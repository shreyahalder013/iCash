const fs = require('fs/promises');
const path = require('path');
const { createWorker } = require('tesseract.js');
const prisma = require('../prisma');
const crypto = require('crypto');

function parseReceiptText(text) {
  const totalMatch = text.match(/(?:total|amount payable|grand total)[^\d]*(\d+(?:[.,]\d{1,2})?)/i);
  const taxMatch = text.match(/(?:tax|gst|vat)[^\d]*(\d+(?:[.,]\d{1,2})?)/i);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items = lines
    .slice(1)
    .map((line) => {
      const match = line.match(/^(.*?)(?:\s+|₹)\s*(\d+(?:[.,]\d{1,2})?)$/);
      if (!match || /total|tax|gst|vat|amount payable/i.test(match[1])) return null;
      return { name: match[1].trim().slice(0, 120), amount: Number(match[2].replace(',', '.')) };
    })
    .filter(Boolean)
    .slice(0, 100);
  return {
    merchant: lines[0]?.slice(0, 120) || null,
    total: totalMatch ? Number(totalMatch[1].replace(',', '.')) : null,
    tax: taxMatch ? Number(taxMatch[1].replace(',', '.')) : null,
    items,
  };
}

async function scanReceipt(userId, file) {
  const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'receipts');
  await fs.mkdir(uploadDir, { recursive: true });
  const extension = path.extname(file.originalname).toLowerCase() || '.img';
  const imagePath = path.join(uploadDir, `${userId}-${crypto.randomUUID()}${extension}`);
  await fs.writeFile(imagePath, file.buffer);

  const worker = await createWorker('eng');
  let text;
  try {
    const result = await worker.recognize(file.buffer);
    text = result.data.text || '';
  } finally {
    await worker.terminate();
  }
  const parsed = parseReceiptText(text);
  const receipt = await prisma.receipt.create({
    data: {
      user_id: userId,
      merchant: parsed.merchant,
      receipt_date: new Date(),
      total: parsed.total,
      tax: parsed.tax,
      image_path: imagePath,
      confidence: text.trim() ? 0.75 : 0.1,
      items: { create: parsed.items },
    },
    include: { items: true },
  });
  return {
    id: receipt.id,
    merchant: receipt.merchant,
    date: receipt.receipt_date,
    total: receipt.total ? Number(receipt.total) : null,
    tax: receipt.tax ? Number(receipt.tax) : null,
    items: receipt.items,
    confidence: receipt.confidence ? Number(receipt.confidence) : 0,
  };
}

module.exports = { scanReceipt };
