const prisma = require('../prisma');
const crypto = require('crypto');

class AccountService {
  /**
   * Get all active accounts owned by the user.
   */
  static async getUserAccounts(userId) {
    const accounts = await prisma.bankAccount.findMany({
      where: {
        user_id: userId,
        status: { not: 'CLOSED' },
      },
      orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
    });

    return accounts.map((a) => ({
      id: a.id,
      bankName: a.bank_name,
      accountNumberMasked: a.account_number_masked,
      accountReference: a.account_reference,
      accountType: a.account_type,
      balance: Number(a.balance),
      currency: a.currency,
      isPrimary: a.is_primary,
      status: a.status,
      createdAt: a.created_at,
    }));
  }

  /**
   * Link a new bank or wallet account for the authenticated user.
   */
  static async createAccount(userId, data) {
    const { bankName, accountType = 'SAVINGS', initialBalance = 0, isPrimary = false } = data;

    if (Number(initialBalance) !== 0) {
      const err = new Error(
        'New accounts must be funded through a verified deposit or payment workflow.'
      );
      err.status = 400;
      throw err;
    }

    const accountMasked = `•••• ${crypto.randomInt(1000, 10000)}`;
    const accountRef = `ACC_${userId.slice(0, 6).toUpperCase()}_${Date.now()}`;

    return await prisma.$transaction(async (tx) => {
      // If setting this as primary, remove primary flag from existing accounts
      if (isPrimary) {
        await tx.bankAccount.updateMany({
          where: { user_id: userId },
          data: { is_primary: false },
        });
      }

      const account = await tx.bankAccount.create({
        data: {
          user_id: userId,
          bank_name: bankName,
          account_number_masked: accountMasked,
          account_reference: accountRef,
          account_type: accountType,
          balance: 0,
          is_primary: isPrimary,
          status: 'ACTIVE',
        },
      });

      return account;
    });
  }

  /**
   * Update account properties (e.g. set primary or update bank name).
   */
  static async updateAccount(userId, accountId, data) {
    // Ensure account belongs to authenticated user
    const existing = await prisma.bankAccount.findFirst({
      where: {
        id: accountId,
        user_id: userId,
      },
    });

    if (!existing) {
      const err = new Error('Account not found or access denied.');
      err.status = 404;
      throw err;
    }

    return await prisma.$transaction(async (tx) => {
      if (data.isPrimary) {
        await tx.bankAccount.updateMany({
          where: { user_id: userId },
          data: { is_primary: false },
        });
      }

      return await tx.bankAccount.update({
        where: { id: accountId },
        data: {
          bank_name: data.bankName || existing.bank_name,
          is_primary: data.isPrimary !== undefined ? data.isPrimary : existing.is_primary,
          status: data.status || existing.status,
        },
      });
    });
  }

  /**
   * Close / soft-delete a linked account.
   */
  static async deleteAccount(userId, accountId) {
    const account = await prisma.bankAccount.findFirst({
      where: {
        id: accountId,
        user_id: userId,
      },
    });

    if (!account) {
      const err = new Error('Account not found or access denied.');
      err.status = 404;
      throw err;
    }

    if (account.is_primary) {
      const err = new Error(
        'Cannot delete your primary banking account. Please set another primary account first.'
      );
      err.status = 400;
      throw err;
    }

    return await prisma.bankAccount.update({
      where: { id: accountId },
      data: { status: 'CLOSED' },
    });
  }
}

module.exports = AccountService;
