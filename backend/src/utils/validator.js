/**
 * Zod request validation schemas.
 */
const { z } = require('zod');

const mobile10 = z.string().regex(/^\d{10}$/, 'Mobile number must be exactly 10 digits.');
const digits4 = z.string().regex(/^\d{4}$/, 'Must be exactly 4 digits.');
const aadhaarLast4 = z.string().regex(/^\d{4}$/, 'Aadhaar last 4 digits must be numeric.');
const descriptor = z.number().finite();
const faceDescriptor = z.array(descriptor).length(128, 'Face descriptor must contain exactly 128 numeric values.');

const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required.').max(100).optional(),
  name: z.string().trim().min(2).max(100).optional(),
  phone: mobile10.optional(),
  email: z.string().email().optional().or(z.literal('')).optional(),
  password: z.string().min(4).optional(),
  aadhaarNumber: z.string().regex(/^\d{12}$/, 'Aadhaar number must be 12 digits.').optional(),
  dob: z.string().optional(),
  role: z.string().optional(),
  pin: digits4.optional(),
  emergencyPin: digits4.optional().or(z.literal('')).optional(),
  isSenior: z.boolean().optional(),
  emergencyContactName: z.string().trim().max(100).optional(),
  emergencyContactPhone: z.string().trim().max(20).optional().or(z.literal('')).optional(),
  emergencyContactRelation: z.string().trim().max(50).optional(),
  emergencyContacts: z.array(z.object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(8).max(20),
    relation: z.string().trim().max(50).optional(),
    idType: z.string().trim().max(50).optional().nullable(),
    idNumber: z.string().trim().max(100).optional().nullable(),
  })).max(5).optional().default([]),
  descriptors: z.array(faceDescriptor).max(10).optional().default([]),
}).passthrough().refine(data => Boolean(data.fullName || data.name), {
  message: 'Full name or name is required.',
  path: ['fullName'],
});

const loginAadhaarSchema = z.object({ aadhaarLast4 });
const loginPinSchema = z.object({ userId: z.string().uuid('Invalid user identifier.'), pin: digits4 });
const confirmDeleteSchema = z.object({ pin: digits4 });

const biometricEnrollSchema = z.object({
  descriptors: z.array(faceDescriptor).min(1, 'At least one face descriptor sample is required.').max(10),
  biometricToken: z.string().min(10, 'A valid biometric session token is required for enrollment.'),
});

const biometricVerifySchema = z.object({
  liveDescriptor: faceDescriptor,
  userId: z.string().uuid().optional(),
});

// New challenge-based verification schema (replaces plain verifySchema for secure auth)
const biometricChallengeSchema = z.object({
  // Optional user ID hint to speed up lookup (server does not trust it for auth)
  userIdHint: z.string().uuid().optional(),
});

const biometricVerifyChallengeSchema = z.object({
  challengeId:      z.string().uuid('Invalid challenge ID.'),
  nonce:            z.string().regex(/^[0-9a-f]{64}$/, 'Invalid nonce format.'),
  liveDescriptor:   faceDescriptor.optional(),
  userId:           z.string().uuid().optional(),
  // Temporal proof: array of {timestamp, earLeft/leftEAR, earRight/rightEAR, avgEAR, state}
  challengeProof: z.array(z.object({
    timestamp:  z.number().positive(),
    earLeft:    z.number().min(0).max(1).optional(),
    earRight:   z.number().min(0).max(1).optional(),
    leftEAR:    z.number().min(0).max(1).optional(),
    rightEAR:   z.number().min(0).max(1).optional(),
    avgEAR:     z.number().min(0).max(1).optional(),
    state:      z.string().optional(),
    yaw:        z.number().optional(),
  })).min(1).max(300).optional(),
}).passthrough();

const accountCreateSchema = z.object({
  bankName: z.string().trim().min(2).max(100),
  accountType: z.enum(['SAVINGS', 'CURRENT', 'VIRTUAL']).optional().default('SAVINGS'),
  initialBalance: z.number().finite().nonnegative().max(99999999.99).optional().default(0),
  isPrimary: z.boolean().optional().default(false),
});

const accountUpdateSchema = z.object({
  bankName: z.string().trim().min(2).max(100).optional(),
  isPrimary: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).optional(),
});

const transactionCreateSchema = z.object({
  accountId: z.string().uuid().optional(),
  transactionType: z.enum(['WITHDRAWAL', 'DEPOSIT', 'TRANSFER', 'PAYMENT', 'REFUND']),
  amount: z.number().finite().positive('Amount must be greater than zero.').max(99999999.99),
  description: z.string().trim().max(500).optional(),
  recipientName: z.string().trim().max(100).optional(),
  recipientAccount: z.string().trim().max(100).optional(),
  recipientUserId: z.string().uuid().optional(),
  verifyMethod: z.enum(['FACE', 'PIN']).optional().default('PIN'),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
}).passthrough();
const categoryCorrectionSchema = z.object({
  category: z.string().trim().min(2).max(40),
});

const delegateGenerateSchema = z.object({ amount: z.number().finite().positive('Enter a valid authorization amount.').max(99999999.99).or(z.string().regex(/^\d+(\.\d{1,2})?$/)) });
const delegateClaimSchema = z.object({ seniorName: z.string().trim().min(2).max(100), otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits.') });

const emergencyWithdrawalRequestSchema = z.object({
  accountIdentifier: z.string().trim().min(2).max(120),
  authorizedName: z.string().trim().min(2).max(100),
  authorizedPhone: z.string().trim().min(8).max(20),
  authorizedIdType: z.string().trim().max(50).optional(),
  authorizedIdNumber: z.string().trim().max(100).optional(),
  amount: z.number().finite().positive().max(99999999.99).or(z.string().regex(/^\d+(\.\d{1,2})?$/)),
  reason: z.string().trim().max(500).optional(),
});

const emergencyWithdrawalVerifySchema = z.object({ requestId: z.string().min(1).max(100), otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits.') });

const emergencyContactsUpdateSchema = z.object({
  contacts: z.array(z.object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(8).max(20),
    relation: z.string().trim().max(50).optional(),
    idType: z.string().trim().max(50).optional().nullable(),
    idNumber: z.string().trim().max(100).optional().nullable(),
  })).max(5),
});

const complaintCreateSchema = z.object({
  transactionId: z.string().uuid().optional(),
  subject: z.string().trim().min(3).max(150),
  description: z.string().trim().min(5).max(2000),
});

const complaintResolveSchema = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']), adminResponse: z.string().trim().max(2000).optional() });
const merchantPaymentRequestSchema = z.object({ amount: z.number().finite().positive().max(99999999.99), description: z.string().trim().max(500).optional() });
const merchantRefundSchema = z.object({ transactionId: z.string().uuid(), reason: z.string().trim().min(3).max(500) });
const userStatusUpdateSchema = z.object({ status: z.enum(['ACTIVE', 'LOCKED', 'SUSPENDED']) });
const securityEventSchema = z.object({
  eventType: z.string().trim().min(2).max(100),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  description: z.string().trim().min(2).max(1000),
  deviceReference: z.string().trim().max(500).optional(),
});
const aiChatSchema = z.object({
  message: z.string().trim().min(1, 'Message is required.').max(2000),
});

module.exports = {
  registerSchema,
  loginAadhaarSchema,
  loginPinSchema,
  confirmDeleteSchema,
  biometricEnrollSchema,
  biometricVerifySchema,
  biometricChallengeSchema,
  biometricVerifyChallengeSchema,
  accountCreateSchema,
  accountUpdateSchema,
  transactionCreateSchema,
  categoryCorrectionSchema,
  delegateGenerateSchema,
  delegateClaimSchema,
  emergencyWithdrawalRequestSchema,
  emergencyWithdrawalVerifySchema,
  emergencyContactsUpdateSchema,
  complaintCreateSchema,
  complaintResolveSchema,
  merchantPaymentRequestSchema,
  merchantRefundSchema,
  userStatusUpdateSchema,
  securityEventSchema,
  aiChatSchema,
};
