---
name: bugfix-method
description: Diagnose and fix a reproducible defect
---

Observe the reported failure before proposing a repair. Capture the triggering input or sequence, expected behavior from a real contract, actual result, environment, and smallest available reproduction. If reproduction is unavailable, separate that limitation from a confirmed cause and inspect the closest observable path.

Trace from the failure through callers and state transitions. Form one falsifiable hypothesis, identify evidence that could disprove it, and run the smallest relevant check. Follow data across adapter boundaries when necessary; do not infer the cause from the last stack frame alone.

For a confirmed cause, add or identify a regression that fails before the repair. Change one cause at a time using the smallest compatible fix, then verify the regression and neighboring success/error behavior. Inspect timeout, cancellation, retry, and cleanup paths only when implicated by the defect. Avoid speculative fixes and unrelated refactoring.

Use references/evidence.md for the diagnosis and handoff. State what was reproduced, what changed, exact verification outcomes, and what remains uncertain. Never present an unreproduced hypothesis as a verified repair; follow the enclosing task's report contract.
