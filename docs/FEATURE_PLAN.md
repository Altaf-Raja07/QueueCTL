# queuectl — Feature & Build Plan v2 (Revised Assignment)

This supersedes the original feature plan. Key differences driving these changes:
a mandatory 30-min live review (30% of grade) where you must explain/defend/modify
your own code, a hard automated-test **gate** (fail scenarios 1–3 → interview ends),
a strict interface contract, a 60-second crash-recovery SLA, and a required
`DECISIONS.md` with specific graded questions.

**New rule for this build: after every phase, don't just verify it works — read
the actual diff and be able to explain it out loud before committing.** You will be
asked to do exactly this live, on camera, for money.

---

## Phase 0 — Project Foundation

- [ ] `npm init`, install `commander` + `better-sqlite3`
- [ ] Project structure (same as before) **plus**:
  - `DECISIONS.md` created now, empty, with the 5 required question headers
    stubbed in — so it's tracked in git from commit 1, not bolted on at the end
- [ ] `.gitignore`: `*.db`, `*.pid`, `.queuectl/`, `node_modules`
- [ ] Verify `--help` works and shows all command stubs

---

## Phase 1 — Data Layer

- [ ] Same schema as before: `jobs` (id, command, state, attempts, max_retries,
  next_attempt_at, claimed_at, worker_pid, last_error, created_at, updated_at) and
  `config` (key, value)
- [ ] Verify restart doesn't wipe data

*(No structural change here — the original schema already anticipated crash
recovery and locking needs.)*

---

## Phase 2 — Configuration Management

- [ ] `config.js`: get/set/getAll, defaults for `max_retries`, `backoff_base`,
  `stale_timeout_seconds`, `poll_interval_ms`
- [ ] **New decision to make and document in DECISIONS.md**: do config changes
  affect already-enqueued jobs, or only jobs enqueued after the change? Recommended:
  `max_retries` is captured **per-job at enqueue time** (a job created under the old
  config keeps its own limit), but `backoff_base` is read **live** at each retry
  (global timing policy, not a per-job property). Document this split explicitly —
  it's one of the assignment's specific decision points.

---

## Phase 3 — Job Enqueueing

- [ ] Same as before: `enqueueJob()`, CLI wiring, validation, duplicate-id handling
  (decide and document the choice)

---

## Phase 4 — Single Worker: Foreground + Signal Handling (moved earlier — now core, not polish)

This phase absorbs what used to be "Phase 4 + parts of Phase 8," because the
interface contract makes foreground execution and signal semantics load-bearing
from the start, not a later add-on.

- [ ] `worker.js`: poll loop using `child_process.exec`
- [ ] **`worker start` must run in the foreground and block** — the process does
  not exit until stopped
- [ ] On start, the worker process **registers itself** in a PID registry (e.g. a
  row in a `workers` table, or a file under `.queuectl/workers/`) — this is the
  mechanism `worker stop` will use later. Decide file-based vs DB-row-based now,
  since Phase 8 depends on it, and document the choice + rejected alternatives in
  DECISIONS.md (Q4).
- [ ] Trap `SIGTERM` and `SIGINT` (Ctrl+C) in-process: set a flag, finish the
  current in-flight job, deregister from the PID registry, then exit cleanly
- [ ] `SIGKILL` is **not** trapped (it can't be) — this is intentional; recovery
  from this case is Phase 9's job, not this phase's
- [ ] Manual verify: start a worker, Ctrl+C it mid-`sleep 5` job, confirm the job
  finishes before the process exits

---

## Phase 5 — Retry & Exponential Backoff

- [ ] Same logic as before (`next_attempt_at`, claim query filtering on it)
- [ ] Confirm `backoff_base` is read from live config at retry time (per Phase 2 decision)

---

## Phase 6 — Dead Letter Queue

- [ ] `dlq list`, `dlq retry <id>`
- [ ] **Decision required (DECISIONS.md Q3)**: does `dlq retry` reset `attempts` to
  0? Recommended: yes — a manual retry is a human deciding "try again from
  scratch," and leaving `attempts` at the exhausted value would just immediately
  re-exhaust it on the very next failure. Document this reasoning specifically —
  "vague answers score zero" per the spec.

---

## Phase 7 — Multiple Workers & True Cross-Process Concurrency Safety

**Design change from v1**: instead of one parent process forking N children,
implement `--count N` as **N concurrent async poll loops within a single Node
process** (simplest correct approach — Node's event loop handles concurrent I/O-bound
loops fine, and it means only one signal handler and one PID registration per
`worker start` invocation).

The *real* cross-process test isn't `--count N` — it's what happens when you run
`queuectl worker start` **multiple times, as separate OS processes** (i.e., from
separate terminals). That's what "not just threads" in the spec is pointing at.

- [ ] `--count N` → N concurrent async loops in one process
- [ ] The atomic claim query (single `UPDATE ... WHERE state='pending' ... LIMIT 1`)
  must be safe regardless of whether concurrency comes from N loops in one process
  or N fully separate `worker start` processes — SQLite's transactional writes make
  this true either way, but you must **verify it against real separate processes**,
  not just in-process loops, since that's what's actually being tested
- [ ] **DECISIONS.md Q1**: point to the exact line(s) of the claim query and explain
  why it's atomic *across separate OS processes* specifically (not just across
  threads/loops in one process) — this is graded specifically on precision
- [ ] Stress test: from a test script, spawn 3 **real separate** `worker start`
  child processes (via `child_process.spawn`, simulating 3 terminals) against 30+
  short jobs, then assert every job ran exactly once

---

## Phase 8 — Cross-Terminal `worker stop`

- [ ] `worker stop` is invoked as a **separate CLI process**, with no shared memory
  with the running workers — it must discover live workers via the Phase 4 registry
  and send `SIGTERM` to each
- [ ] Before signaling, check each registered PID is actually alive
  (`process.kill(pid, 0)` throws if not) and prune stale/dead entries from the
  registry (crashed workers via `SIGKILL` never got to deregister themselves)
- [ ] Report to the user which workers were signaled and confirm graceful exit
- [ ] Manual verify from **two actual separate terminal windows**: terminal A runs
  `worker start`, terminal B runs `worker stop`, confirm A's in-flight job finishes
  before it exits

---

## Phase 9 — Crash Recovery (hard SLA: under 60 seconds, automated-tested)

- [ ] `claimed_at` timestamp set when a job → `processing`
- [ ] Sweep: any job stuck in `processing` past `stale_timeout_seconds` → reset to
  `pending`, clear `worker_pid`, **do not increment `attempts`**
- [ ] Run the sweep **immediately on every worker startup**, and again every poll
  cycle — don't wait a full poll interval before the first sweep, since a test may
  `SIGKILL` a worker and then immediately restart a new one expecting fast recovery
- [ ] **Tune the numbers deliberately** so worst-case recovery is comfortably under
  60s, not just barely under it: e.g. `stale_timeout_seconds` default ~15–20s,
  `poll_interval_ms` a few seconds — worst case ≈ `stale_timeout + poll_interval`,
  leave real margin below 60s
- [ ] **DECISIONS.md Q2**: walk through, step by step, the exact state of a job
  when its worker is `SIGKILL`ed mid-execution, and the exact sequence of events
  until it recovers — with the worst-case delay computed from your actual config
  defaults, not a guess
- [ ] Manual verify: start a worker, let it claim a `sleep 10` job, `kill -9` the
  worker PID directly, start a new worker, time how long until the job is reclaimed
  and completes

---

## Phase 10 — Status, List, and Strict `--json` Output

- [ ] `status`: state counts + active (live, pruned) worker count
- [ ] `list --state <state>`: human-readable table by default
- [ ] `list --state <state> --json`: **must print only a valid JSON array to
  stdout, nothing else** — this is explicitly contract-tested. Route every log
  message, banner, or diagnostic print to `stderr`, never `stdout`, when `--json`
  is set (or just always route logs to stderr as a blanket rule, simplest to get right)
- [ ] Verify: `queuectl list --state pending --json | jq .` actually parses cleanly
  with no leading/trailing junk

---

## Phase 11 — CLI Polish & Interface Contract Conformance Pass

- [ ] Re-verify literally every point of the "Interface contract" section of the
  spec against your actual CLI, one by one: foreground blocking, SIGTERM/SIGINT
  semantics, `--json` purity, `worker stop` from a separate terminal
  — deviating from the contract fails the automated run regardless of correctness
  elsewhere
- [ ] `--help` text quality, consistent formatting, friendly errors, sane exit codes

---

## Phase 12 — Testing

Build your own test suite even though it's not separately weighted anymore —
scenarios 1–5 will be run live against you, so verify them yourself first:

- [ ] `test/unit-queue.js` — in-memory SQLite state transitions
- [ ] `test/e2e-basic.js` — basic job completes
- [ ] `test/e2e-retry-dlq.js` — failing job retries then reaches DLQ
- [ ] `test/e2e-concurrency.js` — **real separate spawned processes**, not
  in-process loops, N jobs, assert exactly-once execution
- [ ] `test/e2e-crash-recovery.js` — spawn a worker, `kill -9` it mid-job, start a
  new worker, assert completion within a safety margin under 60s (e.g. assert
  under 30s to leave headroom)
- [ ] `test/e2e-restart.js` — persistence across full restart
- [ ] `test/run-all.js` wiring them together

---

## Phase 13 — Documentation

### README.md
Same sections as before (setup, usage with real output, architecture, trade-offs,
testing), plus a link to the demo recording.

### DECISIONS.md (required, specific, graded 15% jointly with README)
Answer these five **exactly as asked**, with specifics, not generalities:

1. Exact line(s) that make job-claiming atomic, and why atomic *across separate
   OS processes*
2. Step-by-step walkthrough of a `SIGKILL`-mid-job scenario and the worst-case
   recovery delay, computed from your actual config defaults
3. Whether `dlq retry` resets `attempts`, and why
4. What you considered and rejected for cross-process `worker stop` signaling
   (e.g. considered a Unix domain socket, rejected for X reason; chose PID files
   for Y reason)
5. If priority queues were added tomorrow, which parts of the design survive
   unchanged (e.g. the atomic claim pattern generalizes to `ORDER BY priority,
   created_at`) and which break (e.g. FIFO assumptions in tests, or a
   round-robin poll order)

---

## Phase 14 — Final Pre-Submission Pass

- [ ] Re-run the 5 test scenarios from the spec **yourself**, exactly as their
  automated script would: foreground worker, separate terminal `worker stop`,
  `--json` output piped through a JSON parser, `kill -9` recovery timing
- [ ] Confirm git history is genuinely incremental (check `git log --oneline`
  yourself — if it looks like 2 commits, that's a problem, not just a formality)
- [ ] Confirm `README.md` and `DECISIONS.md` are both present, and that
  `DECISIONS.md` answers are specific (re-read them as if you were the reviewer
  looking for vagueness)
- [ ] **Do a personal dry-run of the live review**: pick 3 files at random and
  explain them out loud to yourself (or to someone else) without looking at
  agent-generated comments — if you can't, that's the actual risk area, fix it
  before submitting, not after being asked in the interview
- [ ] Confirm `bash` and `python3` are available in your environment (their test
  script may depend on them)
- [ ] Record the CLI demo, upload, link in README
- [ ] Push to a public GitHub repo

---

## Sequencing Rationale (updated)

The single biggest structural change from v1: **foreground execution + signal
handling + PID registration move from "polish" (old Phase 8) into core Phase 4**,
because the new interface contract makes them load-bearing for every scenario the
automated test runs, not an afterthought. Crash recovery (Phase 9) is now a
timed, hard-gated requirement, not a "nice robustness feature" — build and time it
deliberately, with real margin under the 60s SLA, not just barely under it.