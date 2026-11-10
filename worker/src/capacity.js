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

Invoices made in the Stripe Dashboard (e.g. for
catering) count too, once they're sent or paid:
metadata delivery_date = YYYY-MM-DD puts one on a
delivery day, drop_id = <drop number> on a pickup
drop. Its loaves are its line quantities, minus
delivery/fee/tip lines, unless metadata
loaf_count says otherwise.
==================================================
*/

import { DELIVERY } from "../../macros.js";
import { listInvoicesSince } from "./stripe-cache.js";

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

// Invoice lines that aren't loaves: kept out of capacity and prep counts.
export const NON_LOAF_INVOICE_LINE = /\b(delivery|shipping|tip|gratuity|fee|discount)\b/i;

// How far back a sent or paid invoice can have been created and still count.
export const INVOICE_LOOKBACK_SECONDS = 90 * 24 * 60 * 60;

// An invoice's loaf lines as { name, quantity }.
export function invoiceLoafItems(lines) {
  return lines
    .filter(({ description }) => !NON_LOAF_LINES.has(description) && !NON_LOAF_INVOICE_LINE.test(description || ""))
    .map(({ description, quantity }) => ({ name: description || "Item", quantity: quantity || 1 }));
}

export function loavesFromInvoice(invoice, lines) {
  const count = Number(invoice?.metadata?.loaf_count);
  if (invoice?.metadata?.loaf_count !== undefined && invoice.metadata.loaf_count !== "" && Number.isInteger(count) && count >= 0) return count;
  return invoiceLoafItems(lines).reduce((total, { quantity }) => total + quantity, 0);
}

/*
  Sent and paid invoices that are on a delivery day
  or a pickup drop, as { id, deliveryDate, dropId,
  loaves }. Drafts and voided invoices don't count.
*/
export async function listCapacityInvoices(env, stripe, { fresh = true } = {}) {

  const since = Math.floor(Date.now() / 1000) - INVOICE_LOOKBACK_SECONDS;
  const found = [];

  for (const status of ["paid", "open"]) {
    for (const invoice of await listInvoicesSince(env, stripe, status, since, { fresh })) {
      const deliveryDate = /^\d{4}-\d{2}-\d{2}$/.test(invoice.metadata?.delivery_date || "") ? invoice.metadata.delivery_date : "";
      const dropId = /^\d+$/.test(invoice.metadata?.drop_id || "") ? invoice.metadata.drop_id : "";
      if (!deliveryDate && !dropId) continue;
      const lines = invoice.lines?.has_more
        ? (await stripe(env, "GET", `/invoices/${invoice.id}/lines`, { limit: 100 })).data
        : invoice.lines?.data || [];
      found.push({ id: invoice.id, deliveryDate, dropId, loaves: loavesFromInvoice(invoice, lines) });
    }
  }

  return found;

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
