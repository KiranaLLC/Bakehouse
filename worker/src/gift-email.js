/*
==================================================
GIFT CARD EMAILS

The gift card itself (to the person receiving
it), with the sender's message; one email to the
buyer with every card from their order; and a
note to the bakery. Sent through Resend
(email.js). Each has a plain-text version, and
the gift card has a simple design in the bakery's
colors for mail apps that show it.
==================================================
*/

import { CONTACT, GIFT_CARDS } from "../../macros.js";
import { BAKERY_EMAIL, firstName } from "./email.js";

export const SITE = "https://www.kiranabakehouse.com";

const dollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

export const GIFT_CARD_TERMS = GIFT_CARDS.terms;
const HOW_TO_USE = "Enter the code in the Gift card box when you check out.";

const siteName = siteUrl => (siteUrl || SITE).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

// The gift card, to whoever it's for (or the buyer, when it's for them to pass on).
// edits (from the preview): { subject, hi, intro, message } replace those parts.
export function giftCardEmail(card, siteUrl = SITE, { to, edits } = {}) {
  const orderUrl = `${siteUrl || SITE}/order.html`;
  const amount = dollars(card.initialCents);
  const greeting = card.recipientName ? firstName(card.recipientName) : "there";
  const from = card.fromName || "Kirana Bakehouse";
  // Issued by the bakery itself: "from us", not "Kirana Bakehouse sent you a Kirana Bakehouse…".
  const fromBakery = card.source === "issued" || /^kirana bakehouse$/i.test(from);
  const hi = edits?.hi ?? `Hi ${greeting},`;
  const intro = edits?.intro ?? (fromBakery ? `Here's a ${amount} gift card from us.` : `${from} sent you a ${amount} gift card.`);
  const message = edits?.message ?? card.message ?? "";
  const terms = `${GIFT_CARD_TERMS.replace("our website.", `our website, ${siteName(siteUrl)}.`)} ${HOW_TO_USE}`;

  const text = [
    hi,
    "",
    intro,
    ...(message ? ["", `"${message}"`, `– ${fromBakery ? "Kirana Bakehouse" : from}`] : []),
    "",
    `Your code: ${card.code}`,
    `Balance: ${dollars(card.balanceCents)}`,
    "",
    terms,
    `Order here: ${orderUrl}`,
    "",
    `Questions? Just reply to this email, or DM us on Instagram @${CONTACT.instagram}.`,
    "",
    "Kirana Bakehouse"
  ].join("\n");

  const brown = "#4d1a00";
  const terracotta = "#b31d00";
  const cream = "#fbf7ea";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your Kirana Bakehouse gift card</title></head>
<body style="margin:0;padding:0;background:#f0e7cc;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0e7cc;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:${cream};border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:${brown};">
  <tr><td style="background:${brown};padding:20px 24px;text-align:center;color:${cream};font-size:22px;font-weight:bold;letter-spacing:1px;">Kirana Bakehouse</td></tr>
  <tr><td style="padding:26px 28px 6px;text-align:center;">
    <div style="font-size:20px;font-weight:bold;">${escapeHtml(hi)}</div>
    <div style="font-size:15px;color:#6b5a4a;margin-top:8px;">${escapeHtml(intro)}</div>
  </td></tr>
  ${message ? `<tr><td style="padding:12px 36px 2px;text-align:center;">
    <div style="font-size:17px;font-style:italic;line-height:1.5;">&ldquo;${escapeHtml(message)}&rdquo;</div>
    <div style="font-size:14px;color:#6b5a4a;margin-top:6px;">&ndash; ${escapeHtml(from)}</div>
  </td></tr>` : ""}
  <tr><td style="padding:18px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ${brown};border-radius:14px;background:#fff;">
      <tr><td style="padding:22px;text-align:center;">
        <div style="font-size:12px;letter-spacing:3px;color:#6b5a4a;">GIFT CARD</div>
        <div style="font-size:44px;font-weight:bold;margin:6px 0 12px;">${escapeHtml(amount)}</div>
        <div style="display:inline-block;background:${cream};border:1px dashed ${brown};font-family:'Courier New',Courier,monospace;font-size:20px;font-weight:bold;letter-spacing:2px;padding:9px 14px;border-radius:8px;">${escapeHtml(card.code)}</div>
        <div style="font-size:12px;color:#6b5a4a;margin-top:8px;">Balance: ${escapeHtml(dollars(card.balanceCents))}</div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:6px 24px;text-align:center;">
    <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:${terracotta};color:#fff;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 26px;border-radius:999px;">Order sourdough</a>
  </td></tr>
  <tr><td style="padding:14px 32px 6px;text-align:center;font-size:13px;line-height:1.5;color:#6b5a4a;">${escapeHtml(terms)}</td></tr>
  <tr><td style="padding:10px 24px 22px;text-align:center;font-size:12px;color:#8a7a6a;">
    Questions? Reply to this email or DM <a href="https://instagram.com/${escapeHtml(CONTACT.instagram)}" style="color:${terracotta};">@${escapeHtml(CONTACT.instagram)}</a>.
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return {
    to: to || card.recipientEmail,
    editable: { subject: edits?.subject ?? null, hi, intro, message },
    subject: edits?.subject ?? (fromBakery ? `A ${amount} gift card from Kirana Bakehouse` : `${from} sent you a ${amount} Kirana Bakehouse gift card`),
    text,
    html
  };
}

/*
  For the buyer: every gift card in their order,
  with its code, and whether we emailed it to
  someone or it's theirs to pass on.
*/
export function buyerGiftCardsEmail(cards, buyerEmail, siteUrl = SITE) {
  const total = cards.reduce((sum, card) => sum + card.initialCents, 0);
  const lines = cards.map(card => card.recipientEmail
    ? `${dollars(card.initialCents)} for ${card.recipientName || card.recipientEmail}: ${card.code} (emailed to ${card.recipientEmail})`
    : `${dollars(card.initialCents)}${card.recipientName ? ` for ${card.recipientName}` : ""}: ${card.code}`);
  const toPassOn = cards.some(card => !card.recipientEmail);
  return {
    to: buyerEmail,
    subject: cards.length === 1 ? `Your ${dollars(total)} Kirana Bakehouse gift card` : `Your ${cards.length} Kirana Bakehouse gift cards`,
    text: [
      "Hi,",
      "",
      `Thank you for buying ${cards.length === 1 ? "a Kirana Bakehouse gift card" : `${cards.length} Kirana Bakehouse gift cards`}!`,
      "",
      ...lines,
      "",
      ...(toPassOn ? ["To give a card, pass on its code. They enter it in the Gift card box when they check out.", ""] : []),
      (cards.length === 1 ? GIFT_CARD_TERMS : GIFT_CARD_TERMS.replace("This gift card", "These gift cards"))
        .replace("our website.", `our website, ${siteName(siteUrl)}.`),
      "",
      "Stripe sends your receipt separately.",
      "",
      `Questions? Just reply to this email, or DM us on Instagram @${CONTACT.instagram}.`,
      "",
      "Kirana Bakehouse"
    ].join("\n")
  };
}

export function giftCardAlert(cards, buyerEmail) {
  const total = cards.reduce((sum, card) => sum + card.initialCents, 0);
  return {
    to: BAKERY_EMAIL,
    subject: `New gift card${cards.length === 1 ? "" : "s"}: ${dollars(total)}`,
    text: [
      `${buyerEmail || "Someone"} bought:`,
      ...cards.map(card => `- ${dollars(card.initialCents)} ${card.code}${card.recipientName ? ` for ${card.recipientName}` : ""}${card.recipientEmail ? ` (${card.recipientEmail})` : ""}`),
      "",
      "See every gift card on the orders page, Gift cards tab."
    ].join("\n")
  };
}
