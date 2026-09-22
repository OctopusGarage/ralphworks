import { spawn } from "node:child_process";

import { redactSensitiveValues } from "./redact.ts";

export type CheckResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
};

export function runCheck(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
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
      if (stream === "stdout") stdout = (stdout + chunk.toString()).slice(-8192);
      else stderr = (stderr + chunk.toString()).slice(-8192);
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
        stdout: redactSensitiveValues(stdout),
        stderr: redactSensitiveValues(error ? `${stderr}\n${error.message}`.trim() : stderr),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      });
    });
  });
}
