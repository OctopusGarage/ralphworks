import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

  await assert.rejects(
    execFileAsync("node", [CLI, "run", jobPath, "--runner", "dry-run"], {
      cwd: workspace,
    }),
    (error: unknown) => {
      assert.match(String((error as { stdout?: string }).stdout), /RalphWorks run max_iterations: cli-job/);
      assert.match(String((error as { stdout?: string }).stdout), /runner=dry-run/);
      return true;
    },
  );
});

test("CLI SIGINT cancels a running check and writes a terminal result", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  const jobPath = join(workspace, "job.yaml");
  await writeJob(jobPath);
  const check = `node -e "require('node:fs').writeFileSync('check-started', 'yes'); setTimeout(() => {}, 5000)"`;
  const child = spawn("node", [CLI, "run", jobPath, "--runner", "dry-run", "--check", check], { cwd: workspace });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const closed = new Promise<number | null>((resolveClose) => child.on("close", (code) => resolveClose(code)));
  try {
    let started = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      started = await stat(join(workspace, "check-started")).then(
        () => true,
        () => false,
      );
      if (started) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(started, true, "check did not start");
    child.kill("SIGINT");
    assert.equal(await closed, 130);
    assert.match(stdout, /RalphWorks run cancelled/);
    const pointer = (await readFile(join(workspace, ".ralph", "current"), "utf8")).trim();
    const result = JSON.parse(await readFile(join(workspace, ".ralph", pointer, "result.json"), "utf8"));
    assert.equal(result.status, "cancelled");
    await assert.rejects(stat(join(workspace, ".ralph", "run.lock")), { code: "ENOENT" });
  } finally {
    child.kill("SIGKILL");
  }
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

test("CLI host run directs total deadline users to the loop limit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-cli-"));
  await assert.rejects(execFileAsync("node", [CLI, "run", "do work", "--total-minutes", "5"], { cwd: workspace }), (error: unknown) => {
    assert.match(String((error as { stderr?: string }).stderr), /use --max-minutes for host runs/);
    return true;
  });
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

  await assert.rejects(
    execFileAsync("node", [CLI, "run", jobPath, "--runner", "dry-run", "--executor", "host"], {
      cwd: workspace,
    }),
    (error: unknown) => {
      const stdout = String((error as { stdout?: string }).stdout);
      assert.match(stdout, /RalphWorks run max_iterations: cli-job/);
      assert.match(stdout, /runner=dry-run/);
      assert.match(stdout, /executor=host/);
      return true;
    },
  );
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
    ["name: cli-job", "task: Exercise the CLI runner option.", "completion_promise: DONE", "max_iterations: 1", "mode: local", ""].join(
      "\n",
    ),
    "utf8",
  );
}

test("CLI plan resolves a reusable task without executing checks or creating run state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-plan-"));
  await mkdir(join(cwd, "profile"));
  await writeFile(
    join(cwd, "profile", "profile.json"),
    JSON.stringify({ version: 1, name: "review", prompts: ["method.md"], parameters: { scope: null }, checks: ["touch should-not-exist"] }),
  );
  await writeFile(join(cwd, "profile", "method.md"), "Review {{scope}}");
  const { stdout } = await execFileAsync(
    "node",
    [CLI, "plan", "Review code", "--profile", "./profile", "--param", "scope=login", "--model", "any/model"],
    { cwd },
  );
  const plan = JSON.parse(stdout);
  assert.match(plan.job.task, /Review login/);
  assert.equal(plan.runtime.modelRef.provider, "any");
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(cwd)).sort(), ["profile"]);
});

test("CLI profiles collects, lists, shows and removes a personal task bundle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-library-"));
  const env = { ...process.env, RALPHWORKS_HOME: join(cwd, "library") };
  await mkdir(join(cwd, "source"));
  await writeFile(join(cwd, "source", "profile.json"), JSON.stringify({ version: 1, name: "review", prompts: ["method.md"] }));
  await writeFile(join(cwd, "source", "method.md"), "Inspect correctness.");
  await execFileAsync("node", [CLI, "profiles", "add", "./source", "my-review"], { cwd, env });
  assert.match((await execFileAsync("node", [CLI, "profiles", "list"], { cwd, env })).stdout, /my-review/);
  assert.match((await execFileAsync("node", [CLI, "profiles", "show", "my-review"], { cwd, env })).stdout, /Inspect correctness/);
  await execFileAsync("node", [CLI, "profiles", "remove", "my-review"], { cwd, env });
  assert.ok(
    !JSON.parse((await execFileAsync("node", [CLI, "profiles", "list"], { cwd, env })).stdout).some(
      (entry: { name: string }) => entry.name === "my-review",
    ),
  );
});

test("CLI worktree runs retain task records and leave source files unchanged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-worktree-cli-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "file.txt"), "source");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
  const worktree = join(cwd, "..", `task-${Date.now()}`);
  await assert.rejects(
    execFileAsync(
      "node",
      [
        CLI,
        "run",
        "Do a task",
        "--runner",
        "dry-run",
        "--workspace",
        "worktree",
        "--worktree-path",
        worktree,
        "--max-iterations",
        "1",
        "--check",
        "echo task-edit > file.txt",
      ],
      { cwd },
    ),
    (error) => {
      assert.match(String((error as { stdout: string }).stdout), /workspace=/);
      return true;
    },
  );
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "source");
  assert.equal((await readFile(join(worktree, "file.txt"), "utf8")).trim(), "task-edit");
});

test("container execution retains the prepared outer runtime in its run record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-prepared-runtime-"));
  const { resolveTask } = await import("../src/resolved-task.ts");
  const prepared = await resolveTask("Review", { cwd, jobOverrides: { maxIterations: 1 } });
  const path = join(cwd, "prepared.json");
  await writeFile(path, JSON.stringify({ ...prepared, runtime: { executor: "docker", workspace: "worktree", runtime: "my-preset" } }));
  await assert.rejects(
    execFileAsync("node", [CLI, "run", "Review", "--runner", "dry-run", "--executor", "host", "--workspace", "current"], {
      cwd,
      env: { ...process.env, RALPHWORKS_PREPARED_TASK: path },
    }),
  );
  const { readFile } = await import("node:fs/promises");
  const pointer = (await readFile(join(cwd, ".ralph", "current"), "utf8")).trim();
  const snapshot = JSON.parse(await readFile(join(cwd, ".ralph", pointer, "task.json"), "utf8"));
  assert.deepEqual(snapshot.runtime, { executor: "docker", workspace: "worktree", runtime: "my-preset" });
});

test("docker-clone forwards only explicit profile selection, preserving pushed YAML precedence", async () => {
  const { chmod, readFile } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-clone-precedence-"));
  await mkdir(join(cwd, ".ralphworks"));
  await mkdir(join(cwd, "bin"));
  await writeFile(join(cwd, ".ralphworks", "config.json"), JSON.stringify({ version: 1, profile: "default-method" }));
  const capture = join(cwd, "args.json");
  const docker = join(cwd, "bin", "docker");
  await writeFile(
    docker,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2)));\n',
  );
  await chmod(docker, 0o755);
  const args = [CLI, "run", "job.yaml", "--executor", "docker-clone", "--repo", "acme/project", "--ref", "main", "--runner", "dry-run"];
  const env = { ...process.env, PATH: `${join(cwd, "bin")}:${process.env.PATH}`, CAPTURE: capture, RALPHWORKS_HOME: join(cwd, "personal") };
  await execFileAsync("node", args, { cwd, env });
  let captured = JSON.parse(await readFile(capture, "utf8")) as string[];
  assert.ok(!captured.some((value) => value.startsWith("RALPHWORKS_PROFILE=")));
  await execFileAsync("node", [...args, "--profile", "explicit-method"], { cwd, env });
  captured = JSON.parse(await readFile(capture, "utf8")) as string[];
  assert.ok(captured.includes("RALPHWORKS_PROFILE=explicit-method"));
});
