# QueueCTL — Backend Developer Internship Assignment

**Tech Stack:** Your choice — Python / Go / Node.js / Java

**Submission:** Public GitHub repository + README + live review session

---

# 🎯 Objective

Build a CLI-based background job queue system called `queuectl`.

The system manages background jobs with worker processes, retries failures with exponential backoff, and maintains a Dead Letter Queue (DLQ) for permanently failed jobs.

> **Read this first:** Your submission is evaluated in two parts — the code and a 30-minute live review where you explain and modify your own system.

You may use any tools you like to build it (including AI assistants), but you must be able to explain, defend, and change every line on a screen share.

A submission whose author cannot explain it is rejected regardless of how well it works.

---

# 🧩 Problem Overview

Implement a minimal, production-grade job queue that supports:

- Enqueuing and managing background jobs
- Running multiple worker processes in parallel
- Automatic retries with exponential backoff
- A Dead Letter Queue (DLQ) after retries are exhausted
- Persistent job storage across restarts and crashes
- All operations through a CLI

---

# 📦 Job Specification

Each job must contain at least:

```json
{
  "id": "unique-job-id",
  "command": "echo 'Hello World'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2025-11-04T10:30:00Z",
  "updated_at": "2025-11-04T10:30:00Z"
}
```

---

# 🔄 Job Lifecycle

| State | Description |
|--------|-------------|
| `pending` | Waiting to be picked up by a worker |
| `processing` | Currently being executed |
| `completed` | Successfully executed |
| `failed` | Failed, but retryable (waiting for its backoff delay) |
| `dead` | Permanently failed (moved to DLQ) |

### Crash Rule

A job must **never** be stuck in `processing` forever.

If the worker running it dies (including **SIGKILL** — no cleanup handler will run), the system must detect this and recover the job so it can run again.

With your default settings, **worst-case recovery must be under 60 seconds**.

Document your recovery mechanism and its trade-offs in **DECISIONS.md**.

---

# 💻 CLI Commands

| Category | Command Example | Description |
|----------|-----------------|-------------|
| Enqueue | `queuectl enqueue '{"id":"job1","command":"sleep 2"}'` | Add a new job |
| Workers | `queuectl worker start --count 3` | Start workers in the foreground (blocks until stopped) |
| Workers | `queuectl worker stop` | Gracefully stop all running workers from another terminal |
| Status | `queuectl status` | Summary of all job states & active workers |
| List | `queuectl list --state pending --json` | List jobs by state |
| DLQ | `queuectl dlq list` / `queuectl dlq retry job1` | View or retry DLQ jobs |
| Config | `queuectl config set max-retries 3` | Manage configuration |

---

## Interface Contract (Required)

Your automated test suite depends on these behaviors.

### 1. Worker Start

- `worker start` runs **in the foreground**
- `SIGTERM` / `SIGINT` (`Ctrl+C`) triggers graceful shutdown
- Finish the current job before exiting
- `SIGKILL` simulates a crash; your system must survive it

### 2. JSON Output

```bash
queuectl list --state <state> --json
```

Must print **only** a JSON array of job objects to stdout.

### 3. Worker Stop

```bash
queuectl worker stop
```

Must work from a **different terminal** than the one running the workers.

How your CLI discovers and signals live workers (PID files, control socket, DB rows, etc.) is a design decision.

Document both your chosen design and rejected alternatives in `DECISIONS.md`.

---

# ⚙️ System Requirements

## 1. Job Execution

Workers execute the job's command via the shell.

Exit code determines:

- `0` → Success
- Non-zero → Failure (including command-not-found)
## 2. Retry & Backoff

Failed jobs retry automatically after a delay:

```text
delay = base ^ attempts seconds
```

Where `attempts` is the number of completed attempts.

Example with the default base of `2`:

| Attempt | Delay |
|---------|-------|
| 1 | 2 seconds |
| 2 | 4 seconds |
| 3 | 8 seconds |

The default backoff base is `2`, configurable via:

```bash
queuectl config set backoff-base <value>
```

After `max_retries` failed attempts, the job moves to the Dead Letter Queue (`dead`).

```bash
queuectl dlq retry <id>
```

Re-enqueues a dead job.

Decide whether retrying from the DLQ resets `attempts`, and justify your choice in **DECISIONS.md**.

---

## 3. Persistence

All job data must survive process restarts.

You may use:

- File-based JSON
- SQLite
- Any other persistent storage you can justify

However, your locking strategy must actually work for the chosen storage backend.

---

## 4. Worker Management & Concurrency

Requirements:

- Multiple workers run in parallel.
- Workers may be started from **different terminal sessions**.
- These are **separate OS processes**, not merely threads.

### Important Constraint

A job **must never** be executed by two workers simultaneously.

In `DECISIONS.md`, point to the **exact line(s)** of code that make claiming a job atomic and explain why that mechanism is atomic across processes.

### Graceful Shutdown

On:

- `queuectl worker stop`
- `Ctrl+C`

Workers should:

1. Finish the current job.
2. Exit cleanly.

---

## 5. Configuration

The following settings must be configurable via CLI:

- Maximum retry count
- Backoff base

Configuration must persist across restarts.

Also document whether configuration changes affect jobs that have already been enqueued.

---

# 🧪 Automated Testing (Live During Interview)

During the interview, an automated test script will run against your real CLI.

The script covers at least the following scenarios:

## 1. Basic Job

A normal job completes successfully.

---

## 2. Retry & DLQ

A failing job:

- retries with exponential backoff
- eventually lands in the DLQ

---

## 3. Parallel Workers

Many jobs are executed across multiple workers.

Every job must execute **exactly once**.

---

## 4. Worker Crash Recovery

Workers receive `SIGKILL` while processing jobs.

After restarting workers:

- every job completes
- nothing remains permanently in the `processing` state

---

## 5. Persistence

Jobs survive a complete restart of the application.

---

### Important Notes

Failing scenarios **1–3** during the interview immediately ends the interview.

If something fails, you'll be asked to debug it live.

The evaluation includes **how you diagnose problems under pressure**, not only whether the implementation works.

The automated script assumes the CLI interface contract exactly as specified.

Changing CLI behavior—even if your implementation is technically correct—will cause the tests to fail.

---

# 📋 Deliverables

Your submission must include:

- ✅ Working `queuectl` CLI
- ✅ All required commands implemented
- ✅ Persistent storage
- ✅ Retry with exponential backoff
- ✅ Dead Letter Queue (DLQ)
- ✅ Crash recovery
- ✅ `README.md`
- ✅ `DECISIONS.md`
- ✅ Incremental Git history
- ✅ Short CLI demo recording (linked from README)

---

# DECISIONS.md (Required)

Answer these five questions clearly and specifically.

Generic answers receive **zero credit**.

1. Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?

2. A worker receives `SIGKILL` halfway through a job.

   Explain:

   - what state the job is in,
   - how it is recovered,
   - worst-case recovery delay.

3. Does `dlq retry` reset `attempts`?

   Explain why.
4. What designs did you consider and reject for `worker stop` (cross-process signaling), and why?

5. If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which parts would need to change?

---

# 🎙️ Live Review (30 Minutes)

Shortlisted candidates will participate in a screen-share interview consisting of three parts.

## 1. Automated Test Run (~10 minutes)

The interviewers will run their automated test suite against your code on your machine.

If any test fails, you are expected to debug the issue live while explaining your reasoning.

---

## 2. Design Defense (~10 minutes)

You will be asked detailed questions about:

- Your architecture
- Design decisions
- Edge cases
- Concurrency
- Crash recovery
- Trade-offs

These questions build upon the topics covered in `DECISIONS.md`, but may go deeper.

---

## 3. Live Code Change (~10 minutes)

You will implement one small feature or behavioral change to your own code live.

Examples include:

- Adding a new CLI command
- Modifying an existing command
- Changing retry behavior
- Tweaking configuration

The focus is **how well you understand and navigate your own codebase**, not whether you finish every change.

---

## Environment

Before the interview, ensure that:

- Your repository is cloned locally.
- The project runs successfully.
- `bash` is available.
- `python3` is available.

You may also receive one additional requirement change by email after submission, with **48 hours** to implement it.

Design your solution with future changes in mind.

---

# 📊 Evaluation Criteria

| Criteria | Weight | Description |
|----------|--------|-------------|
| Automated Test Run | Gate | Failing scenarios 1–3 ends the interview |
| Functionality | 20% | Full command surface, DLQ, configuration |
| Robustness | 20% | Crash recovery, concurrency safety, edge cases |
| Live Review | 30% | Ability to explain and modify your own system |
| Code Quality | 15% | Structure, readability, idiomatic use of your chosen stack |
| `DECISIONS.md` + `README.md` | 15% | Specific, honest reasoning and real trade-offs |

---

# 🌟 Bonus (Optional)

Implementing any of the following features may strengthen your submission:

- Job timeouts
- Priority queues
- Scheduled jobs (`run_at`)
- Job output logging
- Metrics
- Minimal web dashboard

---

# ⚠️ Disqualification

Your submission may be rejected if any of the following occur:

- Fails scenarios **1–3** during the live automated test run.
- Duplicate execution of the same job.
- Jobs are lost after restart.
- Jobs remain permanently stuck in the `processing` state after a worker crash.
- You cannot explain your own code during the live review.
- Missing `DECISIONS.md`.
- `DECISIONS.md` contains vague or evasive answers.

---

# 🧾 Submission

1. Push your project to a **public GitHub repository** with genuine incremental commit history.

2. Include the following files:

   - `README.md`
   - `DECISIONS.md`
   - Link to the CLI demo recording

3. Share the GitHub repository link for review.

---

# ✅ Summary Checklist

- [ ] Working `queuectl` CLI
- [ ] Foreground workers
- [ ] Graceful shutdown
- [ ] Crash recovery
- [ ] Persistent storage
- [ ] Parallel workers
- [ ] Atomic job claiming
- [ ] Exponential backoff
- [ ] Dead Letter Queue (DLQ)
- [ ] Configurable retries
- [ ] Configurable backoff base
- [ ] `README.md`
- [ ] `DECISIONS.md`
- [ ] Incremental Git history
- [ ] CLI demo recording
- [ ] Passes all five automated test scenarios