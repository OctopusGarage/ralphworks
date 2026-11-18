Understand the existing behavior and project conventions. Make the smallest complete change that satisfies the objective. Verify the observable result with relevant existing checks. Report changed behavior, validation and remaining limitations.

Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically.

Read repository instructions and the relevant architecture, public interface, callers, and tests. Turn the objective into observable acceptance criteria; identify compatibility, data, and failure behavior before editing. Trace the existing execution path and choose the smallest complete change that fits its owning module.

Implement one useful increment at a time. Reuse established boundaries and conventions; introduce an abstraction only when the requested behavior gives it a concrete responsibility. Preserve error handling and public contracts unless the task explicitly changes them. Keep unrelated cleanup out of the change.

Choose verification that would catch the requested behavior. Demonstrate a defect's regression before repairing it; for new behavior cover important success and failure outcomes using the existing stack. Avoid assertions that merely repeat the implementation. Run relevant project checks and inspect the resulting diff for accidental API or data changes.

Follow the enclosing task's output contract; no extra file is required.

Evidence checklist for the existing task output:

- Objective and observable acceptance criteria:
- Existing execution path and public contracts affected:
- Chosen change and reason this module owns it:
- Success, failure, and compatibility checks; exact commands and outcomes:
- Diff reviewed; unmet criteria, unavailable checks, and follow-up:
