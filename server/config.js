// -----------------------------------------------------------------------
// Server list configuration.
//
// Spec §3: the server list is configurable (add/remove/enable/disable)
// via a settings screen or config file — not hardcoded in the UI — since
// MEGAMU opens and closes servers every few weeks.
//
// This module persists that list to config.json next to this file, and
// exposes simple read/write helpers used by the API routes.
// -----------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { EXCLUDED_SERVER } = require('./constants');

// On Railway, config.json must live on the mounted volume (anything
// written elsewhere is wiped on every redeploy) — Railway exposes the
// volume's mount path via RAILWAY_VOLUME_MOUNT_PATH at runtime.
//
// Under pkg (no volume involved), __dirname resolves inside the packaged
// executable's read-only virtual filesystem, so config.json must live
// next to the .exe instead (process.execPath) rather than next to this
// file.
const CONFIG_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'config.json')
  : process.pkg
  ? path.join(path.dirname(process.execPath), 'config.json')
  : path.join(__dirname, '..', 'config.json');

function defaultConfig() {
  const servers = [];
  // Sv1–Sv12, Sv14–Sv19 (Sv13 currently closed/excluded, SvC never tracked).
  for (let i = 1; i <= 19; i++) {
    if (i === 13) continue;
    servers.push({ id: `Sv${i}`, enabled: true });
  }
  return { servers };
}

function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    writeConfigFile(cfg);
    return cfg;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.servers)) throw new Error('config.json missing servers array');
    return parsed;
  } catch (err) {
    console.error(`[config] Failed to read config.json (${err.message}); falling back to defaults.`);
    return defaultConfig();
  }
}

function writeConfigFile(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function getConfig() {
  return readConfigFile();
}

function getTrackedServers() {
  // Servers that are both present in config AND enabled, excluding SvC
  // no matter what (spec §2: SvC is ignored entirely).
  return getConfig().servers.filter((s) => s.enabled && s.id !== EXCLUDED_SERVER);
}

function getAllServers() {
  return getConfig().servers;
}

function addServer(id) {
  const cfg = getConfig();
  const clean = String(id).trim();
  if (!clean) throw new Error('Server id cannot be empty');
  if (clean === EXCLUDED_SERVER) throw new Error(`${EXCLUDED_SERVER} is never tracked`);
  if (cfg.servers.some((s) => s.id === clean)) throw new Error(`${clean} already exists`);
  cfg.servers.push({ id: clean, enabled: true });
  writeConfigFile(cfg);
  return cfg;
}

function removeServer(id) {
  const cfg = getConfig();
  cfg.servers = cfg.servers.filter((s) => s.id !== id);
  writeConfigFile(cfg);
  return cfg;
}

function setServerEnabled(id, enabled) {
  const cfg = getConfig();
  const server = cfg.servers.find((s) => s.id === id);
  if (!server) throw new Error(`${id} not found`);
  server.enabled = !!enabled;
  writeConfigFile(cfg);
  return cfg;
}

module.exports = {
  getConfig,
  getTrackedServers,
  getAllServers,
  addServer,
  removeServer,
  setServerEnabled,
};
