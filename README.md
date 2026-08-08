# MEGAMU Birthday Boss Death Tracker

A locally-hosted dashboard that tracks whether a boss event has been
killed on each tracked MEGAMU server during the current event window, by
scraping `en.megamu.net/boss-log`. Built from the v4 spec: single-user,
live-state-only, no history.

Multiple independent event trackers are supported from the side nav
under **Events**:

- **Aniversary Tracker** — fires daily at `00:55, 03:55, ..., 21:55`
  (UTC-3). Any monster kill logged for a tracked server inside the
  20-minute window counts.
- **Medusa** — fires weekly, Tuesday 21:00, Friday 21:00, Saturday
  16:00, and Sunday 18:00 (UTC-3). Only a kill whose monster name is
  `Medusa` counts — any other monster kill in the same window is
  ignored.

Each tracker has its own live board, polling toggle, and force-fetch
button, but they share the same tracked-server list (config.json) and
the same underlying boss-log scrape.

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
  ~30 rows. One scrape's rows are applied to every tracked event.
- For each event, matches a kill to a tracked server if the row's
  `Server` is tracked, its `Date` falls inside
  `[event_start, event_start + 20 min)`, and — for events with a monster
  filter (e.g. Medusa) — its `Monster` matches (case-insensitively).
  Event starts are computed at a **fixed UTC-3 offset** (no DST logic —
  see `server/constants.js` if Brazil ever reinstates DST) from each
  event's own weekly schedule (a daily cadence is just the same time
  repeated on every day of the week).
- Shows all tracked servers as ✅ Killed (with monster/time/player/map) or
  ⏳ Pending. Pending servers never disappear or get marked "failed" —
  they stay pending indefinitely so you can keep watching.
- Polling can be toggled on/off per event in the UI, and automatically
  pauses 30 minutes after that event's window start (a 10-minute buffer
  past the 20-minute window for late log entries).
- Plays a short chime 5 minutes before each event, as long as the app tab
  is open (foreground or backgrounded).
- Dark-mode-only, Material-style UI with a side nav for switching between
  tracked events (Events → Aniversary Tracker / Medusa).
- The server list (`Sv1–Sv12, Sv14–Sv19` by default, `Sv13` excluded,
  `SvC` never trackable) is shared across all events and configurable
  from the gear icon in the UI, or by editing `config.json` directly and
  restarting.

## Configuration

- **Server list** — editable at runtime via the settings dialog (⚙️ icon),
  which reads/writes `config.json`. You can also hand-edit that file.
  Shared by every tracked event.
- **Poll interval** — a hardcoded constant, `REFRESH_INTERVAL_MS` in
  `server/constants.js` (default: 5 seconds). Per spec, this is
  intentionally not exposed in the UI; change the constant and restart
  the app to adjust it.
- **Events** — the `EVENTS` array in `server/constants.js`: each entry is
  `{ id, label, schedule, monsterFilter }`, where `schedule` is a list of
  `{ day, time }` slots (`day`: 0=Sunday..6=Saturday, `time`: `"HH:mm"`
  local UTC-3) and `monsterFilter` is either `null` (any monster kill in
  the window counts) or a monster name string (only a matching kill
  counts). Adding a new tracked event means adding an entry here plus a
  matching `.view` block in `public/index.html`.
- **Timezone offset / window length** — also in `server/constants.js`.

## Project structure

```
server/
  index.js        Express app: API routes + serves public/
  poller.js        Drives the periodic scrape on the hardcoded interval
  scraper.js        Fetches + parses the boss-log HTML table (cheerio)
  state.js          In-memory per-event current-event-window state (no history)
  timeUtils.js       Fixed UTC-3 weekly event-window time math
  config.js          Reads/writes config.json (shared tracked server list)
  constants.js       All hardcoded, code-level constants, incl. EVENTS
public/
  index.html, app.js, styles.css   Dark-mode Material-style dashboard,
                                    one tracker view per event + side nav
config.json           Tracked server list (created on first run if absent)
```

## API (for reference / debugging)

Status/polling/poll-now routes take an `?event=<id>` query param
(`aniversary` or `medusa`; defaults to `aniversary` if omitted).

- `GET /api/events` — list of tracked events (`[{ id, label }]`)
- `GET /api/status?event=<id>` — full current-state snapshot for that
  event (servers, timing, errors)
- `POST /api/polling?event=<id>` — `{ "enabled": boolean }`
- `POST /api/poll-now?event=<id>` — trigger an immediate scrape, applied
  to that event only
- `GET /api/config` — current server list (shared across events)
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
