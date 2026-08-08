// -----------------------------------------------------------------------
// Live, in-memory state for each tracked event's "current event window"
// (spec §4, §7).
//
// No history is persisted anywhere (spec §1, §8) — this is intentionally
// just an in-memory object per event that gets reset whenever that
// event's window rolls over. Multiple events (aniversary, medusa, ...)
// track independently: each has its own schedule, its own monster
// filter, and its own polling toggle, but they all share the same
// tracked-server list (config.js) since that's server infrastructure,
// not event-specific.
// -----------------------------------------------------------------------

const { getTrackedServers } = require('./config');
const { scheduleToWeekMinutes, nextEventStart, activeEventStart, eventWindow, parseLogTimestamp } = require('./timeUtils');
const { EVENTS, STARTUP_PENDING_THRESHOLD_MINUTES, PRE_EVENT_PENDING_MINUTES } = require('./constants');

function makeInitialState() {
  return {
    currentEventStart: null, // UTC ms of the event window currently being tracked
    servers: {}, // { [serverId]: { status: 'pending'|'killed', kill: {...}|null } }
    pollingEnabled: true, // manual user toggle (spec §6), independent per event
    lastPollAt: null, // UTC ms of last successful or attempted poll
    lastSuccessAt: null,
    lastError: null, // { type, message } | null
    startupPendingMode: false, // true if we booted within 30 min of the next event
  };
}

// eventId -> { def, weekMinutes, state }
const events = new Map(
  EVENTS.map((def) => [def.id, { def, weekMinutes: scheduleToWeekMinutes(def.schedule), state: makeInitialState() }])
);

function getEvent(eventId) {
  const entry = events.get(eventId);
  if (!entry) throw new Error(`Unknown event "${eventId}"`);
  return entry;
}

function getEventIds() {
  return [...events.keys()];
}

function getEventDefs() {
  return [...events.values()].map(({ def }) => ({ id: def.id, label: def.label }));
}

function ensureServerEntries(state) {
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
function syncEventWindow(eventId, nowUtcMs) {
  const { weekMinutes, state } = getEvent(eventId);

  // Which window we should be tracking right now: the currently-open one,
  // or — once within PRE_EVENT_PENDING_MINUTES of it — the upcoming one.
  // Switching early (rather than at the literal start second) means
  // applyScrapedRows, which only matches timestamps >= this start, can
  // never carry a kill over from the previous (already-decided) window.
  const eventStart = activeEventStart(nowUtcMs, weekMinutes, PRE_EVENT_PENDING_MINUTES);

  if (state.currentEventStart === null) {
    // First run.
    const nextStart = nextEventStart(nowUtcMs, weekMinutes);
    const minutesToNext = (nextStart - nowUtcMs) / 60000;
    // Spec §4: show all servers Pending / Waiting for next event immediately.
    state.startupPendingMode = minutesToNext < STARTUP_PENDING_THRESHOLD_MINUTES;
    state.currentEventStart = eventStart;
    ensureServerEntries(state);
    return;
  }

  if (eventStart !== state.currentEventStart) {
    // Rolled into a new tracked window -> reset kill state (spec §4:
    // one qualifying kill possible per server per window).
    state.currentEventStart = eventStart;
    state.startupPendingMode = false;
    state.servers = {};
    ensureServerEntries(state);
    return;
  }

  ensureServerEntries(state);
}

function applyScrapedRows(eventId, rows) {
  const { def, state } = getEvent(eventId);
  if (state.currentEventStart === null) return;
  const { start, end } = eventWindow(state.currentEventStart);
  const trackedIds = new Set(Object.keys(state.servers));
  const monsterFilter = def.monsterFilter ? def.monsterFilter.trim().toLowerCase() : null;

  for (const row of rows) {
    if (!trackedIds.has(row.server)) continue; // untracked or SvC
    if (monsterFilter && String(row.monster).trim().toLowerCase() !== monsterFilter) continue;
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

function recordPollSuccess(eventId, rows, nowUtcMs) {
  syncEventWindow(eventId, nowUtcMs);
  applyScrapedRows(eventId, rows);
  const { state } = getEvent(eventId);
  state.lastPollAt = nowUtcMs;
  state.lastSuccessAt = nowUtcMs;
  state.lastError = null;
}

function recordPollFailure(eventId, err, nowUtcMs) {
  syncEventWindow(eventId, nowUtcMs);
  const { state } = getEvent(eventId);
  state.lastPollAt = nowUtcMs;
  state.lastError = { type: err.type || 'unknown', message: err.message || String(err) };
}

function getSnapshot(eventId, nowUtcMs) {
  const { def, weekMinutes, state } = getEvent(eventId);
  syncEventWindow(eventId, nowUtcMs);
  const eventStart = state.currentEventStart;
  const { end } = eventStart !== null ? eventWindow(eventStart) : { end: null };
  const next = nextEventStart(nowUtcMs, weekMinutes);

  const servers = getTrackedServers().map((s) => {
    const entry = state.servers[s.id] || { status: 'pending', kill: null };
    return { id: s.id, status: entry.status, kill: entry.kill };
  });

  return {
    eventId: def.id,
    eventLabel: def.label,
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

function setPollingEnabled(eventId, enabled) {
  getEvent(eventId).state.pollingEnabled = !!enabled;
}

function isPollingEnabled(eventId) {
  return getEvent(eventId).state.pollingEnabled;
}

module.exports = {
  getEventIds,
  getEventDefs,
  syncEventWindow,
  recordPollSuccess,
  recordPollFailure,
  getSnapshot,
  setPollingEnabled,
  isPollingEnabled,
};
