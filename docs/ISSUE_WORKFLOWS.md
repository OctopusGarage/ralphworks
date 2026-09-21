# Issue and PR workflow setup

This guide installs RalphWorks' label-driven GitHub Actions workflows in another repository. The workflows turn an issue into a checked draft PR, split and implement a PRD, promote issues when dependencies close, review a PR, apply feedback, update a PR branch, and propose architecture work. A maintainer still reviews and merges implementation PRs.

## 1. Prepare the target repository

The target must have GitHub Issues, Pull Requests, and Actions enabled. The workflows run on GitHub-hosted Ubuntu runners with Node.js 24 and pnpm 10.13.1. Project dependencies are installed with pnpm, npm, or Yarn when the corresponding lockfile exists. Make sure the repository's own test and build commands run on Ubuntu.

Install RalphWorks v0.2.0 or later, then initialize the target repository:

```bash
npm install -g https://github.com/OctopusGarage/ralphworks/releases/download/v0.2.0/ralphworks-0.2.0.tgz
cd /path/to/target-repository
ralphworks init
```

`init` creates eight `ralphworks-*.yml` scenario files, the separate `ralphworks.yml` manual remote workflow, and a `.ralph/` ignore rule. It does not replace existing files: a `skipped=` line means the existing workflow needs a manual comparison and update. Commit the generated files to the **default branch** before adding trigger labels. Label events use the workflow definitions on that branch.

For an existing RalphWorks installation, run `init` in an empty temporary directory, compare its `.github/workflows/ralphworks-*.yml` files with the target's files, and copy reviewed changes. Keep `.ralph/` out of Git.

## 2. Configure Actions variables and secrets

Set these in the target repository under **Settings → Secrets and variables → Actions**. Variables are nonsecret configuration; secrets contain credentials.

| Name | Kind | Required | Value |
| --- | --- | --- | --- |
| `RALPHWORKS_MODEL` | Variable | Yes | Pi model reference, such as `zai-coding-cn/glm-5.3`. |
| `RALPHWORKS_ISSUE_CHECK` | Variable | Yes for implementation and branch updates | One shell command that independently validates the target project, such as `npm test -- --run && npm run build`. |
| `RALPHWORKS_ISSUE_TOKEN` | Secret | Yes | Token for the target repository with Contents, Issues, and Pull requests write access. Its owner must be able to push branches and open PRs. |
| Provider API key | Secret | Yes | The selected model provider's credential, for example `ZAI_CODING_CN_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `NVIDIA_API_KEY`. |
| `RALPHWORKS_AUTH_SECRET` | Variable | For other provider key names | Name of the provider credential secret to export into the model process. |
| `RALPHWORKS_SOURCE_REPO` | Variable | No | RalphWorks source repository; defaults to `OctopusGarage/ralphworks`. |
| `RALPHWORKS_REF` | Variable | Recommended | Branch, tag, or full commit SHA in the source repository. The generated workflows default to `v0.2.0`. Pin a reviewed commit for repeatable runs. |
| `RALPHWORKS_REPO_TOKEN` | Secret | Only for a private source repository | Read access to `RALPHWORKS_SOURCE_REPO`. |

For example, with GitHub CLI authenticated to the target repository:

```bash
REPO=owner/target
gh variable set RALPHWORKS_MODEL --repo "$REPO" --body 'zai-coding-cn/glm-5.3'
gh variable set RALPHWORKS_ISSUE_CHECK --repo "$REPO" --body 'npm test -- --run && npm run build'
gh variable set RALPHWORKS_REF --repo "$REPO" --body '<reviewed-source-commit-sha>'
gh secret set ZAI_CODING_CN_API_KEY --repo "$REPO"
gh secret set RALPHWORKS_ISSUE_TOKEN --repo "$REPO"
```

The last two commands prompt for secret values. Use a fine-grained token scoped to the target repository when possible. The delivery steps use this token so their pushes and labels can start follow-up Actions runs. [GitHub does not start most follow-up workflows from events created with the default `GITHUB_TOKEN`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#triggering-a-workflow-from-a-workflow). The agent execution job uses read-only repository permissions; write operations happen in delivery or status steps.

## 3. Create labels

Create all labels before the first run. Names must match exactly:

```bash
REPO=owner/target
for label in \
  ralphworks:run \
  ralphworks:to-issues \
  ralphworks:implement-prd \
  ralphworks:queued \
  ralphworks:review \
  ralphworks:implement \
  ralphworks:update-branch \
  ralphworks:architecture \
  ralphworks:in-progress \
  ralphworks:blocked; do
  gh label create "$label" --repo "$REPO" --color 0E8A16 --description 'RalphWorks workflow label'
done
```

If some labels already exist, create only the missing ones. A maintainer with repository write access should apply trigger labels. `ralphworks:in-progress` and `ralphworks:blocked` are status labels managed by workflows.

## 4. Run each path

### Ordinary issue

Create an issue with a narrow goal and observable acceptance criteria. Add `ralphworks:run` to the open issue. The workflow reads its title and body, checks the labeling actor, installs dependencies, runs RalphWorks with `RALPHWORKS_ISSUE_CHECK`, and uploads run records and a patch. A completed, checked run with a nonempty patch creates `ralphworks/issue-N`, opens a draft PR with `Closes #N`, comments on the issue, and labels the PR `ralphworks:review`.

Review the diff, the Actions run and artifacts, and the target repository's PR checks before merging. Merging the PR closes the issue. An existing issue branch or open PR prevents a duplicate implementation run.

### PRD with native sub-issues

Create one parent issue describing the desired feature and acceptance criteria. Add `ralphworks:to-issues`. RalphWorks proposes two to eight ordered native sub-issues and attaches them to the parent. Review their scope and edit them before implementation.

Add `ralphworks:implement-prd` to the parent. The workflow selects its first open sub-issue, implements it on `ralphworks/prd-N`, opens or updates one draft PR, and closes the completed child with a commit reference. It then labels the parent again to start the next open child. When no open children remain, it labels the PR `ralphworks:review`. Child issues close after their implementation commit; the parent remains open until its PR is merged.

### Dependency queue

Use GitHub's native issue dependency relationship to mark an issue as blocked by another issue, then add `ralphworks:queued` to the blocked issue. On an issue close event, `ralphworks-queue.yml` checks all queued issues across API pages. When none of their dependencies remain open, it removes `ralphworks:queued` and adds `ralphworks:run` for an ordinary issue or `ralphworks:implement-prd` for a parent with sub-issues. The queue workflow can also be run manually from Actions. A closed dependency may remain visible in GitHub's dependency list; only open dependencies block promotion.

### PR review and feedback

`ralphworks:review` on an open, same-repository PR starts a model review against the base branch. The workflow posts a PR review comment, marks a draft PR ready, and removes the label. It does **not** approve or merge the PR.

To request a revision, put actionable instructions in a **general PR comment or review body**, then add `ralphworks:implement` to the PR. The current feedback workflow reads those two sources; it does not collect inline review-thread comments. It runs the target check, applies the resulting patch to the existing PR branch, and comments with the run link. Add the label again after a later round of feedback if needed.

### Update a PR branch

Add `ralphworks:update-branch` to an open, same-repository PR. The workflow merges the current base into its branch and runs `RALPHWORKS_ISSUE_CHECK`. If the merge conflicts, RalphWorks resolves the conflict and reruns the check. Delivery verifies that neither branch changed during execution and pushes a two-parent merge commit. Check the new diff and PR checks before merging.

### Architecture proposals

`ralphworks-architecture.yml` runs weekly on Monday at 02:00 UTC and supports manual dispatch:

```bash
gh workflow run ralphworks-architecture.yml --repo owner/target --ref main
```

It reviews the repository and creates an issue labeled `ralphworks:architecture` with one bounded proposal and acceptance criteria. It skips new proposals while three such issues are open. Review these proposals as ordinary issues; the workflow does not implement them automatically.

## Limits, failures, and verification

Implementation and conflict-resolution model runs allow at most five iterations, 30 minutes, and $3 of reported model cost. PRD splitting and architecture review allow three iterations, 20 minutes, and $1. PR review allows two iterations, 20 minutes, and $1. A branch update without conflicts runs checks without invoking the model. These are workflow limits, not a substitute for provider-side billing controls.

On failure, inspect the linked Actions run and its artifacts. Delivery failures may leave a branch or PR already created. Resolve that partial state before retrying. For a PRD split whose model job succeeded but delivery created only some sub-issues, use **Re-run failed jobs** on the original Actions run (or `gh run rerun RUN_ID --failed`). The delivery job reuses that run's proposal, skips matching sub-issues, and creates the rest. It stops if an existing sub-issue differs from the proposal; inspect the partial state before changing it. A new label event starts a new proposal and will reject existing sub-issues. Workflows remove their trigger label and usually add `ralphworks:blocked`; successful PRD delivery clears that status label. For other failures, remove the status label and re-add the relevant trigger label only after the cause is fixed. `init` also generates `ralphworks.yml` for the separate manual `ralphworks remote` patch workflow; it does not enter these issue and PR paths.

A small end-to-end check for a new installation is: create a documentation issue, add `ralphworks:run`, confirm that a checked draft PR and review appear, then inspect and merge the PR. For PRD and queue validation, use a small parent with two child tasks and a queued issue with a native dependency. Keep normal branch protection and required PR checks enabled.
