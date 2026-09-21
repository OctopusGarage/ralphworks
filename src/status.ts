import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export type RunStatusSummary = {
  jobName: string;
  status: string;
  iterations: number;
  runDir: string;
  reason?: string;
  failedCheck?: { command: string; exitCode: number; detail: string };
  checks: {
    total: number;
    failed: number;
  };
};

type ResultJson = {
  jobName: string;
  status: string;
  iterations: number;
  runDir: string;
  reason?: string;
  checks?: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>;
};

export async function readRunStatus(target: string): Promise<RunStatusSummary> {
  const runDir = await resolveRunDir(target);
  const raw = JSON.parse(await readFile(join(runDir, "result.json"), "utf8")) as ResultJson;
  const checks = raw.checks ?? [];
  const failedCheck = checks.findLast((check) => check.exitCode !== 0);
  return {
    jobName: raw.jobName,
    status: raw.status,
    iterations: raw.iterations,
    runDir,
    ...(raw.reason ? { reason: raw.reason } : {}),
    ...(failedCheck ? { failedCheck: {
      command: failedCheck.command,
      exitCode: failedCheck.exitCode,
      detail: (failedCheck.stderr || failedCheck.stdout || "").trim().slice(-1000),
    } } : {}),
    checks: {
      total: checks.length,
      failed: checks.filter((check) => check.exitCode !== 0).length,
    },
  };
}

async function resolveRunDir(target: string): Promise<string> {
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    return target;
  }
  const pointer = (await readFile(target, "utf8")).trim();
  return isAbsolute(pointer) ? pointer : join(dirname(target), pointer);
}
