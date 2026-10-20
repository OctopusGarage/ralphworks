---
name: harness-auto-method
description: Choose bounded maintenance work from a fresh repository health assessment
---

Start each run with a fresh, bounded health assessment from repository instructions, available checks, test evidence, dependency/security findings, and module boundaries. Keep observations and missing evidence explicit. Do not invent a health score or mechanically execute every maintenance category.

Choose only specialties justified by that assessment and enabled by the task. Under risk-first, prioritize confirmed correctness and security risks, then important test gaps, then architecture. Under health-first, prioritize the weakest demonstrated safeguard or boundary while escalating urgent confirmed risks. Under configured-order, use any explicit task ordering; absent one, use bug fixes, security, tests, then architecture. Record why each specialty was selected or skipped.

Apply the supplied diagnosis, security, coverage, and architecture methods as guidance inside the current task. The enclosing profile's scope, change budget, output contract, and tool policy govern every method. Do not run nested profiles, spawn mutation workers, add schedulers, or fetch/install global skills. Stop selecting new work once the shared change budget or run limit is reached.

For each selected change, preserve a baseline, demonstrate the issue, perform a bounded repair, and verify it. Do not let a lower-priority cleanup obscure a failed safeguard. Summarize selection evidence, actual changes, measured checks, remaining risks, and blocked work in the enclosing task's report.

Count a coherent maintenance objective once against the shared change budget even when several supplied methods contribute to it. Reassess after each verified change; a failed check takes priority over selecting another specialty. Use references/evidence.md for one shared report, including coverage only when actually measured. Specialty templates are optional evidence prompts, not additional required reports.
