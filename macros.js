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
    description: "Fiery bird's eye chili and garlic, mellowed by pockets of melted mozzarella. A loaf with real heat, made for toasting.",
    price: 1600,
    image: "./img/menu/birds-eye.jpg",
    ingredients: ["Bird's Eye Chili", "Garlic", "Mozzarella Cheese"],
    maxQuantity: 6
  },
  birthday: {
    name: "Birthday",
    description: "Our tangy, open-crumbed sourdough studded with rainbow sprinkles. A little celebration in every slice.",
    price: 1600,
    image: "./img/menu/birthday.jpg",
    ingredients: ["Rainbow Sprinkles"],
    maxQuantity: 6
  },
  cheddar_jalapeno: {
    name: "Cheddar & Jalapeño",
    description: "Sharp cheddar and pickled jalapeños folded through the dough, with cheese that crisps on the crust. Tangy, cheesy and just spicy enough.",
    price: 1600,
    image: "./img/menu/cheddar-jalapeno.jpg",
    ingredients: ["Sharp Cheddar Cheese", "Pickled Jalapeños"],
    maxQuantity: 6
  },
  coconut_laddoo: {
    name: "Coconut Laddoo",
    description: "Inspired by the classic Indian sweet: dried coconut, brown sugar and jaggery, warmed with cardamom. Gently sweet and fragrant, and wonderful toasted with butter.",
    price: 1600,
    image: "./img/menu/coconut-laddoo.jpg",
    ingredients: ["Dried Coconut", "Brown Sugar", "Jaggery", "Cardamom"],
    maxQuantity: 6
  },
  cong_la: {
    name: "Cong La",
    description: "A savory scallion loaf with garlic and a ribbon of chili oil. Aromatic, a little spicy, and best eaten warm.",
    price: 1600,
    image: "./img/menu/cong-la.jpg",
    ingredients: ["Scallions", "Garlic", "Chili Oil"],
    maxQuantity: 6
  },
  elote: {
    name: "Elote",
    description: "Mexican street corn in a loaf: sweet roasted corn, salty cotija and a kick of chili powder.",
    price: 1600,
    image: "./img/menu/elote.jpg",
    ingredients: ["Roasted Corn", "Cotija Cheese", "Chili Powder"],
    maxQuantity: 6
  },
  everything_seasoning: {
    name: "Everything Seasoning",
    description: "Our sourdough with a generous everything crust of black and white sesame, poppy seeds, garlic and onion. Made for sandwiches and cream cheese.",
    price: 1300,
    image: "./img/menu/everything-seasoning.jpg",
    ingredients: ["Sesame Seeds", "Black Sesame Seeds", "Poppy Seeds", "Dehydrated Garlic", "Dehydrated Onion", "Salt"],
    maxQuantity: 6
  },
  french_onion_soup: {
    name: "French Onion Soup",
    description: "Deeply caramelized onions and nutty Gruyère, for a savory loaf that tastes like the classic soup.",
    price: 1600,
    image: "./img/menu/french-onion-soup.jpg",
    ingredients: ["Caramelized Onions", "Gruyère Cheese"],
    maxQuantity: 6
  },
  house_white: {
    name: "House White",
    description: "Our everyday sourdough: just flour, water and salt, naturally leavened for a crackly crust, a chewy open crumb and a gentle tang.",
    price: 1200,
    image: "./img/menu/house-white.jpg",
    ingredients: [],
    maxQuantity: 6
  },
  im_like_a_bird: {
    name: "I'm Like a Bird (ILAB)",
    description: "A seed lover's loaf, packed with black and white sesame, pumpkin, chia and hemp seeds. Nutty, toasty and full of crunch.",
    price: 1600,
    image: "./img/menu/ilab.jpg",
    ingredients: ["Black Sesame Seeds", "White Sesame Seeds", "Pumpkin Seeds", "Chia Seeds", "Hemp Seeds"],
    maxQuantity: 6
  },
  margherita: {
    name: "Margherita",
    description: "Tomato, mozzarella, basil and Italian herbs: the classic pizza, baked into a loaf. Perfect for grilled cheese.",
    price: 1600,
    image: "./img/menu/margherita.jpg",
    ingredients: ["Tomato", "Mozzarella Cheese", "Italian Seasoning", "Basil"],
    maxQuantity: 6
  },
  pumpkin_spice: {
    name: "Pumpkin Spice",
    description: "Pumpkin purée gives this autumn loaf its golden crumb, warmed with cinnamon, ginger, nutmeg, cloves, cardamom and a hint of lemon peel.",
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
