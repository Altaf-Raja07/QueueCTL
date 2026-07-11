const { getDb } = require('./db');
const { getConfig } = require('./config');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const PID_DIR = path.resolve(__dirname, '..', '.queuectl', 'workers');
const PID_FILE = path.join(PID_DIR, `${process.pid}.pid`);

let shuttingDown = false;

function startWorker(count = 1) {
  register();
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  for (let i = 0; i < count; i++) {
    pollLoop();
  }
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
  exec(job.command, { shell: true, timeout: 86400000 }, (err, stdout, stderr) => {
    const db = getDb();
    const now = new Date();
    const updatedAt = now.toISOString();

    if (err === null) {
      db.prepare(`UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?`)
        .run(updatedAt, job.id);
      done();
      return;
    }

    const exitCode = err.code || err.status || 'unknown';
    const stderrTrunc = (stderr || '').toString().slice(0, 200);
    const lastError = `exit code ${exitCode}${stderrTrunc ? ': ' + stderrTrunc : ''}`;

    const newAttempts = job.attempts + 1;

    if (newAttempts >= job.max_retries) {
      db.prepare(`
        UPDATE jobs
        SET state = 'dead',
            attempts = ?,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newAttempts, lastError, updatedAt, job.id);
    } else {
      const backoffBase = getConfig('backoff_base');
      const delaySec = Math.pow(backoffBase, newAttempts);
      const nextAttemptAt = new Date(now.getTime() + delaySec * 1000).toISOString();

      db.prepare(`
        UPDATE jobs
        SET state = 'pending',
            attempts = ?,
            next_attempt_at = ?,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newAttempts, nextAttemptAt, lastError, updatedAt, job.id);
    }

    done();
  });
}

module.exports = { startWorker };
