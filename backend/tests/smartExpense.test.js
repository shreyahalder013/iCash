const SmartExpenseService = require('../src/services/smartExpenseService');

describe('smart expense categorization', () => {
  test('categorizes common merchant descriptions with high confidence', () => {
    expect(SmartExpenseService.categorize('Dinner at Zomato', 'PAYMENT')).toEqual({
      category: 'FOOD',
      confidence: 0.95,
    });
  });

  test('uses transaction type fallback when description has no match', () => {
    expect(SmartExpenseService.categorize('', 'WITHDRAWAL')).toEqual({
      category: 'CASH',
      confidence: 0.98,
    });
  });

  test('recognizes education and investment merchants', () => {
    expect(SmartExpenseService.categorize('Monthly SIP investment', 'PAYMENT').category).toBe(
      'INVESTMENT'
    );
    expect(SmartExpenseService.categorize('Online course tuition', 'PAYMENT').category).toBe(
      'EDUCATION'
    );
  });
});
