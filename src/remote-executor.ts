import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
type Command = (args: string[], timeoutMs: number) => Promise<CommandResult>;
const DEFAULT_TOTAL_MINUTES = 120;

export type RemoteResult = {
  runId: number;
  runUrl: string;
  artifactDir: string;
  status: string;
  reason?: string;
};

export async function runRemoteJob(options: {
  repo: string;
  ref: string;
  jobPath: string;
  resumeRunId?: string;
  totalMinutes?: number;
  cwd?: string;
  command?: Command;
}): Promise<RemoteResult> {
  const command = options.command ?? gh;
  const totalMinutes = options.totalMinutes ?? DEFAULT_TOTAL_MINUTES;
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0 || totalMinutes > 1440) {
    throw new Error("total execution minutes must be between 0 and 1440");
  }
  const deadline = Date.now() + totalMinutes * 60_000;
  const call = (args: string[]): Promise<CommandResult> => {
    const remaining = deadline - Date.now();
    return remaining <= 0
      ? Promise.resolve({ exitCode: 124, stdout: "", stderr: "remote execution deadline reached", timedOut: true })
      : command(args, remaining);
  };
  const requestId = randomUUID();
  const repoArgs = ["--repo", options.repo];
  const dispatched = await call([
    "workflow",
    "run",
    "ralphworks.yml",
    ...repoArgs,
    "--ref",
    options.ref,
    "-f",
    `task=${options.jobPath}`,
    "-f",
    `request_id=${requestId}`,
    ...(options.resumeRunId ? ["-f", `resume_run_id=${options.resumeRunId}`] : []),
  ]);
  if (dispatched.exitCode !== 0) throw new Error(`remote dispatch failed: ${dispatched.stderr || dispatched.stdout}`);
  let runId = Number(/\/actions\/runs\/(\d+)/.exec(dispatched.stdout)?.[1]);
  if (!runId) {
    for (let attempt = 0; attempt < 18 && !runId; attempt += 1) {
      const waitMs = Math.min(5_000, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const listed = await call([
        "run",
        "list",
        ...repoArgs,
        "--workflow",
        "ralphworks.yml",
        "--branch",
        options.ref,
        "--event",
        "workflow_dispatch",
        "--limit",
        "20",
        "--json",
        "databaseId,displayTitle",
      ]);
      if (listed.timedOut) break;
      if (listed.exitCode !== 0) continue;
      const runs = JSON.parse(listed.stdout) as Array<{ databaseId: number; displayTitle: string }>;
      runId = runs.find((run) => run.displayTitle.includes(requestId))?.databaseId ?? 0;
    }
  }
  if (!runId) {
    const reason =
      Date.now() >= deadline
        ? "remote execution deadline reached before the run was found"
        : "remote run was dispatched but could not be found";
    throw new Error(`${reason}; request_id=${requestId}`);
  }
  const runUrl = `https://github.com/${options.repo}/actions/runs/${runId}`;
  const watched = await call(["run", "watch", String(runId), ...repoArgs, "--exit-status", "--interval", "10"]);
  const artifactDir = join(options.cwd ?? process.cwd(), ".ralph", "remote", String(runId));
  await mkdir(artifactDir, { recursive: true });
  if (watched.timedOut) {
    const cancelled = await command(["run", "cancel", String(runId), ...repoArgs], 15_000);
    return {
      runId,
      runUrl,
      artifactDir,
      status: "timed_out",
      reason: `remote execution exceeded ${totalMinutes} minutes; ${cancelled.exitCode === 0 ? "cancellation requested" : "cancellation failed; inspect the run"}`,
    };
  }
  const downloaded = await call(["run", "download", String(runId), ...repoArgs, "--name", "ralphworks-result", "--dir", artifactDir]);
  if (downloaded.timedOut) {
    return { runId, runUrl, artifactDir, status: "timed_out", reason: `result download exceeded ${totalMinutes} minutes` };
  }
  const resultPath = downloaded.exitCode === 0 ? await findResult(artifactDir) : undefined;
  const result = resultPath ? (JSON.parse(await readFile(resultPath, "utf8")) as { status?: string; reason?: string }) : undefined;
  const status = watched.exitCode !== 0 && result?.status === "completed" ? "failed" : (result?.status ?? "failed");
  const reason =
    result?.reason ?? (watched.exitCode !== 0 && (!result || result.status === "completed") ? "GitHub Actions run failed" : undefined);
  return {
    runId,
    runUrl,
    artifactDir,
    status,
    ...(reason ? { reason } : {}),
  };
}

async function findResult(dir: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === "result.json") return path;
    if (entry.isDirectory()) {
      const found = await findResult(path);
      if (found) return found;
    }
  }
  return undefined;
}

async function gh(args: string[], timeoutMs: number): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const value = error as { code?: number | string; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
    const timedOut = value.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && value.killed === true && value.signal === "SIGKILL";
    return {
      exitCode: timedOut ? 124 : typeof value.code === "number" ? value.code : 1,
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}
