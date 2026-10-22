const fs = require('fs');
const path = require('path');

const newEndpoint = `/**
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
    const verification = verifyBiometric(
      { enrolledTemplates: enrolled, liveFrames: frames },
      { threshold: FACE_MATCH_THRESHOLD }
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
  } catch (_e) {
    logger.error({ err: e.message }, 'Biometric verification error');
    res.status(500).json({ error: 'Biometric verification service failed' });
  }
});`;

const filePath = path.join(__dirname, '..', 'server', 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

// Find the verify endpoint by searching for a unique marker
const marker = 'STEP 7, 8, 11, 12, 13: Verify live descriptor';
const startIdx = content.indexOf(marker);
if (startIdx === -1) {
  console.log('Marker not found!');
  process.exit(1);
}

// Find the start of the function (the /** comment block)
const commentStart = content.lastIndexOf('/**', startIdx);
if (commentStart === -1) {
  console.log('Could not find comment start');
  process.exit(1);
}

// Find the end of the function - look for the next /**
const nextComment = content.indexOf('/**', startIdx + 100);
if (nextComment === -1) {
  console.log('Could not find next comment');
  process.exit(1);
}

console.log('Found verify endpoint from', commentStart, 'to', nextComment);

// Replace
const newContent = content.substring(0, commentStart) + newEndpoint + content.substring(nextComment);
fs.writeFileSync(filePath, newContent);
console.log('Successfully replaced verify endpoint!');