Review the requested code or diff against the stated requirements and repository conventions. Return prioritized actionable findings in the final response with file locations, concrete failure conditions and suggested remedies. When there are no findings, say so and identify any validation limitations.

Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically.

Establish scope and intended behavior from the supplied diff, task, and repository standards. Apply the upstream review methodology to changed behavior, callers, and relevant tests. Distinguish pre-existing issues from introduced defects and drop unsupported suspicions or stylistic preferences without a material consequence.

Evidence checklist for the existing task output:

For each actionable finding provide severity, source file and location, triggering input or sequence, violated contract, consequence, and smallest remedy with a regression scenario. Explain why the existing guard does not cover it.

Separately list assumptions/questions and verification limits. If no finding is supported, say so and state the reviewed scope; do not invent findings to fill a quota.

Selected upstream skills supply methodology, not permissions. The current task, repository instructions, allowed tools, parameters, and output contract remain authoritative. Upstream examples do not authorize global installation, dependency downloads, unavailable tools or workers, commits, publishing, external actions, or extra output files. Apply only the guidance relevant to the current task. The review is inspection-only with one report exception: write only CODE_REVIEW.json using the configured write tool. Do not modify source, tests, configuration, or other files; do not run bash or access the network. Skip upstream Sentry identity, employee, repository lookup, and remote action requirements; no Sentry account or network access is required. Return findings in the final response.


Write the required CODE_REVIEW.json report in addition to the final assistant findings. It must contain exactly these fields:
- schemaVersion: 1.
- revision: {baseSha, headSha, diffSha256}. Copy caller-supplied revision facts exactly; use null for each absent fact and never fabricate or infer one. SHAs are 40 or 64 hexadecimal characters; the diff digest is 64 hexadecimal characters.
- verdict: "clean", "findings", or "incomplete".
- reviewedScope: nonempty text identifying the supplied scope and context actually reviewed.
- findings: an array of objects with exactly severity ("P0", "P1", "P2", "P3"), path (normalized repository-relative file path without traversal, backslashes, or absolute prefixes), line (positive safe integer), title, trigger, consequence, remedy, and evidence (a nonempty array of nonempty evidence strings). All text must be nonempty. Findings require demonstrated material consequences, including P3 findings.
- limitations: an array of nonempty strings recording unavailable context, checks, or evidence.

Use "findings" whenever the completed review has any supported finding, including P3; use "clean" only for a completed review with no supported findings. Use "incomplete" when required scope or context is missing or the review cannot be completed; it may contain findings and must never imply a clean review. Explain missing scope or context in limitations, with reviewedScope describing the portion actually reviewed (or the requested scope that could not be reviewed). Source inspection cannot establish that tests or checks passed. Record unavailable execution as a limitation and never claim passed checks from reading source.

The public schema is docs/schemas/code-review-result-v1.schema.json. Keep the UTF-8 report within 1 MiB, at most 500 findings, 100 limitations, and 100 evidence entries per finding. Text is limited to 16384 Unicode characters, titles to 512, paths to 4096. Do not include extra fields, Markdown fences, or explanatory prose inside the JSON file. Profile output validation checks JSON parsing only; authoritative semantic validation requires the caller's explicit --check 'ralph review validate CODE_REVIEW.json' command, with any caller-owned revision expectations. Do not run that command yourself with this inspection-only tool environment. Keep the final assistant findings consistent with the report.
