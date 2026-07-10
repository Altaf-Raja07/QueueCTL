# queuectl — Comprehensive Feature & Build Plan (Node.js)

This plan is organized in **build sequence** — each phase depends on the one before it.
No time estimates are given; work through phases in order, since later phases assume
earlier ones are working and tested.

---

## Phase 0 — Project Foundation

- [ ] Initialize Node.js project (`npm init`)
- [ ] Install core dependencies:
  - `commander` — CLI command/subcommand parsing
  - `better-sqlite3` — synchronous, transactional SQLite driver
- [ ] Set up project structure:
  ```
  queuectl/
  ├── bin/queuectl.js
  ├── src/
  │   ├── db.js
  │   ├── queue.js
  │   ├── worker.js
  │   ├── workerManager.js
  │   ├── config.js
  │   └── commands/
  ├── test/
  ├── .gitignore          (ignore *.db, *.pid, node_modules)
  ├── package.json
  └── README.md
  ```
- [ ] Wire up `bin/queuectl.js` as the CLI entrypoint with `commander`, with empty stub subcommands
- [ ] Confirm `npx queuectl --help` (or `node bin/queuectl.js --help`) prints command list

---

## Phase 1 — Data Layer (Persistence Foundation)

- [ ] Design and create SQLite schema:
  - `jobs` table: `id, command, state, attempts, max_retries, next_attempt_at, claimed_at, worker_pid, last_error, created_at, updated_at`
  - `config` table: `key, value` (for `backoff_base`, `default_max_retries`, `stale_timeout_seconds`, `poll_interval_ms`)
- [ ] `db.js`: initialize DB file on first run, create tables if not exist, export a singleton connection
- [ ] Verify: deleting and restarting the process does **not** wipe existing job data (persistence sanity check)

---

## Phase 2 — Configuration Management

- [ ] `config.js`: `getConfig(key)`, `setConfig(key, value)`, `getAllConfig()` with sane defaults if unset
- [ ] CLI: `queuectl config set max-retries 3`
- [ ] CLI: `queuectl config set backoff-base 2`
- [ ] CLI: `queuectl config get <key>` and `queuectl config list` (not explicitly required, but trivial and useful for debugging/demo)
- [ ] Ensure no retry count or backoff value is hardcoded anywhere else in the codebase — always read through `config.js`

---

## Phase 3 — Job Enqueueing

- [ ] `queue.js`: `enqueueJob(jobInput)`
  - Accept `id`, `command`, optional `max_retries` (falls back to config default)
  - Validate required fields; reject malformed JSON with a clear CLI error
  - Set initial state `pending`, `attempts: 0`, timestamps
- [ ] CLI: `queuectl enqueue '{"id":"job1","command":"sleep 2"}'`
- [ ] Handle duplicate `id` on enqueue (decide: reject vs overwrite — document the decision)

---

## Phase 4 — Core Worker Execution Loop (single worker, no concurrency yet)

- [ ] `worker.js`: basic poll loop
  - Claim one eligible pending job
  - Execute `command` via `child_process.exec`
  - On exit code 0 → mark `completed`
  - On non-zero exit / command-not-found → mark `failed` (handled fully in Phase 5)
  - Sleep on empty queue (configurable poll interval), then loop
- [ ] CLI: `queuectl worker start --count 1` (single worker first, to validate core loop before scaling)
- [ ] Manually verify: `sleep 2` job completes, `echo hello` job completes

---

## Phase 5 — Retry Logic & Exponential Backoff

- [ ] On job failure:
  - Increment `attempts`
  - If `attempts >= max_retries` → move to `dead` (Phase 6 handles this properly)
  - Else → set state back to `pending`, compute `next_attempt_at = now + (backoff_base ^ attempts)` seconds
- [ ] Update claim query to only pick jobs where `next_attempt_at IS NULL OR next_attempt_at <= now`
- [ ] Store `last_error` (exit code + truncated stderr) on every failure for later inspection
- [ ] Manually verify: a job with `command: "exit 1"` retries with increasing delay between attempts

---

## Phase 6 — Dead Letter Queue (DLQ)

- [ ] Finalize "move to dead" logic once `max_retries` exhausted
- [ ] CLI: `queuectl dlq list` — show all `dead` jobs with `last_error` and attempt count
- [ ] CLI: `queuectl dlq retry <job-id>` — reset `attempts: 0`, `state: pending`, clear `next_attempt_at`
- [ ] Manually verify: failing job eventually reaches `dead`, and `dlq retry` successfully requeues it

---

## Phase 7 — Multiple Workers & Concurrency Safety

- [ ] Update claim logic to a single atomic `UPDATE ... WHERE state='pending' AND id=(SELECT ... LIMIT 1)` statement (no read-then-write race window)
- [ ] `workerManager.js`: spawn N worker child processes via `child_process.fork`
- [ ] CLI: `queuectl worker start --count 3`
- [ ] Track spawned worker PIDs in a registry file (e.g. `.queuectl/workers.json` or `.pid` files)
- [ ] Stress-test: enqueue 20+ short jobs, run 3 workers, confirm **zero duplicate completions** and all jobs end up `completed`

---

## Phase 8 — Graceful Shutdown

- [ ] CLI: `queuectl worker stop`
  - Read worker PIDs from registry
  - Send `SIGTERM` to each
- [ ] In `worker.js`: trap `SIGTERM`
  - Set a `shuttingDown` flag
  - Allow the **current in-flight job** to finish before exiting
  - Do not claim any new job once flag is set
  - Remove own PID from registry on clean exit
- [ ] Manually verify: `worker stop` while a `sleep 5` job is running does not kill it mid-execution

---

## Phase 9 — Stale/Crashed Worker Recovery

- [ ] Add `claimed_at` timestamp, set when a job transitions to `processing`
- [ ] Sweep logic (run at start of each poll cycle):
  - Any job stuck in `processing` past a configurable `stale_timeout_seconds` → reset to `pending`, clear `worker_pid`
  - Do **not** increment `attempts` for this case (worker died ≠ command failed) — document this reasoning in README
- [ ] Manually verify: force-kill a worker (`kill -9`) mid-job, confirm the job is later picked up by another worker

---

## Phase 10 — Status & Listing Commands

- [ ] CLI: `queuectl status` — counts per state (`pending/processing/completed/failed/dead`) + number of active worker PIDs
- [ ] CLI: `queuectl list --state pending` — filterable job listing, human-readable table output
- [ ] Ensure both commands read live from SQLite (no caching/staleness)

---

## Phase 11 — CLI Polish

- [ ] `--help` text on every command and subcommand (commander gives this mostly for free — verify it's descriptive)
- [ ] Consistent, readable terminal output (tables for `list`/`dlq list`/`status`; clear success/error messages)
- [ ] Meaningful non-zero exit codes on CLI errors (bad JSON, missing job id, etc.)
- [ ] Input validation errors are friendly, not raw stack traces

---

## Phase 12 — Testing (plain Node scripts, no framework)

- [ ] `test/unit-queue.js` — using `:memory:` SQLite: test enqueue → claim → complete, and enqueue → claim → fail → retry → dead transitions
- [ ] `test/e2e-basic.js` — enqueue a successful command, run a real worker briefly, assert `completed`
- [ ] `test/e2e-retry-dlq.js` — enqueue a failing command, run worker until `dead`, assert attempt count matches `max_retries`
- [ ] `test/e2e-concurrency.js` — enqueue N jobs, spawn 3 real worker processes, assert no duplicates, all `completed`
- [ ] `test/e2e-restart.js` — enqueue jobs, kill process before completion, restart, confirm jobs are still present in DB with correct state
- [ ] `test/run-all.js` — runs all above in sequence, non-zero exit on any failure
- [ ] Wire `npm test` → `node test/run-all.js`

---

## Phase 13 — Documentation (README.md)

- [ ] **Setup Instructions** — clone, `npm install`, how to run (`node bin/queuectl.js ...` or global link via `npm link`)
- [ ] **Usage Examples** — every CLI command with real example output (copy-paste from actual terminal runs)
- [ ] **Architecture Overview**
  - Job lifecycle diagram/table
  - How persistence works (SQLite schema)
  - How worker concurrency/locking works (the atomic claim query)
  - How graceful shutdown works
  - How stale-job recovery works
- [ ] **Assumptions & Trade-offs** — explicitly state:
  - Why SQLite over plain JSON
  - Duplicate `id` on enqueue behavior
  - Stale timeout doesn't count as a retry attempt (reasoning)
  - Any features intentionally simplified
- [ ] **Testing Instructions** — how to run `npm test`, and how to manually verify each of the 5 expected test scenarios from the assignment
- [ ] Link to a recorded CLI demo video (uploaded to Drive, per submission requirements)

---

## Phase 14 — Final Pre-Submission Checklist

- [ ] All required commands functional (`enqueue`, `worker start/stop`, `status`, `list`, `dlq list/retry`, `config set`)
- [ ] Jobs persist correctly after full process restart
- [ ] Retry + exponential backoff verified with actual timing (not just logic review)
- [ ] DLQ operational end-to-end (fail → dead → dlq retry → completes)
- [ ] No hardcoded retry/backoff/timeout values anywhere
- [ ] Code modular: CLI parsing, queue logic, worker logic, config, and DB access are cleanly separated files/modules
- [ ] `npm test` passes cleanly
- [ ] README complete per Phase 13
- [ ] `.gitignore` excludes the runtime `.db` file, `.pid`/registry files, `node_modules`
- [ ] Push to a **public** GitHub repo
- [ ] Record CLI demo video, upload, link in README
- [ ] Share repo link for review

---

## Bonus Features (optional, tackle only after all above is solid)

- [ ] Job timeout handling (kill a job's `exec` if it exceeds a configured max duration)
- [ ] Job priority queues (add `priority` field, order claim query by priority then created_at)
- [ ] Scheduled/delayed jobs (`run_at` field, same mechanism as `next_attempt_at`)
- [ ] Job output logging (capture and persist stdout/stderr per job/attempt)
- [ ] Metrics/execution stats (avg run time, success rate, retries per job)
- [ ] Minimal web dashboard (simple Express + read-only view over the same SQLite DB)

---

## Sequencing Rationale

The order above is deliberate:
1. **Data layer first** — nothing works without persistence being correct from the start.
2. **Single worker before multiple workers** — validate core execution logic before introducing concurrency, so bugs are easier to isolate.
3. **Retry/DLQ before concurrency** — these are pure state-machine logic and easiest to get right in isolation.
4. **Concurrency safety before shutdown/stale-recovery** — shutdown and stale-recovery logic only make sense once multiple real worker processes exist.
5. **Testing threaded in as you go, formalized in Phase 12** — but each phase above already includes a "manually verify" step; don't wait until the end to test.
6. **Documentation last but not rushed** — write the architecture notes while decisions are fresh, ideally right after the phase that made the decision, not all at once at the end.