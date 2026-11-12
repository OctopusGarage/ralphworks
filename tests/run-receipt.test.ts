import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runLocalJob } from "../src/orchestrator.ts";
import { resolveTask } from "../src/resolved-task.ts";
import { runTaskCommand } from "../src/run-command.ts";
import { withRunLock } from "../src/run-lock.ts";
import { reserveRunReceipt } from "../src/run-receipt.ts";

const exec = promisify(execFile);
const cli = resolve("src/cli.ts");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralphworks-receipt-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"], {
    cwd,
  });
  const input = 'name: receipt-test\ntask: Verify this fixture.\nmax_iterations: 1\ncommit: none\nchecks:\n  - node -e "process.exit(0)"\n';
  const target = join(root, "task.yaml");
  await writeFile(target, input);
  return { root, cwd, input, target, path: join(root, "receipt.json") };
}

async function run(f: Awaited<ReturnType<typeof fixture>>, args: string[] = []) {
  return exec("node", [cli, "run", f.target, "--runner", "dry-run", "--result-file", f.path, "--invocation-id", "attempt-123", ...args], {
    cwd: f.cwd,
  }).then(
    (r) => ({ ...r, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => e,
  );
}

test("run publishes a correlated terminal receipt even when the task does not complete", async () => {
  const f = await fixture();
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout.trim();
  const r = await run(f);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /RalphWorks run max_iterations/);
  const receipt = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.invocationId, "attempt-123");
  assert.equal(receipt.taskInputSha256, createHash("sha256").update(f.input).digest("hex"));
  assert.equal(receipt.workspace.baseHead, head);
  assert.equal(receipt.workspace.head, head);
  assert.equal(receipt.workspace.path, await import("node:fs/promises").then((m) => m.realpath(f.cwd)));
  assert.equal(receipt.result.status, "max_iterations");
  assert.equal(receipt.result.checks[0].exitCode, 0);
  assert.deepEqual(receipt.result, JSON.parse(await readFile(receipt.result.resultPath, "utf8")));
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  assert.equal(receipt.profile, null);
  assert.deepEqual(receipt.outputs, []);
  await assert.rejects(stat(`${f.path}.lock`), { code: "ENOENT" });
});

for (const callerWorktree of [false, true]) {
  test(`receipt identifies only its locked run in a caller-owned ${callerWorktree ? "worktree" : "repository"}`, async (t) => {
    const f = await fixture();
    await exec("git", ["config", "user.name", "Test"], { cwd: f.cwd });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: f.cwd });
    if (callerWorktree) {
      const worktree = join(f.root, "caller-worktree");
      await exec("git", ["worktree", "add", "-b", "caller", worktree], { cwd: f.cwd });
      f.cwd = worktree;
    }
    const profile = join(f.root, "profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, name: "locked-receipt", outputs: [{ path: "REPORT.json", format: "json" }] }));
    const report = '{"invocation":"original"}\n';
    const check = join(f.root, "write-report.cjs");
    await writeFile(check, `require('node:fs').writeFileSync('REPORT.json', ${JSON.stringify(report)});`);
    const lockDir = join(f.cwd, ".ralph", "run.lock");
    const originalMkdir = fs.mkdir;
    const originalRm = fs.rm;
    let phase = "before";
    let initialHead: string | undefined;
    let finalHead: string | undefined;
    let publishedBeforeRelease: string | undefined;
    // Schedule real neighboring lock owners at the filesystem boundary, without timing races.
    const mkdirHook = t.mock.method(fs, "mkdir", async (...args: Parameters<typeof mkdir>) => {
      if (String(args[0]) === lockDir && phase === "before") {
        phase = "predecessor";
        await withRunLock(f.cwd, async () => {
          await exec("git", ["commit", "--allow-empty", "-qm", "preceding run"], { cwd: f.cwd });
          initialHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout.trim();
        });
        phase = "run";
      }
      return originalMkdir(...args);
    });
    const rmHook = t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) !== lockDir || phase !== "run") return originalRm(...args);
      publishedBeforeRelease = await readFile(f.path, "utf8").catch(() => undefined);
      finalHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout.trim();
      await originalRm(...args);
      phase = "successor";
      await withRunLock(f.cwd, async () => {
        await writeFile(join(f.cwd, "REPORT.json"), '{"invocation":"successor"}\n');
        await exec("git", ["add", "REPORT.json"], { cwd: f.cwd });
        await exec("git", ["commit", "-qm", "following run"], { cwd: f.cwd });
      });
      phase = "done";
    });
    syncBuiltinESMExports();
    const previousCwd = process.cwd();
    try {
      process.chdir(f.cwd);
      const code = await runTaskCommand("run", f.target, [
        "--runner",
        "dry-run",
        "--profile",
        profile,
        "--commit",
        "verified",
        "--check",
        `node ${JSON.stringify(check)}`,
        "--result-file",
        f.path,
        "--invocation-id",
        "locked-identity",
      ]);
      assert.equal(code, 1);
      assert.equal(phase, "done");
      assert.ok(initialHead);
      assert.ok(finalHead);
      assert.notEqual(initialHead, finalHead, "the run must create its own verified commit");
      const actual = JSON.parse(await readFile(f.path, "utf8"));
      assert.deepEqual(
        { baseHead: actual.workspace.baseHead, head: actual.workspace.head, output: actual.outputs[0].sha256 },
        { baseHead: initialHead, head: finalHead, output: createHash("sha256").update(report).digest("hex") },
        "receipt identities must exclude the preceding and following lock owners",
      );
      assert.equal(publishedBeforeRelease, await readFile(f.path, "utf8"), "complete receipt must exist before lock release");
      assert.deepEqual(actual.result, JSON.parse(await readFile(actual.result.resultPath, "utf8")));
      assert.equal(actual.result.status, "max_iterations");
      assert.deepEqual(actual.result.commits, [finalHead]);
      assert.equal(await readFile(join(f.cwd, "REPORT.json"), "utf8"), '{"invocation":"successor"}\n');
      await assert.rejects(stat(lockDir), { code: "ENOENT" });
    } finally {
      process.chdir(previousCwd);
      mkdirHook.mock.restore();
      rmHook.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("lock rejection and host preparation failure do not fabricate terminal receipts", async () => {
  const locked = await fixture();
  await withRunLock(locked.cwd, async () => {
    const result = await run(locked);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /locked by another/);
    await assert.rejects(stat(locked.path), { code: "ENOENT" });
    await assert.rejects(stat(`${locked.path}.lock`), { code: "ENOENT" });
    await assert.rejects(stat(join(locked.cwd, ".ralph", "runs")), { code: "ENOENT" });
  });

  const failed = await fixture();
  const profile = join(failed.root, "profile.json");
  await writeFile(join(failed.root, "context.md"), "Stage this explicit context.");
  await writeFile(profile, JSON.stringify({ version: 1, name: "preparation-failure", environment: { contextFiles: ["context.md"] } }));
  await mkdir(join(failed.cwd, ".ralph"));
  await writeFile(join(failed.cwd, ".ralph", "inputs"), "not a directory");
  const result = await run(failed, ["--profile", profile]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOTDIR/);
  for (const path of [failed.path, `${failed.path}.lock`, join(failed.cwd, ".ralph", "runs"), join(failed.cwd, ".ralph", "run.lock")])
    await assert.rejects(stat(path), { code: "ENOENT" });
});

test("receipt arguments are paired, run-only, and reject unsupported transports before execution", async () => {
  const f = await fixture();
  for (const args of [
    ["run", f.target, "--result-file", f.path],
    ["run", f.target, "--invocation-id", "x"],
    ["plan", f.target, "--result-file", f.path, "--invocation-id", "x"],
    ["run", f.target, "--result-file", f.path, "--invocation-id", "../x"],
    ["run", f.target, "--result-file", f.path, "--invocation-id", "x", "--executor", "docker"],
  ]) {
    await assert.rejects(exec("node", [cli, ...args], { cwd: f.cwd }), (e: unknown) => {
      assert.match(String((e as { stderr: string }).stderr), /receipt|invocation|result-file/i);
      return true;
    });
    await assert.rejects(stat(join(f.cwd, ".ralph")), { code: "ENOENT" });
    await assert.rejects(stat(f.path), { code: "ENOENT" });
  }
});

test("an existing receipt or symlink is never replaced and blocks before agent/check execution", async () => {
  for (const link of [false, true]) {
    const f = await fixture();
    const prior = join(f.root, "prior.json");
    await writeFile(prior, "old evidence\n");
    if (link) await symlink(prior, f.path);
    else await writeFile(f.path, "old evidence\n");
    const r = await run(f);
    assert.match(r.stderr, /already exists|EEXIST/);
    assert.equal(await readFile(f.path, "utf8"), "old evidence\n");
    assert.equal((await lstat(f.path)).isSymbolicLink(), link);
    await assert.rejects(stat(join(f.cwd, ".ralph")), { code: "ENOENT" });
  }
});

test("a failed preflight leaves no terminal receipt or stale reservation", async () => {
  const f = await fixture();
  const r = await run(f, ["--profile", "builtin:does-not-exist"]);
  assert.equal(r.code, 1);
  await assert.rejects(stat(f.path), { code: "ENOENT" });
  await assert.rejects(stat(`${f.path}.lock`), { code: "ENOENT" });
});

test("SIGTERM waits for a running check and publishes cancellation with the same invocation", async () => {
  const f = await fixture();
  const ready = join(f.cwd, "ready");
  const check = `node -e "require('node:fs').writeFileSync('ready','yes');setTimeout(()=>{},10000)"`;
  const child = spawn(
    "node",
    [cli, "run", f.target, "--runner", "dry-run", "--check", check, "--result-file", f.path, "--invocation-id", "cancel-123"],
    { cwd: f.cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => (stderr += b));
  child.stdout.resume();
  const closed = new Promise<number | null>((done) => child.on("close", done));
  try {
    for (
      let i = 0;
      i < 500 &&
      !(await stat(ready).then(
        () => true,
        () => false,
      ));
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(await stat(ready).catch(() => false), stderr);
    await assert.rejects(stat(f.path), { code: "ENOENT" });
    child.kill("SIGTERM");
    assert.equal(await closed, 143);
    const receipt = JSON.parse(await readFile(f.path, "utf8"));
    assert.equal(receipt.invocationId, "cancel-123");
    assert.equal(receipt.result.status, "cancelled");
    assert.equal(receipt.result.checks.at(-1).cancelled, true);
    await assert.rejects(stat(join(f.cwd, ".ralph", "run.lock")), { code: "ENOENT" });
  } finally {
    child.kill("SIGKILL");
  }
});

test("a competing caller reservation prevents launching a second run", async () => {
  const f = await fixture();
  await writeFile(`${f.path}.lock`, "another invocation owns this path\n");
  const r = await run(f);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EEXIST/);
  assert.equal(await readFile(`${f.path}.lock`, "utf8"), "another invocation owns this path\n");
  await assert.rejects(stat(join(f.cwd, ".ralph")), { code: "ENOENT" });
});

test("terminal receipts include immutable profile provenance and required-output identity", async () => {
  const f = await fixture();
  const profile = join(f.root, "profile.json");
  await writeFile(join(f.root, "prompt.md"), "Inspect this fixture.");
  await writeFile(
    profile,
    JSON.stringify({ version: 1, name: "receipt-profile", prompts: ["prompt.md"], outputs: [{ path: "REPORT.json", format: "json" }] }),
  );
  await writeFile(join(f.cwd, "REPORT.json"), '{"verified":true}\n');
  const r = await run(f, ["--profile", profile]);
  assert.equal(r.code, 1);
  const receipt = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(receipt.profile.name, "receipt-profile");
  assert.match(receipt.profile.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.outputs, [
    { path: "REPORT.json", required: true, format: "json", sha256: createHash("sha256").update('{"verified":true}\n').digest("hex") },
  ]);
});

test("receipt mode cannot attest a positional task while executing an internal prepared task", async () => {
  const f = await fixture();
  const prepared = join(f.root, "prepared.json");
  const plan = await exec("node", [cli, "plan", "A different task"], { cwd: f.cwd });
  await writeFile(prepared, plan.stdout);
  await assert.rejects(
    exec("node", [cli, "run", f.target, "--runner", "dry-run", "--result-file", f.path, "--invocation-id", "wrong-input"], {
      cwd: f.cwd,
      env: { ...process.env, RALPHWORKS_PREPARED_TASK: prepared },
    }),
    (error: unknown) => {
      assert.match(String((error as { stderr: string }).stderr), /receipt.*prepared|prepared.*receipt/i);
      return true;
    },
  );
  await assert.rejects(stat(join(f.cwd, ".ralph")), { code: "ENOENT" });
  await assert.rejects(stat(f.path), { code: "ENOENT" });
});

test("rejected output paths and oversized files retain terminal evidence without out-of-scope digests", async () => {
  for (const kind of ["oversize", "outside", "not-directory"]) {
    const f = await fixture();
    await writeFile(join(f.root, "prompt.md"), "Inspect this fixture.");
    const profile = join(f.root, "profile.json");
    await writeFile(
      profile,
      JSON.stringify({ version: 1, name: "bounded-output", prompts: ["prompt.md"], outputs: [{ path: "reports/result.txt" }] }),
    );
    if (kind === "outside") {
      const external = join(f.root, "external");
      await mkdir(external);
      await writeFile(join(external, "result.txt"), "outside the workspace");
      await symlink(external, join(f.cwd, "reports"));
    } else if (kind === "not-directory") {
      await writeFile(join(f.cwd, "reports"), "not a directory");
    } else {
      await mkdir(join(f.cwd, "reports"));
      await writeFile(join(f.cwd, "reports/result.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
    }
    const r = await run(f, ["--profile", profile]);
    assert.equal(r.code, 1);
    const receipt = JSON.parse(await readFile(f.path, "utf8"));
    assert.equal(receipt.outputs[0].sha256, null);
    if (kind === "oversize") {
      assert.ok(
        receipt.result.checks.some(
          (c: { command: string; exitCode: number }) => c.command === "output: reports/result.txt" && c.exitCode === 1,
        ),
      );
    } else {
      assert.equal(receipt.result.status, "blocked");
      assert.equal(receipt.result.iterations, 0);
      assert.match(receipt.result.reason, /Unsafe output path/);
      assert.deepEqual(receipt.result.checks, []);
    }
  }
});

test("a completed checked run binds its final required output without changing the result", async () => {
  const f = await fixture();
  const profile = join(f.root, "profile.json");
  await writeFile(join(f.root, "prompt.md"), "Write the required report.");
  await writeFile(
    profile,
    JSON.stringify({ version: 1, name: "completed-output", prompts: ["prompt.md"], outputs: [{ path: "REPORT.json", format: "json" }] }),
  );
  const task = await resolveTask(f.target, { cwd: f.cwd, profile });
  const receipt = await reserveRunReceipt(f.path, "complete-123", f.target, f.cwd);
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout.trim();
  try {
    const result = await runLocalJob(f.target, {
      cwd: f.cwd,
      preparedTask: task,
      runner: {
        async runIteration() {
          await writeFile(join(f.cwd, "REPORT.json"), '{"verified":true}');
          return { status: "complete", summary: "The checked fixture is complete." };
        },
      },
    });
    assert.equal(result.status, "completed");
    await receipt.publish({ cwd: f.cwd, baseHead: head, head, task, result });
    const actual = JSON.parse(await readFile(f.path, "utf8"));
    assert.deepEqual(actual.result, result);
    assert.equal(actual.outputs[0].sha256, createHash("sha256").update('{"verified":true}').digest("hex"));
    assert.equal(actual.result.checks.length, 2);
    assert.ok(actual.result.checks.every((c: { exitCode: number }) => c.exitCode === 0));
  } finally {
    await receipt.close();
  }
});
