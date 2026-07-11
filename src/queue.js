const { getDb } = require('./db');
const { getConfig } = require('./config');

function listDeadJobs() {
  const db = getDb();
  return db.prepare("SELECT * FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC").all();
}

function retryDeadJob(id) {
  const db = getDb();
  const job = db.prepare("SELECT id, state FROM jobs WHERE id = ? AND state = 'dead'").get(id);
  if (!job) throw new Error(`No dead job with id '${id}'`);

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE jobs
    SET state = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, id);

  return { id, state: 'pending' };
}

function enqueueJob(input) {
  let job;
  try {
    job = JSON.parse(input);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }

  if (!job.id || typeof job.id !== 'string') {
    throw new Error('Missing required field: id must be a non-empty string');
  }
  if (!job.command || typeof job.command !== 'string') {
    throw new Error('Missing required field: command must be a non-empty string');
  }

  const db = getDb();
  const now = new Date().toISOString();
  const maxRetries = job.max_retries != null ? job.max_retries : getConfig('max_retries');

  try {
    db.prepare(`
      INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, ?, ?)
    `).run(job.id, job.command, maxRetries, now, now);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new Error(`Job with id '${job.id}' already exists`);
    }
    throw e;
  }

  return { id: job.id, state: 'pending' };
}

function getStatus() {
  const db = getDb();
  const counts = {};
  for (const row of db.prepare('SELECT state, COUNT(*) AS cnt FROM jobs GROUP BY state').all()) {
    counts[row.state] = row.cnt;
  }
  for (const s of ['pending', 'processing', 'completed', 'failed', 'dead']) {
    if (counts[s] === undefined) counts[s] = 0;
  }
  return counts;
}

function getJobs(state) {
  const db = getDb();
  if (state) {
    return db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC').all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
}

module.exports = { enqueueJob, listDeadJobs, retryDeadJob, getStatus, getJobs };
