const rateLimit = require('express-rate-limit');

// Strict rate limiter for auth/login endpoints to prevent brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 25, // limit each IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Too many authentication attempts. Please wait 15 minutes before trying again.',
  },
});

// Sensitive transactions rate limiter
const transactionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Rate limit exceeded for financial operations. Please wait a few minutes.',
  },
});

// General API rate limiter
const generalApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 5000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Too many requests. Please slow down.',
  },
});

/**
 * Biometric challenge issuance limiter.
 * 10 challenges per 5-minute window per IP prevents challenge farming
 * (attacker requesting many challenges to find a valid nonce).
 */
const biometricChallengeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Biometric verification failed. Please try again later.',
  },
});

/**
 * Biometric challenge verification limiter.
 * 5 attempts per 15 minutes per IP. After exhaustion the attacker must wait
 * the full window — equivalent to exponential backoff without state.
 * This prevents offline dictionary attacks by repeatedly submitting
 * stolen descriptors against different challenges.
 */
const biometricVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Biometric verification failed. Please try again later.',
  },
});

/**
 * Biometric frame ingestion limiter.
 * Allows up to 400 frames per minute per IP for live camera evidence streaming.
 */
const biometricFrameLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 5000 : 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Biometric streaming limit reached. Please pause a moment.',
  },
});

module.exports = {
  authLimiter,
  transactionLimiter,
  generalApiLimiter,
  biometricChallengeLimiter,
  biometricVerifyLimiter,
  biometricFrameLimiter,
};

