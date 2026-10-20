---
name: performance-method
description: Performance
---

Define the scoped operation and its user-visible cost before optimizing. Discover existing benchmark, profiler, tracing, or timing facilities. Establish a real measured baseline with a reproducible workload, metric, input scale, environment, setup/warmup, repetition count, and variability. Distinguish fixture measurements from production observations. If instrumentation is unavailable, state what cannot be measured and request the missing decision or tooling; do not invent benchmarks.

Trace the measured bottleneck to its execution path. Compare the expected benefit, complexity, and correctness cost of a small set of candidates; choose only evidence-supported changes within the enclosing budget. An adequate baseline or inconclusive signal can justify a no-op. Do not add speculative caching, concurrency, or infrastructure without evidence.

Preserve observable results, errors, ordering, resource cleanup, and concurrency correctness. If caching is justified, establish freshness/invalidation, key scope, bounds, and invalidation races; if concurrency changes, test cancellation, shared-state races, and resource limits relevant to the path. Use existing dependencies and tooling where possible.

Repeat the baseline measurement with comparable inputs, environment, metric, setup, and repetitions after each change. Report regressions, variability, and confounding factors honestly. Claim an improvement only when actual comparable baseline/after evidence supports it; synthetic fixtures do not prove production impact. Use references/evidence.md for PERFORMANCE_REPORT.md and identify unresolved acceptance targets.
