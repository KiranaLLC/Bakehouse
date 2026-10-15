/**
 * Pickup day rules shared by the order page, the admin page and the worker:
 * time slots, status and local-time handling.
 *
 * Pickup days store their date and times in the bakery's time zone
 * (PICKUP.timeZone); the order cutoff is stored as a UTC timestamp.
 */
import { PICKUP } from "./macros.js?v=3";

const LOCALE = "en-US";

/*
==================================================
TIMES
==================================================
*/

// "10:15" → "10:15 am"
export function formatTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

// "2026-11-01" → "Saturday, November 1"
export function formatPickupDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

// "2026-11-01", "10:15" → "Saturday, November 1 at 10:15 am"
export function formatPickupSlot(date, time) {
  return `${formatPickupDate(date)} at ${formatTime(time)}`;
}

// UTC timestamp → "Sunday, October 26 at 6:00 pm" in the bakery's time zone
export function formatMoment(iso) {
  const { date, time } = utcToLocal(iso);
  return formatPickupSlot(date, time);
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(total) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/*
==================================================
TIME ZONE

Converts between the bakery's local date + time
and UTC timestamps, wherever the code runs.
==================================================
*/

function timeZoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(utcMs));
  const get = type => Number(parts.find(part => part.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

// "2026-11-01", "10:15" → "2026-11-01T17:15:00.000Z"
export function localToUtc(date, time, timeZone = PICKUP.timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const asIfUtc = Date.UTC(year, month - 1, day, hours, minutes);
  let utc = asIfUtc;
  // Two passes handle the offset changing across a daylight-saving boundary.
  for (let pass = 0; pass < 2; pass++) utc = asIfUtc - timeZoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

// "2026-11-01T17:15:00.000Z" → { date: "2026-11-01", time: "10:15" }
export function utcToLocal(iso, timeZone = PICKUP.timeZone) {
  const local = new Date(new Date(iso).getTime() + timeZoneOffsetMs(new Date(iso).getTime(), timeZone));
  return { date: local.toISOString().slice(0, 10), time: local.toISOString().slice(11, 16) };
}

/*
==================================================
PICKUP DAYS
==================================================
*/

// All pickup times for a day, e.g. 10:00, 10:15 … up to (not including) the window end.
export function getPickupSlots(day) {
  const slots = [];
  const end = timeToMinutes(day.windowEnd);
  for (let minutes = timeToMinutes(day.windowStart); minutes < end; minutes += day.slotMinutes) {
    const value = minutesToTime(minutes);
    slots.push({ value, label: formatTime(value) });
  }
  return slots;
}

// "open" until the order cutoff, then "closed"
export function getPickupDayStatus(day, now = new Date()) {
  return now.getTime() >= new Date(day.closesAt).getTime() ? "closed" : "open";
}

export function describePickupWindow(day) {
  return `${formatTime(day.windowStart)} – ${formatTime(day.windowEnd)}`;
}

/*
==================================================
WEEKLY SCHEDULE

Turns PICKUP.schedule into concrete pickup days
for the next PICKUP.bookingWindowDays days.
Each has a ruleKey + pickupDate; the worker
replaces any the admin page has changed.
==================================================
*/

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getScheduledPickupDays(now = new Date()) {

  const { date: todayLocal } = utcToLocal(now.toISOString());
  const today = Date.UTC(...todayLocal.split("-").map((part, index) => Number(part) - (index === 1 ? 1 : 0)));
  const days = [];

  for (let offset = 0; offset <= PICKUP.bookingWindowDays; offset++) {
    const date = new Date(today + offset * MS_PER_DAY);
    const pickupDate = date.toISOString().slice(0, 10);

    for (const rule of PICKUP.schedule) {
      if (date.getUTCDay() !== rule.weekday) continue;

      const cutoffDate = new Date(date.getTime() - rule.cutoffDaysBefore * MS_PER_DAY).toISOString().slice(0, 10);
      const closesAt = localToUtc(cutoffDate, rule.cutoffTime);
      if (new Date(closesAt).getTime() <= now.getTime()) continue;

      days.push({
        ruleKey: rule.key,
        name: rule.name,
        address: rule.address,
        notes: rule.notes || "",
        pickupDate,
        windowStart: rule.windowStart,
        windowEnd: rule.windowEnd,
        slotMinutes: rule.slotMinutes || PICKUP.defaultSlotMinutes,
        maxOrdersPerSlot: rule.maxOrdersPerSlot || null,
        totalLoaves: rule.totalLoaves,
        closesAt
      });
    }
  }

  return days;

}
