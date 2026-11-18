import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runLocalJob } from "../src/orchestrator.ts";
import { resolveTask } from "../src/resolved-task.ts";
import { parseRunArgs } from "../src/run-args.ts";

const exec = promisify(execFile);
const CLI = resolve("src/cli.ts");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ralph-external-state-")));
  const cwd = join(root, "project");
  await mkdir(cwd);
  return { root, cwd, stateDir: join(root, "runtime-state") };
}

async function cli(cwd: string, args: string[]) {
  return exec(process.execPath, [CLI, ...args], { cwd }).then(
    (result) => ({ ...result, code: 0 }),
    (error: { stdout: string; stderr: string; code: number }) => error,
  );
}

async function missing(path: string) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

async function job(root: string, progress?: string) {
  const path = join(root, "task.yaml");
  await writeFile(
    path,
    `name: external-state\ntask: Inspect this project.\nmax_iterations: 1\n${progress ? `progress_file: ${progress}\n` : ""}`,
  );
  return path;
}

async function profile(root: string) {
  const path = join(root, "profile");
  await mkdir(join(path, "skill", "scripts"), { recursive: true });
  await mkdir(join(path, "plugin"));
  await writeFile(
    join(path, "profile.json"),
    JSON.stringify({
      version: 1,
      name: "portable-fixture",
      skills: ["skill"],
      prompts: ["method.md"],
      environment: { extensions: ["plugin"], contextFiles: ["context.md"] },
      defaults: { maxIterations: 1 },
    }),
  );
  await writeFile(join(path, "method.md"), "Inspect the portable fixture.");
  await writeFile(
    join(path, "skill", "SKILL.md"),
    "---\nname: portable-fixture\ndescription: Inspect the fixture\n---\nUse scripts/check.sh relative to this skill.",
  );
  await writeFile(join(path, "skill", "scripts", "check.sh"), "echo support-asset\n");
  await writeFile(join(path, "plugin", "index.js"), "export default function(){}\n");
  await writeFile(join(path, "plugin", "helper.js"), "export const support = true;\n");
  await writeFile(join(path, "context.md"), "Explicit portable context.");
  return path;
}

test("public host CLI keeps all path-bearing runtime state outside the workspace and preserves receipt/status/trace", async () => {
  const f = await fixture();
  try {
    await exec("git", ["init", "-q"], { cwd: f.cwd });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"], {
      cwd: f.cwd,
    });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout.trim();
    const selectedProfile = await profile(f.root);
    const task = await job(f.root);
    const receiptPath = join(f.root, "receipt.json");
    const scanner = join(f.root, "portable-check.cjs");
    await writeFile(
      scanner,
      `const fs=require('node:fs'),assert=require('node:assert/strict');const paths=fs.readdirSync('.ralph',{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>require('node:path').relative('.ralph',require('node:path').join(x.parentPath,x.name)));assert.deepEqual(paths,['run.lock/owner']);assert.match(fs.readFileSync('.ralph/run.lock/owner','utf8'),/^\\d+:[0-9a-f-]{36}$/);`,
    );
    const result = await cli(f.cwd, [
      "run",
      task,
      "--runner",
      "dry-run",
      "--profile",
      selectedProfile,
      "--state-dir",
      "../runtime-state",
      "--check",
      `node ${JSON.stringify(scanner)}`,
      "--result-file",
      receiptPath,
      "--invocation-id",
      "portable-state",
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /RalphWorks run max_iterations/);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.workspace.path, await realpath(f.cwd));
    assert.equal(receipt.workspace.baseHead, head);
    assert.equal(receipt.workspace.head, head);
    assert.equal(receipt.result.checks[0].exitCode, 0, receipt.result.checks[0].stderr);
    for (const path of [receipt.result.runDir, receipt.result.resultPath, receipt.result.eventsPath]) {
      assert.ok(!relative(f.stateDir, path).startsWith(".."), path);
      assert.ok(isAbsolute(path));
    }
    const snapshot = JSON.parse(await readFile(join(receipt.result.runDir, "task.json"), "utf8"));
    assert.equal(snapshot.runtime.stateDir, f.stateDir);
    assert.equal(await readFile(join(dirname(snapshot.skillPaths[0]), "scripts", "check.sh"), "utf8"), "echo support-asset\n");
    assert.equal(await readFile(join(snapshot.environment.extensions[0], "helper.js"), "utf8"), "export const support = true;\n");
    assert.equal(await readFile(snapshot.environment.contextFiles[0], "utf8"), "Explicit portable context.");
    for (const path of [
      ...snapshot.skillPaths,
      ...snapshot.environment.extensions,
      ...snapshot.environment.contextFiles,
      snapshot.job.progressFile,
    ])
      assert.ok(!relative(f.stateDir, path).startsWith(".."), path);
    assert.deepEqual(await readdir(join(f.cwd, ".ralph")), []);
    const status = await cli(f.cwd, ["status", join(f.stateDir, "current")]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /status=max_iterations/);
    const trace = await cli(f.cwd, ["trace", receipt.result.eventsPath]);
    assert.equal(trace.code, 0, trace.stderr);
    assert.match(trace.stdout, /run_started/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("plan and help expose state-dir without writing either state location", async () => {
  const f = await fixture();
  try {
    const result = await cli(f.cwd, [
      "plan",
      "Inspect this project",
      "--state-dir",
      "../runtime-state",
      "--runner",
      "dry-run",
      "--profile",
      await profile(f.root),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.runtime.stateDir, f.stateDir);
    assert.ok(plan.job.progressFile.startsWith(join(f.stateDir, "progress")));
    const help = await cli(f.cwd, ["run", "Inspect this project", "--help", "--state-dir", f.stateDir]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--state-dir PATH/);
    await missing(f.stateDir);
    await missing(join(f.cwd, ".ralph"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("public concurrent default-state CLI cannot stage inputs while an external-state CLI owns the workspace", {
  timeout: 15_000,
}, async () => {
  const f = await fixture();
  const ready = join(f.root, "gate-ready");
  const release = join(f.root, "gate-release");
  const check = join(f.root, "gate-check.cjs");
  await writeFile(
    check,
    `const fs=require('node:fs'),assert=require('node:assert/strict');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);assert.deepEqual(fs.readdirSync('.ralph'),['run.lock']);}},10);setTimeout(()=>{clearInterval(timer);process.exit(2);},10000).unref();`,
  );
  const first = spawn(
    process.execPath,
    [CLI, "run", await job(f.root), "--runner", "dry-run", "--state-dir", f.stateDir, "--check", `node ${JSON.stringify(check)}`],
    { cwd: f.cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  first.stdout.resume();
  first.stderr.resume();
  const closed = new Promise<number | null>((done) => first.once("close", done));
  try {
    let started = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      started = await stat(ready).then(
        () => true,
        () => false,
      );
      if (started) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(started, true, "external-state CLI did not reach its active check");
    const second = await cli(f.cwd, ["run", "Inspect", "--runner", "dry-run", "--profile", await profile(f.root)]);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /locked by another/);
    assert.deepEqual(await readdir(join(f.cwd, ".ralph")), ["run.lock"]);
  } finally {
    await writeFile(release, "release");
    await closed;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("state-dir rejects missing, empty and duplicate values", () => {
  const parsed = parseRunArgs(["--state-dir", "../state"], {});
  assert.ok(!(parsed instanceof Error), String(parsed));
  assert.equal(parsed.stateDir, "../state");
  for (const args of [
    ["--state-dir"],
    ["--state-dir", ""],
    ["--state-dir", "--runner", "dry-run"],
    ["--state-dir", "one", "--state-dir", "two"],
  ]) {
    const error = parseRunArgs(args, {});
    assert.ok(error instanceof Error);
    assert.match(error.message, /state-dir.*(value|duplicate)|duplicate.*state-dir/i);
  }
});

for (const suffix of [".ralph/run.lock", ".ralph/run.lock/state", ".ralph/RUN.LOCK/state"]) {
  test(`reserved lock state root is rejected by the library: ${suffix}`, async () => {
    const f = await fixture();
    let ran = false;
    try {
      await assert.rejects(
        runLocalJob("Inspect", {
          cwd: f.cwd,
          stateDir: join(f.cwd, suffix),
          runner: {
            async runIteration() {
              ran = true;
              return { status: "complete", summary: "Finished." };
            },
          },
        }),
        /reserved.*run\.lock/i,
      );
      assert.equal(ran, false);
      await missing(join(f.cwd, ".ralph"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

async function rejectLockStateCli(f: Awaited<ReturnType<typeof fixture>>, stateDir: string) {
  const receipt = join(f.root, "receipt.json");
  const marker = join(f.root, "check-ran");
  const checker = join(f.root, "check.cjs");
  await writeFile(checker, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
  const result = await cli(f.cwd, [
    "run",
    await job(f.root),
    "--runner",
    "dry-run",
    "--profile",
    await profile(f.root),
    "--state-dir",
    stateDir,
    "--check",
    `node ${JSON.stringify(checker)} ${JSON.stringify(marker)}`,
    "--result-file",
    receipt,
    "--invocation-id",
    "reserved-lock",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reserved.*run\.lock/i);
  await missing(receipt);
  await missing(`${receipt}.lock`);
  await missing(marker);
  await missing(join(f.cwd, ".ralph", "inputs"));
  await missing(join(f.cwd, ".ralph", "run.lock"));
}

for (const suffix of [".ralph/run.lock", ".ralph/run.lock/state", ".ralph/RUN.LOCK/state"]) {
  test(`reserved lock state root is rejected by the public CLI before staging or receipt: ${suffix}`, async () => {
    const f = await fixture();
    try {
      await rejectLockStateCli(f, join(f.cwd, suffix));
      await missing(join(f.cwd, ".ralph"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const aliasKind of ["existing-parent", "dangling-target"]) {
  test(`reserved lock state root is rejected through a ${aliasKind} symlink`, async () => {
    const f = await fixture();
    try {
      const alias = join(f.root, "state-alias");
      let selected: string;
      if (aliasKind === "existing-parent") {
        await mkdir(join(f.cwd, ".ralph"));
        await symlink(join(f.cwd, ".ralph"), alias);
        selected = join(alias, "run.lock", "state");
      } else {
        await symlink(join(f.cwd, ".ralph", "run.lock"), alias);
        selected = join(alias, "state");
      }
      await rejectLockStateCli(f, selected);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const aliasKind of ["uppercase-workspace", "data-volume-workspace"]) {
  test(`reserved lock state root is rejected through the actual macOS ${aliasKind} alias`, async (t) => {
    if (process.platform !== "darwin") return t.skip("macOS filesystem alias control");
    const f = await fixture();
    try {
      const alias = aliasKind === "uppercase-workspace" ? f.cwd.toUpperCase() : `/System/Volumes/Data${f.cwd}`;
      const actual = await stat(f.cwd, { bigint: true });
      const alternate = await stat(alias, { bigint: true }).catch(() => undefined);
      if (!alternate || actual.dev !== alternate.dev || actual.ino !== alternate.ino)
        return t.skip("fixture volume does not expose this physical alias");
      await rejectLockStateCli(f, join(alias, ".ralph", "run.lock", "state"));
      await missing(join(f.cwd, ".ralph"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("ordinary external directory aliases remain valid state roots", async () => {
  const f = await fixture();
  try {
    const destination = join(f.root, "actual-state");
    const alias = join(f.root, "state-alias");
    await mkdir(destination);
    await symlink(destination, alias);
    const result = await runLocalJob(await job(f.root), { cwd: f.cwd, stateDir: alias });
    assert.equal(result.status, "max_iterations");
    assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, result.status);
    await missing(join(f.cwd, ".ralph", "run.lock"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("nonhost execution and unsafe in-workspace state fail before filesystem writes", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["--executor", "docker"],
      ["--executor", "docker-clone"],
    ]) {
      const result = await cli(f.cwd, ["run", "Inspect", "--state-dir", f.stateDir, ...args]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /state-dir.*host|host.*state-dir/i);
    }
    for (const path of [".", "runtime", join(f.cwd, "nested", "state")]) {
      const result = await cli(f.cwd, ["plan", "Inspect", "--state-dir", path]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /state.*outside.*workspace|state.*\.ralph/i);
    }
    const alias = join(f.root, "alias");
    await symlink(f.cwd, alias);
    const linked = await cli(f.cwd, ["plan", "Inspect", "--state-dir", join(alias, "runtime")]);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /state.*outside.*workspace|state.*\.ralph/i);
    const dangling = join(f.root, "dangling");
    await symlink(join(f.cwd, "not-created"), dangling);
    const redirected = await cli(f.cwd, ["plan", "Inspect", "--state-dir", join(dangling, "runtime")]);
    assert.equal(redirected.code, 1);
    assert.match(redirected.stderr, /state.*outside.*workspace|state.*\.ralph/i);
    await missing(f.stateDir);
    await missing(join(f.cwd, ".ralph"));
    await missing(join(f.cwd, "runtime"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worktree state and ownership record survive cleanup in the explicit external root", async () => {
  const f = await fixture();
  try {
    await exec("git", ["init", "-q"], { cwd: f.cwd });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"], {
      cwd: f.cwd,
    });
    const workspace = join(f.root, "task-worktree");
    const badPlan = await cli(f.cwd, [
      "plan",
      "Inspect",
      "--workspace",
      "worktree",
      "--worktree-path",
      workspace,
      "--state-dir",
      join(workspace, "runtime"),
    ]);
    assert.equal(badPlan.code, 1);
    assert.match(badPlan.stderr, /state.*outside.*workspace|state.*\.ralph/i);
    await missing(workspace);
    const result = await cli(f.cwd, [
      "run",
      await job(f.root),
      "--runner",
      "dry-run",
      "--workspace",
      "worktree",
      "--worktree-path",
      workspace,
      "--state-dir",
      f.stateDir,
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr, "");
    const record = result.stdout.match(/^workspaceRecord=(.+)$/m)?.[1];
    assert.ok(record, result.stdout);
    assert.ok(record.startsWith(join(f.stateDir, "workspaces")), result.stdout);
    assert.equal(JSON.parse(await readFile(record, "utf8")).cwd, workspace);
    await missing(join(f.cwd, ".ralph"));
    await missing(workspace);
    assert.ok((await readFile(join(f.stateDir, "current"), "utf8")).startsWith("runs/"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("library environment inventory and events follow stateDir while the runner cwd stays the project", async () => {
  const f = await fixture();
  try {
    const result = await runLocalJob("Inspect", {
      cwd: f.cwd,
      stateDir: f.stateDir,
      runner: {
        async runIteration(input) {
          assert.equal(input.cwd, f.cwd);
          return { status: "complete", summary: "Finished.", events: [{ type: "pi_environment_ready", details: { cwd: input.cwd } }] };
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(JSON.parse(await readFile(join(result.runDir, "environment-1.json"), "utf8")).cwd, f.cwd);
    assert.match(await readFile(result.eventsPath, "utf8"), /pi_environment_ready/);
    assert.deepEqual(await readdir(join(f.cwd, ".ralph")), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("under-lock task preparation supplies the effective job and runner before progress rebasing", async () => {
  const f = await fixture();
  try {
    const task = await resolveTask("Inspect", { cwd: f.cwd });
    let preparations = 0;
    const result = await runLocalJob("Inspect", {
      cwd: f.cwd,
      stateDir: f.stateDir,
      preparedTask: task,
      runner: {
        async runIteration() {
          throw new Error("superseded runner must not execute");
        },
      },
      prepareTask: async (resolved) => {
        preparations++;
        assert.match(await readFile(join(f.cwd, ".ralph", "run.lock", "owner"), "utf8"), /^\d+:[0-9a-f-]{36}$/);
        return {
          task: { ...resolved, job: { ...resolved.job, progressFile: ".ralph/progress/prepared.md" } },
          runner: {
            async runIteration() {
              return { status: "complete", summary: "Prepared task complete." };
            },
          },
        };
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(preparations, 1);
    assert.match(await readFile(join(f.stateDir, "progress", "prepared.md"), "utf8"), /Prepared task complete/);
    const retained = await runLocalJob("Inspect", {
      cwd: f.cwd,
      stateDir: f.stateDir,
      preparedTask: task,
      runner: {
        async runIteration() {
          return { status: "complete", summary: "Original runner retained." };
        },
      },
      prepareTask: async (resolved) => ({ task: resolved }),
    });
    assert.equal(retained.status, "completed");
    assert.equal(retained.lastSummary, "Original runner retained.");
    const failedState = join(f.root, "failed-state");
    await assert.rejects(
      runLocalJob("Inspect", {
        cwd: f.cwd,
        stateDir: failedState,
        preparedTask: task,
        prepareTask: async () => {
          throw new Error("preparation refused");
        },
      }),
      /preparation refused/,
    );
    await missing(failedState);
    await missing(join(f.cwd, ".ralph", "run.lock"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("different external state directories retain one workspace lock and release it after cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const first = runLocalJob("Inspect this project", {
    cwd: f.cwd,
    stateDir: f.stateDir,
    signal: controller.signal,
    runner: {
      async runIteration() {
        enter();
        await gate;
        return { status: "complete", summary: "Finished." };
      },
    },
  });
  try {
    await entered;
    assert.deepEqual(await readdir(join(f.cwd, ".ralph")), ["run.lock"]);
    assert.match(await readFile(join(f.cwd, ".ralph", "run.lock", "owner"), "utf8"), /^\d+:[0-9a-f-]{36}$/);
    await assert.rejects(runLocalJob("Inspect another task", { cwd: f.cwd, stateDir: join(f.root, "other-state") }), /locked by another/);
  } finally {
    controller.abort("SIGINT");
    release();
    const result = await first;
    assert.equal(result.status, "cancelled");
    assert.ok(result.runDir.startsWith(f.stateDir));
    await missing(join(f.cwd, ".ralph", "run.lock"));
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const progress of [".ralph/progress/custom.md", "notes/progress.md", "absolute"]) {
  test(`library state-dir preserves progress mapping for ${progress}`, async () => {
    const f = await fixture();
    try {
      const selected = progress === "absolute" ? join(f.root, "chosen-progress.md") : progress;
      const path = await job(f.root, selected);
      const result = await runLocalJob(path, { cwd: f.cwd, stateDir: f.stateDir });
      assert.ok(result.runDir.startsWith(f.stateDir));
      const expected = progress.startsWith(".ralph/") ? join(f.stateDir, "progress", "custom.md") : resolve(f.cwd, selected);
      assert.match(await readFile(expected, "utf8"), /RalphWorks Progress/);
      const snapshot = JSON.parse(await readFile(join(result.runDir, "task.json"), "utf8"));
      assert.equal(resolve(f.cwd, snapshot.job.progressFile), expected);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("default plan and library paths stay unchanged and reserved in-workspace state is allowed", async () => {
  const f = await fixture();
  try {
    const plan = await cli(f.cwd, ["plan", "Inspect", "--runner", "dry-run"]);
    assert.equal(plan.code, 0, plan.stderr);
    assert.equal(Object.hasOwn(JSON.parse(plan.stdout).runtime, "stateDir"), false);
    const defaultResult = await runLocalJob(await job(f.root), { cwd: f.cwd });
    assert.ok(defaultResult.runDir.startsWith(join(f.cwd, ".ralph", "runs")));
    const reserved = join(f.cwd, ".ralph", "custom-state");
    const customResult = await runLocalJob("Inspect", { cwd: f.cwd, stateDir: reserved });
    assert.ok(customResult.runDir.startsWith(join(reserved, "runs")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
