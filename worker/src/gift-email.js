/*
==================================================
GIFT CARD EMAILS

The gift card itself (to the person receiving
it), in a holiday design with a plain-text copy
for mail apps that don't show designs; a copy for
the person who bought it; and a note to the
bakery. Sent through Resend (email.js).
==================================================
*/

import { CONTACT } from "../../macros.js";
import { BAKERY_EMAIL, firstName } from "./email.js";

export const SITE = "https://www.kiranabakehouse.com";

const dollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

const HOW_TO_USE = "Enter your code in the Gift card box when you check out on our order page. Any balance stays on the card for next time, and it never expires.";

export function giftCardEmail(card, siteUrl = SITE) {
  const orderUrl = `${siteUrl || SITE}/order.html`;
  const amount = dollars(card.initialCents);
  const to = firstName(card.recipientName);
  const from = card.fromName || "Kirana Bakehouse";

  const text = [
    `Hi ${to},`,
    "",
    `${from} sent you a ${amount} Kirana Bakehouse gift card!`,
    ...(card.message ? ["", `"${card.message}"`, `– ${from}`] : []),
    "",
    `Your code: ${card.code}`,
    `Balance: ${dollars(card.balanceCents)}`,
    "",
    HOW_TO_USE,
    `Order here: ${orderUrl}`,
    "",
    `Questions? Just reply to this email, or DM us on Instagram @${CONTACT.instagram}.`,
    "",
    "Happy holidays,",
    "Kirana Bakehouse"
  ].join("\n");

  const gold = "#d9b45a";
  const green = "#1f3d2b";
  const red = "#a3221a";
  const cream = "#fbf7ea";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your Kirana Bakehouse gift card</title></head>
<body style="margin:0;padding:0;background:#efe6cf;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe6cf;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${cream};border-radius:18px;overflow:hidden;font-family:Georgia,'Times New Roman',serif;color:#2a1a10;">
  <tr><td style="background:${red};padding:22px 24px;text-align:center;">
    <div style="color:${gold};font-size:14px;letter-spacing:6px;">&#10052; &#10022; &#10052; &#10022; &#10052;</div>
    <div style="color:#fff;font-size:28px;font-style:italic;margin-top:6px;">Kirana Bakehouse</div>
    <div style="color:#f6dc8a;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:3px;margin-top:4px;">HAPPY HOLIDAYS</div>
  </td></tr>
  <tr><td style="padding:28px 28px 8px;text-align:center;">
    <div style="font-size:24px;line-height:1.3;">A gift for you, ${escapeHtml(to)}!</div>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#6b5a4a;margin-top:8px;">${escapeHtml(from)} sent you a Kirana Bakehouse gift card.</div>
  </td></tr>
  <tr><td style="padding:16px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${green};border:3px solid ${gold};border-radius:16px;">
      <tr><td style="padding:24px;text-align:center;">
        <div style="color:${gold};font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:4px;">GIFT CARD</div>
        <div style="color:#fff;font-size:56px;line-height:1.1;margin:8px 0 14px;">${escapeHtml(amount)}</div>
        <div style="display:inline-block;background:${cream};color:${green};font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:bold;letter-spacing:2px;padding:10px 16px;border-radius:10px;">${escapeHtml(card.code)}</div>
        <div style="color:#d8e3d8;font-family:Arial,Helvetica,sans-serif;font-size:12px;margin-top:10px;">Balance: ${escapeHtml(dollars(card.balanceCents))}</div>
      </td></tr>
    </table>
  </td></tr>
  ${card.message ? `<tr><td style="padding:8px 36px 4px;text-align:center;">
    <div style="font-size:18px;font-style:italic;line-height:1.5;color:#4d1a00;">&ldquo;${escapeHtml(card.message)}&rdquo;</div>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b5a4a;margin-top:6px;">&ndash; ${escapeHtml(from)}</div>
  </td></tr>` : ""}
  <tr><td style="padding:22px 24px 6px;text-align:center;">
    <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:${red};color:#fff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:999px;">Order sourdough</a>
  </td></tr>
  <tr><td style="padding:14px 32px 8px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#6b5a4a;">${escapeHtml(HOW_TO_USE)}</td></tr>
  <tr><td style="padding:14px 24px 24px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a7a6a;">
    Questions? Reply to this email or DM <a href="https://instagram.com/${escapeHtml(CONTACT.instagram)}" style="color:${red};">@${escapeHtml(CONTACT.instagram)}</a>.
    <div style="color:${gold};font-size:14px;letter-spacing:6px;margin-top:12px;">&#10052; &#10022; &#10052;</div>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return {
    to: card.recipientEmail,
    subject: `${from} sent you a ${amount} Kirana Bakehouse gift card`,
    text,
    html
  };
}

// For the buyer: it's on its way, and the code in case it's needed.
export function giftCardBuyerCopy(card, buyerEmail) {
  const amount = dollars(card.initialCents);
  return {
    to: buyerEmail,
    subject: `Your ${amount} gift card for ${card.recipientName} is on its way`,
    text: [
      `Hi ${firstName(card.fromName)},`,
      "",
      `Thank you! We've emailed your ${amount} Kirana Bakehouse gift card to ${card.recipientName} (${card.recipientEmail}).`,
      "",
      `Their code, in case it goes astray: ${card.code}`,
      ...(card.message ? ["", "Your message:", `"${card.message}"`] : []),
      "",
      "Stripe sends your receipt separately.",
      "",
      `Questions? Just reply to this email, or DM us on Instagram @${CONTACT.instagram}.`,
      "",
      "Kirana Bakehouse"
    ].join("\n")
  };
}

export function giftCardAlert(card) {
  return {
    to: BAKERY_EMAIL,
    subject: `New gift card: ${dollars(card.initialCents)} for ${card.recipientName}`,
    text: [
      `${card.fromName || "Someone"} (${card.purchaserEmail || "no email"}) bought a ${dollars(card.initialCents)} gift card`,
      `for ${card.recipientName} (${card.recipientEmail}).`,
      "",
      `Code: ${card.code}`,
      "See every gift card on the orders page, Gift cards tab."
    ].join("\n")
  };
}
