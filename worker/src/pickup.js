/*
==================================================
PICKUP DROPS

A drop is one pickup event: a date, an address,
a pickup window and a total number of loaves.
Drops and their orders live in the D1 database
(see schema.sql).

While a customer pays on Stripe their loaves and
time slot are held (a "pending" order). The hold
is released if the payment doesn't complete
within PICKUP.holdMinutes.
==================================================
*/

import { PICKUP, PRODUCTS } from "../../macros.js";
import { calculateDiscount, calculateSubtotal } from "../../delivery-rules.js";
import {
  formatMoment,
  formatPickupDate,
  formatPickupSlot,
  formatTime,
  getDropStatus,
  getPickupSlots,
  localToUtc,
  utcToLocal
} from "../../pickup-rules.js";
import { CONTACT_EMAIL, createDiscountCoupon, stripe, verifyWebhookSignature } from "./stripe.js";
import { OrderValidationError, cleanText, findDiscount, parseCustomer, parseItems, parseTip } from "./validate.js";

const HOLD_GRACE_MINUTES = 2;

function db(env) {
  if (!env.DB) {
    throw Object.assign(new Error("D1 database is not bound"), { publicMessage: `Pickup ordering isn't set up yet. Please email us at ${CONTACT_EMAIL} to place your order.` });
  }
  return env.DB;
}

/*
==================================================
DROPS
==================================================
*/

function rowToDrop(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    notes: row.notes || "",
    pickupDate: row.pickup_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    slotMinutes: row.slot_minutes,
    maxOrdersPerSlot: row.max_orders_per_slot,
    totalLoaves: row.total_loaves,
    opensAt: row.opens_at,
    closesAt: row.closes_at
  };
}

async function getDrop(env, id) {
  const row = await db(env).prepare("SELECT * FROM drops WHERE id = ?").bind(id).first();
  return row ? rowToDrop(row) : null;
}

// Loaves and slots taken by paid orders and by holds that haven't expired.
async function getAvailability(env, dropId, now) {

  const { results } = await db(env)
    .prepare("SELECT slot, loaves FROM pickup_orders WHERE drop_id = ? AND (status = 'paid' OR (status = 'pending' AND expires_at > ?))")
    .bind(dropId, now.toISOString())
    .all();

  const slotCounts = {};
  let loavesTaken = 0;

  for (const row of results) {
    loavesTaken += row.loaves;
    slotCounts[row.slot] = (slotCounts[row.slot] || 0) + 1;
  }

  return { loavesTaken, slotCounts };

}

function describeDrop(drop, availability, now) {

  const remaining = Math.max(0, drop.totalLoaves - availability.loavesTaken);
  let status = getDropStatus(drop, now);
  if (status === "open" && remaining === 0) status = "sold_out";

  return {
    id: drop.id,
    name: drop.name,
    address: drop.address,
    notes: drop.notes,
    pickupDate: drop.pickupDate,
    pickupDateLabel: formatPickupDate(drop.pickupDate),
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    windowLabel: `${formatTime(drop.windowStart)} – ${formatTime(drop.windowEnd)}`,
    slotMinutes: drop.slotMinutes,
    totalLoaves: drop.totalLoaves,
    remaining,
    opensAt: drop.opensAt,
    opensAtLabel: formatMoment(drop.opensAt),
    closesAt: drop.closesAt,
    closesAtLabel: formatMoment(drop.closesAt),
    status,
    slots: getPickupSlots(drop).map(slot => ({
      ...slot,
      available: !drop.maxOrdersPerSlot || (availability.slotCounts[slot.value] || 0) < drop.maxOrdersPerSlot
    }))
  };

}

// The drops customers can see: anything that hasn't closed yet.
export async function listDrops(env) {

  const now = new Date();
  const { results } = await db(env)
    .prepare("SELECT * FROM drops WHERE closes_at > ? ORDER BY pickup_date, window_start")
    .bind(now.toISOString())
    .all();

  const drops = [];

  for (const row of results) {
    const drop = rowToDrop(row);
    drops.push(describeDrop(drop, await getAvailability(env, drop.id, now), now));
  }

  return { drops };

}

/*
==================================================
CREATE STRIPE CHECKOUT SESSION FOR A PICKUP
==================================================
*/

export async function createPickupCheckoutSession(body, env, siteUrl) {

  const items = parseItems(body.items);
  const customer = parseCustomer(body.customer, "on pickup day");
  const tipCents = parseTip(body.tipCents);
  const discount = body.discountCode ? findDiscount(body.discountCode, env) : null;
  const slot = cleanText(body.slot, 5);
  const now = new Date();

  const drop = Number.isInteger(body.dropId) ? await getDrop(env, body.dropId) : null;

  if (!drop) {
    throw new OrderValidationError("That pickup is no longer available. Please refresh the page.");
  }

  const status = getDropStatus(drop, now);

  if (status === "upcoming") {
    throw new OrderValidationError(`Ordering for this pickup opens ${formatMoment(drop.opensAt)}.`);
  }

  if (status === "closed") {
    throw new OrderValidationError("Ordering for this pickup has closed.");
  }

  if (!getPickupSlots(drop).some(option => option.value === slot)) {
    throw new OrderValidationError("Please choose a pickup time.");
  }

  /*
  ==========================================
  LOAVES AND SLOT AVAILABILITY
  ==========================================
  */

  const loaves = items.reduce((total, item) => total + item.quantity, 0);
  const availability = await getAvailability(env, drop.id, now);
  const remaining = drop.totalLoaves - availability.loavesTaken;

  if (loaves > remaining) {
    throw new OrderValidationError(remaining <= 0
      ? "Sorry, this pickup has just sold out."
      : `Only ${remaining} ${remaining === 1 ? "loaf is" : "loaves are"} left for this pickup — please reduce your order.`);
  }

  if (drop.maxOrdersPerSlot && (availability.slotCounts[slot] || 0) >= drop.maxOrdersPerSlot) {
    throw new OrderValidationError("That pickup time has just filled up — please choose another.");
  }

  /*
  ==========================================
  HOLD THE LOAVES
  ==========================================
  */

  const reservationId = crypto.randomUUID();
  const holdSeconds = PICKUP.holdMinutes * 60;
  const expiresAt = new Date(now.getTime() + (PICKUP.holdMinutes + HOLD_GRACE_MINUTES) * 60 * 1000).toISOString();

  await db(env)
    .prepare("INSERT INTO pickup_orders (id, drop_id, status, slot, loaves, items, customer_name, customer_phone, tip_cents, discount_code, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(reservationId, drop.id, slot, loaves, JSON.stringify(items), customer.name, customer.phone, tipCents, discount?.code || null, now.toISOString(), expiresAt)
    .run();

  try {

    /*
    ==========================================
    STRIPE CHECKOUT
    ==========================================
    */

    const subtotal = calculateSubtotal(items);
    const discountCents = discount ? calculateDiscount(discount.percent, subtotal, 0) : 0;
    const slotLabel = formatPickupSlot(drop.pickupDate, slot);

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
      drop_id: String(drop.id),
      drop_name: drop.name,
      pickup_date: drop.pickupDate,
      pickup_slot: slot,
      pickup_slot_label: slotLabel,
      pickup_address: drop.address,
      customer_name: customer.name,
      customer_phone: customer.phone,
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
        description: `Kirana Bakehouse pickup — ${slotLabel}`,
        metadata
      },
      metadata,
      custom_text: {
        submit: {
          message: `Pick up at ${drop.address} on ${slotLabel}. Your loaves are held for ${PICKUP.holdMinutes} minutes while you pay.`
        }
      },
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/pickup.html?cancelled=true`
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
    .prepare("UPDATE pickup_orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), session_id = COALESCE(session_id, ?), customer_email = ?, amount_total = ? WHERE (id = ? OR session_id = ?) AND status != 'paid'")
    .bind(new Date().toISOString(), session.id, session.customer_details?.email || null, session.amount_total ?? null, session.metadata.reservation_id || "", session.id)
    .run();

}

// Extra fields for the thank-you page.
export function pickupSummary(session) {
  const metadata = session.metadata || {};
  return {
    type: "pickup",
    dropName: metadata.drop_name,
    pickupDate: metadata.pickup_date,
    pickupSlot: metadata.pickup_slot_label,
    pickupAddress: metadata.pickup_address
  };
}

/*
==================================================
ADMIN
==================================================
*/

function adminDrop(drop, availability, stats, now) {
  return {
    ...describeDrop(drop, availability, now),
    maxOrdersPerSlot: drop.maxOrdersPerSlot,
    opensAtLocal: localInputValue(drop.opensAt),
    closesAtLocal: localInputValue(drop.closesAt),
    loavesSold: stats.loavesSold || 0,
    ordersPaid: stats.ordersPaid || 0,
    loavesHeld: Math.max(0, availability.loavesTaken - (stats.loavesSold || 0))
  };
}

// "2026-10-26T01:00:00.000Z" → "2026-10-25T18:00" for a datetime-local input
function localInputValue(iso) {
  const { date, time } = utcToLocal(iso);
  return `${date}T${time}`;
}

export async function adminListDrops(env) {

  const now = new Date();
  const { results } = await db(env).prepare("SELECT * FROM drops ORDER BY pickup_date DESC, window_start DESC").all();
  const drops = [];

  for (const row of results) {
    const drop = rowToDrop(row);
    const stats = await db(env)
      .prepare("SELECT COALESCE(SUM(loaves), 0) AS loavesSold, COUNT(*) AS ordersPaid FROM pickup_orders WHERE drop_id = ? AND status = 'paid'")
      .bind(drop.id)
      .first();
    drops.push(adminDrop(drop, await getAvailability(env, drop.id, now), stats, now));
  }

  return { drops };

}

export async function adminSaveDrop(body, env) {

  const name = cleanText(body.name, 80);
  const address = cleanText(body.address, 200);
  const notes = cleanText(body.notes, 300);
  const pickupDate = cleanText(body.pickupDate, 10);
  const windowStart = cleanText(body.windowStart, 5);
  const windowEnd = cleanText(body.windowEnd, 5);
  const slotMinutes = Number(body.slotMinutes) || PICKUP.defaultSlotMinutes;
  const maxOrdersPerSlot = body.maxOrdersPerSlot ? Number(body.maxOrdersPerSlot) : null;
  const totalLoaves = Number(body.totalLoaves);
  const opensAtLocal = cleanText(body.opensAtLocal, 16);
  const closesAtLocal = cleanText(body.closesAtLocal, 16);

  const timePattern = /^\d{2}:\d{2}$/;
  const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

  if (!name) throw new OrderValidationError("Please give the drop a name.");
  if (!address) throw new OrderValidationError("Please enter the pickup address.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new OrderValidationError("Please choose the pickup date.");
  if (!timePattern.test(windowStart) || !timePattern.test(windowEnd) || windowStart >= windowEnd) throw new OrderValidationError("The pickup window must start before it ends.");
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 240) throw new OrderValidationError("Slot length must be between 5 and 240 minutes.");
  if (maxOrdersPerSlot !== null && (!Number.isInteger(maxOrdersPerSlot) || maxOrdersPerSlot < 1)) throw new OrderValidationError("Max orders per slot must be a whole number.");
  if (!Number.isInteger(totalLoaves) || totalLoaves < 1 || totalLoaves > PICKUP.maxLoavesPerDrop) throw new OrderValidationError(`Total loaves must be between 1 and ${PICKUP.maxLoavesPerDrop}.`);
  if (!localPattern.test(opensAtLocal) || !localPattern.test(closesAtLocal)) throw new OrderValidationError("Please set when ordering opens and closes.");

  const opensAt = localToUtc(opensAtLocal.slice(0, 10), opensAtLocal.slice(11));
  const closesAt = localToUtc(closesAtLocal.slice(0, 10), closesAtLocal.slice(11));
  const pickupEnds = localToUtc(pickupDate, windowEnd);

  if (opensAt >= closesAt) throw new OrderValidationError("Ordering must open before it closes.");
  if (closesAt > pickupEnds) throw new OrderValidationError("Ordering must close before the pickup window ends.");

  const id = Number.isInteger(body.id) ? body.id : null;

  if (id !== null) {
    const existing = await getDrop(env, id);
    if (!existing) throw new OrderValidationError("That drop no longer exists.");

    await db(env)
      .prepare("UPDATE drops SET name = ?, address = ?, notes = ?, pickup_date = ?, window_start = ?, window_end = ?, slot_minutes = ?, max_orders_per_slot = ?, total_loaves = ?, opens_at = ?, closes_at = ? WHERE id = ?")
      .bind(name, address, notes, pickupDate, windowStart, windowEnd, slotMinutes, maxOrdersPerSlot, totalLoaves, opensAt, closesAt, id)
      .run();

    return { id };
  }

  const result = await db(env)
    .prepare("INSERT INTO drops (name, address, notes, pickup_date, window_start, window_end, slot_minutes, max_orders_per_slot, total_loaves, opens_at, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(name, address, notes, pickupDate, windowStart, windowEnd, slotMinutes, maxOrdersPerSlot, totalLoaves, opensAt, closesAt, new Date().toISOString())
    .run();

  return { id: result.meta.last_row_id };

}

export async function adminDeleteDrop(id, env) {

  if (!Number.isInteger(id)) throw new OrderValidationError("Which drop?");

  const paid = await db(env).prepare("SELECT COUNT(*) AS count FROM pickup_orders WHERE drop_id = ? AND status = 'paid'").bind(id).first("count");

  if (paid > 0) {
    throw new OrderValidationError("This drop has paid orders, so it can't be deleted. Set its total loaves to what's sold to stop further orders.");
  }

  await db(env).batch([
    db(env).prepare("DELETE FROM pickup_orders WHERE drop_id = ?").bind(id),
    db(env).prepare("DELETE FROM drops WHERE id = ?").bind(id)
  ]);

  return { deleted: true };

}

export async function adminListOrders(dropId, env) {

  const drop = Number.isInteger(dropId) ? await getDrop(env, dropId) : null;
  if (!drop) throw new OrderValidationError("That drop doesn't exist.");

  const now = new Date();

  const { results } = await db(env)
    .prepare("SELECT * FROM pickup_orders WHERE drop_id = ? AND (status = 'paid' OR (status = 'pending' AND expires_at > ?)) ORDER BY slot, paid_at, created_at")
    .bind(drop.id, now.toISOString())
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
      slot: row.slot,
      slotLabel: formatTime(row.slot),
      loaves: row.loaves,
      items,
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email || "",
      tipCents: row.tip_cents,
      discountCode: row.discount_code || "",
      amountTotal: row.amount_total,
      paidAt: row.paid_at
    };
  });

  return {
    drop: describeDrop(drop, await getAvailability(env, drop.id, now), now),
    orders,
    loafTotals
  };

}
