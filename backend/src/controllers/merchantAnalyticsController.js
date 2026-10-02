const prisma = require('../prisma');

async function analytics(req, res, next) {
  try {
    const since = new Date(Date.now() - 30 * 86400000);
    const transactions = await prisma.transaction.findMany({
      where: { user_id: req.user.id, created_at: { gte: since }, status: 'COMPLETED' },
      select: { amount: true, created_at: true, recipient_account: true },
      orderBy: { created_at: 'asc' },
    });
    const revenue = transactions.reduce((sum, tx) => sum + Number(tx.amount), 0);
    const customers = new Set(transactions.map((tx) => tx.recipient_account).filter(Boolean));
    const dailyRevenue = {};
    for (const tx of transactions) {
      const day = tx.created_at.toISOString().slice(0, 10);
      dailyRevenue[day] = (dailyRevenue[day] || 0) + Number(tx.amount);
    }
    res.json({
      ok: true,
      analytics: {
        dailyRevenue,
        weeklyRevenue: revenue,
        monthlyRevenue: revenue,
        repeatCustomers: customers.size,
        averageTransactionValue: transactions.length ? revenue / transactions.length : 0,
        peakHours: [],
        customerRetention: 0,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { analytics, dashboard: analytics };
