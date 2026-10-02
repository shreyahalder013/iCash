const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');

describe('Email Verification System (zahid-afridi/EmailVerfication)', () => {
  const testPhone = '9977553311';
  const testEmail = 'verify.test@icash.bank';
  const testAadhaar = '987654321098';

  beforeAll(async () => {
    await prisma.user.deleteMany({
      where: {
        OR: [{ phone: testPhone }, { email: testEmail }],
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: {
        OR: [{ phone: testPhone }, { email: testEmail }],
      },
    });
    await prisma.$disconnect();
  });

  let verificationCode = null;
  let userId = null;
  let sessionCookie = null;

  test('POST /api/auth/register - Generates 6-digit email verification token and sets email_verified=false', async () => {
    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Email Verification User',
      phone: testPhone,
      email: testEmail,
      aadhaarNumber: testAadhaar,
      pin: '1234',
      emergencyPin: '4321',
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe(testEmail);
    expect(res.body.user.emailVerified).toBe(false);

    // Capture session cookie
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      sessionCookie = cookies[0].split(';')[0];
    }

    userId = res.body.user.id;

    // Check database record
    const userInDb = await prisma.user.findUnique({
      where: { id: userId },
    });

    expect(userInDb).toBeTruthy();
    expect(userInDb.email_verified).toBe(false);
    expect(userInDb.email_verification_token).toMatch(/^\d{6}$/);
    expect(userInDb.email_verification_expires_at).toBeTruthy();
    expect(new Date(userInDb.email_verification_expires_at).getTime()).toBeGreaterThan(Date.now());

    verificationCode = userInDb.email_verification_token;
  });

  test('POST /api/auth/verify-email - Fails with invalid code', async () => {
    const res = await request(app).post('/api/auth/verify-email').send({
      email: testEmail,
      code: '000000',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or expired code/i);
  });

  test('POST /api/auth/verify-email - Fails with expired code', async () => {
    // Manually expire token in database
    await prisma.user.update({
      where: { id: userId },
      data: {
        email_verification_expires_at: new Date(Date.now() - 10000),
      },
    });

    const res = await request(app).post('/api/auth/verify-email').send({
      email: testEmail,
      code: verificationCode,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or expired code/i);
  });

  test('POST /api/auth/resend-verification - Generates fresh verification code', async () => {
    const res = await request(app).post('/api/auth/resend-verification').send({
      email: testEmail,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/verification code resent/i);

    const refreshedUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    expect(refreshedUser.email_verification_token).toMatch(/^\d{6}$/);
    expect(new Date(refreshedUser.email_verification_expires_at).getTime()).toBeGreaterThan(
      Date.now()
    );

    verificationCode = refreshedUser.email_verification_token;
  });

  test('POST /api/auth/verifyEmail (reference route) - Verifies email with valid code', async () => {
    const res = await request(app).post('/api/auth/verifyEmail').send({
      email: testEmail,
      code: verificationCode,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Email Verified Successfully');
    expect(res.body.user.emailVerified).toBe(true);

    const verifiedUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    expect(verifiedUser.email_verified).toBe(true);
    expect(verifiedUser.email_verification_token).toBeNull();
    expect(verifiedUser.email_verification_expires_at).toBeNull();
  });

  test('GET /api/auth/verification-status - Reflects verified email status in session', async () => {
    const res = await request(app)
      .get('/api/auth/verification-status')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe(testEmail);
    expect(res.body.emailVerified).toBe(true);
  });

  describe('Exact zahid-afridi/EmailVerfication Route Compatibility (/auth)', () => {
    const directEmail = 'direct.compat@icash.bank';

    beforeAll(async () => {
      await prisma.user.deleteMany({ where: { email: directEmail } });
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { email: directEmail } });
    });

    let directCode = null;

    test('POST /auth/register - Accepts { name, email, password } and sends verification email', async () => {
      const res = await request(app).post('/auth/register').send({
        name: 'John Doe',
        email: directEmail,
        password: 'password123',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeTruthy();
      expect(res.body.user.email).toBe(directEmail);
      expect(res.body.user.emailVerified).toBe(false);
      expect(res.body.devCode).toMatch(/^\d{6}$/);

      directCode = res.body.devCode;
    });

    test('POST /auth/verifyEmail - Verifies with { code } only', async () => {
      const res = await request(app).post('/auth/verifyEmail').send({
        code: directCode,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Email Verified Successfully');
      expect(res.body.user.emailVerified).toBe(true);
    });
  });
});
