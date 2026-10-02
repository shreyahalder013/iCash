const prisma = require('../prisma');

async function getHealthScore(userId) {
  const [accounts, transactions, complaints] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { user_id: userId, status: 'ACTIVE' },
      select: { balance: true },
    }),
    prisma.transaction.findMany({
      where: { user_id: userId, created_at: { gte: new Date(Date.now() - 90 * 86400000) } },
      select: { transaction_type: true, amount: true, status: true },
    }),
    prisma.complaint.count({ where: { user_id: userId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
  ]);
  const balance = accounts.reduce((s, a) => s + Number(a.balance), 0);
  const completedTransactions = transactions.filter((t) => t.status === 'COMPLETED');
  const inflow = completedTransactions
    .filter((t) => ['DEPOSIT', 'REFUND'].includes(t.transaction_type))
    .reduce((s, t) => s + Number(t.amount), 0);
  const outflow = completedTransactions
    .filter((t) => ['WITHDRAWAL', 'PAYMENT', 'TRANSFER'].includes(t.transaction_type))
    .reduce((s, t) => s + Number(t.amount), 0);
  const completed = transactions.filter((t) => t.status === 'COMPLETED').length;
  const ratioScore = outflow
    ? Math.max(0, Math.min(35, ((inflow - outflow) / outflow + 1) * 17.5))
    : 35;
  const liquidityScore = Math.min(35, Math.max(0, (balance / Math.max(outflow / 3, 1)) * 35));
  const reliabilityScore = transactions.length
    ? Math.max(0, 30 * (completed / transactions.length))
    : 15;
  const score = Math.round(
    Math.max(
      0,
      Math.min(100, ratioScore + liquidityScore + reliabilityScore - Math.min(10, complaints * 2))
    )
  );
  return {
    score,
    grade: score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
    insights: [
      ...(outflow > inflow ? ['Spending currently exceeds recorded income.'] : []),
      ...(balance < outflow / 3
        ? ['Build an emergency fund covering at least three months of spending.']
        : []),
      ...(complaints ? ['Review open account complaints and resolve outstanding issues.'] : []),
    ],
    rating:
      score >= 80 ? 'EXCELLENT' : score >= 60 ? 'GOOD' : score >= 40 ? 'FAIR' : 'NEEDS_ATTENTION',
    balance: Number(balance.toFixed(2)),
    income: Number(inflow.toFixed(2)),
    spending: Number(outflow.toFixed(2)),
    openComplaints: complaints,
    periodDays: 90,
  };
}

module.exports = { getHealthScore };
