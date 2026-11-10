/*
  Email tests: next-drop sign-up with a confirm link, unsubscribe links, the
  Stripe "order paid" webhook, the hourly drop emails, and the orders page's
  send buttons. Run from the worker folder with: npm test

  Resend and Stripe are faked in memory; the database is a local SQLite copy
  of schema.sql. Nothing here sends a real email.
*/

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetStripeLists } from "../src/stripe-cache.js";

import checkoutWorker, { isFromStripe } from "../src/index.js";
import ordersWorker from "../src/orders.js";
import { runScheduledEmails } from "../src/email-flows.js";
import { stripe } from "../src/stripe.js";
import { createFakeD1 } from "./fake-d1.js";
import { bakeryTodayValue } from "../../delivery-rules.js";
import { dayBefore, localToUtc } from "../../pickup-rules.js";

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

async function signUpAndConfirm(email) {
  const signUp = await callCheckout("POST", "/api/subscribe", { email });
  assert.equal(signUp.body.confirm, true);
  const link = emails.at(-1).text.match(/https:\/\/\S+\/api\/subscribe\/confirm\?token=\S+/)[0];
  const confirmed = await checkoutWorker.fetch(new Request(link), env);
  assert.equal(confirmed.status, 200);
  return link;
}

async function signedWebhook(event, { secret = WEBHOOK_SECRET, time = Math.floor(Date.now() / 1000) } = {}) {
  const payload = JSON.stringify(event);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${payload}`)));
  const signature = [...mac].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return callCheckout("POST", "/api/stripe-webhook", payload, { "Stripe-Signature": `t=${time},v1=${signature}` });
}

/* ---------- Sign-up, confirm, unsubscribe ---------- */

test("with email on, signing up sends a confirm link, and only confirmed people are on the list", async () => {
  const signUp = await callCheckout("POST", "/api/subscribe", { email: "Ana@Example.com" });
  assert.deepEqual(signUp.body, { ok: true, confirm: true });
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ["ana@example.com"]);
  assert.equal(emails[0].reply_to, "hellokiranabakehouse@gmail.com");
  assert.match(emails[0].text, /\/api\/subscribe\/confirm\?token=/);

  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 0);

  const link = emails[0].text.match(/https:\/\/\S+\/api\/subscribe\/confirm\?token=\S+/)[0];
  const page = await checkoutWorker.fetch(new Request(link), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /on the list/);
  assert.deepEqual((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.map(({ email }) => email), ["ana@example.com"]);

  // The same link again, or a made-up one, doesn't work.
  assert.equal((await checkoutWorker.fetch(new Request(link), env)).status, 404);
  assert.equal((await checkoutWorker.fetch(new Request(`${CHECKOUT}/api/subscribe/confirm?token=nope`), env)).status, 404);
});

test("without email set up, signing up joins the list straight away", async () => {
  delete env.RESEND_API_KEY;
  const signUp = await callCheckout("POST", "/api/subscribe", { email: "ben@example.com" });
  assert.equal(signUp.body.confirm, undefined);
  assert.equal(emails.length, 0);
  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 1);
});

test("no extra email for someone already on the list, or asked again within minutes, and the answer doesn't tell", async () => {
  await signUpAndConfirm("cy@example.com");
  emails = [];
  const again = await callCheckout("POST", "/api/subscribe", { email: "cy@example.com" });
  assert.deepEqual(again.body, { ok: true, confirm: true });
  assert.equal(emails.length, 0);

  await callCheckout("POST", "/api/subscribe", { email: "new@example.com" });
  await callCheckout("POST", "/api/subscribe", { email: "new@example.com" });
  await callCheckout("POST", "/api/subscribe", { email: "new@example.com" });
  assert.equal(emails.length, 1);
});

test("confirm links stop working after 14 days", async () => {
  await callCheckout("POST", "/api/subscribe", { email: "old@example.com" });
  const link = emails[0].text.match(/https:\/\/\S+\/api\/subscribe\/confirm\?token=\S+/)[0];
  await env.DB.prepare("UPDATE pending_subscribers SET created_at = ?1").bind(new Date(Date.now() - 15 * 864e5).toISOString()).run();
  assert.equal((await checkoutWorker.fetch(new Request(link), env)).status, 404);
});

test("each drop email has a working one-click unsubscribe link", async () => {
  await signUpAndConfirm("dee@example.com");
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
  await signUpAndConfirm("eli@example.com");
  const drop = await makeDrop();
  await callOrders("POST", `/admin/api/drops/${drop.id}/announce`);
  const local = emails.at(-1).headers["List-Unsubscribe"].slice(1, -1).replace(/^https:\/\/[^/]+/, CHECKOUT);
  const done = await checkoutWorker.fetch(new Request(local, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "" }), env);
  assert.match(await done.text(), /You're unsubscribed/);
  assert.equal((await callOrders("GET", "/admin/api/subscribers")).body.subscribers.length, 0);
});

/* ---------- New-order alert (Stripe webhook) ---------- */

test("a paid order emails the bakery once, even if Stripe sends the event twice", async () => {
  const id = paidOrder({ dropId: 3, name: "Sam Rivera" });
  const event = { type: "checkout.session.completed", data: { object: sessions.find(session => session.id === id) } };

  assert.equal((await signedWebhook(event)).status, 200);
  assert.equal((await signedWebhook(event)).status, 200);

  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ["hellokiranabakehouse@gmail.com"]);
  assert.match(emails[0].subject, /New pickup order: Sam Rivera, Saturday, Nov 14, 2 pm – 3 pm \(2 loaves\)/);
  assert.match(emails[0].text, /1 × House White/);
  assert.match(emails[0].text, /Paid: \$32\.00 \(incl\. \$3\.00 tip\)/);
});

test("webhook calls that aren't really from Stripe are refused", async () => {
  const event = { type: "checkout.session.completed", data: { object: { id: "cs_fake", payment_status: "paid", metadata: {} } } };
  assert.equal((await signedWebhook(event, { secret: "whsec_wrong" })).status, 400);
  assert.equal((await signedWebhook(event, { time: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  assert.equal((await callCheckout("POST", "/api/stripe-webhook", JSON.stringify(event))).status, 400);
  assert.equal(emails.length, 0);
  assert.equal(await isFromStripe("{}", "t=1,v1=00", "x"), false);
});

test("if the alert email fails, Stripe is asked to try again and the retry sends it", async () => {
  const id = paidOrder({ delivery: true });
  const event = { type: "checkout.session.completed", data: { object: sessions.find(session => session.id === id) } };
  resendFails = true;
  assert.equal((await signedWebhook(event)).status, 500);
  resendFails = false;
  assert.equal((await signedWebhook(event)).status, 200);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /New delivery order/);
});

/* ---------- Hourly drop emails ---------- */

test("the hourly run announces a newly opened drop to the list, once", async () => {
  await signUpAndConfirm("eve@example.com");
  await signUpAndConfirm("fay@example.com");
  await makeDrop();
  emails = [];

  assert.deepEqual(await runScheduledEmails(env, stripe), { announced: 2, reminded: 0 });
  assert.equal(emails.length, 2);
  assert.match(emails[0].text, /Ordering is open now/);

  assert.deepEqual(await runScheduledEmails(env, stripe), { announced: 0, reminded: 0 });
  assert.equal(emails.length, 2);
});

test("drops that opened days ago, or haven't opened, aren't announced by the schedule", async () => {
  await signUpAndConfirm("gus@example.com");
  await makeDrop({ opensAt: hoursFromNow(-72) });
  await makeDrop({ pickupDate: addDays(today, 9), opensAt: hoursFromNow(5), closesAt: hoursFromNow(80) });
  emails = [];
  assert.deepEqual(await runScheduledEmails(env, stripe), { announced: 0, reminded: 0 });
});

test("pickup reminders go to that drop's customers from 5 pm the day before, once each", async () => {
  const drop = await makeDrop({ opensAt: hoursFromNow(-72) });
  paidOrder({ dropId: drop.id, email: "hal@example.com" });
  paidOrder({ dropId: drop.id, email: "HAL@example.com" });
  paidOrder({ dropId: drop.id, email: "ivy@example.com" });
  paidOrder({ dropId: 999, email: "other@example.com" });
  emails = [];

  const dayBeforePickup = dayBefore(drop.pickupDate);
  const fourPm = Date.parse(localToUtc(dayBeforePickup, "16:00"));
  const sixPm = Date.parse(localToUtc(dayBeforePickup, "18:00"));

  assert.equal((await runScheduledEmails(env, stripe, fourPm)).reminded, 0);
  assert.equal((await runScheduledEmails(env, stripe, sixPm)).reminded, 2);
  assert.deepEqual(emails.map(({ to }) => to[0]).sort(), ["hal@example.com", "ivy@example.com"]);
  assert.match(emails[0].subject, /Reminder: your pickup/);
  assert.equal((await runScheduledEmails(env, stripe, sixPm + 36e5)).reminded, 0);
});

test("a reminder sent from the orders page isn't sent again by the schedule", async () => {
  const drop = await makeDrop({ opensAt: hoursFromNow(-72) });
  paidOrder({ dropId: drop.id });
  emails = [];
  assert.equal((await callOrders("POST", `/admin/api/drops/${drop.id}/remind`)).body.sent, 1);
  assert.equal((await runScheduledEmails(env, stripe, Date.parse(localToUtc(dayBefore(drop.pickupDate), "18:00")))).reminded, 0);
  assert.equal(emails.length, 1);

  const listed = (await callOrders("GET", "/admin/api/drops")).body.drops.find(({ id }) => id === drop.id);
  assert.equal(listed.reminded.recipients, 1);
  assert.equal(listed.customerCount, 1);
});

test("without email set up, the schedule sends nothing", async () => {
  delete env.RESEND_API_KEY;
  await makeDrop();
  assert.deepEqual(await runScheduledEmails(env, stripe), { announced: 0, reminded: 0 });
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

test("people who join the list after a drop's email went out still get it on the next hourly run", async () => {
  await signUpAndConfirm("first@example.com");
  await makeDrop();
  emails = [];
  assert.equal((await runScheduledEmails(env, stripe)).announced, 1);
  await signUpAndConfirm("later@example.com");
  emails = [];
  assert.equal((await runScheduledEmails(env, stripe)).announced, 1);
  assert.deepEqual(emails[0].to, ["later@example.com"]);
});

test("customers who order after the reminders went out get one too, until pickup ends", async () => {
  const drop = await makeDrop({ opensAt: hoursFromNow(-72) });
  paidOrder({ dropId: drop.id, email: "early@example.com" });
  emails = [];
  assert.equal((await runScheduledEmails(env, stripe, Date.parse(localToUtc(dayBefore(drop.pickupDate), "18:00")))).reminded, 1);
  paidOrder({ dropId: drop.id, email: "late@example.com" });
  assert.equal((await runScheduledEmails(env, stripe, Date.parse(localToUtc(drop.pickupDate, "09:00")))).reminded, 1);
  assert.deepEqual(emails.map(({ to }) => to[0]), ["early@example.com", "late@example.com"]);
  paidOrder({ dropId: drop.id, email: "after@example.com" });
  assert.equal((await runScheduledEmails(env, stripe, Date.parse(localToUtc(drop.pickupDate, "15:30")))).reminded, 0);
});

test("if sending fails, nothing is marked sent and the next run sends it", async () => {
  await signUpAndConfirm("try@example.com");
  await makeDrop();
  emails = [];
  resendFails = true;
  await assert.rejects(runScheduledEmails(env, stripe));
  resendFails = false;
  assert.equal((await runScheduledEmails(env, stripe)).announced, 1);
  assert.equal((await runScheduledEmails(env, stripe)).announced, 0);
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
