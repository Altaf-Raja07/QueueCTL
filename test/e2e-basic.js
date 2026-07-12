const { spawn, execSync } = require('child_process');
const path = require('path');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');
const { getDb } = require('../src/db');
const { resetDb } = require('../src/db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  resetDb();
  getDb().prepare('DELETE FROM jobs').run();

  execSync(`node "${CLI}" enqueue '{"id":"basic1","command":"echo hello world"}' 2>/dev/null`);

  const worker = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });

  let completed = false;
  const deadline = Date.now() + 15000;
  while (!completed && Date.now() < deadline) {
    await sleep(300);
    const row = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='basic1'").get();
    if (row && row.state === 'completed') {
      completed = true;
    }
  }

  worker.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(r, 2000); worker.on('exit', () => { clearTimeout(t); r(); }); });

  const row = getDb().prepare("SELECT id, state, attempts FROM jobs WHERE id='basic1'").get();

  if (!row || row.state !== 'completed') {
    console.error(`FAIL: job state is ${row ? row.state : 'missing'}, expected completed`);
    process.exit(1);
  }
  if (row.attempts !== 0) {
    console.error(`FAIL: job attempts is ${row.attempts}, expected 0`);
    process.exit(1);
  }

  console.error(`e2e-basic: PASS (${row.id} completed, attempts=${row.attempts})`);
}

main().catch(e => { console.error('e2e-basic error:', e.message); process.exit(1); });
