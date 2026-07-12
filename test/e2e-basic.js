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
  execSync(`node "${CLI}" enqueue "echo simple syntax" --id basic2 --retries 5 2>/dev/null`);

  const worker = spawn('node', [CLI, 'worker', 'start', '--count', '1'], { stdio: 'ignore' });

  let completed = false;
  const deadline = Date.now() + 15000;
  while (!completed && Date.now() < deadline) {
    await sleep(300);
    const row1 = getDb().prepare("SELECT state FROM jobs WHERE id='basic1'").get();
    const row2 = getDb().prepare("SELECT state FROM jobs WHERE id='basic2'").get();
    if (row1 && row1.state === 'completed' && row2 && row2.state === 'completed') {
      completed = true;
    }
  }

  worker.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(r, 2000); worker.on('exit', () => { clearTimeout(t); r(); }); });

  const row1 = getDb().prepare("SELECT id, state, attempts FROM jobs WHERE id='basic1'").get();
  const row2 = getDb().prepare("SELECT id, state, attempts, max_retries FROM jobs WHERE id='basic2'").get();

  if (!row1 || row1.state !== 'completed') {
    console.error(`FAIL: basic1 state is ${row1 ? row1.state : 'missing'}, expected completed`);
    process.exit(1);
  }
  if (!row2 || row2.state !== 'completed') {
    console.error(`FAIL: basic2 state is ${row2 ? row2.state : 'missing'}, expected completed`);
    process.exit(1);
  }
  if (row2.max_retries !== 5) {
    console.error(`FAIL: basic2 max_retries is ${row2.max_retries}, expected 5`);
    process.exit(1);
  }

  console.error(`e2e-basic: PASS (both basic1 and basic2 completed, attempts=${row1.attempts})`);
}

main().catch(e => { console.error('e2e-basic error:', e.message); process.exit(1); });
