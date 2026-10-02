const { verifyToken, COOKIE_NAME } = require('../utils/token');
const prisma = require('../prisma');

function fromNodeHeaders(nodeHeaders) {
  const headers = new Headers();
  if (!nodeHeaders) return headers;
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }
  return headers;
}

let authInstance = null;
try {
  const authModule = require('../auth');
  authInstance = authModule.auth || authModule;
} catch (_) {
  // Better Auth module not available — fallback to JWT-only mode
}

/**
 * Authentication middleware that verifies Better Auth session or JWT from HTTP-only cookie/Authorization header.
 * Attaches the authenticated user database record to req.user.
 */
async function authenticate(req, res, next) {
  try {
    let resolvedUserId = null;

    // 1. Try Better Auth Session verification
    if (authInstance) {
      try {
        const session = await authInstance.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });
        if (session && session.user && session.user.id) {
          resolvedUserId = session.user.id;
          req.session = session.session;
        }
      } catch (betterAuthErr) {
        // Fall through to JWT token checking
      }
    }

    let token = null;
    if (!resolvedUserId) {
      // 2. Check Authorization: Bearer <token> or X-Access-Token header
      if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      } else if (req.headers['x-access-token']) {
        token = req.headers['x-access-token'];
      }
      // 3. Check HTTP-only cookie (primary or legacy name)
      else if (req.cookies && (req.cookies[COOKIE_NAME] || req.cookies['token'])) {
        token = req.cookies[COOKIE_NAME] || req.cookies['token'];
      }

      if (!token) {
        return res.status(401).json({
          ok: false,
          error: 'Unauthorized',
          message: 'Your secure session has expired. Please authenticate again.',
        });
      }

      const decoded = verifyToken(token);
      if (!decoded || !decoded.userId) {
        return res.status(401).json({
          ok: false,
          error: 'Unauthorized',
          message: 'Your secure session has expired. Please authenticate again.',
        });
      }

      resolvedUserId = decoded.userId;

      // Verify the backing session when present.
      if (decoded.sessionReference) {
        try {
          const session = await prisma.loginSession.findUnique({
            where: { session_reference: decoded.sessionReference },
          });
          if (session) {
            if (
              session.user_id !== decoded.userId ||
              session.revoked_at ||
              session.expires_at <= new Date()
            ) {
              return res.status(401).json({
                ok: false,
                error: 'Unauthorized',
                message: 'Your secure session has expired. Please authenticate again.',
              });
            }
            req.sessionReference = session.session_reference;
          } else {
            // If session was cleared (e.g. dev reseed) but user exists and JWT signature is valid, re-anchor session
            await prisma.loginSession
              .create({
                data: {
                  user_id: decoded.userId,
                  session_reference: decoded.sessionReference,
                  ip_address: req.ip,
                  user_agent: req.headers['user-agent'],
                  expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                },
              })
              .catch(() => {});
            req.sessionReference = decoded.sessionReference;
          }
        } catch (dbErr) {
          console.warn('[authMiddleware] Session verification notice:', dbErr.message);
        }
      }
    }

    // Verify user exists and check lock status
    const user = await prisma.user.findUnique({
      where: { id: resolvedUserId },
      include: {
        accounts: {
          where: { status: 'ACTIVE' },
          orderBy: { is_primary: 'desc' },
        },
        biometric_profile: true,
        merchant_profile: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized',
        message: 'Account not found. Please log in again.',
      });
    }

    // Check account status
    if (user.status === 'LOCKED' || (user.locked_until && user.locked_until > new Date())) {
      return res.status(403).json({
        ok: false,
        error: 'AccountLocked',
        message: 'For your protection, access to this account has been temporarily restricted.',
      });
    }

    if (user.status === 'SUSPENDED') {
      return res.status(403).json({
        ok: false,
        error: 'AccountSuspended',
        message: 'This account is currently suspended. Please contact bank support.',
      });
    }

    // Attach user to request — strip all sensitive credential fields first.
    // Never expose password_hash, emergency_pin_hash, or raw aadhaar_reference
    // to controllers, even accidentally via JSON serialization.
    const {
      password_hash: _ph,
      emergency_pin_hash: _eph,
      aadhaar_reference: _ar,
      ...safeUser
    } = user;
    req.user = safeUser;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({
      ok: false,
      error: 'ServerError',
      message: "We're unable to connect to banking services right now. Please try again.",
    });
  }
}

/**
 * Optional authentication middleware that extracts user info if a valid Better Auth session or JWT is present,
 * but does not reject the request if unauthenticated.
 */
async function optionalAuthenticate(req, res, next) {
  try {
    let resolvedUserId = null;

    if (authInstance) {
      try {
        const session = await authInstance.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });
        if (session && session.user && session.user.id) {
          resolvedUserId = session.user.id;
          req.session = session.session;
        }
      } catch (_) {
        // Session lookup failed — fall through to JWT verification
      }
    }

    if (!resolvedUserId) {
      let token = null;
      if (req.cookies && req.cookies[COOKIE_NAME]) {
        token = req.cookies[COOKIE_NAME];
      } else if (req.cookies && req.cookies.token) {
        token = req.cookies.token;
      } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      }

      if (token) {
        const decoded = verifyToken(token);
        if (decoded && decoded.userId) {
          resolvedUserId = decoded.userId;
        }
      }
    }

    if (!resolvedUserId) return next();

    const user = await prisma.user.findUnique({
      where: { id: resolvedUserId },
      include: {
        accounts: {
          where: { status: 'ACTIVE' },
        },
      },
    });

    if (user && user.status === 'ACTIVE') {
      const {
        password_hash: _ph,
        emergency_pin_hash: _eph,
        aadhaar_reference: _ar,
        ...safeUser
      } = user;
      req.user = safeUser;
    }
  } catch (_) {
    // Authentication errors are non-fatal — unauthenticated request continues
  }
  next();
}

module.exports = {
  authenticate,
  optionalAuthenticate,
};
