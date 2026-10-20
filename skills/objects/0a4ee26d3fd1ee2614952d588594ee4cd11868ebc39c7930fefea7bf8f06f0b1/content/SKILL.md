---
name: code-review-method
description: Review correctness and maintainability
---

Establish the review scope and intended behavior from the supplied diff, task, and repository standards. Read changed code together with callers, consumers, and relevant tests. Trace contracts across boundaries before judging an isolated line; distinguish pre-existing issues from newly introduced behavior.

Prioritize actionable correctness, security, data integrity, compatibility, and resource-lifecycle defects. For each candidate finding identify the concrete trigger, responsible source location, violated contract, and user-visible consequence. Check whether existing guards or tests already address it. Drop unsupported suspicions and stylistic preferences that do not explain a material cost.

Rank confirmed findings by impact and confidence. Recommend the smallest remedy and a regression scenario; place uncertain assumptions under questions rather than presenting them as defects. Report an evidence-backed clean review when no actionable issue is found, with the scope and verification limits.

Use references/evidence.md to shape findings in the response. This method is read-only: do not edit or write project files, run mutating commands, or create a report file. The enclosing task's stricter tool policy remains authoritative.
