# DECISIONS.md

## Q1 — Atomic Job Claiming

**Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?**

The atomic claim is the single SQL `UPDATE` statement at `src/worker.js:91-105` (the `claimJob` function):

```sql
UPDATE jobs
SET state = 'processing',
    claimed_at = ?,
    worker_pid = ?,
    updated_at = ?
WHERE id = (
  SELECT id FROM jobs
  WHERE state = 'pending'
    AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *
```

**Why it is atomic across separate OS processes:**

1. **It is a single SQL statement.** SQLite compiles this into one sequence of virtual-machine instructions — the subquery (`SELECT ... LIMIT 1`) and the outer `UPDATE` execute under the same write lock with no yield point between them. There is no read-then-write gap where another process could interleave.

2. **SQLite serializes all writers.** Each `worker start` process opens its own `better-sqlite3` connection to the same `.db` file. SQLite uses POSIX advisory locks (`fcntl`) on the database file to ensure only one write transaction commits at a time. If Process A and Process B both submit this UPDATE simultaneously, one gets the write lock first; its subquery finds the oldest `pending` job, flips it to `processing`, and releases the lock. The other process's subquery then runs, but that job is now `processing`, so it picks the next oldest `pending` job instead.

3. **`better-sqlite3` is synchronous.** Every `db.prepare(...).get(...)` call blocks the calling JavaScript thread until SQLite returns. No Promise or callback can interleave between "read which job is pending" and "write that it's now processing." This eliminates the race regardless of whether concurrency comes from in-process async loops or from physically separate OS processes sharing the same database file.

**The same guarantee holds for the stale-job recovery sweep** at `src/worker.js:29-40` — it is also a single `UPDATE ... WHERE state='processing' AND claimed_at <= ? RETURNING id`, atomically selecting and resetting only jobs past the timeout.

---

## Q2 — Worker SIGKILL Recovery

**A worker receives SIGKILL halfway through a job. Explain what state the job is in, how it is recovered, and the worst-case recovery delay.**

### State after SIGKILL

The job remains in `processing` state in the SQLite database. The columns `claimed_at` and `worker_pid` are still set to the values the dead worker wrote when it claimed the job. The command was never completed — we have no way to know if it would have succeeded or failed.

### Recovery sequence

1. A new worker starts (either manually by the user, or one was already running).
2. On startup (`startWorker` at `src/worker.js:15`) and at the top of every poll iteration (`pollLoop` at `src/worker.js:72`), the worker calls `sweepStaleJobs()` (`src/worker.js:23-45`).
3. `sweepStaleJobs` reads the live `stale_timeout_seconds` config value (default: 15). It computes a cutoff timestamp: `now - stale_timeout_seconds`.
4. It executes:
   ```sql
   UPDATE jobs
   SET state = 'pending',
       claimed_at = NULL,
       worker_pid = NULL,
       next_attempt_at = NULL,
       updated_at = ?
   WHERE state = 'processing'
     AND claimed_at IS NOT NULL
     AND claimed_at <= ?
   RETURNING id
   ```
5. Any job whose `claimed_at` is older than the cutoff is reset to `pending`. The `claimed_at` and `worker_pid` columns are cleared so the job looks identical to a freshly enqueued one.
6. **`attempts` is NOT incremented.** The worker didn't run the command — it was killed by the OS before the command could complete. Incrementing `attempts` would unfairly consume the job's retry budget for a failure that was infrastructure-caused, not command-caused.
7. On the very next `claimJob()` call (same poll iteration, after the sweep), the recovered job is picked up as if it had never been claimed before.
8. The new worker executes the command normally.

### Worst-case recovery delay

Computed from our actual config defaults:

```
stale_timeout_seconds = 15
poll_interval_ms      = 2000 (2 seconds)
```

The worst case happens when the job is claimed at time T, the worker is killed immediately after, and the sweep has just passed the job before it became stale:

```
T + 0s     Job claimed, worker killed
T + 15s    Job becomes stale (claimed_at age = stale_timeout_seconds)
T + 15-17s Next sweep iteration runs (up to poll_interval after staleness)
T + 17s    Job recovered to pending, claimed by new worker
```

**Worst-case delay from kill to recovery: 17 seconds.** This is comfortably under the 60-second SLA, with a 3.5× safety margin.

For a concrete example from our test suite: a `sleep 5` job killed mid-execution was recovered and completed within ~22 seconds total (15s stale wait + 2s poll + 5s execution).

If `stale_timeout_seconds` were reduced to, say, 10 and `poll_interval_ms` to 1000, worst-case recovery would be 11 seconds — but the current defaults already meet the SLA with substantial margin.

---

## Q3 — DLQ Retry: Reset Attempts?

**Does `dlq retry` reset `attempts`? Explain why.**

**Yes, `dlq retry` resets `attempts` to 0** (implemented at `src/queue.js:14-19`):

```js
UPDATE jobs
SET state = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
WHERE id = ?
```

A manual retry from the DLQ is an explicit human decision to say "try this job from scratch." If `attempts` were left at the exhausted value (say, 3/3), the very next failure of the retried job would immediately trigger the `attempts >= max_retries` check and send it straight back to the DLQ without any actual retries. The `dlq retry` operation would be functionally useless.

Resetting to 0 gives the job a full fresh retry budget, which is what an operator intends when they rescue a job from the dead letter queue. The job gets the same number of retry chances as a newly-enqueued job, regardless of how many failures occurred in its previous life.

This is clearly distinct from our Phase 5 retry logic, which correctly increments `attempts` on actual command failures — those are genuine execution attempts that consumed a retry slot.

---

## Q4 — Cross-Process `worker stop`: Considered & Rejected Designs

**What designs did you consider and reject for `worker stop` (cross-process signaling), and why?**

### Chosen Design: PID File Registry

Each worker process, on startup, writes its `process.pid` to `.queuectl/workers/<pid>.pid` (`src/worker.js:47-50`). On graceful shutdown (SIGTERM/SIGINT), the worker deletes its own file (`src/worker.js:52-58`). The `worker stop` command (`src/worker.js:165-191`) reads the directory, checks each PID via `process.kill(pid, 0)` (throws `ESRCH` if the process is dead), sends `SIGTERM` to live PIDs, and prunes stale files from crashed workers that never got to deregister.

### Rejected: Unix Domain Socket

The worker would listen on a Unix socket; `worker stop` would connect and send a shutdown command.

**Rejected because:** Socket lifecycle management (create, bind, accept, clean up on crash) adds significant complexity. The worker's main loop is already a polling event loop — adding concurrent socket accept logic would complicate signal handling and introduce edge cases around socket file cleanup. For a tool that only needs to deliver a single OS signal, a socket is over-engineering. There is no functional advantage over `kill(pid, SIGTERM)` for this use case.

### Rejected: DB Polling (Shutdown Flag)

A `shutdown` row in the `config` table. Workers check it on every poll iteration. `worker stop` sets it to `true`.

**Rejected because:** Introduces up to `poll_interval_ms` (2 seconds by default) of latency between the user running `worker stop` and the worker noticing. Worse, if the worker's database connection is stuck or the DB file is locked, the shutdown signal is never delivered. OS signals (`SIGTERM`) are delivered by the kernel immediately and don't depend on database availability. Additionally, there is no clean way to distinguish "shutdown flag was never set" from "shutdown flag was set but the worker already exited and the flag was never cleared."

### Rejected: Lock / Stamp File

Touch a `.queuectl/stop` file. Workers check for its existence on each poll.

**Rejected because:** Same latency problem as DB polling, plus the same stale-file cleanup issue that PID files already have. If the `worker stop` process itself crashes after creating the file, workers would shut down unexpectedly on their next poll. A PID file at least maps one-to-one with a live process and can be validated with `kill(pid, 0)`.

### The Trade-off We Accept

PID files have one fundamental limitation: **PID recycling**. If a worker crashes and the OS reassigns its PID to an unrelated (non-queuectl) process before `worker stop` runs, `worker stop` would send `SIGTERM` to the wrong process. In practice, for a local development tool on a single-user machine, the window between crash and `worker stop` is far too short for PID recycling to be likely, and even if it happened, the consequence is a spurious SIGTERM to a local process. This is the same trade-off made by nginx, sshd, and countless other Unix tools that use PID files.

For a production deployment, we would use a proper process supervisor (systemd, supervisord) instead of PID-based signaling.

---

## Q5 — Adding Priority Queues Tomorrow

**If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which parts would need to change?**

### What Survives Unchanged

**The atomic claim pattern.** The single `UPDATE ... WHERE id = (SELECT ... ORDER BY ... LIMIT 1)` generalizes directly: the subquery's `ORDER BY created_at ASC` becomes `ORDER BY priority ASC, created_at ASC`. The UPDATE mechanism, SQLite's write serialization, and the synchronous `better-sqlite3` API are all unchanged. This is the main strength of the design — the concurrency safety mechanism is orthogonal to sort order.

**The SQLite schema.** Adding `priority INTEGER NOT NULL DEFAULT 0` to the `jobs` table requires one `ALTER TABLE` statement. No migrations beyond that — the existing `config` table, `state` CHECK constraint, and all indexes survive.

**Retry and backoff logic.** The exponential backoff formula (`delay = base ^ attempts`) is independent of job priority. A high-priority job that fails retries with the same delay calculation as a low-priority one. This is correct behavior — retry scheduling is about when to retry, not in what order.

**Dead Letter Queue.** The `dlq list` and `dlq retry` commands don't depend on ordering. Dead jobs are dead regardless of their original priority. `dlq retry` resets `attempts` to 0 and re-enqueues — the priority field would persist through the retry cycle.

**Crash recovery (stale-job sweep).** `sweepStaleJobs` resets any `processing` job past the timeout to `pending`, regardless of priority. No change needed.

**Worker lifecycle.** PID registration, signal handling, graceful shutdown — all completely independent of job ordering.

**JSON output.** `list --json` serializes all columns. A `priority` field would appear in the output automatically.

### What Breaks or Changes

**The claim subquery's ORDER BY.** Currently `ORDER BY created_at ASC` at `src/worker.js:101`. Would change to `ORDER BY priority ASC, created_at ASC` (assuming lower numbers = higher priority). This is a one-line change to `worker.js`.

**FIFO ordering assumptions in tests and documentation.** The `e2e-concurrency` test and the manual test scenarios assume round-robin or FIFO processing. Priority inversion could cause starvation of low-priority jobs, which needs to be documented as a known behavior.

**The `list` command's default table output.** Currently sorted by `created_at` only. Would likely want to sort by `(priority, created_at)` or at least display the priority column. The table format in `bin/queuectl.js:88-93` would need an additional column.

**The `status` output.** Would benefit from showing priority distribution (e.g., "3 high, 10 normal, 2 low pending").

**The `enqueue` input format.** Currently accepts `id`, `command`, and optional `max_retries`. Would need to accept an optional `priority` field:

```bash
queuectl enqueue '{"id":"urgent","command":"echo hi","priority":0}'
```

**DLQ retry semantics edge case.** If a high-priority job exhausts retries and lands in the DLQ, retrying it should preserve the original priority — otherwise it would lose its priority on requeue. Our current `retryDeadJob` copies all job columns from the existing row; the `priority` column would survive as long as the schema stores it. This needs an explicit assertion in the test suite.

### Summary

The most important property is that **the concurrency safety mechanism (the atomic claim query) survives unchanged** — it simply gets a different `ORDER BY`. The changes are all additive: one schema column, one additional input field, one sort-order tweak, and cosmetic output changes. No architectural restructuring is needed.
