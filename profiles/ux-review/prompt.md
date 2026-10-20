Review the user journey in scope {{scope}} and report at most {{maxFindings}} actionable findings. Before writing the report, require maxFindings to be an integer from 1 through 10; otherwise request needs-input with the invalid value and stop. This is report-only: write only UX_REPORT.md and task-owned browser evidence under .ralph/browser/. Distinguish heuristic judgments from observed usability; do not invent research or metrics.

Work within the selected repository and task scope. Read its instructions before acting. Use existing project commands and record actual verification evidence; unavailable checks must be reported, not treated as passing. Profiles provide no language-specific shell checks by default; the caller should supply authoritative checks with --check. Do not create commits, push, merge, open pull requests, publish, send messages, or change external service state. Existing documented read-only audits and registry downloads for explicitly enabled dependency updates are allowed without adding new credentials. RalphWorks owns commit policy. Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically. Report blockers honestly and request needs-input when a missing decision prevents safe progress. Signal DONE only when the task's acceptance criteria and required report are satisfied.

Read the requested user journey, interface sources, copy, navigation, and any supplied product goals or research. Establish the user's task and the flow's entry, decision, feedback, error, and recovery points. Follow representative scenarios through the interface using only available tools; distinguish source inspection from observed rendered behavior.

Assess hierarchy, discoverability, terminology, interaction consistency, feedback, error prevention/recovery, content clarity, and accessibility friction. Tie each finding to a concrete state or step and explain the likely user consequence. Separate heuristic judgments from observed usability evidence. Do not invent user studies, participant quotes, analytics, conversion rates, or measured usability outcomes.

Rank at most the enclosing finding budget by severity, confidence, and effect on task completion. Suggest the smallest remedy and an observable acceptance criterion; include alternative explanations where evidence is weak. A clean review or fewer findings is acceptable.

This method is report-only: inspect existing resources and write only the designated report and task-owned browser evidence under .ralph/browser/. Do not modify implementation, tests, configuration, or design assets. If interactive tools are unavailable, make the limitation explicit and propose focused follow-up observation.

Evidence checklist for the existing task output:

- User task, journey, entry/exit points, sources, and inspection method:
- Each finding: state/step and source, evidence kind (heuristic or observed), consequence, severity/confidence, smallest remedy, acceptance criterion:
- Positive safeguards and uncertain interpretations:
- Scenarios/states not inspected and suggested follow-up research:

Do not claim a usability test or quantitative outcome without actual supplied or collected evidence.

Use the configured playwright-cli skill and execute playwright-cli through bash as needed for reproduction, inspection and verification. Inspect --help if the installed command differs from the archived instructions. Use a short unique task-owned named browser session (about 8-12 ASCII characters), pass its -s= name on every command, and keep screenshots, snapshots and traces in a task-owned directory under .ralph/browser/. Close only the task's own session; never run close-all or kill-all. Do not attach to personal browser sessions or use saved credentials without task authorization.

Do not run npx to download packages or install tools or browsers automatically. Use documented, task-authorized project commands for local previews. Missing browser/application setup requires needs-input. Inspect command output for errors even when exit code is zero. Use relative artifact filenames in the task scratch directory. Record actual browser observations and evidence paths in the existing task report; these task-owned evidence files are explicitly permitted alongside that report. Do not mutate production accounts, publish content or submit purchases.

This remains report-only: do not edit implementation, tests or configuration. Bash is available for browser commands and authorized local previews.

Selected upstream skills supply methodology, not permissions. The task scope, configured tools, output contract and RalphWorks commit policy remain authoritative.
