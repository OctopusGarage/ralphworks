import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLocalJob } from "../src/orchestrator.ts";
import { checkTaskPrerequisites, validateTaskOutputs } from "../src/task-contracts.ts";
import { normalizeTaskEnvironment } from "../src/task-environment.ts";

test("prerequisites check named commands and environment without running arbitrary setup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-prerequisites-"));
  const environment = normalizeTaskEnvironment({ requires: { commands: ["node"], env: ["TASK_TOKEN"] } });
  await assert.rejects(checkTaskPrerequisites(environment, cwd, {}), /TASK_TOKEN/);
  await checkTaskPrerequisites(environment, cwd, { ...process.env, TASK_TOKEN: "private" });
  await assert.rejects(
    checkTaskPrerequisites(normalizeTaskEnvironment({ requires: { commands: ["ralph_missing_command_xyz"] } }), cwd, process.env),
    /ralph_missing_command_xyz/,
  );
});

test("outputs independently validate required files and JSON while optional missing files pass", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-outputs-"));
  const requirements = [
    { path: "report.json", format: "json" as const },
    { path: "optional.txt", required: false },
  ];
  let checks = await validateTaskOutputs(requirements, cwd);
  assert.equal(checks[0].exitCode, 1);
  assert.equal(checks[1].exitCode, 0);
  await writeFile(join(cwd, "report.json"), "not-json-secret");
  checks = await validateTaskOutputs(requirements, cwd);
  assert.equal(checks[0].exitCode, 1);
  assert.ok(!checks[0].stderr.includes("not-json-secret"));
  await writeFile(join(cwd, "report.json"), '{"passed":true}');
  assert.equal((await validateTaskOutputs(requirements, cwd))[0].exitCode, 0);
});

test("an agent completion signal cannot bypass task output requirements", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-output-completion-"));
  const profile = join(cwd, "profile");
  await mkdir(profile);
  await writeFile(
    join(profile, "profile.json"),
    JSON.stringify({ version: 1, name: "report", outputs: [{ path: "report.json", format: "json" }], defaults: { maxIterations: 2 } }),
  );
  const result = await runLocalJob("Produce report", {
    cwd,
    profile,
    runner: {
      async runIteration(input) {
        if (input.iteration === 2) {
          assert.match(input.progress, /report.json/);
          await writeFile(join(cwd, "report.json"), "{}");
        }
        return { status: "continue", summary: "Done", output: "<promise>DONE</promise>" };
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 2);
  assert.equal(result.checks[0].exitCode, 1);
  assert.equal(result.checks[1].exitCode, 0);
});
