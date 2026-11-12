/*
==================================================
BAKERY ADMIN

The bakery's private orders page, served by this
worker at /admin so the page and its data share
one origin (the session cookie never has to cross
sites, which Safari would block).

  GET  /admin                                the page itself
  POST /admin/api/login                      { password } → session cookie
  POST /admin/api/logout                     clears the cookie
  GET  /admin/api/orders                     paid orders and invoices not yet delivered
  POST /admin/api/orders/<id>/delivered      { delivered: true | false }
  POST /admin/api/orders/<id>/partial        { items: { "<loaf name>": <loaves delivered so far> } }
  POST /admin/api/orders/<id>/move           { items: { "<loaf name>": <loaves to move> }, deliveryDate | dropId }
  GET  /admin/api/drops                      pickup drops (recent and upcoming)
  POST /admin/api/drops                      create a drop
  POST /admin/api/drops/<id>                 change a drop
  POST /admin/api/drops/<id>/cancel          { cancelled: true | false }
  GET  /admin/api/subscribers                the "next drop" email list
  POST /admin/api/subscribers/remove         { email }

There's one password, set as a Cloudflare secret:
  npx wrangler secret put ADMIN_PASSWORD
Changing it signs out every device.

Orders come from Stripe: website checkouts, and
invoices (paid or sent). "Delivered" is saved in
Stripe (delivered_at in the payment's or the
invoice's metadata), and delivered orders drop off
the list.
==================================================
*/

import { CONTACT, PICKUP, PRODUCTS } from "../../macros.js";
import { bakeryTodayValue, formatDeliveryDate } from "../../delivery-rules.js";
import { NON_LOAF_LINES, invoiceLoafItems } from "./capacity.js";
import { ADMIN_PAGE } from "./admin-page.js";
import {
  DropError,
  createDrop,
  getDrop,
  getDropBookings,
  getEmailLog,
  getQuietDropIds,
  hasDatabase,
  listDrops,
  listSubscribers,
  logEmail,
  removeSubscriber,
  setDropCancelled,
  updateDrop
} from "./drops.js";
import { EmailError, canEmail, deliveredEmail, firstName, pickupReadyEmail, sendEmail } from "./email.js";
import { announceDrop, announceKey, dropCustomerEmails, placeLines, remindDrop, remindKey } from "./email-flows.js";
import { dropStatus, weekdayBefore, formatMoment, formatPickupWhen, utcToLocal } from "../../pickup-rules.js";
import { getMove, insertMove, listMoves, movedOutByOrder, setMoveDelivered, sumItems, updateMoveItems, updateMoveTarget } from "./moves.js";

const COOKIE_NAME = "kirana_admin";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
// Long enough to keep showing orders whose delivery date has passed but
// that were never marked delivered.
const ORDER_LOOKBACK_SECONDS = 60 * 24 * 60 * 60;
const FAILED_LOGIN_DELAY_MS = 1000;

const encoder = new TextEncoder();

export async function handleAdmin(request, env, { stripe }) {

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const secure = url.protocol === "https:";

  try {

    if (request.method === "GET" && path === "/admin") {
      return page();
    }

    if (!env.ADMIN_PASSWORD) {
      return json({ error: "The orders page isn't set up yet. Run: npx wrangler secret put ADMIN_PASSWORD" }, 503);
    }

    // Only this page may change anything (the cookie is also SameSite=Strict).
    if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) {
      return json({ error: "Forbidden." }, 403);
    }

    if (request.method === "POST" && path === "/admin/api/login") {
      return await login(request, env, secure);
    }

    if (request.method === "POST" && path === "/admin/api/logout") {
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0, secure) });
    }

    if (!(await isSignedIn(request, env))) {
      return json({ error: "Please sign in." }, 401);
    }

    if (request.method === "GET" && path === "/admin/api/orders") {
      return json(await listOpenOrders(env, stripe));
    }

    const deliveredMatch = path.match(/^\/admin\/api\/orders\/((?:cs|in)_[A-Za-z0-9_]+|mv_\d+)\/delivered$/);
    if (request.method === "POST" && deliveredMatch) {
      const body = await request.json().catch(() => ({}));
      const result = await setDelivered(deliveredMatch[1], body.delivered !== false, env, stripe);
      return json(result, result.ok ? 200 : 400);
    }

    const partialMatch = path.match(/^\/admin\/api\/orders\/((?:cs|in)_[A-Za-z0-9_]+|mv_\d+)\/partial$/);
    if (request.method === "POST" && partialMatch) {
      const body = await request.json().catch(() => ({}));
      const result = await setPartlyDelivered(partialMatch[1], body.items, env, stripe);
      return json(result, result.ok ? 200 : 400);
    }

    const moveMatch = path.match(/^\/admin\/api\/orders\/((?:cs|in)_[A-Za-z0-9_]+|mv_\d+)\/move$/);
    if (request.method === "POST" && moveMatch) {
      const body = await request.json().catch(() => ({}));
      const result = await moveOrder(moveMatch[1], body, env, stripe);
      return json(result, result.ok ? 200 : 400);
    }

    const emailMatch = path.match(/^\/admin\/api\/orders\/((?:cs|in)_[A-Za-z0-9_]+|mv_\d+)\/email$/);
    if (request.method === "POST" && emailMatch) {
      return json(await emailCustomer(emailMatch[1], env, stripe));
    }

    const dropRoute = await handleDropRoutes(request, path, env, stripe);
    if (dropRoute) return dropRoute;

    return json({ error: "Not found." }, 404);

  } catch (error) {

    if (error instanceof DropError || error instanceof EmailError) {
      return json({ error: error.message }, 400);
    }

    if (/no such table: order_moves/i.test(error.message || "")) {
      return json({ error: "Moving orders needs a new table in the pickup database. Run: npx wrangler d1 execute kirana-pickup --remote --file=schema.sql" }, 400);
    }

    console.error(error);
    return json({ error: error.publicMessage || "Something went wrong. Please try again." }, 500);

  }

}

/*
==================================================
RESPONSES
==================================================
*/

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...PRIVATE_HEADERS, ...headers, "Content-Type": "application/json" } });
}

function page() {
  return new Response(ADMIN_PAGE, {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    }
  });
}

/*
==================================================
SIGNING IN

The session cookie is "<expiry>.<signature>",
signed with the admin password, so it can't be
forged and changing the password ends it.
==================================================
*/

async function login(request, env, secure) {

  const { password } = await request.json().catch(() => ({}));

  if (typeof password !== "string" || !(await passwordMatches(password, env.ADMIN_PASSWORD))) {
    // Slows down anyone guessing.
    await new Promise(resolve => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return json({ error: "That password isn't right." }, 401);
  }

  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const token = `${expires}.${toHex(await sign(env.ADMIN_PASSWORD, `session:${expires}`))}`;

  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS, secure) });

}

function sessionCookie(value, maxAge, secure) {
  return `${COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=/admin; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

async function isSignedIn(request, env) {

  const cookie = (request.headers.get("Cookie") || "")
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`));

  const [expires, signature] = (cookie?.slice(COOKIE_NAME.length + 1) || "").split(".");

  if (!/^\d+$/.test(expires || "") || Number(expires) < Date.now() / 1000 || !/^[0-9a-f]{64}$/.test(signature || "")) {
    return false;
  }

  return verify(env.ADMIN_PASSWORD, `session:${expires}`, fromHex(signature));

}

// Compares in constant time, so response timing doesn't leak the password.
async function passwordMatches(given, actual) {
  const expected = await sign("kirana-admin-password", actual);
  return verify("kirana-admin-password", given, expected);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(secret, message) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
}

async function verify(secret, message, signature) {
  return crypto.subtle.verify("HMAC", await hmacKey(secret), signature, encoder.encode(message));
}

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  return new Uint8Array(hex.match(/../g).map(pair => parseInt(pair, 16)));
}

/*
==================================================
ORDERS
==================================================
*/

/*
  Every paid delivery order not yet marked
  delivered, oldest delivery date first, plus the
  loaves to bake for each date.
*/
async function listOpenOrders(env, stripe) {

  const since = Math.floor(Date.now() / 1000) - ORDER_LOOKBACK_SECONDS;
  const today = bakeryTodayValue();
  const moves = await listMoves(env);
  const movedOut = movedOutByOrder(moves);
  const orders = [];
  let startingAfter;

  do {

    const page = await stripe(env, "GET", "/checkout/sessions", {
      limit: 100,
      status: "complete",
      created: { gte: since },
      starting_after: startingAfter,
      expand: ["data.payment_intent", "data.customer"]
    });

    for (const session of page.data) {
      if (!isOpenOrder(session)) continue;
      orders.push(await describeOrder(session, today, env, stripe));
    }

    startingAfter = page.has_more ? page.data.at(-1).id : undefined;

  } while (startingAfter);

  orders.push(...await listOpenInvoices(env, stripe, since, today));

  // Loaves moved to another day leave their order and show up on that day.
  const drops = new Map();
  const dropFor = async id => {
    if (!id || !hasDatabase(env)) return null;
    if (!drops.has(id)) drops.set(id, await getDrop(env, Number(id)));
    return drops.get(id);
  };
  const open = [];
  for (const order of orders) {
    const moved = movedOut.get(order.id);
    if (!moved) { open.push(order); continue; }
    const left = withoutMoved(order, moved);
    left.movedTo = await describeMovedTo(moves.filter(move => move.orderId === order.id), dropFor);
    if (left.loaves > 0) open.push(left);
  }
  for (const move of moves) {
    if (!move.deliveredAt) open.push(describeMove(move, today, await dropFor(move.dropId)));
  }
  orders.length = 0;
  orders.push(...open);

  // Dated orders first, oldest date first; invoices with no delivery date last.
  // (Plain comparison: localeCompare would sort "~" before digits.)
  const sortKey = order => order.deliveryDate || "~";
  orders.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0) || a.created - b.created);

  // When each order's email was sent from this page (email turned on only).
  const emailReady = canEmail(env);
  if (emailReady) {
    const log = await getEmailLog(env, orders.map(({ id }) => `order:${id}`));
    for (const order of orders) order.emailedAt = log.get(`order:${order.id}`)?.sentAt || "";
  }

  return { today, emailReady, contact: CONTACT, orders, prep: prepByDate(orders) };

}

function isPickup(session) {
  return session.metadata?.fulfillment === "pickup";
}

// The day the order goes out: its delivery date, or its pickup date.
function orderDate(session) {
  return session.metadata?.delivery_date || (isPickup(session) ? session.metadata?.pickup_date : "") || "";
}

function isOpenOrder(session) {
  return Boolean(orderDate(session))
    && (session.payment_status === "paid" || session.payment_status === "no_payment_required")
    && !deliveredAt(session);
}

// Saved on the payment, or on the customer for an order that was free
// (a 100% discount has no payment).
function deliveredAt(session) {
  return session.payment_intent?.metadata?.delivered_at || session.customer?.metadata?.delivered_at || "";
}

/*
  PARTLY DELIVERED

  When only some loaves have gone out, the orders
  page saves how many of each in delivered_items,
  next to delivered_at: {"House White":1,"Pesto":2}.
  The order stays on the list (and in the prep
  counts, for what's left) until it's fully
  delivered.
*/
function parseDeliveredItems(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function withDelivered(items, delivered) {
  return items.map(item => ({ ...item, delivered: Math.min(item.quantity, Math.max(0, Number(delivered[item.name]) || 0)) }));
}

// An order with the loaves moved to other days taken off.
function withoutMoved(order, moved) {
  const items = order.items
    .map(item => {
      const quantity = Math.max(0, item.quantity - (moved[item.name] || 0));
      return { ...item, quantity, delivered: Math.min(item.delivered || 0, quantity) };
    })
    .filter(({ quantity }) => quantity > 0);
  return {
    ...order,
    items,
    loaves: items.reduce((total, { quantity }) => total + quantity, 0),
    loavesDelivered: items.reduce((total, { delivered }) => total + delivered, 0),
    movedLoaves: sumItems(moved)
  };
}

async function describeMovedTo(moves, dropFor) {
  const list = [];
  for (const move of moves) {
    const drop = await dropFor(move.dropId);
    const date = drop ? drop.pickupDate : move.deliveryDate;
    list.push({ label: date ? formatDeliveryDate(date) : "another day", loaves: sumItems(move.items) });
  }
  return list;
}

/*
  A moved part, shown as its own order on its new
  day. Its id is "mv_<number>".
*/
function describeMove(move, today, drop) {
  const pickup = Boolean(move.dropId);
  const date = pickup ? drop?.pickupDate || "" : move.deliveryDate;
  const items = withDelivered(Object.entries(move.items).map(([name, quantity]) => ({ name, quantity })), move.deliveredItems);
  return {
    id: move.partId,
    kind: "moved",
    orderId: move.orderId,
    fulfillment: pickup ? "pickup" : "delivery",
    dropId: move.dropId,
    pickupWhen: drop ? formatPickupWhen(drop) : "",
    unpaid: false,
    created: Math.floor(Date.parse(move.createdAt) / 1000) || 0,
    deliveryDate: date,
    deliveryLabel: date ? formatDeliveryDate(date) : "Pickup drop not found",
    pastDue: Boolean(date) && date < today,
    name: move.name,
    phone: move.phone,
    email: move.email,
    address: pickup ? (drop ? `${drop.locationName}, ${drop.locationAddress}` : "") : move.address,
    notes: move.notes,
    items,
    loaves: items.reduce((total, { quantity }) => total + quantity, 0),
    loavesDelivered: items.reduce((total, { delivered }) => total + delivered, 0),
    movedFrom: move.fromDate,
    movedFromLabel: move.fromDate ? formatDeliveryDate(move.fromDate) : "",
    totalCents: 0,
    tipCents: 0
  };
}

function sessionDeliveredItems(session) {
  return parseDeliveredItems(session.payment_intent?.metadata?.delivered_items || session.customer?.metadata?.delivered_items);
}

async function describeOrder(session, today, env, stripe) {

  const metadata = session.metadata;
  const items = withDelivered(await orderItems(session, env, stripe), sessionDeliveredItems(session));
  const pickup = isPickup(session);
  const date = orderDate(session);

  return {
    id: session.id,
    kind: "checkout",
    fulfillment: pickup ? "pickup" : "delivery",
    dropId: pickup ? metadata.drop_id : "",
    pickupWhen: pickup ? metadata.pickup_label || "" : "",
    unpaid: false,
    created: session.created,
    deliveryDate: date,
    deliveryLabel: formatDeliveryDate(date),
    pastDue: date < today,
    name: metadata.customer_name || session.customer_details?.name || "",
    phone: metadata.customer_phone || "",
    email: session.customer_details?.email || "",
    address: (pickup ? metadata.pickup_location : metadata.delivery_address) || "",
    notes: metadata.delivery_notes || "",
    items,
    loaves: items.reduce((total, { quantity }) => total + quantity, 0),
    loavesDelivered: items.reduce((total, { delivered }) => total + delivered, 0),
    totalCents: session.amount_total || 0,
    tipCents: Number(metadata.tip_cents) || 0
  };

}

/*
  Loaves in an order as [{ name, quantity }]. New
  orders list them in metadata ("house_white:2");
  older ones are read from their Stripe line items.
  Loaves that have since left the menu keep the
  name they were sold under.
*/
async function orderItems(session, env, stripe) {

  if (session.metadata?.items) {
    return session.metadata.items.split(",").map(entry => {
      const [productId, quantity] = entry.split(":");
      return { name: PRODUCTS[productId]?.name || productId, quantity: Number(quantity) || 0 };
    }).filter(({ quantity }) => quantity > 0);
  }

  const lineItems = await stripe(env, "GET", `/checkout/sessions/${session.id}/line_items`, { limit: 100 });

  return lineItems.data
    .filter(({ description }) => !NON_LOAF_LINES.has(description))
    .map(({ description, quantity }) => ({ name: description, quantity }));

}

/*
==================================================
EMAILING A CUSTOMER

"Your order has been delivered", or "your order is
ready for pickup", sent straight from the orders
page through Resend. The order is read fresh from
Stripe so the email matches it.
==================================================
*/

async function emailCustomer(id, env, stripe) {

  if (!canEmail(env)) throw new EmailError("Email isn't set up yet, so use the draft instead.");

  const order = await describeAny(id, bakeryTodayValue(), env, stripe);
  if (!order) throw new EmailError("That order wasn't found.");

  if (!order.email) throw new EmailError("This order has no email address.");

  // Website orders are people ("Hi Ben"); invoices are often businesses.
  const name = order.kind === "invoice" ? order.name || "there" : firstName(order.name);
  let message;

  if (order.fulfillment === "pickup") {
    const drop = order.dropId && hasDatabase(env) ? await getDrop(env, Number(order.dropId)) : null;
    message = pickupReadyEmail({ to: order.email, name, items: order.items, when: order.pickupWhen, place: drop ? placeLines(drop) : [`Where: ${order.address}`] });
  } else {
    message = deliveredEmail({ to: order.email, name, items: order.items });
  }

  await sendEmail(env, message);
  if (hasDatabase(env)) await logEmail(env, `order:${id}`, 1).catch(() => {});

  return { ok: true, sentAt: new Date().toISOString() };

}

// Any order or moved part by id, as the orders page shows it (loaves moved
// off an order are taken off it). null if a moved part isn't found.
async function describeAny(id, today, env, stripe) {
  if (id.startsWith("mv_")) {
    const move = await getMove(env, id);
    return move ? describeMove(move, today, move.dropId ? await getDrop(env, Number(move.dropId)) : null) : null;
  }
  const order = id.startsWith("cs_")
    ? await describeOrder(await stripe(env, "GET", `/checkout/sessions/${id}`, { expand: ["payment_intent", "customer"] }), today, env, stripe)
    : await describeInvoice(await stripe(env, "GET", `/invoices/${id}`, {}), today, env, stripe);
  const moved = movedOutByOrder(await listMoves(env)).get(id);
  return moved ? withoutMoved(order, moved) : order;
}

/*
==================================================
INVOICES

Invoices made in the Stripe Dashboard, e.g. for
catering. Paid ones, and sent ones not yet paid
(shown as "Unpaid"); drafts and voided invoices
are left out. To give one a delivery date, add
metadata delivery_date = YYYY-MM-DD to it in
Stripe; without it, it's listed under "No
delivery date set".
==================================================
*/

async function listOpenInvoices(env, stripe, since, today) {

  const invoices = [];

  for (const status of ["paid", "open"]) {
    let startingAfter;
    do {
      const page = await stripe(env, "GET", "/invoices", { limit: 100, status, created: { gte: since }, starting_after: startingAfter });
      for (const invoice of page.data) {
        if (invoice.metadata?.delivered_at) continue;
        invoices.push(await describeInvoice(invoice, today, env, stripe));
      }
      startingAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (startingAfter);
  }

  return invoices;

}

async function describeInvoice(invoice, today, env, stripe) {

  // An invoice with drop_id is a pickup order for that drop.
  const dropId = /^\d+$/.test(invoice.metadata?.drop_id || "") ? invoice.metadata.drop_id : "";
  const drop = dropId && hasDatabase(env) ? await getDrop(env, Number(dropId)) : null;
  const date = drop ? drop.pickupDate
    : /^\d{4}-\d{2}-\d{2}$/.test(invoice.metadata?.delivery_date || "") ? invoice.metadata.delivery_date : "";
  const lines = invoice.lines?.has_more
    ? (await stripe(env, "GET", `/invoices/${invoice.id}/lines`, { limit: 100 })).data
    : invoice.lines?.data || [];
  const items = withDelivered(invoiceLoafItems(lines), parseDeliveredItems(invoice.metadata?.delivered_items));
  const shipping = invoice.customer_shipping;
  const paid = invoice.status === "paid";

  return {
    id: invoice.id,
    kind: "invoice",
    fulfillment: dropId ? "pickup" : "delivery",
    dropId,
    pickupWhen: drop ? formatPickupWhen(drop) : "",
    invoiceNumber: invoice.number || "",
    unpaid: !paid,
    created: invoice.created,
    deliveryDate: date,
    deliveryLabel: date ? formatDeliveryDate(date) : "No delivery date set",
    pastDue: Boolean(date) && date < today,
    name: shipping?.name || invoice.customer_name || "",
    phone: shipping?.phone || invoice.customer_phone || "",
    email: invoice.customer_email || "",
    address: drop ? `${drop.locationName}, ${drop.locationAddress}` : formatStripeAddress(shipping?.address || invoice.customer_address),
    notes: invoice.description || "",
    items,
    loaves: items.reduce((total, { quantity }) => total + quantity, 0),
    loavesDelivered: items.reduce((total, { delivered }) => total + delivered, 0),
    totalCents: paid ? invoice.amount_paid : invoice.amount_due,
    tipCents: 0
  };

}

function formatStripeAddress(address) {
  if (!address) return "";
  const cityLine = [address.city, [address.state, address.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.line1, address.line2, cityLine].filter(Boolean).join(", ");
}

// For each delivery date: how many of each loaf still to bake or hand over, most first.
export function prepByDate(orders) {

  const dates = new Map();

  for (const order of orders) {
    const day = dates.get(order.deliveryDate) || { date: order.deliveryDate, label: order.deliveryLabel, pastDue: order.pastDue, orders: 0, total: 0, loaves: new Map() };
    day.orders += 1;
    for (const { name, quantity, delivered = 0 } of order.items) {
      const left = quantity - delivered;
      if (left <= 0) continue;
      day.loaves.set(name, (day.loaves.get(name) || 0) + left);
      day.total += left;
    }
    dates.set(order.deliveryDate, day);
  }

  return [...dates.values()].map(day => ({
    ...day,
    loaves: [...day.loaves].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
  }));

}

/*
  Saves how many of each loaf have gone out so
  far. Once every loaf has, the order is marked
  delivered and leaves the list.
*/
async function setPartlyDelivered(id, input, env, stripe) {

  const target = id.startsWith("mv_") ? await findMoveTarget(id, env) : await findDeliveryTarget(id, env, stripe);
  if (!target.ok) return target;

  const delivered = {};
  for (const item of target.items) {
    const count = Number(input?.[item.name]);
    if (input?.[item.name] === undefined || input[item.name] === "") continue;
    if (!Number.isInteger(count) || count < 0 || count > item.quantity) {
      return { ok: false, error: `${item.name}: enter a number from 0 to ${item.quantity}.` };
    }
    if (count > 0) delivered[item.name] = count;
  }

  const total = target.items.reduce((sum, { quantity }) => sum + quantity, 0);
  const done = Object.values(delivered).reduce((sum, count) => sum + count, 0);
  const complete = total > 0 && done === total;
  const value = JSON.stringify(delivered);

  if (value.length > 500) return { ok: false, error: "Too many loaf types to save on this order." };

  if (target.move) {
    await setMoveDelivered(env, target.move, { deliveredItems: delivered, deliveredAt: complete ? new Date().toISOString() : "" });
    return { ok: true, delivered, loavesDelivered: done, loaves: total, complete };
  }

  await stripe(env, "POST", target.path, { metadata: {
    // Empty values remove the keys in Stripe.
    delivered_items: done ? value : "",
    delivered_at: complete ? new Date().toISOString() : ""
  } });

  return { ok: true, delivered, loavesDelivered: done, loaves: total, complete };

}

// A moved part's loaves; its delivered state lives in the database.
async function findMoveTarget(id, env) {
  const move = await getMove(env, id);
  if (!move) return { ok: false, error: "That moved order wasn't found." };
  return { ok: true, move, items: Object.entries(move.items).map(([name, quantity]) => ({ name, quantity })) };
}

// The loaves still on an order, after any moved to other days.
async function itemsLeft(id, items, env) {
  const moved = movedOutByOrder(await listMoves(env)).get(id) || {};
  return items.map(item => ({ ...item, quantity: Math.max(0, item.quantity - (moved[item.name] || 0)) })).filter(({ quantity }) => quantity > 0);
}

// Where an order's delivered state lives in Stripe, and its loaves (those
// still on it, not moved to another day).
async function findDeliveryTarget(id, env, stripe) {

  if (id.startsWith("in_")) {
    const invoice = await stripe(env, "GET", `/invoices/${id}`, {});
    if (invoice.status !== "paid" && invoice.status !== "open") {
      return { ok: false, error: "Only paid or sent invoices can be marked delivered." };
    }
    const lines = invoice.lines?.has_more
      ? (await stripe(env, "GET", `/invoices/${id}/lines`, { limit: 100 })).data
      : invoice.lines?.data || [];
    return { ok: true, path: `/invoices/${id}`, items: await itemsLeft(id, invoiceLoafItems(lines), env) };
  }

  const session = await stripe(env, "GET", `/checkout/sessions/${id}`, {});
  if (session.status !== "complete" || !orderDate(session)) {
    return { ok: false, error: "That isn't a completed delivery order." };
  }
  const items = await itemsLeft(id, await orderItems(session, env, stripe), env);
  if (session.payment_intent) return { ok: true, path: `/payment_intents/${session.payment_intent}`, items };
  if (session.customer) return { ok: true, path: `/customers/${session.customer}`, items };
  return { ok: false, error: "This order has no payment or customer in Stripe to mark." };

}

/*
  Marks an order delivered (or not, to undo a
  mistaken tick) on its Stripe payment, or on
  the invoice itself.
*/
async function setDelivered(id, delivered, env, stripe) {

  const value = delivered ? new Date().toISOString() : "";

  if (id.startsWith("mv_")) {
    const move = await getMove(env, id);
    if (!move) return { ok: false, error: "That moved order wasn't found." };
    // Undoing a tick keeps any loaves marked as partly delivered.
    await setMoveDelivered(env, move, { deliveredItems: delivered ? {} : move.deliveredItems, deliveredAt: value });
    return { ok: true, delivered };
  }

  // An empty value removes the key in Stripe.
  const params = { metadata: { delivered_at: value } };

  if (id.startsWith("in_")) {
    const invoice = await stripe(env, "GET", `/invoices/${id}`, {});
    if (invoice.status !== "paid" && invoice.status !== "open") {
      return { ok: false, error: "Only paid or sent invoices can be marked delivered." };
    }
    await stripe(env, "POST", `/invoices/${id}`, params);
    return { ok: true, delivered };
  }

  const sessionId = id;
  const session = await stripe(env, "GET", `/checkout/sessions/${sessionId}`, {});

  if (session.status !== "complete" || !orderDate(session)) {
    return { ok: false, error: "That isn't a completed delivery order." };
  }

  if (session.payment_intent) {
    await stripe(env, "POST", `/payment_intents/${session.payment_intent}`, params);
  } else if (session.customer) {
    await stripe(env, "POST", `/customers/${session.customer}`, params);
  } else {
    return { ok: false, error: "This order has no payment or customer in Stripe to mark." };
  }

  return { ok: true, delivered };

}

/*
==================================================
MOVING AN ORDER

Moves a paid order, or some of its loaves, to
another delivery day (delivery orders) or another
pickup drop (pickup orders). Stripe isn't changed:
the move is saved in the database (see moves.js),
and the order page, prep and capacity all follow
it. Loaves already handed over can't be moved.

Moving a moved part again changes its day, or
splits it. Moving it back to the order's own day
puts its loaves back on the order.

The customer isn't emailed; the page offers a
draft to let them know.
==================================================
*/

async function moveOrder(id, input, env, stripe) {

  if (!hasDatabase(env)) return { ok: false, error: "Moving orders needs the pickup database. See README, \"Pickup drops\"." };

  const today = bakeryTodayValue();
  const source = await describeAny(id, today, env, stripe);
  if (!source) return { ok: false, error: "That order wasn't found." };
  if (source.kind !== "moved" && source.unpaid) return { ok: false, error: "Only paid orders can be moved." };

  // The original order: a moved part goes back onto it when moved to its day.
  const original = source.kind === "moved" ? await describeAny(source.orderId, today, env, stripe).catch(() => null) : source;
  const pickup = source.fulfillment === "pickup";

  // Where to.
  let target;
  if (pickup) {
    const drop = /^\d+$/.test(String(input?.dropId || "")) ? await getDrop(env, Number(input.dropId)) : null;
    if (!drop || drop.cancelled) return { ok: false, error: "Pick a pickup drop to move it to." };
    if (drop.pickupDate < today) return { ok: false, error: "That drop has already happened." };
    target = { dropId: String(drop.id), date: drop.pickupDate };
  } else {
    const date = String(input?.deliveryDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, error: "Pick a day to move it to." };
    if (date < today) return { ok: false, error: "Pick today or a day after." };
    target = { deliveryDate: date, date };
  }
  const sameTarget = order => order && (pickup ? String(order.dropId) === target.dropId : order.deliveryDate === target.deliveryDate);
  if (sameTarget(source)) return { ok: false, error: "It's already on that day." };

  // Which loaves: up to what's still to hand over, for each.
  const items = {};
  for (const item of source.items) {
    const raw = input?.items?.[item.name];
    if (raw === undefined || raw === "" || raw === 0 || raw === "0") continue;
    const count = Number(raw);
    const movable = item.quantity - (item.delivered || 0);
    if (!Number.isInteger(count) || count < 0 || count > movable) {
      return { ok: false, error: `${item.name}: enter a number from 0 to ${movable}.` };
    }
    items[item.name] = count;
  }
  if (!sumItems(items)) return { ok: false, error: "Pick at least one loaf to move." };

  const moves = await listMoves(env);
  const sourceMove = source.kind === "moved" ? moves.find(move => move.partId === id) : null;
  if (source.kind === "moved" && !sourceMove) return { ok: false, error: "That moved order wasn't found." };

  const takeOff = (from, gone) => Object.fromEntries(Object.entries(from).map(([name, count]) => [name, count - (gone[name] || 0)]).filter(([, count]) => count > 0));
  const addOn = (to, more) => { const sum = { ...to }; for (const [name, count] of Object.entries(more)) sum[name] = (sum[name] || 0) + count; return sum; };
  const everything = sourceMove && !sumItems(sourceMove.deliveredItems) && sumItems(takeOff(sourceMove.items, items)) === 0;

  // Another moved part of the same order already on that day takes them.
  const orderId = sourceMove ? sourceMove.orderId : id;
  const join = moves.find(move => move.orderId === orderId && move.partId !== id && !move.deliveredAt && sameTarget({ dropId: move.dropId, deliveryDate: move.deliveryDate }));

  if (sourceMove && sameTarget(original)) {
    // Back onto the order itself.
    await updateMoveItems(env, sourceMove, takeOff(sourceMove.items, items));
  } else if (join) {
    await updateMoveItems(env, join, addOn(join.items, items));
    if (sourceMove) await updateMoveItems(env, sourceMove, takeOff(sourceMove.items, items));
  } else if (everything) {
    await updateMoveTarget(env, sourceMove, { ...target, fromDate: source.deliveryDate });
  } else {
    await insertMove(env, {
      orderId,
      items,
      deliveryDate: target.deliveryDate,
      dropId: target.dropId,
      fromDate: source.deliveryDate,
      name: source.name,
      email: source.email,
      phone: source.phone,
      // A pickup part's place comes from its drop.
      address: pickup ? "" : source.address,
      notes: source.notes
    });
    if (sourceMove) await updateMoveItems(env, sourceMove, takeOff(sourceMove.items, items));
  }

  return { ok: true, moved: sumItems(items), to: formatDeliveryDate(target.date) };

}

/*
==================================================
PICKUP DROPS

Scheduling drops and the notify list. Needs the
pickup database (binding DB); without it, these
say so instead of failing.
==================================================
*/

// How far back the drops list goes, so recent drops stay visible for reminders.
const DROPS_LOOKBACK_DAYS = 14;

// Linked from "a new drop is open" emails; ?pickup opens the order page on pickup.
const ORDER_PAGE_URL = "https://www.kiranabakehouse.com/order.html?pickup";

// "2026-11-08", 6 (Saturday) → the next Saturday after that date
function nextWeekday(date, weekday) {
  const day = new Date(`${date}T00:00:00Z`);
  const ahead = ((weekday - day.getUTCDay() + 7) % 7) || 7;
  return new Date(day.getTime() + ahead * 864e5).toISOString().slice(0, 10);
}

async function handleDropRoutes(request, path, env, stripe) {

  const isDropPath = path === "/admin/api/drops" || path.startsWith("/admin/api/drops/") || path.startsWith("/admin/api/subscribers");
  if (!isDropPath) return null;

  if (request.method === "GET" && path === "/admin/api/drops") {
    return json(await listAdminDrops(env, stripe));
  }

  if (!hasDatabase(env)) {
    return json({ error: "The pickup database isn't set up yet. See README, \"Pickup drops\"." }, 503);
  }

  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  if (request.method === "POST" && path === "/admin/api/drops") {
    return json({ drop: await createDrop(env, body) });
  }

  const cancelMatch = path.match(/^\/admin\/api\/drops\/(\d+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    return json({ drop: await setDropCancelled(env, Number(cancelMatch[1]), body.cancelled !== false) });
  }

  const updateMatch = path.match(/^\/admin\/api\/drops\/(\d+)$/);
  if (request.method === "POST" && updateMatch) {
    return json({ drop: await updateDrop(env, Number(updateMatch[1]), body) });
  }

  const sendMatch = path.match(/^\/admin\/api\/drops\/(\d+)\/(announce|remind)$/);
  if (request.method === "POST" && sendMatch) {
    if (!canEmail(env)) throw new EmailError("Email isn't set up yet, so use the draft instead.");
    const drop = await getDrop(env, Number(sendMatch[1]));
    if (!drop) return json({ error: "That drop doesn't exist." }, 404);
    try {
      const sent = sendMatch[2] === "announce" ? await announceDrop(env, drop, { force: true }) : await remindDrop(env, stripe, drop, { force: true });
      return json({ ok: true, sent });
    } catch (error) {
      if (/no such table/i.test(error.message || "")) {
        throw new EmailError("The email tables aren't in the pickup database yet. Run: npx wrangler d1 execute kirana-pickup --remote --file=schema.sql");
      }
      if (error.sent) throw new EmailError(`Sent to ${error.sent}, then stopped: ${error.message}`);
      throw error;
    }
  }

  if (request.method === "GET" && path === "/admin/api/subscribers") {
    return json({ subscribers: await listSubscribers(env) });
  }

  if (request.method === "POST" && path === "/admin/api/subscribers/remove") {
    return json(await removeSubscriber(env, body.email));
  }

  return json({ error: "Not found." }, 404);

}

async function listAdminDrops(env, stripe) {

  const { date: today, time: nowTime } = utcToLocal(new Date().toISOString());
  // For the new-drop form: today in bakery time, and the next Saturday.
  const clock = { today, nowLocal: `${today}T${nowTime}`, nextSaturday: nextWeekday(today, 6), orderPageUrl: ORDER_PAGE_URL };

  if (!hasDatabase(env)) {
    return { databaseReady: false, drops: [], subscriberCount: 0, defaults: PICKUP.defaults, ...clock };
  }

  const fromDate = new Date(Date.parse(`${bakeryTodayValue()}T00:00:00Z`) - DROPS_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const drops = await listDrops(env, { fromDate, includeCancelled: true });
  const booked = await getDropBookings(env, stripe, drops.filter(({ cancelled }) => !cancelled));
  const subscribers = await listSubscribers(env);
  const now = Date.now();
  const emailReady = canEmail(env);
  const log = emailReady ? await getEmailLog(env, drops.flatMap(drop => [announceKey(drop), remindKey(drop)])) : new Map();
  const quiet = await getQuietDropIds(env);
  // With email on, reminders go to customers found in Stripe (paid pickup orders).
  const customerCounts = new Map();
  if (emailReady) {
    for (const drop of drops.filter(({ cancelled, pickupDate }) => !cancelled && pickupDate >= today)) {
      customerCounts.set(drop.id, (await dropCustomerEmails(env, stripe, drop)).length);
    }
  }

  return {
    databaseReady: true,
    emailReady,
    defaults: PICKUP.defaults,
    ...clock,
    subscriberCount: subscribers.length,
    // For the "a new drop is open" email (sent as BCC).
    subscriberEmails: subscribers.map(({ email }) => email),
    drops: drops.map(drop => {
      const loaves = booked.get(String(drop.id)) || 0;
      const remaining = Math.max(drop.loafLimit - loaves, 0);
      return {
        ...drop,
        booked: loaves,
        remaining,
        status: dropStatus(drop, remaining, now),
        when: formatPickupWhen(drop),
        opensLabel: formatMoment(drop.opensAt),
        closesLabel: formatMoment(drop.closesAt),
        announce: !quiet.has(drop.id),
        announced: log.get(announceKey(drop)) || null,
        reminded: log.get(remindKey(drop)) || null,
        customerCount: customerCounts.get(drop.id) ?? null,
        // Default closing for this drop's date, used when its date changes in the form.
        defaultCloseLocal: `${weekdayBefore(drop.pickupDate, PICKUP.defaults.closesWeekday)}T${PICKUP.defaults.closesAt}`
      };
    })
  };

}
