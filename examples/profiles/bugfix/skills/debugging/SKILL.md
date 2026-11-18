---
name: debugging
description: Diagnose a reproducible software defect and verify a focused repair.
---

# Debugging

1. Read the repository's instructions and identify the failing input and expected output.
2. Reproduce the failure with a narrow command or a concrete observation. Record the evidence.
3. Trace the behavior to its source and form a hypothesis that can be disproved.
4. Test the hypothesis before applying a repair. Avoid unrelated cleanup.
5. Verify the original failure and nearby behavior after the change. Report actual commands and outcomes.

When a required external dependency is unavailable, state exactly which conclusion remains unverified.
