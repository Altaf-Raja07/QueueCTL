const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-unit-'));
process.env.QUEUECTL_DB_DIR = TEST_DIR;

const { getDb, resetDb } = require('../src/db');
const { enqueueJob, listDeadJobs, retryDeadJob } = require('../src/queue');
const { getConfig, setConfig } = require('../src/config');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', msg);
  }
}

// --- test: enqueue valid job ---
resetDb();
delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/queue')];
delete require.cache[require.resolve('../src/config')];

const r = enqueueJob('{"id":"u1","command":"echo hi"}');
assert(r.id === 'u1', 'enqueue returns id');
assert(r.state === 'pending', 'enqueue returns pending');

const row = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='u1'").get();
assert(row.state === 'pending', 'db state is pending');
assert(row.attempts === 0, 'db attempts is 0');

// --- test: enqueue duplicate id ---
let threw = false;
try {
  enqueueJob('{"id":"u1","command":"echo again"}');
} catch (e) {
  threw = true;
  assert(e.message.includes('already exists'), 'duplicate id error message');
}
assert(threw, 'duplicate id throws');

// --- test: enqueue missing id ---
threw = false;
try {
  enqueueJob('{"command":"echo no id"}');
} catch (e) {
  threw = true;
  assert(e.message.includes('id'), 'missing id error');
}
assert(threw, 'missing id throws');

// --- test: enqueue missing command ---
threw = false;
try {
  enqueueJob('{"id":"no-cmd"}');
} catch (e) {
  threw = true;
  assert(e.message.includes('command'), 'missing command error');
}
assert(threw, 'missing command throws');

// --- test: enqueue malformed JSON ---
threw = false;
try {
  enqueueJob('not json');
} catch (e) {
  threw = true;
  assert(e.message.includes('Invalid JSON'), 'malformed JSON error');
}
assert(threw, 'malformed JSON throws');

// --- test: enqueue with custom max_retries ---
enqueueJob('{"id":"u2","command":"echo bye","max_retries":7}');
const r2 = getDb().prepare("SELECT max_retries FROM jobs WHERE id='u2'").get();
assert(r2.max_retries === 7, 'custom max_retries stored');

// --- test: enqueue uses config default for max_retries ---
setConfig('max_retries', 5);
enqueueJob('{"id":"u3","command":"echo default"}');
const r3 = getDb().prepare("SELECT max_retries FROM jobs WHERE id='u3'").get();
assert(r3.max_retries === 5, 'config default max_retries used');
setConfig('max_retries', 3);

// --- test: claim query (single atomic UPDATE) ---
const now = new Date().toISOString();
const claimed = getDb().prepare(`
  UPDATE jobs
  SET state = 'processing', claimed_at = ?, worker_pid = ?, updated_at = ?
  WHERE id = (SELECT id FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1)
  RETURNING id
`).get(now, 99999, now);
assert(claimed && claimed.id === 'u1', 'claim picks oldest pending job');

// Verify claimed job is no longer pending
const u1state = getDb().prepare("SELECT state FROM jobs WHERE id='u1'").get();
assert(u1state.state === 'processing', 'claimed job is now processing');

// Verify second claim gets a different job
const second = getDb().prepare(`
  UPDATE jobs
  SET state = 'processing', claimed_at = ?, worker_pid = ?, updated_at = ?
  WHERE id = (SELECT id FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1)
  RETURNING id
`).get(now, 99999, now);
assert(second && second.id !== 'u1', 'second claim gets different job');

// --- test: complete transition ---
getDb().prepare("UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?").run(now, 'u1');
const done = getDb().prepare("SELECT state FROM jobs WHERE id='u1'").get();
assert(done.state === 'completed', 'complete transition works');

// --- test: retry transition ---
getDb().prepare(`
  UPDATE jobs SET state = 'pending', attempts = 1, next_attempt_at = ?
  WHERE id = ?
`).run(new Date(Date.now() + 2000).toISOString(), 'u3');
const retried = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='u3'").get();
assert(retried.state === 'pending', 'retry sets state pending');
assert(retried.attempts === 1, 'retry increments attempts');

// --- test: dead transition (attempts exhausted) ---
getDb().prepare(`
  UPDATE jobs SET state = 'dead', attempts = 5, last_error = 'exit code 1', updated_at = ?
  WHERE id = ?
`).run(now, 'u2');
const dead = getDb().prepare("SELECT state, attempts FROM jobs WHERE id='u2'").get();
assert(dead.state === 'dead', 'dead transition works');
assert(dead.attempts === 5, 'dead has attempt count');

// --- test: dlq list ---
const dl = listDeadJobs();
assert(dl.length === 1, 'dlq list has 1 job');
assert(dl[0].id === 'u2', 'dlq list has correct job');

// --- test: dlq retry resets attempts to 0 ---
retryDeadJob('u2');
const rj = getDb().prepare("SELECT state, attempts, next_attempt_at FROM jobs WHERE id='u2'").get();
assert(rj.state === 'pending', 'dlq retry sets pending');
assert(rj.attempts === 0, 'dlq retry resets attempts to 0');
assert(rj.next_attempt_at === null, 'dlq retry clears next_attempt_at');

// --- cleanup ---
resetDb();
fs.rmSync(TEST_DIR, { recursive: true, force: true });

console.error(`unit-queue: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
