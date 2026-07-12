const { spawn, execSync } = require('child_process');
const path = require('path');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');
const { getDb, resetDb } = require('../src/db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  resetDb();
  getDb().prepare('DELETE FROM jobs').run();

  // Enqueue a job
  execSync(`node "${CLI}" enqueue '{"id":"restart1","command":"echo survived"}' 2>/dev/null`);

  // Simulate "restart" by resetting DB connection and re-getting it
  // (in a real process restart, the DB file persists on disk)
  resetDb();
  const db2 = getDb();

  const before = db2.prepare("SELECT id, state FROM jobs WHERE id='restart1'").get();
  if (!before || before.state !== 'pending') {
    console.error(`FAIL: job not found after simulated restart (state=${before ? before.state : 'missing'})`);
    process.exit(1);
  }
  console.error(`e2e-restart: job persisted across restart (state=${before.state})`);

  // Now actually process it with a real worker
  const worker = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });

  let completed = false;
  const deadline = Date.now() + 10000;
  while (!completed && Date.now() < deadline) {
    await sleep(300);
    const row = getDb().prepare("SELECT state FROM jobs WHERE id='restart1'").get();
    if (row && row.state === 'completed') completed = true;
  }

  worker.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(r, 2000); worker.on('exit', () => { clearTimeout(t); r(); }); });

  const final = getDb().prepare("SELECT id, state FROM jobs WHERE id='restart1'").get();
  if (!final || final.state !== 'completed') {
    console.error(`FAIL: job not completed after restart+worker (state=${final ? final.state : 'missing'})`);
    process.exit(1);
  }

  console.error('e2e-restart: PASS (job survived restart and completed)');
}

main().catch(e => { console.error('e2e-restart error:', e.message); process.exit(1); });
