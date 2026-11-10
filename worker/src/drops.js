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
