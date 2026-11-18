# Bug repair method

Investigate {{target}} using the concrete task description and repository guidance.
Establish the expected behavior and reproduce the defect before changing code.
Choose the smallest repair that addresses the cause, then run relevant independent checks.
If an automated regression test provides meaningful protection, add it and demonstrate that it detects the original defect.
Write BUGFIX_REPORT.md with the cause, changed behavior, verification commands and results, and any unresolved limitations.
