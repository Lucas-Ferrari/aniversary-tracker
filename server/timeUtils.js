// -----------------------------------------------------------------------
// Event-window time math, all under the fixed UTC-3 offset (spec §4).
//
// We work in "local minutes since local midnight" to avoid any reliance
// on the host machine's own timezone or on JS Date's local-timezone
// behavior, which would break as soon as this runs on a machine that
// isn't already UTC-3.
// -----------------------------------------------------------------------

const { EVENT_TIMES, TZ_OFFSET_MINUTES, EVENT_WINDOW_MINUTES } = require('./constants');

const EVENT_MINUTES = EVENT_TIMES.map((t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
});
const MINUTES_PER_DAY = 24 * 60;

// Converts a real-world instant (UTC ms) into "local UTC-3 minutes since
// local midnight" plus which local calendar day (as a UTC-ms midnight
// marker) it falls on. This lets us do all comparisons in plain integer
// minutes.
function toLocalParts(utcMs) {
  const localMs = utcMs + TZ_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMs);
  const dayStartLocalMs =
    Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()) -
    TZ_OFFSET_MINUTES * 60 * 1000;
  // Re-derive using UTC getters on the shifted timestamp so we never touch
  // the host machine's local timezone.
  const minutesOfDay = localDate.getUTCHours() * 60 + localDate.getUTCMinutes() + localDate.getUTCSeconds() / 60;
  return { minutesOfDay, dayStartLocalMs };
}

function localPartsToUtcMs(dayStartLocalMs, minutesOfDay) {
  return dayStartLocalMs + minutesOfDay * 60 * 1000;
}

// Returns the UTC ms timestamp of the most recent event start at or
// before `nowUtcMs`, walking back into the previous day if needed.
function mostRecentEventStart(nowUtcMs) {
  const { minutesOfDay, dayStartLocalMs } = toLocalParts(nowUtcMs);
  const todaysPast = EVENT_MINUTES.filter((m) => m <= minutesOfDay);
  if (todaysPast.length > 0) {
    const m = Math.max(...todaysPast);
    return localPartsToUtcMs(dayStartLocalMs, m);
  }
  // Nothing has fired yet today locally -> most recent was yesterday's last slot.
  const lastSlot = Math.max(...EVENT_MINUTES);
  return localPartsToUtcMs(dayStartLocalMs - MINUTES_PER_DAY * 60 * 1000, lastSlot);
}

// Returns the UTC ms timestamp of the next event start strictly after
// `nowUtcMs`.
function nextEventStart(nowUtcMs) {
  const { minutesOfDay, dayStartLocalMs } = toLocalParts(nowUtcMs);
  const todaysFuture = EVENT_MINUTES.filter((m) => m > minutesOfDay);
  if (todaysFuture.length > 0) {
    const m = Math.min(...todaysFuture);
    return localPartsToUtcMs(dayStartLocalMs, m);
  }
  const firstSlot = Math.min(...EVENT_MINUTES);
  return localPartsToUtcMs(dayStartLocalMs + MINUTES_PER_DAY * 60 * 1000, firstSlot);
}

// Returns the UTC ms timestamp of the event window that should currently
// be tracked: normally the most recent event start, but flips early to
// the upcoming event once we're within `preEventMinutes` of it. This lets
// the board reset to Pending ahead of time instead of continuing to show
// the previous (already-decided) window's results right up until the
// literal start second.
function activeEventStart(nowUtcMs, preEventMinutes) {
  const next = nextEventStart(nowUtcMs);
  const minutesToNext = (next - nowUtcMs) / 60000;
  if (minutesToNext <= preEventMinutes) return next;
  return mostRecentEventStart(nowUtcMs);
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
  mostRecentEventStart,
  nextEventStart,
  activeEventStart,
  eventWindow,
  parseLogTimestamp,
};
