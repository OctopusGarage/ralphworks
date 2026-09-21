# RalphWorks

RalphWorks is a bounded Ralph loop orchestrator powered by [Pi Coding Agent](https://github.com/badlogic/pi-mono). It keeps an agent working on a repository, verifies each iteration, and records the run until the task completes, becomes blocked, or reaches a configured limit.

## Quick start

### 1. Install

RalphWorks requires Node.js 24 and pnpm 10.

```bash
git clone https://github.com/OctopusGarage/ralphworks.git
cd ralphworks
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

### 2. Configure a model

RalphWorks uses Pi's model, authentication, and custom provider configuration. Run `/login` in Pi to configure credentials and `/model` to select a model. Pi stores its configuration in `~/.pi/agent` by default.

If `--model` is omitted, RalphWorks uses Pi's current selection. Any configured model can be selected for one run:

```bash
ralphworks run 'Fix the login page error' --model provider/model-id
```

### 3. Run a task

Run RalphWorks from the root of the repository that it should modify:

```bash
cd /path/to/project
ralphworks run 'Fix the lost state after refreshing the results page and verify the relevant tests'
```

A task runs for at most five iterations by default. Docker and GitHub Actions runs also default to a 30-minute work budget and a $3 reported model-cost budget. Each Pi iteration runs in a child process that RalphWorks can stop at the deadline. Changes remain in the current working tree and run records are written under `.ralph/`.

```bash
ralphworks status .ralph/current
ralphworks trace .ralph/runs/<run-directory>/events.jsonl
```

## Tasks and context

The first argument to `run` can be direct task text or a text file at any location. Plain text files have no required name or format. Only `.yaml` and `.yml` files are parsed as structured job configuration.

```bash
ralphworks run 'Implement data export and add tests'
ralphworks run ./docs/issue-123.md
ralphworks run /any/path/requirements.txt
```

Repeat `--context` to attach files or directories:

```bash
ralphworks run 'Implement the export feature from the supplied specification' \
  --context /any/path/spec.md \
  --context ./docs/api
```

Directories are read recursively. RalphWorks skips `.git`, `.ralph`, `node_modules`, and binary files. Context is limited to 100 files and 1 MiB of text.

A useful task states the goal, allowed scope, constraints, and verifiable acceptance criteria. The task does not need to ask the agent to commit or include `<promise>DONE</promise>`; RalphWorks injects the completion protocol.

## Checks and verified commits

The agent runs checks appropriate to the task. Add one or more `--check` options when the orchestrator must independently validate every iteration:

For unattended or important changes, provide checks that actually test the acceptance criteria. Without checks, RalphWorks relies on the agent's completion claim.

```bash
ralphworks run 'Fix the login endpoint' \
  --check 'npm test' \
  --check 'npm run build'
```

Checks are optional for ordinary tasks. To let RalphWorks commit an iteration after its checks pass, use `--commit verified`. This mode requires a clean starting worktree and at least one check.

```bash
git switch -c ralph/fix-login
ralphworks run 'Fix the login endpoint' \
  --check 'npm test' \
  --check 'npm run build' \
  --commit verified
```

The agent must not commit. RalphWorks detects changes to Git HEAD and creates verified commits with its bot identity after checks pass.

## Common controls

```bash
ralphworks run 'Implement search' \
  --context ./docs/search-spec.md \
  --max-iterations 8 \
  --max-minutes 30 \
  --max-cost-usd 3 \
  --check-timeout 120 \
  --check 'npm test'
```

Use YAML for a reusable job:

```yaml
name: implement-search
task: |
  Implement search using the existing project structure and add relevant tests.
max_iterations: 8
max_minutes: 30
max_cost_usd: 3
check_timeout_seconds: 120
commit: verified
checks:
  - npm test
  - npm run build
```

```bash
ralphworks run ralphworks.yaml
```

Plain tasks and YAML jobs both default to five iterations, the completion value `DONE`, and no commits. CLI options override the corresponding YAML limits, checks, commit policy, and completion value.

## Execution modes

### Host

The default mode runs Pi and checks directly in the current directory.

```bash
ralphworks run 'Complete the current task'
```

### Docker mount

Build the sandbox image once:

```bash
cd /path/to/ralphworks
docker build -f docker/ralphworks-sandbox.Dockerfile \
  -t ralphworks-sandbox:latest .
```

Mount the current project into the container. Container changes are written back to the current worktree.

```bash
cd /path/to/project
ralphworks run 'Complete the current task' \
  --executor docker \
  --pi-agent-dir ~/.pi/agent
```

### Docker clone

Clone a GitHub branch into a clean container, run the job, then export a patch and run records.

```bash
ralphworks run ralphworks.yaml \
  --executor docker-clone \
  --repo owner/repo \
  --ref ralph/task-branch \
  --pi-agent-dir ~/.pi/agent
```

The task file and context must exist on the selected branch. Private repositories require a `GH_TOKEN` with read access. Results are written under `.ralph/exports/` and are not applied to the local repository automatically.

### GitHub Actions

Initialize the target repository and commit the generated workflow:

```bash
ralphworks init
git add .github/workflows/ralphworks.yml .gitignore
git commit -m 'ci: add RalphWorks workflow'
git push
```

Configure these values in the target GitHub repository:

- Variable `RALPHWORKS_MODEL`: a Pi `provider/model-id`.
- Variable `RALPHWORKS_AUTH_SECRET`: the name of the GitHub secret containing the Pi provider's API key (for example, `GEMINI_API_KEY`). Existing Anthropic, OpenAI, NVIDIA, and Z.AI secret names also work without this variable.
- Optional variable `RALPHWORKS_REF`: RalphWorks Git branch, tag, or commit SHA to run. The generated workflow defaults to the `v0.1.3` release tag. Set this variable when using a fork or another version. The resolved SHA is included in the artifact.
- Optional variable `RALPHWORKS_SOURCE_REPO`: `owner/repo` for the RalphWorks source. It defaults to `OctopusGarage/ralphworks`; set it to your fork when needed.
- Secret `RALPHWORKS_REPO_TOKEN`: required only when the selected RalphWorks source repository is private. It needs read access.

Push the task file and source branch before dispatching the job:

```bash
ralphworks remote ralphworks.yaml \
  --repo owner/repo \
  --ref ralph/task-branch
```

Results are downloaded to `.ralph/remote/<run-id>/`. The workflow exports a patch and never pushes code, opens a pull request, or merges changes.

```bash
git apply --check .ralph/remote/<run-id>/export/change.patch
git apply .ralph/remote/<run-id>/export/change.patch
```

To continue an unfinished remote run on the same unchanged branch, use its GitHub Actions run ID:

```bash
ralphworks remote ralphworks.yaml --repo owner/repo --ref ralph/task-branch --resume-from <run-id>
```

RalphWorks checks that the previous run used the same branch, commit, and task path, then restores its patch and progress before the next loop. The new artifact contains the cumulative patch. If the branch has changed, review and apply the previous patch manually before starting a fresh run. Resume requires an artifact produced by this version or later. `commit: verified` cannot resume an uncommitted patch; use a fresh run after reviewing and committing that patch.

## How it works

![RalphWorks core architecture](docs/assets/ralphworks-overview.svg)

The design has four essential parts:

- **Task input:** direct text, a text file, or YAML, with optional context files.
- **Pi Agent:** performs one useful implementation step per iteration.
- **Orchestrator:** carries progress into the next iteration and enforces iteration, time, cost, Git, and completion rules.
- **Verification and results:** optional checks validate each iteration; `.ralph/` records progress, events, status, cost, and commits.

The agent's completion marker is a request to finish. If checks are configured, they must also pass. Otherwise RalphWorks continues until the task completes, becomes blocked, or reaches a limit.

| Mode | Where it works | How changes return |
| --- | --- | --- |
| `host` | Current worktree | Changes remain in the worktree. |
| `docker` | Current worktree mounted in Docker | Changes are written back to the worktree. |
| `docker-clone` | Clean repository clone in Docker | Patch and run records are exported. |
| `remote` | Temporary GitHub Actions worktree | Artifacts are downloaded under `.ralph/remote/`. |

## Run records

```text
.ralph/
├── current                         # Pointer to the latest run directory
├── progress/<job-name>-<hash>.md   # Durable progress for this task
├── runs/<job-name>-<timestamp>/
│   ├── events.jsonl                # Ordered execution events
│   └── result.json                 # Status, checks, cost, and commits
├── exports/<run-id>/               # Docker clone results
└── remote/<github-run-id>/         # GitHub Actions results
```

`ralphworks init` adds `.ralph/` to `.gitignore`. A worktree can run only one RalphWorks job at a time; the lock is also stored under `.ralph/`.

## Current boundaries

- YAML support is intentionally limited and does not include nested objects, anchors, or inline arrays.
- RalphWorks does not create branches, push code, open pull requests, merge, or deploy.
- A run cannot resume across processes.
- YAML `mode: remote` is not implemented; use `ralphworks remote` for GitHub Actions.
- Check commands come from the job author. Run only trusted jobs in trusted repositories.

See the [usage guide](docs/USAGE.md) for the complete execution contract and [architecture](docs/ARCHITECTURE.md) for module responsibilities.
