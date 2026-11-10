/*
  Daily capacity tests. Run from the worker folder with: npm test

  Stripe and the address lookup are replaced with a fake in-memory version,
  so these never touch the network or a real Stripe account.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetStripeLists } from "../src/stripe-cache.js";

import worker from "../src/index.js";
import { DELIVERY, PRODUCTS } from "../../macros.js";
import { placeInLine } from "../src/capacity.js";
import { getDeliveryDates } from "../../delivery-rules.js";

const ORIGIN = "https://www.kiranabakehouse.com";
const env = { STRIPE_SECRET_KEY: "sk_test_fake", SITE_URL: ORIGIN, ALLOWED_ORIGINS: ORIGIN };
const [firstDate, secondDate] = getDeliveryDates().map(({ value }) => value);

let sessions;
let invoices;
let lineItems;
let nextId;
let stripeCalls;
let beforeCreate;   // runs just before a payment page is created: another customer racing in

function addSession({ date = firstDate, status = "complete", loaves, created = Math.floor(Date.now() / 1000) - 60 }) {
  const id = `cs_test_${nextId++}`;
  const metadata = { delivery_date: date };
  if (loaves !== undefined) metadata.loaf_count = String(loaves);
  sessions.push({ id, status, metadata, created });
  return id;
}

beforeEach(() => {
  forgetStripeLists();
  sessions = [];
  invoices = [];
  lineItems = {};
  nextId = 1;
  stripeCalls = [];
  beforeCreate = null;
  globalThis.fetch = fakeFetch;
});

async function fakeFetch(input, init = {}) {

  const url = new URL(input);

  if (url.hostname === "nominatim.openstreetmap.org") {
    // Everything geocodes to the kitchen's neighbourhood: inside the first zone.
    return Response.json([{ lat: "37.4530", lon: "-122.1817" }]);
  }

  assert.equal(url.hostname, "api.stripe.com");
  const method = init.method || "GET";
  const params = method === "GET" ? url.searchParams : new URLSearchParams(init.body);
  stripeCalls.push({ method, path: url.pathname, params });

  if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
    const since = Number(params.get("created[gte]"));
    const limit = Number(params.get("limit"));
    const after = params.get("starting_after");
    let matching = sessions.filter(session => session.created >= since).reverse(); // newest first, like Stripe
    if (after) matching = matching.slice(matching.findIndex(({ id }) => id === after) + 1);
    return Response.json({ data: matching.slice(0, limit), has_more: matching.length > limit });
  }

  if (method === "GET" && url.pathname === "/v1/invoices") {
    return Response.json({ data: invoices.filter(({ status }) => status === params.get("status")), has_more: false });
  }

  const lineItemsMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)\/line_items$/);
  if (method === "GET" && lineItemsMatch) {
    return Response.json({ data: lineItems[lineItemsMatch[1]] || [], has_more: false });
  }

  const expireMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)\/expire$/);
  if (method === "POST" && expireMatch) {
    const session = sessions.find(({ id }) => id === expireMatch[1]);
    if (!session || session.status !== "open") {
      return Response.json({ error: { message: "Only open sessions can be expired." } }, { status: 400 });
    }
    session.status = "expired";
    return Response.json(session);
  }

  if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
    beforeCreate?.();
    beforeCreate = null;
    const id = addSession({ date: params.get("metadata[delivery_date]"), status: "open", loaves: Number(params.get("metadata[loaf_count]")) });
    return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }

  throw new Error(`Unexpected Stripe call: ${method} ${url.pathname}`);

}

async function call(method, path, body) {
  const request = new Request(`https://worker.example${path}`, {
    method,
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json() };
}

function order(loaves, extra = {}) {
  return {
    items: [{ productId: "house_white", quantity: Math.min(loaves, 6) }, ...(loaves > 6 ? [{ productId: "birthday", quantity: loaves - 6 }] : [])],
    deliveryDate: firstDate,
    customer: { name: "Test Customer", phone: "650-555-0100" },
    address: { line1: "1 Test Street", city: "Menlo Park", postalCode: "94025" },
    tipCents: 0,
    ...extra
  };
}

function remainingOn(capacity, date) {
  return capacity.dates.find(({ value }) => value === date).remaining;
}

test("the limit is 10 loaves a day", () => {
  assert.equal(DELIVERY.dailyLoafLimit, 10);
});

test("capacity counts paid and in-progress orders, not expired ones", async () => {
  addSession({ status: "complete", loaves: 4 });
  addSession({ status: "open", loaves: 3 });
  addSession({ status: "expired", loaves: 5 });
  addSession({ date: secondDate, status: "complete", loaves: 6 });

  const { status, body } = await call("GET", "/api/capacity");

  assert.equal(status, 200);
  assert.equal(body.limit, 10);
  assert.equal(remainingOn(body, firstDate), 3);
  assert.equal(remainingOn(body, secondDate), 4);
});

test("orders placed before loaf_count existed are counted from their line items", async () => {
  const id = addSession({ status: "complete" });
  lineItems[id] = [
    { description: PRODUCTS.house_white.name, quantity: 2 },
    { description: PRODUCTS.pesto.name, quantity: 1 },
    { description: "Local delivery", quantity: 1 },
    { description: "Tip for your baker", quantity: 1 }
  ];

  const { body } = await call("GET", "/api/capacity");

  assert.equal(remainingOn(body, firstDate), 7);
});

test("remaining never goes below zero", async () => {
  addSession({ status: "complete", loaves: 12 });
  const { body } = await call("GET", "/api/capacity");
  assert.equal(remainingOn(body, firstDate), 0);
});

test("capacity reads every page of sessions", async () => {
  for (let i = 0; i < 101; i++) addSession({ date: secondDate, status: "expired", loaves: 1 });
  addSession({ status: "complete", loaves: 9 }); // newest, so on the first page
  sessions.unshift({ id: "cs_test_oldest", status: "complete", metadata: { delivery_date: firstDate, loaf_count: "1" }, created: Math.floor(Date.now() / 1000) - 120 });

  const { body } = await call("GET", "/api/capacity");

  assert.equal(remainingOn(body, firstDate), 0);
  assert.equal(stripeCalls.filter(({ path }) => path === "/v1/checkout/sessions").length, 2);
});

test("exclude ignores the customer's own unfinished payment, but not a paid one", async () => {
  const open = addSession({ status: "open", loaves: 4 });
  const paid = addSession({ status: "complete", loaves: 2 });

  assert.equal(remainingOn((await call("GET", `/api/capacity?exclude=${open}`)).body, firstDate), 8);
  assert.equal(remainingOn((await call("GET", `/api/capacity?exclude=${paid}`)).body, firstDate), 4);
});

test("checkout is refused when the day doesn't have enough loaves left", async () => {
  addSession({ status: "complete", loaves: 8 });

  const { status, body } = await call("POST", "/api/create-checkout-session", order(3));

  assert.equal(status, 400);
  assert.match(body.error, /can't fit your order of 3 loaves/);
  assert.doesNotMatch(body.error, /\b2\b/, "doesn't reveal how many are left");
  assert.equal(stripeCalls.some(({ method, path }) => method === "POST" && path === "/v1/checkout/sessions"), false);
});

test("checkout is refused on a fully booked day", async () => {
  addSession({ status: "complete", loaves: 10 });
  const { status, body } = await call("POST", "/api/create-checkout-session", order(1));
  assert.equal(status, 400);
  assert.match(body.error, /fully booked/);
});

test("checkout that fits is created with a loaf count and a short expiry", async () => {
  addSession({ status: "complete", loaves: 8 });

  const before = Math.floor(Date.now() / 1000);
  const { status, body } = await call("POST", "/api/create-checkout-session", order(2));

  assert.equal(status, 200);
  assert.match(body.id, /^cs_test_/);
  const created = stripeCalls.find(({ method, path }) => method === "POST" && path === "/v1/checkout/sessions").params;
  assert.equal(created.get("metadata[loaf_count]"), "2");
  assert.equal(created.get("payment_intent_data[metadata][loaf_count]"), "2");
  assert.equal(created.get("metadata[items]"), "house_white:2");
  const expiresIn = Number(created.get("expires_at")) - before;
  assert.ok(expiresIn >= 30 * 60 && expiresIn <= 32 * 60, `expires in ${expiresIn}s`);
});

test("a customer who comes back to change their order isn't blocked by their own hold", async () => {
  addSession({ status: "complete", loaves: 4 });
  const previous = addSession({ status: "open", loaves: 6 });

  const { status } = await call("POST", "/api/create-checkout-session", order(6, { previousSessionId: previous }));

  assert.equal(status, 200);
  assert.equal(sessions.find(({ id }) => id === previous).status, "expired");
});

test("a paid order passed as previousSessionId still counts", async () => {
  const paid = addSession({ status: "complete", loaves: 6 });

  const { status } = await call("POST", "/api/create-checkout-session", order(6, { previousSessionId: paid }));

  assert.equal(status, 400);
});

test("sent and paid invoices on a delivery day use up its loaves; drafts don't", async () => {
  invoices.push(
    { id: "in_paid", status: "paid", metadata: { delivery_date: firstDate }, lines: { data: [{ description: "Catering loaves", quantity: 4 }, { description: "Delivery fee", quantity: 1 }] } },
    { id: "in_sent", status: "open", metadata: { delivery_date: firstDate, loaf_count: "3" }, lines: { data: [{ description: "Party order", quantity: 1 }] } },
    { id: "in_draft", status: "draft", metadata: { delivery_date: firstDate }, lines: { data: [{ description: "Loaves", quantity: 5 }] } },
    { id: "in_undated", status: "paid", metadata: {}, lines: { data: [{ description: "Loaves", quantity: 5 }] } }
  );

  const { body } = await call("GET", "/api/capacity");
  assert.equal(remainingOn(body, firstDate), 3);

  const refused = await call("POST", "/api/create-checkout-session", order(4));
  assert.equal(refused.status, 400);

  const accepted = await call("POST", "/api/create-checkout-session", order(3));
  assert.equal(accepted.status, 200);
});

test("the order page's counts are remembered briefly, but checkout always asks Stripe fresh", async () => {
  addSession({ status: "complete", loaves: 4 });
  const sessionLists = () => stripeCalls.filter(({ method, path }) => method === "GET" && path === "/v1/checkout/sessions").length;

  await call("GET", "/api/capacity");
  await call("GET", "/api/capacity");
  assert.equal(sessionLists(), 1);

  // Someone else books 6 more loaves; the remembered count doesn't know yet...
  addSession({ status: "complete", loaves: 6 });
  assert.equal(remainingOn((await call("GET", "/api/capacity")).body, firstDate), 6);

  // ...but checkout counts fresh and refuses.
  const refused = await call("POST", "/api/create-checkout-session", order(1));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /fully booked/);
});

test("starting a payment makes the next count fresh", async () => {
  await call("GET", "/api/capacity");
  assert.equal((await call("POST", "/api/create-checkout-session", order(3))).status, 200);
  assert.equal(remainingOn((await call("GET", "/api/capacity")).body, firstDate), 7);
});

test("when two customers race for the last loaves, the one who started paying first keeps them", async () => {
  addSession({ status: "complete", loaves: 6 });

  // Both pass the check with 4 left; the other customer's payment page is created a moment earlier.
  beforeCreate = () => addSession({ status: "open", loaves: 3, created: Math.floor(Date.now() / 1000) - 120 });

  const late = await call("POST", "/api/create-checkout-session", order(4));
  assert.equal(late.status, 400);
  assert.match(late.body.error, /can't fit your order of 4 loaves/);

  const pages = sessions.filter(({ metadata }) => metadata.loaf_count === "4");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].status, "expired", "the later page is ended so it holds nothing");
  assert.equal(remainingOn((await call("GET", "/api/capacity")).body, firstDate), 1);
});

test("a customer who started paying first isn't turned away by someone racing in after", async () => {
  addSession({ status: "complete", loaves: 6 });
  beforeCreate = () => addSession({ status: "open", loaves: 3, created: Math.floor(Date.now() / 1000) + 120 });

  const first = await call("POST", "/api/create-checkout-session", order(4));
  assert.equal(first.status, 200);
  assert.equal(sessions.find(({ id }) => id === first.body.id).status, "open");
});

test("pages made in the same second each count the other as ahead, so they can't both overfill a day", () => {
  const bookings = [{ id: "cs_paid", created: 90, loaves: 0 }, { id: "cs_b", created: 100, loaves: 6 }, { id: "cs_a", created: 100, loaves: 6 }];
  assert.equal(placeInLine(bookings, "cs_a", 10).fits, false);
  assert.equal(placeInLine(bookings, "cs_b", 10).fits, false);
  // A page made a second later never counts against an earlier one.
  assert.equal(placeInLine([{ id: "cs_b", created: 100, loaves: 6 }, { id: "cs_a", created: 101, loaves: 6 }], "cs_b", 10).fits, true);
  // Invoices always count.
  assert.deepEqual(placeInLine([{ id: "in_1", created: 0, loaves: 5, invoice: true }, { id: "cs_a", created: 100, loaves: 6 }], "cs_a", 10), { ahead: 5, fits: false });
});

test("a customer's own just-ended page doesn't count against their new one, even if Stripe still lists it", async () => {
  const first = await call("POST", "/api/create-checkout-session", order(6));
  assert.equal(first.status, 200);
  // Stripe hasn't caught up: ending the old page "works" but the list still shows it open.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if ((init.method || "GET") === "POST" && url.pathname.endsWith("/expire")) return Response.json({ id: first.body.id, status: "expired" });
    return realFetch(input, init);
  };
  const again = await call("POST", "/api/create-checkout-session", order(6, { previousSessionId: first.body.id }));
  globalThis.fetch = realFetch;
  assert.equal(again.status, 200, JSON.stringify(again.body));
});
