/*
  Pickup drop tests: scheduling drops on the orders page, the order page's
  drop list and notify sign-up, pickup checkout, and pickup orders on the
  orders page. Run from the worker folder with: npm test

  Stripe is faked in memory and the database is a local SQLite copy of
  schema.sql, so nothing here touches the network or a real account.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetStripeLists } from "../src/stripe-cache.js";

import checkoutWorker from "../src/index.js";
import ordersWorker from "../src/orders.js";
import { createFakeD1 } from "./fake-d1.js";
import { bakeryTodayValue, getDeliveryDates } from "../../delivery-rules.js";

const SITE = "https://www.kiranabakehouse.com";
const ORDERS = "https://kirana-orders.example.workers.dev";
const PASSWORD = "a long test password";

const today = bakeryTodayValue();
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const hoursFromNow = hours => new Date(Date.now() + hours * 36e5).toISOString();

let env;
let sessions;
let invoices;
let updates;
let beforeCreate;
let nextId;

beforeEach(() => {
  forgetStripeLists();
  env = { STRIPE_SECRET_KEY: "sk_test_fake", SITE_URL: SITE, ALLOWED_ORIGINS: SITE, ADMIN_PASSWORD: PASSWORD, DB: createFakeD1() };
  sessions = [];
  invoices = [];
  updates = [];
  beforeCreate = null;
  nextId = 1;
  globalThis.fetch = fakeStripe;
});

async function fakeStripe(input, init = {}) {

  const url = new URL(input);
  assert.equal(url.hostname, "api.stripe.com", `unexpected request to ${url.hostname}`);
  const method = init.method || "GET";
  const params = method === "GET" ? url.searchParams : new URLSearchParams(init.body);

  if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
    const status = params.get("status");
    const list = sessions.filter(session => !status || session.status === status).reverse();
    return Response.json({ data: list, has_more: false });
  }

  if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
    beforeCreate?.();
    beforeCreate = null;
    const metadata = {};
    for (const [key, value] of params) {
      const match = key.match(/^metadata\[(\w+)\]$/);
      if (match) metadata[match[1]] = value;
    }
    const id = `cs_test_${nextId++}`;
    sessions.push({ id, status: "open", payment_status: "unpaid", created: Math.floor(Date.now() / 1000), metadata, params });
    return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }

  if (method === "POST" && url.pathname === "/v1/coupons") {
    return Response.json({ id: "coupon_1" });
  }

  const expire = url.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)\/expire$/);
  if (method === "POST" && expire) {
    const session = sessions.find(({ id }) => id === expire[1]);
    if (!session || session.status !== "open") return Response.json({ error: { message: "nope" } }, { status: 400 });
    session.status = "expired";
    return Response.json(session);
  }

  const retrieve = url.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)$/);
  if (method === "GET" && retrieve) {
    const session = sessions.find(({ id }) => id === retrieve[1]);
    return Response.json({ ...session, payment_intent: session.payment_intent?.id || null, customer: null });
  }

  const update = url.pathname.match(/^\/v1\/payment_intents\/(\w+)$/);
  if (method === "POST" && update) {
    updates.push({ id: update[1], deliveredAt: params.get("metadata[delivered_at]") });
    return Response.json({});
  }

  if (method === "GET" && url.pathname === "/v1/invoices") {
    return Response.json({ data: invoices.filter(({ status }) => status === params.get("status")), has_more: false });
  }

  if (url.hostname === "api.stripe.com") {
    throw new Error(`Unexpected Stripe call: ${method} ${url.pathname}`);
  }

}

// A paid pickup order already in Stripe.
function paidPickup(dropId, loaves, extra = {}) {
  const id = `cs_test_${nextId++}`;
  sessions.push({
    id, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000) - 60, amount_total: loaves * 1600,
    customer_details: { email: `${id}@example.com` },
    payment_intent: { id: `pi_${id}`, metadata: {} },
    metadata: {
      fulfillment: "pickup", drop_id: String(dropId), pickup_date: extra.pickupDate || addDays(today, 5), pickup_label: "Saturday, 2 pm – 3 pm",
      pickup_location: "Verve Coffee Roasters, 162 University Ave, Palo Alto, CA 94301",
      loaf_count: String(loaves), items: `house_white:${loaves}`, customer_name: extra.name || "Pat Lee", customer_phone: "650-555-0101", tip_cents: "0"
    }
  });
  return id;
}

async function callCheckout(method, path, body) {
  const response = await checkoutWorker.fetch(new Request(`https://kirana-checkout.example.workers.dev${path}`, {
    method, headers: { Origin: SITE, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: response.status, body: await response.json() };
}

let cookie;

async function callOrders(method, path, body) {
  if (!cookie) {
    const login = await ordersWorker.fetch(new Request(`${ORDERS}/admin/api/login`, {
      method: "POST", headers: { Origin: ORDERS, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD })
    }), env);
    cookie = login.headers.get("Set-Cookie").split(";")[0];
  }
  const response = await ordersWorker.fetch(new Request(`${ORDERS}${path}`, {
    method, headers: { Origin: ORDERS, Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: response.status, body: await response.json() };
}

function dropInput(overrides = {}) {
  return {
    pickupDate: addDays(today, 5), windowStart: "14:00", windowEnd: "15:00",
    locationName: "Verve Coffee Roasters", locationAddress: "162 University Ave, Palo Alto, CA 94301", notes: "Outdoor seating",
    opensAt: hoursFromNow(-1), closesAt: hoursFromNow(48), loafLimit: 5, ...overrides
  };
}

async function makeDrop(overrides) {
  const { status, body } = await callOrders("POST", "/admin/api/drops", dropInput(overrides));
  assert.equal(status, 200, JSON.stringify(body));
  return body.drop;
}

function pickupOrder(dropId, loaves, extra = {}) {
  return {
    fulfillment: "pickup", dropId,
    items: [{ productId: "house_white", quantity: Math.min(loaves, 6) }, ...(loaves > 6 ? [{ productId: "pesto", quantity: loaves - 6 }] : [])],
    customer: { name: "Sam Rivera", phone: "650-555-0123" }, tipCents: 0, ...extra
  };
}

/* ---------- Without a database ---------- */

test("without the pickup database, pickup shows no drops and delivery still works", async () => {
  delete env.DB;
  assert.deepEqual((await callCheckout("GET", "/api/drops")).body, { available: false, drops: [] });
  assert.equal((await callCheckout("GET", "/api/capacity")).status, 200);
  assert.equal((await callCheckout("POST", "/api/subscribe", { email: "a@b.co" })).status, 400);
  const admin = await callOrders("GET", "/admin/api/drops");
  assert.equal(admin.body.databaseReady, false);
  assert.equal((await callOrders("POST", "/admin/api/drops", dropInput())).status, 503);
});

/* ---------- Scheduling drops ---------- */

test("the orders page creates, changes and cancels drops", async () => {
  const drop = await makeDrop();
  assert.equal(drop.loafLimit, 5);
  assert.equal(drop.locationName, "Verve Coffee Roasters");

  const changed = await callOrders("POST", `/admin/api/drops/${drop.id}`, dropInput({ loafLimit: 12, windowEnd: "15:30" }));
  assert.equal(changed.body.drop.loafLimit, 12);
  assert.equal(changed.body.drop.windowEnd, "15:30");

  const list = await callOrders("GET", "/admin/api/drops");
  assert.equal(list.body.drops[0].status, "open");
  assert.equal(list.body.drops[0].when, `${new Date(`${drop.pickupDate}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })}, 2 pm – 3:30 pm`);

  await callOrders("POST", `/admin/api/drops/${drop.id}/cancel`, { cancelled: true });
  assert.equal((await callOrders("GET", "/admin/api/drops")).body.drops[0].status, "cancelled");
  assert.equal((await callCheckout("GET", "/api/drops")).body.drops.length, 0);
});

test("opening and closing times from the orders page are read as bakery time", async () => {
  const drop = await makeDrop({ opensAt: undefined, closesAt: undefined, opensLocal: "2026-11-08T18:00", closesLocal: "2026-11-13T20:00" });
  assert.equal(drop.opensAt, "2026-11-09T02:00:00.000Z");
  assert.equal(drop.closesAt, "2026-11-14T04:00:00.000Z");
  assert.equal(drop.opensLocal, "2026-11-08T18:00");
  assert.equal(drop.closesLocal, "2026-11-13T20:00");
});

test("drops with mistakes are refused with a clear message", async () => {
  const cases = [
    [{ windowEnd: "13:00" }, /end after it starts/],
    [{ closesAt: hoursFromNow(-2) }, /close after it opens/],
    [{ loafLimit: 0 }, /loaf limit/],
    [{ locationName: "" }, /location/],
    [{ pickupDate: "next week" }, /pickup date/]
  ];
  for (const [overrides, message] of cases) {
    const { status, body } = await callOrders("POST", "/admin/api/drops", dropInput(overrides));
    assert.equal(status, 400);
    assert.match(body.error, message);
  }
});

/* ---------- The order page's drop list ---------- */

test("the order page sees each drop as upcoming, open, sold out or closed", async () => {
  const upcoming = await makeDrop({ opensAt: hoursFromNow(5), closesAt: hoursFromNow(50), pickupDate: addDays(today, 6) });
  const open = await makeDrop({ loafLimit: 5 });
  const soldOut = await makeDrop({ loafLimit: 3, pickupDate: addDays(today, 7) });
  await makeDrop({ closesAt: hoursFromNow(-0.5), opensAt: hoursFromNow(-3), pickupDate: addDays(today, 2) });
  paidPickup(open.id, 2);
  paidPickup(soldOut.id, 3);

  const { body } = await callCheckout("GET", "/api/drops");

  assert.equal(body.available, true);
  const byId = Object.fromEntries(body.drops.map(drop => [drop.id, drop]));
  assert.equal(body.drops.length, 3, "closed drops are hidden");
  assert.equal(byId[upcoming.id].status, "upcoming");
  assert.equal(byId[open.id].status, "open");
  assert.equal(byId[open.id].remaining, 3);
  assert.equal(byId[soldOut.id].status, "sold_out");
});

test("pickup orders don't use up delivery's daily limit", async () => {
  const date = getDeliveryDates()[0].value;
  const drop = await makeDrop({ pickupDate: date, loafLimit: 50 });
  paidPickup(drop.id, 12, { pickupDate: date });
  const capacity = await callCheckout("GET", "/api/capacity");
  assert.equal(capacity.body.dates.find(({ value }) => value === date).remaining, 10);
});

/* ---------- Pickup checkout ---------- */

test("a pickup order creates a Stripe payment with no address or delivery fee", async () => {
  const drop = await makeDrop();

  const { status, body } = await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 2, { tipCents: 300 }));

  assert.equal(status, 200, JSON.stringify(body));
  const { params, metadata } = sessions.at(-1);
  assert.equal(metadata.fulfillment, "pickup");
  assert.equal(metadata.drop_id, String(drop.id));
  assert.equal(metadata.pickup_date, drop.pickupDate);
  assert.equal(metadata.loaf_count, "2");
  assert.equal(metadata.items, "house_white:2");
  assert.equal(metadata.delivery_date, undefined);
  assert.equal(params.get("payment_intent_data[shipping][name]"), null);
  const lineNames = [...params].filter(([key]) => key.endsWith("[product_data][name]")).map(([, value]) => value);
  assert.deepEqual(lineNames, ["House White", "Tip for your baker"]);
  assert.match(params.get("custom_text[submit][message]"), /Pickup at Verve Coffee Roasters/);
});

test("pickup checkout is refused before a drop opens, after it closes, or when cancelled", async () => {
  const notYet = await makeDrop({ opensAt: hoursFromNow(3) });
  const over = await makeDrop({ opensAt: hoursFromNow(-5), closesAt: hoursFromNow(-1) });
  const cancelled = await makeDrop();
  await callOrders("POST", `/admin/api/drops/${cancelled.id}/cancel`, { cancelled: true });

  assert.match((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(notYet.id, 1))).body.error, /opens/);
  assert.match((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(over.id, 1))).body.error, /closed/);
  assert.match((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(cancelled.id, 1))).body.error, /isn't available/);
  assert.match((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(9999, 1))).body.error, /isn't available/);
  assert.equal(sessions.length, 0);
});

test("a drop's loaf limit counts paid orders and customers paying right now", async () => {
  const drop = await makeDrop({ loafLimit: 5 });
  paidPickup(drop.id, 2);
  assert.equal((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 2))).status, 200); // now 4 booked, 1 open hold

  const tooMany = await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 2));
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /can't fit your order of 2 loaves/);

  assert.equal((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 1))).status, 200);
  assert.match((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 1))).body.error, /sold out/);
});

test("an invoice with a drop_id takes loaves from that drop", async () => {
  const drop = await makeDrop({ loafLimit: 5 });
  invoices.push({ id: "in_party", status: "paid", metadata: { drop_id: String(drop.id), loaf_count: "4" }, lines: { data: [] } });

  const listed = (await callCheckout("GET", "/api/drops")).body.drops.find(({ id }) => id === drop.id);
  assert.equal(listed.remaining, 1);
  assert.match((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 2))).body.error, /can't fit/);
  assert.equal((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 1))).status, 200);
});

test("two customers racing for a drop's last loaves: the one who started paying first keeps them", async () => {
  const drop = await makeDrop({ loafLimit: 5 });
  beforeCreate = () => sessions.push({ id: "cs_test_rival", status: "open", created: Math.floor(Date.now() / 1000) - 60, metadata: { fulfillment: "pickup", drop_id: String(drop.id), loaf_count: "3" } });

  const late = await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 3));
  assert.equal(late.status, 400);
  assert.match(late.body.error, /can't fit your order of 3 loaves/);
  assert.equal(sessions.filter(({ status }) => status === "open").map(({ id }) => id).join(), "cs_test_rival");
});

test("coming back to change a pickup order releases the customer's own hold", async () => {
  const drop = await makeDrop({ loafLimit: 3 });
  const first = await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 3));
  const again = await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 3, { previousSessionId: first.body.id }));
  assert.equal(again.status, 200);
  assert.equal(sessions.find(({ id }) => id === first.body.id).status, "expired");
});

test("a pickup discount applies to the loaves only", async () => {
  env.DISCOUNT_CODES = "FRIENDS=50";
  const drop = await makeDrop();
  await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 2, { discountCode: "friends", tipCents: 1000 }));
  assert.equal(sessions.at(-1).metadata.discount_cents, "1200");
});

test("pickup orders get the delivery rules for loaves, name and phone", async () => {
  const drop = await makeDrop({ loafLimit: 50 });
  assert.equal((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 1, { customer: { name: "", phone: "650-555-0123" } }))).status, 400);
  assert.equal((await callCheckout("POST", "/api/create-checkout-session", pickupOrder(drop.id, 1, { customer: { name: "Sam", phone: "123" } }))).status, 400);
  assert.equal((await callCheckout("POST", "/api/create-checkout-session", { ...pickupOrder(drop.id, 1), items: [{ productId: "house_white", quantity: 7 }] })).status, 400);
});

/* ---------- Notify list ---------- */

test("customers can join the next-drop list, and the bakery can see and remove them", async () => {
  assert.equal((await callCheckout("POST", "/api/subscribe", { email: "Asha@Example.com", name: "Asha" })).status, 200);
  assert.equal((await callCheckout("POST", "/api/subscribe", { email: "asha@example.com" })).status, 200);
  assert.equal((await callCheckout("POST", "/api/subscribe", { email: "ben@example.com" })).status, 200);
  const bad = await callCheckout("POST", "/api/subscribe", { email: "not an email" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /valid email/);

  const list = (await callOrders("GET", "/admin/api/subscribers")).body.subscribers;
  assert.deepEqual(list.map(({ email }) => email).sort(), ["asha@example.com", "ben@example.com"]);
  assert.equal(list.find(({ email }) => email === "asha@example.com").name, "Asha", "a later sign-up without a name keeps the name");
  const drops = (await callOrders("GET", "/admin/api/drops")).body;
  assert.equal(drops.subscriberCount, 2);
  assert.deepEqual(drops.subscriberEmails.sort(), ["asha@example.com", "ben@example.com"]);

  await callOrders("POST", "/admin/api/subscribers/remove", { email: "BEN@example.com" });
  assert.deepEqual((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.map(({ email }) => email), ["asha@example.com"]);
});

/* ---------- Pickup orders on the orders page ---------- */

test("pickup orders appear on the orders page and in prep, and can be marked picked up", async () => {
  const drop = await makeDrop({ loafLimit: 20 });
  const id = paidPickup(drop.id, 3, { name: "Rae Kim" });

  const { body } = await callOrders("GET", "/admin/api/orders");
  const order = body.orders.find(o => o.id === id);
  assert.equal(order.fulfillment, "pickup");
  assert.equal(order.dropId, String(drop.id));
  assert.equal(order.deliveryDate, drop.pickupDate);
  assert.match(order.address, /Verve Coffee Roasters/);
  assert.equal(order.loaves, 3);
  assert.equal(body.prep.find(({ date }) => date === drop.pickupDate).total, 3);

  const listedDrop = (await callOrders("GET", "/admin/api/drops")).body.drops.find(({ id: dropId }) => dropId === drop.id);
  assert.equal(listedDrop.booked, 3);
  assert.equal(listedDrop.remaining, 17);

  assert.equal((await callOrders("POST", `/admin/api/orders/${id}/delivered`, { delivered: true })).status, 200);
  assert.equal(updates[0].id, `pi_${id}`);
});

test("the order summary after paying shows the pickup details", async () => {
  const drop = await makeDrop();
  const id = paidPickup(drop.id, 1);
  const session = sessions.find(s => s.id === id);
  session.line_items = { data: [{ description: "House White", quantity: 1, amount_subtotal: 1200 }] };
  session.amount_total = 1200;
  const { body } = await callCheckout("GET", `/api/order-summary?session_id=${id}`);
  assert.equal(body.fulfillment, "pickup");
  assert.match(body.address, /Verve Coffee Roasters/);
  assert.equal(body.deliveryDate, "Saturday, 2 pm – 3 pm");
});
