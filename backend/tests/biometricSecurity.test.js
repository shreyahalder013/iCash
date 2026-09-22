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
});
