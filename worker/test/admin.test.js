/*
  Orders page (admin) tests. Run from the worker folder with: npm test

  Stripe is replaced with a fake in-memory version, so these never touch
  the network or a real Stripe account.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/orders.js";
import checkoutWorker from "../src/index.js";
import { bakeryTodayValue } from "../../delivery-rules.js";

const BASE = "https://kirana-checkout.example.workers.dev";
const PASSWORD = "correct horse battery staple";
const env = { STRIPE_SECRET_KEY: "sk_test_fake", ADMIN_PASSWORD: PASSWORD, ALLOWED_ORIGINS: "https://www.kiranabakehouse.com" };

const today = bakeryTodayValue();
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

let sessions;
let lineItems;
let updates;

function addOrder({ id, date = addDays(today, 3), items, paymentStatus = "paid", status = "complete", delivered, name = "Asha Rao", payment = true, created }) {
  const metadata = { delivery_date: date, customer_name: name, customer_phone: "650-555-0100", delivery_address: "1 Oak St, Menlo Park, CA 94025", delivery_notes: "Leave by the door", tip_cents: "200" };
  if (items) metadata.items = items;
  const session = {
    id,
    status,
    payment_status: paymentStatus,
    created: created ?? Math.floor(Date.now() / 1000) - 3600,
    amount_total: 3400,
    metadata,
    customer_details: { email: `${id}@example.com`, name },
    payment_intent: payment ? { id: `pi_${id}`, metadata: delivered ? { delivered_at: "2026-11-01T00:00:00Z" } : {} } : null,
    customer: { id: `cus_${id}`, metadata: !payment && delivered ? { delivered_at: "2026-11-01T00:00:00Z" } : {} }
  };
  sessions.push(session);
  return session;
}

beforeEach(() => {
  sessions = [];
  lineItems = {};
  updates = [];
  globalThis.fetch = fakeStripe;
});

async function fakeStripe(input, init = {}) {

  const url = new URL(input);
  assert.equal(url.hostname, "api.stripe.com", `unexpected request to ${url.hostname}`);
  const method = init.method || "GET";
  const params = method === "GET" ? url.searchParams : new URLSearchParams(init.body);

  if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
    assert.equal(params.get("status"), "complete");
    assert.deepEqual(params.getAll("expand[0]").concat(params.getAll("expand[1]")), ["data.payment_intent", "data.customer"]);
    const after = params.get("starting_after");
    let list = sessions.filter(({ status }) => status === "complete").reverse();
    if (after) list = list.slice(list.findIndex(({ id }) => id === after) + 1);
    const limit = Number(params.get("limit"));
    return Response.json({ data: list.slice(0, limit), has_more: list.length > limit });
  }

  const lineItemsMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)\/line_items$/);
  if (method === "GET" && lineItemsMatch) {
    return Response.json({ data: lineItems[lineItemsMatch[1]] || [], has_more: false });
  }

  const sessionMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)$/);
  if (method === "GET" && sessionMatch) {
    const session = sessions.find(({ id }) => id === sessionMatch[1]);
    if (!session) return Response.json({ error: { message: "No such session" } }, { status: 404 });
    // Unexpanded, like Stripe's default.
    return Response.json({ ...session, payment_intent: session.payment_intent?.id || null, customer: session.customer?.id || null });
  }

  const updateMatch = url.pathname.match(/^\/v1\/(payment_intents|customers)\/(\w+)$/);
  if (method === "POST" && updateMatch) {
    updates.push({ object: updateMatch[1], id: updateMatch[2], deliveredAt: params.get("metadata[delivered_at]") });
    return Response.json({ id: updateMatch[2] });
  }

  throw new Error(`Unexpected Stripe call: ${method} ${url.pathname}`);

}

async function call(method, path, { body, cookie, origin = BASE, useEnv = env } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  const response = await worker.fetch(new Request(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), useEnv);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, body: data };
}

async function signIn() {
  const { status, headers } = await call("POST", "/admin/api/login", { body: { password: PASSWORD } });
  assert.equal(status, 200);
  return headers.get("Set-Cookie").split(";")[0];
}

test("the page loads without signing in, privately", async () => {
  const { status, headers, body } = await call("GET", "/admin");
  assert.equal(status, 200);
  assert.match(headers.get("Content-Type"), /text\/html/);
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.match(headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.match(body, /<title>Orders · Kirana Bakehouse<\/title>/);
});

test("orders need a signed-in session", async () => {
  assert.equal((await call("GET", "/admin/api/orders")).status, 401);
});

test("a wrong password is refused", async () => {
  const { status, headers } = await call("POST", "/admin/api/login", { body: { password: "nope" } });
  assert.equal(status, 401);
  assert.equal(headers.get("Set-Cookie"), null);
});

test("the right password gives a locked-down session cookie", async () => {
  const { headers } = await call("POST", "/admin/api/login", { body: { password: PASSWORD } });
  const cookie = headers.get("Set-Cookie");
  assert.match(cookie, /^kirana_admin=\d+\.[0-9a-f]{64};/);
  for (const part of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/admin"]) assert.ok(cookie.includes(part), part);
});

test("a forged, tampered or old-password cookie is refused", async () => {
  const cookie = await signIn();
  const [expires, signature] = cookie.split("=")[1].split(".");
  const farFuture = String(Number(expires) + 10 ** 6);
  assert.equal((await call("GET", "/admin/api/orders", { cookie: `kirana_admin=${farFuture}.${signature}` })).status, 401);
  assert.equal((await call("GET", "/admin/api/orders", { cookie: `kirana_admin=${expires}.${"0".repeat(64)}` })).status, 401);
  assert.equal((await call("GET", "/admin/api/orders", { cookie, useEnv: { ...env, ADMIN_PASSWORD: "a new password" } })).status, 401);
});

test("changes from another site are refused", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_a", items: "house_white:1" });
  assert.equal((await call("POST", "/admin/api/orders/cs_a/delivered", { cookie, origin: "https://evil.example", body: { delivered: true } })).status, 403);
  assert.equal((await call("POST", "/admin/api/orders/cs_a/delivered", { cookie, origin: null, body: { delivered: true } })).status, 403);
  assert.equal(updates.length, 0);
});

test("without ADMIN_PASSWORD the orders page explains how to set it up", async () => {
  const { status, body } = await call("GET", "/admin/api/orders", { useEnv: { STRIPE_SECRET_KEY: "sk_test_fake" } });
  assert.equal(status, 503);
  assert.match(body.error, /wrangler secret put ADMIN_PASSWORD/);
});

test("lists paid orders that aren't delivered yet, oldest date first", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_later", date: addDays(today, 5), items: "margherita:2" });
  addOrder({ id: "cs_soon", date: addDays(today, 2), items: "house_white:1,croissourdough:2", name: "Ben Ito" });
  addOrder({ id: "cs_late", date: addDays(today, -2), items: "birthday:1" });
  addOrder({ id: "cs_delivered", items: "house_white:3", delivered: true });
  addOrder({ id: "cs_free_delivered", items: "house_white:1", payment: false, paymentStatus: "no_payment_required", delivered: true });
  addOrder({ id: "cs_free", items: "birthday:1", payment: false, paymentStatus: "no_payment_required" });
  addOrder({ id: "cs_unpaid", items: "house_white:1", paymentStatus: "unpaid" });
  addOrder({ id: "cs_open", items: "house_white:1", status: "open" });
  sessions.push({ id: "cs_not_ours", status: "complete", payment_status: "paid", metadata: {}, payment_intent: null, customer: null });

  const { status, body } = await call("GET", "/admin/api/orders", { cookie });

  assert.equal(status, 200);
  assert.deepEqual(body.orders.map(({ id }) => id), ["cs_late", "cs_soon", "cs_free", "cs_later"]);
  const soon = body.orders[1];
  assert.equal(soon.name, "Ben Ito");
  assert.equal(soon.email, "cs_soon@example.com");
  assert.equal(soon.loaves, 3);
  assert.deepEqual(soon.items, [{ name: "House White", quantity: 1 }, { name: "Croissourdough", quantity: 2 }]);
  assert.equal(body.orders[0].pastDue, true);
  assert.equal(soon.pastDue, false);
});

test("older orders without an item list are read from Stripe line items", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_legacy" });
  lineItems.cs_legacy = [
    { description: "Elote", quantity: 2 },
    { description: "House White", quantity: 1 },
    { description: "Local delivery", quantity: 1 },
    { description: "Tip for your baker", quantity: 1 }
  ];

  const { body } = await call("GET", "/admin/api/orders", { cookie });

  assert.deepEqual(body.orders[0].items, [{ name: "Elote", quantity: 2 }, { name: "House White", quantity: 1 }]);
  assert.equal(body.orders[0].loaves, 3);
});

test("prep adds up each loaf per delivery date", async () => {
  const cookie = await signIn();
  const day = addDays(today, 3);
  addOrder({ id: "cs_1", date: day, items: "house_white:2,margherita:1" });
  addOrder({ id: "cs_2", date: day, items: "house_white:1,croissourdough:1" });
  addOrder({ id: "cs_3", date: addDays(today, 4), items: "birthday:4" });
  addOrder({ id: "cs_done", date: day, items: "house_white:6", delivered: true });

  const { body } = await call("GET", "/admin/api/orders", { cookie });

  assert.deepEqual(body.prep.map(({ date, orders, total }) => ({ date, orders, total })), [
    { date: day, orders: 2, total: 5 },
    { date: addDays(today, 4), orders: 1, total: 4 }
  ]);
  assert.deepEqual(body.prep[0].loaves, [
    { name: "House White", quantity: 3 },
    { name: "Croissourdough", quantity: 1 },
    { name: "Margherita", quantity: 1 }
  ]);
});

test("marking delivered saves it on the Stripe payment, and undo clears it", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_a", items: "house_white:1" });

  const done = await call("POST", "/admin/api/orders/cs_a/delivered", { cookie, body: { delivered: true } });
  assert.equal(done.status, 200);
  assert.equal(updates[0].object, "payment_intents");
  assert.equal(updates[0].id, "pi_cs_a");
  assert.ok(!Number.isNaN(Date.parse(updates[0].deliveredAt)));

  await call("POST", "/admin/api/orders/cs_a/delivered", { cookie, body: { delivered: false } });
  assert.deepEqual(updates[1], { object: "payment_intents", id: "pi_cs_a", deliveredAt: "" });
});

test("a free order (100% discount) is marked on its Stripe customer", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_free", items: "house_white:1", payment: false, paymentStatus: "no_payment_required" });

  await call("POST", "/admin/api/orders/cs_free/delivered", { cookie, body: { delivered: true } });

  assert.equal(updates[0].object, "customers");
  assert.equal(updates[0].id, "cus_cs_free");
});

test("only completed delivery orders can be marked", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_open", items: "house_white:1", status: "open" });
  const { status } = await call("POST", "/admin/api/orders/cs_open/delivered", { cookie, body: { delivered: true } });
  assert.equal(status, 400);
  assert.equal(updates.length, 0);
});

test("the orders worker serves only the orders page", async () => {
  const root = await worker.fetch(new Request(`${BASE}/`), env);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("Location"), `${BASE}/admin`);
  assert.equal((await call("POST", "/api/create-checkout-session", { body: {} })).status, 404);
  assert.equal((await call("GET", "/api/status")).status, 404);
});

test("the public checkout worker no longer serves the orders page", async () => {
  for (const path of ["/admin", "/admin/api/orders"]) {
    const response = await checkoutWorker.fetch(new Request(`https://kirana-checkout.example.workers.dev${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test("signing out clears the cookie", async () => {
  const { headers } = await call("POST", "/admin/api/logout", { body: {} });
  assert.match(headers.get("Set-Cookie"), /^kirana_admin=; Max-Age=0;/);
});
