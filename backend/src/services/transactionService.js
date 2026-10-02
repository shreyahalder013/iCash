const prisma = require('../prisma');
const SecurityService = require('./securityService');
const { hashValue, compareValue } = require('../utils/hash');
const crypto = require('crypto');
const SmartExpenseService = require('./smartExpenseService');

class TransactionService {
  /**
   * Get transaction history for user.
   */
  static async getUserTransactions(userId, { limit = 50, offset = 0, type = null } = {}) {
    const where = { user_id: userId };
    if (type) where.transaction_type = type;

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Number(limit),
      skip: Number(offset),
      include: {
        account: {
          select: {
            bank_name: true,
            account_number_masked: true,
          },
        },
      },
    });

    return transactions.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      bankName: t.account?.bank_name,
      accountMasked: t.account?.account_number_masked,
      type: t.transaction_type,
      amount: Number(t.amount),
      currency: t.currency,
      description: t.description,
      status: t.status,
      referenceNumber: t.reference_number,
      recipientName: t.recipient_name,
      recipientAccount: t.recipient_account,
      createdAt: t.created_at,
      category: t.category,
      categoryConfidence: t.category_confidence == null ? null : Number(t.category_confidence),
      categoryUserCorrected: t.category_user_corrected,
    }));
  }

  /**
   * Get single transaction details.
   */
  static async getTransactionById(userId, transactionId) {
    const tx = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        user_id: userId,
      },
      include: {
        account: true,
        complaints: true,
      },
    });

    if (!tx) {
      const err = new Error('Transaction not found or access denied.');
      err.status = 404;
      throw err;
    }

    return {
      id: tx.id,
      accountId: tx.account_id,
      bankName: tx.account?.bank_name,
      accountMasked: tx.account?.account_number_masked,
      type: tx.transaction_type,
      amount: Number(tx.amount),
      currency: tx.currency,
      description: tx.description,
      status: tx.status,
      referenceNumber: tx.reference_number,
      recipientName: tx.recipient_name,
      recipientAccount: tx.recipient_account,
      createdAt: tx.created_at,
      category: tx.category,
      categoryConfidence: tx.category_confidence == null ? null : Number(tx.category_confidence),
      categoryUserCorrected: tx.category_user_corrected,
      complaints: tx.complaints,
    };
  }

  /**
   * Process financial transaction atomically using PostgreSQL transaction block.
   */
  static async processTransaction(userId, payload, req, options = {}) {
    const {
      accountId,
      transactionType,
      amount,
      description,
      recipientName,
      recipientAccount,
      recipientUserId,
      verifyMethod,
      idempotencyKey,
    } = payload;
    const numAmount = Number(amount);
    const category = SmartExpenseService.categorize(description, transactionType);

    if (transactionType === 'DEPOSIT' && !options.allowDeposit) {
      const err = new Error('Deposits must be initiated through a verified payment workflow.');
      err.status = 403;
      throw err;
    }

    if (isNaN(numAmount) || numAmount <= 0) {
      const err = new Error('Invalid transaction amount.');
      err.status = 400;
      throw err;
    }

    // ── Idempotency check: prevent double-spend on network retries ──────────
    if (idempotencyKey) {
      const existing = await prisma.transaction.findUnique({
        where: { idempotency_key: String(idempotencyKey) },
        include: { account: { select: { balance: true, account_number_masked: true } } },
      });
      if (existing) {
        if (existing.user_id !== userId) {
          const err = new Error('This idempotency key is already in use.');
          err.status = 409;
          throw err;
        }
        return {
          transaction: existing,
          newBalance: Number(existing.account.balance),
          accountMasked: existing.account.account_number_masked,
          idempotent: true,
        };
      }
    }

    // ── Self-transfer guard ──────────────────────────────────────────────────
    if (transactionType === 'TRANSFER' && recipientUserId && recipientUserId === userId) {
      const err = new Error('Self-transfer is not permitted.');
      err.status = 400;
      throw err;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch user's target account (or primary account if none specified)
      let account;
      if (accountId) {
        account = await tx.bankAccount.findFirst({
          where: { id: accountId, user_id: userId, status: 'ACTIVE' },
        });
      } else {
        account = await tx.bankAccount.findFirst({
          where: { user_id: userId, is_primary: true, status: 'ACTIVE' },
        });
      }

      if (!account) {
        const err = new Error('Active banking account not found for this user.');
        err.status = 404;
        throw err;
      }

      const currentBalance = Number(account.balance);
      const refNumber = `TX_${crypto.randomUUID()}`;

      // 2. Handle specific transaction types
      if (transactionType === 'WITHDRAWAL') {
        // Conditional update prevents two concurrent withdrawals from both
        // passing a stale in-memory balance check.
        const debited = await tx.bankAccount.updateMany({
          where: { id: account.id, status: 'ACTIVE', balance: { gte: numAmount } },
          data: { balance: { decrement: numAmount } },
        });
        if (debited.count !== 1) {
          const err = new Error('Insufficient funds.');
          err.status = 400;
          throw err;
        }
        const updatedAccount = await tx.bankAccount.findUnique({ where: { id: account.id } });
        const newBalance = Number(updatedAccount.balance);

        const createdTx = await tx.transaction.create({
          data: {
            user_id: userId,
            account_id: account.id,
            transaction_type: 'WITHDRAWAL',
            amount: numAmount,
            description: description || 'ATM cash withdrawal (biometric verified)',
            status: 'COMPLETED',
            reference_number: refNumber,
            category: category.category,
            category_confidence: category.confidence,
            ...(idempotencyKey ? { idempotency_key: String(idempotencyKey) } : {}),
          },
        });

        await tx.securityEvent.create({
          data: {
            user_id: userId,
            event_type: 'TRANSACTION_SUCCESS',
            severity: numAmount >= 10000 ? 'MEDIUM' : 'LOW',
            description: `Withdrawal of ₹${numAmount.toLocaleString('en-IN')} authorized via ${verifyMethod}.`,
            ip_address: req?.ip,
            device_reference: req?.headers['user-agent'],
          },
        });

        return {
          transaction: createdTx,
          newBalance,
          accountMasked: account.account_number_masked,
        };
      } else if (transactionType === 'TRANSFER') {
        let recipientPrimaryAccount = null;
        if (recipientUserId) {
          recipientPrimaryAccount = await tx.bankAccount.findFirst({
            where: { user_id: recipientUserId, is_primary: true, status: 'ACTIVE' },
          });
          if (!recipientPrimaryAccount) {
            const err = new Error('A valid active recipient account is required.');
            err.status = 400;
            throw err;
          }
        }

        const debited = await tx.bankAccount.updateMany({
          where: { id: account.id, status: 'ACTIVE', balance: { gte: numAmount } },
          data: { balance: { decrement: numAmount } },
        });
        if (debited.count !== 1) {
          const err = new Error('Insufficient funds.');
          err.status = 400;
          throw err;
        }
        const senderAccount = await tx.bankAccount.findUnique({ where: { id: account.id } });
        const senderNewBalance = Number(senderAccount.balance);

        const senderTx = await tx.transaction.create({
          data: {
            user_id: userId,
            account_id: account.id,
            transaction_type: 'TRANSFER',
            amount: numAmount,
            description: description || `Transfer to ${recipientName || 'recipient'}`,
            recipient_name: recipientName || null,
            recipient_account: recipientAccount || null,
            status: 'COMPLETED',
            reference_number: refNumber,
            category: category.category,
            category_confidence: category.confidence,
          },
        });

        // If recipient is another internal registered user, credit their primary account atomically
        if (recipientUserId) {
          await tx.bankAccount.update({
              where: { id: recipientPrimaryAccount.id },
              data: { balance: { increment: numAmount } },
          });

            const senderUser = await tx.user.findUnique({
              where: { id: userId },
              select: { full_name: true },
            });

            await tx.transaction.create({
              data: {
                user_id: recipientUserId,
                account_id: recipientPrimaryAccount.id,
                transaction_type: 'DEPOSIT',
                amount: numAmount,
                description: `Received transfer from ${senderUser?.full_name || 'iCash user'}`,
                recipient_name: senderUser?.full_name || null,
                status: 'COMPLETED',
                reference_number: `TX_REC_${crypto.randomUUID()}`,
                category: SmartExpenseService.categorize(`Received transfer from ${senderUser?.full_name || 'iCash user'}`, 'DEPOSIT').category,
                category_confidence: 0.98,
              },
            });
        }

        await tx.securityEvent.create({
          data: {
            user_id: userId,
            event_type: 'TRANSFER_SUCCESS',
            severity: numAmount >= 20000 ? 'HIGH' : 'LOW',
            description: `Transfer of ₹${numAmount.toLocaleString('en-IN')} to ${recipientName || 'external'} authorized via ${verifyMethod}.`,
            ip_address: req?.ip,
            device_reference: req?.headers['user-agent'],
          },
        });

        return {
          transaction: senderTx,
          newBalance: senderNewBalance,
          accountMasked: account.account_number_masked,
        };
      } else if (transactionType === 'DEPOSIT') {
        // Use DB-level increment to avoid JavaScript floating-point precision errors.
        await tx.bankAccount.update({
          where: { id: account.id },
          data: { balance: { increment: numAmount } },
        });
        const depositedAccount = await tx.bankAccount.findUnique({ where: { id: account.id } });
        const newBalance = Number(depositedAccount.balance);

        const createdTx = await tx.transaction.create({
          data: {
            user_id: userId,
            account_id: account.id,
            transaction_type: 'DEPOSIT',
            amount: numAmount,
            description: description || 'Account top-up / deposit',
            status: 'COMPLETED',
            reference_number: refNumber,
            category: category.category,
            category_confidence: category.confidence,
            ...(idempotencyKey ? { idempotency_key: String(idempotencyKey) } : {}),
          },
        });

        return {
          transaction: createdTx,
          newBalance,
          accountMasked: account.account_number_masked,
        };
      }

        throw new Error(`Unsupported transaction type: ${transactionType}`);
      });
      // Fraud analysis is persisted for every user-created transaction so the
      // risk endpoint is immediately available without a second client call.
      if (result.transaction?.id) {
        const FraudService = require('./fraudService');
        await FraudService.analyze(userId, result.transaction.id);
      }
      return result;
    } catch (err) {
      // A concurrent retry may win the unique idempotency-key insert. Treat it
      // as the same completed request instead of surfacing a conflict.
      if (idempotencyKey && err.code === 'P2002') {
        const existing = await prisma.transaction.findUnique({
          where: { idempotency_key: String(idempotencyKey) },
          include: { account: { select: { balance: true, account_number_masked: true } } },
        });
        if (existing && existing.user_id === userId) {
          return {
            transaction: existing,
            newBalance: Number(existing.account.balance),
            accountMasked: existing.account.account_number_masked,
            idempotent: true,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Helper: Mask mobile number for secure public display (e.g. 9876543210 -> 98••••••10)
   */
  static maskPhone(phone) {
    if (!phone) return '••••••••••';
    const str = String(phone).trim();
    if (str.length <= 4) return '••••' + str;
    return str.slice(0, 2) + '••••••' + str.slice(-2);
  }

  /**
   * Request an emergency withdrawal by an authorized person.
   * Dispatches a 6-digit OTP to the account holder's registered mobile number with a strict 5-minute expiry.
   */
  static async requestEmergencyWithdrawal(data, req) {
    const {
      accountIdentifier,
      authorizedName,
      authorizedPhone,
      authorizedIdType,
      authorizedIdNumber,
      amount,
      reason,
    } = data;

    if (!accountIdentifier || !authorizedName || !authorizedPhone || !amount) {
      const err = new Error('Please provide account identifier, authorized person name, mobile number, and withdrawal amount.');
      err.status = 400;
      throw err;
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      const err = new Error('Please enter a valid positive withdrawal amount.');
      err.status = 400;
      throw err;
    }

    const cleanIdent = String(accountIdentifier).trim();
    const cleanAuthName = String(authorizedName).trim();
    const cleanAuthPhone = String(authorizedPhone).trim().replace(/\D/g, '').slice(-10);

    // Look up account holder by Phone, Aadhaar last 4, Email, or Full Name
    const accountHolder = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanIdent },
          { phone: cleanIdent.replace(/\D/g, '').slice(-10) },
          { aadhaar_last4: cleanIdent.replace(/\D/g, '').slice(-4) },
          { email: { equals: cleanIdent, mode: 'insensitive' } },
          { full_name: { equals: cleanIdent, mode: 'insensitive' } },
        ],
        status: 'ACTIVE',
      },
      include: {
        accounts: { where: { is_primary: true, status: 'ACTIVE' } },
      },
    });

    if (!accountHolder) {
      const err = new Error('No active account found matching the provided account details.');
      err.status = 404;
      throw err;
    }

    // Parse registered emergency contacts list
    let regContacts = [];
    if (accountHolder.emergency_contact_name) {
      if (accountHolder.emergency_contact_name.startsWith('[') || accountHolder.emergency_contact_name.startsWith('{')) {
        try {
          const arr = JSON.parse(accountHolder.emergency_contact_name);
          regContacts = Array.isArray(arr) ? arr : [arr];
        } catch (e) {
          regContacts = [{ name: accountHolder.emergency_contact_name, phone: accountHolder.emergency_contact_phone }];
        }
      } else {
        regContacts = [{ name: accountHolder.emergency_contact_name, phone: accountHolder.emergency_contact_phone }];
      }
    }

    const isAuthorized = regContacts.some((contact) => {
      if (!contact) return false;
      const cPhone = String(contact.phone || '').replace(/\D/g, '').slice(-10);
      const cName = String(contact.name || '').toLowerCase().trim();
      const matchPhone = cPhone && cPhone === cleanAuthPhone;
      const matchName = cName && cName === cleanAuthName.toLowerCase();
      return matchPhone || matchName;
    });

    if (!isAuthorized && regContacts.length > 0) {
      const err = new Error(
        `Authorization Failed: "${cleanAuthName}" (${cleanAuthPhone}) is not listed as a registered emergency contact for this account holder.`
      );
      err.status = 403;
      throw err;
    }

    const primaryAccount = accountHolder.accounts[0];
    if (!primaryAccount) {
      const err = new Error("Account holder has no active primary account.");
      err.status = 400;
      throw err;
    }
    // NOTE: Balance sufficiency is enforced atomically inside the $transaction block
    // to prevent TOCTOU race conditions. Do not add a balance check here.

    // Generate cryptographically secure 6-digit OTP
    const rawOtp = String(crypto.randomInt(100000, 1000000));
    const otpHash = await hashValue(rawOtp);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes strict

    // Encode delegation metadata inside otp_hash payload
    const encodedPayload = `${otpHash}|${cleanAuthName}|${cleanAuthPhone}|${authorizedIdType || 'GOV_ID'}|${authorizedIdNumber || ''}|${reason || ''}`;

    // Invalidate existing pending delegations for this user
    await prisma.delegatedWithdrawal.updateMany({
      where: { user_id: accountHolder.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });

    // Create delegation record
    const delegation = await prisma.delegatedWithdrawal.create({
      data: {
        user_id: accountHolder.id,
        amount: numAmount,
        otp_hash: encodedPayload,
        status: 'PENDING',
        expires_at: expiresAt,
      },
    });

    // Simulated SMS dispatch to account holder
    console.log(
      `[SMS GATEWAY] Emergency withdrawal OTP dispatched to account holder ${TransactionService.maskPhone(accountHolder.phone)} for ₹${numAmount}. Valid for 5 mins.`
    );

    await SecurityService.recordEvent({
      userId: accountHolder.id,
      eventType: 'EMERGENCY_WITHDRAWAL_OTP_DISPATCHED',
      severity: 'HIGH',
      description: `Emergency withdrawal OTP generated for ₹${numAmount} by authorized representative ${cleanAuthName} (${cleanAuthPhone}). Dispatched to account holder mobile ${accountHolder.phone}.`,
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });

    return {
      ok: true,
      requestId: delegation.id,
      accountHolderName: accountHolder.full_name,
      accountHolderPhoneMasked: TransactionService.maskPhone(accountHolder.phone),
      authorizedName: cleanAuthName,
      authorizedPhone: cleanAuthPhone,
      amount: numAmount,
      expiresInSeconds: 300,
      expiresAt,
      ...(process.env.NODE_ENV === 'test' || process.env.ALLOW_DEV_OTP === 'true'
        ? { otp: rawOtp, devOtp: rawOtp }
        : {}),
      message: `A One-Time Password (OTP) has been dispatched to the account holder's registered mobile number (${TransactionService.maskPhone(accountHolder.phone)}). You have 5 minutes to complete verification.`,
    };
  }

  /**
   * Verify OTP and complete emergency cash withdrawal.
   * Atomically transfers funds and issues an official transaction receipt.
   */
  static async verifyEmergencyWithdrawal(data, req) {
    const { requestId, otp } = data;

    if (!requestId || !otp) {
      const err = new Error('Please provide request ID and the 6-digit OTP received by the account holder.');
      err.status = 400;
      throw err;
    }

    const delegation = await prisma.delegatedWithdrawal.findUnique({
      where: { id: String(requestId) },
      include: {
        user: {
          include: {
            accounts: { where: { is_primary: true, status: 'ACTIVE' } },
          },
        },
      },
    });

    if (!delegation) {
      const err = new Error('Withdrawal request not found.');
      err.status = 404;
      throw err;
    }

    if (delegation.status === 'COMPLETED' || delegation.status === 'USED') {
      const err = new Error('This withdrawal request has already been completed.');
      err.status = 400;
      throw err;
    }

    if (new Date() > delegation.expires_at || delegation.status === 'EXPIRED') {
      await prisma.delegatedWithdrawal.update({
        where: { id: delegation.id },
        data: { status: 'EXPIRED' },
      });
      const err = new Error('The 5-minute OTP authorization window has expired. Please initiate a new request.');
      err.status = 400;
      throw err;
    }

    // Unpack encoded payload: storedHash|authName|authPhone|idType|idNumber|reason
    const parts = delegation.otp_hash.split('|');
    const storedOtpHash = parts[0];
    const authorizedName = parts[1] || 'Authorized Contact';
    const authorizedPhone = parts[2] || '';
    const authorizedIdType = parts[3] || 'Gov ID';
    const authorizedIdNumber = parts[4] || '';
    const reason = parts[5] || 'Emergency Cash Withdrawal';

    const isMatch = await compareValue(String(otp).trim(), storedOtpHash);
    if (!isMatch) {
      // ── Brute-force protection: lock after 5 failed OTP attempts ──────────
      const newAttemptCount = (delegation.attempt_count || 0) + 1;
      const shouldLock = newAttemptCount >= 5;
      await prisma.delegatedWithdrawal.update({
        where: { id: delegation.id },
        data: {
          attempt_count: newAttemptCount,
          status: shouldLock ? 'LOCKED' : delegation.status,
        },
      });
      await SecurityService.recordEvent({
        userId: delegation.user_id,
        eventType: 'EMERGENCY_WITHDRAWAL_OTP_FAILED',
        severity: 'HIGH',
        description: `Failed OTP attempt #${newAttemptCount} for emergency withdrawal ${delegation.id} by ${authorizedName}.${shouldLock ? ' Request LOCKED after 5 failures.' : ''}`,
        ipAddress: req?.ip,
        deviceReference: req?.headers['user-agent'],
      });
      const errMsg = shouldLock
        ? 'This withdrawal request has been locked after too many failed attempts. Please initiate a new request.'
        : `Incorrect One-Time Password. ${5 - newAttemptCount} attempt(s) remaining before lockout.`;
      const err = new Error(errMsg);
      err.status = shouldLock ? 403 : 400;
      throw err;
    }

    const accountHolder = delegation.user;
    const primaryAccount = accountHolder.accounts[0];
    const amount = Number(delegation.amount);

    if (!primaryAccount) {
      const err = new Error("Account holder has no active primary account.");
      err.status = 400;
      throw err;
    }
    // Balance is verified atomically inside the $transaction block (TOCTOU-safe).

    // Atomically release funds and generate audit transaction record
    return await prisma.$transaction(async (tx) => {
      // Claim is a compare-and-set: concurrent OTP submissions can consume
      // the delegation only once.
      const claimed = await tx.delegatedWithdrawal.updateMany({
        where: {
          id: delegation.id,
          status: 'PENDING',
          expires_at: { gt: new Date() },
          attempt_count: { lt: 5 }, // Cannot claim a locked delegation
        },
        data: { status: 'USED' },
      });
      if (claimed.count !== 1) {
        const err = new Error('This withdrawal request has already been completed.');
        err.status = 400;
        throw err;
      }

      const debited = await tx.bankAccount.updateMany({
        where: { id: primaryAccount.id, status: 'ACTIVE', balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (debited.count !== 1) {
        const err = new Error("Account holder's balance is insufficient.");
        err.status = 400;
        throw err;
      }
      const updatedAccount = await tx.bankAccount.findUnique({ where: { id: primaryAccount.id } });
      const newBalance = Number(updatedAccount.balance);

      const transaction = await tx.transaction.create({
        data: {
          user_id: accountHolder.id,
          account_id: primaryAccount.id,
          transaction_type: 'WITHDRAWAL',
          amount,
          description: `Emergency Cash Withdrawal by Authorized Representative (${authorizedName} - ${authorizedPhone})`,
          recipient_name: authorizedName,
          recipient_account: authorizedPhone,
          status: 'COMPLETED',
          reference_number: `TX_EMERGENCY_${Date.now()}`,
          category: 'CASH',
          category_confidence: 0.98,
        },
      });

      await SecurityService.recordEvent({
        userId: accountHolder.id,
        eventType: 'EMERGENCY_WITHDRAWAL_SUCCESS',
        severity: 'MEDIUM',
        description: `₹${amount} released to authorized representative ${authorizedName} (${authorizedPhone}) after successful OTP verification.`,
        ipAddress: req?.ip,
        deviceReference: req?.headers ? req.headers['user-agent'] : null,
      });

      return {
        ok: true,
        transactionId: transaction.id,
        referenceNumber: transaction.reference_number,
        accountHolderName: accountHolder.full_name,
        accountHolderPhoneMasked: TransactionService.maskPhone(accountHolder.phone),
        authorizedPersonName: authorizedName,
        authorizedPersonPhone: authorizedPhone,
        authorizedIdType,
        authorizedIdNumber,
        reason,
        amount,
        remainingBalance: newBalance,
        completedAt: transaction.created_at,
        message: `₹${amount.toLocaleString('en-IN')} successfully authorized and released to ${authorizedName}.`,
      };
    });
  }

  /**
   * Get user's emergency contacts
   */
  static async getEmergencyContacts(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        emergency_contact_name: true,
        emergency_contact_phone: true,
      },
    });

    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }

    let contacts = [];
    if (user.emergency_contact_name) {
      if (user.emergency_contact_name.startsWith('[') || user.emergency_contact_name.startsWith('{')) {
        try {
          const arr = JSON.parse(user.emergency_contact_name);
          contacts = Array.isArray(arr) ? arr : [arr];
        } catch (e) {
          contacts = [{ name: user.emergency_contact_name, phone: user.emergency_contact_phone, relation: 'Trusted Representative' }];
        }
      } else {
        contacts = [{ name: user.emergency_contact_name, phone: user.emergency_contact_phone, relation: 'Trusted Representative' }];
      }
    }

    return contacts;
  }

  /**
   * Update user's emergency contacts
   */
  static async updateEmergencyContacts(userId, contacts, req) {
    if (!Array.isArray(contacts)) {
      const err = new Error('Contacts must be an array.');
      err.status = 400;
      throw err;
    }

    const normalized = contacts
      .filter((c) => c && c.name && c.phone)
      .map((c) => ({
        name: String(c.name).trim(),
        phone: String(c.phone).trim(),
        relation: c.relation ? String(c.relation).trim() : 'Trusted Representative',
        idType: c.idType ? String(c.idType).trim() : null,
        idNumber: c.idNumber ? String(c.idNumber).trim() : null,
      }));

    const primary = normalized[0] || null;
    // Always store as JSON array for consistency — never as a bare name string.
    const contactsData = normalized.length > 0 ? JSON.stringify(normalized) : null;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        emergency_contact_name: contactsData,
        emergency_contact_phone: primary ? primary.phone : null,
      },
    });

    await SecurityService.recordEvent({
      userId,
      eventType: 'EMERGENCY_CONTACTS_UPDATED',
      severity: 'LOW',
      description: `User updated emergency contacts list (${normalized.length} contacts).`,
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });

    return normalized;
  }

  /**
   * Legacy senior delegation helper (forwards to emergency withdrawal engine)
   */
  static async generateDelegatedOtp(seniorUserId, amount, req) {
    const senior = await prisma.user.findUnique({
      where: { id: seniorUserId },
      include: { accounts: { where: { is_primary: true, status: 'ACTIVE' } } },
    });
    if (!senior) {
      const err = new Error('Senior user not found.');
      err.status = 404;
      throw err;
    }
    return await TransactionService.requestEmergencyWithdrawal({
      accountIdentifier: senior.phone,
      authorizedName: senior.emergency_contact_name || 'Authorized Senior Contact',
      authorizedPhone: senior.emergency_contact_phone || senior.phone,
      amount,
      reason: 'Senior Citizen Assisted Cash Withdrawal',
    }, req);
  }

  /**
   * Legacy senior delegation claim helper
   */
  static async claimDelegatedWithdrawal(seniorName, otp, req) {
    const senior = await prisma.user.findFirst({
      where: { full_name: { equals: seniorName.trim(), mode: 'insensitive' } },
      include: {
        delegations: {
          where: { status: 'PENDING' },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });
    if (!senior || !senior.delegations[0]) {
      const err = new Error('No active withdrawal request found for that account name.');
      err.status = 404;
      throw err;
    }
    return await TransactionService.verifyEmergencyWithdrawal({
      requestId: senior.delegations[0].id,
      otp,
    }, req);
  }
}

module.exports = TransactionService;
