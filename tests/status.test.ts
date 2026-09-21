import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRunStatus } from "../src/status.ts";

test("readRunStatus reads the compact run summary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-status-"));
  const runDir = join(workspace, ".ralph", "runs", "sample-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "result.json"),
    JSON.stringify(
      {
        jobName: "sample-job",
        status: "completed",
        iterations: 2,
        runDir,
        eventsPath: join(runDir, "events.jsonl"),
        resultPath: join(runDir, "result.json"),
        checks: [{ iteration: 2, command: "pnpm test", exitCode: 0, stdout: "", stderr: "" }],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const status = await readRunStatus(runDir);

  assert.equal(status.jobName, "sample-job");
  assert.equal(status.status, "completed");
  assert.equal(status.iterations, 2);
  assert.equal(status.checks.total, 1);
  assert.equal(status.checks.failed, 0);
});

test("readRunStatus keeps historical failure counts without presenting a completed run as failed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-status-"));
  await writeFile(
    join(workspace, "result.json"),
    JSON.stringify({
      jobName: "recovered-job",
      status: "completed",
      iterations: 2,
      runDir: workspace,
      checks: [
        { command: "./check.sh", exitCode: 17, stderr: "first check failed" },
        { command: "./check.sh", exitCode: 0 },
      ],
    }),
  );
  const status = await readRunStatus(workspace);
  assert.equal(status.checks.failed, 1);
  assert.equal(status.failedCheck, undefined);
});

test("readRunStatus follows a current run pointer file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-status-"));
  const runDir = join(workspace, ".ralph", "runs", "sample-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(workspace, ".ralph", "current"), runDir + "\n", "utf8");
  await writeFile(
    join(runDir, "result.json"),
    JSON.stringify(
      {
        jobName: "pointer-job",
        status: "max_iterations",
        iterations: 5,
        runDir,
        eventsPath: join(runDir, "events.jsonl"),
        resultPath: join(runDir, "result.json"),
        checks: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const status = await readRunStatus(join(workspace, ".ralph", "current"));

  assert.equal(status.jobName, "pointer-job");
  assert.equal(status.status, "max_iterations");
  assert.equal(status.runDir, runDir);
});

test("readRunStatus resolves a relative pointer from the state directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-status-"));
  const runDir = join(workspace, ".ralph", "runs", "sample-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(workspace, ".ralph", "current"), "runs/sample-run\n");
  await writeFile(join(runDir, "result.json"), JSON.stringify({ jobName: "portable", status: "completed", iterations: 1, runDir }));
  assert.equal((await readRunStatus(join(workspace, ".ralph", "current"))).jobName, "portable");
});

test("readRunStatus exposes a bounded failure summary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-status-"));
  await writeFile(
    join(workspace, "result.json"),
    JSON.stringify({
      jobName: "failed-job",
      status: "max_iterations",
      iterations: 3,
      runDir: workspace,
      reason: "iteration limit reached",
      checks: [{ command: "pnpm test", exitCode: 1, stderr: "assertion failed" }],
    }),
  );
  const status = await readRunStatus(workspace);
  assert.equal(status.reason, "iteration limit reached");
  assert.deepEqual(status.failedCheck, { command: "pnpm test", exitCode: 1, detail: "assertion failed" });
});
