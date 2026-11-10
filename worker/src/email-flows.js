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

// Everyone confirmed on the list, each with their own unsubscribe link.
export async function announceDrop(env, drop, now = Date.now()) {

  const people = await listSubscribers(env);
  const opening = now < Date.parse(drop.opensAt)
    ? `Ordering opens ${formatMoment(drop.opensAt)} and closes ${formatMoment(drop.closesAt)}.`
    : `Ordering is open now and closes ${formatMoment(drop.closesAt)}.`;

  const messages = [];
  for (const { email } of people) {
    const token = await unsubscribeToken(env, email);
    messages.push(dropOpenEmail({
      to: email,
      when: formatPickupWhen(drop),
      place: placeLines(drop),
      opening,
      orderUrl: orderPageUrl(env),
      unsubscribeUrl: `${API.origin}/api/unsubscribe?token=${token}`
    }));
  }

  await sendEmails(env, messages);
  await logEmail(env, announceKey(drop), messages.length);
  return messages.length;

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

export async function remindDrop(env, stripe, drop) {
  const emails = await dropCustomerEmails(env, stripe, drop);
  const messages = emails.map(to => pickupReminderEmail({ to, when: formatPickupWhen(drop), place: placeLines(drop) }));
  await sendEmails(env, messages);
  await logEmail(env, remindKey(drop), messages.length);
  return messages.length;
}

/*
==================================================
SCHEDULE

Runs every hour on the checkout worker. Each email
is claimed in the log before it's sent, so an
overlapping run (or the orders page's button)
can't send it twice. If sending fails, the claim
is let go and the next run tries again.
==================================================
*/

export async function runScheduledEmails(env, stripe, now = Date.now()) {

  if (!canEmail(env) || !hasDatabase(env)) return { announced: 0, reminded: 0 };

  const local = utcToLocal(new Date(now).toISOString(), PICKUP.timeZone);
  const drops = await listDrops(env, { fromDate: local.date });
  let announced = 0;
  let reminded = 0;

  for (const drop of drops) {

    const opened = Date.parse(drop.opensAt);
    const isOpen = opened <= now && now < Date.parse(drop.closesAt);
    if (isOpen && now - opened < SCHEDULE.announceWithinHours * 36e5) {
      announced += await sendOnce(env, announceKey(drop), () => announceDrop(env, drop, now));
    }

    const hour = Number(local.time.slice(0, 2));
    if (dayBefore(drop.pickupDate) === local.date && hour >= SCHEDULE.reminderFromHour) {
      reminded += await sendOnce(env, remindKey(drop), () => remindDrop(env, stripe, drop));
    }

  }

  return { announced, reminded };

}

async function sendOnce(env, key, send) {
  if (!await claimEmail(env, key)) return 0;
  try {
    return await send();
  } catch (error) {
    await forgetEmail(env, key);
    throw error;
  }
}
