Review scope {{scope}} and repair at most {{maxFixes}} confirmed security findings. Dependency updates allowed: {{allowDependencyUpdates}}; configuration hardening allowed: {{allowConfigHardening}}. Before editing, require maxFixes to be an integer from 1 through 10; otherwise request needs-input and stop. Honor disabled change categories, report affected findings as deferred, and do not bypass them. Use established local scanners, audit commands, and direct source evidence. Write SECURITY_REPORT.md with finding severity, reachability and impact evidence, smallest compatible repair, verification commands and outcomes, and deferred risks. If the task's security acceptance criteria cannot be verified, report the blocker and do not claim they passed.

Work within the selected repository and task scope. Read its instructions before acting. Use existing project commands and record actual verification evidence; unavailable checks must be reported, not treated as passing. Profiles provide no language-specific shell checks by default; the caller should supply authoritative checks with --check. Do not create commits, push, merge, open pull requests, publish, send messages, or change external service state. Existing documented read-only audits and registry downloads for explicitly enabled dependency updates are allowed without adding new credentials. RalphWorks owns commit policy. Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically. Report blockers honestly and request needs-input when a missing decision prevents safe progress. Signal DONE only when the task's acceptance criteria and required report are satisfied.

Read repository security guidance and identify existing local audit, dependency, secret, and static-analysis commands. Use available high-signal findings and trace the vulnerable input through the reachable code path. Separate confirmed exposure, scanner-only signals needing investigation, and unreachable or unsupported hypotheses. Avoid printing credential values in evidence.

Prioritize demonstrated exploitability and impact. For each confirmed finding, capture the trigger, affected trust boundary, source or dependency version, reachability proof, and expected protection. Do not make speculative security changes merely because a pattern looks unfamiliar.

Respect the enclosing task's limits on dependency updates and configuration hardening. Apply the smallest compatible dependency or code/configuration repair, preserve required functionality, and update lockfiles through the existing package manager when applicable. Add regression tests that demonstrate the protection and run established checks. Do not suppress scanners, add broad ignores, weaken policy, perform unrelated upgrades, rotate credentials, or change external services.

Re-run the relevant audit or scanner where available and explain residual findings, unavailable tooling, compatibility risks, and what was actually verified. No findings within a bounded scan is not proof of complete security. Use the enclosing task's report contract.

Check the proposed repair against both the hostile input and the legitimate workflow. A version advisory alone does not establish application reachability, and a clean scanner alone does not prove the boundary is protected.

Evidence checklist for the existing task output:

- Advisory/scanner/source location and affected version or trust boundary:
- Hostile trigger and reachability evidence; confidence and missing evidence:
- Protection expected, bounded repair, dependency/lockfile compatibility:
- Exploit regression and legitimate-path checks, with actual outcomes:
- Relevant rescan result, unresolved findings, and unavailable tooling:

Redact credential values; record identifiers or locations only.
