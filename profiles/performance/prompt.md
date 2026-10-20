Inspect scope {{scope}} and make at most {{maxChanges}} evidence-supported performance changes. Before editing, require maxChanges to be an integer from 1 through 10; otherwise request needs-input with the invalid value and stop. Establish a real measured baseline and comparable after measurements before claiming improvement. Do not fabricate benchmarks or equate fixture measurements with production impact. Record commands, workload, environment, results, correctness checks, and limitations in PERFORMANCE_REPORT.md. If an acceptance target remains unmeasured or unresolved, request needs-input rather than signal DONE.

Work within the selected repository and task scope. Read its instructions before acting. Use existing project commands and record actual verification evidence; unavailable checks must be reported, not treated as passing. Profiles provide no language-specific shell checks by default; the caller should supply authoritative checks with --check. Do not create commits, push, merge, open pull requests, publish, send messages, or change external service state. Existing documented read-only audits and registry downloads for explicitly enabled dependency updates are allowed without adding new credentials. RalphWorks owns commit policy. Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically. Report blockers honestly and request needs-input when a missing decision prevents safe progress. Signal DONE only when the task's acceptance criteria and required report are satisfied.

Define the scoped operation and its user-visible cost before optimizing. Discover existing benchmark, profiler, tracing, or timing facilities. Establish a real measured baseline with a reproducible workload, metric, input scale, environment, setup/warmup, repetition count, and variability. Distinguish fixture measurements from production observations. If instrumentation is unavailable, state what cannot be measured and request the missing decision or tooling; do not invent benchmarks.

Trace the measured bottleneck to its execution path. Compare the expected benefit, complexity, and correctness cost of a small set of candidates; choose only evidence-supported changes within the enclosing budget. An adequate baseline or inconclusive signal can justify a no-op. Do not add speculative caching, concurrency, or infrastructure without evidence.

Preserve observable results, errors, ordering, resource cleanup, and concurrency correctness. If caching is justified, establish freshness/invalidation, key scope, bounds, and invalidation races; if concurrency changes, test cancellation, shared-state races, and resource limits relevant to the path. Use existing dependencies and tooling where possible.

Repeat the baseline measurement with comparable inputs, environment, metric, setup, and repetitions after each change. Report regressions, variability, and confounding factors honestly. Claim an improvement only when actual comparable baseline/after evidence supports it; synthetic fixtures do not prove production impact. Identify unresolved acceptance targets in the report.

Evidence checklist for the existing task output:

- Operation and acceptance target; metric and workload rationale:
- Fixture vs production evidence; environment, input scale, warmup/setup, repetitions:
- Exact baseline measurement command and observed results/variability:
- Bottleneck evidence and selected change, alternatives deferred:
- Correctness checks including relevant races, cleanup, freshness/invalidation:
- Exact comparable after command/results; delta and limitations/confounders:
- Improvement supported, no-op, regression, or unmeasured/needs-input:
