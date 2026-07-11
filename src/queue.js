const { getDb } = require('./db');
const { getConfig } = require('./config');

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

module.exports = { enqueueJob };
