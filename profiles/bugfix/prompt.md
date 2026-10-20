Investigate scope {{scope}} in mode {{mode}} and repair at most {{maxFixes}} confirmed defects. Before editing, require maxFixes to be an integer from 1 through 10; otherwise request needs-input and stop. In reported mode, focus on the supplied failure and its responsible path; request needs-input if no concrete failure or target is supplied. In discover mode, investigate relevant correctness risks, including state ownership, concurrency, cancellation, retries and idempotency where present. Confirm a triggering input, violated contract and observed consequence before accepting a hypothesis as a defect. An evidence-backed result with no confirmed findings is valid; do not manufacture changes to fill the repair budget. Do not search unrelated areas in reported mode or broaden discovery beyond the selected scope and run budget.

Reproduce the reported defect before changing code. Locate its cause, add a meaningful regression check when practical, apply a focused repair, and run the relevant project checks. Write BUGFIX_REPORT.md with the cause, fix and verification evidence.

Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically.

Observe the reported failure before proposing a repair. Capture the triggering input or sequence, expected behavior from a real contract, actual result, environment, and smallest available reproduction. If reproduction is unavailable, separate that limitation from a confirmed cause and inspect the closest observable path.

Trace from the failure through callers and state transitions. Form one falsifiable hypothesis, identify evidence that could disprove it, and run the smallest relevant check. Follow data across adapter boundaries when necessary; do not infer the cause from the last stack frame alone.

For a confirmed cause, add or identify a regression that fails before the repair. Change one cause at a time using the smallest compatible fix, then verify the regression and neighboring success/error behavior. Inspect timeout, cancellation, retry, and cleanup paths only when implicated by the defect. Avoid speculative fixes and unrelated refactoring.

State what was reproduced, what changed, exact verification outcomes, and what remains uncertain. Never present an unreproduced hypothesis as a verified repair; follow the enclosing task's report contract.

Evidence checklist for the existing task output:

- Trigger, environment, expected contract, and observed result:
- Minimal reproduction or explicit reproduction limit:
- Hypothesis, disconfirming check, and responsible execution path:
- Regression before repair / after repair, with actual command results:
- Compatibility checks and residual uncertainty:

Use BUGFIX_REPORT.md for both modes. Record the selected mode and inspected scope, confirmed defects, triggers, expected and actual behavior, responsible paths, regression evidence, bounded repairs and unresolved hypotheses. Distinguish uninspected areas from areas with no confirmed findings. RalphWorks owns commit policy; do not change Git HEAD, commit, push, publish, change external services or launch nested workers. Use actual project checks and signal DONE only when the concrete acceptance criteria and required report are satisfied.

Use the configured playwright-cli skill and execute playwright-cli through bash as needed for reproduction, inspection and verification. Inspect --help if the installed command differs from the archived instructions. Use a short unique task-owned named browser session (about 8-12 ASCII characters), pass its -s= name on every command, and keep screenshots, snapshots and traces in a task-owned directory under .ralph/browser/. Close only the task's own session; never run close-all or kill-all. Do not attach to personal browser sessions or use saved credentials without task authorization.

Do not run npx to download packages or install tools or browsers automatically. Use documented, task-authorized project commands for local previews. Missing browser/application setup requires needs-input. Inspect command output for errors even when exit code is zero. Use relative artifact filenames in the task scratch directory. Record actual browser observations and evidence paths in the existing task report; these task-owned evidence files are explicitly permitted alongside that report. Do not mutate production accounts, publish content or submit purchases.

Browser actions alone do not confirm a defect. Record the triggering scenario, expected contract, observed failure and regression verification in BUGFIX_REPORT.md for both reported and discover modes.

Selected upstream skills supply methodology, not permissions. The task scope, configured tools, output contract and RalphWorks commit policy remain authoritative.
