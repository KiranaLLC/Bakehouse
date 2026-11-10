/*
==================================================
EMAIL (Resend)

Emails the site sends itself, through Resend
(resend.com). Turned on by the RESEND_API_KEY
secret on a worker; without it nothing is sent
and the orders page keeps opening email drafts in
the Mail app instead.

Sent from EMAIL_FROM (a [vars] setting, an
address on the verified kiranabakehouse.com
domain). Replies go to the bakery's Gmail.
==================================================
*/

import { PRODUCTS } from "../../macros.js";

export const BAKERY_EMAIL = "hellokiranabakehouse@gmail.com";
const DEFAULT_FROM = "Kirana Bakehouse <hello@kiranabakehouse.com>";
const RESEND_URL = "https://api.resend.com";

export function canEmail(env) {
  return Boolean(env.RESEND_API_KEY);
}

export class EmailError extends Error {}

// message: { to, subject, text, headers? }. One email, one recipient.
export async function sendEmail(env, message) {
  await resend(env, "/emails", toResend(env, message));
}

// Many emails at once (each with its own recipient), 100 per request.
export async function sendEmails(env, messages) {
  for (let i = 0; i < messages.length; i += 100) {
    await resend(env, "/emails/batch", messages.slice(i, i + 100).map(message => toResend(env, message)));
  }
  return messages.length;
}

function toResend(env, { to, subject, text, headers }) {
  return {
    from: env.EMAIL_FROM || DEFAULT_FROM,
    to: [to],
    reply_to: BAKERY_EMAIL,
    subject,
    text,
    ...(headers ? { headers } : {})
  };
}

async function resend(env, path, body) {
  if (!canEmail(env)) throw new EmailError("Email isn't set up yet (RESEND_API_KEY is missing).");
  const response = await fetch(`${RESEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new EmailError(`Email couldn't be sent: ${detail.message || `Resend answered ${response.status}`}`);
  }
  return response.json().catch(() => ({}));
}

/*
==================================================
THE EMAILS

Plain text, in the same words as the drafts the
orders page used to open in the Mail app.
==================================================
*/

const SIGN_OFF = ["", "Kirana Bakehouse"];

function itemLines(items) {
  return items.map(({ name, quantity }) => `${quantity} × ${name}`);
}

// "house_white:2,pesto:1" (Stripe metadata) → [{ name, quantity }]
export function itemsFromMetadata(value) {
  return String(value || "").split(",").filter(Boolean).map(pair => {
    const [productId, quantity] = pair.split(":");
    return { name: PRODUCTS[productId]?.name || productId, quantity: Number(quantity) || 1 };
  });
}

export function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

export function deliveredEmail({ to, name, items }) {
  return {
    to,
    subject: "Your Kirana Bakehouse order has been delivered",
    text: [
      `Hi ${name},`,
      "",
      "Your Kirana Bakehouse order has just been delivered:",
      "",
      ...itemLines(items),
      "",
      "We hope you enjoy it! If anything isn't right, just reply to this email.",
      "",
      "Thank you,",
      "Kirana Bakehouse"
    ].join("\n")
  };
}

export function pickupReadyEmail({ to, name, items, when, place }) {
  return {
    to,
    subject: "Your Kirana Bakehouse order is ready for pickup",
    text: [
      `Hi ${name},`,
      "",
      "Your Kirana Bakehouse order is ready for pickup:",
      "",
      ...itemLines(items),
      "",
      `When: ${when}`,
      ...place,
      "",
      "See you soon!",
      ...SIGN_OFF.slice(1)
    ].join("\n")
  };
}

export function dropOpenEmail({ to, when, place, opening, orderUrl, unsubscribeUrl }) {
  return {
    to,
    subject: `Pickup drop: ${when}`,
    text: [
      "Hi friends,",
      "",
      "Our next pickup drop is here!",
      "",
      `When: ${when}`,
      ...place,
      "",
      opening,
      `Order here: ${orderUrl}`,
      "",
      "Loaves are limited, so order early. See you there!",
      "Kirana Bakehouse",
      "",
      `Don't want these emails? Unsubscribe: ${unsubscribeUrl}`
    ].join("\n"),
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    }
  };
}

export function pickupReminderEmail({ to, when, place }) {
  return {
    to,
    subject: `Reminder: your pickup ${when}`,
    text: [
      "Hi there,",
      "",
      "A friendly reminder that your Kirana Bakehouse order will be ready for pickup:",
      "",
      `When: ${when}`,
      ...place,
      "",
      "See you there!",
      ...SIGN_OFF.slice(1)
    ].join("\n")
  };
}

export function confirmSubscriptionEmail({ to, confirmUrl }) {
  return {
    to,
    subject: "Confirm: Kirana Bakehouse pickup emails",
    text: [
      "Hi!",
      "",
      "Tap this link to get an email whenever a new Kirana Bakehouse pickup drop opens:",
      "",
      confirmUrl,
      "",
      "If you didn't ask for this, just ignore this email and you won't hear from us.",
      ...SIGN_OFF
    ].join("\n")
  };
}

export function newOrderAlert(session) {

  const meta = session.metadata || {};
  const pickup = meta.fulfillment === "pickup";
  const name = meta.customer_name || session.customer_details?.name || "Someone";
  const when = pickup ? meta.pickup_label : meta.delivery_date_label || meta.delivery_date;
  const total = `$${((session.amount_total || 0) / 100).toFixed(2)}`;
  const loaves = Number(meta.loaf_count) || itemsFromMetadata(meta.items).reduce((sum, { quantity }) => sum + quantity, 0);

  return {
    to: BAKERY_EMAIL,
    subject: `New ${pickup ? "pickup" : "delivery"} order: ${name}, ${when} (${loaves} ${loaves === 1 ? "loaf" : "loaves"})`,
    text: [
      `${name} just placed an order.`,
      "",
      ...itemLines(itemsFromMetadata(meta.items)),
      "",
      pickup ? `Pickup: ${meta.pickup_label}` : `Delivery: ${when}`,
      pickup ? `Where: ${meta.pickup_location}` : `Address: ${meta.delivery_address || ""}`,
      `Phone: ${meta.customer_phone || session.customer_details?.phone || ""}`,
      `Email: ${session.customer_details?.email || ""}`,
      meta.delivery_notes ? `Notes: ${meta.delivery_notes}` : null,
      `Paid: ${total}${Number(meta.tip_cents) ? ` (incl. $${(Number(meta.tip_cents) / 100).toFixed(2)} tip)` : ""}`,
      meta.discount_code ? `Discount code: ${meta.discount_code}` : null,
      "",
      "It's on the orders page now."
    ].filter(line => line !== null).join("\n")
  };

}
