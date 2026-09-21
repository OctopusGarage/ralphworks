import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { commitVerifiedChanges, currentGitHead, verifyCleanGitWorkspace, workspaceFingerprint } from "./git-transaction.ts";
import { defaultProgressFile, loadJob, type RalphJob } from "./job.ts";
import type { JobOverrides } from "./run-args.ts";
import { withRunLock } from "./run-lock.ts";
import { type AgentRunner, DryRunRunner, type IterationResult } from "./runner.ts";

type RunStatus = "completed" | "blocked" | "cancelled" | "max_iterations" | "timed_out" | "budget_exhausted" | "failed";

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
  const job = await loadJob((await exists(resolvedJobPath)) ? resolvedJobPath : jobPath);
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
    const originalTask = job.task;
    if (job.promptFile) {
      job.task += `\n\n${await readFile(resolvePath(cwd, job.promptFile), "utf8")}`;
    }
    if (options.contexts?.length) job.task += await loadContexts(cwd, options.contexts);
    if (job.progressFile === defaultProgressFile(job.name, originalTask)) {
      job.progressFile = defaultProgressFile(job.name, job.task);
    }
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
        for (const runnerEvent of iterationResult.events ?? []) {
          await appendEvent(eventsPath, { ...event(runnerEvent.type, job, iteration), details: runnerEvent.details });
        }
        lastSummary = iterationResult.summary.slice(0, 600);
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
      const output = `${check.stdout}\n${check.stderr}`.trim().slice(-2000) || "(no output)";
      return `  - ${check.command}${check.timedOut ? " (timed out)" : ""}:\n${output
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`;
    });
  await writeFile(
    path,
    `\n- Iteration ${iteration}: ${status}; ${summary}; checks: ${checkText}\n${failures.length ? `  Check failures:\n${failures.join("\n")}\n` : ""}`,
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
  await writeFile(eventsPath, JSON.stringify(item) + "\n", { encoding: "utf8", flag: "a" });
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

async function loadContexts(cwd: string, sources: string[]): Promise<string> {
  const files: string[] = [];
  for (const source of sources) {
    const absolute = resolvePath(cwd, source);
    const info = await stat(absolute);
    if (info.isFile()) files.push(absolute);
    else if (info.isDirectory()) await collectContextFiles(absolute, files);
    else throw new Error(`Context source must be a file or directory: ${source}`);
  }
  if (files.length > 100) throw new Error("Context sources contain more than 100 files; narrow the context paths");
  let total = 0;
  const sections: string[] = [];
  for (const file of files.sort()) {
    const content = await readFile(file);
    if (content.includes(0)) continue;
    total += content.length;
    if (total > 1024 * 1024) throw new Error("Context sources exceed 1 MiB; narrow the context paths");
    sections.push(`\n\nContext file: ${relative(cwd, file)}\n\n${content.toString("utf8")}`);
  }
  return sections.join("");
}

async function collectContextFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".ralph", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectContextFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
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

type CheckResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
};

type CheckRecord = CheckResult & {
  iteration: number;
};

function runCheck(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
  return new Promise((resolveCheck) => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let error: Error | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) error = cause as Error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 1000);
    }, timeoutMs);
    const abort = () => {
      cancelled = true;
      clearTimeout(timer);
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), 1000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdout = (stdout + chunk.toString()).slice(0, 1024 * 1024);
      else stderr = (stderr + chunk.toString()).slice(0, 1024 * 1024);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      resolveCheck({
        command,
        exitCode: code ?? 1,
        stdout,
        stderr: error ? `${stderr}\n${error.message}`.trim() : stderr,
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      });
    });
  });
}

function completionPromiseSatisfied(completionPromise: string | undefined, output: string): boolean {
  if (!completionPromise) {
    return false;
  }
  return output.trimEnd().endsWith(`<promise>${completionPromise}</promise>`);
}
