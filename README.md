# MEGAMU Birthday Boss Death Tracker

A locally-hosted dashboard that tracks whether the "birthday boss" event
monster has been killed on each tracked MEGAMU server during the current
event window, by scraping `en.megamu.net/boss-log`. Built from the v4
spec: single-user, live-state-only, no history.

## Requirements

- Node.js 18+ (uses the built-in `fetch`; developed/tested on Node 22)

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:4173** in your browser. The port can be
changed with the `PORT` environment variable, e.g. `PORT=8080 npm start`.

## What it does

- Polls `https://en.megamu.net/boss-log`, scraping the HTML table
  server-side (no public API exists) and inspects only the most recent
  ~30 rows.
- Matches a kill to a tracked server if the row's `Server` is tracked and
  its `Date` falls inside `[event_start, event_start + 20 min)`, where
  event starts are `00:55, 03:55, 06:55, ..., 21:55` daily at a **fixed
  UTC-3 offset** (no DST logic — see `server/constants.js` if Brazil ever
  reinstates DST).
- Shows all tracked servers as ✅ Killed (with monster/time/player/map) or
  ⏳ Pending. Pending servers never disappear or get marked "failed" —
  they stay pending indefinitely so you can keep watching.
- Polling can be toggled on/off in the UI, and automatically pauses 30
  minutes after each event start (a 10-minute buffer past the 20-minute
  window for late log entries).
- Plays a short chime 5 minutes before each event, as long as the app tab
  is open (foreground or backgrounded).
- Dark-mode-only, Material-style UI.
- The server list (`Sv1–Sv12, Sv14–Sv19` by default, `Sv13` excluded,
  `SvC` never trackable) is configurable from the gear icon in the UI, or
  by editing `config.json` directly and restarting.

## Configuration

- **Server list** — editable at runtime via the settings dialog (⚙️ icon),
  which reads/writes `config.json`. You can also hand-edit that file.
- **Poll interval** — a hardcoded constant, `REFRESH_INTERVAL_MS` in
  `server/constants.js` (default: 30 seconds). Per spec, this is
  intentionally not exposed in the UI; change the constant and restart
  the app to adjust it.
- **Event times / timezone offset / window length** — also in
  `server/constants.js`.

## Project structure

```
server/
  index.js        Express app: API routes + serves public/
  poller.js        Drives the periodic scrape on the hardcoded interval
  scraper.js        Fetches + parses the boss-log HTML table (cheerio)
  state.js          In-memory current-event-window state (no history)
  timeUtils.js       Fixed UTC-3 event-window time math
  config.js          Reads/writes config.json (tracked server list)
  constants.js       All hardcoded, code-level constants
public/
  index.html, app.js, styles.css   Dark-mode Material-style dashboard
config.json           Tracked server list (created on first run if absent)
```

## API (for reference / debugging)

- `GET /api/status` — full current-state snapshot (servers, timing, errors)
- `POST /api/polling` — `{ "enabled": boolean }`
- `POST /api/poll-now` — trigger an immediate scrape
- `GET /api/config` — current server list
- `POST /api/config/servers` — `{ "id": "Sv20" }` to add a server
- `PATCH /api/config/servers/:id` — `{ "enabled": boolean }`
- `DELETE /api/config/servers/:id` — remove a server

## Notes

- I verified the scraper's table-locating logic against the live page's
  actual column layout (`Date, Monster, Player, Server, Map`) while
  building this. I could not do a full live end-to-end run of the
  scraper from my sandboxed environment, since its network egress only
  allows a short allowlist of package-registry domains and
  `en.megamu.net` isn't on it (an environment restriction on my end, not
  a real error from the site). Everything else — the Express server, the
  API, the event-window/timezone math, and the frontend — has been run
  and exercised locally. Worth doing a first real run on your machine to
  confirm the live table markup still matches; the error banner will
  clearly say if it doesn't (see `server/scraper.js`'s `ErrorType.PARSE`).
