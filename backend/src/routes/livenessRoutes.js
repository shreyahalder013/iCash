const express = require('express');
const router = express.Router();
const LivenessController = require('../controllers/livenessController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { livenessChallengeSchema, livenessVerifySchema } = require('../utils/validator');
const { livenessChallengeLimiter, livenessVerifyLimiter } = require('../middleware/rateLimitMiddleware');

/**
 * POST /api/liveness/challenge
 * 
 * Issues a server-generated liveness challenge with:
 *   - cryptographic nonce (32-byte hex)
 *   - required blink count (1 or 2, randomized)
 *   - 30-second expiry
 *   - challenge ID
 * 
 * Rate-limited: 10 per 5 min per IP
 */
router.post(
  '/challenge',
  livenessChallengeLimiter,
  validateRequest(livenessChallengeSchema),
  LivenessController.issueChallenge
);

/**
 * POST /api/liveness/verify
 * 
 * Validates the completed liveness challenge:
 *   - nonce validity & single-use
 *   - expiry (30s TTL)
 *   - blink count matches required
 *   - plausible minimum duration
 *   - face descriptor match against enrolled template (AES-256-GCM encrypted)
 * 
 * Returns biometricToken on success for session establishment.
 * Rate-limited: 5 per 15 min per IP
 */
router.post(
  '/verify',
  livenessVerifyLimiter,
  validateRequest(livenessVerifySchema),
  LivenessController.verifyChallenge
);

module.exports = router;