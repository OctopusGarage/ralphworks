---
name: security-maintenance-method
description: Repair confirmed, reachable security findings with compatible changes
---

Read repository security guidance and identify existing local audit, dependency, secret, and static-analysis commands. Use available high-signal findings and trace the vulnerable input through the reachable code path. Separate confirmed exposure, scanner-only signals needing investigation, and unreachable or unsupported hypotheses. Avoid printing credential values in evidence.

Prioritize demonstrated exploitability and impact. For each confirmed finding, capture the trigger, affected trust boundary, source or dependency version, reachability proof, and expected protection. Do not make speculative security changes merely because a pattern looks unfamiliar.

Respect the enclosing task's limits on dependency updates and configuration hardening. Apply the smallest compatible dependency or code/configuration repair, preserve required functionality, and update lockfiles through the existing package manager when applicable. Add regression tests that demonstrate the protection and run established checks. Do not suppress scanners, add broad ignores, weaken policy, perform unrelated upgrades, rotate credentials, or change external services.

Re-run the relevant audit or scanner where available and explain residual findings, unavailable tooling, compatibility risks, and what was actually verified. No findings within a bounded scan is not proof of complete security. Use the enclosing task's report contract.

Check the proposed repair against both the hostile input and the legitimate workflow. A version advisory alone does not establish application reachability, and a clean scanner alone does not prove the boundary is protected. Use references/evidence.md to distinguish the finding's source, exposure evidence, compatibility impact, and residual uncertainty.
