import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RalphJob } from "../src/job.ts";
import { runLocalJob } from "../src/orchestrator.ts";
import { PiProcessRunner } from "../src/pi-process-runner.ts";

const job: RalphJob = {
  name: "worker",
  task: "test",
  progressFile: ".ralph/progress.md",
  maxIterations: 1,
  mode: "local",
  checkTimeoutSeconds: 60,
  commit: "none",
  checks: [],
};

test("PiProcessRunner returns a worker result after the process exits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-worker-"));
  const workerPath = join(cwd, "worker.cjs");
  await writeFile(
    workerPath,
    'process.on("message", () => process.send({result:{status:"continue",summary:"done"}}, () => process.exit(0)));',
  );
  const result = await new PiProcessRunner({ workerPath }).runIteration({
    job,
    iteration: 1,
    cwd,
    progress: "",
    signal: new AbortController().signal,
  });
  assert.equal(result.summary, "done");
});

test("PiProcessRunner aborts the worker process group", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-worker-"));
  const marker = join(cwd, "late-marker");
  const workerPath = join(cwd, "worker.cjs");
  await writeFile(
    workerPath,
    'const {spawn}=require("node:child_process"); process.on("message", () => { spawn("sh", ["-c", "sleep 0.3; touch late-marker"], {stdio:"ignore"}); setInterval(()=>{},1000); });',
  );
  const controller = new AbortController();
  const running = new PiProcessRunner({ workerPath }).runIteration({ job, iteration: 1, cwd, progress: "", signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /aborted/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.match(await readFile(workerPath, "utf8"), /late-marker/);
});

test("the orchestrator records a deadline after stopping a Pi worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-worker-"));
  const workerPath = join(cwd, "worker.cjs");
  const jobPath = join(cwd, "job.yaml");
  await writeFile(workerPath, 'process.on("message", () => setInterval(()=>{},1000));');
  await writeFile(jobPath, "name: timed-worker\ntask: Test deadline.\nmax_minutes: 0.002\nmax_iterations: 1\n");
  const result = await runLocalJob(jobPath, { cwd, runner: new PiProcessRunner({ workerPath }) });
  assert.equal(result.status, "timed_out");
  assert.match(result.reason ?? "", /aborted/);
  await assert.rejects(stat(join(cwd, ".ralph", "run.lock")), { code: "ENOENT" });
});
