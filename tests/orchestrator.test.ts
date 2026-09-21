import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseJob } from "../src/job.ts";
import { runLocalJob } from "../src/orchestrator.ts";

test("runLocalJob creates Ralph state and records dry-run iterations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  const jobPath = join(workspace, "job.yaml");
  await writeFile(
    jobPath,
    ["name: test-job", "task: Implement the next small task.", "completion_promise: DONE", "max_iterations: 2", "mode: local", ""].join(
      "\n",
    ),
    "utf8",
  );

  const result = await runLocalJob(jobPath, { cwd: workspace });

  assert.equal(result.status, "max_iterations");
  assert.equal(result.iterations, 2);
  assert.match(result.runDir, /\.ralph\/runs\/test-job-/);

  const progressFile = parseJob(await readFile(jobPath, "utf8")).progressFile;
  const progress = await readFile(join(workspace, progressFile), "utf8");
  assert.match(progress, /RalphWorks Progress/);
  assert.match(progress, /test-job/);

  const resultJson = JSON.parse(await readFile(join(result.runDir, "result.json"), "utf8"));
  assert.equal(resultJson.status, "max_iterations");
  assert.equal(resultJson.iterations, 2);

  const eventLines = (await readFile(join(result.runDir, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(eventLines.length, 5);
  assert.deepEqual(
    eventLines.map((line) => JSON.parse(line).type),
    ["run_started", "iteration_started", "iteration_finished", "iteration_started", "iteration_finished"],
  );
});

test("runLocalJob persists runner events between iteration boundaries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  const jobPath = join(workspace, "job.yaml");
  await writeFile(
    jobPath,
    ["name: event-job", "task: Record runner events.", "completion_promise: DONE", "max_iterations: 1", "mode: local", ""].join("\n"),
    "utf8",
  );

  const result = await runLocalJob(jobPath, {
    cwd: workspace,
    runner: {
      async runIteration() {
        return {
          status: "continue",
          summary: "fake runner finished",
          events: [{ type: "fake_event", details: { value: 42 } }],
        };
      },
    },
  });

  const events = (await readFile(join(result.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    events.map((event) => event.type),
    ["run_started", "iteration_started", "fake_event", "iteration_finished"],
  );
  assert.deepEqual(events[2].details, { value: 42 });
});

test("runLocalJob executes configured checks after each iteration", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  const jobPath = join(workspace, "job.yaml");
  await writeFile(
    jobPath,
    [
      "name: check-job",
      "task: Run checks after work.",
      "completion_promise: DONE",
      "max_iterations: 1",
      "mode: local",
      "checks:",
      "  - node -e \"require('node:fs').writeFileSync('check-output.txt', 'ok')\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runLocalJob(jobPath, {
    cwd: workspace,
    runner: {
      async runIteration() {
        return {
          status: "continue",
          summary: "fake runner finished",
        };
      },
    },
  });

  assert.equal(await readFile(join(workspace, "check-output.txt"), "utf8"), "ok");

  const events = (await readFile(join(result.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.type),
    ["run_started", "iteration_started", "check_started", "check_finished", "iteration_finished"],
  );
  assert.equal(events[2].details.command, "node -e \"require('node:fs').writeFileSync('check-output.txt', 'ok')\"");
  assert.equal(events[3].details.exitCode, 0);

  const resultJson = JSON.parse(await readFile(join(result.runDir, "result.json"), "utf8"));
  assert.deepEqual(resultJson.checks, [
    {
      iteration: 1,
      command: "node -e \"require('node:fs').writeFileSync('check-output.txt', 'ok')\"",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  ]);
});

test("runLocalJob completes when runner output satisfies the completion promise", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  const jobPath = join(workspace, "job.yaml");
  await writeFile(
    jobPath,
    [
      "name: promise-job",
      "task: Finish when the promise is emitted.",
      "completion_promise: DONE",
      "max_iterations: 5",
      "mode: local",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runLocalJob(jobPath, {
    cwd: workspace,
    runner: {
      async runIteration() {
        return {
          status: "continue",
          summary: "fake runner emitted completion text",
          output: "All checks passed. <promise>DONE</promise>",
        };
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 1);

  const resultJson = JSON.parse(await readFile(join(result.runDir, "result.json"), "utf8"));
  assert.equal(resultJson.status, "completed");
  assert.equal(resultJson.iterations, 1);

  const events = (await readFile(join(result.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "iteration_finished");
  assert.equal(events.at(-1).status, "complete");
});

test("runLocalJob appends context files and directories and applies CLI overrides", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  await writeFile(join(workspace, "spec.md"), "Required behavior", "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(workspace, "context")));
  await writeFile(join(workspace, "context", "api.txt"), "API contract", "utf8");
  let task = "";
  const result = await runLocalJob("Implement it", {
    cwd: workspace,
    contexts: ["spec.md", "context"],
    jobOverrides: { maxIterations: 1, completionPromise: "FINISHED" },
    runner: {
      async runIteration(input) {
        task = input.job.task;
        return { status: "continue", summary: "done", output: "<promise>FINISHED</promise>" };
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.match(task, /Required behavior/);
  assert.match(task, /API contract/);
});

test("different context produces separate default progress", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-context-progress-"));
  const context = join(workspace, "context.txt");
  await writeFile(context, "first version");
  let firstProgress = "";
  await runLocalJob("Build from context", {
    cwd: workspace,
    contexts: [context],
    runner: {
      async runIteration(input) {
        firstProgress = input.job.progressFile;
        return { status: "continue", summary: "one" };
      },
    },
    jobOverrides: { maxIterations: 1 },
  });
  await writeFile(context, "second version");
  let secondProgress = "";
  await runLocalJob("Build from context", {
    cwd: workspace,
    contexts: [context],
    runner: {
      async runIteration(input) {
        secondProgress = input.job.progressFile;
        return { status: "continue", summary: "two" };
      },
    },
    jobOverrides: { maxIterations: 1 },
  });
  assert.notEqual(firstProgress, secondProgress);
});

test("runLocalJob keeps iterating when the completion promise is emitted but checks fail", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  const jobPath = join(workspace, "job.yaml");
  await writeFile(
    jobPath,
    [
      "name: gated-promise-job",
      "task: Do not complete until checks pass.",
      "completion_promise: DONE",
      "max_iterations: 2",
      "mode: local",
      "checks:",
      '  - node -e "process.exit(7)"',
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runLocalJob(jobPath, {
    cwd: workspace,
    runner: {
      async runIteration() {
        return {
          status: "continue",
          summary: "fake runner emitted completion text",
          output: "<promise>DONE</promise>",
        };
      },
    },
  });

  assert.equal(result.status, "max_iterations");
  assert.equal(result.iterations, 2);

  const events = (await readFile(join(result.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "check_finished").length, 2);
  assert.deepEqual(
    events.filter((event) => event.type === "check_finished").map((event) => event.details.exitCode),
    [7, 7],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "iteration_finished").map((event) => event.status),
    ["continue", "continue"],
  );
});

test("runLocalJob records the latest local run pointer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-"));
  const jobPath = join(workspace, "job.yaml");
  await writeFile(
    jobPath,
    ["name: pointer-job", "task: Record current pointer.", "max_iterations: 1", "mode: local", ""].join("\n"),
    "utf8",
  );

  const result = await runLocalJob(jobPath, { cwd: workspace });
  const current = await readFile(join(workspace, ".ralph", "current"), "utf8");

  assert.equal(join(workspace, ".ralph", current.trim()), result.runDir);
});
