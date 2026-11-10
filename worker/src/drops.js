/*
==================================================
PICKUP DROPS (storage)

Drops and the notify list live in a Cloudflare
D1 database (binding "DB", schema in schema.sql).
Loaves booked for a drop are counted from Stripe
Checkout Sessions, the same way as delivery:
paid orders, plus customers on the payment page
right now.

Everything here copes with no database yet:
pickup simply shows no drops, and delivery keeps
working.
==================================================
*/

import { CHECKOUT_HOLD_SECONDS, listCapacityInvoices, loavesFromMetadata } from "./capacity.js";
import { listSessionsSince } from "./stripe-cache.js";
import { localToUtc, utcToLocal } from "../../pickup-rules.js";

export class DropError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hasDatabase(env) {
  return Boolean(env.DB);
}

// "2026-11-09T02:00:00.000Z" → "2026-11-08T18:00" (bakery time)
function toLocalInput(iso) {
  const { date, time } = utcToLocal(iso);
  return `${date}T${time}`;
}

// "2026-11-08T18:00" (bakery time) → ISO UTC, or "" if it isn't one.
function fromLocalInput(value) {
  const match = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? localToUtc(match[1], `${match[2]}:${match[3]}`) : "";
}

function toDrop(row) {
  return {
    id: row.id,
    pickupDate: row.pickup_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    locationName: row.location_name,
    locationAddress: row.location_address,
    notes: row.notes || "",
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    loafLimit: row.loaf_limit,
    cancelled: Boolean(row.cancelled),
    createdAt: row.created_at,
    // The same moments in the bakery's time zone, for the orders page's form.
    opensLocal: toLocalInput(row.opens_at),
    closesLocal: toLocalInput(row.closes_at)
  };
}

/*
==================================================
READING DROPS
==================================================
*/

// Drops whose pickup date is on or after `fromDate` ("YYYY-MM-DD"), soonest first.
export async function listDrops(env, { fromDate, includeCancelled = false } = {}) {
  if (!hasDatabase(env)) return [];
  const { results } = await env.DB
    .prepare(`SELECT * FROM drops WHERE pickup_date >= ?1 ${includeCancelled ? "" : "AND cancelled = 0"} ORDER BY pickup_date, window_start, id`)
    .bind(fromDate || "0000-00-00")
    .all();
  return results.map(toDrop);
}

export async function getDrop(env, id) {
  if (!hasDatabase(env) || !Number.isInteger(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM drops WHERE id = ?1").bind(id).first();
  return row ? toDrop(row) : null;
}

/*
==================================================
WRITING DROPS (orders page only)
==================================================
*/

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

// Checks a drop sent from the orders page; throws DropError with a readable message.
export function parseDropInput(input) {

  const drop = {
    pickupDate: cleanText(input?.pickupDate, 10),
    windowStart: cleanText(input?.windowStart, 5),
    windowEnd: cleanText(input?.windowEnd, 5),
    locationName: cleanText(input?.locationName, 100),
    locationAddress: cleanText(input?.locationAddress, 200),
    notes: cleanText(input?.notes, 300),
    // The orders page sends bakery-time "opensLocal"; an exact "opensAt" also works.
    opensAt: input?.opensLocal ? fromLocalInput(input.opensLocal) : cleanText(input?.opensAt, 30),
    closesAt: input?.closesLocal ? fromLocalInput(input.closesLocal) : cleanText(input?.closesAt, 30),
    loafLimit: Number(input?.loafLimit)
  };

  if (!DATE.test(drop.pickupDate)) throw new DropError("Please choose a pickup date.");
  if (!TIME.test(drop.windowStart) || !TIME.test(drop.windowEnd)) throw new DropError("Please enter the pickup window's start and end times.");
  if (drop.windowEnd <= drop.windowStart) throw new DropError("The pickup window must end after it starts.");
  if (!drop.locationName || !drop.locationAddress) throw new DropError("Please enter the pickup location's name and address.");
  if (Number.isNaN(Date.parse(drop.opensAt)) || Number.isNaN(Date.parse(drop.closesAt))) throw new DropError("Please enter when ordering opens and closes.");
  if (Date.parse(drop.closesAt) <= Date.parse(drop.opensAt)) throw new DropError("Ordering must close after it opens.");
  if (!Number.isInteger(drop.loafLimit) || drop.loafLimit < 1 || drop.loafLimit > 500) throw new DropError("The loaf limit must be a whole number from 1 to 500.");

  drop.opensAt = new Date(drop.opensAt).toISOString();
  drop.closesAt = new Date(drop.closesAt).toISOString();
  return drop;

}

export async function createDrop(env, input) {
  const drop = parseDropInput(input);
  const row = await env.DB.prepare(`
    INSERT INTO drops (pickup_date, window_start, window_end, location_name, location_address, notes, opens_at, closes_at, loaf_limit, cancelled, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)
    RETURNING *`)
    .bind(drop.pickupDate, drop.windowStart, drop.windowEnd, drop.locationName, drop.locationAddress, drop.notes, drop.opensAt, drop.closesAt, drop.loafLimit, new Date().toISOString())
    .first();
  return toDrop(row);
}

export async function updateDrop(env, id, input) {
  const drop = parseDropInput(input);
  const row = await env.DB.prepare(`
    UPDATE drops SET pickup_date = ?2, window_start = ?3, window_end = ?4, location_name = ?5, location_address = ?6,
      notes = ?7, opens_at = ?8, closes_at = ?9, loaf_limit = ?10
    WHERE id = ?1
    RETURNING *`)
    .bind(id, drop.pickupDate, drop.windowStart, drop.windowEnd, drop.locationName, drop.locationAddress, drop.notes, drop.opensAt, drop.closesAt, drop.loafLimit)
    .first();
  if (!row) throw new DropError("That drop doesn't exist.");
  return toDrop(row);
}

export async function setDropCancelled(env, id, cancelled) {
  const row = await env.DB.prepare("UPDATE drops SET cancelled = ?2 WHERE id = ?1 RETURNING *").bind(id, cancelled ? 1 : 0).first();
  if (!row) throw new DropError("That drop doesn't exist.");
  return toDrop(row);
}

/*
==================================================
NOTIFY LIST
==================================================
*/

export async function addSubscriber(env, input) {
  const email = cleanText(input?.email, 200).toLowerCase();
  const name = cleanText(input?.name, 100);
  if (!EMAIL.test(email)) throw new DropError("Please enter a valid email address.");
  await env.DB.prepare(`
    INSERT INTO subscribers (email, name, created_at) VALUES (?1, ?2, ?3)
    ON CONFLICT (email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE subscribers.name END`)
    .bind(email, name, new Date().toISOString())
    .run();
  return { ok: true };
}

export async function listSubscribers(env) {
  if (!hasDatabase(env)) return [];
  const { results } = await env.DB.prepare("SELECT email, name, created_at FROM subscribers ORDER BY created_at DESC").all();
  return results.map(row => ({ email: row.email, name: row.name, createdAt: row.created_at }));
}

export async function removeSubscriber(env, email) {
  await env.DB.prepare("DELETE FROM subscribers WHERE email = ?1").bind(cleanText(email, 200).toLowerCase()).run();
  return { ok: true };
}

/*
==================================================
EMAIL SIGN-UPS AND THE EMAIL LOG

With email turned on, signing up is two steps: the
person is "pending" until they tap the link in the
confirm email. Everyone confirmed gets their own
unsubscribe link. The email log remembers what has
been sent, so nothing goes out twice.
==================================================
*/

export async function addPendingSubscriber(env, input) {
  const email = cleanText(input?.email, 200).toLowerCase();
  const name = cleanText(input?.name, 100);
  if (!EMAIL.test(email)) throw new DropError("Please enter a valid email address.");
  const existing = await env.DB.prepare("SELECT email FROM subscribers WHERE email = ?1").bind(email).first();
  if (existing) return { email, alreadySubscribed: true };
  const token = crypto.randomUUID();
  await env.DB.prepare("DELETE FROM pending_subscribers WHERE email = ?1 OR created_at < ?2")
    .bind(email, new Date(Date.now() - 14 * 864e5).toISOString()).run();
  await env.DB.prepare("INSERT INTO pending_subscribers (token, email, name, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(token, email, name, new Date().toISOString()).run();
  return { email, token };
}

// The confirm link: moves the person onto the list. Returns their email, or null.
export async function confirmSubscriber(env, token) {
  if (!isToken(token)) return null;
  const pending = await env.DB.prepare("SELECT email, name FROM pending_subscribers WHERE token = ?1").bind(token).first();
  if (!pending) return null;
  await addSubscriber(env, pending);
  await env.DB.prepare("DELETE FROM pending_subscribers WHERE email = ?1").bind(pending.email).run();
  return pending.email;
}

// Each subscriber's unsubscribe link secret, made the first time it's needed.
export async function unsubscribeToken(env, email) {
  const row = await env.DB.prepare("SELECT token FROM unsubscribe_tokens WHERE email = ?1").bind(email).first();
  if (row) return row.token;
  const token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO unsubscribe_tokens (email, token) VALUES (?1, ?2) ON CONFLICT (email) DO NOTHING").bind(email, token).run();
  return (await env.DB.prepare("SELECT token FROM unsubscribe_tokens WHERE email = ?1").bind(email).first()).token;
}

// The unsubscribe link: takes the person off the list. Returns their email, or null.
export async function unsubscribeByToken(env, token) {
  if (!isToken(token)) return null;
  const row = await env.DB.prepare("SELECT email FROM unsubscribe_tokens WHERE token = ?1").bind(token).first();
  if (!row) return null;
  await removeSubscriber(env, row.email);
  return row.email;
}

function isToken(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}

// key → { sentAt, recipients } for the keys that have been sent.
export async function getEmailLog(env, keys) {
  const log = new Map();
  if (!hasDatabase(env) || !keys.length) return log;
  try {
    const { results } = await env.DB.prepare(`SELECT key, sent_at, recipients FROM email_log WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...keys).all();
    for (const row of results) log.set(row.key, { sentAt: row.sent_at, recipients: row.recipients });
  } catch {
    // The email tables haven't been added yet (schema.sql not re-run): nothing logged.
  }
  return log;
}

// Claims a key before sending, so two runs can't both send it. Returns false if already taken.
export async function claimEmail(env, key) {
  const result = await env.DB.prepare("INSERT INTO email_log (key, sent_at, recipients) VALUES (?1, ?2, 0) ON CONFLICT (key) DO NOTHING")
    .bind(key, new Date().toISOString()).run();
  if (result?.meta && typeof result.meta.changes === "number") return result.meta.changes > 0;
  return true;
}

export async function logEmail(env, key, recipients) {
  await env.DB.prepare(`INSERT INTO email_log (key, sent_at, recipients) VALUES (?1, ?2, ?3)
    ON CONFLICT (key) DO UPDATE SET sent_at = excluded.sent_at, recipients = excluded.recipients`)
    .bind(key, new Date().toISOString(), recipients).run();
}

export async function forgetEmail(env, key) {
  await env.DB.prepare("DELETE FROM email_log WHERE key = ?1").bind(key).run();
}

/*
==================================================
LOAVES BOOKED PER DROP

From Stripe Checkout Sessions marked as pickup:
paid ones, and open ones (customers paying right
now). Looks back to just before the earliest of
the given drops opened.

ignoreSessionId is skipped whatever its state;
ignoreOpenSessionId only while it is unpaid.
==================================================
*/

export async function getDropBookings(env, stripe, drops, { ignoreSessionId, ignoreOpenSessionId, fresh = true } = {}) {

  const booked = new Map(drops.map(({ id }) => [String(id), 0]));

  for (const booking of await listDropBookings(env, stripe, drops, { fresh })) {
    if (booking.id === ignoreSessionId) continue;
    if (booking.id === ignoreOpenSessionId && booking.status === "open") continue;
    booked.set(booking.dropId, booked.get(booking.dropId) + booking.loaves);
  }

  return booked;

}

// Every booking on these drops, as { id, dropId, created, loaves, status, invoice? }.
export async function listDropBookings(env, stripe, drops, { fresh = true } = {}) {

  const wanted = new Set(drops.map(({ id }) => String(id)));
  const bookings = [];
  if (!drops.length) return bookings;

  const earliestOpen = Math.min(...drops.map(({ opensAt }) => Date.parse(opensAt)));
  const since = Math.floor(Math.min(earliestOpen, Date.now()) / 1000) - CHECKOUT_HOLD_SECONDS;

  for (const session of await listSessionsSince(env, stripe, since, { fresh })) {
    const dropId = session.metadata?.drop_id;
    if (session.metadata?.fulfillment !== "pickup" || !wanted.has(dropId)) continue;
    if (session.status !== "open" && session.status !== "complete") continue;
    bookings.push({ id: session.id, dropId, created: session.created, loaves: loavesFromMetadata(session) ?? 0, status: session.status });
  }

  // Invoices with metadata drop_id take loaves from that drop.
  for (const invoice of await listCapacityInvoices(env, stripe, { fresh })) {
    if (!wanted.has(invoice.dropId)) continue;
    bookings.push({ id: invoice.id, dropId: invoice.dropId, created: 0, loaves: invoice.loaves, status: "invoice", invoice: true });
  }

  return bookings;

}

// "user@example.com" check, shared with the subscribe endpoint.
export function isEmail(value) {
  return EMAIL.test(value);
}
