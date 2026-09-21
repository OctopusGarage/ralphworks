import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { RalphJob } from "./job.ts";
import type { ModelRef } from "./run-args.ts";
import type { AgentRunner, IterationResult } from "./runner.ts";

type WorkerReply = { result: IterationResult } | { error: string };

export class PiProcessRunner implements AgentRunner {
  private readonly options: { modelRef?: ModelRef; piAgentDir?: string; workerPath?: string };

  constructor(options: { modelRef?: ModelRef; piAgentDir?: string; workerPath?: string } = {}) {
    this.options = options;
  }

  runIteration(input: { job: RalphJob; iteration: number; cwd: string; progress: string; signal: AbortSignal }): Promise<IterationResult> {
    const workerPath = this.options.workerPath ?? fileURLToPath(new URL(`./pi-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
    return new Promise((resolve, reject) => {
      const child = fork(workerPath, [], { cwd: input.cwd, detached: process.platform !== "win32", execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let reply: WorkerReply | undefined;
      let diagnostics = "";
      let killed = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) diagnostics += String(error);
        }
      };
      const abort = () => {
        killed = true;
        kill("SIGTERM");
        forceTimer = setTimeout(() => kill("SIGKILL"), 1000);
      };
      child.stdout?.resume();
      child.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
      child.on("message", (message) => { reply = message as WorkerReply; });
      child.on("error", (error) => { diagnostics = `${diagnostics}\n${error.message}`; });
      child.on("close", (code) => {
        input.signal.removeEventListener("abort", abort);
        if (forceTimer) clearTimeout(forceTimer);
        if (killed) { kill("SIGKILL"); reject(new Error("Pi iteration aborted")); return; }
        if (reply && "result" in reply && code === 0) { resolve(reply.result); return; }
        reject(new Error(reply && "error" in reply ? reply.error : `Pi worker exited ${code ?? "without a code"}: ${diagnostics.trim()}`));
      });
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else child.send({ ...input, signal: undefined, options: this.options });
    });
  }
}
