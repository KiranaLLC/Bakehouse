/**
 * Application-wide configuration values.
 *
 * Keep values that describe the business or application in this file so the
 * storefront and checkout server use the same source of truth.
 */
// Every loaf starts with these; each product lists only what it adds.
export const BASE_INGREDIENTS = Object.freeze(["Organic Unbleached All Purpose Flour", "Water", "Sea Salt"]);

export const PRODUCTS = Object.freeze({
  birds_eye: {
    name: "Bird's Eye",
    description: "Chili cheese garlic bread, with the kick of bird's eye chili.",
    price: 1600,
    image: "./img/menu/birds-eye.jpg",
    ingredients: ["Bird's Eye Chili", "Garlic", "Mozzarella Cheese"],
    maxQuantity: 6
  },
  birthday: {
    name: "Birthday",
    description: "Rainbow sprinkles folded into a sourdough bread.",
    price: 1600,
    image: "./img/menu/birthday.jpg",
    ingredients: ["Rainbow Sprinkles"],
    maxQuantity: 6
  },
  cheddar_jalapeno: {
    name: "Cheddar & Jalapeño",
    description: "A classic sourdough flavour with melty cheese and a kick of jalapeño.",
    price: 1600,
    image: "./img/menu/cheddar-jalapeno.jpg",
    ingredients: ["Sharp Cheddar Cheese", "Pickled Jalapeños"],
    maxQuantity: 6
  },
  coconut_laddoo: {
    name: "Coconut Laddoo",
    description: "The classic Indian sweet, reimagined as a sourdough.",
    price: 1600,
    image: "./img/menu/coconut-laddoo.jpg",
    ingredients: ["Dried Coconut", "Brown Sugar", "Jaggery", "Cardamom"],
    maxQuantity: 6
  },
  cong_la: {
    name: "Cong La",
    description: "Scallion pancakes with chili oil inspired sourdough bread.",
    price: 1600,
    image: "./img/menu/cong-la.jpg",
    ingredients: ["Scallions", "Garlic", "Chili Oil"],
    maxQuantity: 6
  },
  double_chocolate: {
    name: "Double Chocolate",
    description: "Your favourite brownie, baked into a sourdough.",
    price: 1600,
    image: "./img/menu/double-chocolate.jpg",
    ingredients: ["Milk Chocolate Chips", "Unsweetened Cocoa Powder", "Vanilla Essence"],
    maxQuantity: 6
  },
  elote: {
    name: "Elote",
    description: "Bringing Mexican street corn flavours to sourdough bread.",
    price: 1600,
    image: "./img/menu/elote.jpg",
    ingredients: ["Roasted Corn", "Cotija Cheese", "Chili Powder"],
    maxQuantity: 6
  },
  everything_seasoning: {
    name: "Everything Seasoning",
    description: "The everything bagel inspired sourdough bread.",
    price: 1300,
    image: "./img/menu/everything-seasoning.jpg",
    ingredients: ["Sesame Seeds", "Black Sesame Seeds", "Poppy Seeds", "Dehydrated Garlic", "Dehydrated Onion", "Salt"],
    maxQuantity: 6
  },
  french_onion_soup: {
    name: "French Onion Soup",
    description: "The cozy French classic soup inspired sourdough bread.",
    price: 1600,
    image: "./img/menu/french-onion-soup.jpg",
    ingredients: ["Caramelized Onions", "Gruyère Cheese"],
    maxQuantity: 6
  },
  house_white: {
    name: "House White",
    description: "Our classic sourdough: simple and made for every day.",
    price: 1200,
    image: "./img/menu/house-white.jpg",
    ingredients: [],
    maxQuantity: 6
  },
  im_like_a_bird: {
    name: "I'm Like a Bird (ILAB)",
    description: "A seed-packed sourdough the birds would envy.",
    price: 1600,
    image: "./img/menu/ilab.jpg",
    ingredients: ["Black Sesame Seeds", "White Sesame Seeds", "Pumpkin Seeds", "Chia Seeds", "Hemp Seeds"],
    maxQuantity: 6
  },
  margherita: {
    name: "Margherita",
    description: "Margherita pizza(not the drink!), reimagined as a sourdough.",
    price: 1600,
    image: "./img/menu/margherita.jpg",
    ingredients: ["Tomato", "Mozzarella Cheese", "Italian Seasoning", "Basil"],
    maxQuantity: 6
  },
  pumpkin_spice: {
    name: "Pumpkin Spice",
    description: "Autumn's favourite flavour, baked into a sourdough.",
    price: 1600,
    image: "./img/menu/pumpkin-spice.jpg",
    ingredients: ["Pumpkin Purée", "Cinnamon", "Ginger", "Lemon Peel", "Nutmeg", "Cloves", "Cardamom"],
    maxQuantity: 6
  }
});

export const DELIVERY = Object.freeze({
  // Dates are always calculated in the bakery's time zone so the server
  // (which may run in UTC) and the customer's browser agree on "today".
  timeZone: "America/Los_Angeles",
  firstAvailableOffsetDays: 3,
  bookingWindowDays: 15,
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
  checkDiscount: "/api/check-discount",
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
