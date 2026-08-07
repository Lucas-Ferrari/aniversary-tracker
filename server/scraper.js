// -----------------------------------------------------------------------
// Scrapes https://en.megamu.net/boss-log (spec §5).
//
// No public API exists, so this does a plain HTTP GET of the HTML page
// and parses the table with cheerio. The parser locates the table
// generically (by matching header text) rather than hardcoding a CSS
// class, so a minor markup tweak on the site doesn't silently break
// everything — but a genuine structural change is still reported as a
// distinct error type per spec §5.
// -----------------------------------------------------------------------

const cheerio = require('cheerio');
const { BOSS_LOG_URL, ROWS_TO_INSPECT } = require('./constants');

const EXPECTED_HEADERS = ['date', 'monster', 'player', 'server', 'map'];

// Error "type" values the rest of the app can branch on.
const ErrorType = {
  NETWORK: 'network', // unreachable / HTTP error / timeout
  PARSE: 'parse', // page loaded but table structure didn't match
};

async function fetchBossLogHtml() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(BOSS_LOG_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MegamuBossTracker/1.0)' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.type = ErrorType.NETWORK;
      throw err;
    }
    return await res.text();
  } catch (err) {
    if (err.type) throw err;
    err.type = ErrorType.NETWORK;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Finds the boss-log table by locating a header row whose cell text
// matches our expected columns (order-independent), then returns the
// cheerio table element plus a column-name -> index map.
function locateTable($) {
  let found = null;
  $('table').each((_, table) => {
    if (found) return;
    const headerCells = $(table).find('tr').first().find('th, td');
    const headerText = headerCells
      .map((__, cell) => $(cell).text().trim().toLowerCase())
      .get();
    const hasAll = EXPECTED_HEADERS.every((h) => headerText.includes(h));
    if (hasAll) {
      const colIndex = {};
      headerText.forEach((text, idx) => {
        if (EXPECTED_HEADERS.includes(text)) colIndex[text] = idx;
      });
      found = { table, colIndex };
    }
  });
  return found;
}

function parseRows($, table, colIndex) {
  const rows = [];
  const trs = $(table).find('tr').slice(1); // skip header row
  trs.each((i, tr) => {
    if (rows.length >= ROWS_TO_INSPECT) return false;
    const cells = $(tr).find('td');
    if (cells.length === 0) return; // skip stray header/empty rows
    const get = (col) => $(cells.get(colIndex[col])).text().trim();
    rows.push({
      date: get('date'),
      monster: get('monster'),
      player: get('player'),
      server: get('server'),
      map: get('map'),
    });
  });
  return rows;
}

// Returns { rows } on success, or throws an Error with `.type` set to
// ErrorType.NETWORK or ErrorType.PARSE.
async function scrapeBossLog() {
  const html = await fetchBossLogHtml();
  const $ = cheerio.load(html);
  const located = locateTable($);
  if (!located) {
    const err = new Error('Boss log table not found or column headers changed');
    err.type = ErrorType.PARSE;
    throw err;
  }
  const rows = parseRows($, located.table, located.colIndex);
  return { rows };
}

module.exports = { scrapeBossLog, ErrorType };
