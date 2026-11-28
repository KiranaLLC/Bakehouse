/*
==================================================
GIFT CARDS

Codes like KIRANA-7QKM-X2PD with a balance in
dollars, bought on the order page or issued from
the orders page. Only for orders on the website. Saved in the pickup database
(gift_cards and gift_card_uses in schema.sql).

Using a code at checkout:
  1. planGiftCard works out how much of the card
     the order takes (loaves and delivery first,
     then the tip; the payment processing fee is
     only on what's left to pay by card).
  2. holdGiftCard takes that amount off the
     balance straight away, as a "held" use, so
     the same balance can't be spent twice.
  3. When the payment completes the use becomes
     "used"; if the customer leaves (the payment
     page expires) it's "released" and the amount
     goes back on the card. The Stripe webhook,
     the thank-you page and the hourly check all
     settle these, so it works without any one of
     them.
==================================================
*/

// Shared with the order page, so its totals match.
export { STRIPE_MINIMUM_CENTS, planGiftCard } from "../../delivery-rules.js";

// No 0/O, 1/I/L: easy to read out and type.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_PREFIX = "KIRANA";

export class GiftCardError extends Error {}

export function newGiftCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${CODE_PREFIX}-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

// "kirana 7qkm x2pd", "7QKMX2PD" → "KIRANA-7QKM-X2PD"; null if it can't be a code.
export function normalizeGiftCode(value) {
  let chars = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (chars.startsWith(CODE_PREFIX)) chars = chars.slice(CODE_PREFIX.length);
  if (chars.length !== 8) return null;
  return `${CODE_PREFIX}-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function needDatabase(env) {
  if (!env.DB) throw new GiftCardError("Gift cards aren't available right now.");
}

export function toCard(row) {
  return {
    id: row.id,
    code: row.code,
    initialCents: row.initial_cents,
    balanceCents: row.balance_cents,
    source: row.source,
    fromName: row.from_name,
    purchaserEmail: row.purchaser_email,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    message: row.message,
    note: row.note,
    emailedAt: row.emailed_at,
    createdAt: row.created_at,
    stripeSessionId: row.stripe_session_id || ""
  };
}

export async function findGiftCard(env, rawCode) {
  needDatabase(env);
  const code = normalizeGiftCode(rawCode);
  if (!code) throw new GiftCardError("That gift card code doesn't look right. It's like KIRANA-7QKM-X2PD.");
  const row = await env.DB.prepare("SELECT * FROM gift_cards WHERE code = ?1").bind(code).first();
  if (!row) throw new GiftCardError("We couldn't find that gift card code.");
  return toCard(row);
}

// For the order page: is this a code, and what's left on it?
export async function checkGiftCard(env, rawCode) {
  const card = await findGiftCard(env, rawCode);
  if (card.balanceCents <= 0) throw new GiftCardError("That gift card has been used up.");
  return { code: card.code, balanceCents: card.balanceCents };
}

/*
==================================================
HOLDS (checkout)
==================================================
*/

// Takes amountCents off the card now; returns the use's id.
export async function holdGiftCard(env, card, amountCents) {
  needDatabase(env);
  const taken = await env.DB.prepare(
    "UPDATE gift_cards SET balance_cents = balance_cents - ?2 WHERE id = ?1 AND balance_cents >= ?2"
  ).bind(card.id, amountCents).run();
  if (!taken.meta?.changes) throw new GiftCardError("That gift card's balance just changed. Please try again.");
  const use = await env.DB.prepare(
    "INSERT INTO gift_card_uses (gift_card_id, amount_cents, status, created_at) VALUES (?1, ?2, 'held', ?3) RETURNING id"
  ).bind(card.id, amountCents, new Date().toISOString()).first();
  return use.id;
}

export async function attachGiftUse(env, useId, sessionId) {
  await env.DB.prepare("UPDATE gift_card_uses SET session_id = ?2 WHERE id = ?1").bind(useId, sessionId).run();
}

// Gives a held amount back to its card (once).
export async function releaseGiftUse(env, useId) {
  if (!env.DB || !useId) return false;
  const use = await env.DB.prepare("UPDATE gift_card_uses SET status = 'released' WHERE id = ?1 AND status = 'held' RETURNING gift_card_id, amount_cents")
    .bind(Number(useId)).first();
  if (!use) return false;
  await env.DB.prepare("UPDATE gift_cards SET balance_cents = balance_cents + ?2 WHERE id = ?1").bind(use.gift_card_id, use.amount_cents).run();
  return true;
}

export async function markGiftUseUsed(env, useId) {
  if (!env.DB || !useId) return false;
  const result = await env.DB.prepare("UPDATE gift_card_uses SET status = 'used' WHERE id = ?1 AND status = 'held'").bind(Number(useId)).run();
  return Boolean(result.meta?.changes);
}

// Settles the gift card on an order's payment page, from what Stripe says about it.
export async function settleGiftForSession(env, session) {
  const useId = session?.metadata?.gift_use_id;
  if (!useId || !env.DB) return;
  const paid = session.status === "complete" && session.payment_status !== "unpaid";
  if (paid) await markGiftUseUsed(env, useId);
  else if (session.status === "expired") await releaseGiftUse(env, useId);
}

/*
  The hourly check: holds whose payment page has
  had time to finish or expire are settled from
  Stripe.
*/
export async function settleStaleGiftHolds(env, stripe, holdSeconds) {
  if (!env.DB) return 0;
  const before = new Date(Date.now() - (holdSeconds + 10 * 60) * 1000).toISOString();
  let results;
  try {
    ({ results } = await env.DB.prepare("SELECT id, session_id FROM gift_card_uses WHERE status = 'held' AND created_at < ?1").bind(before).all());
  } catch (error) {
    if (/no such table/i.test(error.message || "")) return 0;
    throw error;
  }
  let settled = 0;
  for (const use of results) {
    // Never got a payment page (something failed in between): give it back.
    if (!use.session_id) { if (await releaseGiftUse(env, use.id)) settled += 1; continue; }
    try {
      const session = await stripe(env, "GET", `/checkout/sessions/${use.session_id}`, {});
      await settleGiftForSession(env, { ...session, metadata: { ...session.metadata, gift_use_id: String(use.id) } });
      settled += 1;
    } catch (error) {
      console.error("Couldn't settle gift card hold", use.id, error);
    }
  }
  return settled;
}

/*
==================================================
NEW CARDS
==================================================
*/

export async function createGiftCard(env, card) {
  needDatabase(env);
  for (let tries = 0; tries < 5; tries += 1) {
    try {
      const row = await env.DB.prepare(`INSERT INTO gift_cards
          (code, initial_cents, balance_cents, source, stripe_session_id, purchase_key, from_name, purchaser_email,
           recipient_name, recipient_email, message, note, created_at)
          VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING *`)
        .bind(newGiftCode(), card.amountCents, card.source, card.stripeSessionId || null, card.purchaseKey || null,
          card.fromName || "", card.purchaserEmail || "", card.recipientName || "", card.recipientEmail || "",
          card.message || "", card.note || "", new Date().toISOString())
        .first();
      return toCard(row);
    } catch (error) {
      const message = error.message || "";
      // Made already (the webhook and the thank-you page both make them): that one.
      if (card.purchaseKey && /UNIQUE.*purchase_key/i.test(message)) {
        return toCard(await env.DB.prepare("SELECT * FROM gift_cards WHERE purchase_key = ?1").bind(card.purchaseKey).first());
      }
      // A code clash (astronomically rare): try another code.
      if (!/UNIQUE.*code/i.test(message)) throw error;
    }
  }
  throw new GiftCardError("Couldn't make a gift card code. Please try again.");
}

// Marks a card's email as sent, once. False if it already was (or is being sent).
export async function claimGiftEmail(env, cardId) {
  const result = await env.DB.prepare("UPDATE gift_cards SET emailed_at = ?2 WHERE id = ?1 AND emailed_at = ''")
    .bind(cardId, new Date().toISOString()).run();
  return Boolean(result.meta?.changes);
}

export async function unclaimGiftEmail(env, cardId) {
  await env.DB.prepare("UPDATE gift_cards SET emailed_at = '' WHERE id = ?1").bind(cardId).run();
}

export async function listGiftCards(env) {
  needDatabase(env);
  try {
    const { results: cards } = await env.DB.prepare("SELECT * FROM gift_cards ORDER BY id DESC").all();
    const { results: uses } = await env.DB.prepare("SELECT gift_card_id, COUNT(*) AS count FROM gift_card_uses WHERE status = 'used' GROUP BY gift_card_id").all();
    const useCounts = new Map(uses.map(use => [use.gift_card_id, use.count]));
    return { ready: true, cards: cards.map(row => ({ ...toCard(row), timesUsed: useCounts.get(row.id) || 0 })) };
  } catch (error) {
    if (/no such table/i.test(error.message || "")) return { ready: false, cards: [] };
    throw error;
  }
}

export async function getGiftCard(env, id) {
  needDatabase(env);
  const row = await env.DB.prepare("SELECT * FROM gift_cards WHERE id = ?1").bind(Number(id)).first();
  return row ? toCard(row) : null;
}
