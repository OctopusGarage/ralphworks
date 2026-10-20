import { join } from "node:path";

import type { RalphJob } from "./job.ts";
import { connectMcpTools } from "./mcp-client.ts";
import type { McpBindings } from "./mcp-config.ts";
import { createProfileResourceLoader } from "./pi-resources.ts";
import { redactSensitiveValues } from "./redact.ts";
import type { ModelRef } from "./run-args.ts";
import type { AgentRunner, IterationResult, RunnerEvent } from "./runner.ts";
import { normalizeTaskEnvironment, type TaskEnvironment } from "./task-environment.ts";

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
  dispose?: () => void | Promise<void>;
  environmentEvents?: RunnerEvent[];
  abort?: () => Promise<void>;
  getSessionStats?: () => { cost: number };
};

type SessionInput = {
  cwd: string;
  modelRef?: ModelRef;
  piAgentDir?: string;
  skillPaths?: string[];
  environment?: TaskEnvironment;
  mcpBindings?: McpBindings;
  signal?: AbortSignal;
};

type PiSdkRunnerOptions = {
  environment?: TaskEnvironment;
  mcpBindings?: McpBindings;
  skillPaths?: string[];
  modelRef?: ModelRef;
  piAgentDir?: string;
  createSession?: (input: SessionInput) => Promise<PiSessionLike>;
};

export class PiSdkRunner implements AgentRunner {
  #createSession: (input: SessionInput) => Promise<PiSessionLike>;
  #modelRef: ModelRef | undefined;
  #piAgentDir: string | undefined;
  #skillPaths: string[];
  #environment: TaskEnvironment | undefined;
  #mcpBindings: McpBindings | undefined;

  constructor(options: PiSdkRunnerOptions = {}) {
    this.#createSession = options.createSession ?? createDefaultPiSession;
    this.#modelRef = options.modelRef;
    this.#piAgentDir = options.piAgentDir;
    this.#skillPaths = options.skillPaths ?? [];
    this.#environment = options.environment;
    this.#mcpBindings = options.mcpBindings;
  }

  async runIteration(input: {
    job: RalphJob;
    iteration: number;
    cwd: string;
    progress?: string;
    signal?: AbortSignal;
    environment?: TaskEnvironment;
  }): Promise<IterationResult> {
    const session = await this.#createSession({
      cwd: input.cwd,
      ...((input.environment ?? this.#environment) ? { environment: input.environment ?? this.#environment } : {}),
      ...(this.#mcpBindings ? { mcpBindings: this.#mcpBindings } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(this.#skillPaths.length ? { skillPaths: this.#skillPaths } : {}),
      ...(this.#modelRef ? { modelRef: this.#modelRef } : {}),
      ...(this.#piAgentDir ? { piAgentDir: this.#piAgentDir } : {}),
    });
    const events: RunnerEvent[] = [...(session.environmentEvents ?? [])];
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
      input.signal?.throwIfAborted();
      await session.prompt(buildRalphPrompt(input.job, input.iteration, input.progress ?? ""));
      await session.waitForIdle?.();
    } finally {
      unsubscribe();
      input.signal?.removeEventListener("abort", abort);
      await session.dispose?.();
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

async function createDefaultPiSession(input: SessionInput): Promise<PiSessionLike> {
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
  const environment = input.environment ?? normalizeTaskEnvironment(undefined);
  const resourceLoader = await createProfileResourceLoader({ ...input, skillPaths: input.skillPaths ?? [], environment });
  let mcp: Awaited<ReturnType<typeof connectMcpTools>> | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const release = async () => {
    try {
      if (session) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 2000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          session.dispose();
        }
      }
    } finally {
      try {
        await mcp?.close();
      } finally {
        await resourceLoader.release();
      }
    }
  };
  try {
    mcp = await connectMcpTools(environment.mcp, input.mcpBindings ?? {}, { cwd: input.cwd, signal: input.signal });
    const requested = [...new Set([...environment.tools, ...mcp.tools.map((tool) => tool.name)])];
    const result = await createAgentSession({
      resourceLoader,
      settingsManager: resourceLoader.taskSettings,
      cwd: input.cwd,
      ...(input.piAgentDir ? { agentDir: input.piAgentDir } : {}),
      sessionManager: SessionManager.create(input.cwd),
      ...(modelRuntime ? { modelRuntime } : {}),
      ...(model ? { model } : {}),
      tools: requested,
      customTools: mcp.tools,
    });
    session = result.session;
    const extensionErrors: string[] = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        extensionErrors.push(redactSensitiveValues(JSON.stringify(error)));
      },
    });
    if (extensionErrors.length) throw new Error(`Task extension startup failed: ${extensionErrors.join("; ")}`);
    const available = new Set(session.getAllTools().map((tool) => tool.name));
    for (const name of requested) if (!available.has(name)) throw new Error(`Requested task tool is unavailable: ${name}`);
    session.setActiveToolsByName(requested);
    const activeSession = session;
    return {
      subscribe: activeSession.subscribe.bind(activeSession),
      prompt: async (text) => {
        await activeSession.prompt(text);
      },
      waitForIdle: activeSession.waitForIdle.bind(activeSession),
      abort: activeSession.abort.bind(activeSession),
      getSessionStats: activeSession.getSessionStats.bind(activeSession),
      dispose: release,
      environmentEvents: [
        {
          type: "pi_environment_ready",
          details: {
            resourceInheritance: environment.resourceInheritance,
            tools: activeSession.getActiveToolNames(),
            skills: resourceLoader.getSkills().skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
            extensions: resourceLoader.getExtensions().extensions.map((extension) => extension.path),
            mcp: mcp.inventory,
          },
        },
      ],
    };
  } catch (error) {
    await release();
    throw error;
  }
}
