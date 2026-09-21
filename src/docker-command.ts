import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TOTAL_MINUTES = 120;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

export async function runDockerContainer(
  args: string[],
  totalMinutes = DEFAULT_TOTAL_MINUTES,
  runCommand: RunCommand = defaultRunCommand,
): Promise<CommandResult> {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0 || totalMinutes > 1440) {
    throw new Error("total execution minutes must be between 0 and 1440");
  }
  const name = `ralphworks-${process.pid}-${randomUUID().slice(0, 8)}`;
  const timeoutMs = totalMinutes * 60_000;
  const result = await runCommand("docker", [...args.slice(0, 2), "--name", name, ...args.slice(2)], timeoutMs);
  if (!result.timedOut) return result;

  const cleanup = await runCommand("docker", ["rm", "--force", name], 15_000);
  return {
    ...result,
    exitCode: 124,
    stderr: [
      result.stderr,
      `Docker execution exceeded ${totalMinutes} minutes`,
      cleanup.exitCode === 0 ? "" : `Container cleanup failed: ${name}: ${cleanup.stderr}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function defaultRunCommand(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs, killSignal: "SIGKILL" });
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
