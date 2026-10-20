# Explicit Capability Profiles

RalphWorks ships nine focused built-in task types. Task prompts define objectives, scope, evidence and outputs; selected upstream skills add specialized methods. External service bindings, executables, model providers and execution choices remain separate. No capability automatically inherits global configuration. Alcove is not integrated.

## Combined built-in methods

| Built-in | Upstream selections | Output and adaptation |
| --- | --- | --- |
| `architecture` | Matt Pocock improve-codebase-architecture and codebase-design | Bounded authorized refactoring; candidate comparisons in `ARCHITECTURE_REPORT.md`. No HTML/browser presentation, nested workers or automatic domain-document writes. Unresolved decisions produce needs-input. |
| `test-coverage` | Brooks brooks-test | Test quality assessment and focused repairs accompany measured coverage; only `COVERAGE_REPORT.md` is required. Skip upstream tracking, suppressions/configuration writes and unrelated remediation. |
| `domain-modeling` | Matt Pocock domain-modeling | Scoped glossary/ADR changes and `MODEL_REPORT.md`; no automatic implementation refactoring. |

The former audit, debt, test-quality and research task types are not built-ins. Generic coding/documentation methods are explicit examples. The optional [deep-debug example](../examples/profiles/deep-debug/profile.json) extends bugfix in reported mode with the archived diagnosis skill. It cannot change HEAD through bisection, checkout or reset, or run an interactive human-in-the-loop script unattended.

```bash
ralphworks run 'Improve important tests and remove brittle assertions' \
  --profile builtin:test-coverage --param scope=tests --check 'pnpm test:coverage'
ralphworks run 'Improve the evidenced execution seam' \
  --profile builtin:architecture --param scope=src --check 'pnpm test'
ralphworks run 'Diagnose the reproduced cancellation failure' \
  --profile /path/to/ralphworks/examples/profiles/deep-debug --check 'pnpm test'
```

## Browser capabilities

Built-in `bugfix`, `ui-implementation` and `ux-review` now select the archived Playwright CLI skill, expose `bash`, and require `playwright-cli` directly. Bugfix uses this configuration for both reported and discover modes. No extra task type or browser mode is needed.

These built-ins and the following explicit examples require an installed `playwright-cli` inside the selected executor. The archived Microsoft skill includes its references and license; it does not install the executable, browser binaries, or project dependencies. Install and prepare the chosen environment separately. The project does not reuse the author's browser profile or credentials.

| Example under `examples/profiles/` | Parent task | Added skills | Tool policy |
| --- | --- | --- | --- |
| `ui-with-playwright` | `ui-implementation` | Playwright CLI already selected by the parent | Existing editing tools. |
| `ux-with-playwright` | `ux-review` | Playwright CLI already selected by the parent | Bash for local preview/browser commands; no source edits. |
| `accessibility-with-playwright` | Standalone web accessibility example | Web accessibility and Playwright CLI | Bounded web accessibility repairs. |
| `coverage-with-playwright` | `test-coverage` | Playwright CLI | Explicitly defaults `includeE2E=true`; real coverage instrumentation still required. |
| `web-performance-with-playwright` | `performance` | Web performance and Playwright CLI | Comparable lab measurement; no invented field data. |

Each requires `environment.requires.commands: ["playwright-cli"]`, so a missing executable fails preflight rather than causing automatic package installation. Use `--help` to reconcile the installed CLI with its archived skill version. Each task must create a short unique named session (about 8-12 ASCII characters to avoid local socket path limits), use it on every command, keep generated evidence under a task-owned `.ralph/browser/` scratch directory, and close only its own session. Never use global session cleanup commands. Inspect reported command errors even when the CLI returns exit code zero; use relative `--filename` paths inside the scratch directory to avoid canonical-path mismatches. Browse local or explicitly authorized test applications with synthetic data; production account mutations and purchases are outside the task contract.

The UX built-in and its variant explicitly permit browser evidence files in addition to `UX_REPORT.md`, while preserving report-only implementation policy. Bash tool selection is not an operating-system sandbox. Screenshots alone do not verify interaction correctness, accessibility conformance, code coverage, or production performance.

```bash
ralphworks plan 'Improve the local settings screen and verify its states' \
  --profile builtin:ui-implementation
ralphworks run 'Inspect the onboarding flow without editing source' \
  --profile builtin:ux-review
```

The `browser-ui` example adds an explicit browser MCP connection to the UI configuration; it also inherits the parent's Playwright CLI capability and prerequisite. The default built-ins require no MCP connection. Neither a skill nor an MCP connection installs the CLI.

## Documentation through Context7

Examples `coding-with-docs`, `bugfix-with-docs`, `docs-with-docs`, and `review-with-docs` preserve their parent method's tools and outputs. Coding and documentation inherit sibling example directories, not removed built-ins. They select only `resolve-library-id` and `query-docs` from logical alias `docs`. The service is optional: unavailable connections fall back to local evidence with a recorded limitation. If current external documentation is required by the concrete task, missing documentation remains a blocker.

Use the [Context7 runtime](../examples/runtimes/context7.json). It binds the documented HTTP endpoint and maps the Authorization header from `CONTEXT7_AUTHORIZATION`. Set that variable to the complete authorization value, including the `Bearer ` prefix; do not put a real key in a profile or committed runtime. Missing optional credentials make the service unavailable, not secretly inherited from another coding agent. Server tool schemas are inspected at connection time. [Context7 documentation](https://github.com/upstash/context7#installation)

```bash
ralphworks run 'Check the library upgrade against its current API documentation' \
  --profile /path/to/ralphworks/examples/profiles/review-with-docs \
  --runtime /path/to/ralphworks/examples/runtimes/context7.json
```

Resolve the library and required version before querying. Send public library questions, not private source code or confidential project details. The review variant still has no bash, edit, or write tools.

## Indexed source through CodeGraph

Examples `architecture-with-codegraph` and `review-with-codegraph` select only `codegraph_explore` from alias `graph`. The [CodeGraph runtime](../examples/runtimes/codegraph.json) starts an independently installed `codegraph serve --mcp` in the selected working directory. The capability is optional and requires an existing project index for useful queries. No profile creates or refreshes an index automatically. [CodeGraph documentation](https://github.com/colbymchenry/codegraph/blob/main/site/src/content/docs/reference/mcp-server.md)

Check for `.codegraph/` before graph queries. Pass the executor's repository path as `projectPath` when required by the advertised schema, use the returned source and call paths directly, and disclose index coverage/staleness limitations. When no index or connection is available, use the parent's reading/search tools. Do not claim graph-backed verification occurred.

## Public repository research through DeepWiki

`repository-research-with-deepwiki` is a standalone report-only example, not a built-in task type. It declares its own tools, prompt, budget and `RESEARCH_REPORT.md` output, and adds alias `wiki` with exactly `read_wiki_structure`, `read_wiki_contents`, and `ask_wiki_question`. This explicit variant requires a repository parameter and connection. The live server currently advertises `ask_wiki_question`; older provider documentation may call it `ask_question`. The allowlist follows the verified advertised name rather than that older spelling. The [DeepWiki runtime](../examples/runtimes/deepwiki.json) uses the documented public Streamable HTTP endpoint; no personal global configuration is loaded. [DeepWiki documentation](https://docs.devin.ai/work-with-devin/deepwiki-mcp)

```bash
ralphworks run 'Explain the public project architecture with source links' \
  --profile /path/to/ralphworks/examples/profiles/repository-research-with-deepwiki \
  --param repository=microsoft/playwright \
  --runtime /path/to/ralphworks/examples/runtimes/deepwiki.json
```

Only send public repository identities and non-confidential questions. An indexed wiki summary is a lead to verify, not proof that it reflects the current checkout or latest commit. Report the source links and uncertainty; unavailable required repository documentation produces a needs-input handoff.

## Complete upstream bundles and entrypoints

Brooks skills read sibling `_shared/` files. Archiving a single `brooks-test/` folder loses that dependency. RalphWorks therefore archives the complete upstream `skills/` directory unchanged and selects a nested entrypoint:

```json
{
  "source": "https://github.com/hyhmrright/brooks-lint",
  "path": "skills",
  "ref": "917ea82286e74569817875e6a9da8bdf95030c3f",
  "entrypoint": "brooks-test/SKILL.md",
  "autoUpdate": false
}
```

The three archived Brooks Hub selections share one content object, retain the repository license, and select different entrypoints. Only the requested method is activated; other bundled methods are supporting archived content. Full bundle integrity, resource bounds, and paths are validated. `entrypoint` defaults to `SKILL.md`; existing sources and locks retain their behavior and digests. It must be a safe relative path to a regular `SKILL.md`, with no traversal or symlinks.

Import an upstream or local bundle explicitly:

```bash
ralphworks skills add https://github.com/hyhmrright/brooks-lint \
  --name test-quality --scope personal --path skills \
  --ref 917ea82286e74569817875e6a9da8bdf95030c3f \
  --entrypoint brooks-test/SKILL.md
ralphworks skills add ./editable-bundle --name custom-quality --scope project \
  --entrypoint brooks-test/SKILL.md
```

Whole directories, selected entrypoints, licenses and source provenance survive collection, updates, automatic-refresh fallback, export/import, fork/reimport, vendoring, staging and path remapping. Task records may include aligned `skillRoots` paths for whole bundles. Each run uses prepared bytes; upstream updates never replace resources mid-run. Forking edits a copy, not the immutable object. Existing iteration/time/cost, command checks and output validators continue to govern completion.

## Archived sources

| Skill | Source directory | Archived commit | License |
| --- | --- | --- | --- |
| Playwright CLI | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli), `skills/playwright-cli` | `b1a5903c5b633b8c9f843ad7b629c2a78437040c` | Apache-2.0 |
| Diagnosing bugs | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/diagnosing-bugs` | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT |
| Improve codebase architecture | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/improve-codebase-architecture` | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT |
| Domain modeling | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/domain-modeling` | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT |
| Brooks test/audit/debt | [hyhmrright/brooks-lint](https://github.com/hyhmrright/brooks-lint), complete `skills/` tree | `917ea82286e74569817875e6a9da8bdf95030c3f` | MIT |

The catalog and profile locks retain exact refs, commits, content digests and entrypoints. Automatic updates are off by default. The active Brooks test selection tracks `main`; retained historical audit/debt selections pin the same commit for existing explicit references. Users can choose their own tracked refs in project/personal sources. Third-party files are archived unchanged and their notices remain part of the published package.
