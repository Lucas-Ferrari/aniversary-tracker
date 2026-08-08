// -----------------------------------------------------------------------
// Drives periodic scraping.
//
// One scrape of the shared boss-log page serves every tracked event
// (aniversary, medusa, ...) — each event just applies the same rows
// through its own window/monster-filter logic (state.applyScrapedRows).
//
// Spec §6:
//   - Polling can be toggled on/off per event by the user (state.pollingEnabled).
//   - Polling automatically stops 30 minutes after that event's window
//     start, regardless of the manual toggle, to stop hammering the site
//     once the window (plus late-arrival buffer) has closed.
//   - The tick interval itself is a hardcoded constant (constants.js).
// -----------------------------------------------------------------------

const { scrapeBossLog } = require('./scraper');
const { recordPollSuccess, recordPollFailure, isPollingEnabled, syncEventWindow, getSnapshot, getEventIds } = require('./state');
const { REFRESH_INTERVAL_MS, POLL_AUTO_STOP_MINUTES } = require('./constants');

function withinAutoPollWindow(eventId, nowUtcMs) {
  const snap = getSnapshot(eventId, nowUtcMs);
  if (snap.currentEventStart === null) return true;
  const minutesSinceStart = (nowUtcMs - snap.currentEventStart) / 60000;
  // Also keep polling in the run-up to the next event once we're close
  // enough that the window is about to open (avoids a dead gap right at
  // the boundary).
  const minutesToNext = snap.secondsUntilNextEvent / 60;
  return minutesSinceStart <= POLL_AUTO_STOP_MINUTES || minutesToNext <= 1;
}

// Scrapes once and applies the result to exactly the given event ids.
async function scrapeNow(eventIds) {
  if (eventIds.length === 0) return;
  const now = Date.now();
  for (const id of eventIds) syncEventWindow(id, now);

  try {
    const { rows } = await scrapeBossLog();
    const successAt = Date.now();
    for (const id of eventIds) recordPollSuccess(id, rows, successAt);
  } catch (err) {
    const failAt = Date.now();
    for (const id of eventIds) recordPollFailure(id, err, failAt);
    console.error(`[poller] scrape failed (${err.type || 'unknown'}): ${err.message}`);
  }
}

async function tick() {
  const now = Date.now();
  const ids = getEventIds();
  for (const id of ids) syncEventWindow(id, now);

  const activeIds = ids.filter((id) => isPollingEnabled(id) && withinAutoPollWindow(id, now));
  await scrapeNow(activeIds);
}

// Bypasses the enabled/auto-stop guards in tick() — used by each view's
// manual "force fetch" button so it always hits the source regardless of
// the polling toggle or the auto-stop window. Defaults to every event if
// no specific ids are given.
async function forceTick(eventIds) {
  await scrapeNow(eventIds && eventIds.length ? eventIds : getEventIds());
}

function start() {
  // Run once immediately on boot, then on the fixed interval.
  tick();
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  return handle;
}

module.exports = { start, tick, forceTick };
