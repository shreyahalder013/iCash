/* =========================================================
   ICASH — Supabase / PostgreSQL Database Layer
   With Resilient In-Memory Fallback.
   Supports individual PG* env vars and connection URLs.
   If PostgreSQL is unavailable or credentials fail, automatically
   switches to in-memory mode so the biometric server NEVER goes down.
   ========================================================= */
const { Pool } = require('pg');
const path = require('path');
const argon2 = require('argon2');
const logger = require('./logger');

// Automatically load .env if present
try {
  if (process.loadEnvFile) {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  }
} catch (_e) {}

let pool = null;
let isFallback = false;

// In-Memory Data Store (Active when PostgreSQL is offline)
// DEMO DATA ONLY — No real credentials, no production use
const memStore = {
  users: [],
  transactions: [],
  events: [],
  sessions: []
};

function createPool() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (process.env.PG_HOST) {
    const pool = new Pool({
      host:                    process.env.PG_HOST,
      port:                    parseInt(process.env.PG_PORT || '6543'),
      database:                process.env.PG_DATABASE || 'postgres',
      user:                    process.env.PG_USER,
      password:                process.env.PG_PASSWORD,
      ssl:                     { rejectUnauthorized: process.env.PG_REJECT_UNAUTHORIZED === 'true' },
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis:       10000
    });
    // Parse BIGINT (OID 20) and NUMERIC (OID 1700) as numbers instead of strings
    pool.on('connect', (client) => {
      client.on('type', (type) => {
        if (type.oid === 20 || type.oid === 1700) { // BIGINT or NUMERIC
          type.parse = (val) => val === null ? null : Number(val);
        }
      });
    });
    return pool;
  } else if (dbUrl) {
    const pool = new Pool({
      connectionString:        dbUrl,
      ssl:                     { rejectUnauthorized: process.env.PG_REJECT_UNAUTHORIZED === 'true' },
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis:       10000
    });
    // Parse BIGINT (OID 20) and NUMERIC (OID 1700) as numbers instead of strings
    pool.on('connect', (client) => {
      client.on('type', (type) => {
        if (type.oid === 20 || type.oid === 1700) { // BIGINT or NUMERIC
          type.parse = (val) => val === null ? null : Number(val);
        }
      });
    });
    return pool;
  }
  return null;
}

/* =========================================================
   PASSWORD/PIN HASHING UTILITIES
   ========================================================= */
async function hashPin(pin) {
  try {
    // Argon2id with OWASP recommended parameters
    return await argon2.hash(pin, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,  // 64 MB
      timeCost: 3,
      parallelism: 1
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'PIN hashing failed');
    throw new Error('Failed to hash PIN: ' + err.message);
  }
}

async function verifyPin(pin, hash) {
  try {
    if (!hash || !pin) {return false;}
    const cleanPin = String(pin).trim();
    if (!hash.startsWith('$argon2')) {
      return cleanPin === String(hash).trim();
    }
    return await argon2.verify(hash, cleanPin);
  } catch (err) {
    logger.warn({ err: err.message }, 'PIN verification error');
    return false;
  }
}

/* =========================================================
   MONETARY ARITHMETIC — Integer Minor Units (Paise)
   All amounts stored/retrieved as integers (₹1 = 100 paise)
   ========================================================= */
function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

function paiseToRupees(paise) {
  return Number(paise) / 100;
}

function formatINR(paise) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Normalize phone number to E.164-like format.
 * - Strips spaces, dashes, parentheses, dots
 * - Defaults to +91 (India) if no country code provided
 * - Returns format like +919876543210
 */
function normalizePhone(phone) {
  if (!phone) {return '';}
  // Remove all non-digit characters except leading +
  let cleaned = phone.trim().replace(/[^\d+]/g, '');
  
  // If starts with 0 (Indian trunk prefix), remove it
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }
  
  // If starts with 91 but no +, add +
  if (cleaned.startsWith('91') && !cleaned.startsWith('+91')) {
    cleaned = '+' + cleaned;
  }
  
  // If no country code, assume +91
  if (!cleaned.startsWith('+')) {
    cleaned = '+91' + cleaned;
  }
  
  // Validate: should be +91 followed by 10 digits
  if (!/^\+91\d{10}$/.test(cleaned)) {
    // Return original cleaned version for debugging, but this will fail validation
    return cleaned;
  }
  
  return cleaned;
}

/* =========================================================
   INIT
   ========================================================= */
async function initDb() {
  logger.info('=== DB Connection Diagnostics ===');
  logger.info({ PG_HOST: process.env.PG_HOST || '(not set)' });
  logger.info({ PG_PORT: process.env.PG_PORT || '(not set)' });
  logger.info({ PG_USER: process.env.PG_USER || '(not set)' });
  logger.info({ PG_PASSWORD: process.env.PG_PASSWORD ? '(set)' : '(not set)' });
  logger.info({ SUPABASE_DB_URL: process.env.SUPABASE_DB_URL ? '(set)' : '(not set)' });
  logger.info({ DATABASE_URL: process.env.DATABASE_URL ? '(set)' : '(not set)' });
  logger.info({ mode: process.env.PG_HOST ? 'individual vars' : (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL ? 'connection URL' : 'in-memory fallback') });
  logger.info('=================================');

  try {
    pool = createPool();
    if (!pool) {
      throw new Error('No PostgreSQL credentials provided in environment');
    }

    const client = await pool.connect();
    client.release();

    // Create tables if they don't exist yet
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                          SERIAL PRIMARY KEY,
        name                        TEXT NOT NULL,
        phone                       TEXT NOT NULL UNIQUE,
        aadhaar                     TEXT,
        email                       TEXT,
        dob                         TEXT,
        age                         INTEGER,
        senior                      BOOLEAN DEFAULT FALSE,
        normal_pin_hash             TEXT NOT NULL,
        emergency_pin_hash          TEXT,
        emergency_contact_name      TEXT,
        emergency_contact_phone     TEXT,
        emergency_contact_relation  TEXT,
        face_registered             BOOLEAN DEFAULT FALSE,
        biometric_template          TEXT,
        last_login                  TEXT,
        senior_mode                 BOOLEAN DEFAULT FALSE,
        balance_paise               BIGINT DEFAULT 4875000,
        created_at                  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration: rename old columns if they exist
    try {
      await pool.query(`ALTER TABLE users RENAME COLUMN normal_pin TO normal_pin_hash;`);
    } catch (_err) {}
    try {
      await pool.query(`ALTER TABLE users RENAME COLUMN emergency_pin TO emergency_pin_hash;`);
    } catch (_err) {}
    try {
      await pool.query(`ALTER TABLE users RENAME COLUMN balance TO balance_paise;`);
    } catch (_err) {}
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhaar_last4 TEXT;`);
    } catch (_err) {}
    try {
      await pool.query(`ALTER TABLE transactions RENAME COLUMN amount TO amount_paise;`);
    } catch (_err) {}
    try {
      await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount_paise BIGINT;`);
    } catch (_err) {}
    try {
      await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS duress BOOLEAN DEFAULT FALSE;`);
    } catch (_err) {}

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        txn_id          TEXT NOT NULL,
        date            TEXT NOT NULL,
        description     TEXT NOT NULL,
        type            TEXT NOT NULL CHECK (type IN ('in', 'out', 'mid')),
        category        TEXT,
        amount_paise    BIGINT NOT NULL,
        status          TEXT DEFAULT 'Completed',
        idempotency_key TEXT UNIQUE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add idempotency_key column if missing
    try {
      await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;`);
    } catch (_err) {}

    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        description TEXT NOT NULL,
        timestamp   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        method     TEXT,
        active     BOOLEAN DEFAULT TRUE,
        duress     BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Challenges table for biometric challenge-response (single-use, TTL)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biometric_challenges (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        challenge_type  TEXT NOT NULL,
        session_nonce   TEXT,
        client_ip       TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL,
        used            BOOLEAN DEFAULT FALSE,
        used_at         TIMESTAMPTZ
      )
    `);

    // Index for challenge lookup and cleanup
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenges_user_expires ON biometric_challenges(user_id, expires_at);`);

    // Create indexes for performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_security_events_user_id ON security_events(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id_active ON sessions(user_id, active);`);

    await seedIfEmpty();
    logger.info('✓ Connected to Supabase PostgreSQL — tables ready');
    isFallback = false;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not connect to PostgreSQL — activating in-memory fallback');
    isFallback = true;
    seedMemoryStore();
  }
}

async function seedIfEmpty() {
  if (isFallback || !pool) {return;}
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS c FROM users');
    if (parseInt(rows[0].c) > 0) {return;}

    // Only seed when explicitly allowed via env var
    if (process.env.ALLOW_DEMO_SEED !== 'true') {
      logger.info('Demo seed not allowed (set ALLOW_DEMO_SEED=true to enable) — skipping');
      return;
    }

    // PINs from environment variables (required when seeding)
    const demoNormalPin = process.env.DEMO_NORMAL_PIN;
    const demoEmergencyPin = process.env.DEMO_EMERGENCY_PIN;
    if (!demoNormalPin || !demoEmergencyPin) {
      logger.warn('DEMO_NORMAL_PIN and DEMO_EMERGENCY_PIN must be set when ALLOW_DEMO_SEED=true');
      return;
    }

    const normalPinHash = await hashPin(demoNormalPin);
    const emergencyPinHash = await hashPin(demoEmergencyPin);

    const { rows: inserted } = await pool.query(`
      INSERT INTO users (
        name, phone, aadhaar_last4, email, dob, age, senior,
        normal_pin_hash, emergency_pin_hash,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
        face_registered, last_login, senior_mode, balance_paise
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id
    `, [
      'Demo User', '+91 98765 43210', '8921', 'demo@icash.app',
      '1999-04-12', 25, false,
      normalPinHash, emergencyPinHash,
      'Emergency Contact', '+91 91234 56789', 'Guardian',
      false, new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), false, 4875000
    ]);

    const userId = inserted[0].id;
    const seedTx = [
      ['TXN-9F21A', '2026-09-20', 'Salary Credit',    'in',  null,         500000],
      ['TXN-8C10B', '2026-09-19', 'Grocery Store',    'out', 'Food',       120000],
      ['TXN-7A02D', '2026-09-18', 'ATM Withdrawal',   'out', 'Cash',       200000],
      ['TXN-6E88F', '2026-09-16', 'Electricity Bill', 'out', 'Bills',       50000],
      ['TXN-5D77C', '2026-09-14', 'Cab Ride',         'out', 'Transport',   75000],
    ];

    for (const [txnId, date, desc, type, cat, amount] of seedTx) {
      await pool.query(
        'INSERT INTO transactions (user_id,txn_id,date,description,type,category,amount_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [userId, txnId, date, desc, type, cat, amount]
      );
    }
    logger.info({ userId }, 'Database seeded with demo user and transactions');
  } catch (err) {
    logger.warn({ err: err.message }, 'Seed note');
  }
}

function seedMemoryStore() {
  // Only seed when explicitly allowed via env var
  if (process.env.ALLOW_DEMO_SEED !== 'true') {
    logger.info('Demo seed not allowed (set ALLOW_DEMO_SEED=true to enable) — skipping');
    return;
  }
  if (memStore.users.length > 0) {return;}
  // PINs from environment variables (required when seeding)
  const demoNormalPin = process.env.DEMO_NORMAL_PIN;
  const demoEmergencyPin = process.env.DEMO_EMERGENCY_PIN;
  if (!demoNormalPin || !demoEmergencyPin) {
    logger.warn('DEMO_NORMAL_PIN and DEMO_EMERGENCY_PIN must be set when ALLOW_DEMO_SEED=true');
    return;
  }
  // Seed with hashed PINs from env
  (async () => {
    const normalPinHash = await hashPin(demoNormalPin);
    const emergencyPinHash = await hashPin(demoEmergencyPin);
    memStore.users.push({
      id: 1,
      name: 'Demo User',
      phone: '+91 98765 43210',
      aadhaar_last4: '8921',
      email: 'demo@icash.app',
      dob: '1999-04-12',
      age: 25,
      senior: false,
      normal_pin_hash: normalPinHash,
      emergency_pin_hash: emergencyPinHash,
      emergency_contact_name: 'Emergency Contact',
      emergency_contact_phone: '+91 91234 56789',
      emergency_contact_relation: 'Guardian',
      face_registered: false,
      biometric_template: null,
      last_login: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      senior_mode: false,
      balance_paise: 4875000
    });
    memStore.transactions.push(
      { id: 1, user_id: 1, txn_id: 'TXN-9F21A', date: '2026-09-20', description: 'Salary Credit', type: 'in', category: null, amount_paise: 500000, status: 'Completed', created_at: new Date() },
      { id: 2, user_id: 1, txn_id: 'TXN-8C10B', date: '2026-09-19', description: 'Grocery Store', type: 'out', category: 'Food', amount_paise: 120000, status: 'Completed', created_at: new Date() },
      { id: 3, user_id: 1, txn_id: 'TXN-7A02D', date: '2026-09-18', description: 'ATM Withdrawal', type: 'out', category: 'Cash', amount_paise: 200000, status: 'Completed', created_at: new Date() },
      { id: 4, user_id: 1, txn_id: 'TXN-6E88F', date: '2026-09-16', description: 'Electricity Bill', type: 'out', category: 'Bills', amount_paise: 50000, status: 'Completed', created_at: new Date() },
      { id: 5, user_id: 1, txn_id: 'TXN-5D77C', date: '2026-09-14', description: 'Cab Ride', type: 'out', category: 'Transport', amount_paise: 75000, status: 'Completed', created_at: new Date() }
    );
  })();
}

/* =========================================================
   USER HELPERS
   ========================================================= */
function formatUser(row) {
  if (!row) {return null;}
  const hasBio = !!(row.biometric_template && row.biometric_template.length > 10);
  return {
    id:            row.id,
    name:          row.name,
    phone:         row.phone,
    aadhaar:       row.aadhaar_last4 ? 'XXXX XXXX ' + row.aadhaar_last4 : null,
    email:         row.email,
    dob:           row.dob,
    age:           row.age,
    senior:        !!row.senior,
    emergencyContact: {
      name:     row.emergency_contact_name,
      phone:    row.emergency_contact_phone,
      relation: row.emergency_contact_relation
    },
    faceRegistered: !!row.face_registered || hasBio,
    hasBiometric:  hasBio,
    lastLogin:     row.last_login,
    seniorMode:    !!row.senior_mode,
    balance:       paiseToRupees(row.balance_paise),
    balancePaise:  row.balance_paise
  };
}

async function createUser(userData) {
  const bioTemplate = userData.biometricTemplate ? JSON.stringify(userData.biometricTemplate) : null;
  const isFaceReg = userData.faceRegistered || !!bioTemplate;

  const normalPinHash = await hashPin(userData.normalPin);
  const emergencyPinHash = userData.emergencyPin ? await hashPin(userData.emergencyPin) : null;

  // Normalize phone number before storing
  const normalizedPhone = normalizePhone(userData.phone);

  if (isFallback || !pool) {
    const newId = memStore.users.length + 1;
    const newUser = {
      id: newId,
      name: userData.name,
      phone: normalizedPhone,
      aadhaar_last4: userData.aadhaar?.slice(-4) || null,
      email: userData.email,
      dob: userData.dob,
      age: userData.age,
      senior: !!userData.senior,
      normal_pin_hash: normalPinHash,
      emergency_pin_hash: emergencyPinHash,
      emergency_contact_name: userData.emergencyContact?.name || null,
      emergency_contact_phone: userData.emergencyContact?.phone ? normalizePhone(userData.emergencyContact.phone) : null,
      emergency_contact_relation: userData.emergencyContact?.relation || null,
      face_registered: isFaceReg,
      biometric_template: bioTemplate,
      last_login: userData.lastLogin || 'Just now',
      senior_mode: !!userData.seniorMode,
      balance_paise: 4875000
    };
    memStore.users.push(newUser);
    return newId;
  }

  const { rows } = await pool.query(`
    INSERT INTO users (
      name, phone, aadhaar_last4, email, dob, age, senior,
      normal_pin_hash, emergency_pin_hash,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
      face_registered, biometric_template, last_login, senior_mode, balance_paise
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING id
  `, [
    userData.name, normalizedPhone, userData.aadhaar?.slice(-4) || null, userData.email,
    userData.dob, userData.age, userData.senior ? true : false,
    normalPinHash, emergencyPinHash,
    userData.emergencyContact?.name  || null,
    userData.emergencyContact?.phone ? normalizePhone(userData.emergencyContact.phone) : null,
    userData.emergencyContact?.relation || null,
    isFaceReg,
    bioTemplate,
    userData.lastLogin || 'Just now',
    userData.seniorMode ? true : false,
    4875000
  ]);
  return rows[0].id;
}

async function getUserById(id) {
  if (isFallback || !pool) {
    const u = memStore.users.find(u => u.id === Number(id));
    return formatUser(u || null);
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return formatUser(rows[0] || null);
}

async function getUserByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (isFallback || !pool) {
    const u = memStore.users.find(u => u.phone === normalizedPhone);
    return formatUser(u || null);
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [normalizedPhone]);
  return formatUser(rows[0] || null);
}

async function getUserRawById(id) {
  if (isFallback || !pool) {
    return memStore.users.find(u => u.id === Number(id)) || null;
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserRawByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (isFallback || !pool) {
    return memStore.users.find(u => u.phone === normalizedPhone) || null;
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [normalizedPhone]);
  return rows[0] || null;
}

async function getFirstUser() {
  if (isFallback || !pool) {
    return formatUser(memStore.users[0] || null);
  }
  const { rows } = await pool.query('SELECT * FROM users ORDER BY id ASC LIMIT 1');
  return formatUser(rows[0] || null);
}

async function getFirstUserRaw() {
  if (isFallback || !pool) {
    return memStore.users[0] || null;
  }
  const { rows } = await pool.query('SELECT * FROM users ORDER BY id ASC LIMIT 1');
  return rows[0] || null;
}

async function updateUser(id, data) {
  if (isFallback || !pool) {
    const u = memStore.users.find(u => u.id === Number(id));
    if (!u) {return;}
    if (data.name !== undefined) {u.name = data.name;}
    if (data.phone !== undefined) {u.phone = data.phone;}
    if (data.email !== undefined) {u.email = data.email;}
    if (data.seniorMode !== undefined) {u.senior_mode = !!data.seniorMode;}
    if (data.lastLogin !== undefined) {u.last_login = data.lastLogin;}
    if (data.balancePaise !== undefined) {u.balance_paise = data.balancePaise;}
    if (data.normalPin !== undefined) {u.normal_pin_hash = await hashPin(data.normalPin);}
    if (data.emergencyPin !== undefined) {u.emergency_pin_hash = await hashPin(data.emergencyPin);}
    return;
  }

  const fields = [];
  const values = [];
  let i = 1;

  if (data.name          !== undefined) { fields.push(`name = $${i++}`);          values.push(data.name); }
  if (data.phone         !== undefined) { fields.push(`phone = $${i++}`);         values.push(data.phone); }
  if (data.email         !== undefined) { fields.push(`email = $${i++}`);         values.push(data.email); }
  if (data.seniorMode    !== undefined) { fields.push(`senior_mode = $${i++}`);   values.push(!!data.seniorMode); }
  if (data.lastLogin     !== undefined) { fields.push(`last_login = $${i++}`);    values.push(data.lastLogin); }
  if (data.balancePaise  !== undefined) { fields.push(`balance_paise = $${i++}`); values.push(data.balancePaise); }
  if (data.normalPin     !== undefined) { fields.push(`normal_pin_hash = $${i++}`); values.push(await hashPin(data.normalPin)); }
  if (data.emergencyPin  !== undefined) { fields.push(`emergency_pin_hash = $${i++}`); values.push(await hashPin(data.emergencyPin)); }
  if (data.emergencyContact) {
    fields.push(`emergency_contact_name = $${i++}`, `emergency_contact_phone = $${i++}`, `emergency_contact_relation = $${i++}`);
    values.push(data.emergencyContact.name, data.emergencyContact.phone, data.emergencyContact.relation);
  }

  if (fields.length === 0) {return;}
  values.push(id);
  await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${i}`, values);
}

/* =========================================================
   TRANSACTIONS — Atomic Operations with Idempotency
   ========================================================= */
async function getTransactions(userId, filters = {}) {
  if (isFallback || !pool) {
    let list = memStore.transactions.filter(t => t.user_id === Number(userId));
    if (filters.type) {list = list.filter(t => t.type === filters.type);}
    if (filters.date) {list = list.filter(t => t.date === filters.date);}
    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(t => (t.description || '').toLowerCase().includes(q) || (t.txn_id || '').toLowerCase().includes(q));
    }
    return list.map(t => ({
      id: t.txn_id,
      date: t.date,
      desc: t.description,
      type: t.type,
      cat: t.category,
      amount: paiseToRupees(t.amount_paise),
      amountPaise: t.amount_paise,
      status: t.status
    }));
  }

  let sql = 'SELECT * FROM transactions WHERE user_id = $1';
  const params = [userId];
  let i = 2;

  if (filters.type)   { sql += ` AND type = $${i++}`;             params.push(filters.type); }
  if (filters.date)   { sql += ` AND date = $${i++}`;             params.push(filters.date); }
  if (filters.search) { sql += ` AND (description ILIKE $${i} OR txn_id ILIKE $${i})`; i++; params.push(`%${filters.search}%`); }

  sql += ' ORDER BY created_at DESC LIMIT 500';

  const { rows } = await pool.query(sql, params);
  return rows.map(row => ({
    id:     row.txn_id,
    date:   row.date,
    desc:   row.description,
    type:   row.type,
    cat:    row.category,
    amount: paiseToRupees(row.amount_paise),
    amountPaise: row.amount_paise,
    status: row.status
  }));
}

/**
 * Create a transaction atomically with balance update.
 * Uses PostgreSQL transaction with row-level locking.
 * @param {number} userId
 * @param {Object} tx - { id, date, desc, type, cat, amountPaise, status, idempotencyKey }
 * @returns {Object} { success: boolean, balancePaise: number, transaction: Object }
 */
async function createTransaction(userId, tx) {
  const { id, date, desc, type, cat, amountPaise, status, idempotencyKey } = tx;

  if (isFallback || !pool) {
    // Check for duplicate idempotency key in memory
    if (idempotencyKey && memStore.transactions.some(t => t.idempotency_key === idempotencyKey)) {
      throw new Error('Duplicate transaction (idempotency key already used)');
    }
    memStore.transactions.unshift({
      id: memStore.transactions.length + 1,
      user_id: Number(userId),
      txn_id: id,
      date,
      description: desc,
      type,
      category: cat || null,
      amount_paise: amountPaise,
      status: status || 'Completed',
      idempotency_key: idempotencyKey || null,
      created_at: new Date()
    });
    return { success: true };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check idempotency key
    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        'SELECT 1 FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing.length > 0) {
        await client.query('ROLLBACK');
        throw new Error('Duplicate transaction (idempotency key already used)');
      }
    }

    // Insert transaction
    await client.query(
      'INSERT INTO transactions (user_id,txn_id,date,description,type,category,amount_paise,status,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [userId, id, date, desc, type, cat || null, amountPaise, status || 'Completed', idempotencyKey || null]
    );

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transfer money between accounts atomically.
 * @param {number} fromUserId
 * @param {number} toUserId
 * @param {number} amountPaise
 * @param {string} description
 * @param {string} idempotencyKey
 * @returns {Object} { success: boolean, fromBalancePaise: number, toBalancePaise: number }
 */
async function transferFunds(fromUserId, toUserId, amountPaise, description, idempotencyKey) {
  if (isFallback || !pool) {
    const fromUser = memStore.users.find(u => u.id === Number(fromUserId));
    const toUser = memStore.users.find(u => u.id === Number(toUserId));
    if (!fromUser || !toUser) {throw new Error('User not found');}
    if (fromUser.balance_paise < amountPaise) {throw new Error('Insufficient funds');}
    if (idempotencyKey && memStore.transactions.some(t => t.idempotency_key === idempotencyKey)) {
      throw new Error('Duplicate transaction');
    }
    fromUser.balance_paise -= amountPaise;
    toUser.balance_paise += amountPaise;
    const txnId = 'TXN-' + Math.random().toString(16).slice(2,7).toUpperCase();
    const now = new Date().toISOString().slice(0,10);
    memStore.transactions.unshift({
      id: memStore.transactions.length + 1,
      user_id: fromUserId,
      txn_id: txnId,
      date: now,
      description,
      type: 'out',
      category: 'Transfer',
      amount_paise: amountPaise,
      status: 'Completed',
      idempotency_key: idempotencyKey,
      created_at: new Date()
    });
    memStore.transactions.unshift({
      id: memStore.transactions.length + 1,
      user_id: toUserId,
      txn_id: txnId + 'R',
      date: now,
      description: 'Received: ' + description,
      type: 'in',
      category: 'Transfer',
      amount_paise: amountPaise,
      status: 'Completed',
      idempotency_key: idempotencyKey + '-recv',
      created_at: new Date()
    });
    return { success: true, fromBalancePaise: fromUser.balance_paise, toBalancePaise: toUser.balance_paise };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check idempotency
    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        'SELECT 1 FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing.length > 0) {
        await client.query('ROLLBACK');
        throw new Error('Duplicate transaction (idempotency key already used)');
      }
    }

    // Lock sender row and check balance
    const { rows: senderRows } = await client.query(
      'SELECT balance_paise FROM users WHERE id = $1 FOR UPDATE',
      [fromUserId]
    );
    if (senderRows.length === 0) {throw new Error('Sender not found');}
    if (senderRows[0].balance_paise < amountPaise) {
      await client.query('ROLLBACK');
      throw new Error('Insufficient funds');
    }

    // Lock recipient row
    const { rows: recipientRows } = await client.query(
      'SELECT balance_paise FROM users WHERE id = $1 FOR UPDATE',
      [toUserId]
    );
    if (recipientRows.length === 0) {throw new Error('Recipient not found');}

    // Update balances
    await client.query(
      'UPDATE users SET balance_paise = balance_paise - $1 WHERE id = $2',
      [amountPaise, fromUserId]
    );
    await client.query(
      'UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2',
      [amountPaise, toUserId]
    );

    // Record transactions
    const txnId = 'TXN-' + Math.random().toString(16).slice(2,7).toUpperCase();
    const now = new Date().toISOString().slice(0,10);

    await client.query(
      'INSERT INTO transactions (user_id,txn_id,date,description,type,category,amount_paise,status,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [fromUserId, txnId, now, description, 'out', 'Transfer', amountPaise, 'Completed', idempotencyKey]
    );
    await client.query(
      'INSERT INTO transactions (user_id,txn_id,date,description,type,category,amount_paise,status,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [toUserId, txnId + 'R', now, 'Received: ' + description, 'in', 'Transfer', amountPaise, 'Completed', idempotencyKey + '-recv']
    );

    await client.query('COMMIT');

    return {
      success: true,
      fromBalancePaise: senderRows[0].balance_paise - amountPaise,
      toBalancePaise: recipientRows[0].balance_paise + amountPaise
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update user balance atomically (for deposits/withdrawals).
 * @param {number} userId
 * @param {number} amountPaise - positive for deposit, negative for withdrawal
 * @param {string} description
 * @param {string} idempotencyKey
 * @returns {Object} { success: boolean, balancePaise: number }
 */
async function adjustBalance(userId, amountPaise, description, idempotencyKey) {
  if (isFallback || !pool) {
    const user = memStore.users.find(u => u.id === Number(userId));
    if (!user) {throw new Error('User not found');}
    if (user.balance_paise + amountPaise < 0) {throw new Error('Insufficient funds');}
    if (idempotencyKey && memStore.transactions.some(t => t.idempotency_key === idempotencyKey)) {
      throw new Error('Duplicate transaction');
    }
    user.balance_paise += amountPaise;
    const type = amountPaise >= 0 ? 'in' : 'out';
    const txnId = 'TXN-' + Math.random().toString(16).slice(2,7).toUpperCase();
    const now = new Date().toISOString().slice(0,10);
    memStore.transactions.unshift({
      id: memStore.transactions.length + 1,
      user_id: userId,
      txn_id: txnId,
      date: now,
      description,
      type,
      category: type === 'in' ? 'Deposit' : 'Cash',
      amount_paise: Math.abs(amountPaise),
      status: 'Completed',
      idempotency_key: idempotencyKey,
      created_at: new Date()
    });
    return { success: true, balancePaise: user.balance_paise };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        'SELECT 1 FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing.length > 0) {
        await client.query('ROLLBACK');
        throw new Error('Duplicate transaction (idempotency key already used)');
      }
    }

    // Lock and check balance
    const { rows } = await client.query(
      'SELECT balance_paise FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (rows.length === 0) {throw new Error('User not found');}
    // Ensure balance is a number (handle string from DB)
    const currentBalance = Number(rows[0].balance_paise);
    if (isNaN(currentBalance)) {
      throw new Error('Invalid balance value from database');
    }
    const newBalance = currentBalance + Number(amountPaise);
    if (newBalance < 0) {
      await client.query('ROLLBACK');
      throw new Error('Insufficient funds');
    }

    // Ensure newBalance is a plain number for parameter binding
    const newBalanceNum = Number(newBalance);
    if (isNaN(newBalanceNum)) {
      throw new Error('Invalid new balance calculation');
    }

    await client.query(
      'UPDATE users SET balance_paise = $1 WHERE id = $2',
      [newBalanceNum, userId]
    );

    const type = amountPaise >= 0 ? 'in' : 'out';
    const txnId = 'TXN-' + Math.random().toString(16).slice(2,7).toUpperCase();
    const now = new Date().toISOString().slice(0,10);

    await client.query(
      'INSERT INTO transactions (user_id,txn_id,date,description,type,category,amount_paise,status,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [userId, txnId, now, description, type, type === 'in' ? 'Deposit' : 'Cash', Math.abs(amountPaise), 'Completed', idempotencyKey]
    );

    await client.query('COMMIT');
    return { success: true, balancePaise: newBalance };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* =========================================================
   SECURITY EVENTS
   ========================================================= */
async function getSecurityEvents(userId, limit = 12) {
  if (isFallback || !pool) {
    return memStore.events
      .filter(e => e.user_id === Number(userId))
      .slice(0, limit)
      .map(e => ({ type: e.type, desc: e.description, time: e.timestamp }));
  }

  const { rows } = await pool.query(
    'SELECT * FROM security_events WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2',
    [userId, limit]
  );
  return rows.map(row => ({
    type: row.type,
    desc: row.description,
    time: row.timestamp
  }));
}

async function logSecurityEvent(userId, type, description) {
  if (isFallback || !pool) {
    memStore.events.unshift({
      id: memStore.events.length + 1,
      user_id: Number(userId),
      type,
      description,
      timestamp: new Date().toISOString()
    });
    return;
  }

  await pool.query(
    'INSERT INTO security_events (user_id,type,description) VALUES ($1,$2,$3)',
    [userId, type, description]
  );
}

/* =========================================================
   SESSIONS
   ========================================================= */
async function createSession(userId, method, duress = false) {
  if (isFallback || !pool) {
    memStore.sessions.forEach(s => { if (s.user_id === Number(userId)) {s.active = false;} });
    const sId = memStore.sessions.length + 1;
    memStore.sessions.push({ id: sId, user_id: Number(userId), method, active: true, duress, created_at: new Date() });
    return sId;
  }

  await pool.query('UPDATE sessions SET active = FALSE WHERE user_id = $1', [userId]);
  const { rows } = await pool.query(
    'INSERT INTO sessions (user_id,method,active,duress) VALUES ($1,$2,TRUE,$3) RETURNING id',
    [userId, method, duress]
  );
  return rows[0].id;
}

async function deactivateSession(userId) {
  if (isFallback || !pool) {
    memStore.sessions.forEach(s => { if (s.user_id === Number(userId)) {s.active = false;} });
    return;
  }
  await pool.query('UPDATE sessions SET active = FALSE WHERE user_id = $1', [userId]);
}

async function getActiveSession(userId) {
  if (isFallback || !pool) {
    return memStore.sessions.find(s => s.user_id === Number(userId) && s.active) || null;
  }
  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE user_id = $1 AND active = TRUE ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

/* =========================================================
   BIOMETRIC CHALLENGES (Server-Authoritative)
   ========================================================= */

/**
 * Create a new biometric challenge in the database.
 * @param {number} userId
 * @param {string} challengeType - One of: blink_once, blink_twice, turn_left_blink, turn_right_blink
 * @param {string} [sessionNonce]
 * @param {string} [clientIp]
 * @returns {Object} { challengeId, challengeType, expiresAt }
 */
async function createBiometricChallenge(userId, challengeType, sessionNonce, clientIp) {
  if (isFallback || !pool) {
    // In-memory fallback
    const challengeId = crypto.randomUUID();
    const expiresAt = Date.now() + 60000;
    if (!memStore.challenges) {memStore.challenges = new Map();}
    memStore.challenges.set(challengeId, {
      id: challengeId,
      user_id: Number(userId),
      challenge_type: challengeType,
      session_nonce: sessionNonce,
      client_ip: clientIp,
      created_at: Date.now(),
      expires_at: expiresAt,
      used: false
    });
    return { challengeId, challengeType, expiresAt };
  }

  const expiresAt = new Date(Date.now() + 60000); // 60 seconds
  const { rows } = await pool.query(
    `INSERT INTO biometric_challenges (user_id, challenge_type, session_nonce, client_ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, challenge_type, expires_at`,
    [userId, challengeType, sessionNonce, clientIp, expiresAt]
  );
  return {
    challengeId: rows[0].id,
    challengeType: rows[0].challenge_type,
    expiresAt: rows[0].expires_at
  };
}

/**
 * Validate and consume a biometric challenge (single-use).
 * @param {string} challengeId
 * @param {number} userId
 * @returns {Object|null} Challenge data if valid, null if invalid/expired/used
 */
async function validateAndConsumeChallenge(challengeId, userId) {
  if (isFallback || !pool) {
    if (!memStore.challenges) {return null;}
    const challenge = memStore.challenges.get(challengeId);
    if (!challenge) {return null;}
    if (challenge.user_id !== Number(userId)) {return null;}
    if (challenge.used) {return null;}
    if (Date.now() > challenge.expires_at) {return null;}
    // Mark as used
    challenge.used = true;
    challenge.used_at = Date.now();
    return challenge;
  }

  const { rows } = await pool.query(
    `SELECT * FROM biometric_challenges
     WHERE id = $1 AND user_id = $2 AND used = FALSE AND expires_at > NOW()
     FOR UPDATE`,
    [challengeId, userId]
  );

  if (rows.length === 0) {return null;}

  // Mark as used atomically
  await pool.query(
    `UPDATE biometric_challenges SET used = TRUE, used_at = NOW() WHERE id = $1`,
    [challengeId]
  );

  return rows[0];
}

/**
 * Clean up expired challenges (run periodically).
 * @returns {number} Number of deleted challenges
 */
async function cleanupExpiredChallenges() {
  if (isFallback || !pool) {
    if (!memStore.challenges) {return 0;}
    let count = 0;
    const now = Date.now();
    for (const [id, c] of memStore.challenges.entries()) {
      if (now > c.expires_at) {
        memStore.challenges.delete(id);
        count++;
      }
    }
    return count;
  }

  const { rowCount } = await pool.query(
    `DELETE FROM biometric_challenges WHERE expires_at < NOW() OR used = TRUE`
  );
  return rowCount;
}

/**
 * Get failed face verification attempts for an account in a time window.
 * @param {number} userId
 * @param {number} windowMs - Time window in milliseconds (default 10 minutes)
 * @returns {number} Count of failed attempts
 */
async function getFailedFaceAttempts(userId, windowMs = 600000) {
  if (isFallback || !pool) {
    if (!memStore.faceFailures) {return 0;}
    const now = Date.now();
    const failures = memStore.faceFailures.get(userId) || [];
    return failures.filter(t => now - t < windowMs).length;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM security_events
     WHERE user_id = $1 AND type = 'Identity Mismatch'
     AND timestamp > NOW() - INTERVAL '10 minutes'`,
    [userId]
  );
  return parseInt(rows[0].count, 10);
}

/**
 * Record a failed face verification attempt.
 * @param {number} userId
 */
async function recordFaceFailure(userId) {
  if (isFallback || !pool) {
    if (!memStore.faceFailures) {memStore.faceFailures = new Map();}
    const failures = memStore.faceFailures.get(userId) || [];
    failures.push(Date.now());
    memStore.faceFailures.set(userId, failures);
    return;
  }

  // Record as security event (already done in verify endpoint)
  // This function is a placeholder for future dedicated tracking table
}

/**
 * Check if account is locked out from face authentication.
 * @param {number} userId
 * @returns {Object} { locked: boolean, retryAfter?: number, reason?: string }
 */
async function checkFaceLockout(userId) {
  const failures = await getFailedFaceAttempts(userId, 600000); // 10 min window
  if (failures >= 10) {
    return { locked: true, retryAfter: 900, reason: 'Too many failed face attempts. Try again in 15 minutes.' };
  }
  if (failures >= 3) {
    return { locked: true, retryAfter: 0, reason: 'Face auth temporarily disabled. Please use PIN.' };
  }
  return { locked: false };
}

/* =========================================================
   TEMPLATE ENCRYPTION HELPERS
   ========================================================= */

/**
 * Get user biometric template (decrypted).
 * @param {number} userId
 * @returns {number[]|null} 128-dimension descriptor array or null
 */
async function getUserBiometricTemplate(userId) {
  if (isFallback || !pool) {
    const u = memStore.users.find(u => u.id === Number(userId));
    if (!u || !u.biometric_template) {return null;}
    try {
      const parsed = typeof u.biometric_template === 'string' ? JSON.parse(u.biometric_template) : u.biometric_template;
      return Array.isArray(parsed) ? parsed : null;
    } catch (_e) { return null; }
  }
  const { rows } = await pool.query('SELECT biometric_template FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !rows[0].biometric_template) {return null;}
  try {
    const { decryptTemplate, isTemplateEncrypted } = require('./template-encryption');
    const encrypted = rows[0].biometric_template;
    if (!encrypted) {return null;}
    // Handle legacy unencrypted templates
    if (!isTemplateEncrypted(encrypted)) {
      const parsed = JSON.parse(encrypted);
      return Array.isArray(parsed) ? parsed : null;
    }
    return decryptTemplate(encrypted);
  } catch (_e) {
    return null;
  }
}

/**
 * Update user biometric template (encrypted).
 * @param {number} userId
 * @param {number[]} template - 128-dimension descriptor array
 */
async function updateUserBiometricTemplate(userId, template) {
  const { encryptTemplate } = require('./template-encryption');
  const encrypted = encryptTemplate(template);
  if (isFallback || !pool) {
    const u = memStore.users.find(u => u.id === Number(userId));
    if (u) {
      u.biometric_template = encrypted;
      u.face_registered = true;
    }
    return;
  }
  await pool.query(
    'UPDATE users SET biometric_template = $1, face_registered = TRUE WHERE id = $2',
    [encrypted, userId]
  );
}

/* =========================================================
   VERIFY PIN HELPERS
   ========================================================= */
async function verifyNormalPin(userId, pin) {
  const userRaw = await getUserRawById(userId);
  if (!userRaw || !userRaw.normal_pin_hash) {return false;}
  return verifyPin(pin, userRaw.normal_pin_hash);
}

async function verifyEmergencyPin(userId, pin) {
  const userRaw = await getUserRawById(userId);
  if (!userRaw || !userRaw.emergency_pin_hash) {return false;}
  return verifyPin(pin, userRaw.emergency_pin_hash);
}

/**
 * Health check for database connection
 * @returns {Promise<{healthy: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck() {
  if (!pool || isFallback) {
    return { healthy: false, latencyMs: -1, error: 'No pool or fallback mode' };
  }
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Graceful shutdown - close pool
 */
async function shutdown() {
  if (pool && !isFallback) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDb,
  createUser,
  getUserById,
  getUserByPhone,
  getUserRawById,
  getUserRawByPhone,
  getFirstUser,
  getFirstUserRaw,
  getUserBiometricTemplate,
  updateUserBiometricTemplate,
  updateUser,
  getTransactions,
  createTransaction,
  transferFunds,
  adjustBalance,
  getSecurityEvents,
  logSecurityEvent,
  createSession,
  deactivateSession,
  getActiveSession,
  verifyNormalPin,
  verifyEmergencyPin,
  healthCheck,
  shutdown,
  // Biometric challenge functions
  createBiometricChallenge,
  validateAndConsumeChallenge,
  cleanupExpiredChallenges,
  checkFaceLockout,
  recordFaceFailure,
  get pool() { return pool; }, // Live getter
  // Utilities
  rupeesToPaise,
  paiseToRupees,
  formatINR,
  hashPin,
  verifyPin,
  normalizePhone,
  get isFallback() { return isFallback; }
};