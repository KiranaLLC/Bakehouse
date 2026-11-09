-- Pickup drops and the "tell me when the next drop opens" list.
-- Create the database once, then apply this file (from the worker folder):
--   npx wrangler d1 create kirana-pickup
--   npx wrangler d1 execute kirana-pickup --remote --file=schema.sql
-- Safe to run again: it only creates what's missing.

CREATE TABLE IF NOT EXISTS drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_date TEXT NOT NULL,              -- YYYY-MM-DD, bakery time zone
  window_start TEXT NOT NULL,             -- HH:MM, 24-hour, bakery time zone
  window_end TEXT NOT NULL,
  location_name TEXT NOT NULL,
  location_address TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  opens_at TEXT NOT NULL,                 -- ISO UTC: ordering opens
  closes_at TEXT NOT NULL,                -- ISO UTC: ordering closes
  loaf_limit INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS drops_pickup_date ON drops (pickup_date);

CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY,                 -- lowercase
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
