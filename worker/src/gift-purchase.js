/*
==================================================
BUYING A GIFT CARD (gift.html)

The buyer picks an amount and who it's for, pays
on Stripe's page, and the card is made and
emailed to the recipient (with a copy to the
buyer) as soon as the payment goes through: by
the Stripe webhook, or by the thank-you page,
whichever comes first. If email isn't set up, the
thank-you page shows the code so it can be passed
on by hand.
==================================================
*/

import { GIFT_CARDS, SERVICE_FEE } from "../../macros.js";
import { calculateServiceFee } from "../../delivery-rules.js";
import { stripe } from "./stripe.js";
import { GiftCardError, claimGiftEmail, createGiftCard, unclaimGiftEmail } from "./gift-cards.js";
import { canEmail, sendEmail } from "./email.js";
import { SITE, giftCardAlert, giftCardBuyerCopy, giftCardEmail } from "./gift-email.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// The buyer's choices, checked. Throws GiftCardError with what to fix.
export function parseGiftCardOrder(body) {
  const amountCents = Number(body?.amountCents);
  if (!Number.isInteger(amountCents) || amountCents % 100 !== 0 || amountCents < GIFT_CARDS.minCents || amountCents > GIFT_CARDS.maxCents) {
    throw new GiftCardError(`Choose an amount from $${GIFT_CARDS.minCents / 100} to $${GIFT_CARDS.maxCents / 100}, in whole dollars.`);
  }
  const recipientName = clean(body?.recipientName, 60);
  const recipientEmail = clean(body?.recipientEmail, 254).toLowerCase();
  const fromName = clean(body?.fromName, 60);
  const message = String(body?.message ?? "").trim().slice(0, GIFT_CARDS.messageMaxLength);
  if (!recipientName) throw new GiftCardError("Who is the gift card for? Add their name.");
  if (!EMAIL_PATTERN.test(recipientEmail)) throw new GiftCardError("Add the email address to send the gift card to.");
  if (!fromName) throw new GiftCardError("Add your name, so they know who it's from.");
  return { amountCents, recipientName, recipientEmail, fromName, message };
}

export async function createGiftCardCheckout(body, env, siteUrl) {
  if (!env.DB) throw new GiftCardError("Gift cards aren't available right now.");
  const order = parseGiftCardOrder(body);
  const fee = calculateServiceFee(SERVICE_FEE, order.amountCents);
  const dollars = `$${order.amountCents / 100}`;
  const metadata = {
    kind: "gift_card",
    amount_cents: String(order.amountCents),
    recipient_name: order.recipientName,
    recipient_email: order.recipientEmail,
    from_name: order.fromName,
    message: order.message,
    service_fee_cents: String(fee)
  };
  const lineItems = [{
    price_data: { currency: "usd", product_data: { name: `Kirana Bakehouse gift card for ${order.recipientName}`.slice(0, 250) }, unit_amount: order.amountCents },
    quantity: 1
  }];
  if (fee > 0) {
    lineItems.push({ price_data: { currency: "usd", product_data: { name: SERVICE_FEE.label }, unit_amount: fee }, quantity: 1 });
  }
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "payment",
    line_items: lineItems,
    payment_intent_data: { description: `Kirana Bakehouse gift card (${dollars})`, metadata },
    metadata,
    custom_text: { submit: { message: `We'll email the ${dollars} gift card to ${order.recipientName} (${order.recipientEmail}) as soon as you've paid.` } },
    success_url: `${siteUrl}/gift.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/gift.html?cancelled=true`
  });
  return { url: session.url, id: session.id };
}

/*
  Makes the card for a paid gift card payment (once)
  and emails it (once). Returns { card, emailed }.
  throwOnEmailError: the webhook wants Stripe to try
  again; the thank-you page just reports it.
*/
export async function deliverBoughtGiftCard(env, session, siteUrl, { throwOnEmailError = true } = {}) {
  const meta = session.metadata || {};
  const card = await createGiftCard(env, {
    amountCents: Number(meta.amount_cents),
    source: "purchase",
    stripeSessionId: session.id,
    fromName: meta.from_name,
    purchaserEmail: session.customer_details?.email || "",
    recipientName: meta.recipient_name,
    recipientEmail: meta.recipient_email,
    message: meta.message
  });

  if (card.emailedAt) return { card, emailed: true };
  if (!canEmail(env) || !await claimGiftEmail(env, card.id)) return { card, emailed: false };

  try {
    await sendEmail(env, giftCardEmail(card, siteUrl || env.SITE_URL || SITE));
  } catch (error) {
    await unclaimGiftEmail(env, card.id).catch(() => {});
    if (throwOnEmailError) throw error;
    console.error("Gift card email failed", error);
    return { card, emailed: false };
  }
  // The copy and the bakery's note are nice to have; the gift itself went out.
  if (card.purchaserEmail) await sendEmail(env, giftCardBuyerCopy(card, card.purchaserEmail)).catch(error => console.error(error));
  await sendEmail(env, giftCardAlert(card)).catch(error => console.error(error));
  return { card: { ...card, emailedAt: new Date().toISOString() }, emailed: true };
}

// The thank-you page: the card, made now if the webhook hasn't yet.
export async function getGiftCardPurchase(sessionId, env, siteUrl) {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new GiftCardError("Invalid gift card reference.");
  const session = await stripe(env, "GET", `/checkout/sessions/${sessionId}`, {});
  if (session.metadata?.kind !== "gift_card") throw new GiftCardError("That isn't a gift card purchase.");
  if (session.status !== "complete" || session.payment_status !== "paid") throw new GiftCardError("We couldn't find a completed payment for this gift card.");
  const { card, emailed } = await deliverBoughtGiftCard(env, session, siteUrl, { throwOnEmailError: false });
  return {
    code: card.code,
    amountCents: card.initialCents,
    recipientName: card.recipientName,
    recipientEmail: card.recipientEmail,
    emailed
  };
}

// Orders page: email a card (new or again). Throws if email isn't set up or fails.
export async function emailGiftCard(env, card, siteUrl) {
  if (!card.recipientEmail) throw new GiftCardError("This gift card has no email address to send to.");
  await sendEmail(env, giftCardEmail(card, siteUrl || env.SITE_URL || SITE));
  await env.DB.prepare("UPDATE gift_cards SET emailed_at = ?2 WHERE id = ?1").bind(card.id, new Date().toISOString()).run();
}
