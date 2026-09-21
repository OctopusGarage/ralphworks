import assert from "node:assert/strict";
import test from "node:test";

import { runDockerContainer } from "../src/docker-command.ts";

test("runDockerContainer forces removal of a container after its outer deadline", async () => {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const result = await runDockerContainer(["run", "--rm", "example:latest"], 0.5, async (_file, args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return calls.length === 1 ? { exitCode: 124, stdout: "", stderr: "", timedOut: true } : { exitCode: 0, stdout: "", stderr: "" };
  });

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /exceeded 0.5 minutes/);
  assert.equal(calls[0].timeoutMs, 30_000);
  assert.deepEqual(calls[0].args.slice(0, 3), ["run", "--rm", "--name"]);
  assert.match(calls[0].args[3], /^ralphworks-/);
  assert.deepEqual(calls[1].args, ["rm", "--force", calls[0].args[3]]);
  assert.equal(calls[1].timeoutMs, 15_000);
});
