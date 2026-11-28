/*
==================================================
DROP EMAILS (both workers)

"A new drop is open" goes to everyone confirmed
on the next-drop list, and "reminder: pickup
tomorrow" to everyone with a paid order for the
drop. Both only when the bakery presses the
button on the orders page: the site never sends
email on its own.
==================================================
*/

import { API } from "../../macros.js";
import { formatMoment, formatPickupWhen } from "../../pickup-rules.js";
import { applyEdits, dropOpenEmail, pickupReminderEmail, sendEmails } from "./email.js";
import { claimEmail, forgetEmail, listSubscribers, logEmail, unsubscribeToken } from "./drops.js";
import { listSessionsSince } from "./stripe-cache.js";
import { CHECKOUT_HOLD_SECONDS, loavesFromMetadata } from "./capacity.js";
import { listMoves, movedOutByOrder, sumItems } from "./moves.js";

const SITE = "https://www.kiranabakehouse.com";


export const announceKey = drop => `announce:${drop.id}`;
export const remindKey = drop => `remind:${drop.id}`;

export function placeLines(drop) {
  return [`Where: ${drop.locationName}, ${drop.locationAddress}`, ...(drop.notes ? [drop.notes] : [])];
}

export function orderPageUrl(env) {
  return `${env.SITE_URL || SITE}/order.html?pickup`;
}

/*
  Each email is claimed in the email log under
  "<kind>:<drop id>:<address>" before it's sent, so
  no one gets the same email twice from the
  schedule, even when runs overlap or a send fails
  halfway (only the ones that didn't go out are let
  go, and the next run sends just those). The
  orders page's buttons pass force, which sends to
  everyone again. "<kind>:<drop id>" keeps a
  summary for the orders page: when, and how many.
*/
async function sendToEach(env, prefix, recipients, makeMessage, { force = false } = {}) {

  const claimed = [];
  const newClaims = new Set();
  for (const email of recipients) {
    const key = `${prefix}:${email}`;
    if (await claimEmail(env, key)) {
      claimed.push(email);
      newClaims.add(email);
    } else if (force) {
      claimed.push(email);
    }
  }

  let sent = 0;
  for (let i = 0; i < claimed.length; i += 100) {
    const batch = claimed.slice(i, i + 100);
    try {
      await sendEmails(env, await Promise.all(batch.map(makeMessage)));
    } catch (error) {
      for (const email of claimed.slice(i).filter(email => newClaims.has(email))) {
        await forgetEmail(env, `${prefix}:${email}`).catch(() => {});
      }
      if (sent) await summarize(env, prefix);
      error.sent = sent;
      throw error;
    }
    sent += batch.length;
  }

  if (sent) await summarize(env, prefix);
  return sent;

}

// "<kind>:<drop id>" = when it last went out, and to how many people in all.
async function summarize(env, prefix) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE key LIKE ?1").bind(`${prefix}:%`).first();
    await logEmail(env, prefix, Number(row?.n) || 0);
  } catch (error) {
    console.error("couldn't update the email log summary", error);
  }
}

// Everyone confirmed on the list, each with their own unsubscribe link.
function openingLine(drop, now) {
  return now < Date.parse(drop.opensAt)
    ? `Ordering opens ${formatMoment(drop.opensAt)} and closes ${formatMoment(drop.closesAt)}.`
    : `Ordering is open now and closes ${formatMoment(drop.closesAt)}.`;
}

// The unsubscribe line is always added back at the end, for each person.
function withAnnounceEdits(message, edits) {
  if (!edits) return message;
  const lines = message.text.split("\n");
  const footer = lines.at(-1);
  return { ...message, subject: edits.subject || message.subject, text: edits.text ? `${edits.text.trimEnd()}\n\n${footer}` : message.text };
}

function announceMessage(env, drop, now, edits) {
  const opening = openingLine(drop, now);
  return async email => withAnnounceEdits(dropOpenEmail({
    to: email,
    when: formatPickupWhen(drop),
    place: placeLines(drop),
    opening,
    orderUrl: orderPageUrl(env),
    unsubscribeUrl: `${API.origin}/api/unsubscribe?token=${await unsubscribeToken(env, email)}`
  }), edits);
}

export async function announceDrop(env, drop, { now = Date.now(), force = false, edits = null } = {}) {
  const people = (await listSubscribers(env)).map(({ email }) => email);
  return sendToEach(env, announceKey(drop), people, announceMessage(env, drop, now, edits), { force });
}

const remindMessage = (drop, edits) => to => applyEdits(pickupReminderEmail({ to, when: formatPickupWhen(drop), place: placeLines(drop) }), edits);

// Preview: who it would go to, and the email as the first of them would get
// it. Sends nothing.
export async function previewDropEmail(env, stripe, drop, kind, { now = Date.now() } = {}) {
  const recipients = kind === "announce"
    ? (await listSubscribers(env)).map(({ email }) => email)
    : await dropCustomerEmails(env, stripe, drop);
  const sample = recipients[0] || "someone@example.com";
  const message = kind === "announce"
    ? dropOpenEmail({ to: sample, when: formatPickupWhen(drop), place: placeLines(drop), opening: openingLine(drop, now), orderUrl: orderPageUrl(env), unsubscribeUrl: `${API.origin}/api/unsubscribe?token=(each person's own link)` })
    : remindMessage(drop)(sample);
  // What can be edited: for "new drop" emails, everything but each person's
  // unsubscribe line (always added back at the end).
  const editable = kind === "announce"
    ? { subject: message.subject, text: message.text.split("\n").slice(0, -2).join("\n"), footer: "Each person's own unsubscribe link is added at the bottom." }
    : { subject: message.subject, text: message.text };
  return { recipients, message, editable };
}

// Emails of everyone with a paid order for this drop, each once.
export async function dropCustomerEmails(env, stripe, drop) {
  const since = Math.floor(Date.parse(drop.opensAt) / 1000) - CHECKOUT_HOLD_SECONDS;
  const emails = new Set();
  // Orders moved here count; orders moved wholly to another day don't.
  const moves = await listMoves(env);
  const movedOut = movedOutByOrder(moves);
  for (const session of await listSessionsSince(env, stripe, since)) {
    if (session.status !== "complete" || session.metadata?.fulfillment !== "pickup" || session.metadata?.drop_id !== String(drop.id)) continue;
    const left = (loavesFromMetadata(session) ?? 1) - sumItems(movedOut.get(session.id) || {});
    const email = session.customer_details?.email;
    if (email && left > 0) emails.add(email.toLowerCase());
  }
  for (const move of moves) {
    if (move.dropId === String(drop.id) && move.email && !move.deliveredAt) emails.add(move.email.toLowerCase());
  }
  return [...emails];
}

export async function remindDrop(env, stripe, drop, { force = false, edits = null } = {}) {
  const emails = await dropCustomerEmails(env, stripe, drop);
  return sendToEach(env, remindKey(drop), emails, remindMessage(drop, edits), { force });
}

