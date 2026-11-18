import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runLocalJob } from "../src/orchestrator.ts";
import { resolveTask } from "../src/resolved-task.ts";
import { withRunLock } from "../src/run-lock.ts";
import { reserveRunReceipt } from "../src/run-receipt.ts";
import { prepareWorkspace } from "../src/workspace.ts";
import { cleanupWorkspace, reconcileWorkspaces, saveWorkspace } from "../src/workspace-lifecycle.ts";
import { workspaceIsUnused } from "../src/workspace-use.ts";

const cli = resolve("src/cli.ts");
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ralph-owned-lifecycle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  execFileSync("git", ["init", "-q", source]);
  await writeFile(join(source, "file.txt"), "baseline\n");
  await writeFile(join(source, ".gitignore"), ".ralph/\nnode_modules/\nprivate.txt\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline");
  return { root, source, target: join(root, "task") };
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function invoke(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 15_000 });
}
function field(text: string, name: string) {
  const value = new RegExp(`^${name}=(.+)$`, "m").exec(text)?.[1];
  assert.ok(value, `missing ${name}: ${text}`);
  return value;
}

test("owned host terminal runs remove the checkout while preserving external state and receipt", async (t) => {
  const { root, source, target } = await fixture(t);
  const receipt = join(root, "receipt.json");
  const result = invoke(source, [
    "run",
    "Inspect",
    "--workspace",
    "worktree",
    "--worktree-path",
    target,
    "--runner",
    "dry-run",
    "--max-iterations",
    "1",
    "--result-file",
    receipt,
    "--invocation-id",
    "cleanup-test",
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(target), false, "terminal owned checkout should be removed");
  const data = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(data.result.status, "max_iterations");
  assert.equal(data.workspace.path, target);
  assert.ok(existsSync(data.result.resultPath));
  assert.equal(data.result.resultPath.startsWith(`${target}/`), false);
  assert.equal(field(result.stdout, "cleanup"), "removed");
  assert.ok(existsSync(join(field(result.stdout, "recovery"), "manifest.json")));
  assert.equal(await readFile(join(source, "file.txt"), "utf8"), "baseline\n");
});

test("keep-worktree is explicit and current workspaces remain untouched", async (t) => {
  const { source, target } = await fixture(t);
  const kept = invoke(source, [
    "run",
    "Inspect",
    "--workspace",
    "worktree",
    "--worktree-path",
    target,
    "--keep-worktree",
    "--runner",
    "dry-run",
    "--max-iterations",
    "1",
  ]);
  assert.equal(kept.status, 1, kept.stderr);
  assert.ok(existsSync(target), kept.stderr);
  assert.equal(field(kept.stdout, "cleanup"), "retained");
  const current = invoke(source, ["run", "Inspect", "--runner", "dry-run", "--max-iterations", "1"]);
  assert.equal(current.status, 1, current.stderr);
  assert.ok(existsSync(source));
  assert.equal(current.stdout.includes("cleanup="), false);
});

test("workspace inventory and prune preview do not create state", async (t) => {
  const { source } = await fixture(t);
  for (const args of [
    ["workspaces", "list"],
    ["workspaces", "prune", "--dry-run"],
  ]) {
    const result = invoke(source, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(source, ".ralph")), false);
  }
});

test("recovery restores distinct binary index/worktree edits and preserves unique commits and private assets", async (t) => {
  const { root, source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  await writeFile(join(target, "committed.txt"), "unique commit");
  git(target, "add", "committed.txt");
  git(target, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "unique");
  const head = git(target, "rev-parse", "HEAD");
  const staged = Buffer.from([0, 255, 1, 128]);
  const working = Buffer.from([0, 254, 2, 129]);
  await writeFile(join(target, "binary.bin"), staged);
  git(target, "add", "binary.bin");
  await writeFile(join(target, "binary.bin"), working);
  await writeFile(join(target, "private.txt"), "private evidence", { mode: 0o600 });
  await writeFile(join(root, "external.txt"), "not an archived symlink target");
  await symlink(join(root, "external.txt"), join(target, "outside-link"));
  await mkdir(join(target, "node_modules"));
  await writeFile(join(target, "node_modules", "reproducible"), "ignored dependency");
  owned.phase = "quiescent";
  owned.head = head;
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
  const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
  assert.equal(git(source, "rev-parse", manifest.recoveryRef), head);
  assert.deepEqual(manifest.excluded, ["node_modules"]);
  const privateFile = manifest.files.find((file: { path: string }) => file.path === "private.txt");
  assert.equal(privateFile.mode, 0o600);
  assert.equal(await readFile(join(owned.archivePath, "files", privateFile.sha256), "utf8"), "private evidence");
  assert.equal(manifest.files.find((file: { path: string }) => file.path === "outside-link").target, join(root, "external.txt"));
  const restored = join(root, "restored");
  git(source, "worktree", "add", "--detach", restored, manifest.recoveryRef);
  git(restored, "apply", "--index", join(owned.archivePath, "staged.patch"));
  git(restored, "apply", join(owned.archivePath, "unstaged.patch"));
  assert.deepEqual(execFileSync("git", ["show", ":binary.bin"], { cwd: restored }), staged);
  assert.deepEqual(await readFile(join(restored, "binary.bin")), working);
  assert.equal(await readFile(join(restored, "committed.txt"), "utf8"), "unique commit");
});

test("archive failure retains dirty work and crash replay only trusts quiescent phases", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  await writeFile(join(target, "file.txt"), "recoverable edit");
  owned.owner.pid = 99999999;
  await saveWorkspace(owned);
  assert.match((await reconcileWorkspaces(source, undefined, true))[0].reason ?? "", /in-flight/);
  owned.head = git(target, "rev-parse", "HEAD");
  owned.phase = "quiescent";
  await writeFile(owned.archivePath, "invalid archive destination");
  await saveWorkspace(owned);
  const failed = await reconcileWorkspaces(source, undefined, true);
  assert.equal(failed[0].cleanup, "retained");
  assert.equal(await readFile(join(target, "file.txt"), "utf8"), "recoverable edit");
  await rm(owned.archivePath);
  assert.equal((await reconcileWorkspaces(source, undefined, true))[0].cleanup, "removed");
  const saved = JSON.parse(await readFile(owned.recordPath, "utf8"));
  saved.phase = "archived";
  await saveWorkspace(saved);
  assert.equal((await reconcileWorkspaces(source, undefined, true))[0].cleanup, "removed");
  assert.equal(existsSync(target), false);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`hidden tracked edits with ${flag} remain recoverable in the retained workspace`, async (t) => {
    const { source, target } = await fixture(t);
    const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
    assert.ok(owned);
    git(target, "update-index", flag, "file.txt");
    await writeFile(join(target, "file.txt"), "hidden edit");
    assert.equal(git(target, "diff", "HEAD"), "");
    owned.phase = "quiescent";
    owned.head = git(target, "rev-parse", "HEAD");
    const result = await withRunLock(target, () => cleanupWorkspace(owned));
    assert.equal(result.cleanup, "retained");
    assert.match(result.reason ?? "", /index flags/);
    assert.equal(await readFile(join(target, "file.txt"), "utf8"), "hidden edit");
  });
}

test("ignored coverage diagnostics survive automatic recovery", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  await writeFile(join(target, ".gitignore"), ".ralph/\ncoverage/\n");
  await mkdir(join(target, "coverage"));
  await writeFile(join(target, "coverage", "summary.json"), '{"lines":81}');
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
  const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
  const report = manifest.files.find((file: { path: string }) => file.path === "coverage/summary.json");
  assert.ok(report, "coverage diagnostics must be captured");
  assert.equal(await readFile(join(owned.archivePath, "files", report.sha256), "utf8"), '{"lines":81}');
});

test("an escaped detached child using the workspace prevents removal", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  const parent = spawnSync(
    process.execPath,
    [
      "-e",
      "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore'});console.log(child.pid);child.unref();",
    ],
    { cwd: target, encoding: "utf8" },
  );
  assert.equal(parent.status, 0, parent.stderr);
  const pid = Number(parent.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  try {
    owned.phase = "quiescent";
    owned.head = git(target, "rev-parse", "HEAD");
    const result = await withRunLock(target, () => cleanupWorkspace(owned));
    assert.equal(result.cleanup, "retained", "a new process group still has cwd in the owned worktree");
    assert.match(result.reason ?? "", /workspace.*use|process reference/i);
    assert.ok(existsSync(target));
  } finally {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* The test-owned child may already have exited. */
    }
  }
});

for (const expected of [
  "completed",
  "blocked",
  "needs_input",
  "cancelled",
  "max_iterations",
  "timed_out",
  "budget_exhausted",
  "failed",
] as const) {
  test(`${expected} persists its original result and receipt before lock-held removal`, async (t) => {
    const { root, source, target } = await fixture(t);
    const workspace = await prepareWorkspace(source, { kind: "worktree", path: target });
    const owned = workspace.owned;
    assert.ok(owned);
    const task = await resolveTask("Inspect", {
      cwd: target,
      jobOverrides: { maxIterations: 1, maxMinutes: expected === "timed_out" ? 0 : 1, maxCostUsd: 1 },
    });
    const receiptPath = join(root, "receipt.json");
    const receipt = await reserveRunReceipt(receiptPath, "terminal-control", "Inspect", source);
    const controller = new AbortController();
    if (expected === "cancelled") controller.abort("SIGINT");
    try {
      const result = await runLocalJob("Inspect", {
        cwd: target,
        stateDir: workspace.stateDir,
        preparedTask: task,
        signal: controller.signal,
        runner: {
          async runIteration() {
            if (expected === "failed") throw new Error("controlled runner failure");
            return {
              status:
                expected === "blocked" || expected === "needs_input" ? expected : expected === "max_iterations" ? "continue" : "complete",
              summary: "Terminal control",
              costUsd: expected === "budget_exhausted" ? 2 : 0,
            };
          },
        },
        finalize: async (terminal) => {
          assert.ok(terminal);
          assert.ok(existsSync(join(target, ".ralph", "run.lock", "owner")));
          assert.equal(JSON.parse(await readFile(terminal.resultPath, "utf8")).status, expected);
          await receipt.publish({ cwd: target, baseHead: owned.baseHead, head: git(target, "rev-parse", "HEAD"), task, result: terminal });
          owned.phase = "quiescent";
          owned.head = git(target, "rev-parse", "HEAD");
          const cleanup = await cleanupWorkspace(owned);
          assert.equal(cleanup.cleanup, "removed", cleanup.reason);
        },
      });
      assert.equal(result.status, expected);
      assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).result.status, expected);
      assert.ok(existsSync(result.resultPath));
      assert.equal(existsSync(target), false);
    } finally {
      await receipt.close();
    }
  });
}

test("preparation failure finalizes inside the lock without inventing a run result", async (t) => {
  const { source, target } = await fixture(t);
  const workspace = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(workspace.owned);
  const owned = workspace.owned;
  await assert.rejects(
    runLocalJob("Inspect", {
      cwd: target,
      stateDir: workspace.stateDir,
      prepareTask: async () => {
        throw new Error("preparation refused");
      },
      finalize: async (result) => {
        assert.equal(result, undefined);
        assert.ok(existsSync(join(target, ".ralph", "run.lock", "owner")));
        owned.phase = "quiescent";
        owned.head = git(target, "rev-parse", "HEAD");
        assert.equal((await cleanupWorkspace(owned)).cleanup, "removed");
      },
    }),
    /preparation refused/,
  );
  assert.equal(existsSync(target), false);
});

test("receipt publication failure retains the worktree and the preexisting receipt bytes", async (t) => {
  const { root, source, target } = await fixture(t);
  const receipt = join(root, "receipt.json");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(receipt)},'occupied')`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const result = invoke(source, [
    "run",
    "Inspect",
    "--runner",
    "dry-run",
    "--max-iterations",
    "1",
    "--workspace",
    "worktree",
    "--worktree-path",
    target,
    "--result-file",
    receipt,
    "--invocation-id",
    "publication-control",
    "--check",
    `${quote(process.execPath)} -e ${quote(script)}`,
  ]);
  assert.equal(result.status, 1);
  assert.equal(field(result.stdout, "cleanup"), "retained");
  assert.ok(existsSync(target));
  assert.equal(await readFile(receipt, "utf8"), "occupied");
});

test("changed branch, live owner, Docker and foreign identity are retained", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  await saveWorkspace(owned);
  assert.match((await reconcileWorkspaces(source, undefined, true))[0].reason ?? "", /owner is live/);
  const docker = await withRunLock(target, () => cleanupWorkspace({ ...owned, executor: "docker" }));
  assert.equal(docker.cleanup, "retained");
  assert.match(docker.reason ?? "", /Docker/);
  git(target, "checkout", "-qb", "user-branch");
  const changed = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(changed.cleanup, "retained");
  assert.match(changed.reason ?? "", /Git identity/);
  const foreign = await cleanupWorkspace({ ...owned, cwd: source });
  assert.equal(foreign.cleanup, "retained");
  assert.equal(await readFile(join(source, "file.txt"), "utf8"), "baseline\n");
  assert.ok(existsSync(target));
});

test("archive byte cap retains oversized evidence before removal", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  const file = await open(join(target, "oversized.trace"), "w");
  await file.truncate(33 * 1024 * 1024);
  await file.close();
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "retained");
  assert.match(result.reason ?? "", /byte limit/);
  assert.ok(existsSync(join(target, "oversized.trace")));
});

test("clean tracked files do not consume archive capture limits", async (t) => {
  const { source, target } = await fixture(t);
  const file = await open(join(source, "asset.bin"), "w");
  await file.truncate(33 * 1024 * 1024);
  await file.close();
  git(source, "add", "asset.bin");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "asset");
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
  const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
  assert.equal(manifest.files.length, 0);
  assert.match(manifest.trackedSha256, /^[a-f0-9]{64}$/);
});

test("workspace-use proof rejects unavailable, malformed, failed and path-matching probes", async (t) => {
  const { root } = await fixture(t);
  const tool = join(root, "lsof");
  const originalPath = process.env.PATH;
  const workspace = join(root, "owned");
  try {
    process.env.PATH = root;
    assert.equal(await workspaceIsUnused(workspace), false);
    for (const [output, expected] of [
      ["printf '%s\\0' p123 n/foreign; printf '\\n'", true],
      [`printf '%s\\0' p123 n${workspace}-neighbor/file; printf '\\n'`, true],
      [`printf '%s\\0' p123 n${workspace}/file; printf '\\n'`, false],
      ["printf malformed", false],
      ["printf '%s\\0' p123 n/foreign; printf '\\n'; printf warning >&2", false],
      ["exit 1", false],
    ] as const) {
      await writeFile(tool, `#!/bin/sh\n${output}\n`);
      await chmod(tool, 0o700);
      assert.equal(await workspaceIsUnused(workspace), expected);
    }
  } finally {
    process.env.PATH = originalPath;
  }
});

test("public reconciliation retries normal terminal cleanup after an escaped child exits", async (t) => {
  const { root, source, target } = await fixture(t);
  const pidFile = join(root, "child-pid");
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const run = invoke(source, [
    "run",
    "Inspect",
    "--runner",
    "dry-run",
    "--max-iterations",
    "1",
    "--workspace",
    "worktree",
    "--worktree-path",
    target,
    "--check",
    `${quote(process.execPath)} -e ${quote(script)}`,
  ]);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  try {
    assert.equal(run.status, 1, run.stderr);
    assert.equal(field(run.stdout, "cleanup"), "retained");
    assert.equal(JSON.parse(await readFile(field(run.stdout, "workspaceRecord"), "utf8")).phase, "terminal");
    assert.equal((await reconcileWorkspaces(source, undefined, true))[0].cleanup, "retained");
    process.kill(pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retried = await reconcileWorkspaces(source, undefined, true);
    assert.equal(retried[0].cleanup, "removed", retried[0].reason);
    assert.equal(existsSync(target), false);
  } finally {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already exited test child. */
    }
  }
});

test("large clean inventories do not consume the recovery entry cap", async (t) => {
  const { source, target } = await fixture(t);
  const directory = join(source, "tracked");
  await mkdir(directory);
  for (let start = 0; start < 4100; start += 100)
    await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(join(directory, `${start + offset}.txt`), "tracked\n")));
  git(source, "add", "tracked");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "inventory");
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
});

test("excess additional-file metadata retains the workspace within archive limits", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  const directory = join(target, "evidence");
  await mkdir(directory);
  for (let start = 0; start < 4100; start += 100)
    await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(join(directory, `${start + offset}.txt`), "evidence\n")));
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "retained");
  assert.match(result.reason ?? "", /metadata|entry limit/);
  assert.ok(existsSync(join(directory, "4099.txt")));
});

test("ignored diagnostic data below the byte cap is preserved", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  await writeFile(join(target, ".gitignore"), ".ralph/\nplaywright-report/\n");
  await mkdir(join(target, "playwright-report"));
  const file = await open(join(target, "playwright-report", "trace.zip"), "w");
  await file.truncate(21 * 1024 * 1024);
  await file.close();
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
  const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
  assert.ok(manifest.files.find((entry: { path: string }) => entry.path === "playwright-report/trace.zip"));
});

test("owned state and receipt paths inside the removable tree are rejected before creation", async (t) => {
  const { source, target } = await fixture(t);
  const plan = invoke(source, [
    "plan",
    "Inspect",
    "--workspace",
    "worktree",
    "--worktree-path",
    target,
    "--state-dir",
    join(target, ".ralph"),
  ]);
  assert.equal(plan.status, 1);
  assert.match(plan.stderr, /outside the owned workspace/);
  const run = invoke(source, [
    "run",
    "Inspect",
    "--workspace",
    "worktree",
    "--worktree-path",
    target,
    "--result-file",
    join(target, "receipt.json"),
    "--invocation-id",
    "inside",
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /outside the owned workspace/);
  assert.equal(existsSync(target), false);
});

test("workspace-use proof treats timeout and truncated output as unknown", async (t) => {
  const { root } = await fixture(t);
  const tool = join(root, "lsof");
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = root;
    await writeFile(tool, `#!/bin/sh\nexec '${process.execPath}' -e "process.stdout.write('x'.repeat(5*1024*1024))"\n`);
    await chmod(tool, 0o700);
    assert.equal(await workspaceIsUnused(join(root, "owned")), false);
    await writeFile(tool, `#!/bin/sh\nexec '${process.execPath}' -e "setTimeout(()=>{},10000)"\n`);
    assert.equal(await workspaceIsUnused(join(root, "owned")), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("normalized required-output and custom-progress paths preserve ignored directories", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, {
    kind: "worktree",
    path: target,
    preservePaths: ["./dist/report.json", "./build/../build/progress.md"],
  });
  assert.ok(owned);
  await writeFile(join(target, ".gitignore"), ".ralph/\ndist/\nbuild/\n");
  await mkdir(join(target, "dist"));
  await mkdir(join(target, "build"));
  await writeFile(join(target, "dist", "report.json"), '{"done":true}');
  await writeFile(join(target, "build", "progress.md"), "recover progress");
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
  const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
  assert.ok(manifest.files.some((entry: { path: string }) => entry.path === "dist/report.json"));
  assert.ok(manifest.files.some((entry: { path: string }) => entry.path === "build/progress.md"));
});

test("core.filemode=false does not hide a tracked executable mode change from recovery", async (t) => {
  const { source, target } = await fixture(t);
  const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
  assert.ok(owned);
  git(target, "config", "core.filemode", "false");
  await chmod(join(target, "file.txt"), 0o755);
  assert.equal(git(target, "diff", "HEAD"), "");
  owned.phase = "quiescent";
  owned.head = git(target, "rev-parse", "HEAD");
  const result = await withRunLock(target, () => cleanupWorkspace(owned));
  assert.equal(result.cleanup, "removed", result.reason);
  const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
  assert.equal(manifest.modes.find((entry: { path: string }) => entry.path === "file.txt")?.mode, 0o755);
});

for (const normalization of ["crlf", "filter"] as const) {
  test(`${normalization} normalization cannot hide raw tracked bytes from recovery`, async (t) => {
    const { source, target } = await fixture(t);
    await writeFile(join(source, ".gitattributes"), normalization === "crlf" ? "file.txt text eol=lf\n" : "file.txt filter=collapse\n");
    if (normalization === "filter") git(source, "config", "filter.collapse.clean", "cat >/dev/null; printf 'baseline\\n'");
    git(source, "add", ".gitattributes");
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "attributes");
    const { owned } = await prepareWorkspace(source, { kind: "worktree", path: target });
    assert.ok(owned);
    const bytes = normalization === "crlf" ? Buffer.from("baseline\r\n") : Buffer.from("substantive private working bytes\n");
    await writeFile(join(target, "file.txt"), bytes);
    assert.equal(git(target, "diff", "HEAD"), "");
    owned.phase = "quiescent";
    owned.head = git(target, "rev-parse", "HEAD");
    const result = await withRunLock(target, () => cleanupWorkspace(owned));
    assert.equal(result.cleanup, "removed", result.reason);
    const manifest = JSON.parse(await readFile(join(owned.archivePath, "manifest.json"), "utf8"));
    const overlay = manifest.files.find((entry: { path: string }) => entry.path === "file.txt");
    assert.ok(overlay, "raw working bytes require a recoverable overlay despite an empty Git diff");
    assert.deepEqual(await readFile(join(owned.archivePath, "files", overlay.sha256)), bytes);
  });
}
