const express = require('express');
const router = express.Router();
const TransactionController = require('../controllers/transactionController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { transactionLimiter } = require('../middleware/rateLimitMiddleware');
const {
  transactionCreateSchema,
  delegateGenerateSchema,
  delegateClaimSchema,
  emergencyWithdrawalRequestSchema,
  emergencyWithdrawalVerifySchema,
  emergencyContactsUpdateSchema,
  categoryCorrectionSchema,
} = require('../utils/validator');

// ── Public Routes for Authorized Representative & Emergency Cash ────────────

// 1. Authorized person requests emergency withdrawal -> dispatches 5-min OTP to account holder's registered mobile
router.post(
  '/emergency-withdrawal/request',
  transactionLimiter,
  validateRequest(emergencyWithdrawalRequestSchema),
  TransactionController.requestEmergencyWithdrawal
);

// 2. Authorized person enters 6-digit OTP received by account holder to release cash
router.post(
  '/emergency-withdrawal/verify',
  transactionLimiter,
  validateRequest(emergencyWithdrawalVerifySchema),
  TransactionController.verifyEmergencyWithdrawal
);

// Legacy aliases for backward compatibility
router.post(
  '/delegate/claim',
  transactionLimiter,
  validateRequest(delegateClaimSchema),
  TransactionController.claimDelegateWithdrawal
);

// ── Protected User Routes ───────────────────────────────────────────────────
router.use(authenticate);

router.get('/', TransactionController.getTransactions);
// Static paths must precede the dynamic transaction-id route.
router.get('/emergency-contacts', TransactionController.getEmergencyContacts);
router.post(
  '/',
  transactionLimiter,
  validateRequest(transactionCreateSchema),
  TransactionController.createTransaction
);
router.post('/topup', transactionLimiter, TransactionController.topUpDemoFunds);
// Demo deposit workflow used by the dashboard. It is intentionally separate
// from generic transaction creation so DEPOSIT cannot be forged by clients.
router.post('/deposit', transactionLimiter, TransactionController.depositMoney);
router.patch(
  '/:id/category',
  validateRequest(categoryCorrectionSchema),
  TransactionController.correctCategory
);

// Emergency contacts management
router.post(
  '/emergency-contacts',
  validateRequest(emergencyContactsUpdateSchema),
  TransactionController.updateEmergencyContacts
);

router.post(
  '/delegate/generate',
  validateRequest(delegateGenerateSchema),
  TransactionController.generateDelegateOtp
);

// Keep the parameterized route last so it cannot shadow static endpoints.
router.get('/:id', TransactionController.getTransactionById);

module.exports = router;
