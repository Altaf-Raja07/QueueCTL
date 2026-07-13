

# queuectl — CLI-Based Background Job Queue System

A minimal, production-grade job queue system that runs entirely via the command line. Workers execute shell commands as background jobs with automatic retries, exponential backoff, a Dead Letter Queue (DLQ), and persistent SQLite storage.

Built for a backend internship assignment. Tech stack: Node.js, better-sqlite3, commander.

---

## Setup

```bash
git clone <repo-url> queuectl
cd queuectl
npm install
```

Run commands directly:

```bash
node bin/queuectl.js --help
```

Or link globally for `queuectl` on your PATH:

```bash
npm link
queuectl --help
```

---

## Usage

### Enqueue a Job

```bash
node bin/queuectl.js enqueue '{"id":"demo","command":"echo hello world"}'
```

Output (to stderr):

```
Job demo enqueued (pending)
```

### Start Workers

Start a single worker in the foreground (blocks until stopped):

```bash
node bin/queuectl.js worker start
```

Start multiple concurrent poll loops in one process:

```bash
node bin/queuectl.js worker start --count 3
```

### Stop Workers

From a **separate terminal** (no shared memory):

```bash
node bin/queuectl.js worker stop
```

Output:

```
Sent SIGTERM to worker 63175
```

### Check Status

```bash
node bin/queuectl.js status
```

```
pending      0
processing   0
completed    2
failed       0
dead         1
active workers 0
```

### List Jobs

Human-readable table:

```bash
node bin/queuectl.js list --state completed
```

```
j1               echo a                   completed    0  /3   2026-07-11T21:11:08
j2               echo b                   completed    0  /3   2026-07-11T21:11:08
```

JSON output (stdout-only, pipes cleanly through `jq`):

```bash
node bin/queuectl.js list --state pending --json | jq .
```

```json
[
  {
    "id": "j3",
    "command": "sleep 10",
    "state": "pending",
    "attempts": 1,
    "max_retries": 3,
    "created_at": "2026-07-11T21:11:08.732Z"
  }
]
```

### Dead Letter Queue

List dead jobs:

```bash
node bin/queuectl.js dlq list
```

```
dlq-demo  attempts=2/2  error="exit code 1"  updated=2026-07-11T20:57:58.316Z
```

Retry a dead job (resets `attempts` to 0):

```bash
node bin/queuectl.js dlq retry dlq-demo
```

```
Job dlq-demo retried (pending)
```

### Configuration

```bash
node bin/queuectl.js config set max-retries 5
node bin/queuectl.js config set backoff-base 2
node bin/queuectl.js config list
```

```
max_retries=5
backoff_base=2
stale_timeout_seconds=15
poll_interval_ms=2000
```

Config keys accept hyphens or underscores interchangeably (e.g. `max-retries` ↔ `max_retries`).

---

## Architecture

### Directory Structure

```
queuectl/
├── bin/queuectl.js      CLI entrypoint (commander)
├── src/
│   ├── db.js            SQLite connection + schema
│   ├── config.js        Key-value config backed by config table
│   ├── queue.js         Queue operations (enqueue, DLQ, list, status)
│   ├── worker.js        Worker poll loop, claim, exec, sweep
│   └── commands/        Reserved for future command modules
├── test/                Test suite (6 tests, run via npm test)
├── .queuectl/           Runtime data (auto-created)
│   ├── queuectl.db      SQLite database
│   └── workers/         PID files for worker discovery
├── .gitignore
├── package.json
├── README.md
└── DECISIONS.md
```

### Job Lifecycle

```
                  ┌──────────┐
                  │  pending │◄────────────────────────────┐
                  └────┬─────┘                              │
                       │ claim (atomic UPDATE)              │
                       ▼                                    │
                  ┌──────────┐                              │
                  │processing│                              │
                  └────┬─────┘                              │
                    ┌──┴──┐                                 │
                    ▼      ▼                                │
              ┌────────┐ ┌──────┐                           │
              │completed│ │failed│──retry (backoff)─────────┘
              └────────┘ └──┬───┘        ◄── alive again
                            │ exhausted
                            ▼
                       ┌──────┐
                       │ dead │ (DLQ)
                       └──────┘
```

A crashed (SIGKILL'd) worker leaves a job stuck in `processing`. The stale-job sweep (`sweepStaleJobs`) resets it to `pending` after `stale_timeout_seconds` without incrementing `attempts`.

### Persistence

SQLite via better-sqlite3, WAL mode for concurrent reads. Two tables:

- **`jobs`** — `id`, `command`, `state`, `attempts`, `max_retries`, `next_attempt_at`, `claimed_at`, `worker_pid`, `last_error`, timestamps
- **`config`** — `key`, `value`

The database file lives at `.queuectl/queuectl.db` and survives process restarts.

### Worker Concurrency

- `--count N` spawns N concurrent async poll loops **within a single process** (one signal handler, one PID registration)
- **Real cross-process safety** (multiple `worker start` terminals) is guaranteed by the atomic claim query, which SQLite serializes via file-level write locks
- Workers must be stopped gracefully via `worker stop`; SIGKILL is handled by crash recovery

### Graceful Shutdown

On SIGTERM or SIGINT (Ctrl+C):

1. Worker sets a `shuttingDown` flag
2. Current in-flight `exec` child continues to completion
3. Worker deregisters its PID file
4. Poll loop detects flag and calls `process.exit(0)`

No new job is claimed after the flag is set.

### Stale-Job Recovery (Crash)

`sweepStaleJobs()` runs on every worker startup and every poll iteration. It finds jobs in `processing` where `claimed_at` is older than `stale_timeout_seconds` and resets them to `pending`. `attempts` is NOT incremented — a crashed worker is not a failed command.

---

## Assumptions & Trade-offs

### SQLite over plain JSON

SQLite provides atomic transactions, concurrent access (WAL mode), and built-in indexing — all essential for correct multi-worker behavior. JSON file storage would require implementing our own locking and atomic writes. The cost: a native binary dependency (`better-sqlite3`).

### Duplicate ID on enqueue: Reject

If two enqueues use the same `id`, the second is rejected with an error. Silently overwriting could destroy a pending job the user didn't intend to replace. Since job IDs are user-chosen, the user can pick a different ID. This is at-most-once semantics on create.

### Config changes: per-job vs live

- **`max_retries`**: captured per-job at enqueue time. A job created under the old config keeps its own limit. Changing the config doesn't retroactively affect already-enqueued jobs.
- **`backoff_base`**: read live from config at each retry. This is a global timing policy, not a per-job contract. Changing it affects the next scheduled retry of every in-flight job.

### Stale-job sweep doesn't increment attempts

A crashed worker (SIGKILL) didn't run the command — we literally don't know if it would have succeeded or failed. Incrementing `attempts` would unfairly consume the retry budget. The job is re-queued as if never picked up.

### `dlq retry` resets attempts to 0

A manual retry from the DLQ is an explicit human decision to "try this job from scratch." Leaving `attempts` at the exhausted value would immediately re-exhaust it on the next failure, making the retry pointless.

### PID recycling risk

PID files (`worker stop` → `kill(pid, SIGTERM)`) have a fundamental limitation: if a worker crashes and its PID is reassigned by the OS to an unrelated process, `worker stop` would signal the wrong process. Acceptable for a local development tool. Production systems use socket-based process supervision (e.g. systemd).

---

## Testing

```bash
npm test
```

Runs 6 tests sequentially:

| Test | What it covers |
|---|---|
| `unit-queue.js` | Enqueue validation, claim atomicity, state transitions, DLQ retry |
| `e2e-basic.js` | A successful job completes with attempts=0 |
| `e2e-retry-dlq.js` | Failing job retries with backoff, reaches DLQ, `dlq retry` works |
| `e2e-concurrency.js` | 3 real separate OS processes process 30 jobs exactly once |
| `e2e-crash-recovery.js` | `kill -9` mid-job → new worker recovers within 30s |
| `e2e-restart.js` | Job data survives full process restart |

### Manual Verification

**Scenario 1 — Basic job:**

```bash
node bin/queuectl.js enqueue '{"id":"test1","command":"echo hello"}'
node bin/queuectl.js worker start
# Ctrl+C after job completes
node bin/queuectl.js list --state completed
```

**Scenario 2 — Retry + DLQ:**

```bash
node bin/queuectl.js enqueue '{"id":"test2","command":"exit 1","max_retries":2}'
node bin/queuectl.js worker start
# After ~10s Ctrl+C
node bin/queuectl.js dlq list
# Should show 2/2 attempts
node bin/queuectl.js dlq retry test2
```

**Scenario 3 — Parallel workers (separate terminals):**

```
Terminal A: node bin/queuectl.js worker start
Terminal B: node bin/queuectl.js worker start
Terminal C: node bin/queuectl.js enqueue '{"id":"p1","command":"sleep 2"}'
            node bin/queuectl.js enqueue '{"id":"p2","command":"sleep 2"}'
# Both process concurrently without overlap
```

**Scenario 4 — Crash recovery:**

```bash
# Terminal A
node bin/queuectl.js enqueue '{"id":"crash1","command":"sleep 20"}'
node bin/queuectl.js worker start
# Terminal B: kill -9 <PID of terminal A's worker>
# Terminal A again
node bin/queuectl.js worker start
# Job completes within ~22s
```

**Scenario 5 — Persistence:**

```bash
node bin/queuectl.js enqueue '{"id":"p1","command":"echo survived"}'
# Kill the entire process
node bin/queuectl.js worker start  # Job is still there, gets processed
```

---

## Demo Recording

<video src="https://github.com/user-attachments/assets/650b50ee-7e34-4663-9124-4a80ef2d5bc9" controls widht="100%"></video>

---

## License

MIT
