const express = require('express');
const path = require('path');

const poller = require('./poller');
const state = require('./state');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Events ---------------------------------------------------------------

// Discovery endpoint so the frontend doesn't need to hardcode which
// events exist (aniversary, medusa, ...) or their display labels.
app.get('/api/events', (req, res) => {
  res.json(state.getEventDefs());
});

// Resolves the `?event=` query param used by the status/polling/poll-now
// routes below, defaulting to "aniversary" for backward compatibility.
// Responds with 404 and returns null if the event id is unknown.
function resolveEventId(req, res) {
  const eventId = req.query.event || 'aniversary';
  if (!state.getEventIds().includes(eventId)) {
    res.status(404).json({ error: `Unknown event "${eventId}"` });
    return null;
  }
  return eventId;
}

// ---- Status -------------------------------------------------------------

app.get('/api/status', (req, res) => {
  const eventId = resolveEventId(req, res);
  if (eventId === null) return;
  res.json(state.getSnapshot(eventId, Date.now()));
});

app.post('/api/polling', (req, res) => {
  const eventId = resolveEventId(req, res);
  if (eventId === null) return;
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'body must be { "enabled": boolean }' });
  }
  state.setPollingEnabled(eventId, enabled);
  res.json(state.getSnapshot(eventId, Date.now()));
});

// Manual "force fetch" — always hits the source, regardless of the
// polling toggle or the auto-stop window.
app.post('/api/poll-now', async (req, res) => {
  const eventId = resolveEventId(req, res);
  if (eventId === null) return;
  await poller.forceTick([eventId]);
  res.json(state.getSnapshot(eventId, Date.now()));
});

// ---- Config (server list) ------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json(config.getConfig());
});

app.post('/api/config/servers', (req, res) => {
  try {
    const { id } = req.body || {};
    const cfg = config.addServer(id);
    res.json(cfg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/config/servers/:id', (req, res) => {
  const cfg = config.removeServer(req.params.id);
  res.json(cfg);
});

app.patch('/api/config/servers/:id', (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'body must be { "enabled": boolean }' });
    }
    const cfg = config.setServerEnabled(req.params.id, enabled);
    res.json(cfg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MEGAMU Birthday Boss Death Tracker running at http://localhost:${PORT}`);
  poller.start();
});
