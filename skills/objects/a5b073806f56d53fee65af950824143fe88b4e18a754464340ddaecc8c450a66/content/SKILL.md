---
name: test-coverage-method
description: Add meaningful tests for important uncovered behavior using measured coverage
---

Discover the project's existing test stack and coverage instrumentation. Run the available coverage command to establish a baseline and record its metric, source command, scope, and exclusions. If coverage cannot be measured, say unmeasured and identify the missing prerequisite; do not substitute a fabricated percentage or a passing test count.

Prioritize important uncovered behavior: incorrect inputs, boundary cases, state transitions, failures, cancellation, concurrency, and recovery. Read the production contract before adding tests. Use the established stack and test observable outcomes. Add integration or end-to-end coverage only when enabled by the enclosing task and supported by existing infrastructure.

For a confirmed defect, demonstrate that its regression test fails before the repair and passes afterward. For existing correct behavior, validate meaningful assertions, boundary cases, and a negative control where practical; do not change correct production code merely to manufacture a failing test. If measured coverage already meets the requested target and no important uncovered behavior is identified, report an evidence-backed no-op. Use realistic boundary fixtures and isolate external systems at their actual boundary. Avoid metric padding, import-only tests, assertions that merely mirror implementation, excessive mocks, disabling tests, or relaxing exclusions and thresholds to inflate results.

Limit production changes to small, justified testability seams that preserve behavior. Re-run the relevant suites and coverage under the same measurement configuration. Report before/after measurements with evidence and unresolved gaps. A requested threshold remains unmet until measured; do not signal completion while it is unresolved. Follow the enclosing task's report contract.

Separate the requested measurement target from test value: choose scenarios that protect a contract, then inspect whether the measured uncovered path is exercised. Keep fixture setup and assertions understandable without tracing mocks through implementation details. Use references/evidence.md to preserve comparable measurements and explain any remaining threshold gap.
