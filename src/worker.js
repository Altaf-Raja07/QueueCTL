const { getDb } = require('./db');
const { getConfig } = require('./config');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const PID_DIR = path.resolve(__dirname, '..', '.queuectl', 'workers');
const PID_FILE = path.join(PID_DIR, `${process.pid}.pid`);

let shuttingDown = false;

function startWorker() {
  register();
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  pollLoop();
}

function register() {
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function deregister() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch (e) {
    // ignore if already gone
  }
}

function handleShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
}

function pollLoop() {
  if (shuttingDown) {
    deregister();
    process.exit(0);
    return;
  }

  const job = claimJob();

  if (!job) {
    setTimeout(pollLoop, getConfig('poll_interval_ms'));
    return;
  }

  runJob(job, () => {
    setTimeout(pollLoop, 0);
  });
}

function claimJob() {
  const db = getDb();
  const now = new Date().toISOString();

  const row = db.prepare(`
    UPDATE jobs
    SET state = 'processing',
        claimed_at = ?,
        worker_pid = ?,
        updated_at = ?
    WHERE id = (
      SELECT id FROM jobs
      WHERE state = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get(now, process.pid, now, now);

  return row || null;
}

function runJob(job, done) {
  const deadline = Date.now() + 1000;

  exec(job.command, { shell: true, timeout: 86400000 }, (err) => {
    const db = getDb();
    const updatedAt = new Date().toISOString();

    if (err === null) {
      db.prepare(`UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?`)
        .run(updatedAt, job.id);
    } else {
      const exitCode = err.code || err.status || 'unknown';
      db.prepare(`
        UPDATE jobs
        SET state = 'failed',
            attempts = attempts + 1,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(`exit code ${exitCode}`, updatedAt, job.id);
    }

    done();
  });
}

module.exports = { startWorker };
