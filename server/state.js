// -----------------------------------------------------------------------
// Live, in-memory state for the "current event window" (spec §4, §7).
//
// No history is persisted anywhere (spec §1, §8) — this is intentionally
// just an in-memory object that gets reset whenever a new event window
// begins.
// -----------------------------------------------------------------------

const { getTrackedServers } = require('./config');
const { nextEventStart, activeEventStart, eventWindow, parseLogTimestamp } = require('./timeUtils');
const { STARTUP_PENDING_THRESHOLD_MINUTES, PRE_EVENT_PENDING_MINUTES } = require('./constants');

const state = {
  currentEventStart: null, // UTC ms of the event window currently being tracked
  servers: {}, // { [serverId]: { status: 'pending'|'killed', kill: {...}|null } }
  pollingEnabled: true, // manual user toggle (spec §6)
  lastPollAt: null, // UTC ms of last successful or attempted poll
  lastSuccessAt: null,
  lastError: null, // { type, message } | null
  startupPendingMode: false, // true if we booted within 30 min of the next event
};

function ensureServerEntries() {
  const tracked = getTrackedServers();
  const trackedIds = new Set(tracked.map((s) => s.id));

  // Add any newly-tracked servers as Pending.
  for (const s of tracked) {
    if (!state.servers[s.id]) {
      state.servers[s.id] = { status: 'pending', kill: null };
    }
  }
  // Drop servers no longer tracked (removed/disabled in config).
  for (const id of Object.keys(state.servers)) {
    if (!trackedIds.has(id)) delete state.servers[id];
  }
}

// Call at startup and on every poll tick to figure out which event
// window we should currently be tracking, resetting state if it just
// rolled over to a new one.
function syncEventWindow(nowUtcMs) {
  // Which window we should be tracking right now: the currently-open one,
  // or — once within PRE_EVENT_PENDING_MINUTES of it — the upcoming one.
  // Switching early (rather than at the literal start second) means
  // applyScrapedRows, which only matches timestamps >= this start, can
  // never carry a kill over from the previous (already-decided) window.
  const eventStart = activeEventStart(nowUtcMs, PRE_EVENT_PENDING_MINUTES);

  if (state.currentEventStart === null) {
    // First run.
    const nextStart = nextEventStart(nowUtcMs);
    const minutesToNext = (nextStart - nowUtcMs) / 60000;
    // Spec §4: show all servers Pending / Waiting for next event immediately.
    state.startupPendingMode = minutesToNext < STARTUP_PENDING_THRESHOLD_MINUTES;
    state.currentEventStart = eventStart;
    ensureServerEntries();
    return;
  }

  if (eventStart !== state.currentEventStart) {
    // Rolled into a new tracked window -> reset kill state (spec §4:
    // one qualifying kill possible per server per window).
    state.currentEventStart = eventStart;
    state.startupPendingMode = false;
    state.servers = {};
    ensureServerEntries();
    return;
  }

  ensureServerEntries();
}

function applyScrapedRows(rows) {
  if (state.currentEventStart === null) return;
  const { start, end } = eventWindow(state.currentEventStart);
  const trackedIds = new Set(Object.keys(state.servers));

  for (const row of rows) {
    if (!trackedIds.has(row.server)) continue; // untracked or SvC
    const entry = state.servers[row.server];
    if (entry.status === 'killed') continue; // already have the one qualifying kill

    const ts = parseLogTimestamp(row.date);
    if (ts === null) continue; // unparseable timestamp, skip defensively
    if (ts >= start && ts < end) {
      entry.status = 'killed';
      entry.kill = {
        monster: row.monster,
        time: row.date,
        player: row.player,
        map: row.map,
      };
    }
  }
}

function recordPollSuccess(rows, nowUtcMs) {
  syncEventWindow(nowUtcMs);
  applyScrapedRows(rows);
  state.lastPollAt = nowUtcMs;
  state.lastSuccessAt = nowUtcMs;
  state.lastError = null;
}

function recordPollFailure(err, nowUtcMs) {
  syncEventWindow(nowUtcMs);
  state.lastPollAt = nowUtcMs;
  state.lastError = { type: err.type || 'unknown', message: err.message || String(err) };
}

function getSnapshot(nowUtcMs) {
  syncEventWindow(nowUtcMs);
  const eventStart = state.currentEventStart;
  const { end } = eventStart !== null ? eventWindow(eventStart) : { end: null };
  const next = nextEventStart(nowUtcMs);

  const servers = getTrackedServers().map((s) => {
    const entry = state.servers[s.id] || { status: 'pending', kill: null };
    return { id: s.id, status: entry.status, kill: entry.kill };
  });

  return {
    servers,
    currentEventStart: eventStart,
    eventWindowEnd: end,
    nextEventStart: next,
    secondsUntilNextEvent: Math.round((next - nowUtcMs) / 1000),
    secondsSinceEventStart: eventStart !== null ? Math.round((nowUtcMs - eventStart) / 1000) : null,
    startupPendingMode: state.startupPendingMode,
    pollingEnabled: state.pollingEnabled,
    lastPollAt: state.lastPollAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    now: nowUtcMs,
  };
}

function setPollingEnabled(enabled) {
  state.pollingEnabled = !!enabled;
}

function isPollingEnabled() {
  return state.pollingEnabled;
}

module.exports = {
  syncEventWindow,
  recordPollSuccess,
  recordPollFailure,
  getSnapshot,
  setPollingEnabled,
  isPollingEnabled,
};
