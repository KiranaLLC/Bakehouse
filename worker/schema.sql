-- Pickup drops and their orders. Apply with (from the worker folder):
--   npx wrangler d1 execute kirana-orders --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  pickup_date TEXT NOT NULL,            -- YYYY-MM-DD, bakery time zone
  window_start TEXT NOT NULL,           -- HH:MM (24-hour)
  window_end TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL,
  max_orders_per_slot INTEGER,          -- NULL = no limit
  total_loaves INTEGER NOT NULL,
  opens_at TEXT NOT NULL,               -- ISO UTC timestamp: when ordering opens
  closes_at TEXT NOT NULL,              -- ISO UTC timestamp: when ordering closes
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickup_orders (
  id TEXT PRIMARY KEY,                  -- reservation id
  drop_id INTEGER NOT NULL,
  session_id TEXT,                      -- Stripe Checkout Session
  status TEXT NOT NULL,                 -- pending | paid | cancelled
  slot TEXT NOT NULL,                   -- HH:MM
  loaves INTEGER NOT NULL,
  items TEXT NOT NULL,                  -- JSON [{ productId, quantity }]
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT,
  amount_total INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,             -- a pending hold is released after this
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS pickup_orders_drop ON pickup_orders (drop_id, status);
CREATE INDEX IF NOT EXISTS pickup_orders_session ON pickup_orders (session_id);
