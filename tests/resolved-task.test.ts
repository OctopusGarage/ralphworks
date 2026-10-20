import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLocalJob } from "../src/orchestrator.ts";
import { resolveTask } from "../src/resolved-task.ts";

test("task types compose before progress identity with job and CLI taking precedence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-resolved-"));
  const profile = join(cwd, ".ralphworks", "profiles", "bugfix");
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, "profile.json"),
    JSON.stringify({
      version: 1,
      name: "bugfix",
      prompts: ["method.md"],
      parameters: { scope: null },
      defaults: { maxIterations: 7, commit: "verified" },
      checks: ["profile-check"],
    }),
  );
  await writeFile(join(profile, "method.md"), "Investigate {{scope}} before editing.");
  const path = join(cwd, "job.yaml");
  await writeFile(path, "name: login\ntask: Fix it\nprofile: bugfix\nmax_iterations: 2\ncommit: none\nchecks:\n  - job-check\n");
  const first = await resolveTask(path, { cwd, params: { scope: "login" }, checks: ["cli-check"], jobOverrides: { maxIterations: 3 } });
  assert.equal(first.job.maxIterations, 3);
  assert.equal(first.job.commit, "none");
  assert.deepEqual(first.job.checks, ["cli-check"]);
  assert.match(first.job.task, /Investigate login before editing/);
  const second = await resolveTask(path, { cwd, params: { scope: "logout" } });
  assert.equal(second.job.maxIterations, 2);
  assert.notEqual(first.job.progressFile, second.job.progressFile);
  assert.deepEqual(second.job.checks, ["job-check"]);
  assert.equal((await resolveTask("Do something", { cwd, profile: "bugfix", params: { scope: "login" } })).job.maxIterations, 7);
  await assert.rejects(resolveTask("Do something", { cwd, params: { scope: "login" } }), /profile/);
});

test("orchestrator persists resolved task and profile provenance for each run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-resolved-run-"));
  const profile = join(cwd, "profile");
  await mkdir(profile);
  await writeFile(
    join(profile, "profile.json"),
    JSON.stringify({ version: 1, name: "review", prompts: ["method.md"], defaults: { maxIterations: 1 } }),
  );
  await writeFile(join(profile, "method.md"), "Review correctness.");
  const result = await runLocalJob("Review this code", { cwd, profile });
  const snapshot = JSON.parse(await readFile(join(result.runDir, "task.json"), "utf8"));
  assert.equal(snapshot.profile.name, "review");
  assert.match(snapshot.job.task, /Review correctness/);
  assert.equal(snapshot.profile.manifest.resources[0].sha256.length, 64);
  assert.equal(result.iterations, 1);
});

test("staged skills retain supporting scripts and survive changes to the collection", async () => {
  const { stageTaskSkills } = await import("../src/resolved-task.ts");
  const cwd = await mkdtemp(join(tmpdir(), "ralph-skill-snapshot-"));
  const profile = join(cwd, "profile");
  await mkdir(join(profile, "skill", "scripts"), { recursive: true });
  await writeFile(join(profile, "profile.json"), JSON.stringify({ version: 1, name: "review", skills: ["skill"] }));
  await writeFile(
    join(profile, "skill", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\nRun scripts/check.sh relative to this skill directory.",
  );
  await writeFile(join(profile, "skill", "scripts", "check.sh"), "echo original");
  const original = await resolveTask("Review", { cwd, profile });
  const staged = await stageTaskSkills(original, cwd);
  await writeFile(join(profile, "skill", "scripts", "check.sh"), "echo changed");
  assert.notEqual(staged.skillPaths[0], original.skillPaths[0]);
  const { dirname } = await import("node:path");
  assert.equal(await readFile(join(dirname(staged.skillPaths[0]), "scripts", "check.sh"), "utf8"), "echo original");
  assert.match(staged.job.task, /\.ralph\/inputs/);
  assert.equal(staged.job.progressFile, original.job.progressFile);
});

test("project profile progress survives moving into a worktree while support file changes invalidate it", async () => {
  const { cp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ralph-identity-"));
  const source = join(root, "source");
  const dest = join(root, "worktree");
  const profile = join(source, ".ralphworks", "profiles", "review");
  await mkdir(join(profile, "skill"), { recursive: true });
  await writeFile(join(profile, "profile.json"), JSON.stringify({ version: 1, name: "review", skills: ["skill"] }));
  await writeFile(join(profile, "skill", "SKILL.md"), "Review code.");
  await writeFile(join(profile, "skill", "support.txt"), "original");
  await cp(source, dest, { recursive: true });
  const first = await resolveTask("Review", { cwd: source, profile: "review" });
  const second = await resolveTask("Review", { cwd: dest, profile: "review" });
  assert.equal(first.job.progressFile, second.job.progressFile);
  await writeFile(join(profile, "skill", "support.txt"), "changed");
  assert.notEqual((await resolveTask("Review", { cwd: source, profile: "review" })).job.progressFile, first.job.progressFile);
});
