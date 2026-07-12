const { spawn, execSync } = require('child_process');
const path = require('path');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');
const { getDb, resetDb } = require('../src/db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  resetDb();
  getDb().prepare('DELETE FROM jobs').run();

  execSync(`node "${CLI}" enqueue '{"id":"retry1","command":"exit 1","max_retries":2}' 2>/dev/null`);

  // Run worker until job is dead
  const worker = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });

  let dead = false;
  const deadline = Date.now() + 20000;
  while (!dead && Date.now() < deadline) {
    await sleep(300);
    const row = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='retry1'").get();
    if (row && row.state === 'dead') {
      dead = true;
    }
  }

  worker.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(r, 2000); worker.on('exit', () => { clearTimeout(t); r(); }); });

  const row = getDb().prepare("SELECT id, state, attempts, max_retries FROM jobs WHERE id='retry1'").get();
  if (!row || row.state !== 'dead') {
    console.error(`FAIL: expected dead, got ${row ? row.state : 'missing'}`);
    process.exit(1);
  }
  if (row.attempts !== row.max_retries) {
    console.error(`FAIL: attempts ${row.attempts} != max_retries ${row.max_retries}`);
    process.exit(1);
  }
  console.error(`e2e-retry-dlq: job reached dead (attempts=${row.attempts}/${row.max_retries})`);

  // --- dlq retry ---
  execSync(`node "${CLI}" dlq retry retry1`);

  const after = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='retry1'").get();
  if (after.state !== 'pending' || after.attempts !== 0) {
    console.error(`FAIL: after dlq retry state=${after.state} attempts=${after.attempts}`);
    process.exit(1);
  }
  console.error('e2e-retry-dlq: dlq retry reset attempts to 0');

  // Run worker again — should retry and reach dead again
  const worker2 = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });

  let dead2 = false;
  const deadline2 = Date.now() + 20000;
  while (!dead2 && Date.now() < deadline2) {
    await sleep(300);
    const r2 = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='retry1'").get();
    if (r2 && r2.state === 'dead') dead2 = true;
  }

  worker2.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(r, 2000); worker2.on('exit', () => { clearTimeout(t); r(); }); });

  const final = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='retry1'").get();
  if (final.state !== 'dead' || final.attempts !== 2) {
    console.error(`FAIL: after retry cycle state=${final.state} attempts=${final.attempts}`);
    process.exit(1);
  }

  console.error(`e2e-retry-dlq: PASS (all retry + dlq cycle verified)`);
}

main().catch(e => { console.error('e2e-retry-dlq error:', e.message); process.exit(1); });
