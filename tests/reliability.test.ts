import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseJob } from "../src/job.ts";
import { readProgressForPrompt, runLocalJob } from "../src/orchestrator.ts";

const execFileAsync = promisify(execFile);

async function fixture(lines: string[]): Promise<{ cwd: string; jobPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-reliable-"));
  const jobPath = join(cwd, "job.yaml");
  await writeFile(jobPath, ["name: reliable-job", "task: Complete one task.", "completion_promise: DONE", ...lines, ""].join("\n"));
  return { cwd, jobPath };
}

test("an agent run can complete without external checks", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "done", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(result.status, "completed");
});

test("iteration limit includes the last handoff", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "Next: finish the export test" };
      },
    },
  });
  assert.equal(result.status, "max_iterations");
  assert.equal(result.reason, "iteration limit reached after 1 iteration");
  assert.equal(result.lastSummary, "Next: finish the export test");
});

test("each iteration receives durable progress from the previous iteration", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 2", "checks:", '  - node -e "process.exit(0)"']);
  const seen: string[] = [];
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration(input) {
        seen.push(input.progress);
        return { status: "continue", summary: `step ${input.iteration}`, output: input.iteration === 2 ? "<promise>DONE</promise>" : "" };
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.doesNotMatch(seen[0], /step 1/);
  assert.match(seen[1], /step 1/);
  const progressFile = parseJob(await readFile(jobPath, "utf8")).progressFile;
  assert.match(await readFile(join(cwd, progressFile), "utf8"), /step 2/);
});

test("long progress keeps full history on disk but bounds model context", async () => {
  const { cwd } = await fixture([]);
  const path = join(cwd, "progress.md");
  const full = `# Progress\n${"old decision\n".repeat(2000)}latest blocker: missing export\n`;
  await writeFile(path, full);
  const promptProgress = await readProgressForPrompt(path, 1000);
  assert.ok(promptProgress.length <= 1000);
  assert.match(promptProgress, /# Progress/);
  assert.match(promptProgress, /Older progress omitted/);
  assert.match(promptProgress, /latest blocker: missing export/);
  assert.equal(await readFile(path, "utf8"), full);
});

test("failed check output is available to the next iteration", async () => {
  const { cwd, jobPath } = await fixture([
    "max_iterations: 2",
    "checks:",
    "  - node -e \"process.stderr.write('missing expected export\\\\n'); process.exit(7)\"",
  ]);
  const seen: string[] = [];
  await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration(input) {
        seen.push(input.progress ?? "");
        return { status: "continue", summary: "working" };
      },
    },
  });
  assert.doesNotMatch(seen[0], /missing expected export/);
  assert.match(seen[1], /missing expected export/);
  assert.match(seen[1], /process\.stderr/);
});

test("a preparation error still writes a failed result", async () => {
  const { cwd, jobPath } = await fixture(["progress_file: blocked-progress"]);
  await mkdir(join(cwd, "blocked-progress"));
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        throw new Error("must not run");
      },
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /directory|EISDIR/i);
  assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, "failed");
  assert.equal((await readFile(join(cwd, ".ralph", "current"), "utf8")).trim(), `runs/${result.runDir.split("/").at(-1)}`);
});

test("a missing context file writes a failed result", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  const result = await runLocalJob(jobPath, { cwd, contexts: ["missing-context.md"] });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /ENOENT/);
  assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, "failed");
});

test("unattended defaults fill only missing time and cost budgets", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1", "max_minutes: 12"]);
  let limits: { maxMinutes?: number; maxCostUsd?: number } = {};
  await runLocalJob(jobPath, {
    cwd,
    unattended: true,
    runner: {
      async runIteration(input) {
        limits = { maxMinutes: input.job.maxMinutes, maxCostUsd: input.job.maxCostUsd };
        return { status: "continue", summary: "done", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.deepEqual(limits, { maxMinutes: 12, maxCostUsd: 3 });
  await runLocalJob(jobPath, {
    cwd,
    unattended: true,
    jobOverrides: { maxMinutes: 4, maxCostUsd: 1 },
    runner: {
      async runIteration(input) {
        limits = { maxMinutes: input.job.maxMinutes, maxCostUsd: input.job.maxCostUsd };
        return { status: "continue", summary: "done", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.deepEqual(limits, { maxMinutes: 4, maxCostUsd: 1 });
});

test("host runs have a default wall clock limit", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  let limit: number | undefined;
  await runLocalJob(jobPath, {
    cwd,
    unattended: false,
    runner: {
      async runIteration(input) {
        limit = input.job.maxMinutes;
        return { status: "continue", summary: "done", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(limit, 30);
});

test("verified runs resume after an interrupted worktree is reviewed and committed", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  await execFileAsync("git", ["-C", cwd, "init", "-q"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "RalphWorks Test"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(cwd, ".gitignore"), ".ralph/\n");
  await execFileAsync("git", ["-C", cwd, "add", ".gitignore", "job.yaml"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-qm", "test: initial task"]);
  await writeFile(join(cwd, "interrupted.txt"), "review me\n");

  const blocked = await runLocalJob(jobPath, {
    cwd,
    checksOverride: ["test -f final.txt"],
    jobOverrides: { commit: "verified" },
    runner: {
      async runIteration() {
        throw new Error("runner must not start on a dirty worktree");
      },
    },
  });
  assert.equal(blocked.status, "blocked");
  await execFileAsync("git", ["-C", cwd, "add", "interrupted.txt"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-qm", "test: review interrupted work"]);

  const resumed = await runLocalJob(jobPath, {
    cwd,
    checksOverride: ["test -f final.txt"],
    jobOverrides: { commit: "verified" },
    runner: {
      async runIteration() {
        await writeFile(join(cwd, "final.txt"), "done\n");
        return { status: "continue", summary: "finished", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.commits.length, 1);
  assert.equal((await execFileAsync("git", ["-C", cwd, "status", "--porcelain"])).stdout.trim(), "");
});

test("interrupting an iteration records cancellation and releases the lock", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  const interrupt = new AbortController();
  const running = runLocalJob(jobPath, {
    cwd,
    signal: interrupt.signal,
    runner: {
      async runIteration(input) {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "continue", summary: "stopped" };
      },
    },
  });
  setTimeout(() => interrupt.abort("SIGINT"), 50);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "run interrupted by SIGINT");
  assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, "cancelled");
  await assert.rejects(stat(join(cwd, ".ralph", "run.lock")), { code: "ENOENT" });
});

test("interrupting a check stops its descendants before releasing the lock", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1", "checks:", "  - sh -c 'touch check-started; sleep 0.3; touch late-marker'"]);
  const interrupt = new AbortController();
  const running = runLocalJob(jobPath, {
    cwd,
    signal: interrupt.signal,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "check now" };
      },
    },
  });
  let started = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    started = await stat(join(cwd, "check-started")).then(
      () => true,
      () => false,
    );
    if (started) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(started, true, "check did not start");
  interrupt.abort("SIGTERM");
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.checks[0]?.cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(stat(join(cwd, "late-marker")), { code: "ENOENT" });
  await assert.rejects(stat(join(cwd, ".ralph", "run.lock")), { code: "ENOENT" });
});

test("wall clock budget aborts a running iteration and persists timeout", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 2", "max_minutes: 0.001", "checks:", '  - node -e "process.exit(0)"']);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration(input) {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "continue", summary: "aborted" };
      },
    },
  });
  assert.equal(result.status, "timed_out");
  assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, "timed_out");
});

test("timeout keeps the workspace lock until the runner has stopped", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1", "max_minutes: 0.001", "checks:", '  - node -e "process.exit(0)"']);
  let runnerStopped = false;
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        await new Promise((resolve) => setTimeout(resolve, 180));
        await writeFile(join(cwd, "late.txt"), "late\n");
        runnerStopped = true;
        return { status: "continue", summary: "late" };
      },
    },
  });
  assert.equal(result.status, "timed_out");
  assert.equal(runnerStopped, true);
});

test("cost budget stops the loop after reported model spend", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 3", "max_cost_usd: 1", "checks:", '  - node -e "process.exit(0)"']);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "spent", costUsd: 1.5 };
      },
    },
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.iterations, 1);
  assert.equal(result.costUsd, 1.5);
});

test("a hanging check stops at its configured timeout", async () => {
  const { cwd, jobPath } = await fixture([
    "max_iterations: 2",
    "check_timeout_seconds: 0.05",
    "checks:",
    '  - node -e "setTimeout(() => {}, 2000)"',
  ]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "ready", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(result.status, "timed_out");
  assert.equal(result.checks[0]?.timedOut, true);
});

test("timed out checks stop descendant processes", async () => {
  const { cwd, jobPath } = await fixture([
    "max_iterations: 1",
    "check_timeout_seconds: 0.05",
    "checks:",
    "  - sh -c 'sleep 0.3; touch late-marker'",
  ]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "ready" };
      },
    },
  });
  assert.equal(result.status, "timed_out");
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(stat(join(cwd, "late-marker")), { code: "ENOENT" });
});

test("two unchanged Git iterations stop as no progress", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 5", "checks:", '  - node -e "process.exit(0)"']);
  await execFileAsync("git", ["init", "-q", cwd]);
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "Ralph Test"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.email", "ralph@example.test"]);
  await execFileAsync("git", ["-C", cwd, "add", "job.yaml"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        return { status: "continue", summary: "still thinking" };
      },
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.iterations, 2);
  assert.match(result.reason ?? "", /no workspace progress/);
});

test("a second run cannot mutate the same workspace concurrently", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1"]);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        started();
        await gate;
        return { status: "continue", summary: "first" };
      },
    },
  });
  await entered;
  await assert.rejects(runLocalJob(jobPath, { cwd }), /workspace is locked/);
  release();
  await first;
  const third = await runLocalJob(jobPath, { cwd });
  assert.equal(third.status, "max_iterations");
});

test("verified commits refuse dirty workspaces and commit only checked changes", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1", "commit: verified", "checks:", '  - node -e "process.exit(0)"']);
  await execFileAsync("git", ["init", "-q", cwd]);
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "Ralph Test"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.email", "ralph@example.test"]);
  await execFileAsync("git", ["-C", cwd, "add", "job.yaml"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  await writeFile(join(cwd, "user.txt"), "pre-existing\n");
  const blocked = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        throw Error("must not run");
      },
    },
  });
  assert.equal(blocked.status, "blocked");
  await execFileAsync("git", ["-C", cwd, "add", "user.txt"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-qm", "user baseline"]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        await writeFile(join(cwd, "feature.txt"), "new\n");
        return { status: "continue", summary: "implemented", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(result.status, "completed");
  const { stdout } = await execFileAsync("git", ["-C", cwd, "show", "--format=", "--name-only", "HEAD"]);
  assert.equal(stdout.trim(), "feature.txt");
  assert.equal(
    (await execFileAsync("git", ["-C", cwd, "show", "-s", "--format=%an <%ae>", "HEAD"])).stdout.trim(),
    "ralphworks[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  );
  assert.equal(
    (await execFileAsync("git", ["-C", cwd, "status", "--porcelain"])).stdout
      .trim()
      .split("\n")
      .every((line) => line.includes(".ralph/")),
    true,
  );
});

test("agent commits cannot bypass RalphWorks checks and commit policy", async () => {
  const { cwd, jobPath } = await fixture(["max_iterations: 1", "checks:", '  - node -e "process.exit(0)"']);
  await execFileAsync("git", ["init", "-q", cwd]);
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "Ralph Test"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.email", "ralph@example.test"]);
  await execFileAsync("git", ["-C", cwd, "add", "job.yaml"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  const result = await runLocalJob(jobPath, {
    cwd,
    runner: {
      async runIteration() {
        await writeFile(join(cwd, "feature.txt"), "new\n");
        await execFileAsync("git", ["-C", cwd, "add", "feature.txt"]);
        await execFileAsync("git", ["-C", cwd, "commit", "-qm", "agent bypass"]);
        return { status: "continue", summary: "committed", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /agent changed Git HEAD/);
  assert.equal(result.checks.length, 0);
});
