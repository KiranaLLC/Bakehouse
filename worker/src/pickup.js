/*
==================================================
PICKUP DAYS

A pickup day is one scheduled pickup: a date, an
address, a pickup window, a total number of
loaves and an order cutoff. Most come from the
weekly schedule in macros.js (PICKUP.schedule);
the admin page can change a single date or add
a one-off pickup. Changed dates and all orders
live in the D1 database (see schema.sql).

A scheduled date that nobody has changed or
ordered from yet has no database row; it gets
one ("materialized") on the first order or edit.

While a customer pays on Stripe their loaves are
held (a "pending" order). Stripe collects their
name and email at checkout; we ask for nothing else. The hold
is released if the payment doesn't complete
within PICKUP.holdMinutes.
==================================================
*/

import { PICKUP, PRODUCTS } from "../../macros.js";
import { calculateDiscount, calculateSubtotal } from "../../delivery-rules.js";
import {
  formatMoment,
  describePickupWindow,
  formatPickupDate,
  formatPickupWhen,
  getPickupDayStatus,
  getScheduledPickupDays,
  localToUtc,
  utcToLocal
} from "../../pickup-rules.js";
import { CONTACT_EMAIL, createDiscountCoupon, stripe, verifyWebhookSignature } from "./stripe.js";
import { OrderValidationError, cleanText, findDiscount, parseItems, parseTip } from "./validate.js";

const HOLD_GRACE_MINUTES = 2;

function db(env) {
  if (!env.DB) {
    throw Object.assign(new Error("D1 database is not bound"), { publicMessage: `Pickup ordering isn't set up yet. Please email us at ${CONTACT_EMAIL} to place your order.` });
  }
  return env.DB;
}

/*
==================================================
PICKUP DAYS
==================================================
*/

function rowToDay(row) {
  return {
    id: row.id,
    ruleKey: row.rule_key || null,
    name: row.name,
    address: row.address,
    notes: row.notes || "",
    pickupDate: row.pickup_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    totalLoaves: row.total_loaves,
    closesAt: row.closes_at
  };
}

async function getDay(env, id) {
  const row = await db(env).prepare("SELECT * FROM pickup_days WHERE id = ?").bind(id).first();
  return row ? rowToDay(row) : null;
}

/*
  Scheduled days that have no database row yet are
  identified as "<ruleKey>:<date>", e.g. "verve:2026-10-24".
*/
const VIRTUAL_ID = /^([a-z0-9_-]+):(\d{4}-\d{2}-\d{2})$/;

function virtualId(day) {
  return `${day.ruleKey}:${day.pickupDate}`;
}

// Every pickup day the admin page could show: database rows plus
// scheduled dates that have no row yet.
async function getAllDays(env, now) {

  const { results } = await db(env).prepare("SELECT * FROM pickup_days").all();
  const rows = results.map(rowToDay);
  const known = new Set(rows.filter(day => day.ruleKey).map(virtualId));

  const scheduled = getScheduledPickupDays(now)
    .filter(day => !known.has(virtualId(day)))
    .map(day => ({ ...day, id: virtualId(day) }));

  return [...rows, ...scheduled].sort((a, b) => a.pickupDate.localeCompare(b.pickupDate) || a.windowStart.localeCompare(b.windowStart));

}

// Finds a day by database id or by "<ruleKey>:<date>".
async function resolveDay(env, pickupDayId, now) {

  if (Number.isInteger(pickupDayId)) return getDay(env, pickupDayId);

  if (typeof pickupDayId !== "string" || !VIRTUAL_ID.test(pickupDayId)) return null;

  const [, ruleKey, pickupDate] = pickupDayId.match(VIRTUAL_ID);
  const row = await db(env).prepare("SELECT * FROM pickup_days WHERE rule_key = ? AND pickup_date = ?").bind(ruleKey, pickupDate).first();
  if (row) return rowToDay(row);

  const scheduled = getScheduledPickupDays(now).find(day => day.ruleKey === ruleKey && day.pickupDate === pickupDate);
  return scheduled ? { ...scheduled, id: virtualId(scheduled) } : null;

}

// Gives a scheduled day its database row (keeping it if one appeared meanwhile).
async function materialize(env, day) {

  if (Number.isInteger(day.id)) return day;

  await db(env)
    .prepare("INSERT OR IGNORE INTO pickup_days (name, address, notes, pickup_date, window_start, window_end, total_loaves, closes_at, rule_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(day.name, day.address, day.notes, day.pickupDate, day.windowStart, day.windowEnd, day.totalLoaves, day.closesAt, day.ruleKey, new Date().toISOString())
    .run();

  const row = await db(env).prepare("SELECT * FROM pickup_days WHERE rule_key = ? AND pickup_date = ?").bind(day.ruleKey, day.pickupDate).first();
  return rowToDay(row);

}

// Loaves taken by paid orders and by holds that haven't expired.
async function getAvailability(env, dayId, now) {

  if (!Number.isInteger(dayId)) return { loavesTaken: 0 };

  const loavesTaken = await db(env)
    .prepare("SELECT COALESCE(SUM(loaves), 0) AS loaves FROM pickup_orders WHERE pickup_day_id = ? AND (status = 'paid' OR (status = 'pending' AND expires_at > ?))")
    .bind(dayId, now.toISOString())
    .first("loaves");

  return { loavesTaken: loavesTaken || 0 };

}

function describeDay(day, availability, now) {

  const remaining = Math.max(0, day.totalLoaves - availability.loavesTaken);
  let status = getPickupDayStatus(day, now);
  if (status === "open" && remaining === 0) status = "sold_out";

  return {
    id: day.id,
    name: day.name,
    address: day.address,
    notes: day.notes,
    pickupDate: day.pickupDate,
    pickupDateLabel: formatPickupDate(day.pickupDate),
    windowStart: day.windowStart,
    windowEnd: day.windowEnd,
    windowLabel: describePickupWindow(day),
    whenLabel: formatPickupWhen(day),
    totalLoaves: day.totalLoaves,
    remaining,
    // Customers only see "sold out" and a "fewer than N left" hint, never the count.
    fewLeft: remaining > 0 && remaining <= PICKUP.fewLeftThreshold,
    closesAt: day.closesAt,
    closesAtLabel: formatMoment(day.closesAt),
    status
  };

}

// The pickup days customers can see: the next few still taking orders (and not skipped).
export async function listPickupDays(env) {

  const now = new Date();
  const days = [];

  for (const day of await getAllDays(env, now)) {
    if (day.totalLoaves === 0 || getPickupDayStatus(day, now) === "closed") continue;
    days.push(describeDay(day, await getAvailability(env, day.id, now), now));
    if (days.length >= PICKUP.maxDaysShown) break;
  }

  return { days };

}

/*
==================================================
CREATE STRIPE CHECKOUT SESSION FOR A PICKUP
==================================================
*/

export async function createPickupCheckoutSession(body, env, siteUrl) {

  const items = parseItems(body.items);
  const tipCents = parseTip(body.tipCents);
  const discount = body.discountCode ? findDiscount(body.discountCode, env) : null;
  const now = new Date();

  let day = await resolveDay(env, body.pickupDayId, now);

  if (!day || day.totalLoaves === 0) {
    throw new OrderValidationError("That pickup day is no longer available. Please refresh the page.");
  }

  if (getPickupDayStatus(day, now) === "closed") {
    throw new OrderValidationError("Ordering for this pickup has closed.");
  }

  /*
  ==========================================
  LOAVES AVAILABLE
  ==========================================
  */

  const loaves = items.reduce((total, item) => total + item.quantity, 0);
  const availability = await getAvailability(env, day.id, now);
  const remaining = day.totalLoaves - availability.loavesTaken;

  if (loaves > remaining) {
    throw new OrderValidationError(remaining <= 0
      ? "Sorry, this pickup has just sold out."
      : `Only ${remaining} ${remaining === 1 ? "loaf is" : "loaves are"} left for this pickup — please reduce your order.`);
  }

  /*
  ==========================================
  HOLD THE LOAVES
  ==========================================
  */

  day = await materialize(env, day);

  const reservationId = crypto.randomUUID();
  const holdSeconds = PICKUP.holdMinutes * 60;
  const expiresAt = new Date(now.getTime() + (PICKUP.holdMinutes + HOLD_GRACE_MINUTES) * 60 * 1000).toISOString();

  await db(env)
    .prepare("INSERT INTO pickup_orders (id, pickup_day_id, status, loaves, items, tip_cents, discount_code, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)")
    .bind(reservationId, day.id, loaves, JSON.stringify(items), tipCents, discount?.code || null, now.toISOString(), expiresAt)
    .run();

  try {

    /*
    ==========================================
    STRIPE CHECKOUT
    ==========================================
    */

    const subtotal = calculateSubtotal(items);
    const discountCents = discount ? calculateDiscount(discount.percent, subtotal, 0) : 0;
    const whenLabel = formatPickupWhen(day);

    const lineItems = items.map(({ productId, quantity }) => ({
      price_data: { currency: "usd", product_data: { name: PRODUCTS[productId].name }, unit_amount: PRODUCTS[productId].price },
      quantity
    }));

    if (tipCents > 0) {
      lineItems.push({ price_data: { currency: "usd", product_data: { name: "Tip for your baker" }, unit_amount: tipCents }, quantity: 1 });
    }

    const metadata = {
      order_type: "pickup",
      reservation_id: reservationId,
      pickup_day_id: String(day.id),
      pickup_day_name: day.name,
      pickup_date: day.pickupDate,
      pickup_when_label: whenLabel,
      pickup_address: day.address,
      tip_cents: String(tipCents),
      discount_code: discount?.code || "",
      discount_cents: String(discountCents)
    };

    const session = await stripe(env, "POST", "/checkout/sessions", {
      mode: "payment",
      line_items: lineItems,
      discounts: discountCents > 0 ? await createDiscountCoupon(env, discount, discountCents) : undefined,
      customer_creation: "always",
      expires_at: Math.floor(now.getTime() / 1000) + holdSeconds,
      payment_intent_data: {
        description: `Kirana Bakehouse pickup — ${whenLabel}`,
        metadata
      },
      metadata,
      custom_text: {
        submit: {
          message: `Pick up at ${day.address} on ${whenLabel}. Your loaves are held for ${PICKUP.holdMinutes} minutes while you pay.`
        }
      },
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/order.html?cancelled=true`
    });

    await db(env).prepare("UPDATE pickup_orders SET session_id = ? WHERE id = ?").bind(session.id, reservationId).run();

    return { url: session.url };

  } catch (error) {

    // Release the hold if Stripe couldn't start the payment.
    await db(env).prepare("DELETE FROM pickup_orders WHERE id = ? AND status = 'pending'").bind(reservationId).run();
    throw error;

  }

}

/*
==================================================
PAYMENT RESULTS

Stripe tells the worker the result through a
webhook. As a safety net, the thank-you page
also confirms the order when the customer
returns to the site.
==================================================
*/

export async function handleStripeWebhook(request, env) {

  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET is not set"), { publicMessage: "Webhook secret not set." });
  }

  const payload = await request.text();

  if (!await verifyWebhookSignature(payload, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET)) {
    throw new OrderValidationError("Invalid signature.");
  }

  const event = JSON.parse(payload);
  const session = event.data?.object;

  if (event.type === "checkout.session.completed" && session?.payment_status === "paid") {
    await markPickupOrderPaid(env, session);
  }

  if (event.type === "checkout.session.expired" && session?.id) {
    await db(env).prepare("UPDATE pickup_orders SET status = 'cancelled' WHERE session_id = ? AND status = 'pending'").bind(session.id).run();
  }

  return { received: true };

}

export async function markPickupOrderPaid(env, session) {

  if (session.metadata?.order_type !== "pickup" || !env.DB) return;

  await db(env)
    .prepare("UPDATE pickup_orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), session_id = COALESCE(session_id, ?), customer_name = ?, customer_phone = ?, customer_email = ?, amount_total = ? WHERE (id = ? OR session_id = ?) AND status != 'paid'")
    .bind(new Date().toISOString(), session.id, session.customer_details?.name || "", session.customer_details?.phone || null, session.customer_details?.email || null, session.amount_total ?? null, session.metadata.reservation_id || "", session.id)
    .run();

}

// Extra fields for the thank-you page.
export function pickupSummary(session) {
  const metadata = session.metadata || {};
  return {
    type: "pickup",
    pickupDayName: metadata.pickup_day_name,
    pickupDate: metadata.pickup_date,
    pickupWhen: metadata.pickup_when_label,
    pickupAddress: metadata.pickup_address
  };
}

/*
==================================================
ADMIN
==================================================
*/

function adminDay(day, availability, stats, now) {
  return {
    ...describeDay(day, availability, now),
    ruleKey: day.ruleKey,
    scheduled: !Number.isInteger(day.id),
    skipped: day.totalLoaves === 0,
    closesAtLocal: localInputValue(day.closesAt),
    loavesSold: stats.loavesSold || 0,
    ordersPaid: stats.ordersPaid || 0,
    loavesHeld: Math.max(0, availability.loavesTaken - (stats.loavesSold || 0))
  };
}

// "2026-10-26T06:59:00.000Z" → "2026-10-25T23:59" for a datetime-local input
function localInputValue(iso) {
  const { date, time } = utcToLocal(iso);
  return `${date}T${time}`;
}

export async function adminListPickupDays(env) {

  const now = new Date();
  const days = [];

  for (const day of await getAllDays(env, now)) {
    const stats = Number.isInteger(day.id)
      ? await db(env)
        .prepare("SELECT COALESCE(SUM(loaves), 0) AS loavesSold, COUNT(*) AS ordersPaid FROM pickup_orders WHERE pickup_day_id = ? AND status = 'paid'")
        .bind(day.id)
        .first()
      : {};
    days.push(adminDay(day, await getAvailability(env, day.id, now), stats, now));
  }

  return { days };

}

export async function adminSavePickupDay(body, env) {

  const name = cleanText(body.name, 80);
  const address = cleanText(body.address, 200);
  const notes = cleanText(body.notes, 300);
  const pickupDate = cleanText(body.pickupDate, 10);
  const windowStart = cleanText(body.windowStart, 5);
  const windowEnd = cleanText(body.windowEnd, 5);
  const totalLoaves = Number(body.totalLoaves);
  const closesAtLocal = cleanText(body.closesAtLocal, 16);

  const timePattern = /^\d{2}:\d{2}$/;

  if (!name) throw new OrderValidationError("Please give the pickup a name (e.g. the location).");
  if (!address) throw new OrderValidationError("Please enter the pickup address.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new OrderValidationError("Please choose the pickup date.");
  if (!timePattern.test(windowStart) || !timePattern.test(windowEnd) || windowStart >= windowEnd) throw new OrderValidationError("The pickup window must start before it ends.");
  if (!Number.isInteger(totalLoaves) || totalLoaves < 0 || totalLoaves > PICKUP.maxLoavesPerDay) throw new OrderValidationError(`Total loaves must be between 0 (skip this pickup) and ${PICKUP.maxLoavesPerDay}.`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(closesAtLocal)) throw new OrderValidationError("Please set when ordering closes.");

  const closesAt = localToUtc(closesAtLocal.slice(0, 10), closesAtLocal.slice(11));
  const pickupEnds = localToUtc(pickupDate, windowEnd);

  if (closesAt > pickupEnds) throw new OrderValidationError("Ordering must close before the pickup window ends.");

  // Editing a scheduled date gives it a database row first.
  let existing = await resolveDay(env, body.id, new Date());
  if (body.id !== undefined && body.id !== null && !existing) throw new OrderValidationError("That pickup day no longer exists.");
  if (existing && !Number.isInteger(existing.id)) existing = await materialize(env, existing);

  if (existing) {
    await db(env)
      .prepare("UPDATE pickup_days SET name = ?, address = ?, notes = ?, pickup_date = ?, window_start = ?, window_end = ?, total_loaves = ?, closes_at = ? WHERE id = ?")
      .bind(name, address, notes, pickupDate, windowStart, windowEnd, totalLoaves, closesAt, existing.id)
      .run();

    return { id: existing.id };
  }

  const result = await db(env)
    .prepare("INSERT INTO pickup_days (name, address, notes, pickup_date, window_start, window_end, total_loaves, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(name, address, notes, pickupDate, windowStart, windowEnd, totalLoaves, closesAt, new Date().toISOString())
    .run();

  return { id: result.meta.last_row_id };

}

export async function adminDeletePickupDay(id, env) {

  if (!Number.isInteger(id)) throw new OrderValidationError("Which pickup day?");

  const paid = await db(env).prepare("SELECT COUNT(*) AS count FROM pickup_orders WHERE pickup_day_id = ? AND status = 'paid'").bind(id).first("count");

  if (paid > 0) {
    throw new OrderValidationError("This pickup day has paid orders, so it can't be deleted. Set its total loaves to what's sold, or move its order cutoff to now, to stop further orders.");
  }

  await db(env).batch([
    db(env).prepare("DELETE FROM pickup_orders WHERE pickup_day_id = ?").bind(id),
    db(env).prepare("DELETE FROM pickup_days WHERE id = ?").bind(id)
  ]);

  return { deleted: true };

}

export async function adminListOrders(dayId, env) {

  const now = new Date();
  const day = await resolveDay(env, dayId, now);
  if (!day) throw new OrderValidationError("That pickup day doesn't exist.");

  if (!Number.isInteger(day.id)) {
    return { day: describeDay(day, { loavesTaken: 0 }, now), orders: [], loafTotals: {} };
  }

  const { results } = await db(env)
    .prepare("SELECT * FROM pickup_orders WHERE pickup_day_id = ? AND (status = 'paid' OR (status = 'pending' AND expires_at > ?)) ORDER BY paid_at, created_at")
    .bind(day.id, now.toISOString())
    .all();

  const loafTotals = {};

  const orders = results.map(row => {
    const items = JSON.parse(row.items).map(({ productId, quantity }) => {
      const name = PRODUCTS[productId]?.name || productId;
      if (row.status === "paid") loafTotals[name] = (loafTotals[name] || 0) + quantity;
      return { name, quantity };
    });

    return {
      id: row.id,
      status: row.status,
      loaves: row.loaves,
      items,
      name: row.customer_name,
      phone: row.customer_phone || "",
      email: row.customer_email || "",
      tipCents: row.tip_cents,
      discountCode: row.discount_code || "",
      amountTotal: row.amount_total,
      paidAt: row.paid_at
    };
  });

  return {
    day: describeDay(day, await getAvailability(env, day.id, now), now),
    orders,
    loafTotals
  };

}
