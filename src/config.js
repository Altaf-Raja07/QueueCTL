const { getDb } = require('./db');

const DEFAULTS = {
  max_retries: 3,
  backoff_base: 2,
  stale_timeout_seconds: 15,
  poll_interval_ms: 2000,
};

function getConfig(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(normKey(key));
  if (row) return coerce(key, row.value);
  return DEFAULTS[normKey(key)];
}

function setConfig(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(normKey(key), String(value));
}

function getAllConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM config').all();
  const merged = { ...DEFAULTS };
  for (const row of rows) {
    merged[normKey(row.key)] = coerce(row.key, row.value);
  }
  return merged;
}

function normKey(key) {
  return key.replace(/-/g, '_');
}

function coerce(key, value) {
  const normalized = normKey(key);
  if (typeof DEFAULTS[normalized] === 'number') return Number(value);
  return value;
}

module.exports = { getConfig, setConfig, getAllConfig };
