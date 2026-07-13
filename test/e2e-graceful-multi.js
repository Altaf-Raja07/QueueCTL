const { spawn, execSync } = require('child_process');
const path = require('path');
const { getDb, resetDb } = require('../src/db');

const CLI = path.resolve(__dirname, '..', 'bin', 'queuectl.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  resetDb();
  getDb().prepare('DELETE FROM jobs').run();

  // Enqueue two jobs that take 3 seconds each
  execSync(`node "${CLI}" enqueue '{"id":"long1","command":"sleep 3"}' 2>/dev/null`);
  execSync(`node "${CLI}" enqueue '{"id":"long2","command":"sleep 3"}' 2>/dev/null`);

  console.error("Spawning worker process with --count 2...");
  const worker = spawn('node', [CLI, 'worker', 'start', '--count', '2'], { stdio: 'ignore' });
  const workerPid = worker.pid;

  // Wait for both to be claimed
  await sleep(1000);

  const states = getDb().prepare("SELECT state FROM jobs").all();
  console.error(`Initial states: ${JSON.stringify(states)}`);
  
  const processingCount = states.filter(s => s.state === 'processing').length;
  if (processingCount !== 2) {
    console.error(`FAIL: Expected 2 jobs in processing, got ${processingCount}`);
    worker.kill('SIGKILL');
    process.exit(1);
  }

  console.error(`Sending SIGTERM to worker PID ${workerPid}...`);
  const signalTime = Date.now();
  worker.kill('SIGTERM');

  // Verify worker does not exit immediately (should take at least 1-2 more seconds to finish sleep 3)
  let workerExited = false;
  worker.on('exit', () => {
    workerExited = true;
  });

  await sleep(1000);
  if (workerExited) {
    console.error("FAIL: Worker process exited too early, did not wait for jobs to finish gracefully");
    process.exit(1);
  }

  // Wait for process to exit naturally
  const deadline = Date.now() + 6000;
  while (!workerExited && Date.now() < deadline) {
    await sleep(200);
  }

  if (!workerExited) {
    console.error("FAIL: Worker process did not exit within deadline after finishing jobs");
    worker.kill('SIGKILL');
    process.exit(1);
  }

  const elapsed = Date.now() - signalTime;
  console.error(`Worker exited gracefully in ${elapsed}ms`);

  const finalStates = getDb().prepare("SELECT id, state FROM jobs").all();
  console.error(`Final states: ${JSON.stringify(finalStates)}`);

  const completedCount = finalStates.filter(s => s.state === 'completed').length;
  if (completedCount !== 2) {
    console.error(`FAIL: Expected both jobs to be completed gracefully, got ${completedCount}`);
    process.exit(1);
  }

  console.error("e2e-graceful-multi: PASS");
}

main().catch(e => {
  console.error('e2e-graceful-multi error:', e.message);
  process.exit(1);
});
