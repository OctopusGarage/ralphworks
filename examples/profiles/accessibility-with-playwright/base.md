Inspect scope {{scope}} and repair at most {{maxFixes}} evidenced accessibility barriers. Before editing, require maxFixes to be an integer from 1 through 10; otherwise request needs-input with the invalid value and stop. Verify relevant semantics, keyboard/focus, names, errors, alternatives, and motion with available tools. Record baseline/after evidence and limitations in ACCESSIBILITY_REPORT.md. Do not claim standards conformance from scanner results.

Work within the selected repository and task scope. Read its instructions before acting. Use existing project commands and record actual verification evidence; unavailable checks must be reported, not treated as passing. Profiles provide no language-specific shell checks by default; the caller should supply authoritative checks with --check. Do not create commits, push, merge, open pull requests, publish, send messages, or change external service state. Existing documented read-only audits and registry downloads for explicitly enabled dependency updates are allowed without adding new credentials. RalphWorks owns commit policy. Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically. Report blockers honestly and request needs-input when a missing decision prevents safe progress. Signal DONE only when the task's acceptance criteria and required report are satisfied.

Inspect the scoped interface, existing accessibility conventions, components, styles, and verification tools. Choose representative user tasks and identify evidenced barriers before spending the fix budget. Trace semantic structure and controls, programmatic names, label/error relationships, image/text alternatives, keyboard operation, focus order/visibility/return, and motion preferences where relevant.

Reproduce the barrier using available manual or automated checks. Prefer native semantic elements and established accessible components over extra ARIA or custom interaction machinery. Make bounded fixes that preserve intended behavior, brand, and existing APIs. Verify that names, roles, states, errors, and alternatives communicate meaning; check disabled/loading/error states implicated by the change.

Check affected flows with keyboard and focus inspection, reduced-motion settings, and existing scanners where available. Record which checks were actually run, including browser or assistive-technology limitations. A scanner result is one source of evidence and does not establish accessibility or standards conformance. Do not claim complete WCAG compliance from a scan or source inspection.

Report the barrier, affected users/tasks, bounded repair, actual before/after evidence, and remaining unverified checks. If no supported barrier is found, report an evidence-backed no-op.

Evidence checklist for the existing task output:

- Scoped tasks, components, and available checking tools:
- Barrier: trigger/state, source, impacted interaction, baseline evidence:
- Bounded fix: semantics/names/errors/alternatives/keyboard/focus/motion as applicable:
- Before/after manual and automated checks, exact commands/tools and results:
- Browser/assistive technology and states actually checked; unavailable checks:
- Residual barriers and follow-up; no conformance conclusion from scanner-only evidence:
