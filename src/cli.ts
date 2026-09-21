#!/usr/bin/env node

import { runDockerCloneJob } from "./docker-clone-executor.ts";
import { runDockerMountJob } from "./docker-mount-executor.ts";
import { inferGitContext } from "./git-context.ts";
import { initProject } from "./init.ts";
import { runLocalJob } from "./orchestrator.ts";
import { PiProcessRunner } from "./pi-process-runner.ts";
import { runRemoteJob } from "./remote-executor.ts";
import { parseRunArgs } from "./run-args.ts";
import { readRunStatus } from "./status.ts";
import { readTrace } from "./trace.ts";

const USAGE = `RalphWorks

Usage:
  ralphworks init
  ralphworks run <task-text|task-file|job.yaml> [--context PATH] [--runner dry-run|pi] [--executor host|docker|docker-clone] [--model provider/model] [--check COMMAND] [--max-iterations N] [--max-minutes N] [--max-cost-usd N] [--check-timeout N] [--commit none|verified] [--completion-promise VALUE] [--pass-env NAME] [--pi-agent-dir PATH]
  ralphworks remote <task-file|job.yaml> [--repo owner/name] [--ref branch] [--resume-from RUN_ID]
  ralphworks status <run-dir>
  ralphworks trace <events.jsonl>

RalphWorks is a bounded Ralph loop orchestrator powered by Pi.
`;

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    console.log(USAGE.trimEnd());
    return 0;
  }

  if (command === "init") {
    const result = await initProject();
    console.log("RalphWorks init");
    for (const file of result.created) {
      console.log(`created=${file}`);
    }
    for (const file of result.skipped) {
      console.log(`skipped=${file}`);
    }
    for (const file of result.updated) {
      console.log(`updated=${file}`);
    }
    return 0;
  }

  if (!target) {
    console.error(`Missing target for command: ${command}`);
    console.error("");
    console.error(USAGE.trimEnd());
    return 1;
  }

  switch (command) {
    case "run": {
      const runArgs = parseRunArgs(rest);
      if (runArgs instanceof Error) {
        console.error(runArgs.message);
        return 1;
      }
      if (runArgs.executor === "docker-clone") {
        let repo = runArgs.repo;
        let ref = runArgs.ref;
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
        });
        console.log(`RalphWorks docker ${result.status}`);
        console.log(`runner=${runArgs.runner}`);
        console.log(`executor=${runArgs.executor}`);
        console.log(`repo=${repo}`);
        console.log(`ref=${ref}`);
        console.log(`outputDir=${result.outputDir}`);
        if (result.exitCode !== 0 && result.stdout) console.log(result.stdout.trimEnd());
        if (result.exitCode !== 0 && result.stderr) console.error(result.stderr.trimEnd());
        return result.exitCode === 0 ? 0 : 1;
      }
      if (runArgs.executor === "docker") {
        const result = await runDockerMountJob({
          cwd: process.cwd(),
          jobPath: target,
          runner: runArgs.runner,
          modelRef: runArgs.modelRef,
          piAgentDir: runArgs.piAgentDir,
          passEnv: runArgs.passEnv,
          checks: runArgs.checks,
          contexts: runArgs.contexts,
          jobOverrides: runArgs.jobOverrides,
        });
        console.log(`RalphWorks docker ${result.status}`);
        console.log(`runner=${runArgs.runner}`);
        console.log(`executor=${runArgs.executor}`);
        if (result.exitCode !== 0 && result.stdout) console.log(result.stdout.trimEnd());
        if (result.exitCode !== 0 && result.stderr) console.error(result.stderr.trimEnd());
        return result.exitCode === 0 ? 0 : 1;
      }
      const interrupt = new AbortController();
      const onSigint = () => interrupt.abort("SIGINT");
      const onSigterm = () => interrupt.abort("SIGTERM");
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      const result = await runLocalJob(target, {
        checksOverride: runArgs.checks,
        contexts: runArgs.contexts,
        jobOverrides: runArgs.jobOverrides,
        signal: interrupt.signal,
        runner: runArgs.runner === "pi" ? new PiProcessRunner({ modelRef: runArgs.modelRef, piAgentDir: runArgs.piAgentDir }) : undefined,
      }).finally(() => {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
      });
      console.log(`RalphWorks run ${result.status}: ${result.jobName}`);
      console.log(`runner=${runArgs.runner}`);
      console.log(`executor=${runArgs.executor}`);
      console.log(`iterations=${result.iterations}`);
      console.log(`runDir=${result.runDir}`);
      if (result.reason) console.log(`reason=${result.reason}`);
      if (result.status !== "completed" && result.lastSummary) console.log(`lastSummary=${result.lastSummary}`);
      const failedCheck = result.checks.findLast((check) => check.exitCode !== 0);
      if (failedCheck) {
        console.log(`failedCheck=${failedCheck.command} (exit ${failedCheck.exitCode})`);
        const detail = (failedCheck.stderr || failedCheck.stdout).trim().slice(-1000);
        if (detail) console.log(`checkOutput=${detail}`);
      }
      return result.status === "completed" ? 0 : result.status === "cancelled" ? (interrupt.signal.reason === "SIGTERM" ? 143 : 130) : 1;
    }
    case "status":
      {
        const status = await readRunStatus(target);
        console.log(`job=${status.jobName}`);
        console.log(`status=${status.status}`);
        console.log(`iterations=${status.iterations}`);
        console.log(`checks=${status.checks.total} total, ${status.checks.failed} failed`);
        if (status.reason) console.log(`reason=${status.reason}`);
        if (status.status !== "completed" && status.lastSummary) console.log(`lastSummary=${status.lastSummary}`);
        if (status.failedCheck) {
          console.log(`failedCheck=${status.failedCheck.command} (exit ${status.failedCheck.exitCode})`);
          if (status.failedCheck.detail) console.log(`checkOutput=${status.failedCheck.detail}`);
        }
      }
      return 0;
    case "trace":
      {
        const trace = await readTrace(target);
        console.log(`events=${trace.totalEvents}`);
        console.log(`types=${trace.eventTypes.join(",")}`);
        console.log(`first=${trace.firstAt ?? ""}`);
        console.log(`last=${trace.lastAt ?? ""}`);
      }
      return 0;
    case "remote": {
      const unsupported = rest.find((arg) => arg.startsWith("--") && arg !== "--repo" && arg !== "--ref" && arg !== "--resume-from");
      if (unsupported) {
        console.error(`${unsupported} is not supported by remote; configure the pushed job and GitHub Actions variables instead`);
        return 1;
      }
      const resumeIndex = rest.indexOf("--resume-from");
      const resumeRunId = resumeIndex < 0 ? undefined : rest[resumeIndex + 1];
      if (resumeIndex >= 0 && (!resumeRunId || !/^[1-9]\d*$/.test(resumeRunId))) {
        console.error("--resume-from requires a positive GitHub Actions run ID");
        return 1;
      }
      const remoteArgs = resumeIndex < 0 ? rest : rest.filter((_, index) => index !== resumeIndex && index !== resumeIndex + 1);
      const runArgs = parseRunArgs(remoteArgs);
      if (runArgs instanceof Error) {
        console.error(runArgs.message);
        return 1;
      }
      let repo = runArgs.repo;
      let ref = runArgs.ref;
      if (!repo || !ref) {
        const inferred = await inferGitContext();
        repo ??= inferred.repo;
        ref ??= inferred.ref;
      }
      const result = await runRemoteJob({ repo, ref, jobPath: target, resumeRunId });
      console.log(`RalphWorks remote ${result.status}`);
      console.log(`runUrl=${result.runUrl}`);
      console.log(`artifactDir=${result.artifactDir}`);
      if (result.reason) console.log(`reason=${result.reason}`);
      return result.status === "completed" ? 0 : 1;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error("");
      console.error(USAGE.trimEnd());
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${message(error)}`);
  process.exitCode = 1;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
