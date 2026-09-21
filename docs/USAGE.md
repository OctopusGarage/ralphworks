# RalphWorks Usage and Execution Guide

This guide describes the current behavior of RalphWorks. RalphWorks is a bounded loop orchestrator built on Pi Coding Agent: it loads a task, lets an agent modify a repository over multiple iterations, runs optional independent checks, and persists progress and results. It does not create branches, push, open pull requests, merge, or deploy.

## Installation and command entry point

RalphWorks requires Node.js 24. Install the release package and configure Pi:

```bash
npm install -g @earendil-works/pi-coding-agent \
  https://github.com/OctopusGarage/ralphworks/releases/download/v0.1.0/ralphworks-0.1.0.tgz
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

```bash
cd /path/to/project
ralphworks run 'Fix the lost state after refreshing the results page'
ralphworks status .ralph/current
ralphworks trace .ralph/runs/<run-directory>/events.jsonl
```

## Model and credential configuration

RalphWorks delegates models, authentication, and custom providers to Pi. Configure credentials with Pi's `/login` command and select a model with `/model`. Pi uses `~/.pi/agent` by default; use `--pi-agent-dir` to select another directory.

Model resolution follows this order:

1. CLI: `--model`, `--provider`, `--pi-agent-dir`, and `--pass-env`.
2. Environment: `RALPHWORKS_MODEL`, `RALPHWORKS_PROVIDER`, `PI_CODING_AGENT_DIR`, and `RALPHWORKS_PASS_ENV`.
3. Pi's current configuration and available models.

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

The agent can modify any file in the current worktree. RalphWorks injects its own completion and Git rules, so task text does not need to mention commits or completion tags.

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

The checklist is ordinary task text, not a format RalphWorks parses or edits. Keep the task file stable during a run. RalphWorks supplies the same task and its saved progress to each new agent session; the handoff should identify the completed item, check evidence, and the next item. Use independent `--check` commands or a YAML job for the acceptance criteria. Make each item small enough to complete and check in one iteration.

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

CLI options override the matching job values: `--max-iterations`, `--max-minutes`, `--max-cost-usd`, `--check-timeout`, `--commit`, `--completion-promise`, repeatable `--check`, and repeatable `--context`. CLI options suit one-off work; YAML suits reviewed and reusable jobs.

Docker and remote commands also accept `--total-minutes N` (default: 120, maximum: 1440). This bounds the whole Docker command, including clone and dependency installation, or the remote dispatch, wait, and artifact download. It is separate from `--max-minutes`, which bounds the agent loop. A timed-out Docker command attempts to force-remove its container; a timed-out remote wait requests cancellation of the Actions run. Check the run URL if cancellation fails or is still in progress. Host runs use `--max-minutes` and reject `--total-minutes`.

## Iteration and terminal states

Each iteration creates a new Pi session and supplies the task plus a bounded view of durable progress from earlier iterations. The full progress history stays on disk. For tasks with several items, the agent chooses the highest-priority unfinished item. After the agent returns, RalphWorks records model events and cost, runs every configured check, updates progress, and decides whether to continue. Failed check output is included in the next iteration's progress, capped at 2,000 characters per failed check.

A completion tag requests completion. A configured check failure prevents completion even when the tag is present. Without independent checks, the tag is sufficient; it is an agent report, not independent proof that the task is correct. Use checks covering the essential acceptance criteria for unattended work. Two consecutive Git iterations without worktree progress stop as `blocked`.

Terminal states are:

- `completed`: the completion condition and all configured checks passed.
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

`commit: verified` requires:

- A Git repository and clean starting worktree, excluding `.ralph/`.
- At least one configured check.
- A configured Git author.

After every iteration whose checks pass, RalphWorks commits that iteration's changes, even if the overall task needs another iteration. The agent is instructed not to commit. If Git HEAD changes during the agent step, the run stops as `blocked` so the agent cannot bypass verification. RalphWorks does not undo an agent-created commit; inspect it manually.

Use verified commits on a dedicated branch or worktree. A passing command proves only what that command checks and does not replace semantic review.

## Run state

Host and Docker mount runs store state under `.ralph/`:

```text
.ralph/
├── current
├── progress/<job-name>-<task-hash>.md
├── run.lock/
└── runs/<job-name>-<timestamp>/
    ├── events.jsonl
    └── result.json
```

`current` points to the latest run. Default progress paths include a hash of the complete task and supplied context: rerunning the same task reuses progress, while changed tasks start fresh. An explicit `progress_file` keeps its chosen path. The lock prevents concurrent runs in one worktree. `ralphworks init` adds `.ralph/` to `.gitignore`.

## Recovering an interrupted local run

Inspect the last result and the worktree before restarting:

```bash
ralphworks status .ralph/current
git status --short
git diff --check
git diff
```

RalphWorks leaves edits in place after a failure or interruption. If `commit: verified` is enabled, a dirty worktree blocks a new run so unchecked edits cannot be committed automatically. On the same dedicated branch, review the changed files, run the relevant project checks, then commit only the files you have verified. You can instead discard the edits after reviewing them. Rerun the same task and options once the worktree is clean; its default progress file is reused when the task and context are unchanged. Do not delete a lock held by a live run; a stale lock is reclaimed automatically when its owner is gone.

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
- Optional variable `RALPHWORKS_REF`, set to a branch, tag, or commit SHA in the RalphWorks repository. The generated workflow defaults to the `v0.1.0` release tag. Set this variable for a fork or another version; the resolved commit is saved in the result artifact.

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

### Issue to draft PR workflow

See the [step-by-step setup guide](ISSUE_WORKFLOWS.md) for installation, credentials, labels, and examples for every issue and PR path.

`ralphworks init` also creates eight scenario workflows in `.github/workflows/`. Commit them to the default branch to enable issue and PR driven work. Existing workflows are never overwritten. This does not change the `remote` command or its read-only artifact delivery.

Configure `RALPHWORKS_MODEL` and the provider credential as above. Set repository variable `RALPHWORKS_ISSUE_CHECK` to one acceptance command, such as `npm test`. Implementation workflows require this independent check and limit each run to five iterations, 30 minutes, and $3 of reported model cost. Set secret `RALPHWORKS_ISSUE_TOKEN` to a fine-grained token with repository Contents, Issues, and Pull requests write access. Write actions use that token only in delivery jobs or narrow status steps so pushed branches, new labels, and draft PRs trigger normal follow-up workflows. The account behind the token must be allowed to push branches and open PRs. Create the labels in the table below in the target repository.

A maintainer with write access adds `ralphworks:run` to an open issue. The workflow verifies the labeling actor, reads the issue title and body as the task, runs RalphWorks on the default branch, and uploads a patch and run records. Only a completed result with passing checks and a nonempty patch proceeds. A separate delivery job verifies the original base commit, applies the patch, pushes `ralphworks/issue-<number>`, and opens a draft PR containing `Closes #<number>` and a link to the run. It labels the PR `ralphworks:review` to request review. The issue stays open until the PR is merged. On failure, the workflow removes the trigger label and comments with the run link; inspect the run and any existing branch before re-adding the label. An existing issue branch or open PR blocks a duplicate run.

| Label | Where to add it | Effect |
| --- | --- | --- |
| `ralphworks:run` | Ordinary issue | Implement one issue and open a checked draft PR. |
| `ralphworks:to-issues` | PRD issue | Propose two to eight ordered native sub-issues. Review the split before implementation. |
| `ralphworks:implement-prd` | PRD with sub-issues | Implement the next open sub-issue on one draft PR branch; continue until all are closed, then request review. |
| `ralphworks:queued` | Blocked issue | Wait until native issue dependencies are closed; the queue workflow then starts the ordinary or PRD path. |
| `ralphworks:review` | Same-repository PR | Post a model-generated review and mark the draft PR ready. |
| `ralphworks:implement` | Same-repository PR with comments | Address review feedback on the PR branch and run the configured checks. |
| `ralphworks:update-branch` | Same-repository PR | Merge the current base into the PR branch, resolve conflicts if needed, and run checks. |
| `ralphworks:architecture` | Generated issue | Tracks an architecture proposal; the weekly or manual workflow creates at most three open proposals. |
| `ralphworks:in-progress`, `ralphworks:blocked` | PRD or failed job | Status labels managed by the workflows. |

`ralphworks-queue.yml` also supports manual dispatch, and `ralphworks-architecture.yml` supports manual dispatch and a weekly schedule. To retry a failed path, inspect its run and artifacts, resolve partial GitHub changes, remove `ralphworks:blocked`, then add the relevant trigger label again. Implementation PRs still require human review and merge. Fork PRs are not supported by the PR workflows. The configured acceptance command runs against the checked-out project; review and architecture proposals have a separate nonempty-report check.

Issue text is agent input. Grant the trigger label only to trusted maintainers, and review generated code and run artifacts before merging. The workflow keeps repository write credentials out of the agent execution job, but the model credential and checkout are available while it runs the task. Use repository branch rules and required PR checks for the resulting PR.

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
