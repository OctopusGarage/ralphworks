---
name: bug-hunt-method
description: Find and fix confirmed correctness defects with regression evidence
---

Inspect the requested scope and its boundary contracts, recent failure evidence, and existing tests. Search for concrete correctness and reliability failures, giving priority to user impact, authorization, accounting, state, concurrency, retries, and idempotency where applicable.

Before changing code, establish an evidence chain: triggering inputs or sequence, expected behavior from a real contract, actual behavior, impact, and the responsible execution path. Trace across callers, adapters, state stores, and result readers when the defect spans a boundary. A suspicion or stylistic preference is not a confirmed defect.

Create a regression test or reproducible check that fails for the observed cause. Repair one cause at a time with the smallest compatible change and verify both the regression and relevant existing behavior. For asynchronous work inspect success, error, timeout, cancellation, replacement, and shutdown paths where they exist; do not demand unrelated infrastructure.

Do not bundle speculative fixes, style cleanup, or architecture rewrites. Stop when no confirmed defect is available within scope and budget. Clearly distinguish fixed defects, deferred confirmed defects, and unverified hypotheses in the enclosing task's report.

Rank candidate paths by impact and evidence before spending the fix budget. A confirmed no-op is preferable to changing a suspicious pattern without a contract violation. Use references/evidence.md to keep confirmed defects, repaired defects, and hypotheses distinct, and stop investigating when the enclosing budget is exhausted.
