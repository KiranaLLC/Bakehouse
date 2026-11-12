/*
  Orders page (admin) tests. Run from the worker folder with: npm test

  Stripe is replaced with a fake in-memory version, so these never touch
  the network or a real Stripe account.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetStripeLists } from "../src/stripe-cache.js";
import { createFakeD1 } from "./fake-d1.js";
import { applyMoves } from "../src/moves.js";

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
let invoices;

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

function addInvoice({ id, status = "paid", deliveryDate, delivered, lines = [{ description: "House White", quantity: 4 }], moreLines, number = "KB-0001" }) {
  const metadata = {};
  if (deliveryDate) metadata.delivery_date = deliveryDate;
  if (delivered) metadata.delivered_at = "2026-11-01T00:00:00Z";
  const invoice = {
    id, status, number, metadata,
    created: Math.floor(Date.now() / 1000) - 7200,
    customer_name: "Office Catering Co", customer_email: `${id}@example.com`, customer_phone: "650-555-0199",
    customer_shipping: { name: "Front desk", phone: "650-555-0198", address: { line1: "500 El Camino Real", city: "Menlo Park", state: "CA", postal_code: "94025" } },
    description: "Leave at reception",
    amount_paid: status === "paid" ? 8000 : 0, amount_due: 8000,
    lines: { data: lines, has_more: Boolean(moreLines) }
  };
  invoice.allLines = lines.concat(moreLines || []);
  invoices.push(invoice);
  return invoice;
}

beforeEach(() => {
  forgetStripeLists();
  invoices = [];
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

  if (method === "GET" && url.pathname === "/v1/invoices") {
    const status = params.get("status");
    assert.ok(["paid", "open"].includes(status), `asked for ${status} invoices`);
    return Response.json({ data: invoices.filter(invoice => invoice.status === status), has_more: false });
  }

  const invoiceLinesMatch = url.pathname.match(/^\/v1\/invoices\/(\w+)\/lines$/);
  if (method === "GET" && invoiceLinesMatch) {
    return Response.json({ data: invoices.find(({ id }) => id === invoiceLinesMatch[1]).allLines, has_more: false });
  }

  const invoiceMatch = url.pathname.match(/^\/v1\/invoices\/(\w+)$/);
  if (method === "GET" && invoiceMatch) {
    return Response.json(invoices.find(({ id }) => id === invoiceMatch[1]));
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

  const updateMatch = url.pathname.match(/^\/v1\/(payment_intents|customers|invoices)\/(\w+)$/);
  if (method === "POST" && updateMatch) {
    updates.push({ object: updateMatch[1], id: updateMatch[2], deliveredAt: params.get("metadata[delivered_at]"),
      ...(params.has("metadata[delivered_items]") ? { deliveredItems: params.get("metadata[delivered_items]") } : {}) });
    // Keep the saved metadata, so the next list shows it (empty values remove keys, like Stripe).
    const holder = updateMatch[1] === "invoices" ? invoices.find(({ id }) => id === updateMatch[2])
      : sessions.map(session => updateMatch[1] === "payment_intents" ? session.payment_intent : session.customer).find(object => object?.id === updateMatch[2]);
    if (holder) {
      for (const [key, value] of params) {
        const name = key.match(/^metadata\[(\w+)\]$/)?.[1];
        if (!name) continue;
        holder.metadata = { ...holder.metadata };
        if (value === "") delete holder.metadata[name]; else holder.metadata[name] = value;
      }
    }
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
  addOrder({ id: "cs_later", date: addDays(today, 5), items: "pesto:2" });
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
  assert.deepEqual(soon.items, [{ name: "House White", quantity: 1, delivered: 0 }, { name: "Croissourdough", quantity: 2, delivered: 0 }]);
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

  assert.deepEqual(body.orders[0].items, [{ name: "Elote", quantity: 2, delivered: 0 }, { name: "House White", quantity: 1, delivered: 0 }]);
  assert.equal(body.orders[0].loaves, 3);
});

test("prep adds up each loaf per delivery date", async () => {
  const cookie = await signIn();
  const day = addDays(today, 3);
  addOrder({ id: "cs_1", date: day, items: "house_white:2,pesto:1" });
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
    { name: "Pesto", quantity: 1 }
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

test("paid and sent invoices are listed with website orders; delivered, draft and void ones aren't", async () => {
  const cookie = await signIn();
  const day = addDays(today, 3);
  addOrder({ id: "cs_web", date: day, items: "house_white:1" });
  addInvoice({ id: "in_dated", deliveryDate: day, number: "KB-0007" });
  addInvoice({ id: "in_undated", status: "open", number: "KB-0008" });
  addInvoice({ id: "in_done", delivered: true });
  addInvoice({ id: "in_draft", status: "draft" });
  addInvoice({ id: "in_void", status: "void" });

  const { body } = await call("GET", "/admin/api/orders", { cookie });

  // Same day: oldest first (the invoice was created an hour before the web order).
  assert.deepEqual(body.orders.map(({ id }) => id), ["in_dated", "cs_web", "in_undated"]);
  const [dated, , undated] = body.orders;
  assert.equal(dated.kind, "invoice");
  assert.equal(dated.invoiceNumber, "KB-0007");
  assert.equal(dated.unpaid, false);
  assert.equal(dated.name, "Front desk");
  assert.equal(dated.address, "500 El Camino Real, Menlo Park, CA 94025");
  assert.equal(dated.notes, "Leave at reception");
  assert.equal(dated.totalCents, 8000);
  assert.equal(undated.unpaid, true);
  assert.equal(undated.deliveryDate, "");
  assert.equal(undated.deliveryLabel, "No delivery date set");
  assert.deepEqual(body.prep.map(({ date, total }) => ({ date, total })), [{ date: day, total: 5 }, { date: "", total: 4 }]);
});

test("invoice delivery, tip and fee lines don't count as loaves", async () => {
  const cookie = await signIn();
  addInvoice({
    id: "in_mixed",
    lines: [{ description: "Pesto", quantity: 10 }, { description: "Delivery fee", quantity: 1 }],
    moreLines: [{ description: "Tip", quantity: 1 }, { description: "Bacon & Cheddar", quantity: 5 }]
  });

  const { body } = await call("GET", "/admin/api/orders", { cookie });

  assert.deepEqual(body.orders[0].items, [{ name: "Pesto", quantity: 10, delivered: 0 }, { name: "Bacon & Cheddar", quantity: 5, delivered: 0 }]);
  assert.equal(body.orders[0].loaves, 15);
});

test("an invoice can be marked delivered and undone", async () => {
  const cookie = await signIn();
  addInvoice({ id: "in_a" });

  assert.equal((await call("POST", "/admin/api/orders/in_a/delivered", { cookie, body: { delivered: true } })).status, 200);
  assert.equal(updates[0].object, "invoices");
  assert.equal(updates[0].id, "in_a");
  assert.ok(updates[0].deliveredAt);

  await call("POST", "/admin/api/orders/in_a/delivered", { cookie, body: { delivered: false } });
  assert.deepEqual(updates[1], { object: "invoices", id: "in_a", deliveredAt: "" });
});

test("a draft or void invoice can't be marked delivered", async () => {
  const cookie = await signIn();
  addInvoice({ id: "in_draft", status: "draft" });
  assert.equal((await call("POST", "/admin/api/orders/in_draft/delivered", { cookie, body: { delivered: true } })).status, 400);
  assert.equal(updates.length, 0);
});

test("signing out clears the cookie", async () => {
  const { headers } = await call("POST", "/admin/api/logout", { body: {} });
  assert.match(headers.get("Set-Cookie"), /^kirana_admin=; Max-Age=0;/);
});

/* ---------- Partly delivered ---------- */

test("marking part of an order delivered keeps it on the list and takes those loaves out of prep", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_part", items: "house_white:3,pesto:2" });

  const saved = await call("POST", "/admin/api/orders/cs_part/partial", { cookie, body: { items: { "House White": 2, Pesto: 0 } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { ok: true, delivered: { "House White": 2 }, loavesDelivered: 2, loaves: 5, complete: false });
  assert.equal(updates.at(-1).object, "payment_intents");
  assert.equal(updates.at(-1).deliveredAt, "");

  const { body } = await call("GET", "/admin/api/orders", { cookie });
  const order = body.orders.find(({ id }) => id === "cs_part");
  assert.equal(order.loavesDelivered, 2);
  assert.deepEqual(order.items, [{ name: "House White", quantity: 3, delivered: 2 }, { name: "Pesto", quantity: 2, delivered: 0 }]);
  assert.deepEqual(body.prep[0].loaves, [{ name: "Pesto", quantity: 2 }, { name: "House White", quantity: 1 }]);
  assert.equal(body.prep[0].total, 3);
});

test("once every loaf is delivered, the order is marked delivered and leaves the list", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_done", items: "house_white:1,pesto:1" });
  await call("POST", "/admin/api/orders/cs_done/partial", { cookie, body: { items: { "House White": 1 } } });
  const last = await call("POST", "/admin/api/orders/cs_done/partial", { cookie, body: { items: { "House White": 1, Pesto: 1 } } });
  assert.equal(last.body.complete, true);
  assert.ok(updates.at(-1).deliveredAt);
  assert.equal((await call("GET", "/admin/api/orders", { cookie })).body.orders.some(({ id }) => id === "cs_done"), false);
});

test("partly delivered counts can't go above what was ordered, and can be cleared", async () => {
  const cookie = await signIn();
  addOrder({ id: "cs_check", items: "house_white:2" });
  const tooMany = await call("POST", "/admin/api/orders/cs_check/partial", { cookie, body: { items: { "House White": 3 } } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /0 to 2/);

  await call("POST", "/admin/api/orders/cs_check/partial", { cookie, body: { items: { "House White": 1 } } });
  await call("POST", "/admin/api/orders/cs_check/partial", { cookie, body: { items: { "House White": 0 } } });
  assert.equal(updates.at(-1).deliveredItems, "");
  const order = (await call("GET", "/admin/api/orders", { cookie })).body.orders.find(({ id }) => id === "cs_check");
  assert.equal(order.loavesDelivered, 0);
});

test("invoices can be partly delivered too", async () => {
  const cookie = await signIn();
  addInvoice({ id: "in_part", deliveryDate: addDays(today, 2), lines: [{ description: "Pesto", quantity: 10 }, { description: "Delivery fee", quantity: 1 }] });
  const saved = await call("POST", "/admin/api/orders/in_part/partial", { cookie, body: { items: { Pesto: 6 } } });
  assert.equal(saved.body.loaves, 10);
  assert.equal(updates.at(-1).object, "invoices");
  const order = (await call("GET", "/admin/api/orders", { cookie })).body.orders.find(({ id }) => id === "in_part");
  assert.equal(order.loavesDelivered, 6);
});

/*
  Moving a paid order to another day.
*/

const withDb = () => ({ ...env, DB: createFakeD1() });

test("a whole order can be moved to another delivery day", async () => {
  const cookie = await signIn();
  const useEnv = withDb();
  const from = addDays(today, 3);
  const to = addDays(today, 6);
  addOrder({ id: "cs_move", date: from, items: "house_white:2,pesto:1" });

  const moved = await call("POST", "/admin/api/orders/cs_move/move", { cookie, useEnv, body: { deliveryDate: to, items: { "House White": 2, Pesto: 1 } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.moved, 3);

  const { body } = await call("GET", "/admin/api/orders", { cookie, useEnv });
  assert.equal(body.orders.some(({ id }) => id === "cs_move"), false, "nothing left on the old day");
  const part = body.orders.find(({ kind }) => kind === "moved");
  assert.equal(part.deliveryDate, to);
  assert.equal(part.movedFrom, from);
  assert.equal(part.name, "Asha Rao");
  assert.equal(part.address, "1 Oak St, Menlo Park, CA 94025");
  assert.deepEqual(body.prep.map(({ date, total }) => [date, total]), [[to, 3]]);
  // Stripe isn't changed.
  assert.equal(updates.length, 0);
});

test("some loaves can be moved, and the rest stay on the order", async () => {
  const cookie = await signIn();
  const useEnv = withDb();
  const to = addDays(today, 5);
  addOrder({ id: "cs_split", items: "house_white:3,pesto:2" });

  await call("POST", "/admin/api/orders/cs_split/move", { cookie, useEnv, body: { deliveryDate: to, items: { "House White": 1 } } });
  const { body } = await call("GET", "/admin/api/orders", { cookie, useEnv });
  const left = body.orders.find(({ id }) => id === "cs_split");
  assert.deepEqual(left.items.map(({ name, quantity }) => [name, quantity]), [["House White", 2], ["Pesto", 2]]);
  assert.equal(left.loaves, 4);
  assert.deepEqual(left.movedTo, [{ label: body.orders.find(({ kind }) => kind === "moved").deliveryLabel, loaves: 1 }]);
  const part = body.orders.find(({ kind }) => kind === "moved");
  assert.deepEqual(part.items.map(({ name, quantity }) => [name, quantity]), [["House White", 1]]);

  // Moving the moved part back puts the loaf back on the order.
  const back = await call("POST", `/admin/api/orders/${part.id}/move`, { cookie, useEnv, body: { deliveryDate: left.deliveryDate, items: { "House White": 1 } } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const after = (await call("GET", "/admin/api/orders", { cookie, useEnv })).body;
  assert.equal(after.orders.some(({ kind }) => kind === "moved"), false);
  assert.equal(after.orders.find(({ id }) => id === "cs_split").loaves, 5);
});

test("a moved part can be delivered, partly delivered and emailed on its own", async () => {
  const cookie = await signIn();
  const useEnv = withDb();
  addOrder({ id: "cs_part2", items: "house_white:2,pesto:2" });
  await call("POST", "/admin/api/orders/cs_part2/move", { cookie, useEnv, body: { deliveryDate: addDays(today, 7), items: { Pesto: 2 } } });
  let part = (await call("GET", "/admin/api/orders", { cookie, useEnv })).body.orders.find(({ kind }) => kind === "moved");

  const partly = await call("POST", `/admin/api/orders/${part.id}/partial`, { cookie, useEnv, body: { items: { Pesto: 1 } } });
  assert.equal(partly.status, 200, JSON.stringify(partly.body));
  part = (await call("GET", "/admin/api/orders", { cookie, useEnv })).body.orders.find(({ id }) => id === part.id);
  assert.equal(part.loavesDelivered, 1);

  // Only the loaf not yet handed over can move again.
  const tooMany = await call("POST", `/admin/api/orders/${part.id}/move`, { cookie, useEnv, body: { deliveryDate: addDays(today, 8), items: { Pesto: 2 } } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /0 to 1/);

  const done = await call("POST", `/admin/api/orders/${part.id}/delivered`, { cookie, useEnv, body: { delivered: true } });
  assert.equal(done.status, 200);
  const list = (await call("GET", "/admin/api/orders", { cookie, useEnv })).body.orders;
  assert.equal(list.some(({ kind }) => kind === "moved"), false);
  // The original still has its two House White.
  assert.equal(list.find(({ id }) => id === "cs_part2").loaves, 2);
  assert.equal(updates.length, 0);
});

test("delivering the rest of a partly moved order completes it", async () => {
  const cookie = await signIn();
  const useEnv = withDb();
  addOrder({ id: "cs_rest", items: "house_white:2,pesto:1" });
  await call("POST", "/admin/api/orders/cs_rest/move", { cookie, useEnv, body: { deliveryDate: addDays(today, 7), items: { Pesto: 1 } } });
  const saved = await call("POST", "/admin/api/orders/cs_rest/partial", { cookie, useEnv, body: { items: { "House White": 2 } } });
  assert.equal(saved.body.complete, true);
  assert.equal(saved.body.loaves, 2);
});

test("moves are checked: a day, at least one loaf, not the same day, not past", async () => {
  const cookie = await signIn();
  const useEnv = withDb();
  const date = addDays(today, 3);
  addOrder({ id: "cs_bad", date, items: "house_white:2" });
  const cases = [
    [{ items: { "House White": 1 } }, /Pick a day/],
    [{ deliveryDate: addDays(today, 5), items: {} }, /at least one loaf/],
    [{ deliveryDate: date, items: { "House White": 1 } }, /already on that day/],
    [{ deliveryDate: addDays(today, -1), items: { "House White": 1 } }, /today or a day after/],
    [{ deliveryDate: addDays(today, 5), items: { "House White": 3 } }, /0 to 2/]
  ];
  for (const [body, error] of cases) {
    const result = await call("POST", "/admin/api/orders/cs_bad/move", { cookie, useEnv, body });
    assert.equal(result.status, 400);
    assert.match(result.body.error, error);
  }
  const noDb = await call("POST", "/admin/api/orders/cs_bad/move", { cookie, body: { deliveryDate: addDays(today, 5), items: { "House White": 1 } } });
  assert.equal(noDb.status, 400);
  assert.match(noDb.body.error, /database/);
});

test("capacity follows moves: loaves leave the old day and count on the new one", () => {
  const moves = [
    { partId: "mv_1", orderId: "cs_a", items: { "House White": 2 }, deliveryDate: "2026-11-20", dropId: "" },
    { partId: "mv_2", orderId: "cs_old", items: { Pesto: 1 }, deliveryDate: "2026-11-20", dropId: "" },
    { partId: "mv_3", orderId: "cs_b", items: { Pesto: 3 }, deliveryDate: "", dropId: "7" }
  ];
  const bookings = [{ id: "cs_a", date: "2026-11-15", created: 5, loaves: 3 }, { id: "cs_c", date: "2026-11-20", created: 6, loaves: 4 }];
  const counted = applyMoves(bookings, moves, { key: "date", wanted: new Set(["2026-11-15", "2026-11-20"]) });
  const byDate = date => counted.filter(booking => booking.date === date).reduce((sum, { loaves }) => sum + loaves, 0);
  assert.equal(byDate("2026-11-15"), 1);
  // Moved parts count even when their order is too old to be listed (cs_old).
  assert.equal(byDate("2026-11-20"), 7);
  assert.ok(counted.filter(({ status }) => status === "moved").every(({ invoice, created }) => invoice && created === 0));

  const drops = applyMoves([], moves, { key: "dropId", wanted: new Set(["7"]) });
  assert.deepEqual(drops.map(({ id, loaves }) => [id, loaves]), [["mv_3", 3]]);
});
