/*
  Email tests. The rule: the site NEVER sends an email on its own. Sign-ups,
  paid orders, gift card purchases and the hourly run send nothing; email
  only goes out when the bakery presses a send button on the orders page.
  Run from the worker folder with: npm test

  Resend and Stripe are faked in memory; the database is a local SQLite copy
  of schema.sql. Nothing here sends a real email.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetStripeLists } from "../src/stripe-cache.js";

import checkoutWorker, { isFromStripe } from "../src/index.js";
import ordersWorker from "../src/orders.js";
import { sendEmail, sendEmails } from "../src/email.js";
import { createFakeD1 } from "./fake-d1.js";
import { bakeryTodayValue } from "../../delivery-rules.js";

const SITE = "https://www.kiranabakehouse.com";
const CHECKOUT = "https://kirana-checkout.example.workers.dev";
const ORDERS = "https://kirana-orders.example.workers.dev";
const PASSWORD = "a long test password";
const WEBHOOK_SECRET = "whsec_test_secret";

const today = bakeryTodayValue();
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const hoursFromNow = hours => new Date(Date.now() + hours * 36e5).toISOString();

let env;
let sessions;
let emails;
let resendFails;

beforeEach(() => {
  forgetStripeLists();
  env = {
    STRIPE_SECRET_KEY: "sk_test_fake", SITE_URL: SITE, ALLOWED_ORIGINS: SITE, ADMIN_PASSWORD: PASSWORD,
    RESEND_API_KEY: "re_test_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: createFakeD1()
  };
  sessions = [];
  emails = [];
  resendFails = false;
  globalThis.fetch = fakeNetwork;
});

async function fakeNetwork(input, init = {}) {

  const url = new URL(input);
  const method = init.method || "GET";

  if (url.hostname === "api.resend.com") {
    assert.equal(init.headers.Authorization, "Bearer re_test_fake");
    if (resendFails) return Response.json({ message: "Resend is down" }, { status: 500 });
    const body = JSON.parse(init.body);
    emails.push(...(Array.isArray(body) ? body : [body]));
    return Response.json(url.pathname === "/emails/batch" ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" });
  }

  assert.equal(url.hostname, "api.stripe.com", `unexpected request to ${url.hostname}`);
  const params = method === "GET" ? url.searchParams : new URLSearchParams(init.body);

  if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
    const status = params.get("status");
    return Response.json({ data: sessions.filter(session => !status || session.status === status).reverse(), has_more: false });
  }

  const retrieve = url.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)$/);
  if (method === "GET" && retrieve) {
    const session = sessions.find(({ id }) => id === retrieve[1]);
    return Response.json({ ...session, payment_intent: { id: `pi_${session.id}`, metadata: {} } });
  }

  if (method === "GET" && url.pathname === "/v1/invoices") {
    return Response.json({ data: [], has_more: false });
  }

  throw new Error(`Unexpected Stripe call: ${method} ${url.pathname}`);

}

function paidOrder({ dropId, email = "pat@example.com", name = "Pat Lee", delivery = false } = {}) {
  const id = `cs_test_${sessions.length + 1}`;
  sessions.push({
    id, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000) - 60, amount_total: 3200,
    customer_details: { email },
    metadata: delivery
      ? { delivery_date: addDays(today, 3), delivery_date_label: "Friday, November 13", delivery_address: "1 Test St, Menlo Park, CA 94025", loaf_count: "2", items: "house_white:2", customer_name: name, customer_phone: "650-555-0100", tip_cents: "0" }
      : { fulfillment: "pickup", drop_id: String(dropId), pickup_date: addDays(today, 5), pickup_label: "Saturday, Nov 14, 2 pm – 3 pm", pickup_location: "Verve, 162 University Ave", loaf_count: "2", items: "house_white:1,pesto:1", customer_name: name, customer_phone: "650-555-0101", tip_cents: "300" }
  });
  return id;
}

async function callCheckout(method, path, body, headers = {}) {
  const response = await checkoutWorker.fetch(new Request(`${CHECKOUT}${path}`, {
    method, headers: { Origin: SITE, "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined
  }), env);
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed };
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

async function makeDrop(overrides = {}) {
  const { status, body } = await callOrders("POST", "/admin/api/drops", {
    pickupDate: addDays(today, 5), windowStart: "14:00", windowEnd: "15:00",
    locationName: "Verve Coffee Roasters", locationAddress: "162 University Ave, Palo Alto, CA 94301", notes: "Outdoor seating",
    opensAt: hoursFromNow(-1), closesAt: hoursFromNow(48), loafLimit: 20, ...overrides
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body.drop;
}

async function signUp(email) {
  const result = await callCheckout("POST", "/api/subscribe", { email });
  assert.equal(result.status, 200);
  return result;
}

async function runHourly() {
  const waits = [];
  await checkoutWorker.scheduled({ cron: "0 * * * *", scheduledTime: Date.now() }, env, { waitUntil: promise => waits.push(promise) });
  await Promise.allSettled(waits);
}

async function signedWebhook(event, { secret = WEBHOOK_SECRET, time = Math.floor(Date.now() / 1000) } = {}) {
  const payload = JSON.stringify(event);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${payload}`)));
  const signature = [...mac].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return callCheckout("POST", "/api/stripe-webhook", payload, { "Stripe-Signature": `t=${time},v1=${signature}` });
}

/* ---------- Nothing is ever sent automatically ---------- */

test("signing up sends nothing and joins the list straight away", async () => {
  const result = await signUp("Ana@Example.com");
  assert.equal(result.body.ok, true);
  assert.equal(result.body.confirm, undefined);
  assert.equal(emails.length, 0);
  assert.deepEqual((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.map(({ email }) => email), ["ana@example.com"]);
  await signUp("ana@example.com");
  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 1);
  assert.equal(emails.length, 0);
});

test("a paid order sends nothing, to the bakery or the customer", async () => {
  const id = paidOrder({ dropId: 3, name: "Sam Rivera", email: "sam@example.com" });
  const event = { type: "checkout.session.completed", data: { object: sessions.find(session => session.id === id) } };
  assert.equal((await signedWebhook(event)).status, 200);
  assert.equal((await signedWebhook(event)).status, 200);
  assert.equal(emails.length, 0);
});

test("webhook calls that aren't really from Stripe are refused", async () => {
  const event = { type: "checkout.session.completed", data: { object: { id: "cs_fake", payment_status: "paid", metadata: {} } } };
  assert.equal((await signedWebhook(event, { secret: "whsec_wrong" })).status, 400);
  assert.equal((await signedWebhook(event, { time: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  assert.equal((await callCheckout("POST", "/api/stripe-webhook", JSON.stringify(event))).status, 400);
  assert.equal(emails.length, 0);
  assert.equal(await isFromStripe("{}", "t=1,v1=00", "x"), false);
});

test("the hourly run sends nothing: no announcements, no reminders", async () => {
  await signUp("eve@example.com");
  const drop = await makeDrop();
  await makeDrop({ opensAt: hoursFromNow(-72), pickupDate: addDays(today, 1) });
  paidOrder({ dropId: drop.id, email: "hal@example.com" });
  emails = [];
  await runHourly();
  await runHourly();
  assert.equal(emails.length, 0);
});

test("the safety lock: nothing can be sent without a send button press, even by mistake", async () => {
  const message = { to: "x@example.com", subject: "Hi", text: "Hi" };
  await assert.rejects(sendEmail(env, message), /press a send button/);
  await assert.rejects(sendEmails(env, [message]), /press a send button/);
  assert.equal(emails.length, 0);
});

/* ---------- Send buttons on the orders page ---------- */

test("previews show the exact email and who it goes to, and send nothing", async () => {
  await signUp("pia@example.com");
  await signUp("quinn@example.com");
  const drop = await makeDrop();
  const order = paidOrder({ dropId: drop.id, email: "rae@example.com", name: "Rae Lin" });

  const announce = await callOrders("POST", `/admin/api/drops/${drop.id}/announce/preview`);
  assert.equal(announce.status, 200, JSON.stringify(announce.body));
  assert.deepEqual(announce.body.recipients.sort(), ["pia@example.com", "quinn@example.com"]);
  assert.match(announce.body.message.subject, /Pickup drop/);

  const remind = await callOrders("POST", `/admin/api/drops/${drop.id}/remind/preview`);
  assert.deepEqual(remind.body.recipients, ["rae@example.com"]);
  assert.match(remind.body.message.subject, /Reminder: your pickup/);

  const one = await callOrders("POST", `/admin/api/orders/${order}/email/preview`);
  assert.deepEqual(one.body.recipients, ["rae@example.com"]);
  assert.match(one.body.message.text, /^Hi Rae,/);

  assert.equal(emails.length, 0);
});

test("a drop is only announced when the orders page button is pressed", async () => {
  await signUp("quiet@example.com");
  const drop = await makeDrop();
  assert.equal(emails.length, 0);
  assert.equal((await callOrders("POST", `/admin/api/drops/${drop.id}/announce`)).body.sent, 1);
  assert.equal(emails.length, 1);
  await runHourly();
  assert.equal(emails.length, 1);
});

test("reminders only go out when the Remind button is pressed, once per customer", async () => {
  const drop = await makeDrop({ opensAt: hoursFromNow(-72) });
  paidOrder({ dropId: drop.id, email: "hal@example.com" });
  paidOrder({ dropId: drop.id, email: "HAL@example.com" });
  paidOrder({ dropId: drop.id, email: "ivy@example.com" });
  paidOrder({ dropId: 999, email: "other@example.com" });
  await runHourly();
  assert.equal(emails.length, 0);
  assert.equal((await callOrders("POST", `/admin/api/drops/${drop.id}/remind`)).body.sent, 2);
  assert.deepEqual(emails.map(({ to }) => to[0]).sort(), ["hal@example.com", "ivy@example.com"]);
  assert.match(emails[0].subject, /Reminder: your pickup/);
  const listed = (await callOrders("GET", "/admin/api/drops")).body.drops.find(({ id }) => id === drop.id);
  assert.equal(listed.reminded.recipients, 2);
});

test("if a reminder send fails, nothing is marked sent and pressing again sends it", async () => {
  const drop = await makeDrop({ opensAt: hoursFromNow(-72) });
  paidOrder({ dropId: drop.id, email: "try@example.com" });
  resendFails = true;
  assert.notEqual((await callOrders("POST", `/admin/api/drops/${drop.id}/remind`)).status, 200);
  resendFails = false;
  assert.equal((await callOrders("POST", `/admin/api/drops/${drop.id}/remind`)).body.sent, 1);
  assert.equal(emails.length, 1);
});

test("each drop email has a working one-click unsubscribe link", async () => {
  await signUp("dee@example.com");
  const drop = await makeDrop();
  emails = [];

  const sent = await callOrders("POST", `/admin/api/drops/${drop.id}/announce`);
  assert.deepEqual(sent.body, { ok: true, sent: 1 });
  const email = emails[0];
  assert.match(email.subject, /Pickup drop/);
  assert.match(email.text, /Order here: https:\/\/www\.kiranabakehouse\.com\/order\.html\?pickup/);
  const link = email.headers["List-Unsubscribe"].slice(1, -1);
  assert.ok(email.text.includes(link));

  const local = link.replace(/^https:\/\/[^/]+/, CHECKOUT);

  // Opening the link (as a mail scanner would) only asks.
  const ask = await checkoutWorker.fetch(new Request(local), env);
  assert.match(await ask.text(), /<form method="post"/);
  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 1);

  // A mail app's one-click unsubscribe POSTs to the same link.
  const oneClick = await checkoutWorker.fetch(new Request(local, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), env);
  assert.equal(oneClick.status, 200);
  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 0);
});

test("the Unsubscribe button on the page takes someone off the list", async () => {
  await signUp("eli@example.com");
  const drop = await makeDrop();
  await callOrders("POST", `/admin/api/drops/${drop.id}/announce`);
  const local = emails.at(-1).headers["List-Unsubscribe"].slice(1, -1).replace(/^https:\/\/[^/]+/, CHECKOUT);
  const done = await checkoutWorker.fetch(new Request(local, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "" }), env);
  assert.match(await done.text(), /You're unsubscribed/);
  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 0);
});

/* ---------- Orders page: email a customer ---------- */

test("the orders page emails a customer directly and remembers when", async () => {
  const delivery = paidOrder({ delivery: true, email: "jo@example.com", name: "Jo Park" });
  const drop = await makeDrop();
  const pickup = paidOrder({ dropId: drop.id, email: "kai@example.com", name: "Kai Moss" });

  assert.equal((await callOrders("POST", `/admin/api/orders/${delivery}/email`)).body.ok, true);
  assert.equal((await callOrders("POST", `/admin/api/orders/${pickup}/email`)).body.ok, true);

  assert.deepEqual(emails[0].to, ["jo@example.com"]);
  assert.match(emails[0].subject, /has been delivered/);
  assert.match(emails[0].text, /^Hi Jo,/);
  assert.match(emails[0].text, /2 × House White/);
  assert.deepEqual(emails[1].to, ["kai@example.com"]);
  assert.match(emails[1].subject, /ready for pickup/);
  assert.match(emails[1].text, /Where: Verve Coffee Roasters, 162 University Ave, Palo Alto, CA 94301/);
  assert.match(emails[1].text, /Outdoor seating/);
  assert.match(emails[1].text, /Call or text \(408\) 548-7856/);

  const listed = await callOrders("GET", "/admin/api/orders");
  assert.equal(listed.body.emailReady, true);
  assert.ok(listed.body.orders.find(({ id }) => id === delivery).emailedAt);
});

test("without email set up, the orders page's send buttons say to use the draft", async () => {
  delete env.RESEND_API_KEY;
  const id = paidOrder({ delivery: true });
  const result = await callOrders("POST", `/admin/api/orders/${id}/email`);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /draft/);
  assert.equal((await callOrders("GET", "/admin/api/orders")).body.emailReady, false);
});

test("before schema.sql is re-run, the send buttons say what to do instead of failing", async () => {
  const drop = await makeDrop();
  paidOrder({ dropId: drop.id });
  await env.DB.prepare("DROP TABLE email_log").run();
  const result = await callOrders("POST", `/admin/api/drops/${drop.id}/remind`);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /schema\.sql/);
  assert.equal(emails.length, 0);
});
