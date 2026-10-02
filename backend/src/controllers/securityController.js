const prisma = require('../prisma');
const SecurityService = require('../services/securityService');

class SecurityController {
  static async getSecurityStatus(req, res, next) {
    try {
      const recentEvents = await prisma.securityEvent.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' },
        take: 10,
      });

      const duressEvents = recentEvents.filter((e) => e.event_type === 'DURESS_ALERT');
      const multiFaceEvents = recentEvents.filter((e) => e.event_type === 'MULTIPLE_FACE_DETECTED');
      const isLocked =
        req.user.status === 'LOCKED' ||
        Boolean(req.user.locked_until && req.user.locked_until > new Date());

      res.json({
        ok: true,
        status: {
          accountStatus: req.user.status,
          failedLoginAttempts: req.user.failed_login_attempts,
          isLocked: Boolean(isLocked),
          hasActiveDuressAlert: duressEvents.length > 0,
          duressAlertCount: duressEvents.length,
          multiFaceAlertCount: multiFaceEvents.length,
          lastLoginAt: req.user.last_login_at,
        },
        recentEvents,
        user: require('../services/authService').toSafeUser(
          req.user,
          req.user.accounts?.[0] || null
        ),
      });
    } catch (err) {
      next(err);
    }
  }

  static async getSecurityEvents(req, res, next) {
    try {
      const { limit = 20 } = req.query;
      const events = await prisma.securityEvent.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' },
        take: Number(limit),
      });

      res.json({
        ok: true,
        events,
      });
    } catch (err) {
      next(err);
    }
  }

  static async reportSecurityEvent(req, res, next) {
    try {
      const { eventType, severity, description, deviceReference } = req.body;
      const userId = req.user ? req.user.id : null;

      const event = await SecurityService.recordEvent({
        userId,
        eventType,
        severity: severity || 'MEDIUM',
        description,
        ipAddress: req.ip,
        deviceReference: deviceReference || req.headers['user-agent'],
      });

      res.status(201).json({
        ok: true,
        message: 'Security event recorded.',
        event,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = SecurityController;
