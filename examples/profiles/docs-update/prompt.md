Read the relevant implementation and documentation. Update the requested documentation to describe current behavior with accurate commands and useful examples. Keep maintained prose in English. Write DOCS_REPORT.md describing changed documents and verification.

Use only tools and MCP capabilities explicitly configured for this task, within the method's permissions; no globally installed skill, plugin, or service is required. Do not install optional plugins or enable external services automatically.

Identify the audience, their task, and the authoritative implementation or public interface for the requested documentation. Read surrounding terminology, examples, navigation, and repository documentation conventions. Trace each changed command or behavior to code or actual help output; avoid copying stale examples.

Write prerequisites before commands and show expected results where they remove ambiguity. Keep examples runnable in the documented context, label placeholders, and distinguish required setup from optional integrations. Preserve accurate cross-links and update related references when a name or command changes. Never include live credentials or claim an untested example was executed.

Run available documentation checks and validate affected commands or examples when the tools and environment allow it. Prefer safe help, validation, or fixture execution over commands that publish or mutate external state. Inspect the final text for consistency with the actual interface and flag unavailable validation explicitly.

Evidence checklist for the existing task output:

- Reader task and authoritative interface/source:
- Prerequisites, working directory, and placeholder meanings:
- Changed examples/cross-links and observed expected output:
- Commands or docs checks actually run and results:
- Examples not executed, why, and remaining ambiguity:
