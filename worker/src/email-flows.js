/*
==================================================
DROP EMAILS (both workers)

"A new drop is open" goes to everyone confirmed
on the next-drop list; "reminder: pickup tomorrow"
goes to everyone with a paid order for the drop.

The checkout worker sends both on its own, from an
hourly schedule (see SCHEDULE below); the orders
page's buttons send them by hand at any time. The
email log stops the schedule from sending one
that's already gone out.
==================================================
*/

import { API, PICKUP } from "../../macros.js";
import { dayBefore, formatMoment, formatPickupWhen, utcToLocal } from "../../pickup-rules.js";
import { canEmail, dropOpenEmail, pickupReminderEmail, sendEmails } from "./email.js";
import { claimEmail, forgetEmail, hasDatabase, listDrops, listSubscribers, logEmail, unsubscribeToken } from "./drops.js";
import { listSessionsSince } from "./stripe-cache.js";
import { CHECKOUT_HOLD_SECONDS } from "./capacity.js";

const SITE = "https://www.kiranabakehouse.com";

// When the hourly schedule sends each email (bakery time).
export const SCHEDULE = Object.freeze({
  // "A new drop is open" for a drop that opened in the last day.
  announceWithinHours: 24,
  // "Pickup tomorrow" reminders, from this hour the day before.
  reminderFromHour: 17
});

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
export async function announceDrop(env, drop, { now = Date.now(), force = false } = {}) {

  const people = (await listSubscribers(env)).map(({ email }) => email);
  const opening = now < Date.parse(drop.opensAt)
    ? `Ordering opens ${formatMoment(drop.opensAt)} and closes ${formatMoment(drop.closesAt)}.`
    : `Ordering is open now and closes ${formatMoment(drop.closesAt)}.`;

  return sendToEach(env, announceKey(drop), people, async email => dropOpenEmail({
    to: email,
    when: formatPickupWhen(drop),
    place: placeLines(drop),
    opening,
    orderUrl: orderPageUrl(env),
    unsubscribeUrl: `${API.origin}/api/unsubscribe?token=${await unsubscribeToken(env, email)}`
  }), { force });

}

// Emails of everyone with a paid order for this drop, each once.
export async function dropCustomerEmails(env, stripe, drop) {
  const since = Math.floor(Date.parse(drop.opensAt) / 1000) - CHECKOUT_HOLD_SECONDS;
  const emails = new Set();
  for (const session of await listSessionsSince(env, stripe, since)) {
    if (session.status !== "complete" || session.metadata?.fulfillment !== "pickup" || session.metadata?.drop_id !== String(drop.id)) continue;
    const email = session.customer_details?.email;
    if (email) emails.add(email.toLowerCase());
  }
  return [...emails];
}

export async function remindDrop(env, stripe, drop, { force = false } = {}) {
  const emails = await dropCustomerEmails(env, stripe, drop);
  return sendToEach(env, remindKey(drop), emails,
    to => pickupReminderEmail({ to, when: formatPickupWhen(drop), place: placeLines(drop) }), { force });
}

/*
==================================================
SCHEDULE

Runs every hour on the checkout worker:

  - "A new drop is open" for drops that opened in
    the last day, to anyone on the list who hasn't
    had it (people who join that day get it too).
  - Reminders from 5 pm the day before pickup until
    the pickup window ends, to any customer who
    hasn't had one (late orders get one too).
==================================================
*/

export async function runScheduledEmails(env, stripe, now = Date.now()) {

  if (!canEmail(env) || !hasDatabase(env)) return { announced: 0, reminded: 0 };

  const local = utcToLocal(new Date(now).toISOString(), PICKUP.timeZone);
  const hour = Number(local.time.slice(0, 2));
  const drops = await listDrops(env, { fromDate: local.date });
  let announced = 0;
  let reminded = 0;

  for (const drop of drops) {

    const opened = Date.parse(drop.opensAt);
    const isOpen = opened <= now && now < Date.parse(drop.closesAt);
    if (isOpen && now - opened < SCHEDULE.announceWithinHours * 36e5) {
      announced += await announceDrop(env, drop, { now });
    }

    const eveningBefore = dayBefore(drop.pickupDate) === local.date && hour >= SCHEDULE.reminderFromHour;
    const pickupDayBeforeEnd = drop.pickupDate === local.date && local.time < drop.windowEnd;
    if (eveningBefore || pickupDayBeforeEnd) {
      reminded += await remindDrop(env, stripe, drop);
    }

  }

  return { announced, reminded };

}
