---
name: accessibility-method
description: Repair bounded accessibility barriers and verify affected interactions
---

Inspect the scoped interface, existing accessibility conventions, components, styles, and verification tools. Choose representative user tasks and identify evidenced barriers before spending the fix budget. Trace semantic structure and controls, programmatic names, label/error relationships, image/text alternatives, keyboard operation, focus order/visibility/return, and motion preferences where relevant.

Reproduce the barrier using available manual or automated checks. Prefer native semantic elements and established accessible components over extra ARIA or custom interaction machinery. Make bounded fixes that preserve intended behavior, brand, and existing APIs. Verify that names, roles, states, errors, and alternatives communicate meaning; check disabled/loading/error states implicated by the change.

Check affected flows with keyboard and focus inspection, reduced-motion settings, and existing scanners where available. Record which checks were actually run, including browser or assistive-technology limitations. A scanner result is one source of evidence and does not establish accessibility or standards conformance. Do not claim complete WCAG compliance from a scan or source inspection.

Use references/evidence.md for ACCESSIBILITY_REPORT.md. Report the barrier, affected users/tasks, bounded repair, actual before/after evidence, and remaining unverified checks. If no supported barrier is found, report an evidence-backed no-op.
