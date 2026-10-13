/*
==================================================
KIRANA BAKEHOUSE CHECKOUT WORKER
==================================================

Runs on Cloudflare Workers. The website calls it to:

  POST /api/check-delivery          is this address in the delivery area?
  POST /api/create-checkout-session start a Stripe payment for an order
  GET  /api/order-summary           details of a paid order, for the thank-you page
  GET  /api/status                  is the worker set up correctly? (open it in a browser)

IMPORTANT:
Prices, the delivery fee and the delivery area
are all worked out HERE, never trusted from the
browser. The Stripe secret key lives here too.
==================================================
*/

import { API, DELIVERY, DELIVERY_SERVICE, PRODUCTS, TIP } from "../../macros.js";
import {
  calculateDeliveryFee,
  calculateSubtotal,
  describeDeliveryDays,
  findDeliveryZone,
  formatDeliveryDate,
  isDeliveryDateAvailable
} from "../../delivery-rules.js";

const STRIPE_API = "https://api.stripe.com/v1";
const GEOCODE_CACHE_LIMIT = 500;

class AddressNotFoundError extends Error {}
class OrderValidationError extends Error {}

let originCoordinates;
const geocodeCache = new Map();

export default {

  async fetch(request, env) {

    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {

      let result;

      if (request.method === "POST" && url.pathname === API.checkDelivery) {
        result = await checkDelivery(await readJson(request));
      } else if (request.method === "POST" && url.pathname === API.createCheckoutSession) {
        result = await createCheckoutSession(await readJson(request), env, getSiteUrl(request, env));
      } else if (request.method === "GET" && url.pathname === API.orderSummary) {
        result = await getOrderSummary(url.searchParams.get("session_id"), env);
      } else if (request.method === "GET" && url.pathname === "/api/status") {
        result = await getStatus(env);
      } else {
        return json({ error: "Not found." }, 404, corsHeaders);
      }

      return json(result, 200, corsHeaders);

    } catch (error) {

      if (error instanceof OrderValidationError || error instanceof AddressNotFoundError) {
        return json({ error: error.message }, 400, corsHeaders);
      }

      console.error(error);
      return json({ error: error.publicMessage || "Something went wrong. Please try again." }, 500, corsHeaders);

    }

  }

};

/*
==================================================
RESPONSES
==================================================
*/

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new OrderValidationError("Invalid request.");
  }
}

function getAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
}

// Customers are sent back to the website they ordered from (so testing from
// localhost returns to localhost), as long as it's one of ours.
function getSiteUrl(request, env) {
  const origin = request.headers.get("Origin");
  const siteUrl = origin && getAllowedOrigins(env).includes(origin) ? origin : env.SITE_URL || "";
  return siteUrl.replace(/\/$/, "");
}

// The website is on a different domain to the worker, so browsers need
// these headers before they will let the page read the response.
function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !getAllowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

/*
==================================================
DELIVERY AREA CHECK
==================================================
*/

async function checkDelivery(body) {

  const address = typeof body.address === "string" ? cleanText(body.address, 300) : parseAddress(body.address);

  if (!address) {
    throw new OrderValidationError("Please enter a delivery address.");
  }

  const { distanceMiles, zone } = await checkDeliveryArea(address);

  if (!zone) {
    return { deliverable: false, distanceMiles, message: `This address is outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.` };
  }

  return { deliverable: true, distanceMiles, feeCents: zone.feeCents, freeOverCents: zone.freeOverCents };

}

/*
==================================================
CREATE STRIPE CHECKOUT SESSION
==================================================
*/

async function createCheckoutSession(body, env, siteUrl) {

  const items = parseItems(body.items);
  const deliveryDate = parseDeliveryDate(body.deliveryDate);
  const customer = parseCustomer(body.customer);
  const address = parseAddress(body.address);
  const notes = cleanText(body.notes, DELIVERY.notesMaxLength);
  const tipCents = parseTip(body.tipCents);

  const { distanceMiles, zone } = await checkDeliveryArea(address);

  if (!zone) {
    throw new OrderValidationError(`Sorry, this address is about ${distanceMiles} miles away, outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.`);
  }

  const subtotal = calculateSubtotal(items);
  const deliveryFee = calculateDeliveryFee(zone, subtotal);

  /*
  ==========================================
  LINE ITEMS
  ==========================================
  */

  const lineItems = items.map(({ productId, quantity }) => ({
    price_data: {
      currency: "usd",
      product_data: { name: PRODUCTS[productId].name },
      unit_amount: PRODUCTS[productId].price
    },
    quantity
  }));

  if (deliveryFee > 0) {
    lineItems.push({ price_data: { currency: "usd", product_data: { name: "Local delivery" }, unit_amount: deliveryFee }, quantity: 1 });
  }

  if (tipCents > 0) {
    lineItems.push({ price_data: { currency: "usd", product_data: { name: "Tip for your baker" }, unit_amount: tipCents }, quantity: 1 });
  }

  /*
  ==========================================
  ORDER DETAILS

  Saved on the Stripe payment so every order
  shows its delivery date, address and phone
  number in the Stripe Dashboard.
  ==========================================
  */

  const deliveryDateLabel = formatDeliveryDate(deliveryDate);
  const addressLine = formatAddress(address);

  const metadata = {
    delivery_date: deliveryDate,
    delivery_date_label: deliveryDateLabel,
    customer_name: customer.name,
    customer_phone: customer.phone,
    delivery_address: addressLine,
    delivery_distance_miles: String(distanceMiles),
    delivery_notes: notes,
    tip_cents: String(tipCents)
  };

  /*
  ==========================================
  STRIPE CHECKOUT

  Stripe collects the email address and card
  details. The delivery address was already
  checked above, so Stripe doesn't ask for it
  again.
  ==========================================
  */

  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "payment",
    line_items: lineItems,
    customer_creation: "always",
    payment_intent_data: {
      description: `Kirana Bakehouse delivery — ${deliveryDateLabel}`,
      shipping: {
        name: customer.name,
        phone: customer.phone,
        address: {
          line1: address.line1,
          line2: address.line2 || undefined,
          city: address.city,
          state: DELIVERY.state,
          postal_code: address.postalCode,
          country: "US"
        }
      },
      metadata
    },
    metadata,
    custom_text: {
      submit: {
        message: `Delivering to ${addressLine} on ${deliveryDateLabel}. Your sourdough will be baked fresh for your delivery date.`
      }
    },
    success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/order.html?cancelled=true`
  });

  return { url: session.url };

}

/*
==================================================
ORDER SUMMARY (thank-you page)
==================================================
*/

async function getOrderSummary(sessionId, env) {

  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    throw new OrderValidationError("Invalid order reference.");
  }

  const session = await stripe(env, "GET", `/checkout/sessions/${sessionId}`, { "expand[]": "line_items" });

  if (session.payment_status !== "paid") {
    throw new OrderValidationError("We couldn't find a completed payment for this order.");
  }

  return {
    email: session.customer_details?.email || "",
    name: session.metadata.customer_name,
    deliveryDate: session.metadata.delivery_date_label,
    address: session.metadata.delivery_address,
    items: session.line_items.data.map(item => ({ name: item.description, quantity: item.quantity, amountTotal: item.amount_total })),
    amountTotal: session.amount_total
  };

}

/*
==================================================
STATUS CHECK

Open https://<your-worker>/api/status in a
browser to see whether the Stripe key works.
Never reveals the key itself.
==================================================
*/

async function getStatus(env) {

  const key = env.STRIPE_SECRET_KEY || "";
  const status = {
    stripeKeySet: Boolean(key),
    stripeKeyLooksLike: key ? `${key.slice(0, 8)}… (${key.length} characters)` : "not set",
    siteUrl: env.SITE_URL || "not set",
    allowedOrigins: env.ALLOWED_ORIGINS || "not set"
  };

  if (!key) {
    status.problem = "STRIPE_SECRET_KEY is not set. Run: npx wrangler secret put STRIPE_SECRET_KEY";
    return status;
  }

  if (!/^sk_(test|live)_/.test(key)) {
    status.problem = "The key doesn't look like a Stripe secret key. It should start with sk_test_ or sk_live_ (Stripe Dashboard → Developers → API keys → Secret key).";
  }

  try {
    const account = await stripe(env, "GET", "/account", {});
    status.stripe = `OK — connected to Stripe account ${account.id}${account.business_profile?.name ? ` (${account.business_profile.name})` : ""} in ${key.startsWith("sk_test_") ? "TEST" : "LIVE"} mode`;
  } catch (error) {
    status.stripe = `Stripe rejected the key: ${error.message}`;
  }

  return status;

}

/*
==================================================
STRIPE API

Stripe's API takes form-encoded requests, with
nested values written as line_items[0][quantity].
==================================================
*/

async function stripe(env, method, path, params) {

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

/*
==================================================
VALIDATION
==================================================
*/

function parseItems(items) {

  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderValidationError("Your cart is empty.");
  }

  // Combine repeated products so the per-product limit can't be bypassed.
  const quantities = new Map();

  for (const item of items) {
    const productId = item?.productId;
    const product = Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId] : null;
    const quantity = Number(item?.quantity);

    if (!product) {
      throw new OrderValidationError("Invalid product.");
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new OrderValidationError("Invalid quantity.");
    }

    const total = (quantities.get(productId) || 0) + quantity;

    if (total > product.maxQuantity) {
      throw new OrderValidationError(`${product.name} has a maximum quantity of ${product.maxQuantity}.`);
    }

    quantities.set(productId, total);
  }

  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));

}

function parseDeliveryDate(deliveryDate) {

  if (!deliveryDate) {
    throw new OrderValidationError("Please select a delivery date.");
  }

  if (typeof deliveryDate !== "string" || !isDeliveryDateAvailable(deliveryDate)) {
    throw new OrderValidationError(`That delivery date is no longer available. We deliver ${describeDeliveryDays()} — please choose another date.`);
  }

  return deliveryDate;

}

function parseCustomer(customer) {

  const name = cleanText(customer?.name, 100);
  const phone = cleanText(customer?.phone, 30);

  if (!name) throw new OrderValidationError("Please enter your name.");

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    throw new OrderValidationError("Please enter a valid phone number so we can reach you on delivery day.");
  }

  return { name, phone };

}

function parseAddress(address) {

  const line1 = cleanText(address?.line1, 200);
  const line2 = cleanText(address?.line2, 100);
  const city = cleanText(address?.city, 100);
  const postalCode = cleanText(address?.postalCode, 10);

  if (!line1 || !city) {
    throw new OrderValidationError("Please enter your street address and city.");
  }

  if (!/^\d{5}(-\d{4})?$/.test(postalCode)) {
    throw new OrderValidationError("Please enter a valid 5-digit ZIP code.");
  }

  return { line1, line2, city, postalCode };

}

function parseTip(tipCents) {

  if (tipCents === undefined || tipCents === null || tipCents === 0) return 0;

  if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > TIP.maxCents) {
    throw new OrderValidationError("Please enter a valid tip amount.");
  }

  return tipCents;

}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function formatAddress({ line1, line2, city, postalCode }) {
  return [line1, line2, `${city}, ${DELIVERY.state} ${postalCode}`].filter(Boolean).join(", ");
}

/*
==================================================
DELIVERY AREA
==================================================
*/

async function checkDeliveryArea(address) {
  const origin = await getOriginCoordinates();
  const destination = await geocodeAddress(address);
  const distanceMiles = Number(calculateDistanceMiles(origin, destination).toFixed(1));
  return { distanceMiles, zone: findDeliveryZone(distanceMiles) };
}

async function getOriginCoordinates() {
  if (!originCoordinates) originCoordinates = await geocodeAddress(DELIVERY_SERVICE.originAddress);
  return originCoordinates;
}

/*
  Accepts a free-form string (delivery.html) or a
  { line1, city, postalCode } object (order page).
  Structured searches are more accurate, so try
  that first and fall back to a free-form search.
*/
async function geocodeAddress(address) {

  const searches = typeof address === "string"
    ? [{ q: address }]
    : [
      { street: address.line1, city: address.city, state: DELIVERY.state, postalcode: address.postalCode },
      { q: `${address.line1}, ${address.city}, ${DELIVERY.state} ${address.postalCode}` }
    ];

  const cacheKey = JSON.stringify(searches[0]).toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  for (const search of searches) {
    const location = await searchGeocoder(search);
    if (location) {
      if (geocodeCache.size >= GEOCODE_CACHE_LIMIT) geocodeCache.delete(geocodeCache.keys().next().value);
      geocodeCache.set(cacheKey, location);
      return location;
    }
  }

  throw new AddressNotFoundError("We couldn't find that address. Please check the street address and ZIP code.");

}

async function searchGeocoder(search) {

  const searchParams = new URLSearchParams({ ...search, format: "jsonv2", limit: "1", countrycodes: DELIVERY_SERVICE.countryCode });
  const response = await fetch(`${DELIVERY_SERVICE.geocoderUrl}?${searchParams}`, { headers: { "User-Agent": DELIVERY_SERVICE.userAgent } });

  if (!response.ok) {
    throw Object.assign(new Error(`Geocoder request failed with status ${response.status}.`), { publicMessage: "We couldn't check that address right now. Please try again in a moment." });
  }

  const [location] = await response.json();
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lon);
  if (!location || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };

}

function calculateDistanceMiles(start, end) {
  const toRadians = degrees => degrees * (Math.PI / 180);
  const latitudeDifference = toRadians(end.latitude - start.latitude);
  const longitudeDifference = toRadians(end.longitude - start.longitude);
  const haversine = Math.sin(latitudeDifference / 2) ** 2 + Math.cos(toRadians(start.latitude)) * Math.cos(toRadians(end.latitude)) * Math.sin(longitudeDifference / 2) ** 2;
  return DELIVERY_SERVICE.earthRadiusMiles * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
