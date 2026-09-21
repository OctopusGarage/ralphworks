export type RunnerName = "dry-run" | "pi";
export type ExecutorName = "host" | "docker" | "docker-clone";
export type ModelRef = {
  provider: string;
  id: string;
};

export type JobOverrides = {
  maxIterations?: number;
  maxMinutes?: number;
  maxCostUsd?: number;
  checkTimeoutSeconds?: number;
  commit?: "none" | "verified";
  completionPromise?: string;
};

type RunArgEnv = {
  PI_CODING_AGENT_DIR?: string;
  RALPHWORKS_PROVIDER?: string;
  RALPHWORKS_MODEL?: string;
  RALPHWORKS_PASS_ENV?: string;
  RALPHWORKS_CHECKS_JSON?: string;
  RALPHWORKS_CONTEXTS_JSON?: string;
  RALPHWORKS_JOB_OVERRIDES_JSON?: string;
};

export type RunArgs = {
  runner: RunnerName;
  executor: ExecutorName;
  repo?: string;
  ref?: string;
  modelRef?: ModelRef;
  passEnv?: string[];
  piAgentDir?: string;
  checks?: string[];
  contexts?: string[];
  jobOverrides?: JobOverrides;
};

export function parseRunArgs(args: string[], env: RunArgEnv = process.env): RunArgs | Error {
  const out: RunArgs = {
    runner: "pi",
    executor: "host",
  };
  let provider = env.RALPHWORKS_PROVIDER;
  let model = env.RALPHWORKS_MODEL;
  let piAgentDir = env.PI_CODING_AGENT_DIR;
  const passEnv = splitEnvList(env.RALPHWORKS_PASS_ENV);
  const contexts = jsonStringArray(env.RALPHWORKS_CONTEXTS_JSON, "RALPHWORKS_CONTEXTS_JSON");
  if (contexts instanceof Error) return contexts;
  const jobOverrides = jsonJobOverrides(env.RALPHWORKS_JOB_OVERRIDES_JSON);
  if (jobOverrides instanceof Error) return jobOverrides;
  let checks: string[] = [];
  if (env.RALPHWORKS_CHECKS_JSON) {
    try {
      const parsed: unknown = JSON.parse(env.RALPHWORKS_CHECKS_JSON);
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string" && value.trim())) {
        return new Error("RALPHWORKS_CHECKS_JSON must be a JSON array of commands");
      }
      checks = parsed;
    } catch {
      return new Error("RALPHWORKS_CHECKS_JSON must be a JSON array of commands");
    }
  }
  let modelChangedByCli = false;
  let providerChangedByCli = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runner") {
      const value = args[index + 1];
      if (value !== "dry-run" && value !== "pi") {
        return new Error(`Unknown runner: ${value ?? "(missing)"}`);
      }
      out.runner = value;
      index += 1;
      continue;
    }
    if (arg === "--executor") {
      const value = args[index + 1];
      if (value !== "host" && value !== "docker" && value !== "docker-clone") {
        return new Error(`Unknown executor: ${value ?? "(missing)"}`);
      }
      out.executor = value;
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value) {
        return new Error("--repo requires a value");
      }
      out.repo = value;
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      const value = args[index + 1];
      if (!value) {
        return new Error("--ref requires a value");
      }
      out.ref = value;
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value) {
        return new Error("--provider requires a value");
      }
      provider = value;
      providerChangedByCli = true;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      const value = args[index + 1];
      if (!value) {
        return new Error("--model requires a value");
      }
      model = value;
      modelChangedByCli = true;
      index += 1;
      continue;
    }
    if (arg === "--pass-env") {
      const value = args[index + 1];
      if (!value) {
        return new Error("--pass-env requires a value");
      }
      passEnv.push(value);
      index += 1;
      continue;
    }
    if (arg === "--check") {
      const value = args[index + 1];
      if (!value) return new Error("--check requires a command");
      checks.push(value);
      index += 1;
      continue;
    }
    if (arg === "--context") {
      const value = args[index + 1];
      if (!value) return new Error("--context requires a path");
      contexts.push(value); index += 1; continue;
    }
    if (arg === "--max-iterations") {
      const value = positiveInteger(args[index + 1], "--max-iterations");
      if (value instanceof Error) return value;
      jobOverrides.maxIterations = value; index += 1; continue;
    }
    if (arg === "--max-minutes" || arg === "--max-cost-usd") {
      const value = nonNegativeNumber(args[index + 1], arg);
      if (value instanceof Error) return value;
      if (arg === "--max-minutes") jobOverrides.maxMinutes = value; else jobOverrides.maxCostUsd = value;
      index += 1; continue;
    }
    if (arg === "--check-timeout") {
      const value = positiveNumber(args[index + 1], "--check-timeout");
      if (value instanceof Error) return value;
      jobOverrides.checkTimeoutSeconds = value; index += 1; continue;
    }
    if (arg === "--commit") {
      const value = args[index + 1];
      if (value !== "none" && value !== "verified") return new Error("--commit must be none or verified");
      jobOverrides.commit = value; index += 1; continue;
    }
    if (arg === "--completion-promise") {
      const value = args[index + 1];
      if (!value) return new Error("--completion-promise requires a value");
      jobOverrides.completionPromise = value; index += 1; continue;
    }
    if (arg === "--pi-agent-dir") {
      const value = args[index + 1];
      if (!value) {
        return new Error("--pi-agent-dir requires a value");
      }
      piAgentDir = value;
      index += 1;
      continue;
    }
    return new Error(`Unknown option: ${arg}`);
  }

  const modelRef = resolveModelRef({
    provider,
    model,
    providerChangedByCli,
    modelChangedByCli,
  });
  if (modelRef instanceof Error) {
    return modelRef;
  }
  if (modelRef) {
    out.modelRef = modelRef;
  }
  if (passEnv.length > 0) {
    out.passEnv = unique(passEnv);
  }
  if (piAgentDir) {
    out.piAgentDir = piAgentDir;
  }
  if (checks.length) out.checks = checks;
  if (contexts.length) out.contexts = contexts;
  if (Object.keys(jobOverrides).length) out.jobOverrides = jobOverrides;

  return out;
}

function positiveInteger(value: string | undefined, option: string): number | Error {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : new Error(`${option} requires a positive integer`);
}

function positiveNumber(value: string | undefined, option: string): number | Error {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : new Error(`${option} requires a positive number`);
}

function nonNegativeNumber(value: string | undefined, option: string): number | Error {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : new Error(`${option} requires a non-negative number`);
}

function jsonStringArray(value: string | undefined, name: string): string[] | Error {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item) ? parsed : new Error(`${name} must be a JSON array of strings`);
  } catch { return new Error(`${name} must be a JSON array of strings`); }
}

function jsonJobOverrides(value: string | undefined): JobOverrides | Error {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JobOverrides : new Error("RALPHWORKS_JOB_OVERRIDES_JSON must be a JSON object");
  } catch { return new Error("RALPHWORKS_JOB_OVERRIDES_JSON must be a JSON object"); }
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveModelRef(input: {
  provider?: string;
  model?: string;
  providerChangedByCli: boolean;
  modelChangedByCli: boolean;
}): ModelRef | undefined | Error {
  if (!input.model && !input.provider) {
    return undefined;
  }
  if (!input.model) {
    return new Error("provider requires a model");
  }
  if (input.model.includes("/")) {
    const slash = input.model.indexOf("/");
    const provider = input.model.slice(0, slash);
    const id = input.model.slice(slash + 1);
    if (!provider || !id) {
      return new Error("--model must be provider/model or be paired with --provider");
    }
    if (input.providerChangedByCli && input.provider && input.provider !== provider) {
      return new Error("--provider must match the provider prefix in --model");
    }
    return { provider, id };
  }
  if (!input.provider) {
    return new Error("--model requires --provider unless it is written as provider/model");
  }
  if (!input.modelChangedByCli && input.providerChangedByCli) {
    return new Error("--provider requires --model");
  }
  return { provider: input.provider, id: input.model };
}
