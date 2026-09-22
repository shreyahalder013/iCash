/**
 * AssistantController
 *
 * Exposes endpoints for managing trusted helpers, authorized representatives,
 * and emergency assistance requests.
 */

const TrustedAssistantService = require('../services/trustedAssistantService');

class AssistantController {
  static async listAssistants(req, res, next) {
    try {
      const assistants = await TrustedAssistantService.listAssistants(req.user.id);
      res.json({ ok: true, assistants });
    } catch (err) {
      next(err);
    }
  }

  static async registerAssistant(req, res, next) {
    try {
      const { name, phone, relation, role } = req.body;
      const assistant = await TrustedAssistantService.registerAssistant(req.user.id, {
        name,
        phone,
        relation,
        role,
      });
      res.status(201).json({ ok: true, message: 'Trusted assistant registered successfully.', assistant });
    } catch (err) {
      next(err);
    }
  }

  static async getPermissions(req, res, next) {
    try {
      const role = req.query.role || req.params.role || 'TRUSTED_HELPER';
      const permissions = TrustedAssistantService.getPermissions(role);
      res.json({ ok: true, role, permissions });
    } catch (err) {
      next(err);
    }
  }

  static async createDraftTransfer(req, res, next) {
    try {
      const { assistantId, amount, recipientName, recipientAccount } = req.body;
      const draft = await TrustedAssistantService.createDraftAssistantTransfer(
        req.user.id,
        assistantId,
        { amount, recipientName, recipientAccount }
      );
      res.status(201).json({
        ok: true,
        message: 'Draft transfer created. Owner approval is required before funds can move.',
        draft,
      });
    } catch (err) {
      next(err);
    }
  }

  static async requestEmergencyAssistance(req, res, next) {
    try {
      const result = await TrustedAssistantService.requestEmergencyAssistance(req.user.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = AssistantController;
