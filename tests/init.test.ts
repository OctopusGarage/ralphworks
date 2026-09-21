import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initProject } from "../src/init.ts";

test("initProject creates the workflow and ignores runtime state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-init-"));

  const result = await initProject(workspace);

  assert.deepEqual(result.created, [".github/workflows/ralphworks.yml", ".gitignore"]);
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
  assert.match(action, /RALPHWORKS_REF: \$\{\{ vars\.RALPHWORKS_REF \|\| 'v0\.1\.5' \}\}/);
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
});

test("initProject skips existing files without overwriting them", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-init-"));
  await initProject(workspace);

  const second = await initProject(workspace);

  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skipped, [".github/workflows/ralphworks.yml"]);
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
