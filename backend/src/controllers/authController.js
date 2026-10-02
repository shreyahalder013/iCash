const AuthService = require('../services/authService');
const {
  COOKIE_NAME,
  getCookieOptions,
  getClearCookieOptions,
  signToken,
} = require('../utils/token');

class AuthController {
  static async register(req, res, next) {
    try {
      const { user, token, verificationCode } = await AuthService.registerUser(req.body, req);
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.cookie('token', token, getCookieOptions());
      res.status(201).json({
        ok: true,
        success: true,
        message: 'Registration completed successfully.',
        user,
        token,
        ...(process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP === 'true'
          ? { devCode: verificationCode, code: verificationCode }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  }

  static async lookupAadhaar(req, res, next) {
    try {
      const { aadhaarLast4 } = req.body;
      const matchingUsers = await AuthService.findByAadhaarLast4(aadhaarLast4);
      res.json({ ok: true, users: matchingUsers });
    } catch (err) {
      next(err);
    }
  }

  static async loginBiometric(req, res, next) {
    try {
      const userId = req.biometricUserId;
      if (!userId) {
        return res
          .status(403)
          .json({ ok: false, message: 'Biometric authentication is required.' });
      }
      const { user, token } = await AuthService.loginWithBiometric(userId, req);
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.cookie('token', token, getCookieOptions());
      res.json({ ok: true, message: 'Biometric authentication successful.', user, token });
    } catch (err) {
      next(err);
    }
  }

  static async loginPin(req, res, next) {
    try {
      const { userId, pin } = req.body;
      const { user, token, isDuress } = await AuthService.loginWithPin(userId, pin, req);
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.cookie('token', token, getCookieOptions());
      res.json({
        ok: true,
        message: isDuress ? 'Emergency access mode active.' : 'Authenticated successfully.',
        user,
        token,
        isDuress,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req, res, next) {
    try {
      const primaryAccount = req.user.accounts && req.user.accounts[0];
      res.json({ ok: true, user: AuthService.toSafeUser(req.user, primaryAccount) });
    } catch (err) {
      next(err);
    }
  }

  static async logout(req, res, next) {
    try {
      if (req.user) await AuthService.logout(req.user.id);
      // Always clear both current and legacy cookie names, even if the session
      // has already expired. Logout must be idempotent from the browser.
      res.clearCookie(COOKIE_NAME, getClearCookieOptions());
      res.clearCookie('token', getClearCookieOptions());
      res.json({ ok: true, message: 'Logged out successfully.' });
    } catch (err) {
      next(err);
    }
  }

  static async refresh(req, res, next) {
    try {
      if (!req.user || !req.sessionReference) {
        return res.status(401).json({ ok: false, message: 'Session expired.' });
      }

      // Keep the existing server-side session reference. The session middleware
      // already validates it and the JWT remains short-lived and cookie-only.
      const token = signToken({
        userId: req.user.id,
        role: req.user.role,
        sessionReference: req.sessionReference,
      });
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  static async deleteMe(req, res, next) {
    try {
      await AuthService.deleteUserAccount(req.user && req.user.id, req.body?.pin, req);
      res.clearCookie(COOKIE_NAME, getClearCookieOptions());
      res.json({ ok: true, message: 'Your account has been permanently deleted.' });
    } catch (err) {
      next(err);
    }
  }

  static async verifyEmail(req, res, next) {
    try {
      const code = req.body?.code || req.body?.verificationCode;
      const email = req.body?.email;
      const userId = req.user?.id;
      const result = await AuthService.verifyEmail({ code, email, userId });
      res.status(200).json(result);
    } catch (err) {
      if (
        err.status === 400 ||
        err.message === 'Invalid or Expired Code' ||
        err.message === 'Verification code is required'
      ) {
        return res.status(400).json({ success: false, ok: false, message: err.message });
      }
      next(err);
    }
  }

  static async resendVerification(req, res, next) {
    try {
      const email = req.body?.email;
      const userId = req.user?.id;
      const result = await AuthService.resendVerificationEmail({ email, userId });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getVerificationStatus(req, res, next) {
    try {
      res.json({
        ok: true,
        email: req.user?.email || null,
        emailVerified: Boolean(req.user?.email_verified),
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = AuthController;
