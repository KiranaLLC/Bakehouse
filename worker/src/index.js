/*
==================================================
KIRANA BAKEHOUSE CHECKOUT WORKER
==================================================

Runs on Cloudflare Workers. The website calls it to:

  POST /api/check-delivery                  is this address in the delivery area?
  POST /api/check-discount                  is this discount code valid?
  POST /api/create-checkout-session         start a Stripe payment for a delivery order
  GET  /api/pickup/days                     upcoming pickup days and what's left
  POST /api/pickup/create-checkout-session  start a Stripe payment for a pickup order
  GET  /api/order-summary                   details of a paid order, for the thank-you page
  POST /api/stripe/webhook                  Stripe tells us when a payment completes
  GET  /api/status                          is the worker set up correctly? (open it in a browser)

  Admin (admin.html, password-protected):
  POST /api/admin/login, GET/POST/DELETE /api/admin/pickup-days, GET /api/admin/orders

IMPORTANT:
Prices, the delivery fee, the delivery area and
loaf availability are all worked out HERE, never
trusted from the browser. The Stripe secret key
lives here too.
==================================================
*/

import { API, DELIVERY, DELIVERY_SERVICE, PRODUCTS } from "../../macros.js";
import {
  calculateDeliveryFee,
  calculateDiscount,
  calculateSubtotal,
  describeDeliveryDays,
  findDeliveryZone,
  formatDeliveryDate,
  formatDeliverySlot,
  isDeliveryDateAvailable
} from "../../delivery-rules.js";
import { createDiscountCoupon, stripe } from "./stripe.js";
import {
  AddressNotFoundError,
  AdminAuthError,
  OrderValidationError,
  cleanText,
  findDiscount,
  parseCustomer,
  parseItems,
  parseTip,
  requireAdmin
} from "./validate.js";
import {
  adminDeletePickupDay,
  adminListOrders,
  adminListPickupDays,
  adminSavePickupDay,
  createPickupCheckoutSession,
  handleStripeWebhook,
  listPickupDays,
  markPickupOrderPaid,
  pickupSummary
} from "./pickup.js";

const GEOCODE_CACHE_LIMIT = 500;

let originCoordinates;
const geocodeCache = new Map();
const distanceCache = new Map();

export default {

  async fetch(request, env) {

    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);
    const { method } = request;
    const path = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {

      let result;

      if (method === "POST" && path === API.checkDelivery) {
        result = await checkDelivery(await readJson(request), env);
      } else if (method === "POST" && path === API.checkDiscount) {
        result = findDiscount((await readJson(request)).code, env);
      } else if (method === "POST" && path === API.createCheckoutSession) {
        result = await createCheckoutSession(await readJson(request), env, getSiteUrl(request, env));
      } else if (method === "GET" && path === API.pickupDays) {
        result = await listPickupDays(env);
      } else if (method === "POST" && path === API.createPickupCheckoutSession) {
        result = await createPickupCheckoutSession(await readJson(request), env, getSiteUrl(request, env));
      } else if (method === "GET" && path === API.orderSummary) {
        result = await getOrderSummary(url.searchParams.get("session_id"), env);
      } else if (method === "POST" && path === "/api/stripe/webhook") {
        result = await handleStripeWebhook(request, env);
      } else if (method === "GET" && path === "/api/status") {
        result = await getStatus(env);
      } else if (method === "POST" && path === API.adminLogin) {
        requireAdmin(request, env);
        result = { ok: true };
      } else if (method === "GET" && path === API.adminPickupDays) {
        requireAdmin(request, env);
        result = await adminListPickupDays(env);
      } else if (method === "POST" && path === API.adminPickupDays) {
        requireAdmin(request, env);
        result = await adminSavePickupDay(await readJson(request), env);
      } else if (method === "DELETE" && path === API.adminPickupDays) {
        requireAdmin(request, env);
        result = await adminDeletePickupDay(Number(url.searchParams.get("id")), env);
      } else if (method === "GET" && path === API.adminOrders) {
        requireAdmin(request, env);
        result = await adminListOrders(parseDayId(url.searchParams.get("day")), env);
      } else {
        return json({ error: "Not found." }, 404, corsHeaders);
      }

      return json(result, 200, corsHeaders);

    } catch (error) {

      if (error instanceof OrderValidationError || error instanceof AddressNotFoundError) {
        return json({ error: error.message }, 400, corsHeaders);
      }

      if (error instanceof AdminAuthError) {
        return json({ error: error.message }, 401, corsHeaders);
      }

      console.error(error);
      return json({ error: error.publicMessage || "Something went wrong. Please try again." }, 500, corsHeaders);

    }

  }

};

// A pickup day id is a number (database row) or "<ruleKey>:<date>" (weekly schedule).
function parseDayId(value) {
  return /^\d+$/.test(value || "") ? Number(value) : value;
}

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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

/*
==================================================
DELIVERY AREA CHECK
==================================================
*/

async function checkDelivery(body, env) {

  const address = typeof body.address === "string" ? cleanText(body.address, 300) : parseAddress(body.address);

  if (!address) {
    throw new OrderValidationError("Please enter a delivery address.");
  }

  const { distanceMiles, zone } = await checkDeliveryArea(address, env);

  if (!zone) {
    return { deliverable: false, distanceMiles, message: `This address is outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.` };
  }

  return { deliverable: true, distanceMiles, feeCents: zone.feeCents, freeOverCents: zone.freeOverCents };

}

/*
==================================================
CREATE STRIPE CHECKOUT SESSION FOR A DELIVERY
==================================================
*/

async function createCheckoutSession(body, env, siteUrl) {

  const items = parseItems(body.items);
  const deliveryDate = parseDeliveryDate(body.deliveryDate);
  const customer = parseCustomer(body.customer);
  const address = parseAddress(body.address);
  const notes = cleanText(body.notes, DELIVERY.notesMaxLength);
  const tipCents = parseTip(body.tipCents);
  const discount = body.discountCode ? findDiscount(body.discountCode, env) : null;

  const { distanceMiles, zone } = await checkDeliveryArea(address, env);

  if (!zone) {
    throw new OrderValidationError(`Sorry, this address is about ${distanceMiles} miles away, outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.`);
  }

  const subtotal = calculateSubtotal(items);
  const deliveryFee = calculateDeliveryFee(zone, subtotal);
  const discountCents = discount ? calculateDiscount(discount.percent, subtotal, deliveryFee) : 0;

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
  const deliverySlotLabel = formatDeliverySlot(deliveryDate);
  const addressLine = formatAddress(address);

  const metadata = {
    order_type: "delivery",
    delivery_date: deliveryDate,
    delivery_date_label: deliverySlotLabel,
    customer_name: customer.name,
    customer_phone: customer.phone,
    delivery_address: addressLine,
    delivery_distance_miles: String(distanceMiles),
    delivery_notes: notes,
    tip_cents: String(tipCents),
    discount_code: discount?.code || "",
    discount_cents: String(discountCents)
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
    discounts: discountCents > 0 ? await createDiscountCoupon(env, discount, discountCents) : undefined,
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
        message: `Delivering to ${addressLine} on ${deliverySlotLabel}. Your sourdough will be baked fresh that morning.`
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

  const metadata = session.metadata || {};
  const isPickup = metadata.order_type === "pickup";

  // Safety net in case the webhook hasn't arrived (or isn't set up).
  if (isPickup) await markPickupOrderPaid(env, session);

  return {
    type: isPickup ? "pickup" : "delivery",
    email: session.customer_details?.email || "",
    name: metadata.customer_name || session.customer_details?.name || "",
    deliveryDate: metadata.delivery_date_label,
    address: metadata.delivery_address,
    items: session.line_items.data.map(item => ({ name: item.description, quantity: item.quantity, amountTotal: item.amount_subtotal ?? item.amount_total })),
    discountCode: metadata.discount_code || "",
    amountDiscount: session.total_details?.amount_discount || 0,
    amountTotal: session.amount_total,
    ...(isPickup ? pickupSummary(session) : {})
  };

}

/*
==================================================
STATUS CHECK

Open https://<your-worker>/api/status in a
browser to see whether everything is set up.
Never reveals the secrets themselves.
==================================================
*/

async function getStatus(env) {

  const key = env.STRIPE_SECRET_KEY || "";
  const status = {
    stripeKeySet: Boolean(key),
    stripeKeyLooksLike: key ? `${key.slice(0, 8)}… (${key.length} characters)` : "not set",
    siteUrl: env.SITE_URL || "not set",
    allowedOrigins: env.ALLOWED_ORIGINS || "not set",
    discountCodesSet: Boolean(env.DISCOUNT_CODES),
    adminPasswordSet: Boolean(env.ADMIN_PASSWORD),
    stripeWebhookSecretSet: Boolean(env.STRIPE_WEBHOOK_SECRET),
    drivingDistance: env.ROUTING_API_KEY ? "OK — OpenRouteService key set" : "not set (straight-line distance in use); run: npx wrangler secret put ROUTING_API_KEY"
  };

  try {
    const count = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS count FROM pickup_days").first("count") : null;
    status.pickupDatabase = env.DB ? `OK — ${count} pickup day${count === 1 ? "" : "s"}` : "not set up (see README: npx wrangler d1 create kirana-orders)";
  } catch (error) {
    status.pickupDatabase = `Database error: ${error.message} (did you run the schema.sql step?)`;
  }

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
DELIVERY VALIDATION
==================================================
*/

function parseDeliveryDate(deliveryDate) {

  if (!deliveryDate) {
    throw new OrderValidationError("Please select a delivery date.");
  }

  if (typeof deliveryDate !== "string" || !isDeliveryDateAvailable(deliveryDate)) {
    throw new OrderValidationError(`That delivery date is no longer available. We deliver ${describeDeliveryDays()} — please choose another date.`);
  }

  return deliveryDate;

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

function formatAddress({ line1, line2, city, postalCode }) {
  return [line1, line2, `${city}, ${DELIVERY.state} ${postalCode}`].filter(Boolean).join(", ");
}

/*
==================================================
DELIVERY AREA
==================================================
*/

async function checkDeliveryArea(address, env) {
  const origin = await getOriginCoordinates();
  const destination = await geocodeAddress(address);
  const distanceMiles = Number((await drivingDistanceMiles(origin, destination, env)).toFixed(1));
  return { distanceMiles, zone: findDeliveryZone(distanceMiles) };
}

/*
  Driving distance along the roads, from
  OpenRouteService. Falls back to the straight-line
  distance if the routing key isn't set or the
  service is unavailable, so ordering keeps working.
*/
async function drivingDistanceMiles(origin, destination, env) {

  const cacheKey = `${destination.latitude},${destination.longitude}`;
  if (distanceCache.has(cacheKey)) return distanceCache.get(cacheKey);

  let miles;

  if (env.ROUTING_API_KEY) {
    try {
      const url = `${DELIVERY_SERVICE.routingUrl}?start=${origin.longitude},${origin.latitude}&end=${destination.longitude},${destination.latitude}`;
      const response = await fetch(url, { headers: { Authorization: env.ROUTING_API_KEY, Accept: "application/geo+json" } });
      const data = await response.json();
      const meters = data.features?.[0]?.properties?.summary?.distance;
      if (!response.ok || !Number.isFinite(meters)) throw new Error(`Routing ${response.status}: ${JSON.stringify(data.error || data).slice(0, 200)}`);
      miles = meters / DELIVERY_SERVICE.metersPerMile;
    } catch (error) {
      console.error("Driving distance unavailable, using straight line:", error.message);
    }
  }

  if (miles === undefined) miles = calculateDistanceMiles(origin, destination);

  if (distanceCache.size >= GEOCODE_CACHE_LIMIT) distanceCache.delete(distanceCache.keys().next().value);
  distanceCache.set(cacheKey, miles);
  return miles;

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
