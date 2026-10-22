-- =========================================================
--  iCash Banking — Supabase Schema
--  Paste this into Supabase SQL Editor and click "Run"
-- =========================================================

-- Enable Row Level Security
ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sessions ENABLE ROW LEVEL SECURITY;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id                          SERIAL PRIMARY KEY,
  name                        TEXT NOT NULL,
  phone                       TEXT NOT NULL UNIQUE,
  aadhaar_last4               TEXT, -- Only store last 4 digits of Aadhaar
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
  balance_paise               BIGINT DEFAULT 4875000 CHECK (balance_paise >= 0),
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions table
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
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Unique index on (user_id, idempotency_key) - allows same idempotency key for different users
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_user_idempotency 
  ON transactions(user_id, idempotency_key) 
  WHERE idempotency_key IS NOT NULL;

-- Security events table
CREATE TABLE IF NOT EXISTS security_events (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  description TEXT NOT NULL,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method     TEXT,
  active     BOOLEAN DEFAULT TRUE,
  duress     BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user_id ON security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id_active ON sessions(user_id, active);

-- Row Level Security Policies
-- Users can only see their own data
CREATE POLICY "users_own_data" ON users FOR ALL USING (id = current_setting('app.current_user_id', true)::int);

-- Transactions: users can only see their own
CREATE POLICY "transactions_own_data" ON transactions FOR ALL USING (user_id = current_setting('app.current_user_id', true)::int);

-- Security events: users can only see their own
CREATE POLICY "security_events_own_data" ON security_events FOR ALL USING (user_id = current_setting('app.current_user_id', true)::int);

-- Sessions: users can only see their own
CREATE POLICY "sessions_own_data" ON sessions FOR ALL USING (user_id = current_setting('app.current_user_id', true)::int);