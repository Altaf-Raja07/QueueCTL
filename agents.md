# QueueCTL AI Agent Developer Guide (agents.md)

Welcome, AI Agent! This guide outlines the architecture, database schema, file layout, state transitions, and guidelines for developing and debugging **QueueCTL**.

---

## 1. Project Overview
**QueueCTL** is a CLI-based background job queue system written in Node.js. It runs without an external broker (like Redis or RabbitMQ) by using a local SQLite database (`better-sqlite3`) in WAL (Write-Ahead Logging) mode.

- **OS Environment:** Linux-first (advisory file locking, signal handling for SIGTERM/SIGINT, process signaling).
- **Concurrency model:** Supports multiple concurrent workers running in separate terminal sessions (different OS processes) or as concurrent async loops within a single process.
- **Safety guarantee:** Jobs are claimed atomically using a single SQL query to prevent double-claiming.
- **Persistence:** Job states and configuration keys survive restarts.

---

## 2. File Directory Structure

```
/
├── bin/
│   └── queuectl.js      # Commander CLI parser (handles user interactions/commands)
├── src/
│   ├── db.js            # Database initializer & connection pool (better-sqlite3)
│   ├── config.js        # Persistent key-value store wrapper (config table)
│   ├── queue.js         # Core queue operations (enqueue, list, status, DLQ)
│   └── worker.js        # Worker logic (poll loops, claiming, exec, crash recovery)
├── test/                # Test suite (uses standard assert)
│   ├── run-all.js       # Test runner script
│   └── e2e-*.js / unit  # Test cases
├── .queuectl/           # Generated runtime directory
│   ├── queuectl.db      # SQLite database file
│   └── workers/         # PID registry files (<pid>.pid)
├── README.md            # Main user documentation
├── DECISIONS.md         # Documented architectural decisions (essential read)
└── agents.md            # This file
```

---

## 3. Database Schema

SQLite connection is configured in `src/db.js` with `journal_mode = WAL` and `foreign_keys = ON`.

### `jobs` Table
Tracks job metadata, execution command, attempts, and state.
* **`id`** (`TEXT PRIMARY KEY`): Unique user-defined identifier.
* **`command`** (`TEXT NOT NULL`): The shell command to run.
* **`state`** (`TEXT CHECK(state IN (...))`): `pending`, `processing`, `completed`, `failed`, or `dead`.
* **`attempts`** (`INTEGER DEFAULT 0`): Number of failed execution attempts so far.
* **`max_retries`** (`INTEGER DEFAULT 3`): Limit before moving the job to the Dead Letter Queue.
* **`next_attempt_at`** (`TEXT`): ISO8601 timestamp for retry scheduling (backoff).
* **`claimed_at`** (`TEXT`): ISO8601 timestamp when a worker claimed the job (heartbeat).
* **`worker_pid`** (`INTEGER`): PID of the worker currently running the job.
* **`last_error`** (`TEXT`): Error message/exit code from the last failure.
* **`created_at`** / **`updated_at`** (`TEXT`): Timestamps.

### `config` Table
Tracks persistent global configurations.
* **`key`** (`TEXT PRIMARY KEY`): The config name (e.g., `max_retries`, `backoff_base`).
* **`value`** (`TEXT NOT NULL`): The string value.

---

## 4. Job State Machine & Transitions

```
                    [ Enqueue ]
                         │
                         ▼
                    ┌──────────┐
                    │  pending │◄────────────────────────────┐
                    └────┬─────┘                              │
                         │ claim (Atomic UPDATE)              │
                         ▼                                    │
                    ┌──────────┐                              │
                    │processing│                              │
                    └────┬─────┘                              │
                      ┌──┴──┐                                 │
                      ▼      ▼                                │
                ┌────────┐ ┌──────┐                           │
                │completed│ │failed│──retry (backoff delay)───┘
                └────────┘ └──┬───┘
                              │ attempts >= max_retries
                              ▼
                         ┌──────┐
                         │ dead │ (DLQ State)
                         └──────┘
```

---

## 5. Critical Code Sections

### Atomic Job Claiming (`src/worker.js`)
To prevent two processes from claiming the same job, we execute a single SQL `UPDATE` statement containing an ordering subquery:
```javascript
db.prepare(`
  UPDATE jobs
  SET state = 'processing',
      claimed_at = ?,
      worker_pid = ?,
      updated_at = ?
  WHERE id = (
    SELECT id FROM jobs
    WHERE state IN ('pending', 'failed')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC
    LIMIT 1
  )
  RETURNING *
`).get(now, process.pid, now, now);
```
* **AI Tip:** SQLite serializes all writes using advisory locks on the database file. Because `better-sqlite3` runs synchronously, this query is entirely thread-safe and process-safe without needing application-level mutexes.

### Crash Recovery (`src/worker.js`)
If a worker process dies abruptly via `SIGKILL`:
1. The job is left stranded in the `processing` state.
2. The `sweepStaleJobs()` function checks for jobs in `processing` where the `claimed_at` timestamp is older than `stale_timeout_seconds` (default: 15s).
3. The query resets those jobs back to `pending`, clears `worker_pid` and `claimed_at`, and leaves `attempts` untouched (infrastructure failures do not deduct from the retry budget).

### Graceful Shutdown (`src/worker.js`)
On `SIGTERM` or `SIGINT`, workers set `shuttingDown = true`. The current job continues running, but the worker will not claim new jobs. Once the job finishes, the worker deregisters its PID file and exits cleanly.

---

## 6. Developing & Testing

### Running Tests
To run all automated unit and integration tests:
```bash
npm test
```

### Clearing State / Starting Fresh
To wipe the database and clean up PID worker files:
```bash
rm -rf .queuectl
```
The database and directory will be automatically re-created on the next command.
