# RalphWorks

[![CI](https://github.com/OctopusGarage/ralphworks/actions/workflows/ci.yml/badge.svg)](https://github.com/OctopusGarage/ralphworks/actions/workflows/ci.yml)
[![Gitleaks](https://github.com/OctopusGarage/ralphworks/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/OctopusGarage/ralphworks/actions/workflows/gitleaks.yml)
[![Release](https://github.com/OctopusGarage/ralphworks/actions/workflows/release.yml/badge.svg)](https://github.com/OctopusGarage/ralphworks/releases/latest)
[![Smoke](https://github.com/OctopusGarage/ralphworks/actions/workflows/smoke.yml/badge.svg)](https://github.com/OctopusGarage/ralphworks/actions/workflows/smoke.yml)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
[![MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

Reusable task methods built on a bounded [Ralph loop](https://www.aihero.dev/getting-started-with-ralph) for coding tasks. Give it a goal; it runs [Pi](https://pi.dev) in fresh iterations, carries progress forward, checks the result, and stops when the task is done or a limit is reached.

## Get started

Requires Node.js 24. Install [Pi](https://pi.dev) and the [v0.2.0 release](https://github.com/OctopusGarage/ralphworks/releases/tag/v0.2.0), then configure a model in Pi with `/login` and `/model`. RalphWorks uses Pi's existing model and credentials; select another configured model with `--model provider/model-id`.

```bash
npm install -g @earendil-works/pi-coding-agent \
  https://github.com/OctopusGarage/ralphworks/releases/download/v0.2.0/ralphworks-0.2.0.tgz
pi # configure /login and /model, then exit

cd /path/to/your/repo
ralphworks run 'Fix the login error and add a regression test' --check 'npm test'
```

Run the command from the repository you want to change. Edits stay in that worktree. `--check` runs after every iteration; a failing check sends its output into the next iteration. Omit it for exploratory work, but use checks that cover the acceptance criteria for unattended tasks.
Without checks or profile output requirements, `completed` means the agent reported completion; it does not independently verify the result.

## Save and reuse your way of working

A **task profile** defines a reusable agent environment: prompts, skills, tools, extensions, MCP requirements, parameters, limits, checks, and validated outputs. Keep a personal collection or share profiles with a project. Choose the model provider, executor, and workspace separately, so the same method works with Pi providers, compatible API gateways, host commands, and Docker.

Use a built-in task environment directly:

```bash
cd /path/to/your/repo
ralphworks profiles list
ralphworks plan 'Fix the login error' --profile builtin:bugfix --workspace worktree --check 'npm test'
ralphworks run 'Fix the login error' --profile builtin:bugfix --workspace worktree --check 'npm test'
```

There are nine [built-in task profiles](docs/TASK_PROFILES.md): bugfix, domain modeling, code review, architecture improvement, test coverage and quality, security maintenance, performance, UI implementation, and UX review. Bugfix supports reported defects and bounded proactive discovery. Bugfix, UI implementation and UX review include Playwright CLI for browser inspection and verification; prepare the executable and browsers in the chosen executor. Architecture selects Matt Pocock's improve-codebase-architecture and codebase-design skills; coverage adds the complete Brooks test-quality method. Selected skills are archived upstream snapshots with licenses and exact provenance. Generic coding and documentation methods remain optional examples; ordinary tasks can run directly without a profile. [Explicit capability combinations](docs/CAPABILITY_PROFILES.md) add browser verification, Context7, CodeGraph, or standalone DeepWiki research without global settings. Collect a profile with `ralphworks profiles add builtin:bugfix my-bugfix`, then customize its personal files. Project and personal names can override built-ins; `builtin:NAME` selects the shipped version. Agent resource discovery defaults to off, including runs without a profile. Profiles can opt into project resources or both project and global resources. MCP connections belong in runtimes; profiles declare capabilities. Model providers and execution choices remain independent.

`plan` prints resolved JSON without running the agent or creating a worktree. `--workspace worktree` requires a clean Git repository and creates a retained task branch and worktree from HEAD. Review the reported path and branch afterward. Task profiles contain the working method; [runtime presets](docs/USAGE.md#runtime-presets-and-defaults) contain optional model and execution choices. A [local proxy example](examples/pi/local-proxy/models.json) uses Pi's native model configuration and is optional.

The [Skill Hub](docs/USAGE.md#persistent-skill-hub) saves complete, immutable skill snapshots with content hashes and source provenance. Profiles explicitly select built-in, project, or personal skills and lock exact versions. Vendor snapshots into the project to keep tasks runnable after upstream deletion, across machines, and offline. Local paths and inline [GitHub skills](docs/USAGE.md#skills-from-github) remain supported.

See [task profiles](docs/USAGE.md#reusable-task-profiles) for authoring, inheritance, collection, and precedence.

## The loop

![Task, Pi agent, checks, and progress in the RalphWorks loop](docs/assets/ralphworks-overview.svg)

1. Pi reads the task and saved progress, then works on one useful increment.
2. RalphWorks runs configured checks, validates required outputs, and records the outcome.
3. A new Pi session receives that progress and continues. The loop stops on completion, a request for human input, a blocker, or an iteration, time, or cost limit.

The default limit is **five iterations**. Progress and results live in `.ralph/`; inspect the latest run with `ralphworks status .ralph/current`. Completion requires the agent's completion signal and passing configured checks and output requirements. RalphWorks can commit passing iterations with `--commit verified`; otherwise it leaves changes for you to review.

## Give it a task

Use direct text, any plain text or Markdown file, or a small YAML job. Plain task files have no required name or format. Add supporting files or directories with repeatable `--context`.
For longer work, write small checklist items with observable acceptance criteria; RalphWorks carries progress across fresh sessions without requiring a special PRD format. See the [multi-item task example](docs/USAGE.md#multi-item-tasks).

```bash
ralphworks run ./docs/feature.md --context ./docs/api --max-iterations 8
ralphworks run 'Add CSV export' --check 'npm test' --commit verified
```

`--commit verified` requires a clean Git worktree and at least one check. The agent does not create commits itself. For reusable checks and limits, see the [YAML job format](docs/USAGE.md#structured-yaml-jobs).

For unattended work, start on a dedicated branch and give the loop an independent acceptance check:

```bash
ralphworks run ./docs/feature.md --check 'npm test' --commit verified --max-minutes 30 --max-cost-usd 3
```

## Choose where it runs

| Mode | Command | Result |
| --- | --- | --- |
| Host | `ralphworks run task.md` | Edits the current worktree. |
| Task worktree | `ralphworks run task.md --workspace worktree` | Edits a new retained branch and worktree. |
| Docker mount | `ralphworks run task.md --executor docker` | Edits the mounted worktree. |
| Docker clone | `ralphworks run task.md --executor docker-clone --repo owner/repo --ref branch` | Exports a patch from a clean clone. |
| GitHub Actions | `ralphworks remote task.md --repo owner/repo --ref branch` | Downloads a patch and run records. |

Docker requires the [sandbox image](docs/USAGE.md#docker-execution). Clone and `remote` runs require the task and inputs on the selected branch; they return patches without pushing code. For GitHub Actions, run `ralphworks init` in the target repository, commit the generated workflow, then configure `RALPHWORKS_MODEL` and a provider secret as described in the [remote setup guide](docs/USAGE.md#github-actions-execution). Continue an unfinished remote run with `--resume-from <run-id>` on the same unchanged branch.
Docker and remote commands have a 120-minute total deadline, including setup; change it with `--total-minutes N`. For interrupted local runs, follow the [recovery steps](docs/USAGE.md#recovering-an-interrupted-local-run) before restarting verified commits.

For issue and PR driven work, `ralphworks init` creates [scenario workflows](docs/ISSUE_WORKFLOWS.md) for issue implementation, PRD splitting and serial implementation, dependency promotion, PR review and feedback, branch updates, and architecture proposals. Maintainer labels authorize model runs. Configure a repository check command and a separate token for GitHub delivery.

[Full usage and configuration](docs/USAGE.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)
