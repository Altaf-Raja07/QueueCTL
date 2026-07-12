const { spawn, execSync } = require('child_process');
const path = require('path');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');
const { getDb, resetDb } = require('../src/db');

const SAFETY_MARGIN_MS = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  resetDb();
  getDb().prepare('DELETE FROM jobs').run();

  execSync(`node "${CLI}" enqueue '{"id":"crash1","command":"sleep 5"}' 2>/dev/null`);

  // Spawn worker
  const worker = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });
  const workerPid = worker.pid;
  console.error(`Worker PID: ${workerPid}`);

  // Wait for it to claim the job
  await sleep(1500);

  const before = getDb().prepare("SELECT state, worker_pid FROM jobs WHERE id='crash1'").get();
  if (!before || before.state !== 'processing') {
    console.error(`FAIL: job not processing (state=${before ? before.state : 'missing'})`);
    worker.kill('SIGTERM');
    process.exit(1);
  }
  console.error(`Job claimed by PID ${before.worker_pid}. Killing worker...`);

  // Kill -9 the worker
  worker.kill('SIGKILL');

  // Start a new worker
  const startTime = Date.now();
  const worker2 = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });

  // Wait for job to complete
  let done = false;
  while (!done && Date.now() - startTime < SAFETY_MARGIN_MS) {
    await sleep(500);
    const row = getDb().prepare("SELECT state FROM jobs WHERE id='crash1'").get();
    if (row && (row.state === 'completed' || row.state === 'dead')) done = true;
  }

  const elapsed = Date.now() - startTime;

  worker2.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(r, 2000); worker2.on('exit', () => { clearTimeout(t); r(); }); });

  const final = getDb().prepare("SELECT id, state, attempts FROM jobs WHERE id='crash1'").get();

  if (!final || final.state !== 'completed') {
    console.error(`FAIL: job state is ${final ? final.state : 'missing'}, expected completed`);
    process.exit(1);
  }

  if (elapsed > SAFETY_MARGIN_MS) {
    console.error(`FAIL: recovery took ${elapsed}ms, exceeds ${SAFETY_MARGIN_MS}ms safety margin`);
    process.exit(1);
  }

  if (final.attempts !== 0) {
    console.error(`FAIL: attempts incremented (${final.attempts}) — stale sweep should NOT increment`);
    process.exit(1);
  }

  console.error(`e2e-crash-recovery: PASS (recovered + completed in ${elapsed}ms, attempts=${final.attempts})`);
}

main().catch(e => { console.error('e2e-crash-recovery error:', e.message); process.exit(1); });
