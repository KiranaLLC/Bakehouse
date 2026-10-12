import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import {
  API,
  DELIVERY,
  DELIVERY_SERVICE,
  HTTP_STATUS,
  PRODUCTS,
  SERVER
} from "./macros.js";
import {
  calculateDeliveryFee,
  calculateSubtotal,
  describeDeliveryDays,
  findDeliveryZone,
  formatDeliveryDate,
  isDeliveryDateAvailable
} from "./delivery-rules.js";

dotenv.config();

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set. Copy .env.example to .env and add your Stripe key.");
  process.exit(1);
}

/*
==================================================
APP
==================================================
*/

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

/*
==================================================
STRIPE
==================================================
*/

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

let originCoordinates;
const geocodeCache = new Map();
const GEOCODE_CACHE_LIMIT = 500;

class AddressNotFoundError extends Error {}
class OrderValidationError extends Error {}

/*
==================================================
SERVE WEBSITE

The website files live next to the server code,
so make sure the server's own files are never
served. (Dotfiles such as .env are already
ignored by express.static.)
==================================================
*/

const PRIVATE_PATHS = ["/server.js", "/package.json", "/package-lock.json", "/node_modules"];

app.use((req, res, next) => {
  const path = req.path.toLowerCase();
  if (PRIVATE_PATHS.some(privatePath => path === privatePath || path.startsWith(`${privatePath}/`))) {
    return res.sendStatus(HTTP_STATUS.notFound);
  }
  next();
});

app.use(express.static(SERVER.staticDirectory));

/*
==================================================
JSON API
==================================================
*/

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

// Only needed when the website is hosted somewhere other than this server
// (for example GitHub Pages). See README.md.
app.use(SERVER.apiBasePath, (req, res, next) => {
  const origin = req.get("Origin");
  if (origin && allowedOrigins.includes(origin)) {
    res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST", Vary: "Origin" });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  SERVER.apiBasePath,
  express.json({ limit: "20kb" })
);

app.post(API.checkDelivery, async (req, res) => {
  let address;

  try {
    address = typeof req.body.address === "string" ? cleanText(req.body.address, 300) : parseAddress(req.body.address);
  } catch (error) {
    return res.status(HTTP_STATUS.badRequest).json({ error: error.message });
  }

  if (!address) {
    return res.status(HTTP_STATUS.badRequest).json({ error: "Please enter a delivery address." });
  }

  try {
    const { distanceMiles, zone } = await checkDeliveryArea(address);

    if (!zone) {
      return res.json({ deliverable: false, distanceMiles, message: `This address is outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.` });
    }

    res.json({ deliverable: true, distanceMiles, feeCents: zone.feeCents, freeOverCents: zone.freeOverCents });
  } catch (error) {
    if (error instanceof AddressNotFoundError) {
      return res.status(HTTP_STATUS.badRequest).json({ error: error.message });
    }
    console.error("Delivery area check error:", error);
    res.status(HTTP_STATUS.internalServerError).json({ error: "We couldn't check that address right now. Please try again." });
  }
});

/*
==================================================
CREATE STRIPE CHECKOUT SESSION

IMPORTANT:
Prices, the delivery fee and the delivery area
are all worked out here on the SERVER.

Do not trust prices sent from the browser.
==================================================
*/

app.post(
  API.createCheckoutSession,
  async (req, res) => {

    try {

      const items = parseItems(req.body.items);
      const deliveryDate = parseDeliveryDate(req.body.deliveryDate);
      const customer = parseCustomer(req.body.customer);
      const address = parseAddress(req.body.address);
      const notes = parseNotes(req.body.notes);

      /*
      ==========================================
      DELIVERY AREA + FEE
      ==========================================
      */

      const { distanceMiles, zone } = await checkDeliveryArea(address);

      if (!zone) {
        throw new OrderValidationError(`Sorry, this address is about ${distanceMiles} miles away, outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.`);
      }

      const subtotal = calculateSubtotal(items);
      const deliveryFee = calculateDeliveryFee(zone, subtotal);

      /*
      ==========================================
      BUILD STRIPE LINE ITEMS
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
        lineItems.push({
          price_data: {
            currency: "usd",
            product_data: { name: "Local delivery" },
            unit_amount: deliveryFee
          },
          quantity: 1
        });
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
        delivery_notes: notes
      };

      const siteUrl = (process.env.SITE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

      /*
      ==========================================
      STRIPE CHECKOUT

      Stripe collects the email address and card
      details. The delivery address was already
      checked above, so Stripe doesn't ask for it
      again (and the customer can't change it to
      one outside the delivery area).
      ==========================================
      */

      const session =
        await stripe.checkout.sessions.create({

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

          success_url:
            `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,

          cancel_url:
            `${siteUrl}/order.html?cancelled=true`

        });

      res.json({
        url: session.url
      });

    }

    catch (error) {

      if (error instanceof OrderValidationError || error instanceof AddressNotFoundError) {
        return res.status(HTTP_STATUS.badRequest).json({ error: error.message });
      }

      console.error(
        "Stripe error:",
        error
      );

      res.status(HTTP_STATUS.internalServerError).json({
        error: "Unable to start Stripe checkout. Please try again."
      });

    }

  }
);

/*
==================================================
ORDER SUMMARY (success page)
==================================================
*/

app.get(API.orderSummary, async (req, res) => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";

  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(HTTP_STATUS.badRequest).json({ error: "Invalid order reference." });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });

    if (session.payment_status !== "paid") {
      return res.status(HTTP_STATUS.notFound).json({ error: "We couldn't find a completed payment for this order." });
    }

    res.json({
      email: session.customer_details?.email || "",
      name: session.metadata.customer_name,
      deliveryDate: session.metadata.delivery_date_label,
      address: session.metadata.delivery_address,
      items: session.line_items.data.map(item => ({ name: item.description, quantity: item.quantity, amountTotal: item.amount_total })),
      amountTotal: session.amount_total
    });
  } catch (error) {
    console.error("Order summary error:", error);
    res.status(HTTP_STATUS.notFound).json({ error: "We couldn't load your order details." });
  }
});

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
    const product = PRODUCTS[item?.productId];
    const quantity = Number(item?.quantity);

    if (!product || !Object.hasOwn(PRODUCTS, item.productId)) {
      throw new OrderValidationError("Invalid product.");
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new OrderValidationError("Invalid quantity.");
    }

    const total = (quantities.get(item.productId) || 0) + quantity;

    if (total > product.maxQuantity) {
      throw new OrderValidationError(`${product.name} has a maximum quantity of ${product.maxQuantity}.`);
    }

    quantities.set(item.productId, total);
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

function parseNotes(notes) {
  return cleanText(notes, DELIVERY.notesMaxLength);
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
  const [destination, origin] = await Promise.all([geocodeAddress(address), getOriginCoordinates()]);
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
  if (!response.ok) throw new Error(`Geocoder request failed with status ${response.status}.`);

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


/*
==================================================
START SERVER
==================================================
*/

const PORT =
  process.env.PORT || SERVER.defaultPort;

app.listen(
  PORT,
  () => {

    console.log(
      `Kirana Bakehouse server running on port ${PORT}`
    );

  }
);
