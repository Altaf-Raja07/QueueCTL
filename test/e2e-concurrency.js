const { spawn, execSync } = require('child_process');
const path = require('path');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');
const { getDb, resetDb } = require('../src/db');

const WORK_COUNT = 30;
const WORKER_COUNT = 3;
const TIMEOUT_MS = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  resetDb();
  getDb().prepare('DELETE FROM jobs').run();

  for (let i = 0; i < WORK_COUNT; i++) {
    execSync(`node "${CLI}" enqueue '{"id":"con${i}","command":"echo ${i}"}' 2>/dev/null`);
  }

  console.error(`Enqueued ${WORK_COUNT} jobs. Spawning ${WORKER_COUNT} separate worker processes...`);

  const workers = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const child = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });
    workers.push(child);
  }

  let allDone = false;
  const deadline = Date.now() + TIMEOUT_MS;

  while (!allDone && Date.now() < deadline) {
    await sleep(300);
    const counts = getDb().prepare("SELECT state, COUNT(*) AS cnt FROM jobs GROUP BY state").all();
    const completed = counts.find(r => r.state === 'completed');
    if (completed && completed.cnt === WORK_COUNT) allDone = true;
  }

  for (const w of workers) {
    try { w.kill('SIGTERM'); } catch (_) {}
  }

  for (const w of workers) {
    await new Promise(r => {
      const t = setTimeout(r, 2000);
      w.on('exit', () => { clearTimeout(t); r(); });
    });
  }

  const rows = getDb().prepare("SELECT id, state, attempts FROM jobs ORDER BY id").all();
  const completed = rows.filter(r => r.state === 'completed');

  if (completed.length !== WORK_COUNT) {
    const byState = {};
    rows.forEach(r => { byState[r.state] = (byState[r.state] || 0) + 1; });
    console.error(`FAIL: ${completed.length}/${WORK_COUNT} completed. States:`, JSON.stringify(byState));
    process.exit(1);
  }

  const dupes = rows.filter(r => r.state === 'completed' && r.attempts > 0);
  if (dupes.length > 0) {
    console.error(`FAIL: ${dupes.length} completed jobs had attempts > 0 (rerun/duplicate):`);
    dupes.forEach(d => console.error(`  ${d.id} attempts=${d.attempts}`));
    process.exit(1);
  }

  console.error(`e2e-concurrency: PASS (${WORK_COUNT} jobs × ${WORKER_COUNT} separate OS processes, exactly-once)`);
}

main().catch(e => { console.error('e2e-concurrency error:', e.message); process.exit(1); });
