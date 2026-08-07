(() => {
  'use strict';

  // How often the *frontend* re-reads local /api/status (independent of
  // the backend's own scrape interval, which is a hardcoded server-side
  // constant per spec §6).
  const UI_POLL_MS = 4000;
  const EVENT_WINDOW_SECONDS = 20 * 60;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in the SVG

  const el = {
    errorBanner: document.getElementById('error-banner'),
    errorBannerText: document.getElementById('error-banner-text'),
    pollToggle: document.getElementById('poll-toggle'),
    pollToggleLabel: document.getElementById('poll-toggle-label'),
    forceFetchBtn: document.getElementById('force-fetch-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsOverlay: document.getElementById('settings-overlay'),
    settingsClose: document.getElementById('settings-close'),
    serverConfigList: document.getElementById('server-config-list'),
    addServerForm: document.getElementById('add-server-form'),
    addServerInput: document.getElementById('add-server-input'),
    ringProgress: document.getElementById('event-ring-progress'),
    ringMode: document.getElementById('event-panel__mode'),
    ringTime: document.getElementById('event-panel__time'),
    statKilled: document.getElementById('stat-killed'),
    statPending: document.getElementById('stat-pending'),
    statTotal: document.getElementById('stat-total'),
    serverGrid: document.getElementById('server-grid'),
  };

  let notifiedForEventStart = null; // tracks which event's pre-notification already fired

  // ---- Notification chime (Web Audio, no asset needed) ------------------

  function playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      [660, 880, 1100].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = now + i * 0.16;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.45);
      });
    } catch (err) {
      console.warn('Could not play notification chime', err);
    }
  }

  // ---- Formatting helpers -------------------------------------------------

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ---- Rendering ------------------------------------------------------------

  function renderRing(snapshot) {
    const { secondsUntilNextEvent, secondsSinceEventStart, currentEventStart } = snapshot;

    // secondsSinceEventStart can be negative: the backend starts tracking
    // (and shows Pending for) the upcoming window a few minutes before it
    // actually opens, so a negative value means "not started yet".
    const inActiveWindow =
      currentEventStart !== null &&
      secondsSinceEventStart !== null &&
      secondsSinceEventStart >= 0 &&
      secondsSinceEventStart < EVENT_WINDOW_SECONDS;

    if (inActiveWindow) {
      el.ringMode.textContent = 'Window closes in';
      const remaining = EVENT_WINDOW_SECONDS - secondsSinceEventStart;
      el.ringTime.textContent = formatClock(remaining);
      const frac = remaining / EVENT_WINDOW_SECONDS;
      el.ringProgress.style.stroke = 'var(--emerald)';
      el.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - frac));
    } else {
      el.ringMode.textContent = 'Next event in';
      el.ringTime.textContent = formatClock(secondsUntilNextEvent);
      // 3-hour cadence between events; show progress toward it.
      const cycle = 3 * 60 * 60;
      const frac = Math.min(1, Math.max(0, (cycle - secondsUntilNextEvent) / cycle));
      el.ringProgress.style.stroke = 'var(--gold)';
      el.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - frac));
    }

    // Pre-event notification (spec §7): fire once per event, 5 min out.
    const PRE_EVENT_NOTIFY_SECONDS = 5 * 60;
    if (
      secondsUntilNextEvent <= PRE_EVENT_NOTIFY_SECONDS &&
      secondsUntilNextEvent > 0 &&
      notifiedForEventStart !== snapshot.nextEventStart
    ) {
      notifiedForEventStart = snapshot.nextEventStart;
      playChime();
    }
  }

  function killDetailMarkup(kill) {
    if (!kill) return '';
    return `
      <dl>
        <dt>Monster</dt><dd class="kill-monster">${escapeHtml(kill.monster)}</dd>
        <dt>Player</dt><dd>${escapeHtml(kill.player)}</dd>
        <dt>Map</dt><dd>${escapeHtml(kill.map)}</dd>
        <dt>Time</dt><dd>${escapeHtml(kill.time)}</dd>
      </dl>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderServers(snapshot) {
    const { servers, startupPendingMode } = snapshot;

    el.statTotal.textContent = String(servers.length);
    const killedCount = servers.filter((s) => s.status === 'killed').length;
    el.statKilled.textContent = String(killedCount);
    el.statPending.textContent = String(servers.length - killedCount);

    if (servers.length === 0) {
      el.serverGrid.innerHTML = `<div class="empty-state">No servers are currently tracked. Open settings to add one.</div>`;
      return;
    }

    el.serverGrid.innerHTML = servers
      .map((s) => {
        const killed = s.status === 'killed';
        return `
          <div class="server-card ${killed ? 'server-card--killed' : 'server-card--pending'}">
            <div class="server-card__top">
              <span class="server-card__id">${escapeHtml(s.id)}</span>
              <span class="status-pill ${killed ? 'status-pill--killed' : 'status-pill--pending'}">
                <span class="material-symbols-rounded" aria-hidden="true">${killed ? 'check_circle' : 'hourglass_empty'}</span>
                ${killed ? 'Killed' : 'Pending'}
              </span>
            </div>
            <div class="server-card__body">
              ${
                killed
                  ? killDetailMarkup(s.kill)
                  : `<span class="server-card__waiting">${startupPendingMode ? 'Waiting for next event…' : 'No kill registered yet this window.'}</span>`
              }
            </div>
          </div>`;
      })
      .join('');
  }

  function renderError(snapshot) {
    if (!snapshot.lastError) {
      el.errorBanner.hidden = true;
      return;
    }
    const { type, message } = snapshot.lastError;
    const prefix = type === 'parse' ? 'Boss log page structure changed' : 'Boss log source unreachable';
    el.errorBannerText.textContent = `${prefix} — ${message}`;
    el.errorBanner.hidden = false;
  }

  function renderPollToggle(snapshot) {
    el.pollToggle.setAttribute('aria-checked', String(snapshot.pollingEnabled));
    el.pollToggleLabel.textContent = snapshot.pollingEnabled ? 'Polling on' : 'Polling off';
  }

  function render(snapshot) {
    renderError(snapshot);
    renderPollToggle(snapshot);
    renderRing(snapshot);
    renderServers(snapshot);
  }

  // ---- Data fetching -----------------------------------------------------

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const snapshot = await res.json();
      render(snapshot);
    } catch (err) {
      // The local backend itself is unreachable (different from the
      // upstream-scrape error surfaced inside a normal snapshot).
      el.errorBannerText.textContent = 'Cannot reach the local tracker backend. Is the server running?';
      el.errorBanner.hidden = false;
      console.error(err);
    }
  }

  async function togglePolling() {
    const currentlyOn = el.pollToggle.getAttribute('aria-checked') === 'true';
    el.pollToggle.setAttribute('aria-checked', String(!currentlyOn));
    try {
      const res = await fetch('/api/polling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentlyOn }),
      });
      const snapshot = await res.json();
      render(snapshot);
    } catch (err) {
      console.error('Failed to toggle polling', err);
    }
  }

  // ---- Force fetch ----------------------------------------------------------

  async function forceFetch() {
    el.forceFetchBtn.disabled = true;
    el.forceFetchBtn.classList.add('icon-btn--spinning');
    try {
      const res = await fetch('/api/poll-now', { method: 'POST' });
      const snapshot = await res.json();
      render(snapshot);
    } catch (err) {
      console.error('Failed to force fetch', err);
    } finally {
      el.forceFetchBtn.disabled = false;
      el.forceFetchBtn.classList.remove('icon-btn--spinning');
    }
  }

  // ---- Settings dialog -----------------------------------------------------

  async function loadConfig() {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    renderConfigList(cfg);
  }

  function renderConfigList(cfg) {
    el.serverConfigList.innerHTML = cfg.servers
      .map(
        (s) => `
        <li data-id="${escapeHtml(s.id)}">
          <span class="server-config-list__id">${escapeHtml(s.id)}</span>
          <span class="server-config-list__actions">
            <button class="switch cfg-enable-toggle" role="switch" aria-checked="${s.enabled}" aria-label="Toggle ${escapeHtml(s.id)}">
              <span class="switch__thumb"></span>
            </button>
            <button class="icon-btn icon-btn--danger cfg-remove" aria-label="Remove ${escapeHtml(s.id)}" title="Remove">
              <span class="material-symbols-rounded" aria-hidden="true">delete</span>
            </button>
          </span>
        </li>`
      )
      .join('');

    el.serverConfigList.querySelectorAll('.cfg-enable-toggle').forEach((btn) => {
      // Style the settings-dialog switches with the same on-state as the header one.
      if (btn.getAttribute('aria-checked') === 'true') btn.style.background = 'var(--gold-dim)';
      btn.addEventListener('click', async () => {
        const li = btn.closest('li');
        const id = li.dataset.id;
        const nowChecked = btn.getAttribute('aria-checked') !== 'true';
        try {
          await fetch(`/api/config/servers/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nowChecked }),
          });
          await loadConfig();
          await fetchStatus();
        } catch (err) {
          console.error('Failed to update server', err);
        }
      });
    });

    el.serverConfigList.querySelectorAll('.cfg-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const li = btn.closest('li');
        const id = li.dataset.id;
        try {
          await fetch(`/api/config/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await loadConfig();
          await fetchStatus();
        } catch (err) {
          console.error('Failed to remove server', err);
        }
      });
    });
  }

  function openSettings() {
    el.settingsOverlay.hidden = false;
    loadConfig();
  }

  function closeSettings() {
    el.settingsOverlay.hidden = true;
  }

  // ---- Wire up events -----------------------------------------------------

  el.pollToggle.addEventListener('click', togglePolling);
  el.forceFetchBtn.addEventListener('click', forceFetch);
  el.settingsBtn.addEventListener('click', openSettings);
  el.settingsClose.addEventListener('click', closeSettings);
  el.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === el.settingsOverlay) closeSettings();
  });

  el.addServerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = el.addServerInput.value.trim();
    if (!id) return;
    try {
      const res = await fetch('/api/config/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to add server');
      }
      el.addServerInput.value = '';
      await loadConfig();
      await fetchStatus();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---- Boot ------------------------------------------------------------------

  fetchStatus();
  setInterval(fetchStatus, UI_POLL_MS);
})();
