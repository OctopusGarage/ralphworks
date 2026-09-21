import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadJob, parseJob } from "../src/job.ts";

test("jobs keep separate default progress files", () => {
  const first = parseJob("name: first-task\ntask: Do first.\n");
  const second = parseJob("name: second-task\ntask: Do second.\n");
  assert.match(first.progressFile, /^\.ralph\/progress\/first-task-[a-f0-9]{12}\.md$/);
  assert.match(second.progressFile, /^\.ralph\/progress\/second-task-[a-f0-9]{12}\.md$/);
  assert.notEqual(first.progressFile, second.progressFile);
});

test("loadJob treats Markdown files as built-in Ralph tasks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-job-"));
  const taskPath = join(workspace, "TASK.md");
  await writeFile(taskPath, "# Build search\n\nImplement repository search.", "utf8");

  const job = await loadJob(taskPath);

  assert.deepEqual(job, {
    name: "TASK",
    task: "# Build search\n\nImplement repository search.",
    progressFile: job.progressFile,
    completionPromise: "DONE",
    maxIterations: 5,
    mode: "local",
    checks: [],
    checkTimeoutSeconds: 60,
    commit: "none",
  });
  assert.match(job.progressFile, /^\.ralph\/progress\/task-[a-f0-9]{12}\.md$/);
});

test("YAML jobs reject misspelled, duplicate, and silently ignored lines", () => {
  assert.throws(() => parseJob("name: task\ntask: Do it\nmax_iteration: 5\n"), /Unknown job field: max_iteration/);
  assert.throws(() => parseJob("name: task\ntask: Do it\nname: other\n"), /Duplicate job field: name/);
  assert.throws(() => parseJob("name: task\ntask: Do it\n  unexpected: ignored\n"), /Unsupported job line/);
  assert.throws(() => parseJob("name: task\ntask: Do it\nchecks:\n  - npm test\n    unexpected continuation\n"), /Unsupported job line/);
});

test("YAML jobs reject empty checks", () => {
  assert.throws(() => parseJob("name: task\ntask: Do it\nchecks:\n  - \n"), /non-empty commands/);
});

test("YAML jobs use the same useful loop defaults as plain tasks", () => {
  const job = parseJob("name: task\ntask: Do it\n");
  assert.equal(job.completionPromise, "DONE");
  assert.equal(job.maxIterations, 5);
});

test("loadJob accepts direct task text when no file exists", async () => {
  const job = await loadJob("Fix the result page without changing the scoring algorithm.");
  assert.equal(job.name, "task");
  assert.equal(job.task, "Fix the result page without changing the scoring algorithm.");
  assert.equal(job.completionPromise, "DONE");
  const other = await loadJob("Fix a different bug.");
  assert.notEqual(job.progressFile, other.progressFile);
  assert.equal(job.progressFile, (await loadJob("Fix the result page without changing the scoring algorithm.")).progressFile);
});

test("loadJob reports a missing value that clearly looks like a file path", async () => {
  await assert.rejects(loadJob("./missing-task.md"), /ENOENT/);
});
