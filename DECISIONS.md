# DECISIONS.md

## Q1 — Atomic Job Claiming

*Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?*

(To be filled in during Phase 7.)

---

## Q2 — Worker SIGKILL Recovery

*A worker receives SIGKILL halfway through a job. Explain what state the job is in, how it is recovered, and the worst-case recovery delay.*

(To be filled in during Phase 9.)

---

## Q3 — dlq retry: Reset Attempts?

*Does `dlq retry` reset `attempts`? Explain why.*

(To be filled in during Phase 6.)

---

## Q4 — Cross-Process worker stop: Considered & Rejected Designs

*What designs did you consider and reject for `worker stop` (cross-process signaling), and why?*

(To be filled in during Phase 8.)

---

## Q5 — Adding Priority Queues Tomorrow

*If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which parts would need to change?*

(To be filled in during Phase 13.)
