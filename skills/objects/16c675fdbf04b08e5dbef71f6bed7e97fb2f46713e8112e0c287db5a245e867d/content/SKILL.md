---
name: opportunity-discovery-method
description: Produce evidence-backed improvement opportunities without changing implementation
---

Read repository goals, architecture, tests, and relevant source paths within the selected scope. Identify opportunities from demonstrated friction, failure modes, missing safeguards, or repeated maintenance costs. Stay within the local evidence; do not invent product demand or pretend external validation occurred.

For each useful proposal explain the evidence and affected path, confidence and uncertainty, expected value, observable acceptance criteria, explicit non-goals, risks, and estimated scope. Rank a short list that a maintainer can act on; avoid generic best-practice checklists and duplicate proposals. An empty list is acceptable when evidence is insufficient.

This method is report-only. Inspect existing files and write only the report designated by the enclosing task. Do not implement suggestions, modify code/tests/configuration, create commits or branches, open pull requests, change external services, or publish findings. Describe follow-up verification needed for uncertain proposals.

Prefer a small, non-overlapping set of proposals tied to a real path. Compare benefit against migration cost and the option to do nothing. Use references/evidence.md to distinguish a source-supported need from a product hypothesis; confidence should affect ranking and follow-up validation, not be disguised as a measured return.

Use explicitly configured read-only task capabilities for authorized evidence collection when available; do not require an external service.
