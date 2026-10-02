const AIProvider = require('../src/services/aiProvider');

describe('AIProvider', () => {
  test('returns an explicit grounded local response without an API key', async () => {
    const provider = new AIProvider({ apiKey: null });
    const answer = await provider.generate({
      question: 'Why did I spend so much?',
      context:
        'date=2026-09-01 amount=₹1,000.00 type=PAYMENT description=Groceries status=COMPLETED',
    });

    expect(answer).toContain('1 recent transactions');
    expect(answer).toContain('₹1,000.00');
    expect(answer).toContain('OPENAI_API_KEY');
  });
});
