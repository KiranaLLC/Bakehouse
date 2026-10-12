/**
 * Application-wide configuration values.
 *
 * Keep values that describe the business or application in this file so the
 * storefront and checkout server use the same source of truth.
 */
export const PRODUCTS = Object.freeze({
  french_onion_soup: {
    name: "French Onion Soup",
    description: "A deeply savory sourdough inspired by classic French onion soup.",
    price: 1600,
    image: "./img/menu/french-onion-soup.jpg",
    maxQuantity: 6
  },
  cheddar_jalapeno: {
    name: "Cheddar & Jalapeño",
    description: "Sharp cheddar and jalapeño folded into naturally leavened sourdough.",
    price: 1600,
    image: "./img/menu/cheddar-jalapeno.jpg",
    maxQuantity: 6
  },
  cong_la: {
    name: "Cong La",
    description: "A Kirana Bakehouse seasonal inclusion sourdough.",
    price: 1600,
    image: "./img/menu/cong-la.jpg",
    maxQuantity: 6
  },
  margherita: {
    name: "Margherita",
    description: "A sourdough inspired by the classic Margherita.",
    price: 1600,
    image: "./img/menu/margherita.jpg",
    maxQuantity: 6
  },
  birds_eye: {
    name: "Bird's Eye",
    description: "A bright and spicy inclusion sourdough featuring bird's eye chili.",
    price: 1600,
    image: "./img/menu/birds-eye.jpg",
    maxQuantity: 6
  },
  coconut_laddoo: {
    name: "Coconut Laddoo",
    description: "A sweet-inspired seasonal sourdough featuring coconut.",
    price: 1600,
    image: "./img/menu/coconut-laddoo.jpg",
    maxQuantity: 6
  },
  birthday: {
    name: "Birthday",
    description: "A celebratory seasonal sourdough created for special occasions.",
    price: 1600,
    image: "./img/menu/birthday.jpg",
    maxQuantity: 6
  },
  everything_seasoning: {
    name: "Everything Seasoning",
    description: "Our sourdough with a generous everything-seasoning crust.",
    price: 1300,
    image: "./img/menu/everything-seasoning.jpg",
    maxQuantity: 6
  },
  house_white: {
    name: "House White",
    description: "Our classic everyday sourdough — simple, naturally leavened and versatile.",
    price: 1200,
    image: "./img/menu/house-white.jpg",
    maxQuantity: 6
  }
});

export const DELIVERY = Object.freeze({
  // Dates are always calculated in the bakery's time zone so the server
  // (which may run in UTC) and the customer's browser agree on "today".
  timeZone: "America/Los_Angeles",
  firstAvailableOffsetDays: 3,
  bookingWindowDays: 21,
  // Sunday = 0 … Saturday = 6
  unavailableDays: Object.freeze([0, 1, 2, 6]),
  // Dates we're closed (holidays, trips). Inclusive, YYYY-MM-DD.
  closedDates: Object.freeze([
    Object.freeze({ from: "2026-10-22", to: "2026-10-29" })
  ]),
  // Deliveries are made within this window on the chosen day.
  windowLabel: "between 2 pm and 4 pm",
  state: "CA",
  locale: "en-US",
  notesMaxLength: 300
});

/*
  The checkout worker (see worker/ and README.md). The website talks to it
  for address checks and to start a Stripe payment.
*/

// While WORKER_URL is still the placeholder, a page opened from localhost
// talks to a worker started locally with `npx wrangler dev`.
const WORKER_URL = "https://kirana-checkout.hellokiranabakehouse.workers.dev";
const LOCAL_WORKER_URL = "http://localhost:8787";

const isWorkerConfigured = !WORKER_URL.includes("REPLACE_WITH_YOUR_WORKER");
const isLocalSite = typeof location !== "undefined" && ["localhost", "127.0.0.1"].includes(location.hostname);

export const API = Object.freeze({
  origin: isWorkerConfigured ? WORKER_URL : LOCAL_WORKER_URL,
  isConfigured: isWorkerConfigured || isLocalSite,
  createCheckoutSession: "/api/create-checkout-session",
  checkDelivery: "/api/check-delivery",
  orderSummary: "/api/order-summary"
});

export const TIP = Object.freeze({
  // Percentages offered on the order page (0 = "No tip").
  presetPercents: Object.freeze([0, 10, 15, 20]),
  maxCents: 20000
});

export const HTTP_STATUS = Object.freeze({
  badRequest: 400,
  notFound: 404,
  internalServerError: 500
});

export const MONEY = Object.freeze({
  locale: "en-US",
  currency: "USD",
  centsPerDollar: 100
});

export const DELIVERY_SERVICE = Object.freeze({
  originAddress: "339 Trenton Way, Menlo Park, CA 94025",
  maxMiles: 4,
  // Sent with address lookups so OpenStreetMap can contact us if needed.
  userAgent: "Kirana-Bakehouse-Delivery-Checker/1.0 (hellokiranabakehouse@gmail.com)",
  countryCode: "us",
  geocoderUrl: "https://nominatim.openstreetmap.org/search",
  earthRadiusMiles: 3958.8,
  zones: Object.freeze([
    Object.freeze({ maxMiles: 1, feeCents: 0, freeOverCents: 0 }),
    Object.freeze({ maxMiles: 2, feeCents: 300, freeOverCents: 5000 }),
    Object.freeze({ maxMiles: 3, feeCents: 450, freeOverCents: 5000 }),
    Object.freeze({ maxMiles: 4, feeCents: 600, freeOverCents: 5000 })
  ])
});
