// -----------------------------------------------------------------------
// Event-window time math, all under the fixed UTC-3 offset (spec §4).
//
// We work in "local minutes since local week start (Sunday 00:00)" to
// avoid any reliance on the host machine's own timezone or on JS Date's
// local-timezone behavior, which would break as soon as this runs on a
// machine that isn't already UTC-3. Schedules are expressed weekly (a
// daily schedule is just the same time repeated on all 7 days) so the
// same math serves every tracked event, regardless of cadence.
// -----------------------------------------------------------------------

const { TZ_OFFSET_MINUTES, EVENT_WINDOW_MINUTES } = require('./constants');

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

// Converts a `{ day, time }[]` schedule (day: 0=Sunday..6=Saturday, time:
// "HH:mm") into a sorted list of "minutes since local week start" slots.
function scheduleToWeekMinutes(schedule) {
  const minutes = schedule.map(({ day, time }) => {
    const [h, m] = time.split(':').map(Number);
    return day * MINUTES_PER_DAY + h * 60 + m;
  });
  return [...new Set(minutes)].sort((a, b) => a - b);
}

// Converts a real-world instant (UTC ms) into "local UTC-3 minutes since
// local week start (Sunday 00:00)" plus which local week (as a UTC-ms
// Sunday-00:00 marker) it falls on. This lets us do all comparisons in
// plain integer minutes.
function toLocalWeekParts(utcMs) {
  const localMs = utcMs + TZ_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMs);
  const dayOfWeek = localDate.getUTCDay(); // 0 = Sunday
  const dayStartLocalMs =
    Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()) -
    TZ_OFFSET_MINUTES * 60 * 1000;
  const weekStartLocalMs = dayStartLocalMs - dayOfWeek * MINUTES_PER_DAY * 60 * 1000;
  // Re-derive using UTC getters on the shifted timestamp so we never touch
  // the host machine's local timezone.
  const minutesOfWeek =
    dayOfWeek * MINUTES_PER_DAY +
    localDate.getUTCHours() * 60 +
    localDate.getUTCMinutes() +
    localDate.getUTCSeconds() / 60;
  return { minutesOfWeek, weekStartLocalMs };
}

function localWeekPartsToUtcMs(weekStartLocalMs, minutesOfWeek) {
  return weekStartLocalMs + minutesOfWeek * 60 * 1000;
}

// Returns the UTC ms timestamp of the most recent event start at or
// before `nowUtcMs`, walking back into the previous week if needed.
function mostRecentEventStart(nowUtcMs, weekMinutes) {
  const { minutesOfWeek, weekStartLocalMs } = toLocalWeekParts(nowUtcMs);
  const thisWeekPast = weekMinutes.filter((m) => m <= minutesOfWeek);
  if (thisWeekPast.length > 0) {
    const m = Math.max(...thisWeekPast);
    return localWeekPartsToUtcMs(weekStartLocalMs, m);
  }
  // Nothing has fired yet this local week -> most recent was last week's last slot.
  const lastSlot = Math.max(...weekMinutes);
  return localWeekPartsToUtcMs(weekStartLocalMs - MINUTES_PER_WEEK * 60 * 1000, lastSlot);
}

// Returns the UTC ms timestamp of the next event start strictly after
// `nowUtcMs`.
function nextEventStart(nowUtcMs, weekMinutes) {
  const { minutesOfWeek, weekStartLocalMs } = toLocalWeekParts(nowUtcMs);
  const thisWeekFuture = weekMinutes.filter((m) => m > minutesOfWeek);
  if (thisWeekFuture.length > 0) {
    const m = Math.min(...thisWeekFuture);
    return localWeekPartsToUtcMs(weekStartLocalMs, m);
  }
  const firstSlot = Math.min(...weekMinutes);
  return localWeekPartsToUtcMs(weekStartLocalMs + MINUTES_PER_WEEK * 60 * 1000, firstSlot);
}

// Returns the UTC ms timestamp of the event window that should currently
// be tracked: normally the most recent event start, but flips early to
// the upcoming event once we're within `preEventMinutes` of it. This lets
// the board reset to Pending ahead of time instead of continuing to show
// the previous (already-decided) window's results right up until the
// literal start second.
function activeEventStart(nowUtcMs, weekMinutes, preEventMinutes) {
  const next = nextEventStart(nowUtcMs, weekMinutes);
  const minutesToNext = (next - nowUtcMs) / 60000;
  if (minutesToNext <= preEventMinutes) return next;
  return mostRecentEventStart(nowUtcMs, weekMinutes);
}

function eventWindow(eventStartUtcMs) {
  return {
    start: eventStartUtcMs,
    end: eventStartUtcMs + EVENT_WINDOW_MINUTES * 60 * 1000,
  };
}

// Parses a "YYYY-MM-DD HH:mm:ss" boss-log timestamp, which the site
// renders in the same fixed UTC-3 local time, into a UTC ms timestamp.
function parseLogTimestamp(str) {
  const m = String(str)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Treat the given wall-clock time as UTC-3, so convert to true UTC by
  // subtracting the (negative) offset, i.e. adding 3 hours.
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return asIfUtc - TZ_OFFSET_MINUTES * 60 * 1000;
}

module.exports = {
  scheduleToWeekMinutes,
  mostRecentEventStart,
  nextEventStart,
  activeEventStart,
  eventWindow,
  parseLogTimestamp,
};
