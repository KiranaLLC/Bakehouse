/*
==================================================
BUYING GIFT CARDS (order page)

A gift card is an item on the order page: an
amount, how many, and optionally who it's for
(name, email, message). It's paid for with the
rest of the order, or on its own.

When the payment page is made, the cards being
bought are saved (gift_card_orders). Once the
payment goes through, they're made into gift
cards and emailed: each card with an email address
to that person, and every card in the order to
the buyer. That happens from the Stripe webhook,
the thank-you page or the hourly check, whichever
comes first, and only once.
==================================================
*/

import { GIFT_CARDS } from "../../macros.js";
import { stripe } from "./stripe.js";
import { GiftCardError, claimGiftEmail, createGiftCard, unclaimGiftEmail } from "./gift-cards.js";
import { canEmail, sendEmail } from "./email.js";
import { SITE, buyerGiftCardsEmail, giftCardAlert, giftCardEmail } from "./gift-email.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LINES = 10;

const dollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// The gift cards in an order, checked. [] if none. Throws GiftCardError with what to fix.
export function parseGiftCardLines(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_LINES) throw new GiftCardError("Please check the gift cards in your cart.");
  return input.map(line => {
    const amountCents = Number(line?.amountCents);
    if (!Number.isInteger(amountCents) || amountCents % 100 !== 0 || amountCents < GIFT_CARDS.minCents || amountCents > GIFT_CARDS.maxCents) {
      throw new GiftCardError(`Gift cards can be ${dollars(GIFT_CARDS.minCents)} to ${dollars(GIFT_CARDS.maxCents)}, in whole dollars.`);
    }
    const quantity = Number(line?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > GIFT_CARDS.maxQuantity) {
      throw new GiftCardError(`You can buy up to ${GIFT_CARDS.maxQuantity} of each gift card.`);
    }
    const recipientEmail = clean(line?.recipientEmail, 254).toLowerCase();
    if (recipientEmail && !EMAIL_PATTERN.test(recipientEmail)) throw new GiftCardError(`The email for a gift card (${recipientEmail}) doesn't look right.`);
    return {
      amountCents,
      quantity,
      recipientName: clean(line?.recipientName, 60),
      recipientEmail,
      message: String(line?.message ?? "").trim().slice(0, GIFT_CARDS.messageMaxLength),
      fromName: clean(line?.fromName, 60)
    };
  });
}

export const giftCardLinesTotal = lines => lines.reduce((sum, line) => sum + line.amountCents * line.quantity, 0);

// Stripe line items for the gift cards.
export function giftCardLineItems(lines) {
  return lines.map(line => ({
    price_data: {
      currency: "usd",
      product_data: { name: `Gift card (${dollars(line.amountCents)})${line.recipientName ? ` for ${line.recipientName}` : ""}`.slice(0, 250) },
      unit_amount: line.amountCents
    },
    quantity: line.quantity
  }));
}

export async function saveGiftCardOrder(env, sessionId, lines) {
  if (!lines.length) return;
  await env.DB.prepare("INSERT OR REPLACE INTO gift_card_orders (session_id, lines, created_at) VALUES (?1, ?2, ?3)")
    .bind(sessionId, JSON.stringify(lines), new Date().toISOString()).run();
}

/*
  Makes the gift cards for a paid order (once) and
  emails them (once). Returns the cards, each with
  `emailed` (sent to its recipient), or [] when
  the order had no gift cards.
*/
export async function fulfillGiftCardOrder(env, session, siteUrl, { throwOnEmailError = false } = {}) {
  if (!env.DB || !session?.id) return [];
  let order;
  try {
    order = await env.DB.prepare("SELECT * FROM gift_card_orders WHERE session_id = ?1").bind(session.id).first();
  } catch (error) {
    if (/no such table/i.test(error.message || "")) return [];
    throw error;
  }
  if (!order) return [];

  const lines = JSON.parse(order.lines);
  const buyerEmail = session.customer_details?.email || "";
  const buyerName = session.customer_details?.name || session.metadata?.customer_name || "";
  const cards = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (let n = 0; n < line.quantity; n += 1) {
      cards.push(await createGiftCard(env, {
        amountCents: line.amountCents,
        source: "purchase",
        stripeSessionId: session.id,
        purchaseKey: `${session.id}:${lineIndex}:${n}`,
        fromName: line.fromName || buyerName,
        purchaserEmail: buyerEmail,
        recipientName: line.recipientName,
        recipientEmail: line.recipientEmail,
        message: line.message
      }));
    }
  }
  if (!order.fulfilled_at) {
    await env.DB.prepare("UPDATE gift_card_orders SET fulfilled_at = ?2 WHERE session_id = ?1").bind(session.id, new Date().toISOString()).run();
  }

  if (!canEmail(env)) return cards.map(card => ({ ...card, emailed: Boolean(card.emailedAt) }));

  const site = siteUrl || env.SITE_URL || SITE;
  const result = [];
  let failed = null;
  for (const card of cards) {
    if (!card.recipientEmail || card.emailedAt) { result.push({ ...card, emailed: Boolean(card.emailedAt) }); continue; }
    if (!await claimGiftEmail(env, card.id)) { result.push({ ...card, emailed: true }); continue; }
    try {
      await sendEmail(env, giftCardEmail(card, site));
      result.push({ ...card, emailed: true });
    } catch (error) {
      await unclaimGiftEmail(env, card.id).catch(() => {});
      console.error("Gift card email failed", error);
      failed = failed || error;
      result.push({ ...card, emailed: false });
    }
  }

  // The buyer gets every code once (and the bakery a note).
  if (buyerEmail) {
    const claimed = await env.DB.prepare("UPDATE gift_card_orders SET buyer_emailed_at = ?2 WHERE session_id = ?1 AND buyer_emailed_at = ''")
      .bind(session.id, new Date().toISOString()).run();
    if (claimed.meta?.changes) {
      try {
        await sendEmail(env, buyerGiftCardsEmail(cards, buyerEmail, site));
        await sendEmail(env, giftCardAlert(cards, buyerEmail)).catch(error => console.error(error));
      } catch (error) {
        await env.DB.prepare("UPDATE gift_card_orders SET buyer_emailed_at = '' WHERE session_id = ?1").bind(session.id).run().catch(() => {});
        console.error("Gift card buyer email failed", error);
        failed = failed || error;
      }
    }
  }

  if (failed && throwOnEmailError) throw failed;
  return result;
}

/*
  The hourly check: paid orders whose gift cards
  haven't been made yet (no webhook, and the
  customer closed the thank-you page).
*/
export async function fulfillPendingGiftCardOrders(env, siteUrl) {
  if (!env.DB) return 0;
  let results;
  try {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    ({ results } = await env.DB.prepare("SELECT session_id FROM gift_card_orders WHERE fulfilled_at = '' AND created_at >= ?1").bind(since).all());
  } catch (error) {
    if (/no such table/i.test(error.message || "")) return 0;
    throw error;
  }
  let done = 0;
  for (const { session_id: sessionId } of results) {
    try {
      const session = await stripe(env, "GET", `/checkout/sessions/${sessionId}`, {});
      if (session.status === "complete" && session.payment_status !== "unpaid") {
        await fulfillGiftCardOrder(env, session, siteUrl);
        done += 1;
      }
    } catch (error) {
      console.error("Couldn't finish gift card order", sessionId, error);
    }
  }
  return done;
}

// Orders page: email a card (new or again). Throws if email isn't set up or fails.
export async function emailGiftCard(env, card, siteUrl) {
  if (!card.recipientEmail) throw new GiftCardError("This gift card has no email address to send to.");
  await sendEmail(env, giftCardEmail(card, siteUrl || env.SITE_URL || SITE));
  await env.DB.prepare("UPDATE gift_cards SET emailed_at = ?2 WHERE id = ?1").bind(card.id, new Date().toISOString()).run();
}
