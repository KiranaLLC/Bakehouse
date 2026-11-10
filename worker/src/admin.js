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

import { PICKUP, PRODUCTS } from "../../macros.js";
import { bakeryTodayValue, formatDeliveryDate } from "../../delivery-rules.js";
import { NON_LOAF_LINES, invoiceLoafItems } from "./capacity.js";
import { ADMIN_PAGE } from "./admin-page.js";
import {
  DropError,
  createDrop,
  getDrop,
  getDropBookings,
  hasDatabase,
  listDrops,
  listSubscribers,
  removeSubscriber,
  setDropCancelled,
  updateDrop
} from "./drops.js";
import { dropStatus, weekdayBefore, formatMoment, formatPickupWhen, utcToLocal } from "../../pickup-rules.js";

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

    const deliveredMatch = path.match(/^\/admin\/api\/orders\/((?:cs|in)_[A-Za-z0-9_]+)\/delivered$/);
    if (request.method === "POST" && deliveredMatch) {
      const body = await request.json().catch(() => ({}));
      const result = await setDelivered(deliveredMatch[1], body.delivered !== false, env, stripe);
      return json(result, result.ok ? 200 : 400);
    }

    const dropRoute = await handleDropRoutes(request, path, env, stripe);
    if (dropRoute) return dropRoute;

    return json({ error: "Not found." }, 404);

  } catch (error) {

    if (error instanceof DropError) {
      return json({ error: error.message }, 400);
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

  // Dated orders first, oldest date first; invoices with no delivery date last.
  // (Plain comparison: localeCompare would sort "~" before digits.)
  const sortKey = order => order.deliveryDate || "~";
  orders.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0) || a.created - b.created);

  return { today, orders, prep: prepByDate(orders) };

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

async function describeOrder(session, today, env, stripe) {

  const metadata = session.metadata;
  const items = await orderItems(session, env, stripe);
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
  const items = invoiceLoafItems(lines);
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
    totalCents: paid ? invoice.amount_paid : invoice.amount_due,
    tipCents: 0
  };

}

function formatStripeAddress(address) {
  if (!address) return "";
  const cityLine = [address.city, [address.state, address.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.line1, address.line2, cityLine].filter(Boolean).join(", ");
}

// For each delivery date: how many of each loaf to bake, most first.
export function prepByDate(orders) {

  const dates = new Map();

  for (const order of orders) {
    const day = dates.get(order.deliveryDate) || { date: order.deliveryDate, label: order.deliveryLabel, pastDue: order.pastDue, orders: 0, total: 0, loaves: new Map() };
    day.orders += 1;
    for (const { name, quantity } of order.items) {
      day.loaves.set(name, (day.loaves.get(name) || 0) + quantity);
      day.total += quantity;
    }
    dates.set(order.deliveryDate, day);
  }

  return [...dates.values()].map(day => ({
    ...day,
    loaves: [...day.loaves].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
  }));

}

/*
  Marks an order delivered (or not, to undo a
  mistaken tick) on its Stripe payment, or on
  the invoice itself.
*/
async function setDelivered(id, delivered, env, stripe) {

  const value = delivered ? new Date().toISOString() : "";
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

  return {
    databaseReady: true,
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
        // Default closing for this drop's date, used when its date changes in the form.
        defaultCloseLocal: `${weekdayBefore(drop.pickupDate, PICKUP.defaults.closesWeekday)}T${PICKUP.defaults.closesAt}`
      };
    })
  };

}
