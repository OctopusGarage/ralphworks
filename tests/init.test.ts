import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initProject } from "../src/init.ts";

test("initProject creates the workflow and ignores runtime state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-init-"));

  const result = await initProject(workspace);

  assert.deepEqual(result.created, [
    ".github/workflows/ralphworks-issue.yml",
    ".github/workflows/ralphworks-prd-split.yml",
    ".github/workflows/ralphworks-prd-implement.yml",
    ".github/workflows/ralphworks-queue.yml",
    ".github/workflows/ralphworks-pr-review.yml",
    ".github/workflows/ralphworks-pr-feedback.yml",
    ".github/workflows/ralphworks-update-branch.yml",
    ".github/workflows/ralphworks-architecture.yml",
    ".github/workflows/ralphworks.yml",
    ".gitignore",
  ]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.updated, []);
  assert.equal(await readFile(join(workspace, ".gitignore"), "utf8"), ".ralph/\n");

  const action = await readFile(join(workspace, ".github", "workflows", "ralphworks.yml"), "utf8");
  assert.match(action, /task:/);
  assert.doesNotMatch(action, /job:/);
  assert.match(action, /RALPHWORKS_MODEL: \$\{\{ vars\.RALPHWORKS_MODEL \}\}/);
  assert.match(action, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(action, /ZAI_CODING_CN_API_KEY/);
  assert.match(action, /RALPHWORKS_AUTH_SECRET_VALUE: \$\{\{ secrets\[vars\.RALPHWORKS_AUTH_SECRET\] \}\}/);
  assert.match(action, /RALPHWORKS_REF: \$\{\{ vars\.RALPHWORKS_REF \|\| 'v0\.1\.1' \}\}/);
  assert.match(action, /resume_run_id:/);
  assert.match(action, /actions: read/);
  assert.match(action, /gh run download "\$RALPH_RESUME_RUN"/);
  assert.match(action, /git apply --check "\$PATCH"/);
  assert.match(action, /checkout --detach "\$RALPHWORKS_REF"/);
  assert.match(action, /ralphworks-commit\.txt/);
  assert.match(action, /\.ralph\/progress\//);
  assert.match(action, /contents: read/);
  assert.match(action, /RALPH_TASK/);
  assert.match(action, /actions\/upload-artifact@v4/);
  assert.match(action, /GH_TOKEN: \$\{\{ secrets\.RALPHWORKS_REPO_TOKEN \}\}/);
  assert.match(action, /RALPHWORKS_SOURCE_REPO: \$\{\{ vars\.RALPHWORKS_SOURCE_REPO \|\| 'OctopusGarage\/ralphworks' \}\}/);
  assert.match(action, /gh repo clone "\$RALPHWORKS_SOURCE_REPO" "\$RUNNER_TEMP\/ralphworks"/);
  assert.match(action, /git clone "https:\/\/github\.com\/\$\{RALPHWORKS_SOURCE_REPO\}\.git"/);
  assert.match(action, /run-name: RalphWorks \$\{\{ inputs\.request_id \}\}/);
  assert.match(action, /node "\$RUNNER_TEMP\/ralphworks\/dist\/cli\.js" run "\$RALPH_TASK" --executor host/);
  assert.match(action, /git add -N --all\n/);

  const issueAction = await readFile(join(workspace, ".github", "workflows", "ralphworks-issue.yml"), "utf8");
  assert.match(issueAction, /types: \[labeled\]/);
  assert.match(issueAction, /github\.event\.label\.name == 'ralphworks:run'/);
  assert.match(issueAction, /collaborators\/\$LABEL_ACTOR\/permission/);
  assert.match(issueAction, /RALPHWORKS_ISSUE_CHECK is required/);
  assert.match(issueAction, /contents: read/);
  assert.match(issueAction, /RALPHWORKS_ISSUE_TOKEN/);
  assert.match(issueAction, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(issueAction, /if: always\(\) && steps\.ralph\.outcome != 'skipped'/);
  assert.match(issueAction, /\.status == "completed"/);
  assert.match(issueAction, /git apply --check/);
  assert.match(issueAction, /gh pr create --draft/);
  assert.match(issueAction, /if: failure\(\)/);
  for (const file of [
    "ralphworks-issue.yml",
    "ralphworks-prd-split.yml",
    "ralphworks-prd-implement.yml",
    "ralphworks-pr-review.yml",
    "ralphworks-pr-feedback.yml",
    "ralphworks-update-branch.yml",
  ]) {
    const workflow = await readFile(join(workspace, ".github", "workflows", file), "utf8");
    assert.match(workflow, /\.status == "needs_input"/);
    assert.match(workflow, /needs human input/);
    assert.match(workflow, /gh run download "\$GITHUB_RUN_ID"/);
  }
  for (const [file, trigger] of [
    ["ralphworks-prd-split.yml", "ralphworks:to-issues"],
    ["ralphworks-prd-implement.yml", "ralphworks:implement-prd"],
    ["ralphworks-queue.yml", "ralphworks:queued"],
    ["ralphworks-pr-review.yml", "ralphworks:review"],
    ["ralphworks-pr-feedback.yml", "ralphworks:implement"],
    ["ralphworks-update-branch.yml", "ralphworks:update-branch"],
    ["ralphworks-architecture.yml", "ralphworks:architecture"],
  ]) {
    const workflow = await readFile(join(workspace, ".github", "workflows", file), "utf8");
    assert.match(workflow, new RegExp(trigger));
  }

  for (const file of [
    "ralphworks-issue.yml",
    "ralphworks-prd-split.yml",
    "ralphworks-prd-implement.yml",
    "ralphworks-pr-review.yml",
    "ralphworks-pr-feedback.yml",
    "ralphworks-update-branch.yml",
    "ralphworks-architecture.yml",
  ]) {
    const workflow = await readFile(join(workspace, ".github", "workflows", file), "utf8");
    assert.match(workflow, /RALPHWORKS_REF: \$\{\{ vars\.RALPHWORKS_REF \|\| 'v0\.1\.1' \}\}/);
    assert.match(workflow, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    assert.match(workflow, /RALPHWORKS_AUTH_SECRET_VALUE: \$\{\{ secrets\[vars\.RALPHWORKS_AUTH_SECRET\] \}\}/);
  }

  for (const file of [
    "ralphworks-prd-split.yml",
    "ralphworks-prd-implement.yml",
    "ralphworks-pr-review.yml",
    "ralphworks-pr-feedback.yml",
    "ralphworks-update-branch.yml",
    "ralphworks-architecture.yml",
  ]) {
    const workflow = await readFile(join(workspace, ".github", "workflows", file), "utf8");
    assert.match(workflow, /gh repo clone "\$RALPHWORKS_SOURCE_REPO" "\$RUNNER_TEMP\/ralphworks"/);
    assert.match(workflow, /pnpm --dir "\$RUNNER_TEMP\/ralphworks" build/);
  }
});

test("initProject skips existing files without overwriting them", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-init-"));
  await initProject(workspace);

  const second = await initProject(workspace);

  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skipped, [
    ".github/workflows/ralphworks-issue.yml",
    ".github/workflows/ralphworks-prd-split.yml",
    ".github/workflows/ralphworks-prd-implement.yml",
    ".github/workflows/ralphworks-queue.yml",
    ".github/workflows/ralphworks-pr-review.yml",
    ".github/workflows/ralphworks-pr-feedback.yml",
    ".github/workflows/ralphworks-update-branch.yml",
    ".github/workflows/ralphworks-architecture.yml",
    ".github/workflows/ralphworks.yml",
  ]);
  assert.deepEqual(second.updated, []);
  assert.equal(await readFile(join(workspace, ".gitignore"), "utf8"), ".ralph/\n");
});

test("initProject appends the runtime ignore to an existing gitignore once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-init-"));
  await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
  const first = await initProject(workspace);
  const second = await initProject(workspace);
  assert.deepEqual(first.updated, [".gitignore"]);
  assert.deepEqual(second.updated, []);
  assert.equal(await readFile(join(workspace, ".gitignore"), "utf8"), "node_modules/\n.ralph/\n");
});
