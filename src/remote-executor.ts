import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type Command = (args: string[]) => Promise<CommandResult>;

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
  cwd?: string;
  command?: Command;
}): Promise<RemoteResult> {
  const command = options.command ?? gh;
  const requestId = randomUUID();
  const repoArgs = ["--repo", options.repo];
  const dispatched = await command(["workflow", "run", "ralphworks.yml", ...repoArgs, "--ref", options.ref,
    "-f", `task=${options.jobPath}`, "-f", `request_id=${requestId}`,
    ...(options.resumeRunId ? ["-f", `resume_run_id=${options.resumeRunId}`] : [])]);
  if (dispatched.exitCode !== 0) throw new Error(`remote dispatch failed: ${dispatched.stderr || dispatched.stdout}`);
  let runId = Number(/\/actions\/runs\/(\d+)/.exec(dispatched.stdout)?.[1]);
  if (!runId) {
    for (let attempt = 0; attempt < 18 && !runId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const listed = await command(["run", "list", ...repoArgs, "--workflow", "ralphworks.yml", "--branch", options.ref,
        "--event", "workflow_dispatch", "--limit", "20", "--json", "databaseId,displayTitle"]);
      if (listed.exitCode !== 0) continue;
      const runs = JSON.parse(listed.stdout) as Array<{ databaseId: number; displayTitle: string }>;
      runId = runs.find((run) => run.displayTitle.includes(requestId))?.databaseId ?? 0;
    }
  }
  if (!runId) throw new Error(`remote run was dispatched but could not be found; request_id=${requestId}`);
  const runUrl = `https://github.com/${options.repo}/actions/runs/${runId}`;
  const watched = await command(["run", "watch", String(runId), ...repoArgs, "--exit-status", "--interval", "10"]);
  const artifactDir = join(options.cwd ?? process.cwd(), ".ralph", "remote", String(runId));
  await mkdir(artifactDir, { recursive: true });
  const downloaded = await command(["run", "download", String(runId), ...repoArgs, "--name", "ralphworks-result", "--dir", artifactDir]);
  const resultPath = downloaded.exitCode === 0 ? await findResult(artifactDir) : undefined;
  const result = resultPath ? JSON.parse(await readFile(resultPath, "utf8")) as { status?: string; reason?: string } : undefined;
  const status = watched.exitCode !== 0 && result?.status === "completed" ? "failed" : result?.status ?? "failed";
  const reason = result?.reason ?? (watched.exitCode !== 0 && (!result || result.status === "completed") ? "GitHub Actions run failed" : undefined);
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

async function gh(args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof value.code === "number" ? value.code : 1, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
  }
}
