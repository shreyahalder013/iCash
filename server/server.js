/* =========================================================
   ICASH — Express API Server
   Serves the frontend, static models, and provides REST APIs
   with cryptographic challenge-response biometric authentication.
   ========================================================= */
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Biometric calibration threshold
// For 128-dimensional L2-normalized FaceRecognitionNet embeddings:
// d <= 0.50: Genuine match (same person)
// d > 0.50: Imposter / distinct individual
const FACE_MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.50');

// Face verification failure tracking (in-memory, with DB fallback)
const faceFailedAttempts = new Map();

// Periodic cleanup of expired challenges every 30 seconds (DB-backed)
setInterval(async () => {
  try {
    await db.cleanupExpiredChallenges();
  } catch (_e) {}
}, 30000);

/* =========================================================
   MATHEMATICAL BIOMETRIC DISTANCE & SIMILARITY
   ========================================================= */
function _calculateEuclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {return Infinity;}
  if (a.length !== 128 || b.length !== 128) {return Infinity;}
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function _calculateCosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {return 0;}
  if (a.length !== 128 || b.length !== 128) {return 0;}
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < 128; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {return 0;}
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* =========================================================
   SECURITY MIDDLEWARE
   ========================================================= */

// Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:']
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xFrameOptions: { action: 'deny' },
  xContentTypeOptions: true,
  xDnsPrefetchControl: { allow: false },
  xDownloadOptions: true,
  xPermittedCrossDomainPolicies: { permittedPolicies: 'none' }
}));

// CORS configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:3000', 'http://127.0.0.1:3000',
      'http://localhost:4000', 'http://127.0.0.1:4000',
      'http://localhost:5500', 'http://127.0.0.1:5500',
      'http://localhost:5173', 'http://127.0.0.1:5173',
      'http://localhost:8080', 'http://127.0.0.1:8080'
    ];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, file://)
    if (!origin) {return callback(null, true);}

    // Check against allowed origins
    if (ALLOWED_ORIGINS.includes(origin)) {return callback(null, true);}

    // In development, allow any localhost/127.0.0.1 port
    if (!IS_PRODUCTION) {
      const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
      if (localhostRegex.test(origin)) {return callback(null, true);}
    }

    logger.warn({ origin }, 'CORS blocked origin');
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key']
}));

app.options('*', cors());

// Body parsing with size limit
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      userAgent: req.get('user-agent')
    }, 'HTTP Request');
  });
  next();
});

// Session configuration
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (IS_PRODUCTION) {
    logger.fatal('SESSION_SECRET environment variable is required in production');
    process.exit(1);
  } else {
    logger.warn('SESSION_SECRET not set — using generated secret for development only');
  }
}

// Session store - use PostgreSQL in production, memory in development
let sessionStore;
if (!IS_PRODUCTION) {
  // Use memory store for development
  sessionStore = new session.MemoryStore();
} else {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: db.pool, // Use the existing PostgreSQL pool
    tableName: 'sessions',
    createTableIfMissing: true
  });
}

app.use(session({
  store: sessionStore,
  secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset expiration on activity
  cookie: {
    secure: IS_PRODUCTION,     // HTTPS-only in production
    httpOnly: true,            // Prevent XSS access to cookie
    sameSite: 'lax',           // CSRF protection
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/'
  },
  name: 'icash.sid', // Custom cookie name
  genid: (_req) => crypto.randomBytes(32).toString('hex') // Regenerate session ID on login
}));

// MediaPipe CSP patch middleware (MUST be before static file serving)
const { mediapipeCspPatch } = require('./mediapipe-csp-patch');
// Files are served from /vendor -> public/vendor, so rootDir must point to project root
// and the middleware will look for files at rootDir + req.path
// req.path for /vendor/mediapipe/... so we need project_root + /vendor = project_root/public/vendor
// Actually the middleware uses path.join(rootDir, rel) where rel is the URL path
// So we need rootDir such that rootDir + /vendor/mediapipe = project_root/public/vendor/mediapipe
// That means rootDir should be project_root/public
app.use(mediapipeCspPatch(path.join(__dirname, '..', 'public')));

// Serve static frontend files, models, and vendor
app.use(express.static(path.join(__dirname, '..')));
app.use('/models', express.static(path.join(__dirname, '..', 'models')));
app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor')));

// Ensure .wasm files are served with correct MIME type
app.use((req, res, next) => {
  if (req.path.endsWith('.wasm')) {
    res.type('application/wasm');
  }
  next();
});

/* =========================================================
   RATE LIMITING
   ========================================================= */

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});
app.use('/api/', apiLimiter);

// Strict rate limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `auth:${req.ip}:${req.body?.accountId || req.body?.phone || req.session?.userId || 'unknown'}`,
  skipSuccessfulRequests: true
});

// Progressive lockout tracker for authentication
const authFailedAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of authFailedAttempts.entries()) {
    // Clean up entries older than 1 hour
    if (now - data.lastAttempt > 3600000) {authFailedAttempts.delete(key);}
  }
}, 300000);

function progressiveAuthLimiter(req, res, next) {
  const key = `auth:${req.ip}:${req.body?.accountId || req.body?.phone || req.session?.userId || 'unknown'}`;
  const failed = authFailedAttempts.get(key) || { count: 0, lastAttempt: 0, lockedUntil: 0 };
  
  // Check if currently locked out
  if (failed.lockedUntil > Date.now()) {
    const waitSecs = Math.ceil((failed.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ 
      error: `Too many failed attempts. Try again in ${waitSecs} seconds.`,
      retryAfter: waitSecs
    });
  }
  
  // Add custom handler to track failures
  const originalSend = res.send;
  res.send = function(body) {
    const statusCode = res.statusCode;
    if (statusCode === 401) {
      failed.count++;
      failed.lastAttempt = Date.now();
      // Only lock out after 3 failed attempts
      if (failed.count >= 3) {
        const lockoutDurations = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
        const lockoutIndex = Math.min(failed.count - 3, lockoutDurations.length - 1);
        failed.lockedUntil = Date.now() + lockoutDurations[lockoutIndex];
      }
      authFailedAttempts.set(key, failed);
    } else if (statusCode === 200) {
      // Reset on success
      authFailedAttempts.delete(key);
    }
    return originalSend.call(this, body);
  };
  
  next();
}

// Stricter limiter for biometric challenge (prevent enumeration)
const biometricChallengeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5, // 5 challenges per 5 min
  message: { error: 'Too many biometric challenges requested, please wait' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `biometric:challenge:${req.ip}:${req.body?.accountId || req.body?.phone || 'unknown'}`
});

const biometricVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Too many verification attempts, please wait' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `biometric:verify:${req.ip}:${req.body?.accountId || 'unknown'}`
});

/* =========================================================
   AUTH MIDDLEWARE
   ========================================================= */
function requireSession(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * GET /api/session — lightweight session validation endpoint.
 * The client calls this to verify whether a server session is active
 * rather than trusting localStorage alone.
 */
app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    return res.json({ active: true, userId: req.session.userId });
  }
  return res.json({ active: false });
});

app.get('/api/health', async (req, res) => {
  // Detailed health check with dependency status
  let dbStatus = 'unknown';
  if (db.pool && !db.isFallback) {
    try {
      await db.pool.query('SELECT 1');
      dbStatus = 'healthy';
    } catch (_e) {
      dbStatus = 'unhealthy';
    }
  } else {
    dbStatus = 'fallback';
  }

  res.json({
    status: 'ok',
    server: 'icash-biometric',
    time: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    database: dbStatus,
    isFallback: db.isFallback
  });
});

/* =========================================================
   BIOMETRIC CHALLENGE-RESPONSE APIS
   ========================================================= */

/**
 * STEP 6 & 18: Generate a randomized, time-bound challenge tied to an account.
 * Rejects accounts without enrolled templates.
 * Requires explicit accountId or phone — no first-user fallback.
 */
app.post('/api/auth/biometric/challenge', biometricChallengeLimiter, async (req, res) => {
  try {
    const { accountId, phone } = req.body;
    let userRaw = null;

    // Require explicit account identification — no first-user fallback
    if (accountId) {
      userRaw = await db.getUserRawById(accountId);
    } else if (phone) {
      userRaw = await db.getUserRawByPhone(phone);
    } else if (req.session?.userId) {
      userRaw = await db.getUserRawById(req.session.userId);
    } else {
      return res.status(400).json({ error: 'Account identification required (accountId, phone, or active session)' });
    }

    if (!userRaw) {
      return res.status(404).json({ error: 'Target account not found' });
    }

    // Check face lockout before issuing challenge
    const lockout = await db.checkFaceLockout(userRaw.id);
    if (lockout.locked) {
      return res.status(429).json({ 
        error: lockout.reason, 
        code: 'FACE_LOCKED',
        retryAfter: lockout.retryAfter || 0
      });
    }

    const template = await db.getUserBiometricTemplate(userRaw.id);
    if (!template || !Array.isArray(template) || template.length !== 128) {
      return res.status(400).json({
        error: 'NO_BIOMETRIC_ENROLLED',
        message: `No biometric Face ID is enrolled for ${userRaw.name}. Please enroll Face ID first.`,
        accountId: userRaw.id,
        userName: userRaw.name
      });
    }

    const challengePool = [
      'blink_once',
      'blink_twice',
      'turn_left_blink',
      'turn_right_blink'
    ];
    const challengeType = challengePool[Math.floor(Math.random() * challengePool.length)];

    // Store sessionNonce if provided by client (binds challenge to specific scan session)
    const clientSessionNonce = req.body.sessionNonce || null;
    const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';

    const challenge = await db.createBiometricChallenge(userRaw.id, challengeType, clientSessionNonce, clientIp);

    logger.info({ accountId: userRaw.id, challengeId: challenge.challengeId, challengeType }, 'Biometric challenge generated');

    res.json({
      success: true,
      challengeId: challenge.challengeId,
      challengeType: challenge.challengeType,
      accountId: userRaw.id,
      userName: userRaw.name,
      expiresAt: challenge.expiresAt
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Biometric challenge error');
    res.status(500).json({ error: 'Failed to generate biometric challenge: ' + err.message });
  }
});

/**
 * STEP 7, 8, 11, 12, 13: Verify live descriptor(s) & liveness proof against account template.
 * ONLY authenticates if liveness is proven AND identity matches (multi-frame scoring).
 * NOTE: Liveness proof is client-asserted (EAR history, blink count, frame count, head turn).
 * Server validates the proof structure and timing but cannot cryptographically verify
 * the client actually performed the actions. Trust model: client hardware + MediaPipe attestation.
 * 
 * Supports both single-frame (legacy) and multi-frame verification.
 * Multi-frame: sends liveFrames array (M >= 5), scored against enrolled set.
 */
app.post('/api/auth/biometric/verify', biometricVerifyLimiter, async (req, res) => {
  try {
    const { challengeId, accountId, liveDescriptor, liveFrames, livenessProof, sessionNonce } = req.body;

    // SECURITY: Validate sessionNonce if provided
    if (sessionNonce && typeof sessionNonce !== 'string') {
      return res.status(400).json({ error: 'Invalid session nonce format' });
    }

    // 1. Parameter Validation
    if (!challengeId || !accountId) {
      return res.status(400).json({ error: 'Missing required biometric parameters' });
    }

    // Support both single-frame (legacy) and multi-frame
    const frames = Array.isArray(liveFrames) && liveFrames.length > 0
      ? liveFrames
      : (Array.isArray(liveDescriptor) && liveDescriptor.length === 128 ? [liveDescriptor] : null);

    if (!frames || frames.length === 0) {
      return res.status(400).json({ error: 'Invalid face descriptor format: must provide liveDescriptor or liveFrames array' });
    }

    // Validate each frame
    for (const frame of frames) {
      if (!Array.isArray(frame) || frame.length !== 128) {
        return res.status(400).json({ error: 'Invalid face descriptor format: must be 128 float values' });
      }
    }

    // 2. Validate Challenge Session (Single-use Anti-Replay) - DB backed
    const challenge = await db.validateAndConsumeChallenge(challengeId, accountId);
    if (!challenge) {
      return res.status(400).json({ error: 'Invalid or expired challenge token. Please try again.' });
    }

    // SECURITY: Validate sessionNonce if it was stored with the challenge
    if (challenge.session_nonce && sessionNonce !== challenge.session_nonce) {
      logger.warn({ accountId }, 'Session nonce mismatch — possible replay or session hijack attempt');
      await db.logSecurityEvent(
        accountId,
        'Anti-Spoofing Alert',
        'Biometric verification rejected: session nonce mismatch — possible replay attack'
      );
      return res.status(401).json({ error: 'Session validation failed. Please restart the face scan.' });
    }

    // 3. Validate Liveness Proof
    if (!livenessProof || typeof livenessProof !== 'object') {
      return res.status(400).json({ error: 'Liveness proof missing or invalid' });
    }
    if (livenessProof.challengeType !== challenge.challenge_type) {
      return res.status(400).json({ error: 'Challenge response mismatch: action did not match requested challenge' });
    }
    if (typeof livenessProof.completedInMs !== 'number' || livenessProof.completedInMs < 800) {
      return res.status(400).json({ error: 'Liveness completion timing unnatural (potential replay or simulated attack)' });
    }
    if (typeof livenessProof.framesAnalyzed !== 'number' || livenessProof.framesAnalyzed < 12) {
      return res.status(400).json({ error: 'Insufficient live frames evaluated' });
    }
    // SECURITY: Validate EAR (Eye Aspect Ratio) range as anti-spoofing signal.
    const earMin = typeof livenessProof.earHistoryMin === 'number' ? livenessProof.earHistoryMin : 1.0;
    const earMax = typeof livenessProof.earHistoryMax === 'number' ? livenessProof.earHistoryMax : 0.0;
    const earRange = earMax - earMin;
    if (earRange < 0.06) {
      logger.warn({ accountId, earRange }, 'EAR range too small — possible static image/replay attack');
      await db.logSecurityEvent(
        accountId,
        'Anti-Spoofing Alert',
        'Liveness rejected: EAR range ' + earRange.toFixed(3) + ' < 0.06 threshold — possible photo/replay attack'
      );
      return res.status(401).json({ error: 'Liveness check failed: insufficient eye movement detected. Please use your live face and blink naturally.' });
    }

    // Check face lockout before verification
    const lockout = await db.checkFaceLockout(accountId);
    if (lockout.locked && lockout.retryAfter > 0) {
      return res.status(429).json({ 
        error: lockout.reason, 
        code: 'FACE_LOCKED',
        retryAfter: lockout.retryAfter
      });
    }

    // 4. Retrieve Account-Bound Enrolled Template (decrypted)
    const enrolledTemplates = await db.getUserBiometricTemplate(accountId);
    if (!enrolledTemplates || !Array.isArray(enrolledTemplates)) {
      return res.status(400).json({ error: 'No enrolled biometric profile found for this account' });
    }

    // Ensure enrolledTemplates is an array of descriptors
    const enrolled = Array.isArray(enrolledTemplates[0]) ? enrolledTemplates : [enrolledTemplates];

    // 5. Multi-Frame Verification using biometric-match module
    const { verifyBiometric } = require('./biometric-match');
    
    // Adjust verification parameters for single-frame (legacy) vs multi-frame
    const isSingleFrame = frames.length === 1;
    const verification = verifyBiometric(
      { enrolledTemplates: enrolled, liveFrames: frames },
      { 
        threshold: FACE_MATCH_THRESHOLD,
        // For single-frame legacy mode, relax requirements that need multiple frames
        minFrames: isSingleFrame ? 1 : 3,
        minFrameRatio: isSingleFrame ? 1.0 : 0.6,
        selfConsistencyBound: isSingleFrame ? Infinity : 0.25,
        margin: isSingleFrame ? 0.15 : 0.15
      }
    );

    logger.info({ 
      accountId, 
      medianScore: verification.medianScore?.toFixed(4),
      frameRatio: verification.frameRatio?.toFixed(2),
      selfConsistency: verification.selfConsistency?.toFixed(4),
      reasonCodes: verification.reasonCodes,
      framesAnalyzed: frames.length
    }, 'Biometric verification attempt');

    // 6. Enforce Verification Result
    if (!verification.accept) {
      // Track failure for lockout
      const failures = faceFailedAttempts.get(accountId) || [];
      failures.push(Date.now());
      // Keep only last 10 minutes
      const cutoff = Date.now() - 600000;
      const recent = failures.filter(t => t > cutoff);
      faceFailedAttempts.set(accountId, recent);

      await db.logSecurityEvent(
        accountId,
        'Identity Mismatch',
        'Biometric login rejected: ' + verification.reasonCodes.join(', ')
      );

      // Generic error response — no distance/threshold exposed
      return res.status(401).json({
        success: false,
        error: 'FACE_NOT_RECOGNIZED'
      });
    }

    // 7. Identity & Liveness Confirmed -> Issue Server Session
    req.session.userId = Number(accountId);
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) {reject(err);} else {resolve();}
      });
    });
    req.session.userId = Number(accountId);
    await db.createSession(Number(accountId), 'face');
    
    // Clear failure tracking on success
    faceFailedAttempts.delete(accountId);

    await db.logSecurityEvent(
      accountId,
      'Login',
      'Face authentication successful (median score: ' + verification.medianScore?.toFixed(3) + ', frames: ' + frames.length + ')'
    );

    const now = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    await db.updateUser(accountId, { lastLogin: now });

    const user = await db.getUserById(accountId);
    res.json({
      success: true,
      userId: Number(accountId),
      user
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Biometric verification error');
    res.status(500).json({ error: 'Biometric verification service failed: ' + err.message });
  }
});/**
 * Enroll or update Face ID for an account.
 * Requires active session or valid normal PIN verification.
 */
const biometricEnrollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: { error: 'Too many biometric enrollment attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `biometric:enroll:${req.ip}:${req.body?.accountId || req.session?.userId || 'unknown'}`
});

app.post('/api/auth/biometric/enroll', biometricEnrollLimiter, async (req, res) => {
  try {
    const { accountId, normalPin, biometricTemplate } = req.body;
    const targetId = req.session.userId || accountId;

    if (!targetId) {
      return res.status(400).json({ error: 'Account ID required' });
    }

    if (!biometricTemplate || !Array.isArray(biometricTemplate) || biometricTemplate.length !== 128) {
      return res.status(400).json({ error: 'Invalid biometric template: expected 128 float array' });
    }

    const userRaw = await db.getUserRawById(targetId);
    if (!userRaw) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // If not authenticated via session, verify PIN
    if (!req.session.userId) {
      if (!normalPin || !(await db.verifyNormalPin(targetId, normalPin))) {
        return res.status(401).json({ error: 'Incorrect PIN. Normal PIN required to enroll Face ID.' });
      }
    } else if (Number(req.session.userId) !== Number(userRaw.id)) {
      return res.status(403).json({ error: 'Unauthorized to modify another user profile' });
    }

    await db.updateUserBiometricTemplate(targetId, biometricTemplate);
    await db.logSecurityEvent(targetId, 'Biometrics', 'Face ID enrolled/updated successfully');

    res.json({ success: true, message: 'Face ID successfully enrolled' });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Biometric enroll error');
    res.status(500).json({ error: 'Failed to enroll biometric template: ' + err.message });
  }
});

/* =========================================================
   STANDARD AUTH & ACCOUNT APIS
   ========================================================= */

/* ---------- REGISTER ---------- */
app.post('/api/register', async (req, res) => {
  try {
    const { user, biometricTemplate } = req.body;

    // Validate required fields
    const schema = require('zod').object({
      name: require('zod').string().min(1).max(100),
      phone: require('zod').string().min(10).max(20),
      aadhaar: require('zod').string().optional().or(require('zod').literal('')).transform(a => a || undefined),
      email: require('zod').string().email().optional().or(require('zod').literal('')).transform(e => e || undefined),
      dob: require('zod').string().optional().or(require('zod').literal('')).transform(d => d || undefined),
      age: require('zod').number().int().min(13).max(120).optional(),
      senior: require('zod').boolean().optional(),
      normalPin: require('zod').string().regex(/^\d{4,6}$/),
      emergencyPin: require('zod').string().regex(/^\d{4,6}$/),
      emergencyContact: require('zod').object({
        name: require('zod').string().optional(),
        phone: require('zod').string().optional(),
        relation: require('zod').string().optional()
      }).optional()
    });

    const validation = schema.safeParse(user);
    if (!validation.success) {
      logger.warn({ details: validation.error.flatten() }, 'Registration validation failed');
      const firstError = Object.values(validation.error.flatten().fieldErrors)[0]?.[0];
      return res.status(400).json({
        error: firstError ? `Invalid registration data: ${firstError}` : 'Invalid registration data',
        details: validation.error.flatten()
      });
    }

    if (user.normalPin === user.emergencyPin) {
      return res.status(400).json({ error: 'Emergency PIN must differ from normal PIN' });
    }

    // Check if phone already exists
    const existing = await db.getUserByPhone(user.phone);
    if (existing) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    const userData = { ...user };
    if (biometricTemplate && Array.isArray(biometricTemplate) && biometricTemplate.length === 128) {
      userData.biometricTemplate = biometricTemplate;
      userData.faceRegistered = true;
    }

    const userId = await db.createUser(userData);

    // Server sets starting balance (₹487.50 = 4875000 paise)
    // No client-provided balance or transactions allowed

    // Create session
    req.session.userId = userId;
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {reject(err);} else {resolve();}
      });
    });
    await db.createSession(userId, 'register');
    await db.logSecurityEvent(
      userId,
      'Registration',
      `iCash ID created ${userData.biometricTemplate ? 'with Face ID enrolled' : ''}`
    );

    logger.info({ userId }, 'User registered successfully');
    res.json({ success: true, userId });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Register error');
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

/* ---------- LOGIN (PIN ONLY - Face login MUST use /api/auth/biometric/verify) ---------- */
app.post('/api/login', authLimiter, progressiveAuthLimiter, async (req, res) => {
  try {
    const { method, pin, accountId } = req.body;

    // Face authentication MUST go through the biometric verification pipeline
    if (method === 'face') {
      return res.status(400).json({
        error: 'Insecure login rejected: biometric authentication must use /api/auth/biometric/challenge and verify endpoints.'
      });
    }

    let userRaw = null;
    if (accountId) {
      userRaw = await db.getUserRawById(accountId);
    } else {
      userRaw = await db.getFirstUserRaw();
    }

    if (!userRaw) {
      return res.status(404).json({ error: 'No user registered' });
    }

    if (method === 'emergency') {
      // ONLY check emergency PIN for emergency method
      const isEmergency = await db.verifyEmergencyPin(userRaw.id, pin);
      if (!isEmergency) {
        await db.logSecurityEvent(userRaw.id, 'Security', 'Failed emergency login attempt — incorrect emergency PIN');
        return res.status(401).json({ error: 'Incorrect emergency PIN' });
      }
      // Regenerate session to prevent fixation
      await new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
          if (err) {reject(err);} else {resolve();}
        });
      });
      req.session.userId = userRaw.id;
      await db.createSession(userRaw.id, 'emergency', true); // duress = true
      await db.logSecurityEvent(userRaw.id, 'Emergency', 'Emergency PIN activated — covert alert triggered');
      logger.warn({ userId: userRaw.id }, 'EMERGENCY PIN ACTIVATED — Duress mode');
      return res.json({ success: true, emergency: true, userId: userRaw.id, duress: true });
    }

    if (method === 'pin') {
      // ONLY check normal PIN for pin method
      const isNormal = await db.verifyNormalPin(userRaw.id, pin);
      if (!isNormal) {
        await db.logSecurityEvent(userRaw.id, 'Security', 'Failed login attempt — incorrect PIN');
        return res.status(401).json({ error: 'Incorrect PIN' });
      }
    } else {
      return res.status(400).json({ error: 'Invalid authentication method' });
    }

    // Regenerate session to prevent fixation
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) {reject(err);} else {resolve();}
      });
    });
    // Create session
    req.session.userId = userRaw.id;
    await db.createSession(userRaw.id, 'pin');
    await db.logSecurityEvent(userRaw.id, 'Login', 'PIN authentication successful');

    const now = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    await db.updateUser(userRaw.id, { lastLogin: now });

    const safeUser = await db.getUserById(userRaw.id);
    res.json({ success: true, userId: userRaw.id, user: safeUser });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Login error');
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

/* ---------- LOGOUT ---------- */
app.post('/api/logout', async (req, res) => {
  if (req.session.userId) {
    await db.deactivateSession(req.session.userId);
    await db.logSecurityEvent(req.session.userId, 'Logout', 'User logged out');
  }
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err: err.message }, 'Session destroy error');
    }
    res.clearCookie('icash.sid');
    res.json({ success: true });
  });
});

/* ---------- VERIFY PIN (no session creation) - for Send/Withdraw step-up ---------- */
app.post('/api/auth/verify-pin', authLimiter, progressiveAuthLimiter, async (req, res) => {
  try {
    const { pin } = req.body;
    const accountId = req.body.accountId || req.session?.userId;

    if (!pin || !accountId) {
      return res.status(400).json({ error: 'PIN and accountId required' });
    }

    const userRaw = await db.getUserRawById(accountId);
    if (!userRaw) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Check normal PIN only (not emergency)
    const isNormal = await db.verifyNormalPin(userRaw.id, pin);
    if (!isNormal) {
      const isEmergency = await db.verifyEmergencyPin(userRaw.id, pin);
      if (isEmergency) {
        return res.status(400).json({ error: 'Emergency PIN entered. Please enter your Normal PIN to withdraw.' });
      }
      await db.logSecurityEvent(userRaw.id, 'Security', 'Failed step-up PIN verification');
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Verify PIN error');
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

/* ---------- STEP-UP AUTH (Single-use token for high-value actions) ---------- */
// In-memory store: token -> { userId, amount, recipientId, type, expiresAt, used }
const stepUpTokens = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of stepUpTokens.entries()) {
    if (now > data.expiresAt || data.used) {stepUpTokens.delete(token);}
  }
}, 60000);

app.post('/api/auth/step-up', requireSession, async (req, res) => {
  try {
    const { method, pin, _biometricData, amount, recipientPhone, type } = req.body;
    const userId = req.session.userId;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount required' });
    }
    if (!type || !['withdraw', 'transfer'].includes(type)) {
      return res.status(400).json({ error: 'Invalid step-up type' });
    }

    let recipientId = null;
    if (type === 'transfer') {
      if (!recipientPhone) {
        return res.status(400).json({ error: 'Recipient phone required for transfer' });
      }
      const recipient = await db.getUserByPhone(recipientPhone);
      if (!recipient) {
        return res.status(404).json({ error: 'Recipient not found' });
      }
      if (recipient.id === userId) {
        return res.status(400).json({ error: 'Cannot transfer to yourself' });
      }
      recipientId = recipient.id;
    }

    // Verify PIN or biometric
    if (method === 'pin') {
      if (!pin) {return res.status(400).json({ error: 'PIN required' });}
      const isNormal = await db.verifyNormalPin(userId, pin);
      if (!isNormal) {
        await db.logSecurityEvent(userId, 'Security', 'Failed step-up PIN verification');
        return res.status(401).json({ error: 'Incorrect PIN' });
      }
    } else if (method === 'biometric') {
      // Biometric verification would use the challenge/verify flow
      // For now, require PIN for step-up (biometric step-up can be added later)
      return res.status(400).json({ error: 'Biometric step-up not yet implemented, use PIN' });
    } else {
      return res.status(400).json({ error: 'Invalid step-up method' });
    }

    // Generate single-use token bound to session + amount + recipient
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

    stepUpTokens.set(token, {
      userId,
      amount,
      recipientId,
      type,
      expiresAt,
      used: false
    });

    await db.logSecurityEvent(userId, 'StepUp', `Step-up authorized for ${type} of ${db.formatINR(db.rupeesToPaise(amount))}`);

    res.json({ success: true, stepUpToken: token, expiresAt });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Step-up auth error');
    res.status(500).json({ error: 'Step-up authorization failed: ' + err.message });
  }
});

/* ---------- VERIFY STEP-UP TOKEN (Internal middleware) ---------- */
function requireStepUp(type) {
  return async (req, res, next) => {
    try {
      const token = req.headers['x-step-up-token'] || req.body.stepUpToken;
      if (!token) {
        return res.status(401).json({ error: 'Step-up authorization required', code: 'STEP_UP_REQUIRED' });
      }

      const data = stepUpTokens.get(token);
      if (!data) {
        return res.status(401).json({ error: 'Invalid or expired step-up token' });
      }
      if (data.used) {
        return res.status(401).json({ error: 'Step-up token already used' });
      }
      if (Date.now() > data.expiresAt) {
        stepUpTokens.delete(token);
        return res.status(401).json({ error: 'Step-up token expired' });
      }
      if (data.type !== type) {
        return res.status(401).json({ error: 'Step-up token type mismatch' });
      }
      if (data.userId !== req.session.userId) {
        return res.status(403).json({ error: 'Step-up token user mismatch' });
      }

      // Mark as used
      data.used = true;
      req.stepUpData = data;
      next();
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'Step-up token verification error');
      res.status(500).json({ error: 'Step-up verification failed: ' + err.message });
    }
  };
}

/* ---------- DURESS CHECK MIDDLEWARE ---------- */
function requireNotDuress(req, res, next) {
  // Check if current session is a duress session
  const userId = req.session.userId;
  if (!userId) {return next();} // No session, let requireSession handle it
  
  db.getActiveSession(userId).then(session => {
    if (session && session.duress) {
      return res.status(403).json({ 
        error: 'Account in emergency mode. Money movement disabled.',
        code: 'DURESS_MODE'
      });
    }
    next();
  }).catch(e => {
    logger.error({ err: e.message }, 'Duress check error');
    res.status(500).json({ error: 'Session verification failed' });
  });
}

/* ---------- GET USER BY PHONE (for login lookup) ---------- */
app.post('/api/user/by-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    const user = await db.getUserByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Return minimal user info for login flow (no sensitive data)
    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      faceRegistered: user.faceRegistered,
      hasBiometric: user.hasBiometric
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'User lookup by phone error');
    res.status(500).json({ error: 'Failed to look up account: ' + err.message });
  }
});

/* ---------- GET USER (+ full state) ---------- */
// Returns 200 with user:null when not logged in (no 401)
app.get('/api/user', async (req, res) => {
  try {
    const userId = req.session?.userId;

    if (!userId) {
      // Not logged in - return 200 with null user/session
      return res.json({
        user: null,
        transactions: [],
        balance: 0,
        balancePaise: 0,
        session: null,
        events: []
      });
    }

    const user = await db.getUserById(userId);
    if (!user) {return res.status(404).json({ error: 'User not found' });}

    const activeSession = await db.getActiveSession(userId);

    res.json({
      user,
      transactions: await db.getTransactions(userId),
      balance: user.balance,
      balancePaise: user.balancePaise,
      session: activeSession ? { active: true, method: activeSession.method, duress: activeSession.duress } : null,
      events: await db.getSecurityEvents(userId)
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Get user error');
    res.status(500).json({ error: 'Failed to retrieve user data: ' + err.message });
  }
});

/* ---------- UPDATE USER (Session Required) ---------- */
app.put('/api/user', requireSession, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { user } = req.body;

    // Update user fields (sanitized, cannot forge pins, sessions, balance, or transactions)
    if (user) {
      await db.updateUser(userId, {
        name:             user.name,
        phone:            user.phone,
        email:            user.email,
        seniorMode:       user.seniorMode,
        emergencyContact: user.emergencyContact
      });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Update user error');
    res.status(500).json({ error: 'Failed to update user: ' + err.message });
  }
});

/* ---------- TRANSACTIONS ---------- */
app.get('/api/transactions', requireSession, async (req, res) => {
  try {
    const filters = {
      type:   req.query.type,
      date:   req.query.date,
      search: req.query.search
    };
    const txs = await db.getTransactions(req.session.userId, filters);
    res.json(txs);
  } catch (_e) {
    logger.error({ err: e.message }, 'Get transactions error');
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

/* ---------- WITHDRAW (Atomic: debit + ledger + idempotency, requires step-up) ---------- */
app.post('/api/transactions', requireSession, requireStepUp('withdraw'), requireNotDuress, async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;
    const stepUpData = req.stepUpData;

    const schema = require('zod').object({
      id: require('zod').string().min(1),
      date: require('zod').string().regex(/^\d{4}-\d{2}-\d{2}$/),
      desc: require('zod').string().min(1).max(200),
      // Only 'out' type allowed - deposits go through admin/bank channels
      type: require('zod').literal('out'),
      cat: require('zod').string().max(50).optional(),
      amount: require('zod').number().positive(),
      status: require('zod').string().max(20).optional()
    });

    const validation = schema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid transaction data', details: validation.error.flatten() });
    }

    const tx = validation.data;

    // Verify step-up token matches request
    if (stepUpData.amount !== tx.amount) {
      return res.status(400).json({ error: 'Step-up token amount does not match request' });
    }

    const amountPaise = Number(db.rupeesToPaise(tx.amount));

    // Use adjustBalance which atomically debits balance AND creates ledger row in single DB transaction
    const result = await db.adjustBalance(req.session.userId, -amountPaise, tx.desc, idempotencyKey);

    await db.logSecurityEvent(req.session.userId, 'Transaction', `Withdrew ${db.formatINR(amountPaise)} — ${tx.desc}`);

    res.json({ success: true, balancePaise: result.balancePaise, balance: db.paiseToRupees(result.balancePaise) });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Create transaction error');
    if (err.message.includes('Duplicate') || err.message.includes('idempotency')) {
      return res.status(409).json({ error: 'Duplicate transaction' });
    }
    if (err.message.includes('Insufficient')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Transaction failed: ' + err.message });
  }
});

/* ---------- TRANSFER FEE CALCULATION (Server-side) ---------- */
app.post('/api/transfer/fee', requireSession, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount required' });
    }
    // Fee: 0.5% (minimum ₹1, maximum ₹100)
    const feePaise = Math.max(100, Math.min(10000, Math.round(db.rupeesToPaise(amount) * 0.005)));
    res.json({ fee: db.paiseToRupees(feePaise), feePaise });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Transfer fee calculation error');
    res.status(500).json({ error: 'Failed to calculate fee: ' + err.message });
  }
});

/* ---------- TRANSFER FUNDS (Atomic, requires step-up) ---------- */
app.post('/api/transfer', requireSession, requireStepUp('transfer'), requireNotDuress, async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;
    const stepUpData = req.stepUpData;

    const schema = require('zod').object({
      recipientPhone: require('zod').string().min(10).max(20),
      amount: require('zod').number().positive(),
      description: require('zod').string().min(1).max(200)
    });

    const validation = schema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid transfer data', details: validation.error.flatten() });
    }

    const { recipientPhone, amount, description } = validation.data;

    // Verify step-up token matches request
    if (stepUpData.amount !== amount || stepUpData.recipientId !== (await db.getUserByPhone(recipientPhone))?.id) {
      return res.status(400).json({ error: 'Step-up token does not match request parameters' });
    }

    const amountPaise = Number(db.rupeesToPaise(amount));

    // Find recipient
    const recipient = await db.getUserByPhone(recipientPhone);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    if (recipient.id === req.session.userId) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    // Atomic transfer
    const result = await db.transferFunds(req.session.userId, recipient.id, amountPaise, description, idempotencyKey);

    await db.logSecurityEvent(req.session.userId, 'Transfer', `Sent ${db.formatINR(amountPaise)} to ${recipient.name} (${recipientPhone})`);
    await db.logSecurityEvent(recipient.id, 'Transfer', `Received ${db.formatINR(amountPaise)} from ${(await db.getUserById(req.session.userId)).name}`);

    res.json({ success: true, balance: db.paiseToRupees(result.fromBalancePaise) });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Transfer error');
    if (err.message.includes('Insufficient')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes('Duplicate')) {
      return res.status(409).json({ error: 'Duplicate transaction' });
    }
    res.status(500).json({ error: 'Transfer failed: ' + err.message });
  }
});

/* ---------- BALANCE ---------- */
app.get('/api/balance', requireSession, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    res.json({ balance: user.balance, balancePaise: user.balancePaise });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Get balance error');
    res.status(500).json({ error: 'Failed to retrieve balance: ' + err.message });
  }
});

/* ---------- SECURITY EVENTS ---------- */
app.get('/api/events', requireSession, async (req, res) => {
  try {
    res.json(await db.getSecurityEvents(req.session.userId));
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Get events error');
    res.status(500).json({ error: 'Failed to retrieve events: ' + err.message });
  }
});

app.post('/api/events', requireSession, async (req, res) => {
  try {
    const { type, desc } = req.body;
    await db.logSecurityEvent(req.session.userId, type, desc);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Log event error');
    res.status(500).json({ error: 'Failed to log event: ' + err.message });
  }
});

/* =========================================================
   START SERVER
   ========================================================= */
let server = null;

async function start() {
  // Start listening immediately — DB init happens in background
  // so the server is available right away even if Supabase is slow
  server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`
┌──────────────────────────────────────────┐
│   iCash Secure Banking Server            │
│   Running on http://localhost:${PORT}        │
│   Biometrics: Dual Engine + Anti-Spoof   │
│   Match Threshold: ${FACE_MATCH_THRESHOLD.toFixed(2)}                  │
│   Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}                    │
└──────────────────────────────────────────┘
    `);
  });

  // Initialize DB in background — falls back to in-memory if unavailable
  db.initDb().catch(_err => {
    logger.warn({ err: _err.message }, 'DB init failed — running in-memory mode');
  });

  // Graceful shutdown handling
  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down gracefully...');

    if (server) {
      server.close(() => {
        logger.info('HTTP server closed.');

        // Close database pool if using PostgreSQL
        if (db && db.pool && !db.isFallback) {
          db.pool.end(() => {
            logger.info('Database pool closed.');
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      });

      // Force close after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout.');
        process.exit(1);
      }, 10000);
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => {
  logger.fatal({ err: err.message }, 'Failed to start server');
  process.exit(1);
});