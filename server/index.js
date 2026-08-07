const express = require('express');
const path = require('path');

const poller = require('./poller');
const state = require('./state');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Status -------------------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json(state.getSnapshot(Date.now()));
});

app.post('/api/polling', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'body must be { "enabled": boolean }' });
  }
  state.setPollingEnabled(enabled);
  res.json(state.getSnapshot(Date.now()));
});

// Manual "force fetch" — always hits the source, regardless of the
// polling toggle or the auto-stop window.
app.post('/api/poll-now', async (req, res) => {
  await poller.forceTick();
  res.json(state.getSnapshot(Date.now()));
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
