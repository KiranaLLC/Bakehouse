/*
==================================================
KIRANA BAKEHOUSE CHECKOUT WORKER
==================================================

Runs on Cloudflare Workers. The website calls it to:

  POST /api/check-delivery          is this address in the delivery area?
  POST /api/check-discount          is this discount code valid?
  POST /api/create-checkout-session start a Stripe payment for an order
  GET  /api/capacity                loaves still available on each delivery date
  GET  /api/drops                   upcoming pickup drops and whether they're open
  POST /api/subscribe               join the "next drop" email list
  GET  /api/order-summary           details of a paid order, for the thank-you page
  GET  /api/status                  is the worker set up correctly? (open it in a browser)

The bakery's private orders page is a separate worker (orders.js), so it
can sit behind Cloudflare Access while this one stays public.

IMPORTANT:
Prices, the delivery fee and the delivery area
are all worked out HERE, never trusted from the
browser. The Stripe secret key lives here too.
==================================================
*/

import { API, DELIVERY, DELIVERY_SERVICE, PICKUP, PRODUCTS, TIP } from "../../macros.js";
import {
  calculateDeliveryFee,
  calculateDiscount,
  calculateSubtotal,
  describeDeliveryDays,
  findDeliveryZone,
  formatDeliveryDate,
  formatDeliverySlot,
  bakeryTodayValue,
  getDeliveryDates,
  isDeliveryDateAvailable
} from "../../delivery-rules.js";
import { stripe } from "./stripe.js";
import { forgetStripeLists, listSessionsSince } from "./stripe-cache.js";
import { DropError, addSubscriber, getDrop, getDropBookings, hasDatabase, listDrops } from "./drops.js";
import { dropStatus, formatMoment, formatPickupWhen } from "../../pickup-rules.js";
import {
  CHECKOUT_HOLD_SECONDS,
  countLoaves,
  describeShortfall,
  holdsCapacity,
  listCapacityInvoices,
  loavesFromLineItems,
  loavesFromMetadata,
  lookbackSeconds,
  remainingLoaves
} from "./capacity.js";

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
      } else if (request.method === "POST" && url.pathname === API.checkDiscount) {
        result = findDiscount((await readJson(request)).code, env);
      } else if (request.method === "POST" && url.pathname === API.createCheckoutSession) {
        result = await createCheckoutSession(await readJson(request), env, getSiteUrl(request, env));
      } else if (request.method === "GET" && url.pathname === API.drops) {
        result = await getPublicDrops(url.searchParams.get("exclude"), env);
      } else if (request.method === "POST" && url.pathname === API.subscribe) {
        result = await subscribe(await readJson(request), env);
      } else if (request.method === "GET" && url.pathname === API.capacity) {
        result = await getCapacity(url.searchParams.get("exclude"), env);
      } else if (request.method === "GET" && url.pathname === API.orderSummary) {
        result = await getOrderSummary(url.searchParams.get("session_id"), env);
      } else if (request.method === "GET" && url.pathname === "/api/status") {
        result = await getStatus(env);
      } else {
        return json({ error: "Not found." }, 404, corsHeaders);
      }

      return json(result, 200, corsHeaders);

    } catch (error) {

      if (error instanceof OrderValidationError || error instanceof AddressNotFoundError || error instanceof DropError) {
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

  const address = parseAddress(body.address);

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

  if (body.fulfillment === "pickup") {
    return createPickupCheckoutSession(body, env, siteUrl);
  }

  const items = parseItems(body.items);
  const deliveryDate = parseDeliveryDate(body.deliveryDate);
  const customer = parseCustomer(body.customer);
  const address = parseAddress(body.address);
  const notes = cleanText(body.notes, DELIVERY.notesMaxLength);
  const tipCents = parseTip(body.tipCents);
  const discount = body.discountCode ? findDiscount(body.discountCode, env) : null;
  const loafCount = countLoaves(items);

  const { distanceMiles, zone } = await checkDeliveryArea(address);

  if (!zone) {
    throw new OrderValidationError(`Sorry, this address is about ${distanceMiles} miles away, outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.`);
  }

  /*
  ==========================================
  DAILY CAPACITY

  If this customer already started a payment
  (and came back to change their order), let
  that one go first so their own loaves don't
  count against them twice.
  ==========================================
  */

  const released = await releaseCheckoutSession(body.previousSessionId, env);
  const booked = await getBookedLoaves(env, [deliveryDate], released);
  const remaining = remainingLoaves(booked.get(deliveryDate) || 0);

  if (loafCount > remaining) {
    throw new OrderValidationError(describeShortfall(remaining, loafCount, formatDeliveryDate(deliveryDate)));
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
    delivery_date: deliveryDate,
    delivery_date_label: deliverySlotLabel,
    loaf_count: String(loafCount),
    // e.g. "house_white:2,margherita:1", for the bakery's prep list.
    items: items.map(({ productId, quantity }) => `${productId}:${quantity}`).join(","),
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
  DISCOUNT

  Stripe Checkout applies discounts through
  coupons, so each discounted order gets its
  own single-use coupon for the exact amount
  (loaves and delivery only, not the tip).
  ==========================================
  */

  const discounts = await createDiscountCoupon(env, discount, discountCents);

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
    // Holds this order's loaves only while the customer is paying.
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_HOLD_SECONDS,
    line_items: lineItems,
    discounts,
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

  forgetStripeLists();

  return { url: session.url, id: session.id };

}

async function createDiscountCoupon(env, discount, discountCents) {
  if (!discountCents) return undefined;
  const coupon = await stripe(env, "POST", "/coupons", {
    amount_off: discountCents,
    currency: "usd",
    duration: "once",
    max_redemptions: 1,
    name: `${discount.code} (${discount.percent}% off)`.slice(0, 40)
  });
  return [{ coupon: coupon.id }];
}

/*
==================================================
PICKUP CHECKOUT

Like delivery, minus the address and delivery
fee: the customer picks an open drop, and the
drop's own loaf limit is checked instead of the
daily delivery limit.
==================================================
*/

async function createPickupCheckoutSession(body, env, siteUrl) {

  const items = parseItems(body.items);
  const customer = parseCustomer(body.customer);
  const tipCents = parseTip(body.tipCents);
  const discount = body.discountCode ? findDiscount(body.discountCode, env) : null;
  const loafCount = countLoaves(items);

  const drop = await getDrop(env, Number(body.dropId));

  if (!drop || drop.cancelled) {
    throw new OrderValidationError("Sorry, that pickup isn't available any more. Please choose another.");
  }

  const pickupWhen = formatPickupWhen(drop);
  const now = Date.now();

  if (now < Date.parse(drop.opensAt)) {
    throw new OrderValidationError(`Ordering for this pickup opens ${formatMoment(drop.opensAt)}.`);
  }

  if (now >= Date.parse(drop.closesAt)) {
    throw new OrderValidationError("Sorry, ordering for this pickup has closed. Please choose another.");
  }

  const released = await releaseCheckoutSession(body.previousSessionId, env);
  const booked = await getDropBookings(env, stripe, [drop], { ignoreSessionId: released });
  const remaining = Math.max(drop.loafLimit - booked.get(String(drop.id)), 0);

  if (loafCount > remaining) {
    throw new OrderValidationError(remaining === 0
      ? `Sorry, the ${pickupWhen} pickup is sold out. Please choose another.`
      : `Sorry, the ${pickupWhen} pickup can't fit your order of ${loafCount} loaves. Please choose another pickup, or remove a few loaves.`);
  }

  const subtotal = calculateSubtotal(items);
  const discountCents = discount ? calculateDiscount(discount.percent, subtotal, 0) : 0;

  const lineItems = items.map(({ productId, quantity }) => ({
    price_data: { currency: "usd", product_data: { name: PRODUCTS[productId].name }, unit_amount: PRODUCTS[productId].price },
    quantity
  }));

  if (tipCents > 0) {
    lineItems.push({ price_data: { currency: "usd", product_data: { name: "Tip for your baker" }, unit_amount: tipCents }, quantity: 1 });
  }

  const location = `${drop.locationName}, ${drop.locationAddress}`;

  const metadata = {
    fulfillment: "pickup",
    drop_id: String(drop.id),
    pickup_date: drop.pickupDate,
    pickup_label: pickupWhen,
    pickup_location: location,
    loaf_count: String(loafCount),
    items: items.map(({ productId, quantity }) => `${productId}:${quantity}`).join(","),
    customer_name: customer.name,
    customer_phone: customer.phone,
    tip_cents: String(tipCents),
    discount_code: discount?.code || "",
    discount_cents: String(discountCents)
  };

  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "payment",
    // Holds this order's loaves only while the customer is paying.
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_HOLD_SECONDS,
    line_items: lineItems,
    discounts: await createDiscountCoupon(env, discount, discountCents),
    customer_creation: "always",
    payment_intent_data: {
      description: `Kirana Bakehouse pickup — ${pickupWhen}`,
      metadata
    },
    metadata,
    custom_text: {
      submit: { message: `Pickup at ${location}, ${pickupWhen}. Your sourdough will be baked fresh that morning.` }
    },
    success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/order.html?cancelled=true`
  });

  forgetStripeLists();

  return { url: session.url, id: session.id };

}

/*
==================================================
DROPS (order page)

Upcoming pickup drops, soonest first, with
whether each is open, not open yet, sold out or
closed. "remaining" lets the page grey out drops
that can't fit the cart; it isn't shown.
==================================================
*/

async function getPublicDrops(excludeSessionId, env) {

  if (!hasDatabase(env)) return { available: false, drops: [] };

  const now = Date.now();
  const drops = (await listDrops(env, { fromDate: bakeryTodayValue() }))
    .filter(({ closesAt }) => Date.parse(closesAt) > now)
    .slice(0, PICKUP.maxDropsShown);
  const booked = await getDropBookings(env, stripe, drops, { ignoreOpenSessionId: excludeSessionId, fresh: false });

  return {
    available: true,
    now: new Date(now).toISOString(),
    drops: drops.map(drop => {
      const remaining = Math.max(drop.loafLimit - booked.get(String(drop.id)), 0);
      return {
        id: drop.id,
        pickupDate: drop.pickupDate,
        windowStart: drop.windowStart,
        windowEnd: drop.windowEnd,
        locationName: drop.locationName,
        locationAddress: drop.locationAddress,
        notes: drop.notes,
        opensAt: drop.opensAt,
        closesAt: drop.closesAt,
        remaining,
        status: dropStatus(drop, remaining, now)
      };
    })
  };

}

async function subscribe(body, env) {
  if (!hasDatabase(env)) {
    throw new OrderValidationError("Sorry, sign-ups aren't open yet. Please email hellokiranabakehouse@gmail.com.");
  }
  return addSubscriber(env, body);
}

/*
==================================================
CAPACITY (order page)

Loaves still available on each date a customer
can choose. "exclude" is the customer's own
unfinished payment, if they came back from it.
==================================================
*/

async function getCapacity(excludeSessionId, env) {

  const dates = getDeliveryDates().map(({ value }) => value);
  // A count up to STRIPE_CACHE_SECONDS old is fine here; checkout re-counts fresh.
  const booked = await getBookedLoaves(env, dates, null, excludeSessionId, { fresh: false });

  return {
    limit: DELIVERY.dailyLoafLimit,
    dates: dates.map(value => ({ value, remaining: remainingLoaves(booked.get(value) || 0) }))
  };

}

/*
  Loaves booked per delivery date, as a Map of
  "YYYY-MM-DD" → count, for the given dates only.
  ignoreSessionId is skipped whatever its state;
  ignoreOpenSessionId only while it is unpaid.
*/
async function getBookedLoaves(env, dates, ignoreSessionId, ignoreOpenSessionId, { fresh = true } = {}) {

  const wanted = new Set(dates);
  const booked = new Map();
  const since = Math.floor(Date.now() / 1000) - lookbackSeconds();

  for (const session of await listSessionsSince(env, stripe, since, { fresh })) {
    const date = session.metadata?.delivery_date;
    if (!holdsCapacity(session) || !wanted.has(date) || session.id === ignoreSessionId) continue;
    if (session.id === ignoreOpenSessionId && session.status === "open") continue;
    booked.set(date, (booked.get(date) || 0) + await countSessionLoaves(session, env));
  }

  // Catering and other invoices on these days take loaves too.
  for (const invoice of await listCapacityInvoices(env, stripe, { fresh })) {
    if (!wanted.has(invoice.deliveryDate)) continue;
    booked.set(invoice.deliveryDate, (booked.get(invoice.deliveryDate) || 0) + invoice.loaves);
  }

  return booked;

}

async function countSessionLoaves(session, env) {
  const fromMetadata = loavesFromMetadata(session);
  if (fromMetadata !== null) return fromMetadata;
  const lineItems = await stripe(env, "GET", `/checkout/sessions/${session.id}/line_items`, { limit: 100 });
  return loavesFromLineItems(lineItems.data);
}

/*
  Ends a customer's unfinished payment page so its
  loaves are free again. Returns the session id if
  it was released, or null (no id, already paid,
  already expired, not ours).
*/
async function releaseCheckoutSession(sessionId, env) {

  if (typeof sessionId !== "string" || !isSessionId(sessionId)) return null;

  try {
    await stripe(env, "POST", `/checkout/sessions/${sessionId}/expire`, {});
    forgetStripeLists();
    return sessionId;
  } catch {
    return null;
  }

}

function isSessionId(value) {
  return /^cs_[A-Za-z0-9_]+$/.test(value);
}

/*
==================================================
ORDER SUMMARY (thank-you page)
==================================================
*/

async function getOrderSummary(sessionId, env) {

  if (typeof sessionId !== "string" || !isSessionId(sessionId)) {
    throw new OrderValidationError("Invalid order reference.");
  }

  const session = await stripe(env, "GET", `/checkout/sessions/${sessionId}`, { "expand[]": "line_items" });

  if (session.payment_status !== "paid") {
    throw new OrderValidationError("We couldn't find a completed payment for this order.");
  }

  const pickup = session.metadata.fulfillment === "pickup";

  return {
    email: session.customer_details?.email || "",
    name: session.metadata.customer_name,
    fulfillment: pickup ? "pickup" : "delivery",
    deliveryDate: pickup ? session.metadata.pickup_label : session.metadata.delivery_date_label,
    address: pickup ? session.metadata.pickup_location : session.metadata.delivery_address,
    items: session.line_items.data.map(item => ({ name: item.description, quantity: item.quantity, amountTotal: item.amount_subtotal ?? item.amount_total })),
    discountCode: session.metadata.discount_code || "",
    amountDiscount: session.total_details?.amount_discount || 0,
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

/*
  Discount codes are a Cloudflare secret so they
  stay out of the public repository:
    npx wrangler secret put DISCOUNT_CODES
  with a value like  BREADUCATION=20,FRIENDS=10
  (code = percent off). Codes aren't case-sensitive.
*/
function findDiscount(code, env) {

  const wanted = cleanText(code, 40).toUpperCase();

  for (const entry of (env.DISCOUNT_CODES || "").split(",")) {
    const [name, percent] = entry.split("=").map(part => part.trim());
    const value = Number(percent);
    if (name && name.toUpperCase() === wanted && Number.isInteger(value) && value > 0 && value <= 100) {
      return { code: name.toUpperCase(), percent: value };
    }
  }

  throw new OrderValidationError("That discount code isn't valid.");

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
  Accepts a free-form string (the kitchen's own
  address) or a { line1, city, postalCode }
  object (a customer's address).
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
