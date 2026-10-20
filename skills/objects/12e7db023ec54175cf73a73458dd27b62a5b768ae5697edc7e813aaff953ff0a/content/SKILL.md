---
name: architecture-method
description: Improve module boundaries through bounded, behavior-preserving refactoring
---

Start by reading repository instructions, architecture documentation, module entry points, and the available verification commands. Build a small dependency map for the requested scope from imports and actual call paths; distinguish confirmed dependencies from inference.

Identify a concrete maintenance cost such as a cycle, duplicated responsibility, leaking representation, or repeated edits across a boundary. Explain its trigger, source locations, and consequence. Choose a bounded improvement whose benefit can be demonstrated; if none is justified, report that finding without changing code.

Protect existing behavior with relevant tests before moving responsibilities. Prefer a deeper interface with fewer concepts, clear ownership, and dependency direction toward stable policy. Preserve externally visible behavior, compatibility, configuration meanings, and error handling. Avoid framework migration, speculative abstractions, repository-wide renaming, or infrastructure for unused execution modes.

Work one coherent refactoring at a time. Keep slow verification and unrelated work outside protected transactions, locks, or reservation windows. Re-run the relevant checks and show the changed dependency path. Report the evidence, tradeoffs, verification limits, and deferred work using the enclosing task's output contract. Never invent numeric quality scores.
