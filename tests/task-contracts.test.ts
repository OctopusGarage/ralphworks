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

test("declared output symlinks block before the agent can overwrite an outside file", async () => {
  const { readFile, symlink } = await import("node:fs/promises");
  for (const nested of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "ralph-output-boundary-"));
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    const victim = join(outside, "CODE_REVIEW.json");
    await writeFile(victim, "original outside content");
    const output = nested ? "reports/CODE_REVIEW.json" : "CODE_REVIEW.json";
    await symlink(nested ? outside : victim, join(cwd, nested ? "reports" : "CODE_REVIEW.json"));
    const profile = join(root, "profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, name: "boundary", outputs: [{ path: output, format: "json" }] }));
    let called = false;
    const result = await runLocalJob("Write the report", {
      cwd,
      profile,
      runner: {
        async runIteration() {
          called = true;
          await writeFile(join(cwd, output), "{}");
          return { status: "continue", summary: "Report written", output: "<promise>DONE</promise>" };
        },
      },
    });
    assert.equal(called, false, "unsafe declared output must block before invoking the agent");
    assert.equal(result.status, "blocked");
    assert.equal(result.iterations, 0);
    assert.match(result.reason ?? "", /output.*symlink/i);
    assert.equal(await readFile(victim, "utf8"), "original outside content");
    assert.equal(JSON.parse(await readFile(result.resultPath, "utf8")).status, "blocked");
  }
});

test("safe existing regular reports and missing report directories still allow execution", async () => {
  for (const output of ["ARCHITECTURE_REPORT.md", "reports/review.json"]) {
    const cwd = await mkdtemp(join(tmpdir(), "ralph-output-regular-"));
    const profile = join(cwd, "profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, name: "regular", outputs: [{ path: output }] }));
    if (!output.includes("/")) await writeFile(join(cwd, output), "Prior report");
    let calls = 0;
    const result = await runLocalJob("Update the report", {
      cwd,
      profile,
      runner: {
        async runIteration() {
          calls++;
          await mkdir(join(cwd, "reports"), { recursive: true });
          await writeFile(join(cwd, output), "Updated report");
          return { status: "continue", summary: "Report written", output: "<promise>DONE</promise>" };
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
  }
});
