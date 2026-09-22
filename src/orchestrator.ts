import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { type CheckResult, runCheck } from "./check-runner.ts";
import { commitVerifiedChanges, currentGitHead, verifyCleanGitWorkspace, workspaceFingerprint } from "./git-transaction.ts";
import { loadJob, prepareJob, type RalphJob } from "./job.ts";
import { redactSensitiveValues } from "./redact.ts";
import type { JobOverrides } from "./run-args.ts";
import { withRunLock } from "./run-lock.ts";
import { type AgentRunner, DryRunRunner, type IterationResult } from "./runner.ts";

type RunStatus = "completed" | "blocked" | "needs_input" | "cancelled" | "max_iterations" | "timed_out" | "budget_exhausted" | "failed";

export type RalphRunResult = {
  jobName: string;
  status: RunStatus;
  iterations: number;
  runDir: string;
  eventsPath: string;
  resultPath: string;
  checks: CheckRecord[];
  costUsd: number;
  commits: string[];
  reason?: string;
  lastSummary?: string;
};

type RunOptions = {
  cwd?: string;
  runner?: AgentRunner;
  unattended?: boolean;
  signal?: AbortSignal;
  checksOverride?: string[];
  contexts?: string[];
  jobOverrides?: JobOverrides;
};

type RalphEvent = {
  type: string;
  at: string;
  job: string;
  iteration?: number;
  summary?: string;
  status?: string;
  details?: Record<string, unknown>;
};

export async function runLocalJob(jobPath: string, options: RunOptions = {}): Promise<RalphRunResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  return withRunLock(cwd, () => runLocalJobUnlocked(jobPath, options, cwd));
}

async function runLocalJobUnlocked(jobPath: string, options: RunOptions, cwd: string): Promise<RalphRunResult> {
  const resolvedJobPath = resolvePath(cwd, jobPath);
  let job = await loadJob((await exists(resolvedJobPath)) ? resolvedJobPath : jobPath);
  if (options.checksOverride) job.checks = options.checksOverride;
  applyJobOverrides(job, options.jobOverrides);
  job.maxMinutes ??= 30;
  if (options.unattended ?? (process.env.RALPHWORKS_UNATTENDED === "1" || process.env.GITHUB_ACTIONS === "true")) {
    job.maxCostUsd ??= 3;
  }
  const runner = options.runner ?? new DryRunRunner();

  const runDir = join(cwd, ".ralph", "runs", `${slug(job.name)}-${timestamp()}`);
  const eventsPath = join(runDir, "events.jsonl");
  const resultPath = join(runDir, "result.json");

  await mkdir(runDir, { recursive: true });

  let status: RunStatus = "max_iterations";
  let iterations = 0;
  const checks: CheckRecord[] = [];
  const commits: string[] = [];
  let costUsd = 0;
  let reason: string | undefined;
  let lastSummary: string | undefined;
  try {
    job = await prepareJob(job, cwd, options.contexts ?? []);
    await ensureProgressFile(cwd, job);
    await appendEvent(eventsPath, event("run_started", job));
    const deadline = job.maxMinutes === undefined ? undefined : Date.now() + job.maxMinutes * 60_000;
    const progressPath = resolvePath(cwd, job.progressFile);
    let previousFingerprint = await workspaceFingerprint(cwd);
    let stalledIterations = 0;

    if (job.commit === "verified") {
      reason = await verifyCleanGitWorkspace(cwd);
      if (reason) status = "blocked";
      if (job.checks.length === 0) {
        status = "blocked";
        reason = "checks are required for verified commits";
      }
    }

    if (!reason) {
      for (let iteration = 1; iteration <= job.maxIterations; iteration += 1) {
        if (options.signal?.aborted) {
          status = "cancelled";
          reason = interruptionReason(options.signal);
          break;
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          status = "timed_out";
          reason = "wall clock budget exhausted";
          break;
        }
        if (job.maxCostUsd !== undefined && costUsd >= job.maxCostUsd) {
          status = "budget_exhausted";
          reason = "cost budget exhausted";
          break;
        }
        iterations = iteration;
        await appendEvent(eventsPath, event("iteration_started", job, iteration));
        const headBefore = await currentGitHead(cwd);
        const controller = new AbortController();
        const abortIteration = () => controller.abort();
        options.signal?.addEventListener("abort", abortIteration, { once: true });
        if (options.signal?.aborted) abortIteration();
        let iterationResult: IterationResult;
        try {
          iterationResult = await runWithDeadline(
            runner,
            {
              job,
              iteration,
              cwd,
              progress: await readProgressForPrompt(progressPath),
              signal: controller.signal,
            },
            controller,
            deadline,
          );
        } catch (error) {
          status = options.signal?.aborted ? "cancelled" : controller.signal.aborted ? "timed_out" : "failed";
          reason = status === "cancelled" ? interruptionReason(options.signal) : error instanceof Error ? error.message : String(error);
          await appendProgress(progressPath, iteration, reason, status, []);
          await appendEvent(eventsPath, { ...event("iteration_finished", job, iteration), status, summary: reason });
          break;
        } finally {
          options.signal?.removeEventListener("abort", abortIteration);
        }
        const runnerEvents = iterationResult.events ?? [];
        for (const runnerEvent of runnerEvents.slice(0, 1000)) {
          await appendEvent(eventsPath, { ...event(runnerEvent.type, job, iteration), details: runnerEvent.details });
        }
        if (runnerEvents.length > 1000) {
          await appendEvent(eventsPath, {
            ...event("runner_events_omitted", job, iteration),
            details: { count: runnerEvents.length - 1000 },
          });
        }
        lastSummary = redactSensitiveValues(iterationResult.summary).slice(0, 600);
        costUsd += iterationResult.costUsd ?? 0;
        if (options.signal?.aborted) {
          status = "cancelled";
          reason = interruptionReason(options.signal);
        } else if (controller.signal.aborted || (deadline !== undefined && Date.now() >= deadline)) {
          status = "timed_out";
          reason = "wall clock budget exhausted";
        } else if (job.maxCostUsd !== undefined && costUsd > job.maxCostUsd) {
          status = "budget_exhausted";
          reason = "cost budget exhausted";
        }
        if (!reason && headBefore && (await currentGitHead(cwd)) !== headBefore) {
          status = "blocked";
          reason = "agent changed Git HEAD; RalphWorks must own commits after checks";
        }
        if (!reason && iterationResult.status === "needs_input") {
          status = "needs_input";
          reason = lastSummary;
        }
        const checkResults: CheckResult[] = [];
        if (!reason) {
          for (const command of job.checks) {
            await appendEvent(eventsPath, { ...event("check_started", job, iteration), details: { command } });
            const remaining = deadline === undefined ? Infinity : Math.max(1, deadline - Date.now());
            const checkResult = await runCheck(command, cwd, Math.min(job.checkTimeoutSeconds * 1000, remaining), options.signal);
            checkResults.push(checkResult);
            checks.push({ iteration, ...checkResult });
            await appendEvent(eventsPath, { ...event("check_finished", job, iteration), details: checkResult });
            if (checkResult.cancelled) {
              status = "cancelled";
              reason = interruptionReason(options.signal);
              break;
            }
            if (checkResult.timedOut) {
              status = "timed_out";
              reason = `check timed out: ${command}`;
              break;
            }
          }
        }
        const checksPassed = checkResults.length === job.checks.length && checkResults.every((check) => check.exitCode === 0);
        if (!reason && options.signal?.aborted) {
          status = "cancelled";
          reason = interruptionReason(options.signal);
        }
        if (!reason && iterationResult.status === "blocked") {
          status = "blocked";
          reason = iterationResult.summary;
        }
        if (!reason && checksPassed && job.commit === "verified") {
          try {
            const commit = await commitVerifiedChanges(cwd, job.name, iteration);
            if (commit) commits.push(commit);
          } catch (error) {
            status = "failed";
            reason = `verified commit failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const completionRequested =
          iterationResult.status === "complete" || completionPromiseSatisfied(job.completionPromise, iterationResult.output ?? "");
        if (!reason && !completionRequested) {
          const currentFingerprint = await workspaceFingerprint(cwd);
          if (currentFingerprint && previousFingerprint === currentFingerprint) stalledIterations += 1;
          else stalledIterations = 0;
          previousFingerprint = currentFingerprint;
          if (stalledIterations >= 2) {
            status = "blocked";
            reason = "no workspace progress for two iterations";
          }
        }
        const iterationStatus = reason ? status : completionRequested && checksPassed ? "complete" : "continue";
        await appendProgress(progressPath, iteration, iterationResult.summary, iterationStatus, checkResults);
        await appendEvent(eventsPath, {
          ...event("iteration_finished", job, iteration),
          status: iterationStatus,
          summary: iterationResult.summary,
        });
        if (reason) break;
        if (iterationStatus === "complete") {
          status = "completed";
          break;
        }
      }
      if (status === "max_iterations" && !reason)
        reason = `iteration limit reached after ${iterations} ${iterations === 1 ? "iteration" : "iterations"}`;
    }
  } catch (error) {
    status = "failed";
    reason = error instanceof Error ? error.message : String(error);
    await appendEvent(eventsPath, { ...event("run_failed", job), status, summary: reason }).catch(() => undefined);
  }

  if (reason) reason = redactSensitiveValues(reason);
  const result: RalphRunResult = {
    jobName: job.name,
    status,
    iterations,
    runDir,
    eventsPath,
    resultPath,
    checks,
    costUsd,
    commits,
    ...(reason ? { reason } : {}),
    ...(lastSummary ? { lastSummary } : {}),
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(join(cwd, ".ralph", "current"), join("runs", basename(runDir)) + "\n", "utf8");
  return result;
}

async function appendProgress(path: string, iteration: number, summary: string, status: string, checks: CheckResult[]): Promise<void> {
  const checkText = checks.length ? checks.map((check) => `${check.command}: ${check.exitCode}`).join("; ") : "none";
  const failures = checks
    .filter((check) => check.exitCode !== 0 || check.timedOut)
    .map((check) => {
      const output = redactSensitiveValues(`${check.stdout}\n${check.stderr}`).trim().slice(-2000) || "(no output)";
      return `  - ${check.command}${check.timedOut ? " (timed out)" : ""}:\n${output
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`;
    });
  await writeFile(
    path,
    `\n- Iteration ${iteration}: ${status}; ${redactSensitiveValues(summary)}; checks: ${checkText}\n${failures.length ? `  Check failures:\n${failures.join("\n")}\n` : ""}`,
    { flag: "a" },
  );
}

export async function readProgressForPrompt(path: string, maxCharacters = 12_000): Promise<string> {
  const full = await readFile(path, "utf8");
  if (full.length <= maxCharacters) return full;
  const header = full.slice(0, Math.min(200, Math.floor(maxCharacters / 4)));
  const marker = "\n\n[Older progress omitted; full history remains in the progress file.]\n\n";
  const tail = full.slice(-(maxCharacters - header.length - marker.length));
  return `${header}${marker}${tail.slice(Math.max(0, tail.indexOf("\n") + 1))}`;
}

async function runWithDeadline(
  runner: AgentRunner,
  input: Parameters<AgentRunner["runIteration"]>[0],
  controller: AbortController,
  deadline: number | undefined,
): Promise<IterationResult> {
  if (deadline === undefined) return runner.runIteration(input);
  const remaining = Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const result = await runner.runIteration(input);
    if (controller.signal.aborted) throw new Error("wall clock budget exhausted");
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

async function ensureProgressFile(cwd: string, job: RalphJob): Promise<void> {
  const progressPath = resolvePath(cwd, job.progressFile);
  try {
    await readFile(progressPath, "utf8");
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await mkdir(dirname(progressPath), { recursive: true });
    await writeFile(
      progressPath,
      [`# RalphWorks Progress`, "", `Job: ${job.name}`, "", `- Initialized local loop state.`].join("\n") + "\n",
      "utf8",
    );
  }
}

async function appendEvent(eventsPath: string, item: RalphEvent): Promise<void> {
  const bounded: RalphEvent = {
    ...item,
    ...(item.summary ? { summary: item.summary.slice(0, 1000) } : {}),
    ...(item.details && Buffer.byteLength(JSON.stringify(item.details)) > 2048
      ? { details: { omitted: "event details exceeded 2 KiB" } }
      : {}),
  };
  await writeFile(eventsPath, redactSensitiveValues(JSON.stringify(bounded)) + "\n", { encoding: "utf8", flag: "a" });
}

function event(type: string, job: RalphJob, iteration?: number): RalphEvent {
  return {
    type,
    at: new Date().toISOString(),
    job: job.name,
    ...(iteration === undefined ? {} : { iteration }),
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function interruptionReason(signal: AbortSignal | undefined): string {
  return typeof signal?.reason === "string" ? `run interrupted by ${signal.reason}` : "run interrupted";
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error) => (isNotFound(error) ? false : Promise.reject(error)),
  );
}

function applyJobOverrides(job: RalphJob, overrides: JobOverrides | undefined): void {
  if (!overrides) return;
  if (overrides.maxIterations !== undefined) job.maxIterations = overrides.maxIterations;
  if (overrides.maxMinutes !== undefined) job.maxMinutes = overrides.maxMinutes;
  if (overrides.maxCostUsd !== undefined) job.maxCostUsd = overrides.maxCostUsd;
  if (overrides.checkTimeoutSeconds !== undefined) job.checkTimeoutSeconds = overrides.checkTimeoutSeconds;
  if (overrides.commit !== undefined) job.commit = overrides.commit;
  if (overrides.completionPromise !== undefined) job.completionPromise = overrides.completionPromise;
}

type CheckRecord = CheckResult & {
  iteration: number;
};

function completionPromiseSatisfied(completionPromise: string | undefined, output: string): boolean {
  if (!completionPromise) {
    return false;
  }
  return output.trimEnd().endsWith(`<promise>${completionPromise}</promise>`);
}
