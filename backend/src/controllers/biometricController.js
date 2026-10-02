const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma');
const { biometricService } = require('../services/biometricService');
const SecurityService = require('../services/securityService');

function getBioTokenSecret() {
  const base =
    process.env.BIO_TOKEN_JWT_SECRET ||
    process.env.JWT_SECRET ||
    'icash-insecure-secret-key-change-in-prod';
  return base + ':biometric-challenge-token-v1';
}

class BiometricController {
  /**
   * Enroll or update face descriptors for the authenticated user.
   * REQUIRES: a valid biometricToken issued by verify-challenge (liveness proven).
   * req.biometricUserId is attached by the consumeBiometricToken middleware.
   */
  static async enroll(req, res, next) {
    try {
      const { descriptors } = req.body;

      // Enforce that the authenticated user matches the biometricToken subject.
      if (req.biometricUserId && req.biometricUserId !== req.user.id) {
        await SecurityService.recordEvent({
          userId: req.user.id,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'HIGH',
          description: 'Enrollment rejected: biometricToken user does not match session user.',
          ipAddress: req.ip,
          deviceReference: req.headers['user-agent'],
        });
        return res
          .status(403)
          .json({ ok: false, message: 'Biometric enrollment refused: identity mismatch.' });
      }

      const enrollment = await biometricService.enroll(req.user.id, descriptors);

      const profile = await prisma.biometricProfile.upsert({
        where: { user_id: req.user.id },
        update: {
          biometric_provider: enrollment.provider,
          biometric_reference: enrollment.reference,
          enrollment_status: 'ENROLLED',
          face_descriptors: enrollment.descriptors,
        },
        create: {
          user_id: req.user.id,
          biometric_provider: enrollment.provider,
          biometric_reference: enrollment.reference,
          enrollment_status: 'ENROLLED',
          face_descriptors: enrollment.descriptors,
        },
      });

      await SecurityService.recordEvent({
        userId: req.user.id,
        eventType: 'BIOMETRIC_ENROLLED',
        severity: 'LOW',
        description: `Facial biometric profile enrolled with ${descriptors.length} live sample(s) (liveness verified via biometricToken).`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      res.json({
        ok: true,
        message: 'Biometric profile enrolled successfully.',
        provider: profile.biometric_provider,
        reference: profile.biometric_reference,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Server-side face verification against enrolled template.
   * DEPRECATED for the primary login flow — use POST /verify-challenge instead.
   * This endpoint does NOT validate liveness and must not be used for auth.
   */
  static async verify(req, res, next) {
    try {
      const { liveDescriptor, userId } = req.body;
      let targetUserId = userId || (req.user && req.user.id);

      let profile = null;
      let verifyResult = null;

      if (targetUserId) {
        profile = await prisma.biometricProfile.findUnique({ where: { user_id: targetUserId } });
        if (
          profile &&
          profile.face_descriptors &&
          Array.isArray(profile.face_descriptors) &&
          profile.face_descriptors.length > 0
        ) {
          verifyResult = await biometricService.verify(profile.face_descriptors, liveDescriptor);
        }
      }

      // If no target user specified or not matched on target, attempt matching against all enrolled profiles (1:N matching)
      if (!verifyResult || !verifyResult.matched) {
        const allProfiles = await prisma.biometricProfile.findMany({
          where: { enrollment_status: 'ENROLLED' },
          select: {
            id: true,
            user_id: true,
            face_descriptors: true,
            biometric_provider: true,
            biometric_reference: true,
          },
        });
        let bestDistance = Infinity;
        for (const p of allProfiles) {
          if (
            !p.face_descriptors ||
            !Array.isArray(p.face_descriptors) ||
            p.face_descriptors.length === 0
          )
            continue;
          const r = await biometricService.verify(p.face_descriptors, liveDescriptor);
          if (r.matched && r.distance < bestDistance) {
            bestDistance = r.distance;
            verifyResult = r;
            profile = p;
            targetUserId = p.user_id;
          }
        }
      }

      if (!profile || !verifyResult || !verifyResult.matched) {
        if (targetUserId) {
          await SecurityService.recordEvent({
            userId: targetUserId,
            eventType: 'BIOMETRIC_FAILED',
            severity: 'MEDIUM',
            description: 'Face verification failed: descriptor distance above threshold.',
            ipAddress: req.ip,
            deviceReference: req.headers['user-agent'],
          });
        }
        return res.status(200).json({
          ok: false,
          matched: false,
          confidence: verifyResult ? verifyResult.confidence : 0,
          message: 'Biometric verification failed. Please align your face and try again.',
        });
      }

      await SecurityService.recordEvent({
        userId: targetUserId,
        eventType: 'BIOMETRIC_SUCCESS',
        severity: 'LOW',
        description: 'Face match confirmed.',
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      // SECURITY: POST /verify only provides 1:1 / 1:N descriptor matching.
      // It does NOT verify liveness and MUST NOT issue an authentication biometricToken.
      // All authentication tokens require POST /verify-challenge with authoritative liveness.
      res.json({
        ok: true,
        matched: true,
        confidence: verifyResult.confidence,
        distance: verifyResult.distance,
        provider: verifyResult.provider || profile.biometric_provider,
        reference: profile.biometric_reference,
        userId: targetUserId,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Return enrollment STATUS only — face descriptors are NEVER returned to the browser.
   * Server-side matching via POST /verify-challenge replaced the old download-then-match flow.
   */
  static async getProfile(req, res, next) {
    try {
      const { userId } = req.params;
      if (!userId) return res.status(400).json({ ok: false, message: 'userId required.' });

      const profile = await prisma.biometricProfile.findUnique({
        where: { user_id: userId },
        // SECURITY: face_descriptors intentionally excluded
        select: { enrollment_status: true, biometric_provider: true, updated_at: true },
      });

      if (!profile) return res.json({ ok: true, enrolled: false });

      res.json({
        ok: true,
        enrolled: profile.enrollment_status === 'ENROLLED',
        provider: profile.biometric_provider,
        // face_descriptors deliberately omitted
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = BiometricController;
