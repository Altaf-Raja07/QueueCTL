# QueueCTL - Backend Developer Internship Assignment

## Tech Stack

Choose any one:

- Node.js
- Go
- Python
- Java

---

# Submission

Submit:

- Public GitHub Repository
- README.md

---

# Objective

Build a CLI-based background job queue system called **queuectl**.

The system should:

- Manage background jobs
- Run jobs using worker processes
- Retry failed jobs using exponential backoff
- Maintain a Dead Letter Queue (DLQ)
- Persist job data across restarts

---

# Problem Overview

Implement a minimal production-grade job queue system that supports:

- Enqueuing background jobs
- Managing background jobs
- Running multiple worker processes
- Automatic retries
- Exponential backoff
- Dead Letter Queue (DLQ)
- Persistent storage
- CLI-based interaction

---

# Job Specification

Every job must contain at least the following fields:

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

# Job Lifecycle

| State | Description |
|--------|-------------|
| pending | Waiting to be picked up by a worker |
| processing | Currently being executed |
| completed | Successfully executed |
| failed | Failed but retryable |
| dead | Permanently failed (moved to DLQ) |

---

# CLI Commands

## Enqueue

```bash
queuectl enqueue '{"id":"job1","command":"sleep 2"}'
```

Adds a new job.

---

## Start Workers

```bash
queuectl worker start --count 3
```

Starts one or more workers.

---

## Stop Workers

```bash
queuectl worker stop
```

Stops workers gracefully.

---

## Status

```bash
queuectl status
```

Shows:

- Job counts
- Worker information

---

## List Jobs

```bash
queuectl list --state pending
```

Lists jobs filtered by state.

---

## Dead Letter Queue

List dead jobs

```bash
queuectl dlq list
```

Retry a dead job

```bash
queuectl dlq retry job1
```

---

## Configuration

Example:

```bash
queuectl config set max-retries 3
```

Configuration should support things like:

- Retry count
- Backoff base

---

# System Requirements

## 1. Job Execution

Workers must execute shell commands.

Examples:

```bash
echo hello
```

```bash
sleep 2
```

Exit code determines success or failure.

Invalid commands must fail.

---

## 2. Retry & Backoff

Failed jobs retry automatically.

Use exponential backoff.

Formula:

```
delay = base ^ attempts
```

Example:

Base = 2

Attempt 1 → 2 seconds

Attempt 2 → 4 seconds

Attempt 3 → 8 seconds

After max retries:

Move job to Dead Letter Queue.

---

## 3. Persistence

Jobs must survive application restart.

Acceptable storage:

- SQLite
- JSON
- Embedded database
- Any reasonable persistent storage

---

## 4. Worker Management

Support multiple workers.

Workers should execute jobs in parallel.

Prevent duplicate processing.

Implement locking.

Workers should shut down gracefully.

Current job should finish before exiting.

---

## 5. Configuration

Configuration should allow changing:

- Retry count
- Backoff base

Configuration should be accessible via CLI.

---

# Expected Test Scenarios

The project should successfully demonstrate:

## Scenario 1

Basic job completes successfully.

---

## Scenario 2

Failed job retries.

Eventually moves to DLQ.

---

## Scenario 3

Multiple workers process jobs without overlap.

---

## Scenario 4

Invalid commands fail correctly.

---

## Scenario 5

Job data survives restart.

---

# Must-Have Deliverables

- Working CLI application
- Persistent storage
- Multiple worker support
- Retry mechanism
- Exponential backoff
- Dead Letter Queue
- Configuration management
- Clean CLI
- README
- Modular architecture
- Basic testing

---

# README Expectations

README should include:

## 1. Setup Instructions

How to install.

How to run.

---

## 2. Usage

CLI examples.

Expected outputs.

---

## 3. Architecture Overview

Explain:

- Job lifecycle
- Worker logic
- Persistence
- Retry mechanism

---

## 4. Assumptions & Trade-offs

Explain design decisions.

Mention simplifications.

---

## 5. Testing

Explain how to verify:

- Queue
- Workers
- Retry
- DLQ

---

# Evaluation Criteria

| Criteria | Weight |
|-----------|---------|
| Functionality | 40% |
| Code Quality | 20% |
| Robustness | 20% |
| Documentation | 10% |
| Testing | 10% |

---

# Bonus Features

Optional features:

- Job timeout
- Priority queue
- Scheduled jobs (`run_at`)
- Job output logging
- Metrics
- Execution statistics
- Minimal monitoring dashboard

---

# Common Mistakes (Disqualification Risks)

Avoid:

- Missing retry mechanism
- Missing DLQ
- Duplicate job execution
- Race conditions
- Non-persistent storage
- Hardcoded configuration
- Poor README

---

# Submission Checklist

- Push to a public GitHub repository.
- Include README.md.
- Record a CLI demo.
- Upload demo video.
- Include demo link inside README.
- Optional: architecture.md or design.md

---

# Final Checklist

- All CLI commands work.
- Jobs persist after restart.
- Retry works.
- Exponential backoff works.
- DLQ works.
- Workers support concurrency.
- CLI is documented.
- Code is modular.
- Basic tests included.