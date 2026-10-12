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
    image: "./img/french-onion-soup.png",
    maxQuantity: 6
  },
  cheddar_jalapeno: {
    name: "Cheddar & Jalapeño",
    description: "Sharp cheddar and jalapeño folded into naturally leavened sourdough.",
    price: 1600,
    image: "./img/cheddar-jalapeno.png",
    maxQuantity: 6
  },
  cong_la: {
    name: "Cong La",
    description: "A Kirana Bakehouse seasonal inclusion sourdough.",
    price: 1600,
    image: "./img/cong-la.png",
    maxQuantity: 6
  },
  margherita: {
    name: "Margherita",
    description: "A sourdough inspired by the classic Margherita.",
    price: 1600,
    image: "./img/margherita.png",
    maxQuantity: 6
  },
  birds_eye: {
    name: "Bird's Eye",
    description: "A bright and spicy inclusion sourdough featuring bird's eye chili.",
    price: 1600,
    image: "./img/birds-eye.png",
    maxQuantity: 6
  },
  coconut_laddoo: {
    name: "Coconut Laddoo",
    description: "A sweet-inspired seasonal sourdough featuring coconut.",
    price: 1600,
    image: "./img/coconut-laddoo.png",
    maxQuantity: 6
  },
  birthday: {
    name: "Birthday",
    description: "A celebratory seasonal sourdough created for special occasions.",
    price: 1600,
    image: "./img/birthday.png",
    maxQuantity: 6
  },
  everything_seasoning: {
    name: "Everything Seasoning",
    description: "Our sourdough with a generous everything-seasoning crust.",
    price: 1300,
    image: "./img/everything-seasoning.png",
    maxQuantity: 6
  },
  house_white: {
    name: "House White",
    description: "Our classic everyday sourdough — simple, naturally leavened and versatile.",
    price: 1200,
    image: "./img/house-white.png",
    maxQuantity: 6
  }
});

export const DELIVERY = Object.freeze({
  firstAvailableOffsetDays: 3,
  clientDatesToScan: 15,
  serverDatesToScan: 30,
  unavailableDays: Object.freeze([0, 1, 2, 6]),
  locale: "en-US"
});

export const API = Object.freeze({
  createCheckoutSession: "/api/create-checkout-session",
  checkDelivery: "/api/check-delivery"
});

export const HTTP_STATUS = Object.freeze({
  badRequest: 400,
  internalServerError: 500
});

export const MONEY = Object.freeze({
  locale: "en-US",
  currency: "USD",
  centsPerDollar: 100
});

export const SERVER = Object.freeze({
  defaultPort: 3000,
  staticDirectory: ".",
  apiBasePath: "/api"
});

export const DELIVERY_SERVICE = Object.freeze({
  originAddress: "335 Trenton Way, Menlo Park, CA 94025",
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
