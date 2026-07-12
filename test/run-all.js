const { execSync } = require('child_process');
const path = require('path');

const TESTS = [
  'unit-queue.js',
  'e2e-basic.js',
  'e2e-retry-dlq.js',
  'e2e-concurrency.js',
  'e2e-crash-recovery.js',
  'e2e-restart.js',
];

let passed = 0;
let failed = 0;

for (const file of TESTS) {
  const filePath = path.resolve(__dirname, file);
  process.stdout.write(`${file} ... `);
  try {
    execSync(`node "${filePath}"`, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    console.log('PASS');
    passed++;
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString().trim().split('\n').pop() : e.message;
    console.log(`FAIL (${msg})`);
    failed++;
  }
}

console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
