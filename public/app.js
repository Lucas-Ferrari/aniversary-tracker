(() => {
  'use strict';

  // How often the *frontend* re-reads local /api/status (independent of
  // the backend's own scrape interval, which is a hardcoded server-side
  // constant per spec §6).
  const UI_POLL_MS = 4000;
  const EVENT_WINDOW_SECONDS = 20 * 60;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in the SVG

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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- Tracker view (one per tracked event: aniversary, medusa, ...) ------
  //
  // Each `.view[data-event-id]` in the DOM gets its own independent
  // instance: its own poll loop against `/api/status?event=<id>`, its own
  // ring/stats/grid rendering, and its own polling toggle + force-fetch
  // button. Adding another event is just another `.view` block in the
  // HTML plus a matching event definition on the server.

  function createTrackerView(root) {
    const eventId = root.dataset.eventId;
    const q = (role) => root.querySelector(`[data-role="${role}"]`);
    const el = {
      errorBanner: q('error-banner'),
      errorBannerText: q('error-banner-text'),
      pollToggle: q('poll-toggle'),
      pollToggleLabel: q('poll-toggle-label'),
      forceFetchBtn: q('force-fetch-btn'),
      ringProgress: q('ring-progress'),
      ringMode: q('ring-mode'),
      ringTime: q('ring-time'),
      statKilled: q('stat-killed'),
      statPending: q('stat-pending'),
      statTotal: q('stat-total'),
      serverGrid: q('server-grid'),
    };

    let notifiedForEventStart = null; // tracks which event's pre-notification already fired

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
        // Show progress toward the next event, scaled to the longest gap
        // between two consecutive slots in a day so both a 3-hour cadence
        // (aniversary) and a multi-day cadence (medusa) look reasonable.
        const cycle = 24 * 60 * 60;
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

    async function fetchStatus() {
      try {
        const res = await fetch(`/api/status?event=${encodeURIComponent(eventId)}`);
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
        const res = await fetch(`/api/polling?event=${encodeURIComponent(eventId)}`, {
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

    async function forceFetch() {
      el.forceFetchBtn.disabled = true;
      el.forceFetchBtn.classList.add('icon-btn--spinning');
      try {
        const res = await fetch(`/api/poll-now?event=${encodeURIComponent(eventId)}`, { method: 'POST' });
        const snapshot = await res.json();
        render(snapshot);
      } catch (err) {
        console.error('Failed to force fetch', err);
      } finally {
        el.forceFetchBtn.disabled = false;
        el.forceFetchBtn.classList.remove('icon-btn--spinning');
      }
    }

    el.pollToggle.addEventListener('click', togglePolling);
    el.forceFetchBtn.addEventListener('click', forceFetch);

    function start() {
      fetchStatus();
      setInterval(fetchStatus, UI_POLL_MS);
    }

    return { start };
  }

  // ---- Settings dialog (shared tracked-server list, applies to every event) --

  const settingsEl = {
    settingsBtn: document.getElementById('settings-btn'),
    settingsOverlay: document.getElementById('settings-overlay'),
    settingsClose: document.getElementById('settings-close'),
    serverConfigList: document.getElementById('server-config-list'),
    addServerForm: document.getElementById('add-server-form'),
    addServerInput: document.getElementById('add-server-input'),
  };

  async function loadConfig() {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    renderConfigList(cfg);
  }

  function renderConfigList(cfg) {
    settingsEl.serverConfigList.innerHTML = cfg.servers
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

    settingsEl.serverConfigList.querySelectorAll('.cfg-enable-toggle').forEach((btn) => {
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
        } catch (err) {
          console.error('Failed to update server', err);
        }
      });
    });

    settingsEl.serverConfigList.querySelectorAll('.cfg-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const li = btn.closest('li');
        const id = li.dataset.id;
        try {
          await fetch(`/api/config/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await loadConfig();
        } catch (err) {
          console.error('Failed to remove server', err);
        }
      });
    });
  }

  function openSettings() {
    settingsEl.settingsOverlay.hidden = false;
    loadConfig();
  }

  function closeSettings() {
    settingsEl.settingsOverlay.hidden = true;
  }

  settingsEl.settingsBtn.addEventListener('click', openSettings);
  settingsEl.settingsClose.addEventListener('click', closeSettings);
  settingsEl.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsEl.settingsOverlay) closeSettings();
  });

  settingsEl.addServerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = settingsEl.addServerInput.value.trim();
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
      settingsEl.addServerInput.value = '';
      await loadConfig();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---- Side navigation -----------------------------------------------------

  function initSideNav() {
    const sideNav = document.getElementById('side-nav');
    const sideNavScrim = document.getElementById('side-nav-scrim');
    const navToggleBtn = document.getElementById('nav-toggle-btn');

    // Collapsible sections (e.g. "Events"), accordion-per-section.
    document.querySelectorAll('.side-nav__section-toggle').forEach((toggle) => {
      const submenu = document.getElementById(toggle.getAttribute('aria-controls'));
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        if (submenu) submenu.hidden = expanded;
      });
    });

    // View switching between tracked events (Aniversary Tracker, Medusa, ...).
    document.querySelectorAll('.side-nav__item[data-view]').forEach((item) => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.side-nav__item').forEach((i) => i.classList.remove('side-nav__item--active'));
        item.classList.add('side-nav__item--active');

        const targetView = item.dataset.view;
        document.querySelectorAll('main .view').forEach((view) => {
          view.hidden = view.id !== `view-${targetView}`;
        });

        closeMobileNav();
      });
    });

    function openMobileNav() {
      sideNav.classList.add('side-nav--open');
      sideNavScrim.hidden = false;
      navToggleBtn.setAttribute('aria-expanded', 'true');
    }

    function closeMobileNav() {
      sideNav.classList.remove('side-nav--open');
      sideNavScrim.hidden = true;
      navToggleBtn.setAttribute('aria-expanded', 'false');
    }

    navToggleBtn.addEventListener('click', () => {
      sideNav.classList.contains('side-nav--open') ? closeMobileNav() : openMobileNav();
    });
    sideNavScrim.addEventListener('click', closeMobileNav);
  }

  // ---- Boot ------------------------------------------------------------------

  initSideNav();
  document.querySelectorAll('main .view[data-event-id]').forEach((root) => {
    createTrackerView(root).start();
  });
})();
