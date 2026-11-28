/**
 * Delivery and pricing rules shared by the order page and the checkout
 * server, so what the customer sees is exactly what they are charged.
 */
import { DELIVERY, DELIVERY_SERVICE, MONEY, PRODUCTS, SERVICE_FEE } from "./macros.js";

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

// Today in the bakery's time zone, as "YYYY-MM-DD".
export function bakeryTodayValue(now = new Date()) {
  return new Date(bakeryToday(now)).toISOString().slice(0, 10);
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
    if (DELIVERY.closedDates.some(({ from, to }) => value >= from && value <= to)) continue;
    dates.push({ value, label: formatDeliveryDate(value) });
  }

  return dates;
}

export function isDeliveryDateAvailable(value, now = new Date()) {
  return getDeliveryDates(now).some(date => date.value === value);
}

// e.g. "Thursday, October 15, between 2 pm and 4 pm"
export function formatDeliverySlot(value) {
  return `${formatDeliveryDate(value)}, ${DELIVERY.windowLabel}`;
}

// e.g. "Wednesdays, Thursdays, Fridays"
export function describeDeliveryDays() {
  const sunday = Date.UTC(2024, 0, 7);
  return [1, 2, 3, 4, 5, 6, 0]
    .filter(day => !DELIVERY.unavailableDays.includes(day))
    .map(day => `${new Date(sunday + day * MS_PER_DAY).toLocaleDateString(DELIVERY.locale, { timeZone: "UTC", weekday: "long" })}s`)
    .join(", ");
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

// Discounts apply to the loaves and delivery, never to the tip.
export function calculateDiscount(percent, subtotalCents, deliveryFeeCents) {
  if (!percent) return 0;
  return Math.round((subtotalCents + deliveryFeeCents) * percent / 100);
}

// The service fee on an order (SERVICE_FEE in macros.js), from the loaves and
// delivery after any discount, in cents. 0 when there's nothing to pay.
export function calculateServiceFee(fee, chargeableCents) {
  if (!fee || chargeableCents <= 0 || (!fee.percent && !fee.flatCents)) return 0;
  return Math.round(chargeableCents * fee.percent / 100) + fee.flatCents;
}

export function calculateDeliveryFee(zone, subtotalCents) {
  if (!zone || zone.feeCents === 0) return 0;
  return subtotalCents >= zone.freeOverCents ? 0 : zone.feeCents;
}

/*
==================================================
GIFT CARDS

Used by the order page (for its totals) and the
worker (for the real charge), so they agree.
==================================================
*/

// Stripe can't charge a card less than this.
export const STRIPE_MINIMUM_CENTS = 50;

/*
  How much of a card an order uses, and the
  payment processing fee on what's left.
    baseCents: loaves + delivery − discount
    tipCents:  the tip
  Returns { giftCents, serviceFee, totalCents }.
  Never leaves a card payment under Stripe's 50¢
  minimum: the card covers the whole order, or
  leaves at least 50¢ to pay.
*/
export function planGiftCard(balanceCents, { baseCents, tipCents }, fee = SERVICE_FEE) {
  const base = Math.max(0, baseCents);
  const tip = Math.max(0, tipCents);
  const balance = Math.max(0, balanceCents);

  let onBase = Math.min(balance, base);
  let onTip = Math.min(balance - onBase, tip);
  const totalFor = () => {
    const serviceFee = calculateServiceFee(fee, base - onBase);
    return { serviceFee, totalCents: base - onBase + serviceFee + tip - onTip };
  };

  let { serviceFee, totalCents } = totalFor();
  for (let tries = 0; totalCents > 0 && totalCents < STRIPE_MINIMUM_CENTS && tries < 10; tries += 1) {
    let short = STRIPE_MINIMUM_CENTS - totalCents;
    const fromTip = Math.min(onTip, short);
    onTip -= fromTip;
    short -= fromTip;
    onBase -= Math.min(onBase, short);
    ({ serviceFee, totalCents } = totalFor());
  }

  return { giftCents: onBase + onTip, serviceFee, totalCents };
}

