const TransactionService = require('../services/transactionService');
const SmartExpenseService = require('../services/smartExpenseService');

class TransactionController {
  static async getTransactions(req, res, next) {
    try {
      const { limit, offset, type } = req.query;
      const transactions = await TransactionService.getUserTransactions(req.user.id, {
        limit,
        offset,
        type,
      });
      res.json({
        ok: true,
        transactions,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getTransactionById(req, res, next) {
    try {
      const tx = await TransactionService.getTransactionById(req.user.id, req.params.id);
      res.json({
        ok: true,
        transaction: tx,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createTransaction(req, res, next) {
    try {
      const result = await TransactionService.processTransaction(req.user.id, req.body, req);
      res.status(result.idempotent ? 200 : 201).json({
        ok: true,
        message: 'Transaction completed successfully.',
        transaction: result.transaction,
        newBalance: result.newBalance,
        accountMasked: result.accountMasked,
      });
    } catch (err) {
      next(err);
    }
  }

  static async correctCategory(req, res, next) {
    try {
      const transaction = await SmartExpenseService.correctCategory(
        req.user.id,
        req.params.id,
        req.body.category
      );
      res.json({
        ok: true,
        transaction: {
          id: transaction.id,
          category: transaction.category,
          categoryConfidence: Number(transaction.category_confidence),
          categoryUserCorrected: transaction.category_user_corrected,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async depositMoney(req, res, next) {
    try {
      const amount = Number(req.body?.amount);
      const accountId = req.body?.accountId || undefined;
      const method = String(req.body?.method || 'Cash Deposit').trim();
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
        return res
          .status(400)
          .json({ ok: false, message: 'Enter a deposit between ₹1 and ₹10,00,000.' });
      }

      const result = await TransactionService.processTransaction(
        req.user.id,
        {
          accountId,
          transactionType: 'DEPOSIT',
          amount,
          description: `${method} — account deposit`,
        },
        req,
        { allowDeposit: true }
      );

      return res.status(201).json({
        ok: true,
        message: `₹${amount.toLocaleString('en-IN')} deposited successfully.`,
        newBalance: result.newBalance,
        transaction: result.transaction,
        accountMasked: result.accountMasked,
      });
    } catch (err) {
      next(err);
    }
  }

  static async topUpDemoFunds(req, res, next) {
    try {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_TOPUP !== 'true') {
        return res
          .status(404)
          .json({ ok: false, error: 'NotFound', message: 'Endpoint not found.' });
      }

      const MAX_TOPUP = 10000;
      const rawAmount = Number(req.body.amount);
      if (isNaN(rawAmount) || rawAmount <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'ValidationError',
          message: 'Amount must be a positive number.',
        });
      }
      const amount = Math.min(rawAmount, MAX_TOPUP);
      if (rawAmount > MAX_TOPUP) {
        return res.status(400).json({
          ok: false,
          error: 'ValidationError',
          message: `Demo top-up is capped at ₹${MAX_TOPUP.toLocaleString('en-IN')} per request.`,
        });
      }

      const result = await TransactionService.processTransaction(
        req.user.id,
        {
          transactionType: 'DEPOSIT',
          amount,
          description: 'Instant demo funds top-up',
        },
        req,
        { allowDeposit: true }
      );
      res.json({
        ok: true,
        message: `₹${amount.toLocaleString('en-IN')} deposited successfully.`,
        newBalance: result.newBalance,
        transaction: result.transaction,
      });
    } catch (err) {
      next(err);
    }
  }

  static async requestEmergencyWithdrawal(req, res, next) {
    try {
      const result = await TransactionService.requestEmergencyWithdrawal(req.body, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async verifyEmergencyWithdrawal(req, res, next) {
    try {
      const result = await TransactionService.verifyEmergencyWithdrawal(req.body, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getEmergencyContacts(req, res, next) {
    try {
      const contacts = await TransactionService.getEmergencyContacts(req.user.id);
      res.json({
        ok: true,
        contacts,
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateEmergencyContacts(req, res, next) {
    try {
      const { contacts } = req.body;
      const updated = await TransactionService.updateEmergencyContacts(req.user.id, contacts, req);
      res.json({
        ok: true,
        message: 'Emergency contacts updated successfully.',
        contacts: updated,
      });
    } catch (err) {
      next(err);
    }
  }

  static async generateDelegateOtp(req, res, next) {
    try {
      const { amount } = req.body;
      const result = await TransactionService.generateDelegatedOtp(req.user.id, amount, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async claimDelegateWithdrawal(req, res, next) {
    try {
      const { seniorName, otp } = req.body;
      const result = await TransactionService.claimDelegatedWithdrawal(seniorName, otp, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = TransactionController;
