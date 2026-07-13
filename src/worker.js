const { getDb } = require('./db');
const { getConfig } = require('./config');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const PID_DIR = path.resolve(__dirname, '..', '.queuectl', 'workers');
const PID_FILE = path.join(PID_DIR, `${process.pid}.pid`);

let shuttingDown = false;
let activeLoopsCount = 0;
const sleepTimeouts = new Set();

function startWorker(count = 1) {
  console.error(`Worker started (PID: ${process.pid})`);
  register();
  sweepStaleJobs();
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  activeLoopsCount = count;
  for (let i = 0; i < count; i++) {
    pollLoop();
  }
}

function sweepStaleJobs() {
  const db = getDb();
  const staleTimeout = getConfig('stale_timeout_seconds');
  const cutoff = new Date(Date.now() - staleTimeout * 1000).toISOString();
  const now = new Date().toISOString();

  const recovered = db.prepare(`
    UPDATE jobs
    SET state = 'pending',
        claimed_at = NULL,
        worker_pid = NULL,
        next_attempt_at = NULL,
        updated_at = ?
    WHERE state = 'processing'
      AND claimed_at IS NOT NULL
      AND claimed_at <= ?
    RETURNING id
  `).all(now, cutoff);

  for (const job of recovered) {
    console.error(`Recovered stale job ${job.id}`);
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

  // Wake up/cancel any sleeping loops immediately
  for (const timeoutId of sleepTimeouts) {
    clearTimeout(timeoutId);
    sleepTimeouts.delete(timeoutId);
    process.nextTick(pollLoop);
  }
}

function pollLoop() {
  if (shuttingDown) {
    activeLoopsCount--;
    if (activeLoopsCount <= 0) {
      deregister();
      process.exit(0);
    }
    return;
  }

  sweepStaleJobs();

  const job = claimJob();

  if (!job) {
    console.error(`No pending jobs, polling again in ${getConfig('poll_interval_ms') / 1000}s...`);
    const timeoutId = setTimeout(() => {
      sleepTimeouts.delete(timeoutId);
      pollLoop();
    }, getConfig('poll_interval_ms'));
    sleepTimeouts.add(timeoutId);
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
      WHERE state IN ('pending', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get(now, process.pid, now, now);

  if (row) {
    console.error(`Claimed job ${row.id} - running ${row.command}`);
  }

  return row || null;
}

function runJob(job, done) {
  exec(job.command, { shell: true, timeout: 86400000 }, (err, stdout, stderr) => {
    const db = getDb();
    const now = new Date();
    const updatedAt = now.toISOString();

    if (err === null) {
      console.error(`Job ${job.id} completed successfully`);
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
      console.error(`Job ${job.id} moved to DLQ after ${newAttempts} retries`);
      db.prepare(`
        UPDATE jobs
        SET state = 'dead',
            attempts = ?,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newAttempts, lastError, updatedAt, job.id);
    } else {
      console.error(`Job ${job.id} failed (attempt ${newAttempts}/${job.max_retries}): ${lastError}`);
      const backoffBase = getConfig('backoff_base');
      const delaySec = Math.pow(backoffBase, newAttempts);
      const nextAttemptAt = new Date(now.getTime() + delaySec * 1000).toISOString();

      db.prepare(`
        UPDATE jobs
        SET state = 'failed',
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

function stopWorkers() {
  let signaled = [];
  let pruned = [];

  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
  } catch (_) {}

  for (const entry of fs.readdirSync(PID_DIR)) {
    if (!entry.endsWith('.pid')) continue;
    const pid = parseInt(path.basename(entry, '.pid'), 10);
    const filePath = path.join(PID_DIR, entry);

    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGTERM');
      signaled.push(pid);
    } catch (e) {
      if (e.code === 'ESRCH') {
        fs.unlinkSync(filePath);
        pruned.push(pid);
      }
    }
  }

  return { signaled, pruned };
}

function countActiveWorkers() {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(PID_DIR)) {
      if (!entry.endsWith('.pid')) continue;
      const pid = parseInt(path.basename(entry, '.pid'), 10);
      try {
        process.kill(pid, 0);
        count++;
      } catch (_) {}
    }
  } catch (_) {}
  return count;
}

module.exports = { startWorker, stopWorkers, countActiveWorkers };
