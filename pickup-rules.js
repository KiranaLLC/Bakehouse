/*
==================================================
PICKUP RULES

Shared by the order page, the checkout worker
and the orders page: a drop's status, and the
time and date wording customers see.

A drop's pickup date and window are in the
bakery's time zone ("2026-11-14", "14:00"); the
moments ordering opens and closes are stored as
UTC timestamps.
==================================================
*/

import { PICKUP } from "./macros.js";

const LOCALE = "en-US";

/*
  "open"      ordering is open and loaves are left
  "upcoming"  ordering hasn't opened yet
  "sold_out"  open, but every loaf is taken
  "closed"    ordering has closed
  "cancelled" the bakery cancelled it
*/
export function dropStatus(drop, remaining, now = Date.now()) {
  if (drop.cancelled) return "cancelled";
  if (now >= Date.parse(drop.closesAt)) return "closed";
  if (now < Date.parse(drop.opensAt)) return "upcoming";
  if (remaining <= 0) return "sold_out";
  return "open";
}

/*
==================================================
WORDING
==================================================
*/

// "14:00" → "2 pm", "14:30" → "2:30 pm"
export function formatTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return minutes ? `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}` : `${hour12} ${suffix}`;
}

// "Saturday, November 14"
export function formatPickupDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

// "2 pm – 3 pm"
export function formatPickupWindow(drop) {
  return `${formatTime(drop.windowStart)} – ${formatTime(drop.windowEnd)}`;
}

// "Saturday, November 14, 2 pm – 3 pm"
export function formatPickupWhen(drop) {
  return `${formatPickupDate(drop.pickupDate)}, ${formatPickupWindow(drop)}`;
}

// UTC timestamp → "Sun, Nov 8 at 6 pm" in the bakery's time zone
export function formatMoment(iso) {
  const { date, time } = utcToLocal(iso);
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return `${day} at ${formatTime(time)}`;
}

// Milliseconds → "2d 4h", "3h 12m", "12m 5s"
export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

/*
==================================================
TIME ZONE

Converts between the bakery's local date + time
and UTC timestamps, wherever the code runs (the
customer's phone may be in another time zone).
==================================================
*/

function offsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat(LOCALE, {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(utcMs)).map(({ type, value }) => [type, value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// ("2026-11-08", "18:00") in the bakery's time zone → "2026-11-09T02:00:00.000Z"
export function localToUtc(date, time, timeZone = PICKUP.timeZone) {
  const asIfUtc = Date.parse(`${date}T${time}:00Z`);
  // Twice, so a guess on the wrong side of a daylight-saving change corrects itself.
  let utc = asIfUtc - offsetMs(asIfUtc, timeZone);
  utc = asIfUtc - offsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

// "2026-11-09T02:00:00.000Z" → { date: "2026-11-08", time: "18:00" } in the bakery's time zone
export function utcToLocal(iso, timeZone = PICKUP.timeZone) {
  const local = new Date(Date.parse(iso) + offsetMs(Date.parse(iso), timeZone)).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

// The day before a date: "2026-11-14" → "2026-11-13"
export function dayBefore(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
}

// The last given weekday strictly before a date (0 = Sunday … 3 = Wednesday).
// "2026-11-14" (Sat), 3 → "2026-11-11" (Wed)
export function weekdayBefore(date, weekday) {
  let day = dayBefore(date);
  while (new Date(`${day}T00:00:00Z`).getUTCDay() !== weekday) day = dayBefore(day);
  return day;
}
