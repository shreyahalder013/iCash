/**
 * BiometricChallengeController
 *
 * Implements server-authoritative cryptographic challenge and anti-spoofing verification:
 *
 *   1. POST /api/biometric/challenge
 *      - Server issues single-use challenge { challengeId, nonce, challengeType, expiresAt }
 *      - Randomly selects active challenge action (e.g. BLINK_TWICE, BLINK_PAUSE_BLINK, BLINK_TURN_LEFT_BLINK)
 *      - Initializes bound server liveness session with Python engine
 *      - Stored in DB with 60s TTL and cryptographic 32-byte hex nonce.
 *
 *   2. POST /api/biometric/frame
 *      - Proxies live camera frame to server liveness microservice
 *      - Returns real-time server-authoritative guidance and state
 *
 *   3. POST /api/biometric/verify-challenge
 *      - Validates challenge exists, is not expired, and has not been used.
 *      - Immediately marks challenge as USED (atomic anti-replay protection).
 *      - Queries server liveness engine: verifies PAD, temporal action, single-face.
 *      - Verifies facial identity against enrolled 128D templates (< 0.52 distance).
 *      - Returns short-lived, single-use, signed biometricToken.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma');
const { biometricService } = require('../services/biometricService');
const SecurityService = require('../services/securityService');

// Configurable Constants
const CHALLENGE_TTL_MS = Number(process.env.BIOMETRIC_CHALLENGE_TTL_MS) || 60 * 1000; // 60 seconds
const BIO_TOKEN_TTL_SECONDS = 3 * 60; // 3 minutes
const BIO_TOKEN_SECRET_EXTRA = ':biometric-challenge-token-v1';

const CHALLENGE_TYPES = [
  'BLINK_TWICE',
  'BLINK_PAUSE_BLINK',
  'BLINK_TURN_LEFT_BLINK',
  'BLINK_TURN_RIGHT_BLINK',
  'BLINK_TWICE_WITH_RANDOM_INTERVAL',
];

const CHALLENGE_INSTRUCTIONS = {
  BLINK_TWICE: 'Position your face inside the frame and blink twice naturally.',
  BLINK_PAUSE_BLINK: 'Blink once, pause 1 second with eyes open, then blink again.',
  BLINK_TURN_LEFT_BLINK: 'Blink once, turn head slightly left and back, then blink once more.',
  BLINK_TURN_RIGHT_BLINK: 'Blink once, turn head slightly right and back, then blink once more.',
  BLINK_TWICE_WITH_RANDOM_INTERVAL: 'Please blink twice naturally with a brief pause.',
};

// Challenge stages for the 6-stage state machine
const CHALLENGE_STAGES = {
  CENTER_FACE: 1, // Face detection + quality check
  EYES_DETECTED: 2, // 68-point landmarks localized, EAR computable
  LIVE_CHECK: 3, // Calibration + PAD baseline
  BLINK_CHALLENGE: 4, // Active challenge execution
  IDENTITY_MATCH: 5, // Face descriptor matching
  AUTHORIZED: 6, // Complete
};

// In-memory set of consumed biometric token signatures to guarantee absolute one-time use
const consumedBiometricTokens = new Set();

// In-memory preliminary face-recognition cache (challengeId → { recognized, userId, distance, checkedAt }).
// Used only for real-time "Face recognized" UX feedback during the frame loop.
// The final authoritative identity match always happens at verify-challenge.
const recognitionCache = new Map();
const RECOGNITION_RECHECK_MS = 1800; // throttle: at most ~1 match attempt per 1.8s until recognized
const RECOGNITION_CACHE_TTL_MS = 90 * 1000; // evict entries well after challenge TTL

// In-memory challenge cache for the high-frequency frame loop.
// The challenge row is immutable while frames stream (the nonce and expiry are
// both fixed at creation and only the nonce is checked per frame), but
// re-querying the remote DB on EVERY frame added a full WAN round trip
// (1-6s) per frame — blinks then fall between two frames ~2s apart, the server
// never counts them, the 60s challenge expires, and login times out.
// Per-instance cache only: other instances fall back to the DB lookup, and the
// entry is invalidated the moment the challenge is consumed at verify-challenge,
// so the anti-replay guarantee is unaffected.
const challengeCache = new Map();
const CHALLENGE_CACHE_TTL_MS = 90 * 1000; // just above the 60s challenge TTL

function cacheChallenge(challenge) {
  if (challenge && challenge.id) {
    challengeCache.set(challenge.id, { challenge, cachedAt: Date.now() });
  }
}

function getCachedChallenge(challengeId) {
  const entry = challengeCache.get(challengeId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CHALLENGE_CACHE_TTL_MS) {
    challengeCache.delete(challengeId);
    return null;
  }
  return entry.challenge;
}

function invalidateChallenge(challengeId) {
  challengeCache.delete(challengeId);
}

// Minimum server liveness confidence required to authenticate when the Python
// engine is authoritative. Calibrated so genuine two-blink sessions pass
// comfortably (typical ≥ 0.65) while static/synthetic presentations score low.
const MIN_LIVENESS_CONFIDENCE = Number(process.env.BIOMETRIC_MIN_LIVENESS_CONFIDENCE) || 0.35;

/**
 * Computes a 0-1 liveness confidence score from engine telemetry.
 * Combines EAR variance, dynamic range, blink progress, blink-duration
 * regularity and PAD streak into a single layered-signal score.
 *
 * NOTE: telemetry-only (sent to the UI for progress display). The
 * authoritative confidence used at verify time comes from the Python engine.
 */
function computeLivenessConfidence(liveData) {
  try {
    const blinkCount = Number(liveData.blink_count) || 0;
    const required = Number(liveData.required_blinks) || 2;

    // Without exactly one face there is no liveness evidence at all — a
    // no-face frame must never score above zero (previously the EAR defaults
    // alone produced 0.45 on empty frames).
    if (!liveData.exactly_one_face) return 0;

    // Signal 1: blink progress (0-0.45)
    const progress = Math.min(blinkCount / required, 1) * 0.45;

    // Signal 2: EAR dynamic range relative to baseline (0-0.25)
    // A genuine session shows EAR dropping well below the resting baseline.
    const ear = Number(liveData.ear);
    const baseline = Number(liveData.baseline);
    let rangeScore = 0;
    if (Number.isFinite(ear) && Number.isFinite(baseline) && baseline > 0) {
      const range = Math.max(0, baseline - Math.min(ear, baseline));
      rangeScore = Math.min(range / (baseline * 0.5), 1) * 0.25;
    }

    // Signal 3: presentation state (0-0.2) — quality gate and no spoof flags.
    // Unknown quality (undefined) contributes nothing.
    const qualityScore = liveData.quality_ok === true ? 0.2 : 0;

    // Signal 4: face present and single (0-0.1)
    const faceScore = liveData.exactly_one_face ? 0.1 : 0;

    return Math.round(Math.min(progress + rangeScore + qualityScore + faceScore, 1) * 100) / 100;
  } catch (_) {
    return 0;
  }
}

function getBioTokenSecret() {
  const base = process.env.BIO_TOKEN_JWT_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('BIO_TOKEN_JWT_SECRET (or JWT_SECRET) is not configured.');
  return base + BIO_TOKEN_SECRET_EXTRA;
}

function getLivenessUrl() {
  const raw =
    process.env.ICASH_LIVENESS_URL || process.env.LIVENESS_SERVER_URL || 'http://127.0.0.1:5001';
  return String(raw).trim().replace(/\/+$/, '');
}

class BiometricChallengeController {
  /**
   * POST /api/biometric/challenge
   * Generates a single-use cryptographic challenge for liveness & biometric authentication.
   */
  static async issueChallenge(req, res, next) {
    try {
      // Background cleanup of expired challenges
      prisma.biometricChallenge
        .deleteMany({ where: { expires_at: { lt: new Date() } } })
        .catch(() => {});

      // Cryptographically random 32-byte hex nonce
      const nonce = crypto.randomBytes(32).toString('hex');
      // Randomized active challenge selection
      const challengeType = CHALLENGE_TYPES[Math.floor(Math.random() * CHALLENGE_TYPES.length)];
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;

      // Start session on liveness engine (REQUIRED - no fallback)
      let livenessSessionId = null;
      try {
        const liveRes = await fetch(`${getLivenessUrl()}/liveness/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge_type: challengeType }),
          signal: AbortSignal.timeout(3000),
        });
        if (!liveRes.ok) {
          const errData = await liveRes.json().catch(() => ({}));
          throw new Error(errData.message || `Liveness service error: ${liveRes.status}`);
        }
        const liveData = await liveRes.json();
        livenessSessionId = liveData.session_id;
        if (!livenessSessionId) {
          throw new Error('Liveness service did not return a session ID');
        }
      } catch (e) {
        // Python liveness service is REQUIRED - no local fallback
        console.error('[iCash Bio] Liveness service unavailable:', e.message);
        return res.status(503).json({
          ok: false,
          error: 'BiometricServiceUnavailable',
          message: 'Biometric authentication is temporarily unavailable. Please retry shortly.',
        });
      }

      const challenge = await prisma.biometricChallenge.create({
        data: {
          nonce,
          challenge_type: challengeType,
          ip_address: ipAddress ? String(ipAddress).slice(0, 45) : null,
          liveness_session_id: livenessSessionId,
          expires_at: expiresAt,
        },
      });
      cacheChallenge(challenge);

      await SecurityService.recordEvent({
        userId: null,
        eventType: 'LIVENESS_CHALLENGE_CREATED',
        severity: 'LOW',
        description: `Biometric challenge issued: ${challengeType} (id=${challenge.id})`,
        ipAddress,
        deviceReference: req.headers['user-agent'],
      });

      return res.json({
        ok: true,
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeType: challenge.challenge_type,
        livenessSessionId: challenge.liveness_session_id,
        instruction:
          CHALLENGE_INSTRUCTIONS[challenge.challenge_type] || 'Please blink twice naturally.',
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/biometric/frame
   * Forward live camera frame to server liveness microservice.
   */
  static async submitFrame(req, res, next) {
    try {
      const { challengeId, nonce, image, timestamp } = req.body;
      if (!challengeId || !nonce || !image) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'challengeId, nonce, and image are required',
        });
      }

      // Serve the immutable challenge row from the in-memory cache first (the
      // row cannot change while frames stream); fall back to a DB lookup for
      // cache misses (e.g. multi-instance deployments).
      let challenge = getCachedChallenge(challengeId);
      if (!challenge) {
        challenge = await prisma.biometricChallenge.findUnique({ where: { id: challengeId } });
        if (challenge) cacheChallenge(challenge);
      }
      if (!challenge || challenge.used_at || challenge.expires_at < new Date()) {
        return res.status(400).json({
          ok: false,
          error: 'InvalidChallenge',
          message: 'Challenge expired or consumed.',
        });
      }

      // Do not let a party that only learned a challenge ID stream evidence into
      // another authentication attempt. The nonce is checked on every frame,
      // not just when the final result is redeemed.
      let nonceMatch = false;
      try {
        nonceMatch = crypto.timingSafeEqual(
          Buffer.from(challenge.nonce, 'hex'),
          Buffer.from(nonce, 'hex')
        );
      } catch (_) {
        nonceMatch = false;
      }
      if (!nonceMatch) {
        return res.status(400).json({
          ok: false,
          error: 'NonceMismatch',
          message: 'Cryptographic challenge verification failed. Start a fresh scan.',
        });
      }

      // Proxy frame to Python liveness engine
      let liveData = null;
      try {
        const liveRes = await fetch(`${getLivenessUrl()}/liveness/frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: challenge.liveness_session_id,
            image,
            timestamp: timestamp || Date.now(),
          }),
          signal: AbortSignal.timeout(4000),
        });

        if (liveRes.ok) {
          liveData = await liveRes.json();
        } else {
          const errData = await liveRes.json().catch(() => ({}));
          return res.status(liveRes.status).json({ ok: false, ...errData });
        }
      } catch (err) {
        // Fallback message if liveness service is not reachable
        return res.status(503).json({
          ok: false,
          error: 'BiometricServiceUnavailable',
          message: 'Biometric authentication is temporarily unavailable. Please retry shortly.',
        });
      }

      // ── Preliminary server-side face recognition (real-time UX feedback) ────
      // While the user is still in frame (after eyes are detected), match the live
      // descriptor against enrolled templates so the UI can announce
      // "Face recognized" BEFORE the blink challenge completes.
      // SECURITY: this is feedback only — the authoritative identity match is
      // re-verified at verify-challenge, and the response reveals only a
      // first name, never internal vectors.
      try {
        if (
          liveData &&
          liveData.quality_ok &&
          Number(liveData.current_step) >= 3 &&
          !liveData.spoof_detected &&
          challenge.liveness_session_id &&
          !challenge.liveness_session_id.startsWith('local-')
        ) {
          const now = Date.now();
          const cached = recognitionCache.get(challengeId);

          if (!cached || (!cached.recognized && now - cached.checkedAt > RECOGNITION_RECHECK_MS)) {
            const verifyRes = await fetch(`${getLivenessUrl()}/liveness/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session_id: challenge.liveness_session_id }),
              signal: AbortSignal.timeout(3000),
            });

            if (verifyRes.ok) {
              const vData = await verifyRes.json();
              const entry = cached || {
                recognized: false,
                userId: null,
                distance: Infinity,
                checkedAt: now,
              };

              if (
                vData.face_descriptor &&
                Array.isArray(vData.face_descriptor) &&
                vData.face_descriptor.length >= 128
              ) {
                const profiles = await prisma.biometricProfile.findMany({
                  where: { enrollment_status: 'ENROLLED' },
                  select: { user_id: true, face_descriptors: true },
                });
                for (const profile of profiles) {
                  if (
                    !Array.isArray(profile.face_descriptors) ||
                    profile.face_descriptors.length === 0
                  )
                    continue;
                  const matchResult = await biometricService.verify(
                    profile.face_descriptors,
                    vData.face_descriptor
                  );
                  if (matchResult.matched && matchResult.distance < entry.distance) {
                    entry.recognized = true;
                    entry.userId = profile.user_id;
                    entry.distance = matchResult.distance;
                  }
                }
              }
              entry.checkedAt = now;
              recognitionCache.set(challengeId, entry);
            }
          }
        }
      } catch (e) {
        // Recognition feedback is best-effort — never block the frame loop on it
      }

      // Attach preliminary recognition state + liveness confidence to the response
      if (liveData) {
        const cached = recognitionCache.get(challengeId);
        if (cached && cached.recognized) {
          liveData.faceRecognized = true;
          try {
            if (cached.userId) {
              const recognizedUser = await prisma.user.findUnique({
                where: { id: cached.userId },
                select: { full_name: true },
              });
              if (recognizedUser) {
                // Only a first name — never full identity details mid-scan
                liveData.recognizedName = (recognizedUser.full_name || '').split(' ')[0];
              }
            }
          } catch (_) {
            // Ignore recognition errors - non-critical feedback only
          }
        }
        liveData.livenessConfidence = computeLivenessConfidence(liveData);
        // Evict stale cache entries to bound memory
        for (const [key, value] of recognitionCache) {
          if (Date.now() - value.checkedAt > RECOGNITION_CACHE_TTL_MS) recognitionCache.delete(key);
        }
        return res.json({ ok: true, ...liveData });
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/biometric/verify-challenge
   * Validates challenge nonce, single-use, temporal liveness evidence, and face identity match.
   */
  static async verifyChallenge(req, res, next) {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;
    const ua = req.headers['user-agent'];

    try {
      const { challengeId, nonce, liveDescriptor, userId: targetUserId } = req.body;

      if (!challengeId || !nonce) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Missing required biometric challenge verification parameters.',
        });
      }

      // Gate 1: Lookup challenge record
      const challenge = await prisma.biometricChallenge.findUnique({ where: { id: challengeId } });
      if (!challenge) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'MEDIUM',
          description: `Unknown challenge ID: ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'InvalidChallenge',
          message: 'Biometric challenge not found. Please start a fresh verification.',
        });
      }

      // Gate 2: Expiry verification (strict 60s TTL)
      if (challenge.expires_at < new Date()) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'LOW',
          description: `Expired challenge attempted: ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'ChallengeExpired',
          message: 'Biometric challenge expired. Please restart the verification scan.',
        });
      }

      // Gate 3: Anti-Replay (single-use validation)
      if (challenge.used_at) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_CHALLENGE_REPLAYED',
          severity: 'HIGH',
          description: `Replay attack detected on used challenge ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'ChallengeReplayed',
          message: 'This biometric challenge has already been consumed. Replay is forbidden.',
        });
      }

      // Gate 4: Cryptographic nonce match (constant-time comparison)
      let nonceMatch = false;
      try {
        nonceMatch = crypto.timingSafeEqual(
          Buffer.from(challenge.nonce, 'hex'),
          Buffer.from(nonce, 'hex')
        );
      } catch (_) {
        nonceMatch = false;
      }

      if (!nonceMatch) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'HIGH',
          description: `Nonce mismatch for challenge ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'NonceMismatch',
          message: 'Cryptographic challenge verification failed. Nonce mismatch.',
        });
      }

      // Immediately consume the challenge in DB to prevent concurrent replay
      await prisma.biometricChallenge.update({
        where: { id: challengeId },
        data: { used_at: new Date() },
      });
      // Drop the frame-loop cache entry so no further frames can be streamed
      // into this challenge after consumption (anti-replay enforced end-to-end)
      invalidateChallenge(challengeId);

      // Gate 5: Server-Authoritative Liveness Verification
      let livenessPassed = false;
      let livenessConfidence = 0;
      let serverFaceDescriptor = null;
      let blinkCountRecorded = 0;

      // Attempt verification with Python liveness microservice
      if (challenge.liveness_session_id && !challenge.liveness_session_id.startsWith('local-')) {
        try {
          const verifyRes = await fetch(`${getLivenessUrl()}/liveness/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: challenge.liveness_session_id }),
            signal: AbortSignal.timeout(3000),
          });

          if (verifyRes.ok) {
            const vData = await verifyRes.json();
            // The Python engine computes a layered liveness confidence from the
            // full frame telemetry (EAR history, variance, blink progress, PAD).
            // Trust the authoritative score when present — recomputing locally
            // from the (deliberately minimal) verify response would inflate the
            // score and defeat the confidence gate entirely.
            livenessConfidence =
              typeof vData.liveness_confidence === 'number'
                ? vData.liveness_confidence
                : computeLivenessConfidence(vData);
            if (vData.live && !vData.spoof_detected && vData.exactly_one_face) {
              // Confidence gate: even a "live" verdict below the minimum
              // threshold is not trusted for authentication.
              if (livenessConfidence < MIN_LIVENESS_CONFIDENCE) {
                await SecurityService.recordEvent({
                  userId: null,
                  eventType: 'BIOMETRIC_LIVENESS_FAILURE',
                  severity: 'MEDIUM',
                  description: `Liveness confidence below threshold (confidence=${livenessConfidence}, min=${MIN_LIVENESS_CONFIDENCE}, challenge=${challengeId})`,
                  ipAddress,
                  deviceReference: ua,
                });
                return res.status(403).json({
                  ok: false,
                  error: 'LivenessFailed',
                  message:
                    "We couldn't confidently verify you. Please try again in good lighting, following the on-screen instructions.",
                });
              }
              livenessPassed = true;
              serverFaceDescriptor = vData.face_descriptor;
              blinkCountRecorded = vData.blink_count;

              // Consume the liveness session in Python engine
              fetch(`${getLivenessUrl()}/liveness/consume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: challenge.liveness_session_id }),
              }).catch(() => {});
            } else if (vData.spoof_detected) {
              await SecurityService.recordEvent({
                userId: null,
                eventType: 'SPOOF_REJECTED',
                severity: 'HIGH',
                description: `Spoof attack detected: ${vData.spoof_reason} (challenge=${challengeId})`,
                ipAddress,
                deviceReference: ua,
              });
              return res.status(403).json({
                ok: false,
                error: 'SpoofDetected',
                message:
                  'Live presence could not be verified. Please try again with your live face.',
              });
            }
          }
        } catch (e) {
          console.warn('[iCash Bio] Python liveness verify network notice:', e.message);
        }
      }

      // Python liveness service is REQUIRED - no fallback to client-submitted proof
      if (!livenessPassed) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_LIVENESS_FAILURE',
          severity: 'MEDIUM',
          description: `Liveness verification incomplete or failed - Python service unavailable (challenge=${challengeId})`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(503).json({
          ok: false,
          error: 'BiometricServiceUnavailable',
          message: 'Biometric authentication is temporarily unavailable. Please retry shortly.',
        });
      }

      // Gate 6: Server-side Face Matching against Enrolled Biometric Profile
      const descriptorToMatch = serverFaceDescriptor || liveDescriptor;
      if (
        !descriptorToMatch ||
        !Array.isArray(descriptorToMatch) ||
        descriptorToMatch.length < 128
      ) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Live face biometric descriptor not available for identity verification.',
        });
      }

      let bestUserId = null;
      let bestDistance = Infinity;
      let bestMatchConfidence = 0;

      // Check target user profile first if provided
      if (targetUserId) {
        const targetProfile = await prisma.biometricProfile.findUnique({
          where: { user_id: targetUserId },
          select: { id: true, user_id: true, face_descriptors: true, enrollment_status: true },
        });

        if (
          targetProfile &&
          targetProfile.enrollment_status === 'ENROLLED' &&
          Array.isArray(targetProfile.face_descriptors) &&
          targetProfile.face_descriptors.length > 0
        ) {
          const matchResult = await biometricService.verify(
            targetProfile.face_descriptors,
            descriptorToMatch
          );
          if (matchResult.matched) {
            bestDistance = matchResult.distance;
            bestMatchConfidence = matchResult.confidence || 0;
            bestUserId = targetProfile.user_id;
          }
        }
      }

      // If not yet matched, search across enrolled profiles (1:N identification)
      if (!bestUserId) {
        const profiles = await prisma.biometricProfile.findMany({
          where: { enrollment_status: 'ENROLLED' },
          select: { id: true, user_id: true, face_descriptors: true },
        });

        for (const profile of profiles) {
          if (!Array.isArray(profile.face_descriptors) || profile.face_descriptors.length === 0)
            continue;
          const matchResult = await biometricService.verify(
            profile.face_descriptors,
            descriptorToMatch
          );
          if (matchResult.matched && matchResult.distance < bestDistance) {
            bestDistance = matchResult.distance;
            bestMatchConfidence = matchResult.confidence || 0;
            bestUserId = profile.user_id;
          }
        }
      }

      if (!bestUserId) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'FACE_MATCH_FAILED',
          severity: 'MEDIUM',
          description: `Face identity match failed (challenge=${challengeId}, distance=${Number.isFinite(bestDistance) ? bestDistance.toFixed(4) : 'n/a'})`,
          ipAddress,
          deviceReference: ua,
        });
        // Generic user-facing message — never reveal which internal security
        // threshold failed (identity vs liveness vs confidence).
        return res.status(401).json({
          ok: false,
          error: 'IdentityMismatch',
          message:
            "We couldn't confidently verify you. Please try again in good lighting, following the on-screen instructions.",
        });
      }

      // Gate 7: Ensure user account is active and not locked
      const user = await prisma.user.findUnique({
        where: { id: bestUserId },
        select: {
          id: true,
          full_name: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          locked_until: true,
          is_senior: true,
        },
      });

      if (
        !user ||
        user.status !== 'ACTIVE' ||
        (user.locked_until && user.locked_until > new Date())
      ) {
        return res.status(403).json({
          ok: false,
          error: 'AccountRestricted',
          message: 'Your account is locked or suspended. Please contact customer support.',
        });
      }

      // Update challenge record with authenticated user
      await prisma.biometricChallenge.update({
        where: { id: challengeId },
        data: { user_id: bestUserId },
      });

      // Issue single-use signed biometricToken
      const tokenId = crypto.randomUUID();
      const biometricToken = jwt.sign(
        {
          jti: tokenId,
          sub: bestUserId,
          challengeId,
          nonce: nonce.slice(0, 16),
          purpose: 'biometric-auth',
          livenessOk: true,
        },
        getBioTokenSecret(),
        { expiresIn: BIO_TOKEN_TTL_SECONDS }
      );

      // Overall authentication confidence: face match + liveness combined.
      // Not exposed as raw internal vectors — only a simple 0-1 state.
      const overallConfidence =
        Math.round(((bestMatchConfidence + livenessConfidence) / 2) * 100) / 100;

      await SecurityService.recordEvent({
        userId: bestUserId,
        eventType: 'BIOMETRIC_TOKEN_ISSUED',
        severity: 'LOW',
        description: `Biometric challenge authenticated successfully (id=${challengeId}, distance=${bestDistance.toFixed(4)}, blinks=${blinkCountRecorded}, confidence=${overallConfidence})`,
        ipAddress,
        deviceReference: ua,
      });

      return res.json({
        ok: true,
        biometricToken,
        userId: bestUserId,
        user: {
          id: user.id,
          name: user.full_name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          isSenior: user.is_senior,
        },
        distance: Number(bestDistance.toFixed(4)),
        blinks: blinkCountRecorded,
        confidence: overallConfidence,
        livenessConfidence: livenessConfidence,
        expiresInSeconds: BIO_TOKEN_TTL_SECONDS,
        stage: CHALLENGE_STAGES.AUTHORIZED,
        stageLabel: 'Authorized',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Middleware: consumeBiometricToken
   * Validates and single-use consumes the short-lived biometricToken.
   */
  static consumeBiometricToken(req, res, next) {
    try {
      const token = req.body.biometricToken || req.headers['x-biometric-token'];
      if (!token) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenRequired',
          message: 'A valid biometric verification token is required.',
        });
      }

      let payload;
      try {
        payload = jwt.verify(token, getBioTokenSecret());
      } catch (_) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenInvalid',
          message: 'Biometric verification token is invalid or expired. Please verify face again.',
        });
      }

      // Check replay of single-use biometric token
      if (payload.jti && consumedBiometricTokens.has(payload.jti)) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenReplayed',
          message: 'This biometric token has already been consumed. Replay is forbidden.',
        });
      }

      if (payload.purpose !== 'biometric-auth' || !payload.livenessOk) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenInvalid',
          message: 'Biometric token claims are invalid.',
        });
      }

      // Mark token consumed
      if (payload.jti) {
        consumedBiometricTokens.add(payload.jti);
        // Evict from set after TTL to bound memory
        setTimeout(
          () => consumedBiometricTokens.delete(payload.jti),
          (BIO_TOKEN_TTL_SECONDS + 30) * 1000
        );
      }

      req.biometricUserId = payload.sub;
      req.biometricChallengeId = payload.challengeId;
      next();
    } catch (err) {
      next(err);
    }
  }
}

BiometricChallengeController.consumedBiometricTokens = consumedBiometricTokens;
BiometricChallengeController.getBioTokenSecret = getBioTokenSecret;

module.exports = BiometricChallengeController;
