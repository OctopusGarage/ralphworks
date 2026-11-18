---
name: docs-update-method
description: Update accurate usable documentation
---

Identify the audience, their task, and the authoritative implementation or public interface for the requested documentation. Read surrounding terminology, examples, navigation, and repository documentation conventions. Trace each changed command or behavior to code or actual help output; avoid copying stale examples.

Write prerequisites before commands and show expected results where they remove ambiguity. Keep examples runnable in the documented context, label placeholders, and distinguish required setup from optional integrations. Preserve accurate cross-links and update related references when a name or command changes. Never include live credentials or claim an untested example was executed.

Run available documentation checks and validate affected commands or examples when the tools and environment allow it. Prefer safe help, validation, or fixture execution over commands that publish or mutate external state. Inspect the final text for consistency with the actual interface and flag unavailable validation explicitly.

Use references/evidence.md for the handoff and follow the enclosing output contract; no additional report is required by this method.
