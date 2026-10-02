const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function hashValue(val) {
  return bcrypt.hash(String(val), 12);
}

async function main() {
  console.log('🌱 Starting iCash Database Seeding...');

  // Clean existing records if any
  try {
    await prisma.complaint.deleteMany();
    await prisma.securityEvent.deleteMany();
    await prisma.loginSession.deleteMany();
    await prisma.delegatedWithdrawal.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.bankAccount.deleteMany();
    await prisma.biometricProfile.deleteMany();
    await prisma.paymentRequest.deleteMany();
    await prisma.merchantProfile.deleteMany();
    await prisma.user.deleteMany();
  } catch (e) {
    console.log('Notice: clean slate ready.');
  }

  // 1. ADMIN DEMO ACCOUNT
  // Email: admin@icash.bank / Phone: 9000000001 / PIN: 9999 / Emergency PIN: 1111
  const adminPinHash = await hashValue('9999');
  const adminDuressHash = await hashValue('1111');
  const adminUser = await prisma.user.create({
    data: {
      full_name: 'Admin System Controller',
      email: 'admin@icash.bank',
      phone: '9000000001',
      aadhaar_reference: 'AADHAAR_ADMIN_001',
      aadhaar_last4: '9999',
      aadhaar_verified: true,
      password_hash: adminPinHash,
      emergency_pin_hash: adminDuressHash,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });

  const adminAccount = await prisma.bankAccount.create({
    data: {
      user_id: adminUser.id,
      bank_name: 'Reserve Central Bank',
      account_number_masked: '•••• 9999',
      account_reference: 'ACC_ADMIN_CENTRAL',
      account_type: 'SAVINGS',
      balance: 1000000.0,
      is_primary: true,
      status: 'ACTIVE',
    },
  });

  console.log('✅ Created Admin Account: admin@icash.bank / PIN 9999');

  // 2. MERCHANT DEMO ACCOUNT
  // Email: merchant@icash.bank / Phone: 9000000002 / PIN: 8888 / Emergency PIN: 2222
  const merchantPinHash = await hashValue('8888');
  const merchantDuressHash = await hashValue('2222');
  const merchantUser = await prisma.user.create({
    data: {
      full_name: 'Rajesh Retail Services',
      email: 'merchant@icash.bank',
      phone: '9000000002',
      aadhaar_reference: 'AADHAAR_MERCHANT_002',
      aadhaar_last4: '8888',
      aadhaar_verified: true,
      password_hash: merchantPinHash,
      emergency_pin_hash: merchantDuressHash,
      role: 'MERCHANT',
      status: 'ACTIVE',
    },
  });

  const merchantAccount = await prisma.bankAccount.create({
    data: {
      user_id: merchantUser.id,
      bank_name: 'iCash Commercial Settlement Bank',
      account_number_masked: '•••• 8888',
      account_reference: 'ACC_MERCHANT_COMMERCIAL',
      account_type: 'CURRENT',
      balance: 145000.0,
      is_primary: true,
      status: 'ACTIVE',
    },
  });

  const merchantProfile = await prisma.merchantProfile.create({
    data: {
      user_id: merchantUser.id,
      business_name: 'Metro HyperMarket Pvt Ltd',
      settlement_acct: '•••• 8888',
      settled_balance: 145000.0,
      pending_balance: 12500.0,
    },
  });

  await prisma.paymentRequest.create({
    data: {
      merchant_id: merchantProfile.id,
      amount: 1500.0,
      description: 'Grocery Billing Counter #3',
      reference_code: 'PAY_METRO_501',
      status: 'PENDING',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  console.log('✅ Created Merchant Account: merchant@icash.bank / PIN 8888');

  // 3. REGULAR USER DEMO ACCOUNT (Sidd Paul)
  // Phone: 9876543210 / Aadhaar last4: 4821 / PIN: 4821 / Emergency PIN: 9317
  const siddPinHash = await hashValue('4821');
  const siddDuressHash = await hashValue('9317');
  const siddUser = await prisma.user.create({
    data: {
      full_name: 'Sidd Paul',
      email: 'sidd.paul@demo.icash.bank',
      email_verified: false,
      email_verification_token: '123456',
      email_verification_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      phone: '9876543210',
      aadhaar_reference: 'AADHAAR_SIDD_4821',
      aadhaar_last4: '4821',
      aadhaar_verified: true,
      password_hash: siddPinHash,
      emergency_pin_hash: siddDuressHash,
      dob: new Date('1996-05-14'),
      age: 30,
      is_senior: false,
      role: 'USER',
      status: 'ACTIVE',
    },
  });

  const siddSavings = await prisma.bankAccount.create({
    data: {
      user_id: siddUser.id,
      bank_name: 'iCash Federal Digital Bank',
      account_number_masked: '•••• 4821',
      account_reference: 'ACC_SIDD_PRIMARY_SAVINGS',
      account_type: 'SAVINGS',
      balance: 25000.0,
      is_primary: true,
      status: 'ACTIVE',
    },
  });

  const siddVirtual = await prisma.bankAccount.create({
    data: {
      user_id: siddUser.id,
      bank_name: 'iCash Virtual Debit Wallet',
      account_number_masked: '•••• 0912',
      account_reference: 'ACC_SIDD_VIRTUAL_WALLET',
      account_type: 'VIRTUAL',
      balance: 5000.0,
      is_primary: false,
      status: 'ACTIVE',
    },
  });

  // Seed sample transactions
  await prisma.transaction.create({
    data: {
      user_id: siddUser.id,
      account_id: siddSavings.id,
      transaction_type: 'DEPOSIT',
      amount: 25000.0,
      description: 'Account opened · Aadhaar verified demo funds',
      status: 'COMPLETED',
      reference_number: 'TX_SIDD_OPEN_01',
    },
  });

  await prisma.transaction.create({
    data: {
      user_id: siddUser.id,
      account_id: siddSavings.id,
      transaction_type: 'WITHDRAWAL',
      amount: 2000.0,
      description: 'ATM cash withdrawal (biometric verified)',
      status: 'COMPLETED',
      reference_number: 'TX_SIDD_ATM_02',
    },
  });

  // Update balance after withdrawal
  await prisma.bankAccount.update({
    where: { id: siddSavings.id },
    data: { balance: 23000.0 },
  });

  // Seed biometric profile stub
  await prisma.biometricProfile.create({
    data: {
      user_id: siddUser.id,
      biometric_provider: 'DEMO_FACIAL_EMBEDDINGS',
      biometric_reference: 'BIO_DEMO_SIDD_4821',
      enrollment_status: 'ENROLLED',
      face_descriptors: [],
    },
  });

  console.log(
    '✅ Created User Account: Sidd Paul (Phone: 9876543210, Aadhaar last4: 4821, PIN: 4821)'
  );

  // 4. SENIOR CITIZEN DEMO ACCOUNT (Ramesh Kumar)
  // Phone: 9811122233 / Aadhaar last4: 7712 / PIN: 7712 / Age: 68 / Trusted Contact: Amit Kumar (9811199999)
  const rameshPinHash = await hashValue('7712');
  const rameshDuressHash = await hashValue('9911');
  const rameshUser = await prisma.user.create({
    data: {
      full_name: 'Ramesh Kumar',
      email: 'ramesh.kumar@demo.icash.bank',
      phone: '9811122233',
      aadhaar_reference: 'AADHAAR_RAMESH_7712',
      aadhaar_last4: '7712',
      aadhaar_verified: true,
      password_hash: rameshPinHash,
      emergency_pin_hash: rameshDuressHash,
      dob: new Date('1958-03-20'),
      age: 68,
      is_senior: true,
      emergency_contact_name: 'Amit Kumar',
      emergency_contact_phone: '9811199999',
      role: 'USER',
      status: 'ACTIVE',
    },
  });

  const rameshAccount = await prisma.bankAccount.create({
    data: {
      user_id: rameshUser.id,
      bank_name: 'Senior Citizen Pension Banking',
      account_number_masked: '•••• 7712',
      account_reference: 'ACC_RAMESH_SENIOR',
      account_type: 'SAVINGS',
      balance: 40000.0,
      is_primary: true,
      status: 'ACTIVE',
    },
  });

  await prisma.transaction.create({
    data: {
      user_id: rameshUser.id,
      account_id: rameshAccount.id,
      transaction_type: 'DEPOSIT',
      amount: 40000.0,
      description: 'Monthly Senior Citizen Pension Deposit',
      status: 'COMPLETED',
      reference_number: 'TX_RAMESH_PENSION_01',
    },
  });

  // Seed delegation OTP (valid 5 min)
  const delegationOtpRaw = '654321';
  const delegationOtpHash = await hashValue(delegationOtpRaw);
  await prisma.delegatedWithdrawal.create({
    data: {
      user_id: rameshUser.id,
      amount: 5000.0,
      otp_hash: delegationOtpHash,
      status: 'PENDING',
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  console.log(
    '✅ Created Senior Citizen Account: Ramesh Kumar (PIN: 7712, Delegation OTP: 654321)'
  );

  // 5. SEED INITIAL SECURITY EVENTS
  await prisma.securityEvent.create({
    data: {
      user_id: siddUser.id,
      event_type: 'LOGIN_SUCCESS',
      severity: 'LOW',
      description: 'Successful face biometric match on authorized device.',
      ip_address: '127.0.0.1',
    },
  });

  await prisma.securityEvent.create({
    data: {
      user_id: siddUser.id,
      event_type: 'BIOMETRIC_SUCCESS',
      severity: 'LOW',
      description: 'Biometric liveness verification passed (confidence: 94%).',
      ip_address: '127.0.0.1',
    },
  });

  console.log('🎉 Seeding completed successfully!');
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('Seeding error:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = { main, seed: main };
