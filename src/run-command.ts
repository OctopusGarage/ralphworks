import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDockerCloneJob } from "./docker-clone-executor.ts";
import { runDockerMountJob } from "./docker-mount-executor.ts";
import { inferGitContext } from "./git-context.ts";
import { currentGitHead } from "./git-transaction.ts";
import { runLocalJob } from "./orchestrator.ts";
import { PiProcessRunner } from "./pi-process-runner.ts";
import { type ResolvedTask, resolveTask, stageTaskSkills } from "./resolved-task.ts";
import { parseRunArgs, type RunArgs } from "./run-args.ts";
import { reserveRunReceipt } from "./run-receipt.ts";
import { canonicalPath, resolveStateDirectory, stateProgressFile } from "./run-state.ts";
import { resolveRunConfiguration } from "./runtime.ts";
import { validateMcpRequirements } from "./task-contracts.ts";
import { normalizeTaskEnvironment } from "./task-environment.ts";
import { prepareWorkspace } from "./workspace.ts";
import { cleanupWorkspace, reconcileWorkspaces, saveWorkspace, withinWorkspace } from "./workspace-lifecycle.ts";

export async function runTaskCommand(command: "run" | "plan", target: string, args: string[]): Promise<number> {
  const sourceCwd = process.cwd();
  const inputPath = process.env.RALPHWORKS_PREPARED_TASK;
  const parsed = inputPath ? parseRunArgs(args) : await resolveRunConfiguration(args, sourceCwd);
  if (parsed instanceof Error) throw parsed;
  const runArgs = parsed;
  if (runArgs.stateDir !== undefined && runArgs.executor !== "host") throw new Error("--state-dir requires the host executor");
  const stateDir = runArgs.stateDir === undefined ? undefined : await resolveStateDirectory(sourceCwd, runArgs.stateDir);
  if (stateDir !== undefined) {
    runArgs.stateDir = stateDir;
    if (runArgs.workspace === "worktree" && runArgs.worktreePath) {
      await resolveStateDirectory(resolve(sourceCwd, runArgs.worktreePath), stateDir);
      if (withinWorkspace(await canonicalPath(resolve(sourceCwd, runArgs.worktreePath)), await canonicalPath(stateDir)))
        throw new Error("State must be outside the owned workspace");
    }
  }
  if (Boolean(runArgs.resultFile) !== Boolean(runArgs.invocationId))
    throw new Error("--result-file and --invocation-id must be supplied together");
  if (runArgs.resultFile && (command !== "run" || runArgs.executor !== "host"))
    throw new Error("Invocation receipts require run with the host executor");
  if (runArgs.resultFile && inputPath) throw new Error("Invocation receipts cannot use an internal prepared task");
  if (runArgs.keepWorktree && runArgs.workspace !== "worktree") throw new Error("--keep-worktree requires --workspace worktree");
  if (
    runArgs.workspace === "worktree" &&
    runArgs.resultFile &&
    runArgs.worktreePath &&
    withinWorkspace(
      await canonicalPath(resolve(sourceCwd, runArgs.worktreePath)),
      await canonicalPath(resolve(sourceCwd, runArgs.resultFile)),
    )
  )
    throw new Error("Invocation receipt must be outside the owned workspace");
  const receipt =
    runArgs.resultFile && runArgs.invocationId
      ? await reserveRunReceipt(runArgs.resultFile, runArgs.invocationId, target, sourceCwd)
      : undefined;
  try {
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
    if (stateDir !== undefined) {
      task = { ...task, job: { ...task.job, progressFile: stateProgressFile(task.job.progressFile, stateDir) } };
      runtime.stateDir = stateDir;
    }
    const environment = task.environment ?? normalizeTaskEnvironment(undefined);
    validateMcpRequirements(environment, runArgs.mcpBindings ?? {});
    if (command === "plan") {
      console.log(JSON.stringify({ ...task, runtime }, null, 2));
      return 0;
    }
    if (runArgs.workspace === "worktree") {
      for (const previous of await reconcileWorkspaces(sourceCwd, stateDir, true)) {
        if (previous.cleanup === "retained") console.error(`workspaceCleanup=${previous.id}: retained: ${previous.reason}`);
      }
    }
    const workspace = await prepareWorkspace(sourceCwd, {
      kind: runArgs.workspace ?? "current",
      path: runArgs.worktreePath,
      stateDir,
      keep: runArgs.keepWorktree,
      executor: runArgs.executor,
      preservePaths: [...(task.outputs ?? []).map((output) => output.path), task.job.progressFile],
    });
    const executionState = workspace.stateDir ?? stateDir;
    if (workspace.stateDir) {
      task = { ...task, job: { ...task.job, progressFile: stateProgressFile(task.job.progressFile, workspace.stateDir) } };
      runtime.stateDir = workspace.stateDir;
    }
    if (!inputPath) Object.assign(runtime, { workspacePath: workspace.cwd, branch: workspace.branch, baseHead: workspace.baseHead });
    console.log(`workspace=${workspace.cwd}`);
    if (workspace.branch)
      console.log(`branch=${workspace.branch}\nbaseHead=${workspace.baseHead}\nworkspaceRecord=${workspace.recordPath}`);
    if (workspace.stateDir) console.log(`stateDir=${workspace.stateDir}`);
    const receiptTask = task;
    let baseHead: string | undefined;
    if (runArgs.executor === "docker") {
      if (workspace.owned) console.log("cleanup=retained\ncleanupReason=Docker container absence and external state are not proven");
      if (!inputPath) task = await stageTaskSkills(task, workspace.cwd);
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
    const processes = new Set<number>();
    const onProcessSpawn = workspace.owned
      ? (pid: number) => {
          processes.add(pid);
        }
      : undefined;
    const result = await runLocalJob(target, {
      cwd: workspace.cwd,
      stateDir: executionState,
      preparedTask: task,
      runtime,
      signal: interrupt.signal,
      onProcessSpawn,
      finalize:
        workspace.owned || receipt
          ? async (terminal, executionStarted) => {
              const owned = workspace.owned;
              let receiptPublished = !receipt || !terminal;
              try {
                if (owned && !terminal && executionStarted) {
                  owned.reason = "Terminal run-state persistence did not complete; workspace retained";
                  await saveWorkspace(owned);
                  console.log("cleanup=retained");
                  console.error(`cleanupReason=${owned.reason}`);
                  return;
                }
                if (terminal && receipt)
                  await receipt.publish({
                    cwd: workspace.cwd,
                    baseHead,
                    head: await currentGitHead(workspace.cwd),
                    task: receiptTask,
                    result: terminal,
                  });
                receiptPublished = true;
                if (!owned) return;
                owned.head = await currentGitHead(workspace.cwd);
                owned.resultPath = terminal?.resultPath;
                owned.status = terminal?.status ?? "preparation_failed";
                owned.phase = "terminal";
                owned.managedGroups = [...processes];
                await saveWorkspace(owned);
                const cleanup = await cleanupWorkspace(owned);
                console.log(`cleanup=${cleanup.cleanup}`);
                if (cleanup.recovery) console.log(`recovery=${cleanup.recovery}`);
                if (cleanup.reason) console.error(`cleanupReason=${cleanup.reason}`);
              } catch (error) {
                if (!owned) throw error;
                owned.reason = `Finalization retained workspace: ${String(error)}`;
                await saveWorkspace(owned).catch(() => undefined);
                console.log("cleanup=retained");
                console.error(`cleanupReason=${owned.reason}`);
                // A requested receipt failure retains the original CLI failure semantics.
                if (!receiptPublished) throw error;
              }
            }
          : undefined,
      prepareTask: async (resolvedTask) => {
        // Host input staging and runner construction share the worktree lock with execution.
        if (receipt) baseHead = await currentGitHead(workspace.cwd);
        const prepared = inputPath ? resolvedTask : await stageTaskSkills(resolvedTask, workspace.cwd, executionState);
        return {
          task: prepared,
          runner:
            runArgs.runner === "pi"
              ? new PiProcessRunner({
                  modelRef: runArgs.modelRef,
                  piAgentDir: runArgs.piAgentDir,
                  skillPaths: prepared.skillPaths,
                  environment: prepared.environment,
                  mcpBindings: runArgs.mcpBindings,
                  onSpawn: onProcessSpawn,
                })
              : undefined,
        };
      },
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
  } finally {
    await receipt?.close();
  }
}

function runtimeSnapshot(args: RunArgs): Record<string, unknown> {
  return {
    runner: args.runner,
    executor: args.executor,
    workspace: args.workspace ?? "current",
    ...(args.workspace === "worktree"
      ? { workspaceCleanup: args.keepWorktree ? "keep" : args.executor === "docker" ? "retain-docker" : "archive-remove" }
      : {}),
    modelRef: args.modelRef,
    piAgentDir: args.piAgentDir,
    runtime: args.runtime,
    passEnv: args.passEnv,
    mcpBindings: args.mcpBindings,
  };
}
