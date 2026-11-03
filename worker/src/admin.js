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
  GET  /admin/api/orders                     paid orders not yet delivered
  POST /admin/api/orders/<session>/delivered { delivered: true | false }

There's one password, set as a Cloudflare secret:
  npx wrangler secret put ADMIN_PASSWORD
Changing it signs out every device.

Orders come from Stripe. "Delivered" is saved on
the order's Stripe payment (delivered_at in its
metadata), and delivered orders drop off the list.
==================================================
*/

import { PRODUCTS } from "../../macros.js";
import { bakeryTodayValue, formatDeliveryDate } from "../../delivery-rules.js";
import { NON_LOAF_LINES } from "./capacity.js";
import { ADMIN_PAGE } from "./admin-page.js";

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

    const deliveredMatch = path.match(/^\/admin\/api\/orders\/(cs_[A-Za-z0-9_]+)\/delivered$/);
    if (request.method === "POST" && deliveredMatch) {
      const body = await request.json().catch(() => ({}));
      const result = await setDelivered(deliveredMatch[1], body.delivered !== false, env, stripe);
      return json(result, result.ok ? 200 : 400);
    }

    return json({ error: "Not found." }, 404);

  } catch (error) {

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

  orders.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.created - b.created);

  return { today, orders, prep: prepByDate(orders) };

}

function isOpenOrder(session) {
  return Boolean(session.metadata?.delivery_date)
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

  return {
    id: session.id,
    created: session.created,
    deliveryDate: metadata.delivery_date,
    deliveryLabel: formatDeliveryDate(metadata.delivery_date),
    pastDue: metadata.delivery_date < today,
    name: metadata.customer_name || session.customer_details?.name || "",
    phone: metadata.customer_phone || "",
    email: session.customer_details?.email || "",
    address: metadata.delivery_address || "",
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
  mistaken tick) on its Stripe payment.
*/
async function setDelivered(sessionId, delivered, env, stripe) {

  const session = await stripe(env, "GET", `/checkout/sessions/${sessionId}`, {});

  if (session.status !== "complete" || !session.metadata?.delivery_date) {
    return { ok: false, error: "That isn't a completed delivery order." };
  }

  const value = delivered ? new Date().toISOString() : "";
  // An empty value removes the key in Stripe.
  const params = { metadata: { delivered_at: value } };

  if (session.payment_intent) {
    await stripe(env, "POST", `/payment_intents/${session.payment_intent}`, params);
  } else if (session.customer) {
    await stripe(env, "POST", `/customers/${session.customer}`, params);
  } else {
    return { ok: false, error: "This order has no payment or customer in Stripe to mark." };
  }

  return { ok: true, delivered };

}
