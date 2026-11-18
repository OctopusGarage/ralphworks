---
name: automation-governance-review-method
description: Review repository automation controls, recovery, and ownership without mutation
---

Map the repository's automation entry points and documented owners from local workflow files, scripts, configuration, and operational guidance. Trace authorization and event triggers, checks and merge/release gates, credential exposure, and the boundary between untrusted inputs and privileged execution.

Inspect retry, timeout, cancellation, replacement, and shutdown behavior where relevant. Look for duplicate execution, missing idempotency, stale status, lost failures, ambiguous ownership, and recovery paths that can bypass required checks. Connect each finding to a concrete trigger and source location; distinguish a confirmed defect from missing evidence.

Review status visibility and auditability: can a maintainer tell what ran, why it ran, who authorized it, whether checks passed, and what to do after interruption? Record source-supported severity, consequence, smallest recommended remedy, acceptance criteria, and documented owner or ownership gap.

This method is report-only. Write only the enclosing task's designated report; do not change workflows, policies, credentials, repository settings, or implementation. Do not call external APIs, publish, send notifications, open pull requests, or add automation infrastructure. Local files cannot establish external branch protection or runtime history; mark those checks unverified and state what evidence is missing.

Trace one representative execution from event input through authorization, privileged work, result recording, and recovery; check whether replay or interruption changes who can perform the action. Separate local configuration facts from external settings and actual runtime history. Use references/evidence.md to give each recommendation a concrete owner or explicit ownership gap and a testable acceptance criterion.
