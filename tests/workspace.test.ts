import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWorkspace } from "../src/workspace.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-workspace-"));
  const cwd = join(root, "source");
  execFileSync("git", ["init", "-q", cwd]);
  await writeFile(join(cwd, "file.txt"), "baseline");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
  return { root, cwd };
}

test("worktree creates a retained branch from HEAD and leaves source unchanged", async () => {
  const { root, cwd } = await fixture();
  const workspace = await prepareWorkspace(cwd, { kind: "worktree", path: join(root, "task") });
  assert.equal(workspace.cwd, join(root, "task"));
  assert.match(workspace.branch ?? "", /^ralphworks\//);
  assert.equal(execFileSync("git", ["-C", workspace.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workspace.baseHead);
  await writeFile(join(workspace.cwd, "file.txt"), "task edit");
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "baseline");
  assert.ok(workspace.recordPath);
  assert.equal(JSON.parse(await readFile(workspace.recordPath, "utf8")).cwd, workspace.cwd);
  await assert.rejects(prepareWorkspace(cwd, { kind: "worktree", path: workspace.cwd }), /exist/);
});

test("worktree refuses dirty baselines while current workspace accepts edits", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "user edit");
  await assert.rejects(prepareWorkspace(cwd, { kind: "worktree" }), /clean Git workspace/);
  assert.equal((await prepareWorkspace(cwd, { kind: "current" })).cwd, cwd);
});

test("worktree requires a repository root and current mode works without Git", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-no-git-"));
  assert.equal((await prepareWorkspace(cwd, { kind: "current" })).cwd, cwd);
  await assert.rejects(prepareWorkspace(cwd, { kind: "worktree" }), /Git/);
});
