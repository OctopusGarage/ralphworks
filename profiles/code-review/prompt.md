Review the requested code or diff against the stated requirements and repository conventions. Return prioritized actionable findings in the final response with file locations, concrete failure conditions and suggested remedies. When there are no findings, say so and identify any validation limitations.

Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically.

Establish scope and intended behavior from the supplied diff, task, and repository standards. Apply the upstream review methodology to changed behavior, callers, and relevant tests. Distinguish pre-existing issues from introduced defects and drop unsupported suspicions or stylistic preferences without a material consequence.

Evidence checklist for the existing task output:

For each actionable finding provide severity, source file and location, triggering input or sequence, violated contract, consequence, and smallest remedy with a regression scenario. Explain why the existing guard does not cover it.

Separately list assumptions/questions and verification limits. If no finding is supported, say so and state the reviewed scope; do not invent findings to fill a quota.

Selected upstream skills supply methodology, not permissions. The current task, repository instructions, allowed tools, parameters, and output contract remain authoritative. Upstream examples do not authorize global installation, dependency downloads, unavailable tools or workers, commits, publishing, external actions, or extra output files. Apply only the guidance relevant to the current task. The review is read-only: use the provided diff and file context with the configured reading tools; do not run bash, edit or write files, or create a report file. Skip upstream Sentry identity, employee, repository lookup, and remote action requirements; no Sentry account or network access is required. Return findings in the final response.
