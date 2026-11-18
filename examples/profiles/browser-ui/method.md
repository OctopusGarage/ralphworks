# Browser-assisted UI verification

Use the explicitly configured browser MCP to inspect the requested local development or test application. Discover its advertised tool schemas instead of assuming provider-specific names. Use synthetic test data and the task's selected routes and viewports. Capture the relevant rendered states before and after changes, inspect keyboard navigation and responsive layout, and record the actual observations and artifact locations in UI_REPORT.md. A screenshot alone does not establish interaction correctness or accessibility.

Keep browser actions within the task's local or explicitly authorized test environment. Do not enter production credentials, submit purchases, publish content, or change remote account state. If the required browser cannot connect or the application cannot be started using documented project commands, report the blocker. Do not replace missing rendered verification with an assertion that source inspection proved visual correctness.
