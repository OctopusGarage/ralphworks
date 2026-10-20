import { readFile } from "node:fs/promises";
import { runDockerCloneJob } from "./docker-clone-executor.ts";
import { runDockerMountJob } from "./docker-mount-executor.ts";
import { inferGitContext } from "./git-context.ts";
import { runLocalJob } from "./orchestrator.ts";
import { PiProcessRunner } from "./pi-process-runner.ts";
import { type ResolvedTask, resolveTask, stageTaskSkills } from "./resolved-task.ts";
import { parseRunArgs, type RunArgs } from "./run-args.ts";
import { resolveRunConfiguration } from "./runtime.ts";
import { validateMcpRequirements } from "./task-contracts.ts";
import { normalizeTaskEnvironment } from "./task-environment.ts";
import { prepareWorkspace } from "./workspace.ts";

export async function runTaskCommand(command: "run" | "plan", target: string, args: string[]): Promise<number> {
  const sourceCwd = process.cwd();
  const inputPath = process.env.RALPHWORKS_PREPARED_TASK;
  const parsed = inputPath ? parseRunArgs(args) : await resolveRunConfiguration(args, sourceCwd);
  if (parsed instanceof Error) throw parsed;
  const runArgs = parsed;
  const explicitProfile = args.includes("--profile") ? runArgs.profile : process.env.RALPHWORKS_PROFILE;
  if (runArgs.executor === "docker-clone") {
    if (command === "plan") throw new Error("plan resolves local inputs; inspect the pushed job before docker-clone execution");
    let { repo, ref } = runArgs;
    if (!repo || !ref) {
      const inferred = await inferGitContext();
      repo ??= inferred.repo;
      ref ??= inferred.ref;
    }
    const result = await runDockerCloneJob({
      jobPath: target,
      repo,
      ref,
      runner: runArgs.runner,
      modelRef: runArgs.modelRef,
      piAgentDir: runArgs.piAgentDir,
      passEnv: runArgs.passEnv,
      checks: runArgs.checks,
      contexts: runArgs.contexts,
      jobOverrides: runArgs.jobOverrides,
      totalMinutes: runArgs.totalMinutes,
      profile: explicitProfile,
      mcpBindings: runArgs.mcpBindings,
      params: runArgs.params,
    });
    console.log(`RalphWorks docker ${result.status}`);
    console.log(`runner=${runArgs.runner}\nexecutor=${runArgs.executor}\nrepo=${repo}\nref=${ref}\noutputDir=${result.outputDir}`);
    if (result.exitCode !== 0 && result.stdout) console.log(result.stdout.trimEnd());
    if (result.exitCode !== 0 && result.stderr) console.error(result.stderr.trimEnd());
    return result.exitCode === 0 ? 0 : 1;
  }
  if (runArgs.executor === "host" && runArgs.totalMinutes !== undefined)
    throw new Error("--total-minutes applies to Docker and remote execution; use --max-minutes for host runs");
  let task: ResolvedTask = inputPath
    ? JSON.parse(await readFile(inputPath, "utf8"))
    : await resolveTask(target, {
        cwd: sourceCwd,
        autoUpdateSkills: command === "run",
        profile: explicitProfile,
        defaultProfile: runArgs.profile,
        params: runArgs.params,
        contexts: runArgs.contexts,
        checks: runArgs.checks,
        jobOverrides: runArgs.jobOverrides,
      });
  const runtime = inputPath && task.runtime ? task.runtime : runtimeSnapshot(runArgs);
  const environment = task.environment ?? normalizeTaskEnvironment(undefined);
  validateMcpRequirements(environment, runArgs.mcpBindings ?? {});
  if (command === "plan") {
    console.log(JSON.stringify({ ...task, runtime }, null, 2));
    return 0;
  }
  const workspace = await prepareWorkspace(sourceCwd, { kind: runArgs.workspace ?? "current", path: runArgs.worktreePath });
  if (!inputPath) Object.assign(runtime, { workspacePath: workspace.cwd, branch: workspace.branch, baseHead: workspace.baseHead });
  console.log(`workspace=${workspace.cwd}`);
  if (workspace.branch) console.log(`branch=${workspace.branch}\nbaseHead=${workspace.baseHead}\nworkspaceRecord=${workspace.recordPath}`);
  // Materialize selected skills once so fresh iterations use the same support files.
  if (!inputPath) task = await stageTaskSkills(task, workspace.cwd);
  if (runArgs.executor === "docker") {
    const result = await runDockerMountJob({
      cwd: workspace.cwd,
      jobPath: target,
      runner: runArgs.runner,
      modelRef: runArgs.modelRef,
      piAgentDir: runArgs.piAgentDir,
      passEnv: runArgs.passEnv,
      totalMinutes: runArgs.totalMinutes,
      preparedTask: { ...task, runtime },
      mcpBindings: runArgs.mcpBindings,
    });
    console.log(`RalphWorks docker ${result.status}\nrunner=${runArgs.runner}\nexecutor=${runArgs.executor}`);
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    return result.exitCode === 0 ? 0 : 1;
  }
  const interrupt = new AbortController();
  const onSigint = () => interrupt.abort("SIGINT");
  const onSigterm = () => interrupt.abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const result = await runLocalJob(target, {
    cwd: workspace.cwd,
    preparedTask: task,
    runtime,
    signal: interrupt.signal,
    runner:
      runArgs.runner === "pi"
        ? new PiProcessRunner({
            modelRef: runArgs.modelRef,
            piAgentDir: runArgs.piAgentDir,
            skillPaths: task.skillPaths,
            environment: task.environment,
            mcpBindings: runArgs.mcpBindings,
          })
        : undefined,
  }).finally(() => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  });
  console.log(`RalphWorks run ${result.status}: ${result.jobName}`);
  console.log(`runner=${runArgs.runner}\nexecutor=${runArgs.executor}\niterations=${result.iterations}\nrunDir=${result.runDir}`);
  if (result.reason) console.log(`reason=${result.reason}`);
  if (result.status !== "completed" && result.lastSummary) console.log(`lastSummary=${result.lastSummary}`);
  const failedCheck = result.status === "completed" ? undefined : result.checks.findLast((check) => check.exitCode !== 0);
  if (failedCheck) {
    console.log(`failedCheck=${failedCheck.command} (exit ${failedCheck.exitCode})`);
    const detail = (failedCheck.stderr || failedCheck.stdout).trim().slice(-1000);
    if (detail) console.log(`checkOutput=${detail}`);
  }
  return result.status === "completed" ? 0 : result.status === "cancelled" ? (interrupt.signal.reason === "SIGTERM" ? 143 : 130) : 1;
}

function runtimeSnapshot(args: RunArgs): Record<string, unknown> {
  return {
    runner: args.runner,
    executor: args.executor,
    workspace: args.workspace ?? "current",
    modelRef: args.modelRef,
    piAgentDir: args.piAgentDir,
    runtime: args.runtime,
    passEnv: args.passEnv,
    mcpBindings: args.mcpBindings,
  };
}
