import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadJob, parseJob, prepareJob } from "../src/job.ts";

test("prepareJob assembles prompt and context before identifying default progress", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-job-input-"));
  const contextDir = join(workspace, "context");
  await mkdir(contextDir);
  await writeFile(join(workspace, "prompt.md"), "Additional acceptance criteria.");
  await writeFile(join(contextDir, "notes.md"), "Useful repository context.");
  await writeFile(join(contextDir, "binary.dat"), Buffer.from([0, 1, 2]));
  const original = parseJob("name: input-task\ntask: Implement the change.\nprompt_file: prompt.md\n");

  const prepared = await prepareJob(original, workspace, [contextDir]);

  assert.equal(original.task, "Implement the change.");
  assert.match(prepared.task, /^Implement the change\.\n\nAdditional acceptance criteria\./);
  assert.match(prepared.task, /Context file: context\/notes\.md\n\nUseful repository context\./);
  assert.doesNotMatch(prepared.task, /binary\.dat/);
  assert.notEqual(prepared.progressFile, original.progressFile);
  assert.equal(prepared.progressFile, (await prepareJob(original, workspace, [contextDir])).progressFile);
});

test("prepareJob preserves an explicit progress file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-job-input-"));
  const original = parseJob("name: shared-task\ntask: Do it.\nprogress_file: .ralph/progress/shared.md\n");

  assert.equal((await prepareJob(original, workspace, [])).progressFile, ".ralph/progress/shared.md");
});

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

test("YAML jobs reject the unsupported remote mode before execution", () => {
  assert.throws(() => parseJob("name: task\ntask: Do it\nmode: remote\n"), /use the remote CLI command/);
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
