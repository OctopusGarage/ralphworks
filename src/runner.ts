import type { RalphJob } from "./job.ts";

export type IterationResult = {
  status: "continue" | "complete" | "blocked" | "needs_input";
  summary: string;
  output?: string;
  events?: RunnerEvent[];
  costUsd?: number;
};

export type RunnerEvent = {
  type: string;
  details: Record<string, unknown>;
};

export interface AgentRunner {
  runIteration(input: { job: RalphJob; iteration: number; cwd: string; progress: string; signal: AbortSignal }): Promise<IterationResult>;
}

export class DryRunRunner implements AgentRunner {
  async runIteration(input: {
    job: RalphJob;
    iteration: number;
    cwd: string;
    progress: string;
    signal: AbortSignal;
  }): Promise<IterationResult> {
    return {
      status: "continue",
      summary: `Dry run iteration ${input.iteration} for ${input.job.name}`,
    };
  }
}
