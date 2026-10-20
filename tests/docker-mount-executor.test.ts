import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDockerMountJob } from "../src/docker-mount-executor.ts";

test("runDockerMountJob mounts the current workspace and selected Pi config", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];

  const result = await runDockerMountJob({
    cwd: "/Users/me/project",
    jobPath: "TASK.md",
    runner: "pi",
    modelRef: { provider: "my-gateway", id: "my-coder-model" },
    piAgentDir: "/Users/me/.pi/agent",
    passEnv: ["MY_GATEWAY_API_KEY"],
    contexts: ["spec.md", "docs/api"],
    jobOverrides: { maxIterations: 8, commit: "none" },
    env: { MY_GATEWAY_API_KEY: "secret" },
    runCommand: async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0, stdout: "container ok", stderr: "" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "docker");
  assert.deepEqual(calls[0].args.slice(0, 2), ["run", "--rm"]);
  assert.ok(calls[0].args.includes("--entrypoint"));
  assert.ok(calls[0].args.includes("bash"));
  assert.equal(calls[0].args.at(-2), "-c");
  assert.ok(calls[0].args.includes("/Users/me/project:/workspace"));
  assert.ok(calls[0].args.includes("--user"));
  assert.ok(calls[0].args.includes("root"));
  assert.ok(calls[0].args.includes("--tmpfs"));
  assert.ok(calls[0].args.includes("/workspace/node_modules:rw,exec"));
  assert.ok(calls[0].args.includes("/Users/me/.pi/agent:/home/agent/.pi/agent"));
  assert.ok(calls[0].args.includes("RALPHWORKS_MODEL=my-gateway/my-coder-model"));
  assert.ok(calls[0].args.includes("RALPHWORKS_UNATTENDED=1"));
  assert.ok(calls[0].args.includes("PI_CODING_AGENT_DIR=/home/agent/.pi/agent"));
  assert.ok(calls[0].args.includes("MY_GATEWAY_API_KEY"));
  assert.ok(calls[0].args.includes('RALPHWORKS_CONTEXTS_JSON=["spec.md","docs/api"]'));
  assert.ok(calls[0].args.includes('RALPHWORKS_JOB_OVERRIDES_JSON={"maxIterations":8,"commit":"none"}'));
  assert.match(calls[0].args.at(-1) ?? "", /cd \/workspace/);
  assert.ok((calls[0].args.at(-1) ?? "").includes('usermod --non-unique --uid "$WORKSPACE_UID" agent'));
  assert.match(calls[0].args.at(-1) ?? "", /chown agent:node \/workspace\/node_modules/);
  assert.match(calls[0].args.at(-1) ?? "", /su agent -s \/bin\/bash/);
  assert.match(calls[0].args.at(-1) ?? "", /git config --global user\.name/);
  assert.match(calls[0].args.at(-1) ?? "", /git config --global user\.email/);
  assert.match(calls[0].args.at(-1) ?? "", /npm ci/);
  assert.match(calls[0].args.at(-1) ?? "", /ralphworks run "\$RALPH_JOB" --runner "\$RALPH_RUNNER" --executor host/);
});

test("runDockerMountJob exposes linked worktree Git metadata to the container", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralphworks-linked-worktree-"));
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", source]);
  execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", source, "worktree", "add", "-b", "test", worktree]);
  let args: string[] = [];
  await runDockerMountJob({
    cwd: worktree,
    jobPath: "TASK.md",
    runner: "dry-run",
    runCommand: async (_file, input) => {
      args = input;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const commonDir = execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  assert.ok(args.includes(`${commonDir}:${commonDir}`));
});

test("Docker mount executes a prepared task with container skill paths instead of reloading caller inputs", async () => {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { resolveTask, stageTaskSkills } = await import("../src/resolved-task.ts");
  const cwd = await mkdtemp(join(tmpdir(), "ralph-prepared-docker-"));
  const profile = join(cwd, "profile");
  await mkdir(join(profile, "skill"), { recursive: true });
  await writeFile(join(profile, "profile.json"), JSON.stringify({ version: 1, name: "review", skills: ["skill"] }));
  await writeFile(join(profile, "skill", "SKILL.md"), "Review carefully.");
  const task = await stageTaskSkills(await resolveTask("Review", { cwd, profile }), cwd);
  let args: string[] = [];
  await runDockerMountJob({
    cwd,
    jobPath: "Review",
    runner: "dry-run",
    preparedTask: task,
    runCommand: async (_file, input) => {
      args = input;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const variable = args.find((value) => value.startsWith("RALPHWORKS_PREPARED_TASK="));
  assert.ok(variable);
  const path = variable.split("=")[1].replace("/workspace", cwd);
  const prepared = JSON.parse(await readFile(path, "utf8"));
  assert.match(prepared.skillPaths[0], /^\/workspace\/\.ralph\/inputs/);
  assert.match(prepared.job.task, /Skill: \/workspace\//);
  assert.equal(prepared.job.progressFile, task.job.progressFile);
});

test("Docker forwards selected MCP credential variable names without embedding their values", async () => {
  let args: string[] = [];
  await runDockerMountJob({
    cwd: "/tmp/workspace",
    jobPath: "Task",
    runner: "pi",
    mcpBindings: { docs: { transport: "http", url: "http://host.docker.internal:9000/mcp", headers: { Authorization: "DOCS_AUTH" } } },
    env: { DOCS_AUTH: "secret-auth" },
    runCommand: async (_file, values) => {
      args = values;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(args.includes("DOCS_AUTH"));
  assert.ok(args.some((value) => value.startsWith("RALPHWORKS_MCP_BINDINGS_JSON=")));
  assert.ok(!args.some((value) => value.includes("secret-auth")));
});
