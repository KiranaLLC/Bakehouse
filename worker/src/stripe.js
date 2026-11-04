/*
  Stripe's REST API, called directly with fetch (no SDK). Shared by the
  checkout worker (index.js) and the orders worker (orders.js).
*/

const STRIPE_API = "https://api.stripe.com/v1";

/*
==================================================
STRIPE API

Stripe's API takes form-encoded requests, with
nested values written as line_items[0][quantity].
==================================================
*/

export async function stripe(env, method, path, params) {

  if (!env.STRIPE_SECRET_KEY) {
    throw Object.assign(new Error("STRIPE_SECRET_KEY is not set"), { publicMessage: "Online payment isn't set up yet. Please email us at hellokiranabakehouse@gmail.com to place your order." });
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
      ? "Online payment isn't set up correctly (Stripe rejected the key). Please email us at hellokiranabakehouse@gmail.com to place your order."
      : "Unable to start Stripe checkout. Please try again.";
    throw Object.assign(new Error(`Stripe ${response.status}: ${data.error?.message}`), { publicMessage });
  }

  return data;

}

function encodeForm(value, prefix = "", params = new URLSearchParams()) {

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
