const prisma = require('../prisma');

function calculateRisk({ amount, recentTransactions = 0, transactionType, recipientName }) {
  const indicators = [];
  let score = 0;
  if (amount >= 50000) {
    score += 45;
    indicators.push('HIGH_VALUE');
  } else if (amount >= 20000) {
    score += 25;
    indicators.push('ELEVATED_VALUE');
  }
  if (recentTransactions >= 5) {
    score += 30;
    indicators.push('HIGH_FREQUENCY');
  }
  if (transactionType === 'TRANSFER' && !recipientName) {
    score += 15;
    indicators.push('UNKNOWN_RECIPIENT');
  }
  score = Math.min(100, score);
  return {
    score,
    riskLevel: score >= 75 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW',
    indicators,
  };
}

class FraudService {
  static async analyze(userId, transactionId) {
    const transaction = await prisma.transaction.findFirst({
      where: { id: transactionId, user_id: userId },
      include: { fraud_analysis: true },
    });
    if (!transaction) {
      const error = new Error('Transaction not found or access denied.');
      error.status = 404;
      throw error;
    }

    const amount = Number(transaction.amount);
    const recent = await prisma.transaction.count({
      where: { user_id: userId, created_at: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    const risk = calculateRisk({
      amount,
      recentTransactions: recent,
      transactionType: transaction.transaction_type,
      recipientName: transaction.recipient_name,
    });
    const analysis = await prisma.fraudAnalysis.upsert({
      where: { transaction_id: transactionId },
      create: {
        transaction_id: transactionId,
        risk_score: risk.score,
        risk_level: risk.riskLevel,
        indicators: risk.indicators,
      },
      update: { risk_score: risk.score, risk_level: risk.riskLevel, indicators: risk.indicators },
    });
    return {
      ...analysis,
      riskScore: Number(analysis.risk_score),
      riskLevel: analysis.risk_level,
      indicators: analysis.indicators || [],
      reasons: analysis.indicators || [],
    };
  }

  static async getAnalysis(userId, transactionId) {
    const transaction = await prisma.transaction.findFirst({
      where: { id: transactionId, user_id: userId },
      include: { fraud_analysis: true },
    });
    if (!transaction) {
      const error = new Error('Transaction not found or access denied.');
      error.status = 404;
      throw error;
    }
    return transaction.fraud_analysis
      ? {
          ...transaction.fraud_analysis,
          riskScore: Number(transaction.fraud_analysis.risk_score),
          riskLevel: transaction.fraud_analysis.risk_level,
          indicators: transaction.fraud_analysis.indicators || [],
          reasons: transaction.fraud_analysis.indicators || [],
        }
      : null;
  }
}

module.exports = FraudService;
module.exports.calculateRisk = calculateRisk;
