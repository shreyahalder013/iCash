const prisma = require('../prisma');

const cents = (value) => Math.round(Number(value) * 100);
const money = (value) => Number((value / 100).toFixed(2));

function calculateSplits(total, members, method = 'EQUAL', values = []) {
  const totalCents = cents(total);
  if (
    !Number.isFinite(totalCents) ||
    totalCents <= 0 ||
    !Array.isArray(members) ||
    members.length === 0
  ) {
    throw Object.assign(new Error('A positive amount and at least one member are required.'), {
      status: 400,
    });
  }
  const normalized = String(method).toUpperCase();
  let amounts;
  if (normalized === 'EQUAL') {
    const base = Math.floor(totalCents / members.length);
    amounts = members.map((_, i) => base + (i < totalCents % members.length ? 1 : 0));
  } else if (normalized === 'PERCENTAGE') {
    if (
      values.length !== members.length ||
      Math.abs(values.reduce((a, b) => a + Number(b), 0) - 100) > 0.0001
    ) {
      throw Object.assign(new Error('Percentages must add up to 100.'), { status: 400 });
    }
    amounts = values.map((v) => Math.round((totalCents * Number(v)) / 100));
    amounts[amounts.length - 1] += totalCents - amounts.reduce((a, b) => a + b, 0);
  } else if (normalized === 'CUSTOM') {
    amounts = values.map(cents);
    if (
      amounts.length !== members.length ||
      amounts.some((v) => !Number.isFinite(v) || v < 0) ||
      amounts.reduce((a, b) => a + b, 0) !== totalCents
    ) {
      throw Object.assign(
        new Error('Custom shares must be non-negative and add up to the total.'),
        { status: 400 }
      );
    }
  } else
    throw Object.assign(new Error('Split method must be EQUAL, PERCENTAGE, or CUSTOM.'), {
      status: 400,
    });
  return members.map((userId, i) => ({
    user_id: userId,
    amount: money(amounts[i]),
    percentage: normalized === 'PERCENTAGE' ? Number(values[i]) : null,
  }));
}

// Returns a minimal set of transfers. Sorting the creditor/debtor lists makes this O(n log n).
function optimizeDebts(balances) {
  const entries = (
    Array.isArray(balances)
      ? balances
      : Object.entries(balances || {}).map(([userId, balance]) => ({ userId, balance }))
  )
    .map((x) => ({ userId: x.userId || x.user_id, balance: cents(x.balance) }))
    .filter((x) => x.userId && x.balance !== 0);
  const total = entries.reduce((sum, x) => sum + x.balance, 0);
  if (total !== 0) throw Object.assign(new Error('Balances must net to zero.'), { status: 400 });
  const debtors = entries.filter((x) => x.balance < 0).sort((a, b) => a.balance - b.balance);
  const creditors = entries.filter((x) => x.balance > 0).sort((a, b) => b.balance - a.balance);
  const transfers = [];
  let d = 0,
    c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(-debtors[d].balance, creditors[c].balance);
    transfers.push({ from: debtors[d].userId, to: creditors[c].userId, amount: money(amount) });
    debtors[d].balance += amount;
    creditors[c].balance -= amount;
    if (debtors[d].balance === 0) d++;
    if (creditors[c].balance === 0) c++;
  }
  return transfers;
}

async function createGroup(userId, name, memberIds = []) {
  const ids = [...new Set([userId, ...memberIds])];
  return prisma.expenseGroup.create({
    data: { name, created_by: userId, members: { create: ids.map((id) => ({ user_id: id })) } },
    include: { members: true },
  });
}

async function addMember(userId, groupId, memberId) {
  await assertMember(userId, groupId);
  return prisma.groupMember.create({ data: { group_id: groupId, user_id: memberId } });
}

async function assertMember(userId, groupId) {
  const member = await prisma.groupMember.findUnique({
    where: { group_id_user_id: { group_id: groupId, user_id: userId } },
  });
  if (!member)
    throw Object.assign(new Error('You are not a member of this expense group.'), { status: 403 });
}

async function createExpense(userId, groupId, input) {
  await assertMember(userId, groupId);
  const members = await prisma.groupMember.findMany({
    where: { group_id: groupId },
    select: { user_id: true },
  });
  const ids = members.map((m) => m.user_id);
  const shares = calculateSplits(
    input.totalAmount ?? input.amount,
    input.memberIds || ids,
    input.method || input.splitMethod,
    input.values || input.shares || []
  );
  if (!ids.includes(input.paidBy || userId) || shares.some((s) => !ids.includes(s.user_id))) {
    throw Object.assign(new Error('Payer and all split members must belong to the group.'), {
      status: 400,
    });
  }
  return prisma.splitExpense.create({
    data: {
      group_id: groupId,
      paid_by: input.paidBy || userId,
      description: input.description || 'Shared expense',
      total_amount: input.totalAmount ?? input.amount,
      split_method: String(input.method || input.splitMethod || 'EQUAL').toUpperCase(),
      shares: { create: shares },
      payments: {
        create: shares
          .filter((share) => share.user_id !== (input.paidBy || userId))
          .map((share) => ({
            payer_id: share.user_id,
            payee_id: input.paidBy || userId,
            amount: share.amount,
          })),
      },
    },
    include: { shares: true, payments: true },
  });
}

async function settlePayment(userId, paymentId) {
  const payment = await prisma.splitPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.payer_id !== userId)
    throw Object.assign(new Error('Payment not found.'), { status: 404 });
  if (payment.status === 'PAID') return payment;
  return prisma.splitPayment.update({
    where: { id: paymentId },
    data: { status: 'PAID', paid_at: new Date() },
  });
}

async function getOptimization(userId, groupId) {
  await assertMember(userId, groupId);
  const expenses = await prisma.splitExpense.findMany({
    where: { group_id: groupId },
    include: { shares: true },
  });
  const balances = {};
  for (const expense of expenses) {
    balances[expense.paid_by] = (balances[expense.paid_by] || 0) + cents(expense.total_amount);
    for (const share of expense.shares)
      balances[share.user_id] = (balances[share.user_id] || 0) - cents(share.amount);
  }
  return {
    balances: Object.fromEntries(Object.entries(balances).map(([id, value]) => [id, money(value)])),
    transfers: optimizeDebts(balances),
  };
}

module.exports = {
  calculateSplits,
  optimizeDebts,
  createGroup,
  addMember,
  createExpense,
  getOptimization,
  settlePayment,
};
