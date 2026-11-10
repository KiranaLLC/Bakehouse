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

-- Emails sent by the site (README, "Emails"). Added later than the tables
-- above; running this file again adds them without touching existing data.

-- People who signed up for drop emails but haven't tapped the confirm link yet.
CREATE TABLE IF NOT EXISTS pending_subscribers (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,                    -- lowercase
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- The secret in each subscriber's unsubscribe link.
CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  email TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE
);

-- What's been sent, so nothing goes out twice: "announce:<drop id>",
-- "remind:<drop id>", "order:<order id>", "alert:<session id>".
CREATE TABLE IF NOT EXISTS email_log (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0
);

-- Per-drop choices. announce = 0: don't email the notify list when this drop
-- opens (the orders page's button can still send it).
CREATE TABLE IF NOT EXISTS drop_settings (
  drop_id INTEGER PRIMARY KEY,
  announce INTEGER NOT NULL DEFAULT 1
);
