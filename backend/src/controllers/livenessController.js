/**
 * LivenessController
 * 
 * Implements server-authoritative liveness challenge verification
 * using client-side MediaPipe FaceLandmarker (WASM) for blink detection.
 * 
 * Flow:
 * 1. POST /api/liveness/challenge -> returns { challengeId, nonce, requiredBlinks, expiresAt }
 * 2. Client performs blink detection using MediaPipe, collects face descriptor
 * 3. POST /api/liveness/verify -> validates nonce, blink count, duration, face match
 * 4. On success -> returns biometricToken for session establishment
 * 
 * Security:
 * - Nonce is cryptographically random, single-use, 30s TTL
 * - Face templates encrypted at rest (AES-256-GCM)
 * - Blink count must match server-issued challenge
 * - Minimum duration enforced to prevent replay
 * - Rate limiting per IP and per account
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma');
const { faceTemplateService } = require('../services/faceTemplateService');
const SecurityService = require('../services/securityService');

// Configurable Constants
const CHALLENGE_TTL_MS = Number(process.env.LIVENESS_CHALLENGE_TTL_MS) || 30 * 1000; // 30 seconds
const BIO_TOKEN_TTL_SECONDS = 3 * 60; // 3 minutes
const BIO_TOKEN_SECRET_EXTRA = ':liveness-challenge-token-v1';
const MIN_SESSION_DURATION_MS = 800; // Minimum plausible session duration

// In-memory set of consumed biometric token JTIs for absolute one-time use
const consumedBioTokens = new Set();

// In-memory challenge cache for high-frequency access (falls back to DB)
const challengeCache = new Map();
const CHALLENGE_CACHE_TTL_MS = 45 * 1000;

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

function getBioTokenSecret() {
  const base = process.env.BIO_TOKEN_JWT_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('BIO_TOKEN_JWT_SECRET (or JWT_SECRET) is not configured.');
  return base + BIO_TOKEN_SECRET_EXTRA;
}

class LivenessController {
  /**
   * POST /api/liveness/challenge
   * Generates a single-use cryptographic challenge for liveness & biometric authentication.
   */
  static async issueChallenge(req, res, next) {
    try {
      // Background cleanup of expired challenges
      prisma.livenessNonce
        .deleteMany({ where: { expires_at: { lt: new Date() } } })
        .catch(() => {});

      // Cryptographically random 32-byte hex nonce
      const nonce = crypto.randomBytes(32).toString('hex');
      // Randomized blink count: 1 or 2
      const required_blinks = 1 + Math.floor(Math.random() * 2);
      const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS);
      const ip_address = req.ip || req.headers['x-forwarded-for'] || null;

      const challenge = await prisma.livenessNonce.create({
        data: {
          nonce,
          required_blinks,
          ip_address: ip_address ? String(ip_address).slice(0, 45) : null,
          expires_at,
        },
      });
      cacheChallenge(challenge);

      await SecurityService.recordEvent({
        userId: null,
        eventType: 'LIVENESS_CHALLENGE_CREATED',
        severity: 'LOW',
        description: `Liveness challenge issued: ${required_blinks} blink(s) (id=${challenge.id})`,
        ipAddress: ip_address,
        deviceReference: req.headers['user-agent'],
      });

      // Instruction based on blink count
      const instruction = required_blinks === 1
        ? 'Blink once naturally.'
        : 'Blink twice naturally with a brief pause.';

      return res.json({
        ok: true,
        challengeId: challenge.id,
        nonce: challenge.nonce,
        requiredBlinks: challenge.required_blinks,
        instruction,
        expiresAt: challenge.expires_at.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/liveness/verify
   * Validates challenge nonce, single-use, temporal liveness evidence, and face identity match.
   */
  static async verifyChallenge(req, res, next) {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';

    // Defensive: ensure ipAddress is always defined
    const safeIpAddress = ipAddress || 'unknown';
    const safeUa = ua || 'unknown';

    try {
      const { challengeId, nonce, blinks, durationMs, descriptor, mode } = req.body;

      if (!challengeId || !nonce) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Missing required verification parameters.',
        });
      }

      if (typeof blinks !== 'number' || blinks < 1 || blinks > 2) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Invalid blink count.',
        });
      }

      if (typeof durationMs !== 'number' || durationMs < MIN_SESSION_DURATION_MS) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Session duration too short.',
        });
      }

      if (!descriptor || !Array.isArray(descriptor) || descriptor.length < 128) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Invalid face descriptor.',
        });
      }

      // Gate 1: Lookup challenge record
      let challenge = getCachedChallenge(challengeId);
      if (!challenge) {
        challenge = await prisma.livenessNonce.findUnique({ where: { id: challengeId } });
        if (challenge) cacheChallenge(challenge);
      }
      if (!challenge) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'LIVENESS_AUTH_FAILURE',
          severity: 'MEDIUM',
          description: `Unknown challenge ID: ${challengeId}`,
          ipAddress: safeIpAddress,
          deviceReference: safeUa,
        });
        return res.status(400).json({
          ok: false,
          error: 'InvalidChallenge',
          message: 'Challenge not found. Please start a fresh verification.',
        });
      }

      // Gate 2: Expiry verification (strict 30s TTL)
      if (challenge.expires_at < new Date()) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'LIVENESS_AUTH_FAILURE',
          severity: 'LOW',
          description: `Expired challenge attempted: ${challengeId}`,
          ipAddress: safeIpAddress,
          deviceReference: safeUa,
        });
        return res.status(400).json({
          ok: false,
          error: 'ChallengeExpired',
          message: 'Challenge expired. Please restart the verification scan.',
        });
      }

      // Gate 3: Anti-Replay (single-use validation)
      if (challenge.consumed_at) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'LIVENESS_CHALLENGE_REPLAYED',
          severity: 'HIGH',
          description: `Replay attack detected on used challenge ${challengeId}`,
          ipAddress: safeIpAddress,
          deviceReference: safeUa,
        });
        return res.status(400).json({
          ok: false,
          error: 'ChallengeReplayed',
          message: 'This challenge has already been consumed. Replay is forbidden.',
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
          eventType: 'LIVENESS_AUTH_FAILURE',
          severity: 'HIGH',
          description: `Nonce mismatch for challenge ${challengeId}`,
          ipAddress: safeIpAddress,
          deviceReference: safeUa,
        });
        return res.status(400).json({
          ok: false,
          error: 'NonceMismatch',
          message: 'Cryptographic challenge verification failed. Nonce mismatch.',
        });
      }

      // Gate 5: Blink count must match required
      if (blinks !== challenge.required_blinks) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'LIVENESS_AUTH_FAILURE',
          severity: 'MEDIUM',
          description: `Blink count mismatch: got ${blinks}, required ${challenge.required_blinks} (challenge=${challengeId})`,
          ipAddress: safeIpAddress,
          deviceReference: safeUa,
        });
        return res.status(403).json({
          ok: false,
          error: 'LivenessFailed',
          message: 'Blink pattern does not match challenge. Please try again.',
        });
      }

      // Immediately consume the challenge in DB to prevent concurrent replay
      await prisma.livenessNonce.update({
        where: { id: challengeId },
        data: { consumed_at: new Date() },
      });
      invalidateChallenge(challengeId);

      // Gate 6: Face Matching against Enrolled Biometric Profile
      // Find user with matching face template
      let bestUserId = null;
      let bestDistance = Infinity;

      // If mode is login with target user hint, check that user first
      if (mode === 'login') {
        // We don't have a target user ID here - we need to search all enrolled users
        // The client doesn't send userId for privacy; we do 1:N matching
      }

      // Search across all enrolled profiles (1:N identification)
      const profiles = await prisma.faceTemplate.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          user_id: true,
          encrypted_descriptor: true,
          iv: true,
          auth_tag: true,
        },
      });

      console.log('[LivenessVerify] Found', profiles.length, 'faceTemplate records');
      
      for (const profile of profiles) {
        if (!profile.encrypted_descriptor || !profile.iv || !profile.auth_tag) {
          console.log('[LivenessVerify] Skipping profile', profile.user_id, '- missing data');
          continue;
        }
        
        try {
          const storedDescriptor = faceTemplateService.decrypt(
            profile.encrypted_descriptor,
            profile.iv,
            profile.auth_tag
          );
          
          if (!storedDescriptor || storedDescriptor.length < 128) {
            console.log('[LivenessVerify] Skipping profile', profile.user_id, '- invalid descriptor');
            continue;
          }
          
          const distance = faceTemplateService.distance(storedDescriptor, descriptor);
          console.log('[LivenessVerify] Profile', profile.user_id, 'distance:', distance);
          
          if (distance < bestDistance) {
            bestDistance = distance;
            bestUserId = profile.user_id; // Prisma returns snake_case
          }
        } catch (e) {
          console.log('[LivenessVerify] Decryption failed for profile', profile.user_id, ':', e.message);
          continue;
        }
      }

      // Check against configurable threshold
      const matchMax = Number(process.env.FACE_MATCH_MAX) || 0.085;
      
      if (!bestUserId || bestDistance > matchMax) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'FACE_MATCH_FAILED',
          severity: 'MEDIUM',
          description: `Face identity match failed (challenge=${challengeId}, distance=${Number.isFinite(bestDistance) ? bestDistance.toFixed(4) : 'n/a'}, threshold=${matchMax})`,
          ipAddress: safeIpAddress,
          deviceReference: safeUa,
        });
        
        // Generic message - never reveal which threshold failed
        return res.status(401).json({
          ok: false,
          error: 'IdentityMismatch',
          message: "We couldn't confidently verify you. Please try again in good lighting.",
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
      await prisma.livenessNonce.update({
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
        eventType: 'LIVENESS_TOKEN_ISSUED',
        severity: 'LOW',
        description: `Liveness challenge authenticated (id=${challengeId}, distance=${bestDistance.toFixed(4)}, blinks=${blinks})`,
        ipAddress: safeIpAddress,
        deviceReference: safeUa,
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
        blinks,
        expiresInSeconds: BIO_TOKEN_TTL_SECONDS,
      });
    } catch (err) {
      next(err);
    }
  }
}

// Export consumed token set for middleware
LivenessController.consumedBioTokens = consumedBioTokens;
LivenessController.getBioTokenSecret = getBioTokenSecret;

module.exports = LivenessController;