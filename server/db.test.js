/* =========================================================
   ICASH — Database Layer Tests (Vitest)
   ========================================================= */
import { describe, it, expect, _beforeAll, _afterAll, _beforeEach, _vi } from 'vitest';
import { hashPin, verifyPin, rupeesToPaise, paiseToRupees, formatINR } from './db.js';

describe('db.js - Utilities', () => {
  describe('PIN Hashing', () => {
    it('should hash a PIN and verify it correctly', async () => {
      const pin = '1234';
      const hash = await hashPin(pin);
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.startsWith('$argon2id$')).toBe(true);

      const valid = await verifyPin(pin, hash);
      expect(valid).toBe(true);
    });

    it('should reject incorrect PIN', async () => {
      const pin = '1234';
      const hash = await hashPin(pin);
      const valid = await verifyPin('4321', hash);
      expect(valid).toBe(false);
    });

    it('should produce different hashes for same PIN (salting)', async () => {
      const pin = '1234';
      const hash1 = await hashPin(pin);
      const hash2 = await hashPin(pin);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Monetary Arithmetic', () => {
    it('should convert rupees to paise correctly', () => {
      expect(rupeesToPaise(100)).toBe(10000);
      expect(rupeesToPaise(0.5)).toBe(50);
      expect(rupeesToPaise('100')).toBe(10000);
      expect(rupeesToPaise(48750)).toBe(4875000);
    });

    it('should convert paise to rupees correctly', () => {
      expect(paiseToRupees(10000)).toBe(100);
      expect(paiseToRupees(50)).toBe(0.5);
      expect(paiseToRupees(4875000)).toBe(48750);
    });

    it('should format INR correctly', () => {
      expect(formatINR(10000)).toBe('₹100.00');
      expect(formatINR(4875000)).toBe('₹48,750.00');
      expect(formatINR(50)).toBe('₹0.50');
    });

    it('should handle round-trip conversion without precision loss', () => {
      const amounts = [0.01, 0.1, 1, 10.5, 100, 1000.99, 48750];
      for (const amt of amounts) {
        const paise = rupeesToPaise(amt);
        const back = paiseToRupees(paise);
        expect(back).toBeCloseTo(amt, 2);
      }
    });
  });
});

describe('db.js - In-Memory Store Operations', () => {
  // These tests use the in-memory fallback mode
  const originalFallback = process.env.DATABASE_URL;

  beforeAll(() => {
    // Force in-memory mode by clearing DB connection env vars
    delete process.env.DATABASE_URL;
    delete process.env.PG_HOST;
    delete process.env.SUPABASE_DB_URL;
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalFallback;
  });

  it('should verify utility functions are exported', () => {
    // This test ensures the module exports are available
    expect(typeof rupeesToPaise).toBe('function');
    expect(typeof paiseToRupees).toBe('function');
    expect(typeof formatINR).toBe('function');
    expect(typeof hashPin).toBe('function');
    expect(typeof verifyPin).toBe('function');
  });
});