---
name: coding-method
description: Implement a focused code change
---

Read repository instructions and the relevant architecture, public interface, callers, and tests. Turn the objective into observable acceptance criteria; identify compatibility, data, and failure behavior before editing. Trace the existing execution path and choose the smallest complete change that fits its owning module.

Implement one useful increment at a time. Reuse established boundaries and conventions; introduce an abstraction only when the requested behavior gives it a concrete responsibility. Preserve error handling and public contracts unless the task explicitly changes them. Keep unrelated cleanup out of the change.

Choose verification that would catch the requested behavior. Demonstrate a defect's regression before repairing it; for new behavior cover important success and failure outcomes using the existing stack. Avoid assertions that merely repeat the implementation. Run relevant project checks and inspect the resulting diff for accidental API or data changes.

Use references/evidence.md to record acceptance evidence, commands and actual results, changed behavior, and unresolved limitations. Follow the enclosing task's output contract; the template does not require an extra file.
