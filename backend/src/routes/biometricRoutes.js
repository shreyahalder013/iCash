const express = require('express');
const router  = express.Router();
const BiometricController          = require('../controllers/biometricController');
const BiometricChallengeController = require('../controllers/biometricChallengeController');
const { authenticate }             = require('../middleware/authMiddleware');
const { validateRequest }          = require('../middleware/validateMiddleware');
const {
  biometricEnrollSchema,
  biometricVerifySchema,
  biometricChallengeSchema,
  biometricVerifyChallengeSchema,
} = require('../utils/validator');
const {
  biometricChallengeLimiter,
  biometricVerifyLimiter,
  biometricFrameLimiter,
} = require('../middleware/rateLimitMiddleware');

// ── New secure challenge-based flow ──────────────────────────────────────────
/**
 * POST /api/biometric/challenge
 *
 * Issues a server-generated randomized liveness challenge (nonce + challengeType).
 * No authentication required (used pre-login).
 * Rate-limited: 10 per 5 min per IP.
 */
router.post(
  '/challenge',
  biometricChallengeLimiter,
  validateRequest(biometricChallengeSchema),
  BiometricChallengeController.issueChallenge
);

/**
 * POST /api/biometric/frame
 *
 * Streams camera evidence frames directly to the server liveness & anti-spoofing engine.
 * Rate-limited: 400 per 1 min per IP.
 */
router.post(
  '/frame',
  biometricFrameLimiter,
  BiometricChallengeController.submitFrame
);

/**
 * POST /api/biometric/verify-challenge
 *
 * Validates the completed liveness challenge:
 *   nonce ✓ | expiry ✓ | one-time ✓ | liveness server ✓ | face match ✓
 * Returns a short-lived biometricToken on success.
 * Rate-limited: 5 per 15 min per IP (brute-force and oracle protection).
 */
router.post(
  '/verify-challenge',
  biometricVerifyLimiter,
  validateRequest(biometricVerifyChallengeSchema),
  BiometricChallengeController.verifyChallenge
);

// ── Enrollment (requires authenticated session + biometricToken) ──────────────
/**
 * POST /api/biometric/enroll
 *
 * Saves enrolled face descriptors.
 * Requires:
 *   - HTTP-only session cookie (authenticated user)
 *   - A valid biometricToken in the request body (proves liveness was verified)
 */
router.post(
  '/enroll',
  authenticate,
  BiometricChallengeController.consumeBiometricToken,
  validateRequest(biometricEnrollSchema),
  BiometricController.enroll
);

// ── Facial verification (supports direct face matching and legacy clients) ────
/**
 * POST /api/biometric/verify
 *
 * Verifies live facial descriptor against registered biometric template.
 * Returns match status, confidence, and a short-lived biometricToken on success.
 */
router.post(
  '/verify',
  biometricVerifyLimiter,
  validateRequest(biometricVerifySchema),
  (req, res, next) => {
    if (req.cookies?.icash_session || req.headers.authorization) {
      return authenticate(req, res, () => BiometricController.verify(req, res, next));
    }
    return BiometricController.verify(req, res, next);
  }
);

// ── Enrollment status (descriptors NEVER returned) ───────────────────────────
/**
 * GET /api/biometric/profile/:userId
 *
 * Returns enrollment STATUS only (enrolled: true/false, provider).
 * Face descriptors are NEVER included in this response.
 * Requires authentication; users can only access their own status.
 */
router.get('/profile/:userId', authenticate, (req, res, next) => {
  if (req.params.userId !== req.user.id) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden',
      message: 'You may only access your own biometric profile.',
    });
  }
  BiometricController.getProfile(req, res, next);
});

module.exports = router;
