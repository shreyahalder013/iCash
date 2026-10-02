const FraudService = require('../src/services/fraudService');

describe('fraud risk scoring', () => {
  test('returns the documented 0-100 score and critical level', () => {
    expect(
      FraudService.calculateRisk({
        amount: 50000,
        recentTransactions: 5,
        transactionType: 'TRANSFER',
        recipientName: null,
      })
    ).toEqual({
      score: 90,
      riskLevel: 'CRITICAL',
      indicators: ['HIGH_VALUE', 'HIGH_FREQUENCY', 'UNKNOWN_RECIPIENT'],
    });
  });

  test('keeps ordinary transactions low risk', () => {
    expect(FraudService.calculateRisk({ amount: 500, recentTransactions: 1 })).toEqual({
      score: 0,
      riskLevel: 'LOW',
      indicators: [],
    });
  });
});
