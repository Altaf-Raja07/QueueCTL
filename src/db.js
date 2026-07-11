const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.resolve(__dirname, '..', '.queuectl');
const DB_PATH = path.join(DB_DIR, 'queuectl.db');

let db = null;

function getDb() {
  if (db) return db;

  fs.mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id             TEXT PRIMARY KEY,
      command        TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending','processing','completed','failed','dead')),
      attempts       INTEGER NOT NULL DEFAULT 0,
      max_retries    INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT,
      claimed_at     TEXT,
      worker_pid     INTEGER,
      last_error     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

module.exports = { getDb };
