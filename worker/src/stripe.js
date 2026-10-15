/*
==================================================
STRIPE API

Stripe's API takes form-encoded requests, with
nested values written as line_items[0][quantity].
==================================================
*/

const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300;

export const CONTACT_EMAIL = "hellokiranabakehouse@gmail.com";

export async function stripe(env, method, path, params) {

  if (!env.STRIPE_SECRET_KEY) {
    throw Object.assign(new Error("STRIPE_SECRET_KEY is not set"), { publicMessage: `Online payment isn't set up yet. Please email us at ${CONTACT_EMAIL} to place your order.` });
  }

  const body = encodeForm(params);
  const url = method === "GET" ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" })
    },
    body: method === "GET" ? undefined : body
  });

  const data = await response.json();

  if (!response.ok) {
    const publicMessage = response.status === 401
      ? `Online payment isn't set up correctly (Stripe rejected the key). Please email us at ${CONTACT_EMAIL} to place your order.`
      : "Unable to start Stripe checkout. Please try again.";
    throw Object.assign(new Error(`Stripe ${response.status}: ${data.error?.message}`), { publicMessage });
  }

  return data;

}

export function encodeForm(value, prefix = "", params = new URLSearchParams()) {

  if (value === undefined || value === null) return params;

  if (Array.isArray(value)) {
    value.forEach((item, index) => encodeForm(item, `${prefix}[${index}]`, params));
  } else if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => encodeForm(item, prefix ? `${prefix}[${key}]` : key, params));
  } else {
    params.append(prefix, String(value));
  }

  return params;

}

/*
  Stripe Checkout applies discounts through
  coupons, so each discounted order gets its own
  single-use coupon for the exact amount.
*/
export async function createDiscountCoupon(env, discount, amountCents) {
  const coupon = await stripe(env, "POST", "/coupons", {
    amount_off: amountCents,
    currency: "usd",
    duration: "once",
    max_redemptions: 1,
    name: `${discount.code} (${discount.percent}% off)`.slice(0, 40)
  });
  return [{ coupon: coupon.id }];
}

/*
==================================================
WEBHOOK SIGNATURES

Stripe signs each webhook delivery with the
endpoint's signing secret (whsec_…), so nobody
else can tell the worker an order was paid.
==================================================
*/

export async function verifyWebhookSignature(payload, signatureHeader, secret) {

  const parts = Object.fromEntries((signatureHeader || "").split(",").map(part => part.split("=")));
  const timestamp = Number(parts.t);
  const signatures = (signatureHeader || "").split(",").filter(part => part.startsWith("v1=")).map(part => part.slice(3));

  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some(signature => signature.length === expected.length && timingSafeEqual(signature, expected));

}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
