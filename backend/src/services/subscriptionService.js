const prisma = require('../prisma');

async function detectSubscriptions(userId) {
  const transactions = await prisma.transaction.findMany({
    where: {
      user_id: userId,
      status: 'COMPLETED',
      transaction_type: { in: ['PAYMENT', 'WITHDRAWAL'] },
    },
    orderBy: { created_at: 'asc' },
    select: { description: true, amount: true, created_at: true },
  });
  const groups = new Map();
  for (const tx of transactions) {
    const merchant = String(tx.description || 'Unknown merchant')
      .trim()
      .toLowerCase();
    if (!groups.has(merchant)) groups.set(merchant, []);
    groups.get(merchant).push(tx);
  }
  const detected = [];
  for (const [merchant, entries] of groups) {
    if (entries.length < 2) continue;
    const intervals = entries
      .slice(1)
      .map((entry, index) => Math.round((entry.created_at - entries[index].created_at) / 86400000));
    const interval = Math.round(
      intervals.reduce((sum, value) => sum + value, 0) / intervals.length
    );
    const average = entries.reduce((sum, entry) => sum + Number(entry.amount), 0) / entries.length;
    if (
      interval >= 14 &&
      interval <= 45 &&
      entries.every((entry) => Math.abs(Number(entry.amount) - average) / average <= 0.1)
    ) {
      detected.push({
        merchant,
        amount: Number(average.toFixed(2)),
        intervalDays: interval,
        occurrences: entries.length,
      });
    }
  }
  return detected;
}

async function listSubscriptions(userId) {
  return prisma.subscription.findMany({
    where: { user_id: userId, active: true },
    orderBy: { next_due_at: 'asc' },
  });
}

module.exports = { detectSubscriptions, listSubscriptions };
