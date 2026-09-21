import { join } from "node:path";

import type { RalphJob } from "./job.ts";
import { redactSensitiveValues } from "./redact.ts";
import type { ModelRef } from "./run-args.ts";
import type { AgentRunner, IterationResult, RunnerEvent } from "./runner.ts";

export type PiSessionEvent = {
  type: string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  toolName?: string;
  isError?: boolean;
};

type PiSessionLike = {
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  waitForIdle?: () => Promise<void>;
  dispose?: () => void;
  abort?: () => Promise<void>;
  getSessionStats?: () => { cost: number };
};

type PiSdkRunnerOptions = {
  modelRef?: ModelRef;
  piAgentDir?: string;
  createSession?: (input: { cwd: string; modelRef?: ModelRef; piAgentDir?: string }) => Promise<PiSessionLike>;
};

export class PiSdkRunner implements AgentRunner {
  #createSession: (input: { cwd: string; modelRef?: ModelRef; piAgentDir?: string }) => Promise<PiSessionLike>;
  #modelRef: ModelRef | undefined;
  #piAgentDir: string | undefined;

  constructor(options: PiSdkRunnerOptions = {}) {
    this.#createSession = options.createSession ?? createDefaultPiSession;
    this.#modelRef = options.modelRef;
    this.#piAgentDir = options.piAgentDir;
  }

  async runIteration(input: {
    job: RalphJob;
    iteration: number;
    cwd: string;
    progress?: string;
    signal?: AbortSignal;
  }): Promise<IterationResult> {
    const session = await this.#createSession({
      cwd: input.cwd,
      ...(this.#modelRef ? { modelRef: this.#modelRef } : {}),
      ...(this.#piAgentDir ? { piAgentDir: this.#piAgentDir } : {}),
    });
    const events: RunnerEvent[] = [];
    let output = "";
    let currentAssistantText = "";
    let lastAssistantText = "";
    const assistantErrors: string[] = [];
    const abort = () => {
      void session.abort?.().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const unsubscribe = session.subscribe((event) => {
      const normalized = normalizePiEvent(event);
      if (normalized && events.length < 1000) {
        events.push(normalized);
      }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta ?? "";
        output = (output + delta).slice(-4096);
        currentAssistantText = (currentAssistantText + delta).slice(-4096);
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        if (currentAssistantText.trim()) lastAssistantText = currentAssistantText;
        currentAssistantText = "";
      }
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
        const errorMessage = redactSensitiveValues(event.message.errorMessage ?? "Pi assistant stopped with an error");
        assistantErrors.push(errorMessage);
        output = (output + errorMessage).slice(-4096);
      }
    });

    try {
      await session.prompt(buildRalphPrompt(input.job, input.iteration, input.progress ?? ""));
      await session.waitForIdle?.();
    } finally {
      unsubscribe();
      input.signal?.removeEventListener("abort", abort);
      session.dispose?.();
    }

    const blocked = assistantErrors.length > 0;
    const handoff = lastAssistantText || currentAssistantText;
    const inputRequest = handoff.match(/(?:^|\n)<needs-input>([\s\S]*?)<\/needs-input>\s*$/u)?.[1]?.trim();
    return {
      status: blocked ? "blocked" : inputRequest ? "needs_input" : "continue",
      summary: blocked
        ? `Pi iteration ${input.iteration} blocked: ${assistantErrors.at(-1)}`
        : redactSensitiveValues(inputRequest ? inputRequest.slice(0, 600) : summarizeAssistant(handoff, input.iteration)),
      output: redactSensitiveValues(output),
      events,
      costUsd: session.getSessionStats?.().cost,
    };
  }
}

function buildRalphPrompt(job: RalphJob, iteration: number, progress: string): string {
  const completion = job.completionPromise
    ? `When the task is genuinely complete, output <promise>${job.completionPromise}</promise>.`
    : "No completion promise is configured; continue until the orchestrator stops the loop.";

  return [
    "You are running inside RalphWorks, a controlled Ralph loop orchestrator.",
    "",
    `Job: ${job.name}`,
    `Iteration: ${iteration}`,
    "",
    "Task:",
    job.task,
    "",
    "Progress from previous iterations:",
    progress || "(none)",
    "",
    "Rules:",
    "- If the task has several items, use saved progress to identify the highest-priority unfinished item and work on one useful increment.",
    "- If a check failed, address its feedback from progress before claiming completion.",
    "- Use the task's acceptance criteria to decide what remains; do not treat an attempted change as completion.",
    "- Preserve existing user changes.",
    "- Do not make Git commits; RalphWorks handles verified commits after checks.",
    "- Run relevant checks when possible.",
    "- End with a concise handoff: item addressed, evidence from checks, files changed, and the next unfinished item or blocker.",
    "- Investigate questions you can resolve yourself. If a decision or missing information genuinely requires a person, end with <needs-input>one concrete question and the relevant findings</needs-input>. Do not claim completion.",
    "- Do not claim completion unless the completion promise is true.",
    completion,
  ].join("\n");
}

function summarizeAssistant(message: string, iteration: number): string {
  const summary = message
    .replace(/<promise>[^<]*<\/promise>\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return summary ? summary.slice(-600) : `Pi iteration ${iteration} finished without a text handoff`;
}

function normalizePiEvent(event: PiSessionEvent): RunnerEvent | undefined {
  if (event.type === "tool_execution_start") {
    return {
      type: "pi_tool_start",
      details: { toolName: event.toolName ?? "unknown" },
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "pi_tool_end",
      details: { toolName: event.toolName ?? "unknown", isError: event.isError === true },
    };
  }
  if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
    return {
      type: "pi_assistant_error",
      details: {
        provider: event.message.provider ?? "unknown",
        model: event.message.model ?? "unknown",
        errorMessage: redactSensitiveValues(event.message.errorMessage ?? "Pi assistant stopped with an error").slice(0, 500),
      },
    };
  }
  return undefined;
}

async function createDefaultPiSession(input: { cwd: string; modelRef?: ModelRef; piAgentDir?: string }): Promise<PiSessionLike> {
  const { createAgentSession, ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const modelRuntime =
    input.modelRef || input.piAgentDir
      ? await ModelRuntime.create(
          input.piAgentDir
            ? {
                authPath: join(input.piAgentDir, "auth.json"),
                modelsPath: join(input.piAgentDir, "models.json"),
                modelsStorePath: join(input.piAgentDir, "models-store.json"),
              }
            : undefined,
        )
      : undefined;
  const model = input.modelRef ? modelRuntime?.getModel(input.modelRef.provider, input.modelRef.id) : undefined;
  if (input.modelRef && !model) {
    throw new Error(`Pi model not found: ${input.modelRef.provider}/${input.modelRef.id}`);
  }
  const { session } = await createAgentSession({
    cwd: input.cwd,
    sessionManager: SessionManager.create(input.cwd),
    ...(modelRuntime ? { modelRuntime } : {}),
    ...(model ? { model } : {}),
  });
  return session as PiSessionLike;
}
