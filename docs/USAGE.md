# RalphWorks Usage and Execution Guide

RalphWorks is a bounded loop orchestrator built on Pi Coding Agent. It loads a task, lets an agent modify a repository over multiple iterations, runs optional independent checks, and persists progress and results. This guide covers the core CLI and its patch-based Docker clone and `remote` modes. The separately generated [issue and PR workflows](ISSUE_WORKFLOWS.md) can deliver checked work to GitHub branches and PRs.

## Installation and command entry point

RalphWorks requires Node.js 24. Install the release package and configure Pi:

Maintainers can find the versioning and publication process in the [release guide](RELEASING.md).

```bash
npm install -g @earendil-works/pi-coding-agent \
  https://github.com/OctopusGarage/ralphworks/releases/download/v0.2.0/ralphworks-0.2.0.tgz
pi # configure /login and /model, then exit
ralphworks --help
```

To build from source, use pnpm 10.13.1:

```bash
git clone https://github.com/OctopusGarage/ralphworks.git
cd ralphworks
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
ralphworks --help
```

Without a global link, replace `ralphworks` with `node /path/to/ralphworks/dist/cli.js`. Run commands from the root of the target repository. `run` uses Pi on the host by default. `--runner dry-run` exercises orchestration without modifying code and normally ends at `max_iterations`.

Source installs pin Pi's `minimatch` dependency to 11.0.1 for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Pi's resource filters use the retained `minimatch()` API; the removed regular-expression APIs are not used. Package-manager overrides belong to the installation root: when installing the tarball into a managed prefix, carry the repository's scoped overrides into that prefix and audit its own lockfile. Overrides inside an installed dependency do not protect a separate global or prefix installation.

Use `--help` or `-h` as the command or immediate subcommand target to print usage and exit successfully, including `ralphworks run --help` and `ralphworks plan --help`. For `run` and `plan`, help is also recognized at an option position after the task. Other command argument parsers retain their existing strict validation; `remote task.md -h` is rejected before dispatch. Help exits before resolving tasks, profiles, runtimes or workspaces; it does not start an agent or create run state or worktrees. Values consumed by other options remain literal: `--completion-promise --help` sets the completion promise rather than requesting help. Existing argument validation still applies before a later help option. A bare `--` remains unsupported; `--` consumed as an option value remains literal.

```bash
cd /path/to/project
ralphworks run 'Fix the lost state after refreshing the results page'
ralphworks status .ralph/current
ralphworks trace .ralph/runs/<run-directory>/events.jsonl
```

## Model and credential configuration

RalphWorks delegates models, authentication, and custom providers to Pi. Configure credentials with Pi's `/login` command and select a model with `/model`. Pi uses `~/.pi/agent` by default; use `--pi-agent-dir` to select another directory.
RalphWorks disables automatic agent resource discovery by default, including runs without a profile. A profile can opt into project resources or project and global resources through `environment.resourceInheritance`. Model settings and credentials in `--pi-agent-dir` remain available regardless of resource inheritance. For scheduled architecture skill use, see [Architecture proposals](ISSUE_WORKFLOWS.md#architecture-proposals).

When an agent directory is explicitly selected through `--pi-agent-dir`, runtime `piAgentDir`, or the existing environment resolution, its `settings.json` retry policy also remains available under `none` and `project` resource inheritance. This does not enable its skills, prompts, context or extensions. Without an explicit directory selection, these isolated modes do not inherit ambient global retry settings. In `project` mode, project settings retain the SDK's recursive override behavior, including partial retry overrides; `all` retains its existing inheritance. Task settings are held in memory and do not rewrite the source settings files.

Model resolution follows this order:

1. CLI: `--model`, `--provider`, `--pi-agent-dir`, and `--pass-env`.
2. Environment: `RALPHWORKS_MODEL`, `RALPHWORKS_PROVIDER`, `PI_CODING_AGENT_DIR`, and `RALPHWORKS_PASS_ENV`.
3. The selected runtime preset.
4. Pi's current configuration and available models.

Use either `--model provider/model-id` or `--provider provider --model model-id`. RalphWorks forwards recognized provider credential variables to Docker. Repeat `--pass-env NAME`, or set `RALPHWORKS_PASS_ENV=NAME,OTHER_NAME`, for additional variables. Keep credentials out of tasks and Git.

Pi configuration remains in Pi's native files:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/auth.json`
- `~/.pi/agent/models-store.json`

## Task inputs

### Direct text and plain text files

The first argument to `run` may be direct task text or a text file at any path. Only `.yaml` and `.yml` files receive structured parsing. Other files have no required format; Markdown headings, checkboxes, and front matter have no special meaning.

```bash
ralphworks run 'Fix the refresh bug and add relevant tests'
ralphworks run ./docs/issue-123.md
ralphworks run /any/path/requirements.txt
```

Plain tasks default to:

- Job name: the file basename, or `task` for direct text.
- Progress file: `.ralph/progress/<job-name>-<task-hash>.md`.
- Completion value: `DONE`.
- Maximum iterations: 5.
- Maximum wall-clock time: 30 minutes.
- Checks: none.
- Commit policy: `none`.

The agent can modify any file in the current worktree. RalphWorks injects its own completion and Git rules, so task text does not need to mention commits or completion tags. The agent must not create Git commits. With `commit: none`, RalphWorks leaves changes uncommitted for caller review and delivery; with `commit: verified`, RalphWorks handles permitted commits after passing configured checks. The selected commit policy does not bypass task completion, configured checks or output validation.

### Multi-item tasks

For a longer task, give the agent a stable list of small items and an observable acceptance condition for each one:

```markdown
# Goal
Add CSV export to the report page.

## Work items
- [ ] Add the export action to the report page.
- [ ] Serialize report rows with correct quoting and headers.
- [ ] Cover empty reports and quoted values in tests.

## Acceptance
- The export downloads a CSV with the displayed rows.
- `npm test` and `npm run build` pass.
```

The checklist is ordinary task text, not a format RalphWorks parses or edits. Keep the task file stable during a run. RalphWorks supplies the same task and its saved progress to each new agent session; the handoff should identify the completed item, check evidence, and the next item. Use independent `--check` commands or a YAML job for the acceptance criteria. For architecture changes involving resource owners, combine callback reentry, cleanup and notification-time observations in the same regression; after extraction, run affected-check selectors for each moved implementation path independently. Make each item small enough to complete and check in one iteration.

### Additional context

Repeat `--context PATH` to append files or recursively read directories.

```bash
ralphworks run 'Implement export from the supplied specification' \
  --context /any/path/spec.md \
  --context ./docs/api
```

Directory traversal skips `.git`, `.ralph`, and `node_modules`. Files containing NUL bytes are treated as binary and skipped. The combined context is limited to 100 files and 1 MiB of text. Paths are resolved from the directory where RalphWorks starts unless they are absolute.

### Structured YAML jobs

Use YAML when a task needs reusable limits, checks, or a commit policy.

```yaml
name: fix-result-refresh
task: |
  Preserve completed results after a page refresh.
  Keep the assessment algorithm unchanged and add relevant tests.
max_iterations: 8
max_minutes: 45
max_cost_usd: 5
check_timeout_seconds: 120
commit: verified
checks:
  - npm test
  - npm run build
```

| Field | Contract and default |
| --- | --- |
| `name`, `task` | Required non-empty strings. `task: \|` supports a multiline block. |
| `profile` | Optional task profile name or path; `--profile` overrides it. |
| `prompt_file` | Optional file appended to the task. Relative paths use the starting directory. |
| `progress_file` | Optional; defaults to `.ralph/progress/<job-name>-<task-hash>.md`. Set an explicit path when separate tasks should share progress. |
| `completion_promise` | Optional; defaults to `DONE`. Set only when another completion value is required. |
| `max_iterations` | Positive integer; defaults to 5. |
| `max_minutes`, `max_cost_usd` | Optional non-negative numbers. Every run defaults to 30 minutes; unattended Docker and GitHub Actions also default to $3 when cost is omitted. Pi reports cost, so one iteration may cross the configured amount. |
| `checks` | Optional independent validation commands. Required for `commit: verified`. |
| `check_timeout_seconds` | Timeout for each check; defaults to 60 seconds. |
| `commit` | `none` by default, or `verified`. |
| `mode` | Omit or set to `local`. `remote` fails during parsing; use the separate `remote` command. |

The parser supports a deliberately small YAML subset: top-level scalar fields, a `task: |` block, and a two-space-indented list under `checks`. Nested objects, anchors, and inline arrays are unsupported. Unknown fields, duplicate fields, and unsupported indentation fail immediately.

Values resolve from built-in defaults, then task profile defaults, then explicitly supplied YAML fields, then CLI overrides. CLI options override the matching job values: `--max-iterations`, `--max-minutes`, `--max-cost-usd`, `--check-timeout`, `--commit`, `--completion-promise`, repeatable `--check`, and repeatable `--context`. CLI options suit one-off work; YAML suits reviewed and reusable jobs.

Docker and remote commands also accept `--total-minutes N` (default: 120, maximum: 1440). This bounds the whole Docker command, including clone and dependency installation, or the remote dispatch, wait, and artifact download. It is separate from `--max-minutes`, which bounds the agent loop. A timed-out Docker command attempts to force-remove its container; a timed-out remote wait requests cancellation of the Actions run. Check the run URL if cancellation fails or is still in progress. Host runs use `--max-minutes` and reject `--total-minutes`.

## Reusable task profiles

A profile defines **the reusable agent environment for a task type**: how to work, which capabilities to expose, and how to validate the result. A task describes **what to accomplish this time**. A runtime preset selects optional model and execution settings. Profiles never select a provider, model, executor, or workspace.

```bash
ralphworks profiles list
ralphworks profiles show builtin:bugfix
ralphworks plan 'Fix login after session expiry' --profile builtin:bugfix --check 'npm test'
ralphworks run 'Fix login after session expiry' --profile builtin:bugfix --check 'npm test'
ralphworks profiles add builtin:bugfix my-bugfix
ralphworks profiles update my-bugfix
ralphworks profiles remove my-bugfix
```

The nine shipped profiles are organized as delivery (`bugfix`, `domain-modeling`), quality (`code-review`, `architecture`, `test-coverage`, `security-maintenance`, `performance`), and design (`ui-implementation`, `ux-review`). Bugfix combines reported defects and bounded discovery through `mode=reported|discover`, with `maxFixes=1` by default. Coverage includes the Brooks test-quality skill and records both quality findings and measured coverage in `COVERAGE_REPORT.md`. Architecture explicitly selects improve-codebase-architecture and its codebase-design companion. See the [catalog](TASK_PROFILES.md) for complete environments, parameters, source provenance, reports and migration instructions. Generic coding and documentation remain explicit examples rather than built-in entries; direct tasks need no profile. Optional [capability profiles](CAPABILITY_PROFILES.md) add browser and MCP integrations without requiring them in the base catalog. No built-in requires an external service. Bugfix, UI implementation and UX review include the Playwright CLI skill, bash and `requires.commands: ["playwright-cli"]` directly; prepare the executable and browsers in the chosen executor before running. UX permits task-owned browser evidence while prohibiting implementation edits. The built-in code review has read/search tools and a report-only write permission; it returns findings in its final response and writes required `CODE_REVIEW.json`.

Bugfix preserves independently established external contracts. When producers and consumers disagree, use versioned specifications, compatible fixtures or read-only history to choose the repair; a successful round trip alone does not prove backward compatibility. Unresolved contract choices require input before dependent edits.

For UI work that needs pixel-level judgment, configure an image-capable model. Text-only runs can verify DOM geometry and interactions, but must mark visual inspection unavailable. Capture evidence after the intended viewport/state and layout settle, checking state and overlays before and after capture. Use a unique filename for every capture and retry; never overwrite cited evidence. Record each final image path, viewport, state, observation basis and SHA-256 in UI_REPORT.md, then rehash all referenced files before completion. Hashes establish identity, not state or pixel correctness.

Image capability belongs to the selected Pi model entry, independently of the profile: declare `"input": ["text", "image"]` only after verifying that the route accepts image content. An omitted input declaration defaults to text-only in the current Pi version; a vision-capable backend alone does not enable the adapter to inspect images. Keep unavailable visual acceptance as needs-input rather than a completion claim.

`profiles add SOURCE NAME` saves a bundle in the personal library, flattens inheritance, and copies prompt files, local skill and extension directories, and explicit context files. Remote skills retain their source declarations and current commit pins, so they can be updated independently. Extension support files are preserved; for a standalone extension file, its containing directory is copied. Prefer a dedicated extension directory to keep the bundle focused. Collection refuses existing names and symlink assets. Edit the collected prompts and configuration to customize the method. After editing a copied local skill, run `profiles update NAME` to adopt its new content; use `skills fork` to customize a Hub skill. `remove` affects only the personal profile library.

Named profiles resolve project `.ralphworks/profiles/<name>/profile.json` first, personal `<home>/profiles/<name>/profile.json` second, then shipped built-ins. Home is `RALPHWORKS_HOME`, or `~/.config/ralphworks`. `builtin:NAME` bypasses project and personal overrides. `list` shows effective entries using this precedence. Incomplete bundles and unrelated files are skipped; invalid manifests report an error. A selector may also be a directory or manifest path; use `./` for relative directory selectors.

### Author a bundle

```text
bugfix/
├── profile.json
├── method.md
└── skills/debugging/
    ├── SKILL.md
    └── references/guide.md
```

```json
{
  "version": 1,
  "name": "bugfix",
  "description": "Reproduce and repair a defect",
  "prompts": ["method.md"],
  "skills": ["skills/debugging"],
  "parameters": { "target": null, "style": "concise" },
  "defaults": { "maxIterations": 6, "maxMinutes": 30 },
  "checks": ["npm test"],
  "artifacts": ["BUGFIX_REPORT.md"],
  "environment": {
    "resourceInheritance": "none",
    "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "extensions": [],
    "contextFiles": [],
    "mcp": {},
    "requires": { "commands": ["git", "npm"], "env": [] }
  },
  "outputs": [{ "path": "BUGFIX_REPORT.md", "format": "text", "required": true }]
}
```

| Field | Contract |
| --- | --- |
| `version`, `name` | Required: version `1` and a non-empty name. |
| `description` | Optional description shown in the library. |
| `category` | Optional non-empty grouping label shown in list and resolved profile output. Custom labels are supported; the most specific declared value wins and collection preserves it. Categories do not change execution policy. |
| `extends` | Ordered array of named profiles or relative profile directory/manifest selectors, such as `../base`. |
| `prompts` | Ordered relative paths to instruction files. |
| `skills` | Local paths, explicit `builtin:NAME` / `project:NAME` / `personal:NAME` Hub references, `{ "use": "project:NAME", "autoUpdate": true }`, GitHub URLs, or compatible remote source objects with optional `entrypoint` for a nested `SKILL.md`. |
| `parameters` | String defaults, `null` for required strings, or typed descriptors described below. |
| `defaults` | Optional `maxIterations`, `maxMinutes`, `maxCostUsd`, `checkTimeoutSeconds`, `commit`, and `completionPromise`. Uses camelCase, unlike YAML job fields. |
| `checks` | Literal shell commands; a descendant's declared array replaces inherited checks, including an empty array. |
| `artifacts` | Expected relative output paths, without parent traversal; instructions for the agent. |
| `environment` | Explicit agent resources, tool selection, MCP capability requirements, and preflight requirements. |
| `outputs` | Independent file validators: `{ "path": "report.json", "format": "json", "required": true }`. |

Prompt and selected skill instructions use `{{target}}` placeholders. Unknown parameters, missing required parameters, and unresolved placeholders fail before execution. Values are inserted literally in one pass; they are never interpolated into check commands. Keep secrets in provider configuration and environment variables, since task parameters appear in resolved plans and run records.

Typed parameter descriptors use `type: "string" | "number" | "boolean"`, a matching `default` or `required: true`, and an optional `enum` of matching values. For example, `"retries": { "type": "number", "default": 2 }` accepts `--param retries=3`; booleans accept only `true` or `false`. The prompt receives the resolved string representation. Numeric descriptors also accept `integer: true`, inclusive `minimum` and inclusive `maximum`. For example, `"maxChanges": { "type": "number", "default": 3, "integer": true, "minimum": 1, "maximum": 10 }` rejects `0`, `1.5` and `11` before workspace creation or agent startup. Constraints apply to defaults and enum members as well as supplied values, and survive inheritance and collection. Unconstrained numeric descriptors retain their previous behavior. Defaults outside the enum, inverted ranges, non-numeric bounds and unknown descriptor fields are rejected.

Resolved instructions start with the effective parameters as escaped JSON data. Values are not expanded a second time; this makes supplied/default limits explicit to the agent without shell interpolation. Parameters are task data, not credentials.

Inherited prompts, skills, extensions, and context files concatenate in order and deduplicate by canonical path. Later ancestors and then the descendant override parameter declarations and individual job defaults. A declared tool array replaces inherited tools; `[]` disables built-in and extension tools while separately selected MCP tools remain available. `resourceInheritance` uses the most specific explicit value. MCP entries merge by alias, with a descendant's complete entry replacing that alias. Required commands and environment names combine. Output entries merge by path, with later entries replacing earlier requirements; artifact expectations combine. Resource paths are relative to the declaring bundle. Cycles and more than 32 levels are rejected. Combined manifests, prompts, contexts, and complete skill/extension support files are limited to 100 files and 1 MiB. Unknown fields and invalid values fail before execution.

See [explicit capability profiles](CAPABILITY_PROFILES.md) for browser CLI variants, Context7, indexed CodeGraph, public DeepWiki research, and complete upstream bundles. These remain explicit task/runtime configurations and exclude Alcove.

### Persistent Skill Hub

The Skill Hub stores complete skill snapshots as durable assets. A task profile selects skills; its lock file selects exact versions. Model providers, executors, and MCP connections remain runtime settings. Hub assets are separate from disposable download caches and are never removed by automatic cache eviction.

| Scope | Location | Purpose |
| --- | --- | --- |
| `builtin:NAME` | `skills/` in the RalphWorks installation | Archived upstream skills, legacy snapshots, and pinned profile dependencies, available without network access. |
| `project:NAME` | `.ralphworks/skills/` in the target project | Skills committed with the project for teammates, worktrees, Docker clone, and CI. |
| `personal:NAME` | `<home>/skills/` | Durable personal collection. Home is `RALPHWORKS_HOME` or `~/.config/ralphworks`. |

Only explicitly selected Hub skills are loaded. A personal collection does not automatically enable ambient agent resources; `environment.resourceInheritance` remains `none` by default.

Import a GitHub skill into the project Hub:

```bash
ralphworks skills add https://github.com/anthropics/skills \
  --path skills/frontend-design --ref main \
  --name frontend-design --scope project
```

A GitHub tree/blob skill URL can also be used as the source. To import an existing local skill directory, pass that directory instead of a URL.

Reference it in `.ralphworks/profiles/frontend/profile.json`:

```json
{
  "version": 1,
  "name": "frontend",
  "skills": ["project:frontend-design"],
  "environment": { "resourceInheritance": "none" }
}
```

Create the profile's portable pins explicitly, inspect the result, and commit the profile, lock file, and Hub together:

```bash
ralphworks profiles update frontend
ralphworks profiles show frontend
ralphworks plan 'Build an accessible settings page' --profile frontend
```

Named project and personal dependencies require a prepared `profile.lock.json` beside the profile manifest. Ordinary resolution does not create or modify project locks. For a custom manifest such as `review.json`, the corresponding lock is `review.lock.json`. The lock binds each logical skill selection to a content snapshot and storage scope without machine-specific absolute paths. A named skill's later catalog update does not change existing profile pins.

The Hub contains `catalog.json` and `objects/<digest>/manifest.json` plus each object's `content/` directory. Snapshots preserve `SKILL.md`, references, scripts, assets, and executable permissions. Import validates regular files, rejects symlinks and unsafe paths, and enforces resource limits. Integrity is checked before use; edited or corrupt objects are rejected rather than silently replaced. Customize an editable fork instead of editing an object.

The Git commit records upstream provenance. A separate SHA-256 digest identifies the archived files, paths, and executable permissions. Multiple upstream commits can share the same content snapshot while keeping separate provenance records. Local imports have a content digest without inventing a Git commit. Catalog revisions retain history; snapshots are immutable.

Once all locked snapshots are saved in the project Hub, the project can be copied to a new location and run with an empty personal library and no upstream access. Commit all referenced objects, catalog data, profiles, prompts, and locks. A Git commit hash alone does not archive the source files. Personal Hub references require either that personal library or explicit vendoring.

#### Update and inspect skills

```bash
ralphworks skills list
ralphworks skills list --scope project
ralphworks skills inspect project:frontend-design
ralphworks skills verify project:frontend-design
ralphworks skills update project:frontend-design
ralphworks profiles update frontend
```

`skills update` archives a new revision and advances the catalog's current version. `profiles update` adopts the selected catalog versions for that profile. For a locked local path, explicitly updating the profile adopts edits to that source; ordinary runs keep the locked copy. Other profiles retain their own pins. Explicit update failures return an error and keep existing profile pins usable. These commands may change tracked project assets; review and commit them before a run requiring a clean worktree.

Automatic updates are optional per profile selection:

```json
"skills": [
  { "use": "project:frontend-design", "autoUpdate": true }
]
```

`run` attempts one refresh before preparing inputs. New automatic versions and source revisions are stored in the personal persistent Hub under managed `auto-...` entries, visible through `skills list --scope personal`, and recorded as run-only selections; the project's catalog and lock remain unchanged. If the upstream is unavailable but the pinned snapshot is valid, the run continues with that snapshot and records the refresh failure. Missing or corrupt snapshots still fail. `show` and `plan` do not refresh. Prepared inputs stay fixed across all iterations and subsequent Hub updates.

#### Vendor, export, and customize

```bash
ralphworks profiles vendor frontend
ralphworks skills export project:frontend-design ./frontend-design.bundle
ralphworks skills import ./frontend-design.bundle --name frontend-design --scope personal
ralphworks skills fork project:frontend-design ./skills/my-frontend-design
ralphworks skills add ./skills/my-frontend-design --name my-frontend-design --scope project
```

`profiles vendor` copies selected skill snapshots into the project Hub and writes portable pins. It can migrate already pinned remote cache content without downloading it again, so it remains useful after the upstream repository disappears. Vendoring skills does not copy external parent profiles, prompts, contexts, or extensions; keep the complete profile bundle available too.

Export creates a portable directory bundle with archived content and version metadata. Import verifies the bundle before adding it to a Hub. A fork creates an editable copy and retains its derivation metadata when reimported. Your customized skill becomes an independent snapshot; upstream updates do not overwrite it. Collection with `profiles add` also preserves selected Hub assets and independent pins in the personal library.

Imports preserve supplied license and NOTICE files. GitHub imports also archive matching repository-root license and NOTICE files under `.upstream/` inside the snapshot, rejecting reserved-directory collisions. An old cached skill imported without those root files cannot reconstruct them offline. External dependencies such as package downloads, remote services, and files outside the selected skill directory are not automatically made available offline. Declare those dependencies explicitly through the task environment or project setup.

### Skills from GitHub

Local skills stay simple: `"skills": ["skills/debugging"]` loads the entire directory, including references and scripts. You can also select a skill from a GitHub repository without installing it globally:

```json
{
  "version": 1,
  "name": "team-review",
  "extends": ["builtin:code-review"],
  "skills": [
    {
      "source": "https://github.com/OWNER/REPOSITORY",
      "path": "skills/review",
      "ref": "main",
      "autoUpdate": false
    }
  ]
}
```

Replace `OWNER/REPOSITORY` and `skills/review` with the repository and directory containing the skill's `SKILL.md`. `source` selects an HTTPS GitHub repository; `path` selects the skill within it. `ref` selects a branch, tag, or full commit SHA. Omit `ref` to select the repository's default branch. `autoUpdate` defaults to `false`.

For a complete example using a public skill, see [`github-frontend`](../examples/profiles/github-frontend/profile.json). Its branch is pinned locally on first use; replace `main` with a commit SHA to share an exact version.

A direct link also works:

```json
"skills": [
  "https://github.com/OWNER/REPOSITORY/tree/main/skills/review"
]
```

A GitHub `blob` link ending in `SKILL.md` is accepted too, including a skill at the repository root (`"path": "."` in the object form). Use the object form when a branch or tag name contains `/`, so the ref and path are unambiguous. Remote imports require Git and network access on the first resolution. A source `path` selects the complete archive root; optional `entrypoint` selects a nested `SKILL.md` within it and defaults to `SKILL.md`. Use `skills add --entrypoint brooks-test/SKILL.md` to import a bundle with shared sibling resources. Entrypoints must remain inside the selected tree. They copy only the selected directory, never execute an installation script, and reject symlinks, unsafe paths, and resources exceeding the profile limits.

On first resolution, RalphWorks resolves each remote source to a full commit SHA. Subsequent resolutions use that pin and the local cache, including offline runs. Source declarations and hashes remain separate from the task's model provider and executor. The resolved manifest and each run's `task.json` record the repository, path, requested ref, and exact commit used.

Update all remote skills selected by a profile, including inherited skills, explicitly:

```bash
ralphworks profiles show team-review
ralphworks profiles update team-review
ralphworks plan 'Review the API changes' --profile team-review
```

The update reports the previous and new commits. Source updates are prepared together; a failed update preserves the previous pin set. Local prompts and local skills are never replaced. Collected profiles keep their own pins and update independently of the original profile.

To follow a branch automatically, set `"autoUpdate": true` on that source. When inheritance repeats the same repository, path, and ref, any explicit `true` enables updates for that source; distinct refs remain independently tracked. `run` refreshes opted-in sources once before preparing its inputs. `show` and `plan` keep existing pins; they may install a missing dependency on first use. Updates never happen between iterations. A failed automatic refresh uses the previous valid pin and records the refresh failure; missing or corrupt pinned content still fails. Each prepared run stages its own skill files, so a later update cannot change a running task.

Compatible inline download caches and their original pin records live under `<home>/cache/`, where home is `RALPHWORKS_HOME` or `~/.config/ralphworks`. An explicit profile update also writes a portable profile lock; its referenced personal snapshots must be vendored to make the project self-contained. They do not modify the target repository or make a clean worktree dirty. Pins belong to the selected top-level profile; a parent selected separately has its own pin set. For the same version across machines or CI, put a full commit SHA in `ref`; branch-based local pins are machine-local. Clone and remote executors resolve repository-defined sources in their own environment and need network access for an uncached dependency.

Inline GitHub declarations remain compatible and use machine-local cache pins. For durable project delivery, run `profiles vendor NAME` and commit the resulting Hub objects and portable profile lock. Customize a local skill copy or a Hub fork instead of editing managed cached content. Cache integrity checks reject modified files rather than overwriting edits during an update.

### Agent environment

| Field | Contract |
| --- | --- |
| `resourceInheritance` | `none` (default), `project`, or `all`. `none` loads only declared resources. `project` additionally loads resources belonging to the target project. `all` allows Pi's configured project and global resources. |
| `tools` | Exact names of built-in or extension tools exposed to the agent. Default: `read`, `bash`, `edit`, `write`. Unknown names fail session setup. |
| `extensions` | Relative paths to Pi extension files or directories, including supporting code. |
| `contextFiles` | Relative paths to explicit context files. |
| `mcp` | Logical aliases mapped to `{ tools?, required?, timeoutSeconds? }`; actual connections come from the runtime. |
| `requires` | `{ commands?: string[], env?: string[] }`; required commands and environment variable names checked in the chosen executor before starting the agent. |

To reuse the bugfix method while allowing project resources, save this as `.ralphworks/profiles/project-bugfix/profile.json`:

```json
{
  "version": 1,
  "name": "project-bugfix",
  "extends": ["builtin:bugfix"],
  "environment": { "resourceInheritance": "project" }
}
```

Run it with `--profile project-bugfix`. Use `all` only when you intend to include global resources as well.

Resource inheritance is off even for tasks without a profile. Choosing `none` does not disable model configuration or authentication. Explicit skills are included in task instructions and loaded through Pi's resource loader. Explicit contexts and complete resources are staged under `.ralph/inputs/` for host and Docker mount execution. Project inheritance filters discovered context and skills to the project root. `all` deliberately permits machine-specific resources, so use explicit bundles when sharing a method.

The tool list selects the agent interface; it is not an operating system sandbox. A tool such as `bash`, an extension, or an MCP service can access capabilities beyond a file allowlist. Pi extensions receive session startup/shutdown lifecycle events. Each fresh iteration connects its declared MCP services and closes them when that session ends or is cancelled.

Every run saves `task.json` with its resolved environment, parameters, source paths, and SHA-256 fingerprints, including extension support files and explicit contexts. Selected tools and MCP connection inventory are recorded in `environment-<iteration>.json` and summarized in iteration events. Fingerprints identify explicit resources; they do not freeze resources discovered through opt-in inheritance.

### Output validation

`outputs` defines independent acceptance requirements in addition to shell checks. Paths must be relative without parent traversal. Required outputs must exist as non-empty regular files. `format: "text"` checks for non-empty text; `format: "json"` additionally parses JSON. Missing optional outputs (`required: false`) are allowed; present outputs must still validate. Use an explicit `--check` or profile check for JSON schema validation and domain-specific assertions. The loop carries validation failures into the next iteration and cannot complete until these requirements and the configured checks pass.

`--profile` overrides the YAML `profile` field, which overrides the configured default profile. A YAML selector is relative to the starting directory. Checks and limits use CLI overrides, then explicitly supplied YAML fields, then profile defaults, then built-in defaults.

### Inspect a plan

`ralphworks plan TASK` accepts the same options as `run` and prints resolved JSON. It validates profiles and parameters without starting Pi, running checks, or creating a worktree. Use it before an unattended run:

```bash
ralphworks plan 'Review the API change' \
  --profile /path/to/ralphworks/examples/profiles/code-review \
  --param scope='the difference between main and HEAD' \
  --workspace worktree
```

## Runtime presets and defaults

Runtime presets keep model connectivity and execution choices outside task profiles:

```json
{
  "version": 1,
  "model": "provider/model-id",
  "piAgentDir": "~/.pi/agent",
  "executor": "host",
  "workspace": "worktree",
  "passEnv": ["CUSTOM_API_KEY"]
}
```

Every field except `version` is optional. Executor values are `host`, `docker`, and `docker-clone`; workspace values are `current` and `worktree`. `piAgentDir` supports `~` and paths relative to the runtime file. `passEnv` lists environment variable names, never credential values.

```bash
ralphworks run 'Fix the login error' --profile builtin:bugfix --runtime ./runtime.json
ralphworks run 'Fix the login error' --profile builtin:bugfix --runtime host --executor docker
```

Named runtimes resolve from project `.ralphworks/runtimes/<name>.json`, then personal `<home>/runtimes/<name>.json`. Copy and customize [host](../examples/runtimes/host.json) and [Docker](../examples/runtimes/docker.json) examples into either location. A runtime's model and Pi directory are optional; execution presets can use your existing Pi configuration.

Optional `<home>/config.json` and project `.ralphworks/config.json` choose defaults:

```json
{ "version": 1, "profile": "bugfix", "runtime": "host" }
```

Project settings override personal settings. Named selectors follow library lookup; path selectors are relative to the config file that declares them. CLI selectors override these defaults. Model settings resolve CLI → environment → runtime → Pi. Executor resolves CLI → runtime → `host`; workspace resolves CLI → runtime → `current`.

### MCP bindings

A profile requests logical MCP capabilities independently of the model and execution environment:

```json
{
  "environment": {
    "mcp": {
      "docs": { "tools": ["lookup"], "required": true, "timeoutSeconds": 30 }
    }
  }
}
```

The requirement defaults to required. Omit `tools` to expose all advertised tools, or use `[]` to expose none. Selected tools are added as `mcp__docs__lookup`; they do not need to appear in `environment.tools`. A missing binding, failed connection, or missing selected tool fails setup unless `required: false`, which records the service as unavailable. Timeouts must be greater than zero and at most 600 seconds.

A runtime supplies the matching connection:

```json
{
  "version": 1,
  "mcp": {
    "docs": {
      "transport": "http",
      "url": "http://127.0.0.1:8318/mcp",
      "headers": { "Authorization": "DOCS_AUTHORIZATION" }
    }
  }
}
```

Set `DOCS_AUTHORIZATION` to the complete header value, such as `Bearer <token>`. Header configuration contains environment variable names, never secret values. For stdio, use `{ "transport": "stdio", "command": "node", "args": ["server.mjs"], "cwd": "../mcp", "env": { "API_TOKEN": "DOCS_API_TOKEN" } }`. `cwd` resolves relative to the runtime file. `env` maps child variable names to parent variable names. Command arguments remain literal: no shell, task-parameter, or environment interpolation runs.

Binding credential variable names are forwarded by Docker executors; selected service credentials are passed to the MCP connection. Local absolute paths and installed commands do not become available in containers automatically. Install the service in the image, provide repository-relative resources available in that environment, or use a reachable HTTP endpoint. Inside a container, `127.0.0.1` refers to the container itself.

The [MCP review profile](../examples/profiles/mcp-review/profile.json) and [HTTP runtime](../examples/runtimes/mcp-http.json) show the separation. Configure the endpoint and exported tool name for your service before running them. Built-in profiles do not depend on this example service. From the RalphWorks checkout, inspect the composed configuration before connecting:

```bash
ralphworks plan 'Review the proposed API change' \
  --profile ./examples/profiles/mcp-review \
  --runtime ./examples/runtimes/mcp-http.json
```

`plan` validates the declarations without contacting the service. Replace `plan` with `run` once the endpoint, credentials, and tool name are configured.

### Optional compatible model gateway

Any compatible gateway can be configured in Pi's native `models.json`; RalphWorks has no gateway dependency. The [example](../examples/pi/local-proxy/models.json) uses OpenAI Chat Completions and resolves its API key from the environment using Pi's `$VARIABLE` syntax:

```json
{
  "providers": {
    "local-proxy": {
      "baseUrl": "http://127.0.0.1:8317/v1",
      "api": "openai-completions",
      "apiKey": "$LOCAL_MODEL_API_KEY",
      "models": [{ "id": "REPLACE_WITH_YOUR_MODEL_ID" }]
    }
  }
}
```

Replace the model ID in both `models.json` and the [runtime example](../examples/runtimes/local-proxy.json) with an ID your gateway exposes. Set `LOCAL_MODEL_API_KEY` in your shell to the configured gateway token. From the RalphWorks checkout:

```bash
ralphworks plan 'Fix the login error' --profile ./examples/profiles/bugfix \
  --param target=login --runtime ./examples/runtimes/local-proxy.json
ralphworks run 'Fix the login error' --profile ./examples/profiles/bugfix \
  --param target=login --runtime ./examples/runtimes/local-proxy.json
```

The runtime example points at `../pi/local-proxy` relative to its own file. If you move it into a personal runtime library, update `piAgentDir` to the directory containing your Pi configuration. You can change `--workspace` or `--executor` without changing the task profile or model provider.

CLIProxyAPI is one optional compatible gateway. Start it separately with your own configuration, for example `cli-proxy-api --config ~/.cli-proxy-api/config.yaml`, then configure Pi against the exposed endpoint. A local gateway does not imply local model inference. The examples demonstrate configuration; a live gateway and model tool-call round trip must be verified against your own installation.

In Docker, `127.0.0.1` points to the container. For a gateway on the host, configure a reachable endpoint, such as `http://host.docker.internal:8317/v1` on Docker Desktop, and ensure the service binds to an address accessible from the container. Linux may require explicit host-gateway routing. RalphWorks does not rewrite gateway URLs.

## Task workspaces

Workspace selection controls where files change; executor selection controls where commands run. Use `--workspace current` to edit the starting worktree, or `--workspace worktree` to create a task worktree. Either workspace supports the host executor or Docker mount executor.

```bash
ralphworks run 'Fix the login error' --profile bugfix --param target=login \
  --workspace worktree --check 'npm test'
ralphworks run 'Fix the login error' --profile bugfix --param target=login \
  --workspace worktree --executor docker --worktree-path ../login-repair --check 'npm test'
```

Task worktrees require a clean Git repository root, excluding generated `.ralph/` state. They start at the current HEAD on a unique `ralphworks/<uuid>` branch and include committed inputs. Commit project profiles, task files, and context first. Install task dependencies in the new worktree as appropriate for your project; ignored dependency directories are not copied from the starting worktree.

The CLI reports the created path, branch and ownership record. Newly created host worktrees default to verified recovery archiving and removal after success, failure, cancellation or a limit, provided execution is quiescent and ownership remains unchanged. Use `--keep-worktree` to retain one for inspection. The task branch remains in the source repository; RalphWorks does not merge or push it. Current workspaces, including workspaces supplied by another scheduler, are never removed. `--worktree-path` requires `--workspace worktree`; its target must not already exist. Worktree selection cannot be combined with `docker-clone`, which prepares its own clone. Docker-owned worktrees are explicitly retained because container absence and external state mapping are not established by this cleanup path.

### Workspace cleanup and recovery

```bash
ralphworks run task.md --workspace worktree --check 'npm test'
ralphworks run task.md --workspace worktree --keep-worktree
ralphworks workspaces list
ralphworks workspaces prune --dry-run
ralphworks workspaces prune
```

Ownership records live under `<state-root>/workspaces/<id>.json`. The default registry root is the starting repository's `.ralph`; each owned host run uses `.ralph/workspace-runs/<id>` for inputs, progress, results and its current pointer. An explicit host `--state-dir` instead uses that exact caller-resolved directory. State and receipt destinations must remain outside a removable worktree, including its `.ralph` subtree. `plan` describes the cleanup policy without creating or collecting workspaces.

Before removal, the CLI persists the terminal result and any requested invocation receipt under the original worktree lock. It prints `cleanup=removed` and `recovery=<path>`, or `cleanup=retained` with a reason on stderr. Task status and exit codes retain their existing meaning; cleanup failure never rewrites a failed task into success. Workspace inventory reports cleanup independently. Use `--state-dir PATH` with `workspaces list` or `prune` for a nondefault registry. List and prune preview are read-only. Prune uses the same ownership checks as automatic cleanup and has no force override.

Recovery lives at `<state-root>/workspace-recovery/<id>`. Its private manifest records source/HEAD identity, file hashes, modes, symlink targets and excluded reproducible directories. `staged.patch` and `unstaged.patch` preserve the index separately. Additional files and tracked raw-byte overlays are stored by content hash under `files/`; restore them after applying patches, using the manifest's relative paths and modes without following symlinks. Tracked overlays are marked `tracked: true` and preserve working bytes hidden by line-ending normalization or clean filters. Separate mode overrides preserve differences from indexed permissions, including executable changes hidden by `core.filemode=false`. An immutable `refs/ralphworks/recovery/<id>` reference pins the terminal commit in the original source Git database. This is compact local recovery, not a standalone Git bundle: preserve the source repository and its recovery refs. To inspect tracked changes, create a review checkout at that reference, apply a nonempty staged patch with `git apply --index`, then apply a nonempty unstaged patch. Required outputs, ignored coverage/browser diagnostics and other non-reproducible ignored files are retained. Ignored dependency/build/cache directories can be excluded; symlink targets are never copied.

Capture is bounded to 32 MiB of patch/additional-file data, 4,096 recovery entries and 1 MiB of estimated metadata. Each Git output is bounded to 8 MiB and ten seconds; each source snapshot has a 30-second deadline. Clean tracked assets are streamed for integrity checks and compared with their indexed Git blob; matching bytes do not consume the capture byte/entry allowance. Raw mismatches use the same bounded overlay storage as other recovered files. Required-output and custom-progress preservation paths are normalized before ignored-directory exclusions. Exceeding a bound or encountering unsupported index flags (`assume-unchanged`/`skip-worktree`), conflicts, submodules, unreadable files or changed identity retains the worktree with a reason.

Automatic removal requires absent managed process groups and a fresh, bounded same-user POSIX `lsof` check for cwd/open-file references to the canonical workspace. A live reference, unavailable tool, timeout, truncation or unknown result retains it. These checks do not eliminate general filesystem races or establish ownership of arbitrary foreign writers. Cleanup never kills a process. Docker and hosts without supported process-reference proof retain owned worktrees.

A later `run --workspace worktree` or `workspaces prune` retries recorded normal terminal outcomes, plus quiescent/archived cleanup. A terminal outcome records the managed group IDs already observed during that invocation; retry must freshly prove those groups absent and the workspace unused before advancing to quiescent. It does not infer safety from an old timestamp or a dead parent PID: interrupted in-flight runs, legacy records, live locks, explicit keep policy and unknown ownership are retained for inspection. Published recovery survives a crash between archive and removal; replay verifies its hashes before completing. Forced process termination can still leave an in-flight workspace that needs an operator to establish safety.


For Docker clone and GitHub Actions, store profiles, skills, prompt files, and runtime inputs in the repository and push them to the selected ref. Personal host library paths are not automatically present in those environments. A YAML `profile` field is useful for remote tasks. Docker clone also forwards the explicit `--profile` selector and parameters, which must refer to inputs available inside that clone.

## Iteration and terminal states

Each iteration creates a new Pi session and supplies the task plus a bounded view of durable progress from earlier iterations. The full progress history stays on disk. For tasks with several items, the agent chooses the highest-priority unfinished item. After the agent returns, RalphWorks records model events and cost, runs every configured check, updates progress, and decides whether to continue. Failed check output is included in the next iteration's progress, capped at 2,000 characters per failed check.

The agent receives the enforced agent/check deadline in UTC, the remaining time when its prompt is built, and the configured checks that RalphWorks runs after it returns. An internal Pi context extension refreshes the current UTC time and remaining seconds before each Pi agent model turn, using that same absolute deadline. The note is transient and does not accumulate in session history. Implementation, report, handoff and scheduled checks share the run budget; the deadline is never restarted. Focused verification, meaningful source changes and failed-check diagnosis still need their own checks; repeating an unchanged-input command only to duplicate the scheduled gate is unnecessary. Never present a scheduled check as already passed. Architecture tasks inspect whole-change affected-check selection early, including shared configuration inputs, alongside per-moved-path acceptance selection. They keep their report current as commands finish, including failures and limits.

Architecture tasks inspect the actual verification script and preserve compatible existing dependency resolutions when an authorized prerequisite fix is needed. Additional lockfile updates require a concrete reason; a similarly named package script does not define a built-in package-manager command's behavior.

Pi may retry transient model failures within the same iteration. A recovered response can continue normally; terminal error or aborted responses remain blocked. Historical errors remain in run events. Only the final assistant handoff supplies completion or human-input signals, so an earlier failed or superseded response cannot complete a task.

For example, `"retry": { "enabled": true, "maxRetries": 2, "baseDelayMs": 60000 }` in the selected Pi `settings.json` configures the SDK's session backoff to wait 60 seconds, then 120 seconds, for up to two retries. Retry waits consume the original task deadline and remain cancellable; they do not add task rounds or extend the budget. This uses the SDK's existing retry behavior, not exact `Retry-After` handling, and does not change the default retry policy.

A completion tag requests completion. A configured check failure prevents completion even when the tag is present. Without independent checks, the tag is sufficient; it is an agent report, not independent proof that the task is correct. Use checks covering the essential acceptance criteria for unattended work. Two consecutive Git iterations without worktree progress stop as `blocked`.

Terminal states are:

- `completed`: the completion condition and all configured checks passed.
- `needs_input`: the agent asked one concrete question that requires a person; the run stops before checks or verified commits. Read `reason` in `ralphworks status .ralph/current`, update the task, and run again.
- `blocked`: the agent reported an error, changed Git HEAD, made no progress, or violated another guard.
- `cancelled`: the local CLI received Ctrl+C or SIGTERM and stopped the active worker or check before releasing its lock.
- `max_iterations`: the loop exhausted its iteration limit.
- `timed_out`: the run or a check exceeded its deadline.
- `budget_exhausted`: reported model cost crossed the configured limit.
- `failed`: orchestration or Git processing failed.

Only `completed` returns CLI exit code zero. The local CLI returns 130 after Ctrl+C and 143 after SIGTERM. It runs each Pi iteration in a child process; cancellation or a wall clock timeout terminates that process group before releasing the worktree lock. Cleanup can finish shortly after the configured limit. Embedders using a custom in-process runner must make it respond to abort signals.

Run records omit raw assistant text deltas. The runner keeps at most 1,000 structural events per iteration, event details over 2 KiB are omitted, and check output is limited to the last 8,192 characters per stream. Values of environment variables named like `*_API_KEY`, `*_TOKEN`, or `*_SECRET` are masked in recorded text when they are at least eight characters long. This cannot detect credentials read from arbitrary files or secrets transformed by a command. Review `.ralph/` and remote artifacts before sharing them; keep task and check output free of secrets.

## Checks and Git policy

Checks are optional for ordinary work. They are commands executed by the orchestrator after every iteration and should cover the task's critical acceptance behavior.

The architecture profile allows 180 seconds per configured check; ordinary tasks default to 60 seconds. Override this with `--check-timeout SECONDS` or a job's `check_timeout_seconds`. Each check still shares the overall `--max-minutes` deadline with implementation and handoff. Size that deadline for all required checks and any caller-owned review; a larger per-check cap does not create additional run time. Avoid running competing heavy suites concurrently when setting limits from observed durations.

`commit: verified` requires:

- A Git repository and clean starting worktree, excluding `.ralph/`.
- At least one configured check.
- A configured Git author.

After every iteration whose checks pass, RalphWorks commits that iteration's changes, even if the overall task needs another iteration. The agent is instructed not to commit. If Git HEAD changes during the agent step, the run stops as `blocked` so the agent cannot bypass verification. RalphWorks does not undo an agent-created commit; inspect it manually.

Use verified commits on a dedicated branch or worktree. A passing command proves only what that command checks and does not replace semantic review.

## Machine-readable run receipts

External schedulers can invoke the CLI without importing RalphWorks internals or parsing terminal output. Use an unused caller-owned result path and a unique invocation identifier:

```bash
ralphworks run task.md --profile builtin:architecture \
  --runtime maintenance --executor host --workspace current --commit none \
  --result-file /path/to/attempt/receipt.json --invocation-id attempt-123
```

`--result-file` and `--invocation-id` must be supplied together and are supported by `run` with the host executor. The identifier accepts 1–128 ASCII letters, digits, underscores and hyphens, beginning with a letter or digit. Receipt transport for Docker and remote runs is not supported; their existing execution/export interfaces remain available. A runtime remains an independent model/execution configuration reference. Callers requiring a current host worktree must supply those explicit overrides.

The [version 1 JSON schema](schemas/run-receipt-v1.schema.json) describes the receipt: invocation ID, start/finish times, canonical workspace and initial/final Git HEAD (null outside Git), raw task-input SHA-256, resolved profile fingerprint, terminal result and output-file digests. For file inputs the task hash covers exact original bytes; direct text hashes the supplied string. The profile fingerprint binds the resolved manifest, instructions, environment and output requirements for this invocation before resource staging, including local resource paths; it is not a cross-machine portable identity. Archived task manifests contain remapped skill paths, so hashing their staged profile directly does not reproduce this fingerprint. Portable skill provenance remains in the prepared task manifest.

A complete receipt is published atomically after terminal run-state persistence, while the execution worktree lock is still held, and before owned-workspace removal. Initial Git HEAD is captured after acquiring that same lock; final HEAD and output digests are captured before releasing it, including for current and caller-owned workspaces. Its workspace path identifies the historical execution location, which may no longer exist; external run records and the ownership/recovery record remain available. Existing files and symlinks are never replaced. A sibling `.lock` reserves the destination before agent/check execution; another invocation using that destination fails. Put receipts outside the repository when requiring a clean worktree. Pre-run resolution failures produce a nonzero exit without a terminal receipt. An interrupted process may leave its reservation; preserve its evidence and use a new attempt path rather than deleting an uncertain attempt and blindly rerunning it.

Every normal terminal status, including cancellation, unsuccessful checks and needs-input, retains a receipt. Internal `RALPHWORKS_PREPARED_TASK` transport cannot be combined with receipts, so a different prepared job cannot masquerade as the positional task. Missing, unreadable, nonregular, out-of-workspace or oversized outputs have a null digest; collection is bounded by the existing 1 MiB output validation limit and must not suppress an unsuccessful terminal receipt. The ordinary exit status is unchanged: completed is zero, SIGINT/SIGTERM cancellation is 130/143, and other unsuccessful results are nonzero. Forced termination can prevent a receipt. Clients must correlate the ID, exact task hash, workspace, baseline/current HEAD and referenced artifacts, then validate the terminal status, required outputs and applicable checks. Historical failed checks can precede a successful final iteration; use each check's `iteration`, not an all-history pass assumption. A digest binds bytes, not semantic correctness, and `completed` does not establish an independent domain acceptance decision.

The caller owns worktree preparation, cancellation/deadline supervision and delivery. RalphWorks owns its bounded agent/check loop. For a single Git owner use `--commit none`; the caller may review and commit only after its own acceptance gates. RalphWorks uses `.ralph/` for task state and staged resources. Preserve that state as artifacts and exclude it from source delivery; callers must not overwrite or delete preexisting user state. Model credentials, skill snapshots and MCP bindings remain in RalphWorks/Pi configuration, outside the scheduler protocol.

## Run state

Current-workspace host and Docker mount runs store state under `.ralph/`. Owned host runs use the external per-workspace state described above:

```text
.ralph/
├── current
├── progress/<job-name>-<task-hash>.md
├── inputs/
├── workspaces/
├── run.lock/
└── runs/<job-name>-<timestamp>/
    ├── events.jsonl
    ├── result.json
    └── task.json
```

`current` points to the latest run. Default progress paths include a hash of the complete task and supplied context: rerunning the same task reuses progress, while changed tasks start fresh. Without a state-directory override, an explicit `progress_file` keeps its chosen path. The lock prevents concurrent runs in one worktree. `ralphworks init` adds `.ralph/` to `.gitignore`.

For host execution, choose a separate runtime directory when project checks scan every project file:

```bash
ralphworks plan 'Inspect this project' --state-dir ../task-state
ralphworks run task.md --state-dir ../task-state --check 'npm test'
ralphworks status ../task-state/current
```

`--state-dir PATH` is a runtime choice for host `run` and `plan`, not a task-profile or runtime-preset field. Relative paths resolve from the caller's starting directory, including when `--workspace worktree` selects another worktree. Inputs and their skill/extension/context support files, run manifests, environment inventories, events, results, the current pointer and retained workspace records use that directory. Reported result and receipt paths identify their actual locations; receipt workspace/HEAD and output requirements still refer to the execution worktree. `plan` and help do not create state or a workspace.

Relative progress paths within `.ralph/`, including an explicit `progress_file: .ralph/progress/shared.md`, are rebased under the selected root. Explicit relative progress paths outside `.ralph/` remain relative to the execution worktree; explicit absolute progress paths remain unchanged. Without `--state-dir`, current-workspace paths and metadata stay unchanged; owned host runs use their external per-workspace root. Custom state inside a source or execution worktree is accepted only within its reserved `.ralph` namespace, with existing ancestor symlinks resolved for validation. Docker and remote execution reject `--state-dir`; there is no implicit container path mapping.

The worktree lock always stays at the execution worktree's `.ralph/run.lock`, independently of the selected state directory. Explicit state roots cannot contain the reserved `.ralph/run.lock` component pair or descend from it, including case variants and resolved symlink aliases, because lock cleanup removes that subtree. This conservative reservation applies even outside the selected workspace. Normal `.ralph/custom-state` and external directories remain supported. During an external-state run, the lock owner contains only a PID and random UUID; path-bearing implicit runtime records stay outside the worktree. Two invocations using different state directories still cannot write the same worktree concurrently. Keep state directories unique when separate worktrees or callers must retain independent run histories.

## Recovering an interrupted local run

Inspect the last result and the worktree before restarting:

```bash
ralphworks status .ralph/current
git status --short
git diff --check
git diff
```

For current workspaces and explicitly kept worktrees, RalphWorks leaves edits in place after a failure or interruption. Owned host worktrees otherwise use the recovery archive above when quiescence is proved; inspect the printed cleanup disposition first. If `commit: verified` is enabled, a dirty worktree blocks a new run so unchecked edits cannot be committed automatically. On the same dedicated branch, review the changed files, run the relevant project checks, then commit only the files you have verified. You can instead discard the edits after reviewing them. Rerun the same task and options once the worktree is clean; its default progress file is reused when the task and context are unchanged. Do not delete a lock held by a live run; a stale lock is reclaimed automatically when its owner is gone.

## Docker execution

Build the current image from the RalphWorks repository:

```bash
docker build -f docker/ralphworks-sandbox.Dockerfile -t ralphworks-sandbox:latest .
```

### Mount the current worktree

Docker mount mode mounts the current repository at `/workspace`. Changes, including changes to files that were already uncommitted, are written directly to the host.

```bash
cd /path/to/project
ralphworks run ralphworks.yaml \
  --executor docker \
  --pi-agent-dir ~/.pi/agent
```

The Pi directory is mounted into the container. Provider secrets are forwarded by environment variable name, which keeps values out of Docker command arguments. On Linux, the container maps its agent UID to the worktree owner so it can write without changing host file ownership. The container configures `ralphworks[bot]` as a default Git author; repository-local Git configuration can override it.

### Clone a clean branch

Docker clone mode clones a GitHub repository and branch into the container. The task file, any relative context, and dependency lockfiles must already be pushed. Private repositories require a readable `GH_TOKEN`.

```bash
ralphworks run ralphworks.yaml \
  --executor docker-clone \
  --repo owner/repo \
  --ref ralph/task-branch \
  --pi-agent-dir ~/.pi/agent
```

The container exports `change.patch`, `result.json`, and `events.jsonl` to `.ralph/exports/<run-id>/` before it exits. It never applies the patch to the local repository.

For a long clone or dependency installation, set a larger outer deadline, for example `--total-minutes 180`. The default agent loop limit still applies separately. If the outer deadline expires, the container is stopped and the export may be incomplete.

## GitHub Actions execution

The `remote` command dispatches GitHub Actions. YAML `mode: remote` is rejected at load time.

Run `ralphworks init` in the target repository, then commit and push `.github/workflows/ralphworks.yml` and `.gitignore` to the default branch. Initialization does not overwrite an existing workflow. The task file and files referenced by `prompt_file` must exist on the selected run branch.

Configure the target GitHub repository with:

- Optional variable `RALPHWORKS_SOURCE_REPO`, set to the `owner/repo` hosting the RalphWorks source. It defaults to `OctopusGarage/ralphworks`.
- Secret `RALPHWORKS_REPO_TOKEN`, with read access when the selected source repository is private. Public source repositories need no token.
- The selected Pi provider's credential secret. Set variable `RALPHWORKS_AUTH_SECRET` to that secret's name so the workflow exports it to Pi. The built-in Anthropic, OpenAI, NVIDIA, and Z.AI secret names remain available without the variable.
- Variable `RALPHWORKS_MODEL`, formatted as `provider/model-id`.
- Optional variable `RALPHWORKS_REF`, set to a branch, tag, or commit SHA in the RalphWorks repository. The generated workflow defaults to the `v0.2.0` release tag. Set this variable for a fork or another version; the resolved commit is saved in the result artifact.

The local `gh` account must be able to dispatch Actions in the target repository.

```bash
ralphworks remote ralphworks.yaml \
  --repo owner/repo \
  --ref ralph/task-branch \
  --total-minutes 120
```

The CLI dispatches the workflow, waits for it, and downloads artifacts under `.ralph/remote/<github-run-id>/`. The workflow checks out the target branch, builds RalphWorks, installs project dependencies, runs the host executor, and uploads the patch, run records, and default progress file. Its `contents: read` permission prevents code pushes.

Inspect and apply a returned patch explicitly:

```bash
git apply --check .ralph/remote/<run-id>/export/change.patch
git apply .ralph/remote/<run-id>/export/change.patch
```

For another remote run of an unfinished task on the same unchanged branch, use `ralphworks remote ralphworks.yaml --repo owner/repo --ref branch --resume-from <run-id>`. The workflow checks the previous run's branch, commit, and task path, then imports its patch and progress. The next artifact contains a cumulative patch against the branch commit. If the branch changed, review and apply the patch manually before a fresh run. Resume requires an artifact from this version or later. `commit: verified` requires a clean worktree, so review and commit a previous patch before a fresh run instead.

`remote` accepts `--repo`, `--ref`, and `--resume-from`; model selection and checks must come from Actions configuration and the pushed YAML job. The CLI preserves task terminal states such as `blocked` and `max_iterations`. If the task completes but a later workflow step fails, it reports `failed`.
When a remote run returns `needs_input`, read its `reason` and run URL. Update the pushed task before starting a fresh run; `--resume-from` requires the original task and unchanged branch, so it is not suitable after editing the task.

### Issue and PR workflows

`ralphworks init` also creates eight label-driven workflows for issue implementation, PRD sub-issues, dependency queues, PR review and feedback, branch updates, and architecture proposals. They are separate from the `remote` command: successful implementation runs can push a branch and open or update a PR. Maintainers review and merge those PRs.

Before an implementation workflow delivers a patch, it requires a completed run, passing checks from the final iteration, a nonempty patch, and its base commit record. Missing or failed artifacts stop delivery and leave the run available for inspection.

The queue workflow paginates through all open queued issues. If PRD splitting creates some sub-issues before delivery fails, re-run the failed job from the same Actions run to finish that proposal without duplicating matching sub-issues. See the [issue and PR workflow guide](ISSUE_WORKFLOWS.md#limits-failures-and-verification) for recovery steps.

The [issue and PR workflow guide](ISSUE_WORKFLOWS.md) covers installation, credentials, labels, each path, and retries. Existing workflow files are not overwritten by `init`.

## Operational guidance

- Give each job one clear objective and measurable acceptance criteria.
- Set practical iteration, time, and cost limits for unattended work.
- Use independent checks for critical behavior and every verified commit.
- Start verified commit runs from a clean dedicated branch or worktree.
- Push every required input before Docker clone or GitHub Actions execution.
- Treat returned patches as reviewable artifacts and rerun target project checks after applying them.
- Run only trusted jobs and check commands. Docker isolates the runtime but does not establish trust.

## Repeatable smoke checks

The repository's [Smoke workflow](../.github/workflows/smoke.yml) runs infrastructure checks for every pull request, weekly, and on manual dispatch. Those checks start the real CLI and Docker executors with a dry-run agent, so they need no model credentials and are a required PR check. Run them locally with `RALPHWORKS_SMOKE_RUNNER=dry-run scripts/smoke.sh host`, `docker`, or `docker-clone`; the clone mode uses the public RalphWorks `main` branch by default.

To exercise a real Pi model, run `RALPHWORKS_SMOKE_MODEL=provider/model-id scripts/smoke.sh host` and then `scripts/smoke.sh docker`. The script creates a temporary Git repository, requires the agent to write an exact file, checks that file independently, verifies RalphWorks created a commit, and removes the fixture afterward. For clone mode, set `RALPHWORKS_SMOKE_REF` to a pushed RalphWorks branch containing `scripts/smoke-task.md`.

For a real multi-iteration feedback loop, run `RALPHWORKS_SMOKE_MODEL=provider/model-id scripts/smoke-multi-iteration.sh`. The first independent check deliberately fails and gives the agent a new token. The script verifies that the next iteration reads the feedback, creates the correct files, passes the check, and produces a verified commit. The Smoke workflow runs this test weekly and on manual dispatch with the repository's `ZAI_CODING_CN_API_KEY` Actions secret. It does not run on pull requests, so untrusted PR code cannot access the key or incur model usage. The job has a 15-minute Actions limit; the script also limits the loop to three iterations, 10 minutes, and $1 of reported model cost.

For a configured GitHub target repository, set `RALPHWORKS_SMOKE_TARGET_REPO=owner/repo` and run `scripts/smoke-remote.sh`. The script creates a temporary branch with a checked YAML task, dispatches the target's RalphWorks workflow, validates the downloaded result and patch, and deletes its branch. The target repository must already have the generated workflow, model variable, provider secret, and a RalphWorks source ref pointing to the version under test. This cross-repository check remains manual because it requires a configured external target and write access to temporary branches.


## Structured code review validation

`builtin:code-review` now writes `CODE_REVIEW.json` in addition to its final assistant findings. Its write tool is authorized only for that report; the method prohibits source edits, bash, network, and running checks. It reuses the existing pinned Sentry review skill. This adds a required artifact to the previous final-response-only contract.

The core output requirement checks that this file is nonempty and parses as JSON. For authoritative structural and semantic validation, explicitly configure a check:

```bash
ralph run 'Review the supplied diff and context' --profile builtin:code-review \
  --check 'ralph review validate CODE_REVIEW.json'

ralph review validate CODE_REVIEW.json \
  --base-sha 0123456789012345678901234567890123456789 \
  --head-sha abcdefabcdefabcdefabcdefabcdefabcdefabcd \
  --diff-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The validator reads one local regular file and performs no provider calls or agent execution. Valid reports exit 0 and emit one JSON line, for example `{"schemaVersion":1,"valid":true,"verdict":"clean","findingCount":0}`. Invalid JSON, shapes, limits, revisions, or arguments exit 1, emit a diagnostic on stderr, and leave stdout empty. A valid `findings` or `incomplete` report also exits 0: validation establishes the report contract, and callers decide whether its verdict allows delivery. Symlink input files are rejected.

The [v1 schema](schemas/code-review-result-v1.schema.json) defines the strict shape: `schemaVersion: 1`; `revision` with `baseSha`, `headSha`, and `diffSha256`; `verdict`; nonempty `reviewedScope`; `findings`; and `limitations`. A finding contains `severity` (`P0` through `P3`), normalized relative `path`, positive integer `line`, nonempty `title`, `trigger`, `consequence`, `remedy`, and nonempty `evidence` strings. Unknown fields are rejected. Reports are bounded to 1 MiB of UTF-8 JSON, 500 findings, 100 limitations, 100 evidence entries per finding, 16384 Unicode characters per text, 512 per title, and 4096 per path.

A completed review with any supported finding, including P3, uses `findings`; a completed review with none uses `clean`. Missing required scope or context uses `incomplete`, which may include findings. Record unavailable checks in limitations; source inspection cannot establish passed test results. The validator checks structure and verdict consistency; it cannot establish review truth or detect every missing piece of context.

The agent must copy caller-supplied revision facts exactly and use null for absent facts. SHAs accept 40 or 64 hexadecimal characters; the diff digest accepts 64. Each optional expectation flag requires the corresponding non-null report value to match exactly, including case. Callers must supply their expected facts independently and validate freshness; the command does not inspect Git or calculate a diff digest. Put the known facts in both the review task and the explicit validation check. Profile defaults retain `checks: []`; add the public validation command wherever the caller requires this contract, without importing internal modules.

Security maintenance also supports `--param allowStaticAnalysisFixes=false` to investigate and defer source-code static-analysis findings without repairing them. Its default is true. Dependency and configuration permissions remain independent.

When `allowDependencyUpdates=true` and the task permits dependency maintenance, security maintenance may apply the smallest compatible patched update or narrowly scoped supported override to a confirmed affected installed dependency. Evidence must include the advisory/range, installed version and dependency paths, runtime/development use, patched version, and source-based exposure assessment. Application exploitability may remain unconfirmed or unreachable within the inspected scope; do not fabricate an exploit or equate installed presence with proven exposure. This includes remediation needed for an unchanged required audit. Dependency manifest, override, and lockfile edits for that repair follow `allowDependencyUpdates`. Caller risk thresholds, explicit proven-exploit-only restrictions, and disabled categories remain authoritative. Source-code findings and configuration-hardening findings still require concrete reachability evidence. Broad latest-version updates, unrelated major upgrades, scanner suppression and weakened thresholds are prohibited.

`maxFixes` counts independently justified remediations, not advisory instances or changed files. One coherent package/security repair can resolve several related advisories and dependency paths; unrelated repairs count separately and cannot be bundled to evade the limit. The default remains 3 and the accepted integer range is 1–10. Set an explicit value, such as `--param maxFixes=5`, when the task authorizes a larger bounded repair set.

When no confirmed actionable finding is eligible for repair, security maintenance completes with an evidence-backed `SECURITY_REPORT.md` only. An authorized compatible update to an affected installed dependency is eligible even without proven application exploitability. Add regression tests when necessary to verify protection or compatibility at a changed boundary; dependency resolution, relevant audit results and existing integration checks can verify compatible advisory updates without a new exploit test for every upgrade.

When a dependency update changes a parser or validator generation, compatibility API, or public behavior, compare affected published schemas and accepted inputs before and after through the real application interface, even if application source is unchanged. Preserve supported values and shapes; do not add input limits or change contracts merely to clear an audit. Unrelated passing checks or partial schema matches do not establish compatibility. For concrete reachable behavior already in scope, inspect the installed fix's required conditions and whether the application activates them. Use safe, bounded behavior and legitimate-workflow checks where existing evidence is insufficient. Report advisory resolution, observed application protection and residual limitations separately; a clean audit does not establish required application protection. This does not authorize unrelated hardening or bypass caller scope, category permissions or the independent-remediation limit.

Git staging and index changes remain with RalphWorks. Missing acceptance evidence still blocks completion. Request needs-input for a genuine unresolved decision, an unsupported or breaking repair outside scope, material compatibility uncertainty, or an exhausted explicit repair limit; uncertainty about exploitability alone does not revoke existing dependency-update permission.

Before each agent iteration, declared output destinations must remain inside the workspace with no existing symlink destination or symlink ancestor. Unsafe destinations produce a persisted `blocked` result before the agent runs; existing regular reports and missing report directories remain allowed. This preflight is an output-path guard, not an operating-system sandbox against concurrent filesystem changes.
