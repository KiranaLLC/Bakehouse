/**
 * Delivery dates and pricing rules used by the order pages.
 */
import { DELIVERY, DELIVERY_SERVICE, MONEY, PRODUCTS } from "./macros.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function formatMoney(cents) {
  return new Intl.NumberFormat(MONEY.locale, { style: "currency", currency: MONEY.currency }).format(cents / MONEY.centsPerDollar);
}

/*
==================================================
DELIVERY DATES
==================================================
*/

// Today's date in the bakery's time zone, as a UTC-midnight Date.
function bakeryToday(now) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: DELIVERY.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  return Date.UTC(year, month - 1, day);
}

export function formatDeliveryDate(value) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(DELIVERY.locale, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

/**
 * Every date a customer can currently choose, as { value: "YYYY-MM-DD", label }.
 */
export function getDeliveryDates(now = new Date()) {
  const today = bakeryToday(now);
  const dates = [];

  for (let offset = DELIVERY.firstAvailableOffsetDays; offset < DELIVERY.firstAvailableOffsetDays + DELIVERY.bookingWindowDays; offset++) {
    const date = new Date(today + offset * MS_PER_DAY);
    if (DELIVERY.unavailableDays.includes(date.getUTCDay())) continue;

    const value = date.toISOString().slice(0, 10);
    dates.push({ value, label: formatDeliveryDate(value) });
  }

  return dates;
}

// e.g. "Wednesday, Thursday, and Friday"
export function describeDeliveryDays() {
  const sunday = Date.UTC(2024, 0, 7);
  const days = [1, 2, 3, 4, 5, 6, 0]
    .filter(day => !DELIVERY.unavailableDays.includes(day))
    .map(day => new Date(sunday + day * MS_PER_DAY).toLocaleDateString(DELIVERY.locale, { timeZone: "UTC", weekday: "long" }));
  return new Intl.ListFormat(DELIVERY.locale, { type: "conjunction" }).format(days);
}

/*
==================================================
PRICING
==================================================
*/

export function calculateSubtotal(items) {
  return items.reduce((total, { productId, quantity }) => total + PRODUCTS[productId].price * quantity, 0);
}

export function findDeliveryZone(distanceMiles) {
  return DELIVERY_SERVICE.zones.find(({ maxMiles }) => distanceMiles <= maxMiles) || null;
}

export function calculateDeliveryFee(zone, subtotalCents) {
  if (!zone || zone.feeCents === 0) return 0;
  return subtotalCents >= zone.freeOverCents ? 0 : zone.feeCents;
}
