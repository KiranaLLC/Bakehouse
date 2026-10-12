/**
 * Application-wide configuration values.
 *
 * Keep values that describe the business or application in this file so every
 * page uses the same source of truth.
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
  // Dates are always calculated in the bakery's time zone, wherever the
  // customer happens to be.
  timeZone: "America/Los_Angeles",
  firstAvailableOffsetDays: 3,
  bookingWindowDays: 21,
  // Sunday = 0 … Saturday = 6
  unavailableDays: Object.freeze([0, 1, 2, 6]),
  state: "CA",
  locale: "en-US"
});

export const MONEY = Object.freeze({
  locale: "en-US",
  currency: "USD",
  centsPerDollar: 100
});

/*
  Delivery zones by distance from the kitchen. Each zone has its own Stripe
  Payment Link, identical apart from the delivery charge — see README.md.
*/
export const DELIVERY_SERVICE = Object.freeze({
  originAddress: "339 Trenton Way, Menlo Park, CA 94025",
  maxMiles: 4,
  // Sent to the address lookup service so they can contact us if needed.
  contactEmail: "hellokiranabakehouse@gmail.com",
  countryCode: "us",
  geocoderUrl: "https://nominatim.openstreetmap.org/search",
  earthRadiusMiles: 3958.8,
  zones: Object.freeze([
    Object.freeze({ maxMiles: 1, feeCents: 0, paymentLinkUrl: "" }),
    Object.freeze({ maxMiles: 2, feeCents: 300, paymentLinkUrl: "" }),
    Object.freeze({ maxMiles: 3, feeCents: 450, paymentLinkUrl: "" }),
    Object.freeze({ maxMiles: 4, feeCents: 600, paymentLinkUrl: "" })
  ])
});
