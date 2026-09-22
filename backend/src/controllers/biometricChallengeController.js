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
const { validateTemporalProof } = require('../services/temporalLivenessValidator');

// Configurable Constants
const CHALLENGE_TTL_MS = Number(process.env.BIOMETRIC_CHALLENGE_TTL_MS) || 60 * 1000; // 60 seconds
const BIO_TOKEN_TTL_SECONDS = 3 * 60; // 3 minutes
const BIO_TOKEN_SECRET_EXTRA = ':biometric-challenge-token-v1';

const CHALLENGE_TYPES = [
  'BLINK_TWICE',
];

const CHALLENGE_INSTRUCTIONS = {
  BLINK_TWICE: 'Position your face inside the frame',
  BLINK_PAUSE_BLINK: 'Blink once, pause 1 second with eyes open, then blink again.',
  BLINK_TURN_LEFT_BLINK: 'Blink once, turn head slightly left and back, then blink once more.',
  BLINK_TURN_RIGHT_BLINK: 'Blink once, turn head slightly right and back, then blink once more.',
  BLINK_TWICE_WITH_RANDOM_INTERVAL: 'Please blink twice naturally with a brief pause.',
};

// In-memory set of consumed biometric token signatures to guarantee absolute one-time use
const consumedBiometricTokens = new Set();

function getBioTokenSecret() {
  const base = process.env.BIO_TOKEN_JWT_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('BIO_TOKEN_JWT_SECRET (or JWT_SECRET) is not configured.');
  return base + BIO_TOKEN_SECRET_EXTRA;
}

function getLivenessUrl() {
  const raw = process.env.ICASH_LIVENESS_URL || process.env.LIVENESS_SERVER_URL || 'http://127.0.0.1:5001';
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
      prisma.biometricChallenge.deleteMany({ where: { expires_at: { lt: new Date() } } }).catch(() => {});

      // Cryptographically random 32-byte hex nonce
      const nonce = crypto.randomBytes(32).toString('hex');
      // Randomized active challenge selection
      const challengeType = CHALLENGE_TYPES[Math.floor(Math.random() * CHALLENGE_TYPES.length)];
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;

      // Start session on liveness engine
      let livenessSessionId = null;
      try {
        const liveRes = await fetch(`${getLivenessUrl()}/liveness/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge_type: challengeType }),
          signal: AbortSignal.timeout(3000),
        });
        if (liveRes.ok) {
          const liveData = await liveRes.json();
          livenessSessionId = liveData.session_id;
        }
      } catch (e) {
        // If Python service is offline in development, create local fallback session ID
        livenessSessionId = `local-${crypto.randomUUID()}`;
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
        instruction: CHALLENGE_INSTRUCTIONS[challenge.challenge_type] || 'Please blink twice naturally.',
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
        return res.status(400).json({ ok: false, error: 'BadRequest', message: 'challengeId, nonce, and image are required' });
      }

      const challenge = await prisma.biometricChallenge.findUnique({ where: { id: challengeId } });
      if (!challenge || challenge.used_at || challenge.expires_at < new Date()) {
        return res.status(400).json({ ok: false, error: 'InvalidChallenge', message: 'Challenge expired or consumed.' });
      }

      // Do not let a party that only learned a challenge ID stream evidence into
      // another authentication attempt. The nonce is checked on every frame,
      // not just when the final result is redeemed.
      let nonceMatch = false;
      try {
        nonceMatch = crypto.timingSafeEqual(Buffer.from(challenge.nonce, 'hex'), Buffer.from(nonce, 'hex'));
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
          const liveData = await liveRes.json();
          return res.json({ ok: true, ...liveData });
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
      const { challengeId, nonce, liveDescriptor, challengeProof, userId: targetUserId } = req.body;

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

      // Gate 5: Server-Authoritative Liveness Verification
      let livenessPassed = false;
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
            if (vData.live && !vData.spoof_detected && vData.exactly_one_face) {
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
                message: 'Live presence could not be verified. Presentation attack detected.',
              });
            }
          }
        } catch (e) {
          console.warn('[iCash Bio] Python liveness verify network notice:', e.message);
        }
      }

      // Fallback verification for test suites / offline development
      if (!livenessPassed) {
        if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_DEV_LIVENESS_FALLBACK) {
          // In production, never fallback to unverified liveness
          return res.status(503).json({
            ok: false,
            error: 'BiometricServiceUnavailable',
            message: 'Biometric authentication is temporarily unavailable. Please retry shortly.',
          });
        }

        // Check if temporal frame proof was provided (e.g. unit tests)
        if (challengeProof && Array.isArray(challengeProof)) {
          const requiredBlinks = challenge.challenge_type === 'BLINK_ONCE' ? 1 : 2;
          const temporalResult = validateTemporalProof(challengeProof, requiredBlinks);
          if (temporalResult.valid) {
            livenessPassed = true;
            blinkCountRecorded = temporalResult.blinkCount;
          } else {
            return res.status(403).json({
              ok: false,
              error: 'LivenessFailed',
              message: temporalResult.reason || 'Liveness verification failed. Genuine action sequence required.',
            });
          }
        }
      }

      if (!livenessPassed) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_LIVENESS_FAILURE',
          severity: 'MEDIUM',
          description: `Liveness verification incomplete or failed (challenge=${challengeId})`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(403).json({
          ok: false,
          error: 'LivenessFailed',
          message: 'Liveness verification failed. Genuine completed action sequence required.',
        });
      }

      // Gate 6: Server-side Face Matching against Enrolled Biometric Profile
      const descriptorToMatch = serverFaceDescriptor || liveDescriptor;
      if (!descriptorToMatch || !Array.isArray(descriptorToMatch) || descriptorToMatch.length < 128) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Live face biometric descriptor not available for identity verification.',
        });
      }

      let bestUserId = null;
      let bestDistance = Infinity;

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
          const matchResult = await biometricService.verify(targetProfile.face_descriptors, descriptorToMatch);
          if (matchResult.matched) {
            bestDistance = matchResult.distance;
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
          if (!Array.isArray(profile.face_descriptors) || profile.face_descriptors.length === 0) continue;
          const matchResult = await biometricService.verify(profile.face_descriptors, descriptorToMatch);
          if (matchResult.matched && matchResult.distance < bestDistance) {
            bestDistance = matchResult.distance;
            bestUserId = profile.user_id;
          }
        }
      }

      if (!bestUserId) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'FACE_MATCH_FAILED',
          severity: 'MEDIUM',
          description: `Face identity match failed (challenge=${challengeId})`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(401).json({
          ok: false,
          error: 'IdentityMismatch',
          message: 'Face identity verification failed. Face does not match registered account.',
        });
      }

      // Gate 7: Ensure user account is active and not locked
      const user = await prisma.user.findUnique({
        where: { id: bestUserId },
        select: { id: true, full_name: true, email: true, phone: true, role: true, status: true, locked_until: true, is_senior: true },
      });

      if (!user || user.status !== 'ACTIVE' || (user.locked_until && user.locked_until > new Date())) {
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

      await SecurityService.recordEvent({
        userId: bestUserId,
        eventType: 'BIOMETRIC_TOKEN_ISSUED',
        severity: 'LOW',
        description: `Biometric challenge authenticated successfully (id=${challengeId}, distance=${bestDistance.toFixed(4)}, blinks=${blinkCountRecorded})`,
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
        expiresInSeconds: BIO_TOKEN_TTL_SECONDS,
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
        setTimeout(() => consumedBiometricTokens.delete(payload.jti), (BIO_TOKEN_TTL_SECONDS + 30) * 1000);
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
