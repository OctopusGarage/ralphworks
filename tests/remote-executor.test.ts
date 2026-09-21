import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runRemoteJob } from "../src/remote-executor.ts";

test("remote dispatch watches a run and downloads its result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-remote-"));
  const calls: string[][] = [];
  const result = await runRemoteJob({
    repo: "OctopusGarage/mbti-lab",
    ref: "ralph-test",
    jobPath: "job.yaml",
    cwd,
    command: async (args) => {
      calls.push(args);
      if (args[0] === "workflow")
        return { exitCode: 0, stdout: "https://github.com/OctopusGarage/mbti-lab/actions/runs/123\n", stderr: "" };
      if (args[1] === "watch") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[1] === "download") {
        await writeFile(join(cwd, ".ralph", "remote", "123", "result.json"), JSON.stringify({ status: "completed" }));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.runId, 123);
  assert.match(calls[0].join(" "), /task=job.yaml/);
  assert.match(calls[0].join(" "), /request_id=/);
  assert.equal(JSON.parse(await readFile(join(result.artifactDir, "result.json"), "utf8")).status, "completed");
});

test("remote dispatch passes an explicit resume source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-remote-"));
  let dispatch: string[] = [];
  await runRemoteJob({
    repo: "OctopusGarage/mbti-lab",
    ref: "ralph-test",
    jobPath: "job.yaml",
    resumeRunId: "123",
    cwd,
    command: async (args) => {
      if (args[0] === "workflow") {
        dispatch = args;
        return { exitCode: 0, stdout: "https://github.com/OctopusGarage/mbti-lab/actions/runs/456\n", stderr: "" };
      }
      if (args[1] === "watch") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[1] === "download") return { exitCode: 1, stdout: "", stderr: "" };
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  });
  assert.ok(dispatch.includes("resume_run_id=123"));
});

test("remote preserves the downloaded terminal status when Actions exits nonzero", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-remote-"));
  const result = await runRemoteJob({
    repo: "OctopusGarage/mbti-lab",
    ref: "ralph-test",
    jobPath: "job.yaml",
    cwd,
    command: async (args) => {
      if (args[0] === "workflow")
        return { exitCode: 0, stdout: "https://github.com/OctopusGarage/mbti-lab/actions/runs/456\n", stderr: "" };
      if (args[1] === "watch") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[1] === "download") {
        await writeFile(
          join(cwd, ".ralph", "remote", "456", "result.json"),
          JSON.stringify({ status: "blocked", reason: "checks are required" }),
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "checks are required");
});

test("remote does not claim completion if a later Actions step fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-remote-"));
  const result = await runRemoteJob({
    repo: "OctopusGarage/mbti-lab",
    ref: "ralph-test",
    jobPath: "job.yaml",
    cwd,
    command: async (args) => {
      if (args[0] === "workflow")
        return { exitCode: 0, stdout: "https://github.com/OctopusGarage/mbti-lab/actions/runs/789\n", stderr: "" };
      if (args[1] === "watch") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[1] === "download") {
        await writeFile(join(cwd, ".ralph", "remote", "789", "result.json"), JSON.stringify({ status: "completed" }));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "GitHub Actions run failed");
});

test("remote does not mislabel a task limit as an Actions infrastructure failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-remote-"));
  const result = await runRemoteJob({
    repo: "OctopusGarage/mbti-lab",
    ref: "ralph-test",
    jobPath: "job.yaml",
    cwd,
    command: async (args) => {
      if (args[0] === "workflow")
        return { exitCode: 0, stdout: "https://github.com/OctopusGarage/mbti-lab/actions/runs/790\n", stderr: "" };
      if (args[1] === "watch") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[1] === "download") {
        await writeFile(join(cwd, ".ralph", "remote", "790", "result.json"), JSON.stringify({ status: "max_iterations" }));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "max_iterations");
  assert.equal(result.reason, undefined);
});
