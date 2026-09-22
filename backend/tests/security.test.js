const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');
const { signToken } = require('../src/utils/token');

describe('Security Events & Biometrics APIs', () => {
  let regularUser;
  let userToken;

  beforeAll(async () => {
    regularUser = await prisma.user.findFirst({ where: { role: 'USER' } });
    userToken = signToken({ userId: regularUser.id, role: regularUser.role });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('POST /api/security/events - Logs MULTIPLE_FACE_DETECTED anomaly', async () => {
    const res = await request(app)
      .post('/api/security/events')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        eventType: 'MULTIPLE_FACE_DETECTED',
        severity: 'HIGH',
        description: 'Two faces detected during biometric scan.',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const saved = await prisma.securityEvent.findFirst({
      where: {
        user_id: regularUser.id,
        event_type: 'MULTIPLE_FACE_DETECTED',
      },
    });
    expect(saved).not.toBeNull();
    expect(saved.severity).toBe('HIGH');
  });

  test('GET /api/security/status - Returns security status and active alerts', async () => {
    const res = await request(app)
      .get('/api/security/status')
      .set('Cookie', [`icash_session=${userToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBeDefined();
    expect(res.body.status.accountStatus).toBe('ACTIVE');
    expect(res.body.status.isLocked).toBe(false);
  });

  test('POST /api/biometric/enroll - Rejects enrollment without verified biometricToken', async () => {
    const mockVector = Array.from({ length: 128 }, (_, i) => Math.sin(i));
    const res = await request(app)
      .post('/api/biometric/enroll')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({ descriptors: [mockVector] });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('BiometricTokenRequired');
  });

  test('POST /api/biometric/enroll & /verify - Server-side facial verification with valid token', async () => {
    const jwt = require('jsonwebtoken');
    const bioSecret = (process.env.JWT_SECRET || 'icash-insecure-secret-key-change-in-prod') + ':biometric-challenge-token-v1';
    const validBioToken = jwt.sign(
      { sub: regularUser.id, challengeId: 'test-challenge', purpose: 'biometric-auth', livenessOk: true },
      bioSecret,
      { expiresIn: 180 }
    );

    // Generate a mock 128D descriptor vector
    const mockVector = Array.from({ length: 128 }, (_, i) => Math.sin(i));

    const enrollRes = await request(app)
      .post('/api/biometric/enroll')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        biometricToken: validBioToken,
        descriptors: [mockVector],
      });

    expect(enrollRes.status).toBe(200);
    expect(enrollRes.body.ok).toBe(true);

    // Verify with same vector (exact match -> distance 0)
    const verifyRes = await request(app)
      .post('/api/biometric/verify')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        liveDescriptor: mockVector,
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.matched).toBe(true);
    expect(verifyRes.body.userId).toBe(regularUser.id);
  });

  test('POST /api/biometric/challenge & verify-challenge flow', async () => {
    // 1. Issue challenge
    const challengeRes = await request(app)
      .post('/api/biometric/challenge')
      .send({});

    expect(challengeRes.status).toBe(200);
    expect(challengeRes.body.ok).toBe(true);
    expect(challengeRes.body.challengeId).toBeDefined();
    expect(challengeRes.body.nonce).toBeDefined();
    expect(challengeRes.body.challengeType).toBeDefined();

    // 2. Reject verification if proof or face matching fails
    const mockVector = Array.from({ length: 128 }, (_, i) => Math.sin(i));
    const badVerifyRes = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: challengeRes.body.challengeId,
        nonce: challengeRes.body.nonce,
        liveDescriptor: mockVector,
        // Missing proof frames and no liveness server -> will reject liveness with 403 Forbidden
      });

    expect(badVerifyRes.status).toBe(403);
    expect(badVerifyRes.body.ok).toBe(false);

    // 3. Successfully verify when proof frames and target user are provided
    const goodChallengeRes = await request(app)
      .post('/api/biometric/challenge')
      .send({ userIdHint: regularUser.id });

    // Generate valid 2-blink temporal proof sequence (>12 frames, >800ms)
    const validProof = [];
    let t = 100000;
    for (let i = 0; i < 6; i++) {
      validProof.push({ timestamp: t, leftEAR: 0.30, rightEAR: 0.30, state: 'OPEN' });
      t += 100;
    }
    // Blink 1
    validProof.push({ timestamp: t, leftEAR: 0.12, rightEAR: 0.12, state: 'CLOSED' });
    t += 160;
    validProof.push({ timestamp: t, leftEAR: 0.30, rightEAR: 0.30, state: 'OPEN' });
    t += 350; // debounce gap > 250ms
    // Blink 2
    validProof.push({ timestamp: t, leftEAR: 0.12, rightEAR: 0.12, state: 'CLOSED' });
    t += 160;
    validProof.push({ timestamp: t, leftEAR: 0.30, rightEAR: 0.30, state: 'OPEN' });
    t += 100;
    for (let i = 0; i < 5; i++) {
      validProof.push({ timestamp: t, leftEAR: 0.30, rightEAR: 0.30, state: 'OPEN' });
      t += 100;
    }

    const goodVerifyRes = await request(app)
      .post('/api/biometric/verify-challenge')
      .send({
        challengeId: goodChallengeRes.body.challengeId,
        nonce: goodChallengeRes.body.nonce,
        liveDescriptor: mockVector,
        userId: regularUser.id,
        challengeProof: validProof,
      });

    expect(goodVerifyRes.status).toBe(200);
    expect(goodVerifyRes.body.ok).toBe(true);
    expect(goodVerifyRes.body.biometricToken).toBeDefined();
    expect(goodVerifyRes.body.userId).toBe(regularUser.id);
  });
});
