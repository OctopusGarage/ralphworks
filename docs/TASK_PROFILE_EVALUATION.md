# Task Profile Evaluation and Resource Policy

## Evaluation basis

The built-in catalog is a curated starting set, not an exhaustive registry of possible work. Evaluate entries by their objective, method, evidence, permitted changes, output and portability. Shared methods can be composed through multiple skills or task parameters without adding separate top-level types. These are configuration and method-design decisions, not benchmarked model success rates.

The current catalog has nine task types: delivery (2), quality (5), and design (2). Broad work can run directly without a profile; users can collect or author specialized profiles independently. The orchestrator, model provider, execution environment and task method remain decoupled.

## Catalog decisions

| Previous entry or overlap | Current decision | Rationale and boundary |
| --- | --- | --- |
| `coding` | Remove from built-ins; keep an explicit example. | A generic task already works through direct `run`; the example remains useful as a customization starting point. |
| `docs-update` | Remove from built-ins; keep an explicit example. | Documentation needs can be described in direct tasks or a personal method without occupying the focused default catalog. |
| `bugfix` and `bug-hunt` | Keep one `bugfix` with `mode=reported|discover`, scope and a shared repair limit. | Both use observation, hypothesis, confirmed cause and regression evidence. The mode preserves their different inputs and stopping conditions without two report contracts. Discovery is opt-in; reported mode must not search unrelated code. |
| `architecture` | Select improve-codebase-architecture plus its explicit codebase-design companion. | The first provides the deepening survey and candidate-selection workflow; the second provides its vocabulary and design references. Preserve bounded behavior-compatible refactoring. |
| `architecture-audit` | Remove. | A separate default audit task is outside the requested focused catalog. Architecture remains a modification task; report-only behavior requires a custom profile, not an ambiguous mode switch. |
| `test-quality-review` and `test-coverage` | Remove the separate review entry; select brooks-test in coverage. | Assess quality before adding tests and allow bounded evidence-backed test repairs. Keep measurements distinct from quality heuristics and require only COVERAGE_REPORT.md. |
| `tech-debt-review`, `opportunity-discovery`, `automation-governance-review` | Remove. | These specialized planning/reporting workflows can be user-defined; they are not part of the selected default maintenance set. |
| `accessibility` | Remove from built-ins. | UI work retains accessibility basics. Explicit standalone web-accessibility examples remain available with their own scoped tools, prompts and reports. |
| `repository-research` | Remove from built-ins. | A standalone DeepWiki capability example retains its complete report-only method without a missing parent. |
| `harness-auto` | Remove. | The caller selects the objective. Avoid a default broad maintenance selector and a second conceptual orchestration layer. |
| `deep-debug` | Keep as an explicit bugfix specialization. | Adds the upstream diagnosis skill and remains restricted to reported failures. |

The retained types are bugfix, domain-modeling, code-review, architecture, test-coverage, security-maintenance, performance, ui-implementation and ux-review. Their complete configuration, selected resources and parameters are in the [catalog](TASK_PROFILES.md).

## Upstream method adaptations

Vendor skills remain byte-for-byte archived dependencies with support files, licenses, exact Git commit provenance and content hashes. Profile prompts adapt their workflow to the allowed tools, task budget and output contract; skills never grant additional permissions or install missing companion resources automatically.

Architecture explicitly selects both Matt Pocock methods at the same archived commit. The upstream improve-codebase-architecture workflow is an interactive survey: HTML presentation, browser opening, candidate choice, grilling, domain-document updates and optional subagents. The unattended profile instead records supported candidates and before/after evidence in ARCHITECTURE_REPORT.md, uses the existing worker, and implements only bounded changes authorized by the concrete task. It does not create a separate HTML report, open a browser, load CDN assets, invoke nested skills/workers or automatically update domain documents. Missing domain decisions, unresolved candidate choices and relevant ADR conflicts produce needs-input before dependent edits.

Coverage uses the Brooks assessment method to find weak assertions, brittle tests, mock abuse, misleading coverage and expensive feedback. Focused repairs must have evidence and remain within the requested scope. COVERAGE_REPORT.md includes quality findings, repairs and actual baseline/final coverage; no TEST_QUALITY_REPORT.md, tracking history, suppression or configuration file is required. Rubric scores are optional heuristics with explicit inputs and cannot stand in for coverage measurements. The entire upstream skills bundle, including sibling `_shared/`, is preserved while only brooks-test is activated.

Sentry's upstream skill is named code-review; `sentry-code-review` is its distinct RalphWorks Hub identity. It supplies a checklist for correctness, security, performance, tests and design, not a Sentry service connection or account requirement. Existing repository conventions and the inspection-only task contract remain authoritative. Domain modeling and frontend design likewise use explicit upstream methods without assuming host-specific tools.

## Resources and optional capabilities

All nine built-ins default to no resource inheritance, no MCP, no extensions, no explicit extra contexts and no extra required environment variables. Bugfix, UI implementation and UX review select Playwright CLI, expose bash and declare the executable prerequisite directly. Seven task types select seven distinct upstream skills; security maintenance and performance are prompt-only. More selected skills do not inherently improve a task. Explicit custom project/all inheritance remains supported.

The previous machine-local inventory found 232 physical SKILL.md files and 191 distinct declared names across installed directories and plugin caches. That was a discovery aid, not a list of active Pi capabilities. Built-ins do not load personal paths, plugin caches or global MCP configuration implicitly. Relevant sources are imported explicitly into a durable Hub; private, company-specific, publishing and account-bound integrations remain user-defined.

Bugfix uses the same configured browser capability in both reported and discover modes, without an extra browser-specific task type. UI/UX defaults also include it. Capability examples preserve explicit browser integrations, Context7 documentation, already-indexed CodeGraph lookup and standalone DeepWiki research. Examples whose former built-in parent was removed now inherit an explicit sibling example or declare a complete standalone environment. They are outside `profiles list`. No index is automatically created, no service is silently enabled, and Alcove is excluded. See [capability profiles](CAPABILITY_PROFILES.md).

## Migration and archival

Update direct selectors and custom extends references for removed built-ins; no alias or automatic migration subsystem is introduced. `bug-hunt` becomes bugfix discover mode with BUGFIX_REPORT.md; test-quality review becomes coverage with COVERAGE_REPORT.md and its measured target. Replacing a report-only audit with a modification task is not an automatic migration.

Already collected flattened profiles retain their prepared prompts, selected resources and locks. Historical immutable skill objects, including former authored wrappers and Brooks audit/debt entrypoints, remain available for old explicit references. Removing a task type does not delete archived skill objects or alter existing pinned bytes. New upstream versions are adopted through explicit Hub/profile updates or configured auto-refresh, never mid-run.

## Verification and limits

Configuration tests cover the exact nine-entry catalog, enum/type handling, selected upstream identities, whole-bundle integrity, multi-skill collection/staging, output requirements and tool boundaries. They verify browser command preflight and UX source boundaries, bugfix reported/discover composition, the coverage quality integration and the adaptation of architecture's interactive side effects. Offline and packaged checks verify portability; they do not establish real model task success rates.

The engine enforces iteration/time/cost budgets and configured checks. Specialty numeric ranges remain prompt-enforced. Report validators check non-empty text or valid JSON, not whether every statement is supported. Tool selection and report-only instructions are not filesystem isolation. Choose execution/workspace policy and authoritative project checks according to the task. Browser screenshots cannot by themselves establish usability, accessibility conformance, code coverage or production performance.
