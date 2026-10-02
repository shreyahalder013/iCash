const { calculateSplits, optimizeDebts } = require('../src/services/splitService');

describe('smart bill splitting', () => {
  test('equal split allocates rounding remainder deterministically', () => {
    expect(calculateSplits(10, ['a', 'b', 'c'], 'EQUAL').map((x) => x.amount)).toEqual([
      3.34, 3.33, 3.33,
    ]);
  });

  test('percentage and custom splits conserve every cent', () => {
    expect(calculateSplits(12, ['a', 'b'], 'PERCENTAGE', [25, 75]).map((x) => x.amount)).toEqual([
      3, 9,
    ]);
    expect(calculateSplits(10, ['a', 'b'], 'CUSTOM', [2.5, 7.5]).map((x) => x.amount)).toEqual([
      2.5, 7.5,
    ]);
  });

  test('optimizer nets balances with minimal greedy transfers', () => {
    expect(optimizeDebts({ a: -10, b: -5, c: 15 })).toEqual([
      { from: 'a', to: 'c', amount: 10 },
      { from: 'b', to: 'c', amount: 5 },
    ]);
  });

  test('rejects balances that do not net to zero', () => {
    expect(() => optimizeDebts({ a: -1, b: 2 })).toThrow('Balances must net to zero');
  });
});
