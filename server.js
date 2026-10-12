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

dotenv.config();

/*
==================================================
APP
==================================================
*/

const app = express();

/*
==================================================
STRIPE
==================================================
*/

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

let originCoordinates;

/*
==================================================
PRODUCT CATALOG

IMPORTANT:
Prices are stored on the SERVER.

Do not trust prices sent
from the browser.
==================================================
*/

/*
==================================================
SERVE WEBSITE
==================================================
*/

app.use(express.static(SERVER.staticDirectory));

/*
==================================================
JSON API
==================================================
*/

app.use(
  SERVER.apiBasePath,
  express.json()
);

app.post(API.checkDelivery, async (req, res) => {
  const address = typeof req.body.address === "string" ? req.body.address.trim() : "";

  if (!address) {
    return res.status(HTTP_STATUS.badRequest).json({ error: "Please enter a delivery address." });
  }

  try {
    const [destination, origin] = await Promise.all([geocodeAddress(address), getOriginCoordinates()]);
    const distanceMiles = calculateDistanceMiles(origin, destination);
    const zone = DELIVERY_SERVICE.zones.find(({ maxMiles }) => distanceMiles <= maxMiles);

    if (!zone) {
      return res.json({ deliverable: false, distanceMiles: Number(distanceMiles.toFixed(1)), message: "This address is outside our 4-mile delivery area." });
    }

    res.json({ deliverable: true, distanceMiles: Number(distanceMiles.toFixed(1)), feeCents: zone.feeCents, freeOverCents: zone.freeOverCents });
  } catch (error) {
    console.error("Delivery area check error:", error);
    res.status(HTTP_STATUS.internalServerError).json({ error: "We couldn't check that address right now. Please try again." });
  }
});

/*
==================================================
CREATE STRIPE CHECKOUT SESSION
==================================================
*/

app.post(
  API.createCheckoutSession,
  async (req, res) => {

    try {

      const {
        items,
        deliveryDate
      } = req.body;

      /*
      ==========================================
      VALIDATE CART
      ==========================================
      */

      if (
        !Array.isArray(items) ||
        items.length === 0
      ) {

        return res.status(HTTP_STATUS.badRequest).json({
          error: "Your cart is empty."
        });

      }

      /*
      ==========================================
      VALIDATE DELIVERY DATE
      ==========================================

      Delivery:
      Tuesday
      Wednesday
      Thursday
      Friday
      Saturday

      NO DELIVERY:
      Sunday
      Monday
      ==========================================
      */

      if (!deliveryDate) {

        return res.status(HTTP_STATUS.badRequest).json({
          error: "Please select a delivery date."
        });

      }

      const selectedDate =
        new Date(`${deliveryDate}T12:00:00`);

      if (
        Number.isNaN(
          selectedDate.getTime()
        )
      ) {

        return res.status(HTTP_STATUS.badRequest).json({
          error: "Invalid delivery date."
        });

      }

      const day =
        selectedDate.getDay();

      /*
        Sunday = 0
        Monday = 1
        Tuesday = 2
        Wednesday = 3
        Thursday = 4
        Friday = 5
        Saturday = 6
      */

      if (
        DELIVERY.unavailableDays.includes(day)
      ) {

        return res.status(HTTP_STATUS.badRequest).json({
          error:
            "Delivery is not available on Sunday or Monday."
        });

      }

      /*
      ==========================================
      BUILD STRIPE LINE ITEMS
      ==========================================
      */

      const lineItems = [];

      for (
        const item of items
      ) {

        const product =
          PRODUCTS[item.productId];

        if (!product) {

          return res.status(HTTP_STATUS.badRequest).json({
            error: "Invalid product."
          });

        }

        const quantity =
          Number(item.quantity);

        if (
          !Number.isInteger(quantity) ||
          quantity < 1
        ) {

          return res.status(HTTP_STATUS.badRequest).json({
            error: "Invalid quantity."
          });

        }

        if (
          quantity >
          product.maxQuantity
        ) {

          return res.status(HTTP_STATUS.badRequest).json({
            error:
              `${product.name} has a maximum quantity of ${product.maxQuantity}.`
          });

        }

        lineItems.push({

          price_data: {

            currency: "usd",

            product_data: {
              name: product.name
            },

            unit_amount:
              product.price

          },

          quantity

        });

      }

      /*
      ==========================================
      STRIPE CHECKOUT
      ==========================================
      */

      const session =
        await stripe.checkout.sessions.create({

          /*
          --------------------------------------
          PAYMENT
          --------------------------------------
          */

          mode: "payment",

          line_items: lineItems,

          /*
          --------------------------------------
          CUSTOMER EMAIL
          --------------------------------------

          Stripe collects this directly.
          */

          customer_creation: "always",

          /*
          --------------------------------------
          SHIPPING ADDRESS
          --------------------------------------

          Stripe collects:

          Name
          Street
          City
          State
          ZIP
          Country
          */

          shipping_address_collection: {
            allowed_countries: ["US"]
          },

          /*
          --------------------------------------
          PHONE
          --------------------------------------

          Stripe collects phone number.
          */

          phone_number_collection: {
            enabled: true
          },

          /*
          --------------------------------------
          DELIVERY DATE
          --------------------------------------

          Stripe shows a dropdown on checkout.
          */

          custom_fields: [

            {
              key: "delivery_date",

              label: {
                type: "custom",
                custom: "Delivery Date"
              },

              type: "dropdown",

              dropdown: {

                options:
                  generateDeliveryDateOptions(),

                default_value:
                  generateDeliveryDateOptions()[0].value

              },

              optional: false
            }

          ],

          /*
          --------------------------------------
          CHECKOUT TEXT
          --------------------------------------
          */

          custom_text: {

            shipping_address: {
              message:
                "Please enter the address where you would like your sourdough delivered."
            },

            submit: {
              message:
                "Your order will be prepared fresh for your selected delivery date."
            }

          },

          /*
          --------------------------------------
          METADATA
          --------------------------------------

          We keep the date in metadata too so
          your order information is easy to
          reference from Stripe/webhooks.
          */

          metadata: {

            delivery_date:
              deliveryDate

          },

          /*
          --------------------------------------
          SUCCESS
          --------------------------------------
          */

          success_url:
            `${process.env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,

          /*
          --------------------------------------
          CANCEL
          --------------------------------------
          */

          cancel_url:
            `${process.env.SITE_URL}/order.html?cancelled=true`

        });

      /*
      ==========================================
      RETURN STRIPE CHECKOUT URL
      ==========================================
      */

      res.json({
        url: session.url
      });

    }

    catch (error) {

      console.error(
        "Stripe error:",
        error
      );

      res.status(HTTP_STATUS.internalServerError).json({

        error:
          "Unable to start Stripe checkout."

      });

    }

  }
);


/*
==================================================
GENERATE DELIVERY DATES
==================================================

Tuesday-Saturday only.

Generates the next 30 available
delivery dates.
==================================================
*/

function generateDeliveryDateOptions() {

  const options = [];

  const today = new Date();

  for (
    let i = 0;
    i < DELIVERY.serverDatesToScan;
    i++
  ) {

    const date =
      new Date(today);

    date.setDate(
      today.getDate() + i + DELIVERY.firstAvailableOffsetDays
    );

    const day =
      date.getDay();

    /*
      Skip:

      Sunday = 0
      Monday = 1
    */

    if (
      DELIVERY.unavailableDays.includes(day)
    ) {

      continue;

    }

    const year =
      date.getFullYear();

    const month =
      String(
        date.getMonth() + 1
      ).padStart(2, "0");

    const dayNumber =
      String(
        date.getDate()
      ).padStart(2, "0");

    // Stripe dropdown values may contain only alphanumeric characters.
    // Keep the formatted date for display and order metadata, but use a
    // Stripe-safe identifier for the checkout custom field.
    const value =
      `date${year}${month}${dayNumber}`;

    const label =
      date.toLocaleDateString(
        DELIVERY.locale,
        {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric"
        }
      );

    options.push({

      label,

      value

    });

  }

  return options;
}

async function getOriginCoordinates() {
  if (!originCoordinates) originCoordinates = await geocodeAddress(DELIVERY_SERVICE.originAddress);
  return originCoordinates;
}

async function geocodeAddress(address) {
  const searchParams = new URLSearchParams({ q: address, format: "jsonv2", limit: "1", countrycodes: DELIVERY_SERVICE.countryCode });
  const response = await fetch(`${DELIVERY_SERVICE.geocoderUrl}?${searchParams}`, { headers: { "User-Agent": "Kirana-Bakehouse-Delivery-Checker/1.0" } });
  if (!response.ok) throw new Error(`Geocoder request failed with status ${response.status}.`);

  const [location] = await response.json();
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Address could not be geocoded.");
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
