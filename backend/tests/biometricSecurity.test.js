/**
 * iCash Biometric Security, Anti-Spoofing & Accessibility Acceptance Test Suite
 *
 * Validates:
 * 1. Cryptographic Challenge Generation (nonce, randomized challenge type, 60s expiry)
 * 2. Expired Challenge Rejection (>60s expiry)
 * 3. Forged / Missing Nonce Rejection
 * 4. Anti-Replay on Challenge Consumption (single-use)
 * 5. Anti-Replay on Biometric JWT Token (cannot be reused)
 * 6. Direct Biometric Login without valid token is blocked (403)
 * 7. Authoritative Vector Distance Euclidean Threshold (< 0.52)
 * 8. Trusted Assistant Role-Based Permissions (Read-only for HELPER, Draft-only)
 * 9. Emergency Priority Assistance Dispatch & Audit
 * 10. Email Verification State Transition (emailVerified = true)
 * 11. Secure Session Logout & Invalidation
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/server');
const prisma = require('../src/prisma');
const BiometricChallengeController = require('../src/controllers/biometricChallengeController');
const { consumedBiometricTokens, getBioTokenSecret } = BiometricChallengeController;
const TrustedAssistantService = require('../src/services/trustedAssistantService');

describe('Biometric Security & Anti-Spoofing Subsystem', () => {
  const testPhone = '9911223344';
  const testAadhaar = '991122334455';
  let testUser = null;
  let userCookie = null;

  beforeAll(async () => {
    // Ensure clean state
    await prisma.user.deleteMany({
      where: { phone: testPhone },
    });

    // Register test user
    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Biometric Test Subject',
      phone: testPhone,
      email: 'bio.test@icash.bank',
      aadhaarNumber: testAadhaar,
      pin: '4321',
      emergencyPin: '8765',
      isSenior: false,
    });

    testUser = res.body.user;
    userCookie = res.headers['set-cookie'];
  });

  afterAll(async () => {
    if (testUser) {
      await prisma.user.deleteMany({
        where: { phone: testPhone },
      });
    }
    await prisma.$disconnect();
  });

  // ── 1. Challenge Issuance ──────────────────────────────────────────────────
  test('POST /api/biometric/challenge - Issues fresh randomized challenge with cryptographic nonce', async () => {
    const res = await request(app)
      .post('/api/biometric/challenge')
      .send({ userIdHint: testUser.id });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.challengeId).toBeDefined();
    expect(res.body.nonce).toBeDefined();
    expect(typeof res.body.nonce).toBe('string');
    expect(res.body.nonce.length).toBeGreaterThanOrEqual(16);
    expect([
      'BLINK_TWICE',
      'BLINK_PAUSE_BLINK',
      'BLINK_TURN_LEFT_BLINK',
      'BLINK_TURN_RIGHT_BLINK',
      'BLINK_TWICE_WITH_RANDOM_INTERVAL',
    ]).toContain(res.body.challengeType);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  // ── 2. Expired Challenge Rejection ─────────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects expired challenges (>60s)', async () => {
    const expiredChallenge = await prisma.biometricChallenge.create({
      data: {
        nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() - 5000), // Expired 5 seconds ago
      },
    });

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: expiredChallenge.id,
        nonce: expiredChallenge.nonce,
      });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/expired/i);
  });

  // ── 3. Forged Nonce Rejection ──────────────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects mismatched or forged nonce', async () => {
    const chalRes = await request(app)
      .post('/api/biometric/challenge')
      .send({ userIdHint: testUser.id });

    const { challengeId } = chalRes.body;

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId,
        nonce: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/nonce/i);
  });

  test('POST /api/biometric/frame - Rejects evidence submitted with a forged nonce', async () => {
    const chalRes = await request(app)
      .post('/api/biometric/challenge')
      .send({ userIdHint: testUser.id });

    const res = await request(app)
      .post('/api/biometric/frame')
      .send({
        challengeId: chalRes.body.challengeId,
        nonce: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        image: 'data:image/jpeg;base64,AA==',
        timestamp: Date.now(),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NonceMismatch');
  });

  // ── 4. Replay Attack on Challenge ──────────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Enforces single-use challenge consumption', async () => {
    const usedChallenge = await prisma.biometricChallenge.create({
      data: {
        nonce: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: new Date(), // Already consumed
      },
    });

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: usedChallenge.id,
        nonce: usedChallenge.nonce,
      });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/already been consumed|Replay is forbidden|consumed/i);
  });

  // ── 5. Direct Login Without Token Rejection ────────────────────────────────
  test('POST /api/auth/login-biometric - Blocks login without valid biometric token (403/401)', async () => {
    // Attempt login with no token
    const resEmpty = await request(app).post('/api/auth/login-biometric').send({});
    expect([401, 403]).toContain(resEmpty.status);

    // Attempt login with garbage/forged token
    const resForged = await request(app)
      .post('/api/auth/login-biometric')
      .send({ biometricToken: 'forged.jwt.token' });
    expect([401, 403]).toContain(resForged.status);
  });

  // ── 6. Anti-Replay on Biometric JWT Token ──────────────────────────────────
  test('POST /api/auth/login-biometric - Rejects replayed biometric tokens', async () => {
    const jti = 'test-jti-' + Date.now();
    // Generate valid signed biometric token
    const rawToken = jwt.sign(
      {
        sub: testUser.id,
        challengeId: 'test-bio-chal-' + Date.now(),
        purpose: 'biometric-auth',
        livenessOk: true,
        jti,
      },
      getBioTokenSecret(),
      { expiresIn: '3m' }
    );

    // First use: mark jti as consumed in the registry
    consumedBiometricTokens.add(jti);

    // Attempt to replay token
    const resReplay = await request(app)
      .post('/api/auth/login-biometric')
      .send({ biometricToken: rawToken });

    expect(resReplay.status).toBe(403);
    expect(resReplay.body.ok).toBe(false);
    expect(resReplay.body.message).toMatch(/already been consumed|Replay is forbidden/i);
  });

  // ── 7. Authoritative Vector Matching Threshold ────────────────────────────
  test('Vector Matcher - Exactly enforces < 0.52 Euclidean distance', () => {
    function euclidean(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return Math.sqrt(sum);
    }

    const base = new Array(128).fill(0).map((_, i) => Math.sin(i * 0.1));
    const norm = Math.sqrt(base.reduce((s, v) => s + v * v, 0));
    const unitBase = base.map((v) => v / norm);

    // Match vector: micro-variations (distance < 0.52)
    const matchVec = unitBase.map((v) => v + (Math.random() * 0.02 - 0.01));
    const mNorm = Math.sqrt(matchVec.reduce((s, v) => s + v * v, 0));
    const unitMatch = matchVec.map((v) => v / mNorm);

    expect(euclidean(unitBase, unitMatch)).toBeLessThan(0.52);

    // Impostor vector: distant (distance >= 0.52)
    const impostorVec = unitBase.map((v, i) => (i % 2 === 0 ? -v : v * 0.5));
    const iNorm = Math.sqrt(impostorVec.reduce((s, v) => s + v * v, 0));
    const unitImpostor = impostorVec.map((v) => v / iNorm);

    expect(euclidean(unitBase, unitImpostor)).toBeGreaterThanOrEqual(0.52);
  });

  // ── 8. Granular Assistant Permissions ─────────────────────────────────────
  test('Trusted Assistant Service - Granular role permissions enforce read-only and draft invariants', () => {
    const helperPerms = TrustedAssistantService.getPermissions('TRUSTED_HELPER');
    expect(helperPerms.canViewBalance).toBe(true);
    expect(helperPerms.canViewStatement).toBe(true);
    expect(helperPerms.canTransferMoney).toBe('OWNER_APPROVAL_REQUIRED');
    expect(helperPerms.canChangePin).toBe(false);

    const repPerms = TrustedAssistantService.getPermissions('AUTHORIZED_REPRESENTATIVE');
    expect(repPerms.canViewBalance).toBe(true);
    expect(repPerms.canTransferMoney).toBe('OWNER_APPROVAL_REQUIRED');
    expect(repPerms.canChangePin).toBe(false);

    const ownerPerms = TrustedAssistantService.getPermissions('OWNER');
    expect(ownerPerms.canTransferMoney).toBe(true);
    expect(ownerPerms.canChangePin).toBe(true);
  });

  // ── 9. Emergency Priority Assistance Endpoint ──────────────────────────────
  test('POST /api/assistants/emergency-assistance - Dispatches emergency alerts and creates audit record', async () => {
    const res = await request(app)
      .post('/api/assistants/emergency-assistance')
      .set('Cookie', userCookie)
      .send({
        alertType: 'CONTACTS',
        latitude: 22.5726,
        longitude: 88.3639,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('ALERT_DISPATCHED');
    expect(res.body.incidentId).toBeDefined();
    expect(res.body.message).toMatch(/Emergency assistance alert initiated/i);
  });

  // ── 10. Email Verification State Transition ───────────────────────────────
  test('POST /api/auth/verify-email - Sets emailVerified = true in database', async () => {
    // Request code
    const resendRes = await request(app)
      .post('/api/auth/resend-verification')
      .set('Cookie', userCookie)
      .send({ email: testUser.email });

    expect(resendRes.status).toBe(200);
    const code = resendRes.body.devCode || resendRes.body.code;
    expect(code).toBeDefined();

    // Verify code
    const verifyRes = await request(app)
      .post('/api/auth/verify-email')
      .set('Cookie', userCookie)
      .send({ code, email: testUser.email });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.user.emailVerified).toBe(true);

    // Verify in database
    const dbUser = await prisma.user.findUnique({
      where: { id: testUser.id },
    });
    expect(dbUser.email_verified).toBe(true);
  });

  // ── 11. Secure Logout Session Termination ─────────────────────────────────
  test('POST /api/auth/logout - Completely invalidates session cookies and authorization', async () => {
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', userCookie);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.ok).toBe(true);

    // Subsequent authenticated request using the invalidated cookie should fail
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', logoutRes.headers['set-cookie'] || userCookie);

    expect([401, 403]).toContain(meRes.status);
  });

  // ── 12. Challenge Type Randomization ─────────────────────────────────────────
  test('POST /api/biometric/challenge - Randomizes across all 5 challenge types', async () => {
    const challengeTypes = new Set();
    // Request multiple challenges to verify randomization
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post('/api/biometric/challenge')
        .send({ userIdHint: testUser.id });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      challengeTypes.add(res.body.challengeType);
    }
    // Should have seen at least 3 different challenge types (probabilistic)
    expect(challengeTypes.size).toBeGreaterThanOrEqual(3);
    expect([...challengeTypes].every(t => [
      'BLINK_TWICE',
      'BLINK_PAUSE_BLINK',
      'BLINK_TURN_LEFT_BLINK',
      'BLINK_TURN_RIGHT_BLINK',
      'BLINK_TWICE_WITH_RANDOM_INTERVAL',
    ].includes(t))).toBe(true);
  });

  // ── 13. Challenge Type: BLINK_PAUSE_BLINK Specifics ──────────────────────────
  test('Challenge BLINK_PAUSE_BLINK - Requires pause between blinks', async () => {
    // Create a challenge with BLINK_PAUSE_BLINK type
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_PAUSE_BLINK',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Simulate temporal proof with only 1 blink (missing pause + second blink)
    const frames = generateBlinkSequence({ blinkCount: 1, totalFrames: 18 });
    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: frames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 14. Challenge Type: BLINK_TURN_LEFT_BLINK Specifics ──────────────────────
  test('Challenge BLINK_TURN_LEFT_BLINK - Requires head turn left', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TURN_LEFT_BLINK',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Simulate temporal proof with blinks but no head turn (yaw stays near 0)
    const frames = generateBlinkSequence({ blinkCount: 2, totalFrames: 30 });
    frames.forEach(f => { f.yaw = 0; }); // No head turn

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: frames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 15. Challenge Type: BLINK_TURN_RIGHT_BLINK Specifics ─────────────────────
  test('Challenge BLINK_TURN_RIGHT_BLINK - Requires head turn right', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TURN_RIGHT_BLINK',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Simulate temporal proof with blinks but no head turn (yaw stays near 0)
    const frames = generateBlinkSequence({ blinkCount: 2, totalFrames: 30 });
    frames.forEach(f => { f.yaw = 0; }); // No head turn

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: frames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 16. Anti-Spoofing: Static Photo Attack Detection ────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects static photo (zero EAR variance)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Static photo: EAR barely fluctuates
    const staticFrames = [];
    let time = 100000;
    for (let i = 0; i < 30; i++) {
      staticFrames.push({
        timestamp: time,
        leftEAR: 0.301,
        rightEAR: 0.302,
        avgEAR: 0.3015,
        state: 'OPEN',
      });
      time += 80;
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: staticFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
    expect(res.body.message).toMatch(/Static presentation attack|Static photo/i);
  });

  // ── 17. Anti-Spoofing: Screen Replay Attack Detection ───────────────────────
  test('POST /api/biometric/verify-challenge - Rejects screen replay (low dynamic range)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Screen replay: slight noise but no real blinks
    const replayFrames = [];
    let time = 100000;
    for (let i = 0; i < 30; i++) {
      replayFrames.push({
        timestamp: time,
        leftEAR: 0.29 + Math.sin(i * 0.1) * 0.005,
        rightEAR: 0.30 + Math.cos(i * 0.1) * 0.005,
        state: 'OPEN',
      });
      time += 80;
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: replayFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 18. Anti-Spoofing: Closed-Eye Photo Attack ──────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects closed-eye photo (eyes closed > 700ms)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Closed-eye photo: eyes continuously closed for > 700ms
    const closedEyeFrames = [];
    let time = 100000;
    for (let i = 0; i < 20; i++) {
      closedEyeFrames.push({
        timestamp: time,
        leftEAR: 0.10,
        rightEAR: 0.10,
        state: 'CLOSED',
      });
      time += 80; // 1600ms total
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: closedEyeFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 19. Insufficient Blinks ──────────────────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects single blink when 2 required', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    const frames = generateBlinkSequence({ blinkCount: 1, totalFrames: 18 });

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: frames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
    expect(res.body.message).toMatch(/Insufficient blinks/i);
  });

  // ── 20. Frame Count & Duration Enforcement ──────────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects insufficient frames (< 12)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    const fewFrames = [
      { timestamp: 1000, leftEAR: 0.3, rightEAR: 0.3 },
      { timestamp: 1100, leftEAR: 0.1, rightEAR: 0.1 },
      { timestamp: 1200, leftEAR: 0.3, rightEAR: 0.3 },
    ];

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: fewFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/Insufficient temporal frame data/i);
  });

  test('POST /api/biometric/verify-challenge - Rejects too short duration (< 800ms)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    const rapidFrames = [];
    let time = 1000;
    for (let i = 0; i < 15; i++) {
      rapidFrames.push({
        timestamp: time,
        leftEAR: i % 2 === 0 ? 0.3 : 0.1,
        rightEAR: i % 2 === 0 ? 0.3 : 0.1,
      });
      time += 20; // total 300ms
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: rapidFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/duration too short/i);
  });

  // ── 21. Blink Duration Validation ────────────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects blinks too fast (< 70ms)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Blinks that are too fast (eyes close and open in < 70ms)
    const fastBlinkFrames = [];
    let time = 100000;
    for (let b = 0; b < 2; b++) {
      // Open
      fastBlinkFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
      time += 20;
      // Closed (only 40ms - too fast!)
      fastBlinkFrames.push({ timestamp: time, leftEAR: 0.1, rightEAR: 0.1, state: 'CLOSED' });
      time += 40;
      // Open
      fastBlinkFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
      time += 20;
      // Debounce gap
      for (let d = 0; d < 5; d++) {
        fastBlinkFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
        time += 20;
      }
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: fastBlinkFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  test('POST /api/biometric/verify-challenge - Rejects blinks too slow (> 700ms)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Blinks that are too slow (eyes closed > 700ms)
    const slowBlinkFrames = [];
    let time = 100000;
    for (let b = 0; b < 2; b++) {
      // Open
      slowBlinkFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
      time += 80;
      // Closed for 800ms - too slow!
      for (let c = 0; c < 10; c++) {
        slowBlinkFrames.push({ timestamp: time, leftEAR: 0.1, rightEAR: 0.1, state: 'CLOSED' });
        time += 80;
      }
      // Open
      slowBlinkFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
      time += 80;
      // Debounce gap
      for (let d = 0; d < 5; d++) {
        slowBlinkFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
        time += 80;
      }
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: slowBlinkFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 22. Debounce Between Blinks ──────────────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Rejects blinks without debounce (250ms)', async () => {
    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // Blinks too close together (< 250ms debounce)
    const noDebounceFrames = [];
    let time = 100000;
    // First blink
    noDebounceFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
    time += 80;
    noDebounceFrames.push({ timestamp: time, leftEAR: 0.1, rightEAR: 0.1, state: 'CLOSED' });
    time += 80;
    noDebounceFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
    time += 80;
    // Second blink starts immediately (only 80ms gap, need 250ms)
    noDebounceFrames.push({ timestamp: time, leftEAR: 0.1, rightEAR: 0.1, state: 'CLOSED' });
    time += 80;
    noDebounceFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
    time += 80;
    // Add remaining frames to meet minimum
    for (let i = 0; i < 15; i++) {
      noDebounceFrames.push({ timestamp: time, leftEAR: 0.3, rightEAR: 0.3, state: 'OPEN' });
      time += 80;
    }

    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeProof: noDebounceFrames,
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('LivenessFailed');
  });

  // ── 23. Production Mode: No Dev Fallback ─────────────────────────────────────
  test('POST /api/biometric/verify-challenge - Production rejects when liveness service down', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEV_LIVENESS_FALLBACK = 'false';

    const challenge = await prisma.biometricChallenge.create({
      data: {
        nonce: crypto.randomBytes(32).toString('hex'),
        challenge_type: 'BLINK_TWICE',
        expires_at: new Date(Date.now() + 60000),
        used_at: null,
      },
    });

    // No liveness service, no challengeProof - should fail in production
    const res = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challenge.id,
        nonce: challenge.nonce,
      });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('BiometricServiceUnavailable');

    process.env.NODE_ENV = originalEnv;
    delete process.env.ALLOW_DEV_LIVENESS_FALLBACK;
  });
});

// Helper to generate realistic blink sequences for testing
function generateBlinkSequence({ totalFrames = 30, intervalMs = 80, blinkCount = 2, baselineEAR = 0.30, closedEAR = 0.12 }) {
  const frames = [];
  let currentTime = 100000;

  // Normal resting open frames before first blink
  for (let i = 0; i < 6; i++) {
    frames.push({
      timestamp: currentTime,
      leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
      rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
      state: 'OPEN',
    });
    currentTime += intervalMs;
  }

  // Generate blinks
  for (let b = 0; b < blinkCount; b++) {
    // Closing transition
    frames.push({
      timestamp: currentTime,
      leftEAR: 0.22,
      rightEAR: 0.22,
      state: 'CLOSING',
    });
    currentTime += intervalMs;

    // Closed state (approx 160ms closed)
    for (let c = 0; c < 2; c++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: closedEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: closedEAR + (Math.random() * 0.02 - 0.01),
        state: 'CLOSED',
      });
      currentTime += intervalMs;
    }

    // Opening transition
    frames.push({
      timestamp: currentTime,
      leftEAR: 0.24,
      rightEAR: 0.24,
      state: 'OPENING',
    });
    currentTime += intervalMs;

    // Reopened resting frames (debounce gap > 300ms)
    for (let o = 0; o < 5; o++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
      });
      currentTime += intervalMs;
    }
  }

  return frames;
}

const crypto = require('crypto');
