# Built-in Task Profiles

RalphWorks ships nine focused task profiles. Use `builtin:NAME` to select a shipped version even if a personal or project profile has the same name. Model providers, API gateways, executors, workspaces and MCP server connections remain independently configured.

## Catalog and environment

Every built-in selects its own `prompt.md`, defaults to five iterations and thirty minutes with `commit: none`, and disables automatic resource inheritance. All have `checks: []`, `mcp: {}`, `extensions: []`, `contextFiles: []` and no extra required environment variables. Bugfix, UI implementation and UX review explicitly require the `playwright-cli` executable in the selected executor. Supply authoritative project checks with `--check`; no language-specific test framework is assumed.

| Category | Profile | Purpose | Tools | Required output |
| --- | --- | --- | --- | --- |
| Delivery | `bugfix` | Reproduce reported defects or investigate bounded correctness risks, then repair confirmed causes. | Modification | `BUGFIX_REPORT.md` |
| Delivery | `domain-modeling` | Clarify supported domain terms and record scoped glossary/ADR changes. | Modification | `MODEL_REPORT.md` |
| Quality | `code-review` | Review supplied code or changes against contracts and repository standards. | Inspection | Final assistant findings; no file required. |
| Quality | `architecture` | Find deepening opportunities and implement bounded, behavior-preserving improvements. | Modification | `ARCHITECTURE_REPORT.md` |
| Quality | `test-coverage` | Improve meaningful measured coverage and relevant test quality. | Modification | `COVERAGE_REPORT.md` |
| Quality | `security-maintenance` | Confirm reachable security findings and make compatible focused repairs. | Modification | `SECURITY_REPORT.md` |
| Quality | `performance` | Repair a measured bottleneck with comparable before/after evidence. | Modification | `PERFORMANCE_REPORT.md` |
| Design | `ui-implementation` | Implement a scoped interface using product conventions and meaningful verification. | Modification | `UI_REPORT.md` |
| Design | `ux-review` | Evaluate user journeys and usability evidence without implementation changes. | Report | `UX_REPORT.md` |

Tool sets:

- Modification: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- Inspection: `read`, `grep`, `find`, `ls`.
- Report: `read`, `bash`, `write`, `grep`, `find`, `ls`; bash enables browser inspection and authorized local previews.

UX review permits its report and task-owned browser evidence under `.ralph/browser/`, without implementation edits. Tool selection is not an operating-system sandbox. Categories are descriptive labels shown by `profiles list` and `profiles show`; custom labels are supported and do not change execution or permissions.

## Prompt and upstream skill composition

| Profile | Default Skill Hub selections |
| --- | --- |
| `architecture` | `builtin:mattpocock-codebase-design`, `builtin:mattpocock-improve-codebase-architecture` |
| `test-coverage` | `builtin:brooks-test` |
| `code-review` | `builtin:sentry-code-review` |
| `domain-modeling` | `builtin:mattpocock-domain-modeling` |
| `ui-implementation` | `builtin:anthropic-frontend-design`, `builtin:playwright-cli` |
| `bugfix`, `ux-review` | `builtin:playwright-cli` |
| `security-maintenance`, `performance` | `skills: []`; methods live in their prompts. |

These are unmodified upstream snapshots, including support files and license notices. Locks retain source repository, directory, ref, exact commit, content digest and selected entrypoint. Automatic updates are off; prepared snapshots work without GitHub access or machine-global installations. A profile may select multiple skills.

| Hub skill | Upstream repository and directory | Archived commit | License |
| --- | --- | --- | --- |
| `mattpocock-improve-codebase-architecture` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/improve-codebase-architecture), `skills/engineering/improve-codebase-architecture` | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT |
| `mattpocock-codebase-design` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/codebase-design), `skills/engineering/codebase-design` | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT |
| `mattpocock-domain-modeling` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/domain-modeling), `skills/engineering/domain-modeling` | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT |
| `brooks-test` | [hyhmrright/brooks-lint](https://github.com/hyhmrright/brooks-lint/tree/917ea82286e74569817875e6a9da8bdf95030c3f/skills), complete `skills/` bundle; entrypoint `brooks-test/SKILL.md` | `917ea82286e74569817875e6a9da8bdf95030c3f` | MIT |
| `sentry-code-review` | [getsentry/skills](https://github.com/getsentry/skills/tree/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/code-review), `skills/code-review` | `f57ada2d0b640406ea7e25b11d636c530e77c58b` | Apache-2.0 |
| `playwright-cli` | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli/tree/b1a5903c5b633b8c9f843ad7b629c2a78437040c/skills/playwright-cli), `skills/playwright-cli` | `b1a5903c5b633b8c9f843ad7b629c2a78437040c` | Apache-2.0 |
| `anthropic-frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design), `skills/frontend-design` | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 |

Architecture uses `improve-codebase-architecture` for exploration, deepening candidates and the deletion test; its explicit companion `codebase-design` supplies the design vocabulary and supporting references. The original upstream workflow includes an HTML presentation, browser opening, subagents and interactive decisions. The enclosing profile adapts those steps: compare candidates in `ARCHITECTURE_REPORT.md`, use the current worker and available tools, and request needs-input for unresolved decisions. It does not launch other skills or automatically write domain documents. The concrete task authorizes any bounded refactoring; the upstream survey alone does not authorize implementation.

Coverage applies Brooks test-quality assessment before adding tests and permits focused, evidenced test repairs. Findings and repairs go into `COVERAGE_REPORT.md`; no separate test-quality report, history database, suppression file or configuration rewrite is required. A heuristic rubric score cannot substitute for measured coverage. The full Brooks bundle preserves sibling `_shared/` dependencies while activating only the selected entrypoint.

`sentry-code-review` is the RalphWorks Hub name for the upstream skill named `code-review`. It supplies Sentry's review checklist covering correctness, design, tests, security and performance. It does not connect to Sentry or require an account. Repository conventions and the local read-only review contract remain authoritative.

Bugfix (both reported and discover modes), UI implementation and UX review include Playwright CLI directly. Their `environment.tools` includes `bash`; the external command is declared in `environment.requires.commands`, not as a Pi tool name. The pinned skill supplies usage guidance. A missing executable fails preflight; browser binaries and application setup must be prepared in the selected executor. Tasks do not install them automatically. Each browser session and evidence directory belongs to the task; only that session is closed. Model, executor and MCP settings remain independent.

## Parameters

All profiles except `code-review` accept `scope`, a string defaulting to `project`.

| Profile | Additional parameters and defaults |
| --- | --- |
| `bugfix` | `mode=reported` (`reported` or `discover`), `maxFixes=1` |
| `architecture` | `maxChanges=3` |
| `test-coverage` | `targetCoverage=85`, `includeIntegration=true`, `includeE2E=false` |
| `security-maintenance` | `maxFixes=3`, `allowDependencyUpdates=true`, `allowConfigHardening=true` |
| `performance` | `maxChanges=3` |
| `ux-review` | `maxFindings=5` |
| `domain-modeling`, `ui-implementation` | None beyond `scope`. |
| `code-review` | None. |

Use `--param key=value`. Types and enum membership are validated before execution. Numeric ranges are checked by task instructions; iteration/time/cost budgets are enforced independently by the engine.

In reported mode, bugfix follows the supplied failure and asks for missing inputs rather than searching unrelated code. In discover mode, it investigates scoped correctness risks and repairs only confirmed defects. Both modes share the same tools, budget and `BUGFIX_REPORT.md`. An evidence-backed result with no confirmed defects is valid. Neither mode permits speculative repairs.

Coverage uses line coverage unless the task explicitly chooses another supported metric. Comparable baseline/final instrumentation is required. A measured target already satisfied with adequate behavior tests can yield a no-op; missing measurements must not become a fabricated percentage. Configure an independent coverage command and threshold when runtime enforcement is required. Profile parameters are not substituted into shell checks.

## Use and verify

```bash
ralphworks profiles list
ralphworks profiles show builtin:architecture
ralphworks run 'Fix the reproduced cancellation failure' \
  --profile builtin:bugfix --param scope=src/workers --check 'pnpm test'
ralphworks run 'Investigate state ownership and retry defects' \
  --profile builtin:bugfix --param mode=discover --param maxFixes=3 \
  --param scope=src/workers --check 'pnpm test'
ralphworks run 'Improve meaningful tests and repair brittle assertions' \
  --profile builtin:test-coverage --param targetCoverage=85 --check 'pnpm test:coverage'
ralphworks run 'Deepen the execution module without changing public behavior' \
  --profile builtin:architecture --param maxChanges=2 --check 'pnpm verify:local'
```

Replace example checks with commands authoritative for the target project. Required files are checked for non-empty text, not substantive report correctness. Code review has no file output validator. Profiles do not publish, push, merge or start nested runners. RalphWorks owns optional verified commits; choose execution and workspace policy independently.

## Optional methods and capabilities

Generic coding and documentation tasks can use direct `ralphworks run '...' --check '...'` commands. Their former methods are explicit [coding](../examples/profiles/coding/profile.json) and [documentation](../examples/profiles/docs-update/profile.json) examples, available for collection and customization without adding general-purpose entries to the built-in catalog.

The [deep-debug example](../examples/profiles/deep-debug/profile.json) extends bugfix with the pinned diagnosis skill and restricts its mode to `reported`. [Web performance](../examples/profiles/web-performance/profile.json), browser variants, documentation lookup, indexed CodeGraph navigation and standalone DeepWiki research remain optional examples. Standalone accessibility examples preserve their explicit skills and tools without a built-in accessibility parent. See [capability profiles](CAPABILITY_PROFILES.md) for configurations, dependencies and runtime bindings.

To track a selected upstream source independently, import it into your project or personal Hub and select that reference in a custom profile:

```bash
ralphworks skills add https://github.com/mattpocock/skills \
  --name improve-architecture --scope personal \
  --path skills/engineering/improve-codebase-architecture --ref main
```

An explicit `skills update` refreshes the Hub; `profiles update NAME` adopts its version. Auto-refresh requires explicit opt-in and never changes prepared resources mid-run.

## Catalog migration

| Former built-in | Replacement |
| --- | --- |
| `coding`, `docs-update` | Direct tasks or the corresponding explicit example directory. |
| `bug-hunt` | `builtin:bugfix --param mode=discover`; report is now `BUGFIX_REPORT.md`. |
| `test-quality-review` | `builtin:test-coverage`; test-quality findings and coverage evidence share `COVERAGE_REPORT.md`. |
| `architecture-audit` | Removed. Use a custom report-only profile if needed; `architecture` is a modification task. |
| `tech-debt-review`, `accessibility`, `opportunity-discovery`, `automation-governance-review`, `repository-research`, `harness-auto` | Removed from the built-in catalog. Author a custom profile when needed; surviving external-capability examples are explicit standalone configurations. |
| `deep-debug` | Explicit `examples/profiles/deep-debug` specialization. |

Update old direct selectors and custom `extends` references. Already collected, flattened profiles keep their own prepared prompts and pins. Historical immutable skill objects and legacy Hub names are retained for explicit locked references; removing a task type does not delete archived skill content. No automatic selector aliases are introduced. See the [evaluation](TASK_PROFILE_EVALUATION.md) for the revised selection policy and validation limits.
