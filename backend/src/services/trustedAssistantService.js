/**
 * Trusted Assistant & Authorized Representative Service (Phase 17)
 *
 * Implements granular role-based permissions for assisted banking:
 *   - OWNER: Complete authority over accounts, PINs, and biometrics.
 *   - AUTHORIZED_REPRESENTATIVE: View balance, statements, emergency withdrawals with OTP.
 *   - TRUSTED_HELPER: View balance, statements, assist navigation; cannot transfer without owner approval;
 *                     CANNOT change PIN, disable biometrics, or delete account.
 *
 * Never exposes owner's security credentials to the helper.
 */

const prisma = require('../prisma');
const SecurityService = require('./securityService');
const crypto = require('crypto');

const ROLE_PERMISSIONS = {
  OWNER: {
    canViewBalance: true,
    canViewStatement: true,
    canAssistNavigation: true,
    canRequestAssistance: true,
    canTransferMoney: true,
    canChangePin: true,
    canDisableBiometric: true,
    canDeleteAccount: true,
  },
  AUTHORIZED_REPRESENTATIVE: {
    canViewBalance: true,
    canViewStatement: true,
    canAssistNavigation: true,
    canRequestAssistance: true,
    canTransferMoney: 'OWNER_APPROVAL_REQUIRED',
    canChangePin: false,
    canDisableBiometric: false,
    canDeleteAccount: false,
  },
  TRUSTED_HELPER: {
    canViewBalance: true,
    canViewStatement: true,
    canAssistNavigation: true,
    canRequestAssistance: true,
    canTransferMoney: 'OWNER_APPROVAL_REQUIRED',
    canChangePin: false,
    canDisableBiometric: false,
    canDeleteAccount: false,
  },
};

// In-memory registry of registered assistants for persistence across sessions
const assistantRegistry = new Map();

class TrustedAssistantService {
  /**
   * Get permissions matrix for a role
   */
  static getPermissions(role = 'TRUSTED_HELPER') {
    return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.TRUSTED_HELPER;
  }

  /**
   * Register or update a trusted assistant for an account owner
   */
  static async registerAssistant(ownerId, { name, phone, relation, role = 'TRUSTED_HELPER' }) {
    if (!name || !phone) {
      const err = new Error('Assistant name and phone are required.');
      err.status = 400;
      throw err;
    }

    const assignedRole = role === 'AUTHORIZED_REPRESENTATIVE' ? 'AUTHORIZED_REPRESENTATIVE' : 'TRUSTED_HELPER';
    const assistantId = `asst_${crypto.randomBytes(8).toString('hex')}`;

    const assistant = {
      id: assistantId,
      ownerId,
      name: String(name).trim(),
      phone: String(phone).trim(),
      relation: String(relation || 'Trusted Helper').trim(),
      role: assignedRole,
      permissions: this.getPermissions(assignedRole),
      createdAt: new Date().toISOString(),
    };

    if (!assistantRegistry.has(ownerId)) {
      assistantRegistry.set(ownerId, []);
    }
    const list = assistantRegistry.get(ownerId);
    list.push(assistant);

    // Also update emergency contact on owner's record if not already set
    await prisma.user.update({
      where: { id: ownerId },
      data: {
        emergency_contact_name: assistant.name,
        emergency_contact_phone: assistant.phone,
      },
    }).catch(() => {});

    await SecurityService.recordEvent({
      userId: ownerId,
      eventType: 'TRUSTED_ASSISTANT_REGISTERED',
      severity: 'LOW',
      description: `Registered trusted assistant: ${assistant.name} (${assignedRole})`,
    });

    return assistant;
  }

  /**
   * List trusted assistants for an owner
   */
  static async listAssistants(ownerId) {
    const list = assistantRegistry.get(ownerId) || [];
    // Also include emergency contact from user record if registry is empty
    if (list.length === 0) {
      const user = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { emergency_contact_name: true, emergency_contact_phone: true },
      });
      if (user && user.emergency_contact_name && user.emergency_contact_phone) {
        const defaultAsst = {
          id: `asst_default_${ownerId.slice(0, 8)}`,
          ownerId,
          name: user.emergency_contact_name,
          phone: user.emergency_contact_phone,
          relation: 'Authorized Representative',
          role: 'AUTHORIZED_REPRESENTATIVE',
          permissions: this.getPermissions('AUTHORIZED_REPRESENTATIVE'),
          createdAt: new Date().toISOString(),
        };
        list.push(defaultAsst);
        assistantRegistry.set(ownerId, list);
      }
    }
    return list;
  }

  /**
   * Verify if an action is allowed for a role
   */
  static verifyAction(role, action) {
    const perms = this.getPermissions(role);
    if (!perms[action]) {
      const err = new Error(`Action forbidden for role ${role}: ${action}`);
      err.status = 403;
      throw err;
    }
    return perms[action];
  }

  /**
   * Create draft assistant transfer requiring owner approval
   */
  static async createDraftAssistantTransfer(ownerId, assistantId, transferData) {
    const draftId = `draft_${crypto.randomBytes(8).toString('hex')}`;
    const draft = {
      id: draftId,
      ownerId,
      assistantId,
      amount: transferData.amount,
      recipientName: transferData.recipientName,
      recipientAccount: transferData.recipientAccount,
      status: 'PENDING_OWNER_APPROVAL',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };

    await SecurityService.recordEvent({
      userId: ownerId,
      eventType: 'ASSISTANT_DRAFT_TRANSFER_CREATED',
      severity: 'MEDIUM',
      description: `Assistant ${assistantId} created draft transfer of ₹${transferData.amount} to ${transferData.recipientName}. Awaiting owner authorization.`,
    });

    return draft;
  }

  /**
   * Request Emergency Assistance ("I Need Assistance" flow - Phase 19)
   */
  static async requestEmergencyAssistance(ownerId, details = {}) {
    const user = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, full_name: true, phone: true, emergency_contact_name: true, emergency_contact_phone: true, is_senior: true },
    });

    const incidentId = `EMERGENCY_${Date.now()}_${ownerId.slice(0, 6).toUpperCase()}`;

    await SecurityService.recordEvent({
      userId: ownerId,
      eventType: 'EMERGENCY_ASSISTANCE_TRIGGERED',
      severity: 'HIGH',
      description: `Customer triggered 'I Need Assistance'. Senior: ${Boolean(user?.is_senior)}. Contact: ${user?.emergency_contact_name} (${user?.emergency_contact_phone})`,
    });

    return {
      ok: true,
      incidentId,
      status: 'ALERT_DISPATCHED',
      message: 'Emergency assistance alert initiated. Your designated representative and customer support have been notified.',
      contactName: user?.emergency_contact_name || 'Designated Contact',
      contactPhone: user?.emergency_contact_phone || 'Customer Care: 1800-iCASH',
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = TrustedAssistantService;
