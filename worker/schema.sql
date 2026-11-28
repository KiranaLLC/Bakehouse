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

-- Phone numbers and text preferences (e.g. imported from Hotplate), kept for
-- when the site can send texts. Nothing reads this yet.
CREATE TABLE IF NOT EXISTS contacts (
  phone TEXT PRIMARY KEY,                 -- +1XXXXXXXXXX
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  sms_promotions INTEGER NOT NULL DEFAULT 0,  -- 1 = said yes to promotional texts
  source TEXT NOT NULL DEFAULT '',        -- e.g. "hotplate"
  created_at TEXT NOT NULL
);

-- Paid orders (or some of their loaves) moved to another day from the orders
-- page. The order stays as it is in Stripe; each row here takes `items` off it
-- and puts them on delivery_date (delivery) or drop_id (pickup). Capacity,
-- prep and the orders page all read these. Customer details are copied in so
-- a moved part can be shown and emailed on its own.
CREATE TABLE IF NOT EXISTS order_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,                 -- cs_... (website order) or in_... (invoice)
  items TEXT NOT NULL,                    -- JSON: {"House White":1}
  delivery_date TEXT NOT NULL DEFAULT '', -- YYYY-MM-DD, for a delivery
  drop_id INTEGER,                        -- for a pickup at a drop
  fulfillment TEXT NOT NULL DEFAULT '',   -- "pickup" or "delivery" ('' = pickup if drop_id is set)
  from_date TEXT NOT NULL DEFAULT '',     -- the day it was on before
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  delivered_items TEXT NOT NULL DEFAULT '',
  delivered_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS order_moves_order ON order_moves (order_id);

-- Gift cards: bought on the order page (on their own or with loaves) or
-- issued from the orders page. balance_cents goes down when a code is used at checkout; while the
-- customer is still paying, that amount is held in gift_card_uses and given
-- back if they don't finish.
CREATE TABLE IF NOT EXISTS gift_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,              -- e.g. KIRANA-7QKM-X2PD
  initial_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'purchase',-- 'purchase' or 'issued'
  stripe_session_id TEXT,                 -- the order it was bought in, if bought
  purchase_key TEXT UNIQUE,               -- <session>:<line>:<n>, so each bought card is made once
  from_name TEXT NOT NULL DEFAULT '',
  purchaser_email TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL DEFAULT '',
  recipient_email TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',          -- the bakery's own note (issued cards)
  emailed_at TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT '',  -- cancelled on the orders page: can't be used
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_card_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_card_id INTEGER NOT NULL REFERENCES gift_cards (id),
  session_id TEXT NOT NULL DEFAULT '',    -- the order's Stripe Checkout Session
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',    -- 'held' (paying), 'used' or 'released'
  created_at TEXT NOT NULL
);

-- Gift cards in an order that's being paid for: made into gift_cards (and
-- emailed) once the payment goes through.
CREATE TABLE IF NOT EXISTS gift_card_orders (
  session_id TEXT PRIMARY KEY,            -- the order's Stripe Checkout Session
  lines TEXT NOT NULL,                    -- JSON: [{ amountCents, quantity, recipientName, recipientEmail, message, fromName }]
  buyer_emailed_at TEXT NOT NULL DEFAULT '',
  fulfilled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gift_card_uses_card ON gift_card_uses (gift_card_id);
CREATE INDEX IF NOT EXISTS gift_card_uses_session ON gift_card_uses (session_id);
