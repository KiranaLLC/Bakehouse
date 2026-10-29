/*
  Daily capacity tests. Run from the worker folder with: npm test

  Stripe and the address lookup are replaced with a fake in-memory version,
  so these never touch the network or a real Stripe account.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { DELIVERY, PRODUCTS } from "../../macros.js";
import { getDeliveryDates } from "../../delivery-rules.js";

const ORIGIN = "https://www.kiranabakehouse.com";
const env = { STRIPE_SECRET_KEY: "sk_test_fake", SITE_URL: ORIGIN, ALLOWED_ORIGINS: ORIGIN };
const [firstDate, secondDate] = getDeliveryDates().map(({ value }) => value);

let sessions;
let lineItems;
let nextId;
let stripeCalls;

function addSession({ date = firstDate, status = "complete", loaves, created = Math.floor(Date.now() / 1000) - 60 }) {
  const id = `cs_test_${nextId++}`;
  const metadata = { delivery_date: date };
  if (loaves !== undefined) metadata.loaf_count = String(loaves);
  sessions.push({ id, status, metadata, created });
  return id;
}

beforeEach(() => {
  sessions = [];
  lineItems = {};
  nextId = 1;
  stripeCalls = [];
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
    { description: PRODUCTS.margherita.name, quantity: 1 },
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
  assert.match(body.error, /only 2 loaves are left/);
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
