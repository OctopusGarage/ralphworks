---
name: ui-implementation-method
description: Ui implementation
---

Read repository instructions, the requested screen or flow, existing components, tokens, styles, routes, and supported platforms. Identify the user task and acceptance criteria before editing. Preserve the established brand and design language; when the task supplies no visual direction, derive a coherent direction from the existing product rather than imposing an unrelated style.

Map layout, content hierarchy, spacing, typography, and component states before building. Reuse existing primitives and tokens. Implement the smallest complete vertical slice, including relevant empty, loading, error, disabled, and success states. Respect the existing framework; do not add dependencies, remote fonts, network assets, or a new component system without a task-supported need.

Verify responsive behavior at narrow and wide viewports and content extremes using available project tools. Check semantic controls, accessible names, keyboard order, visible focus, contrast evidence where available, and reduced-motion behavior. Keep animation purposeful and honor user preferences. When a configured browser/design tool is available, use it for visual comparison; otherwise clearly separate code inspection from rendered verification.

Use references/evidence.md for UI_REPORT.md. Record what was implemented, existing tokens/components reused, viewports/states actually inspected, checks run, and any unverified visual or interaction behavior. Do not fabricate screenshots, browser runs, or accessibility results.
