// -----------------------------------------------------------------------
// Drives periodic scraping.
//
// Spec §6:
//   - Polling can be toggled on/off by the user (state.pollingEnabled).
//   - Polling automatically stops 30 minutes after event start,
//     regardless of the manual toggle, to stop hammering the site once
//     the window (plus late-arrival buffer) has closed.
//   - The tick interval itself is a hardcoded constant (constants.js).
// -----------------------------------------------------------------------

const { scrapeBossLog } = require('./scraper');
const { recordPollSuccess, recordPollFailure, isPollingEnabled, syncEventWindow, getSnapshot } = require('./state');
const { REFRESH_INTERVAL_MS, POLL_AUTO_STOP_MINUTES } = require('./constants');

function withinAutoPollWindow(nowUtcMs) {
  const snap = getSnapshot(nowUtcMs);
  if (snap.currentEventStart === null) return true;
  const minutesSinceStart = (nowUtcMs - snap.currentEventStart) / 60000;
  // Also keep polling in the run-up to the next event once we're close
  // enough that the window is about to open (avoids a dead gap right at
  // the boundary).
  const minutesToNext = snap.secondsUntilNextEvent / 60;
  return minutesSinceStart <= POLL_AUTO_STOP_MINUTES || minutesToNext <= 1;
}

async function scrapeNow() {
  const now = Date.now();
  syncEventWindow(now);

  try {
    const { rows } = await scrapeBossLog();
    recordPollSuccess(rows, Date.now());
  } catch (err) {
    recordPollFailure(err, Date.now());
    console.error(`[poller] scrape failed (${err.type || 'unknown'}): ${err.message}`);
  }
}

async function tick() {
  const now = Date.now();
  syncEventWindow(now);

  if (!isPollingEnabled()) return;
  if (!withinAutoPollWindow(now)) return;

  await scrapeNow();
}

// Bypasses the enabled/auto-stop guards in tick() — used by the manual
// "force fetch" button so it always hits the source regardless of the
// polling toggle or the auto-stop window.
async function forceTick() {
  await scrapeNow();
}

function start() {
  // Run once immediately on boot, then on the fixed interval.
  tick();
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  return handle;
}

module.exports = { start, tick, forceTick };
