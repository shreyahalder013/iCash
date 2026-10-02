const prisma = require('../prisma');

const RULES = [
  ['FOOD', /\b(food|restaurant|cafe|coffee|grocery|swiggy|zomato|uber eats)\b/i],
  ['TRANSPORT', /\b(uber|ola|metro|fuel|petrol|diesel|parking|toll|transport)\b/i],
  ['SHOPPING', /\b(shop|shopping|amazon|flipkart|clothing|retail)\b/i],
  ['BILLS', /\b(bill|electricity|water|internet|mobile|rent|utility|recharge)\b/i],
  ['HEALTHCARE', /\b(pharmacy|medical|hospital|doctor|health)\b/i],
  ['EDUCATION', /\b(school|college|university|course|tuition|education|udemy|coursera)\b/i],
  ['ENTERTAINMENT', /\b(movie|cinema|netflix|spotify|game|entertainment)\b/i],
  ['TRAVEL', /\b(hotel|flight|travel|airbnb|booking)\b/i],
  ['INVESTMENT', /\b(invest|investment|mutual fund|sip|stock|shares|brokerage)\b/i],
];

const CATEGORIES = new Set([
  'FOOD',
  'TRANSPORT',
  'SHOPPING',
  'HEALTHCARE',
  'EDUCATION',
  'ENTERTAINMENT',
  'BILLS',
  'TRAVEL',
  'INVESTMENT',
  'OTHER',
]);

function categorize(description, type) {
  const text = String(description || '');
  const match = RULES.find(([, pattern]) => pattern.test(text));
  if (match) return { category: match[0], confidence: 0.95 };
  if (type === 'TRANSFER') return { category: 'TRANSFER', confidence: 0.9 };
  if (type === 'WITHDRAWAL') return { category: 'CASH', confidence: 0.98 };
  if (type === 'DEPOSIT' || type === 'REFUND') return { category: type, confidence: 0.98 };
  return { category: 'OTHER', confidence: 0.45 };
}

class SmartExpenseService {
  static categorize(description, type) {
    return categorize(description, type);
  }

  static async correctCategory(userId, transactionId, category) {
    const normalized = String(category || '')
      .trim()
      .toUpperCase();
    if (!CATEGORIES.has(normalized)) {
      const error = new Error(`Category must be one of: ${Array.from(CATEGORIES).join(', ')}.`);
      error.status = 400;
      throw error;
    }
    const transaction = await prisma.transaction.findFirst({
      where: { id: transactionId, user_id: userId },
    });
    if (!transaction) {
      const error = new Error('Transaction not found or access denied.');
      error.status = 404;
      throw error;
    }
    return prisma.transaction.update({
      where: { id: transactionId },
      data: { category: normalized, category_user_corrected: true, category_confidence: 1 },
    });
  }
}

module.exports = SmartExpenseService;
