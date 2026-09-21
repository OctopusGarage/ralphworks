import { homedir } from "node:os";
import { resolve } from "node:path";

import type { JobOverrides, ModelRef } from "./run-args.ts";

const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY",
  "RADIUS_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const;

const CONTAINER_PI_AGENT_DIR = "/home/agent/.pi/agent";

export function modelEnv(modelRef: ModelRef | undefined): string[] {
  if (!modelRef) {
    return [];
  }
  return ["-e", `RALPHWORKS_MODEL=${modelRef.provider}/${modelRef.id}`];
}

export function checksEnv(checks: string[] | undefined): string[] {
  return checks?.length ? ["-e", `RALPHWORKS_CHECKS_JSON=${JSON.stringify(checks)}`] : [];
}

export function jobOptionsEnv(contexts: string[] | undefined, overrides: JobOverrides | undefined): string[] {
  return [
    ...(contexts?.length ? ["-e", `RALPHWORKS_CONTEXTS_JSON=${JSON.stringify(contexts)}`] : []),
    ...(overrides && Object.keys(overrides).length ? ["-e", `RALPHWORKS_JOB_OVERRIDES_JSON=${JSON.stringify(overrides)}`] : []),
  ];
}

export function providerEnv(env: NodeJS.ProcessEnv, passEnv: string[] = []): string[] {
  const names = [...new Set([...PROVIDER_ENV_VARS, ...passEnv])];
  return names.flatMap((name) => (env[name] ? ["-e", name] : []));
}

export function piAgentEnv(piAgentDir: string | undefined): string[] {
  if (!piAgentDir) {
    return [];
  }
  return ["-e", `PI_CODING_AGENT_DIR=${CONTAINER_PI_AGENT_DIR}`];
}

export function piAgentMount(piAgentDir: string | undefined): string[] {
  if (!piAgentDir) {
    return [];
  }
  return ["-v", `${expandHome(piAgentDir)}:${CONTAINER_PI_AGENT_DIR}`];
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}
