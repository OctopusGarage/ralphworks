import { PiSdkRunner } from "./pi-runner.ts";
import type { RalphJob } from "./job.ts";
import type { ModelRef } from "./run-args.ts";

type WorkerInput = {
  job: RalphJob;
  iteration: number;
  cwd: string;
  progress: string;
  options: { modelRef?: ModelRef; piAgentDir?: string };
};

process.once("message", async (input: WorkerInput) => {
  try {
    const runner = new PiSdkRunner(input.options);
    const result = await runner.runIteration({ ...input, signal: new AbortController().signal });
    process.send?.({ result }, () => process.exit(0));
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
