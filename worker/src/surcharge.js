// The card surcharge Stripe added to a Checkout Session, in cents (0 if none).
// Newer API versions report it; otherwise it's what the total has on top of
// the line items, discounts and tax.
export function surchargeCents(session) {
  const reported = session.total_details?.amount_surcharge;
  if (Number.isInteger(reported)) return reported;
  const { amount_total: total, amount_subtotal: subtotal } = session;
  if (!Number.isInteger(total) || !Number.isInteger(subtotal)) return 0;
  const extra = total - subtotal + (session.total_details?.amount_discount || 0) - (session.total_details?.amount_tax || 0);
  return Math.max(0, extra);
}

/*
  Card surcharge (SURCHARGE in macros.js): Stripe
  works it out once the customer enters a credit
  card and adds it to the total. Sessions that use
  it need Stripe's preview API version.
*/
export function surchargeParams(config) {
  return config.enabled ? { automatic_surcharge: { enabled: true, calculation_basis: "total_after_tax" } } : {};
}

export function surchargeVersion(config) {
  return config.enabled ? { version: config.apiVersion } : {};
}

// Added to the note above Stripe's Pay button.
export function surchargeNotice(config) {
  return config.enabled ? ` Credit cards include a surcharge of up to ${config.maxPercent}% to cover processing; debit cards don't.` : "";
}
