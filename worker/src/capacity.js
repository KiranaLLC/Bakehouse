/*
==================================================
DAILY CAPACITY

The bakery can bake DELIVERY.dailyLoafLimit loaves
for each delivery day. Orders live in Stripe, so
the loaves already booked for a day are counted
from Stripe Checkout Sessions:

  - "complete" sessions are placed orders
  - "open" sessions are customers on the payment
    page right now; their loaves are held until
    the session expires (CHECKOUT_HOLD_SECONDS)

Expired sessions free their loaves again.
==================================================
*/

import { DELIVERY } from "../../macros.js";

// Stripe only allows a Checkout Session to expire 30 minutes to 24 hours after
// it's created. The extra minute keeps us clear of that lower limit.
export const CHECKOUT_HOLD_SECONDS = 31 * 60;

// Checkout line items that aren't loaves.
export const NON_LOAF_LINES = new Set(["Local delivery", "Tip for your baker"]);

export function countLoaves(items) {
  return items.reduce((total, { quantity }) => total + quantity, 0);
}

export function holdsCapacity(session) {
  return Boolean(session?.metadata?.delivery_date) && (session.status === "complete" || session.status === "open");
}

/*
  Loaves in a session, from the loaf_count saved on
  it. Sessions created before that existed return
  null, and their line items are counted instead.
*/
export function loavesFromMetadata(session) {
  const count = Number(session?.metadata?.loaf_count);
  return session?.metadata?.loaf_count !== undefined && Number.isInteger(count) && count >= 0 ? count : null;
}

// Line items include delivery and tip lines; everything else is a loaf, even
// one that has since left the menu.
export function loavesFromLineItems(lineItems) {
  return lineItems
    .filter(({ description }) => !NON_LOAF_LINES.has(description))
    .reduce((total, { quantity }) => total + quantity, 0);
}

export function remainingLoaves(booked) {
  return Math.max(DELIVERY.dailyLoafLimit - booked, 0);
}

// How far back a session for a still-bookable date can have been created.
export function lookbackSeconds() {
  return (DELIVERY.firstAvailableOffsetDays + DELIVERY.bookingWindowDays + 1) * 24 * 60 * 60;
}

// Says the day can't take the order without revealing how many loaves are left.
export function describeShortfall(remaining, wanted, dateLabel) {
  if (remaining === 0) {
    return `Sorry, ${dateLabel} is fully booked. Please choose another delivery date.`;
  }
  return `Sorry, ${dateLabel} can't fit your order of ${wanted} loaves. Please choose another delivery date, or remove a few loaves.`;
}
