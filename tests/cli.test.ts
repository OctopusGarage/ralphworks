import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = resolve("src/cli.ts");

test("CLI init scaffolds a minimal GitHub Actions entrypoint", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));

  const { stdout } = await execFileAsync("node", [CLI, "init"], {
    cwd: workspace,
  });

  assert.match(stdout, /RalphWorks init/);
  assert.match(stdout, /created=.github\/workflows\/ralphworks.yml/);

  const workflow = await readFile(join(workspace, ".github", "workflows", "ralphworks.yml"), "utf8");
  assert.match(workflow, /RALPHWORKS_MODEL: \$\{\{ vars\.RALPHWORKS_MODEL \}\}/);
  assert.match(workflow, /node "\$RUNNER_TEMP\/ralphworks\/dist\/cli\.js" run "\$RALPH_TASK" --executor host/);
});

test("CLI run accepts an explicit dry-run runner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  const jobPath = join(workspace, "job.yaml");
  await writeJob(jobPath);

  await assert.rejects(execFileAsync("node", [CLI, "run", jobPath, "--runner", "dry-run"], {
    cwd: workspace,
  }), (error: unknown) => {
    assert.match(String((error as { stdout?: string }).stdout), /RalphWorks run max_iterations: cli-job/);
    assert.match(String((error as { stdout?: string }).stdout), /runner=dry-run/);
    return true;
  });
});

test("CLI run rejects unknown runners", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  const jobPath = join(workspace, "job.yaml");
  await writeJob(jobPath);

  await assert.rejects(
    execFileAsync("node", [CLI, "run", jobPath, "--runner", "wat"], {
      cwd: workspace,
    }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.match(String((error as { stderr?: string }).stderr), /Unknown runner/);
      return true;
    },
  );
});

test("CLI remote rejects local-only flags before dispatch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  await assert.rejects(
    execFileAsync("node", [CLI, "remote", "job.yaml", "--model", "zai-coding-cn/glm-5.3"], { cwd: workspace }),
    (error: unknown) => {
      assert.match(String((error as { stderr?: string }).stderr), /--model is not supported by remote/);
      return true;
    },
  );
});

test("CLI remote rejects an invalid resume run ID before dispatch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  await assert.rejects(
    execFileAsync("node", [CLI, "remote", "job.yaml", "--resume-from", "../other"], { cwd: workspace }),
    (error: unknown) => {
      assert.match(String((error as { stderr?: string }).stderr), /positive GitHub Actions run ID/);
      return true;
    },
  );
});

test("CLI run reports when docker-clone cannot infer the current git repo", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  const jobPath = join(workspace, "job.yaml");
  await writeJob(jobPath);

  await assert.rejects(
    execFileAsync("node", [CLI, "run", jobPath, "--executor", "docker-clone"], {
      cwd: workspace,
    }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.match(String((error as { stderr?: string }).stderr), /^Error: /);
      assert.match(String((error as { stderr?: string }).stderr), /git remote get-url origin/);
      return true;
    },
  );
});

test("CLI run accepts the host executor explicitly", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  const jobPath = join(workspace, "job.yaml");
  await writeJob(jobPath);

  await assert.rejects(execFileAsync("node", [CLI, "run", jobPath, "--runner", "dry-run", "--executor", "host"], {
    cwd: workspace,
  }), (error: unknown) => {
    const stdout = String((error as { stdout?: string }).stdout);
    assert.match(stdout, /RalphWorks run max_iterations: cli-job/);
    assert.match(stdout, /runner=dry-run/);
    assert.match(stdout, /executor=host/);
    return true;
  });
});

test("CLI status prints a compact run summary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
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

  const { stdout } = await execFileAsync("node", [CLI, "status", runDir], {
    cwd: workspace,
  });

  assert.match(stdout, /job=sample-job/);
  assert.match(stdout, /status=completed/);
  assert.match(stdout, /iterations=2/);
  assert.match(stdout, /checks=1 total, 0 failed/);
});

test("CLI status prints the reason and failed check", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  await writeFile(join(workspace, "result.json"), JSON.stringify({
    jobName: "failed-job", status: "max_iterations", iterations: 3,
    runDir: workspace, reason: "iteration limit reached",
    checks: [{ command: "pnpm test", exitCode: 1, stderr: "assertion failed" }],
  }));
  const { stdout } = await execFileAsync("node", [CLI, "status", workspace], { cwd: workspace });
  assert.match(stdout, /reason=iteration limit reached/);
  assert.match(stdout, /failedCheck=pnpm test \(exit 1\)/);
  assert.match(stdout, /checkOutput=assertion failed/);
});

test("CLI trace prints a compact event summary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  const eventsPath = join(workspace, "events.jsonl");
  await writeFile(
    eventsPath,
    [
      JSON.stringify({ type: "run_started", at: "2026-09-17T00:00:00.000Z", job: "sample" }),
      JSON.stringify({ type: "iteration_started", at: "2026-09-17T00:00:01.000Z", job: "sample", iteration: 1 }),
      JSON.stringify({ type: "check_finished", at: "2026-09-17T00:00:02.000Z", job: "sample", iteration: 1 }),
      "",
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync("node", [CLI, "trace", eventsPath], {
    cwd: workspace,
  });

  assert.match(stdout, /events=3/);
  assert.match(stdout, /types=run_started,iteration_started,check_finished/);
  assert.match(stdout, /first=2026-09-17T00:00:00.000Z/);
  assert.match(stdout, /last=2026-09-17T00:00:02.000Z/);
});

test("CLI status formats missing run directory errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));

  await assert.rejects(
    execFileAsync("node", [CLI, "status", join(workspace, "missing-run")], {
      cwd: workspace,
    }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.match(String((error as { stderr?: string }).stderr), /^Error: /);
      assert.doesNotMatch(String((error as { stderr?: string }).stderr), /node:internal/);
      return true;
    },
  );
});

test("CLI trace formats missing events file errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));

  await assert.rejects(
    execFileAsync("node", [CLI, "trace", join(workspace, "missing-events.jsonl")], {
      cwd: workspace,
    }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.match(String((error as { stderr?: string }).stderr), /^Error: /);
      assert.doesNotMatch(String((error as { stderr?: string }).stderr), /node:internal/);
      return true;
    },
  );
});

async function writeJob(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "name: cli-job",
      "task: Exercise the CLI runner option.",
      "completion_promise: DONE",
      "max_iterations: 1",
      "mode: local",
      "",
    ].join("\n"),
    "utf8",
  );
}
