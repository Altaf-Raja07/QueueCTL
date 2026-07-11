const { spawn, execSync } = require('child_process');
const path = require('path');
const { getDb } = require('../src/db');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');
const WORK_COUNT = 30;
const WORKER_COUNT = 3;
const TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  getDb().prepare('DELETE FROM jobs').run();

  for (let i = 0; i < WORK_COUNT; i++) {
    execSync(`node "${CLI}" enqueue '{"id":"con${i}","command":"echo ${i}"}' 2>/dev/null`);
  }

  console.error(`Enqueued ${WORK_COUNT} jobs. Spawning ${WORKER_COUNT} separate worker processes...`);

  const workers = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const child = spawn('node', [CLI, 'worker', 'start', '--count', '1'], {
      stdio: 'ignore',
    });
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
      const timer = setTimeout(() => r(), 2000);
      w.on('exit', () => { clearTimeout(timer); r(); });
    });
  }

  const rows = getDb().prepare("SELECT id, state, attempts, worker_pid FROM jobs ORDER BY id").all();
  const counts = {};
  for (const r of rows) {
    counts[r.state] = (counts[r.state] || 0) + 1;
  }

  console.error('Final state counts:', JSON.stringify(counts));

  const completed = rows.filter(r => r.state === 'completed');
  const failed = rows.filter(r => r.state !== 'completed');

  let failedAssert = false;

  if (completed.length !== WORK_COUNT) {
    console.error(`FAIL: Expected ${WORK_COUNT} completed, got ${completed.length}`);
    if (failed.length > 0) {
      console.error(`  Non-completed:`, failed.map(r => `${r.id}=${r.state}`).join(', '));
    }
    failedAssert = true;
  }

  const dupes = rows.filter(r => r.state === 'completed' && r.attempts > 0);
  if (dupes.length > 0) {
    console.error(`FAIL: ${dupes.length} completed jobs had attempts > 0 (means they were retried/rerun):`);
    dupes.forEach(d => console.error(`  ${d.id} attempts=${d.attempts}`));
    failedAssert = true;
  }

  if (failedAssert) {
    process.exit(1);
  }

  console.error(`PASS: All ${WORK_COUNT} jobs completed exactly once across ${WORKER_COUNT} separate OS processes`);
}

main().catch(e => { console.error('Test error:', e); process.exit(1); });
