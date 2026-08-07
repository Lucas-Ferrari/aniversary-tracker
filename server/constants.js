// -----------------------------------------------------------------------
// Hardcoded constants.
//
// Per spec §6, the poll interval is a hardcoded, code-level constant (not
// user-editable at runtime). To change it, edit the value below and
// restart the app.
//
// Per spec §4, timezone handling is a fixed UTC-3 offset with no DST
// logic. If Brazil ever reinstates DST, TZ_OFFSET_MINUTES below is the
// single place that needs a manual update.
// -----------------------------------------------------------------------

module.exports = {
  // How often the backend re-scrapes en.megamu.net/boss-log, in ms.
  // Spec §6: hardcoded, not exposed in the UI, no enforced minimum.
  REFRESH_INTERVAL_MS: 5 * 1000, // 5 seconds

  // Source page for the boss log (spec §5).
  BOSS_LOG_URL: 'https://en.megamu.net/boss-log',

  // Only the most recent ~30 rows are needed to reliably capture a
  // window's ~20 kills (spec §5).
  ROWS_TO_INSPECT: 30,

  // Daily event start times, in local (UTC-3) HH:mm (spec §4).
  EVENT_TIMES: ['00:55', '03:55', '06:55', '09:55', '12:55', '15:55', '18:55', '21:55'],

  // Fixed UTC-3 offset, in minutes. No DST logic (spec §4).
  TZ_OFFSET_MINUTES: -180,

  // Event window length in minutes (spec §4).
  EVENT_WINDOW_MINUTES: 20,

  // Polling automatically stops this many minutes after event start —
  // a 10-minute buffer past the 20-minute kill window for late-arriving
  // log entries (spec §6).
  POLL_AUTO_STOP_MINUTES: 30,

  // If the app starts and the next event begins in under this many
  // minutes, show all servers as Pending / Waiting for next event
  // immediately (spec §4).
  STARTUP_PENDING_THRESHOLD_MINUTES: 30,

  // Reset the board to Pending this many minutes before the next event
  // starts, rather than waiting for the literal start second. Kills from
  // the previous window can never bleed into the new one this way, since
  // applyScrapedRows only matches timestamps >= the tracked window's
  // start, which during this buffer is still in the future.
  PRE_EVENT_PENDING_MINUTES: 5,

  // Play a notification sound this many minutes before an event starts
  // (spec §7).
  PRE_EVENT_NOTIFY_MINUTES: 5,

  // Server explicitly excluded from tracking (spec §2 / §3).
  EXCLUDED_SERVER: 'SvC',
};
