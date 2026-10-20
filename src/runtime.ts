import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type McpBindings, parseMcpBindings } from "./mcp-config.ts";
import { parseRunArgs, type RunArgs } from "./run-args.ts";

type Defaults = { version: 1; profile?: string; runtime?: string };
type Runtime = {
  version: 1;
  model?: string;
  piAgentDir?: string;
  executor?: RunArgs["executor"];
  workspace?: RunArgs["workspace"];
  passEnv?: string[];
  mcp?: McpBindings;
};

export async function resolveRunConfiguration(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<RunArgs> {
  const home = resolve(env.RALPHWORKS_HOME ?? join(homedir(), ".config", "ralphworks"));
  let defaults: Defaults = { version: 1 };
  for (const path of [join(home, "config.json"), join(cwd, ".ralphworks", "config.json")]) {
    const raw = await readOptionalObject(path);
    if (!raw) continue;
    validateKeys(raw, ["version", "profile", "runtime"], path);
    for (const key of ["profile", "runtime"]) optionalString(raw[key], key);
    for (const key of ["profile", "runtime"]) {
      const value = raw[key];
      if (typeof value === "string" && (value.includes("/") || value.endsWith(".json"))) raw[key] = expandPath(value, dirname(path));
    }
    defaults = { ...defaults, ...raw };
  }
  const runtimeIndex = args.lastIndexOf("--runtime");
  const selector = runtimeIndex < 0 ? defaults.runtime : args[runtimeIndex + 1];
  if (runtimeIndex >= 0 && (!selector || selector.startsWith("--"))) throw new Error("--runtime requires a value");
  let runtime: Runtime = { version: 1 };
  if (selector) {
    const path = await runtimePath(selector, cwd, home);
    const raw = await readOptionalObject(path);
    if (!raw) throw new Error(`Runtime not found: ${selector}`);
    validateKeys(raw, ["version", "model", "piAgentDir", "executor", "workspace", "passEnv", "mcp"], path);
    for (const key of ["model", "piAgentDir", "executor", "workspace"]) optionalString(raw[key], key);
    if (raw.executor !== undefined && !["host", "docker", "docker-clone"].includes(String(raw.executor)))
      throw new Error("Invalid runtime executor");
    if (raw.workspace !== undefined && !["current", "worktree"].includes(String(raw.workspace)))
      throw new Error("Invalid runtime workspace");
    if (
      raw.passEnv !== undefined &&
      (!Array.isArray(raw.passEnv) || !raw.passEnv.every((value) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
    )
      throw new Error("Runtime passEnv must contain environment variable names");
    if (raw.mcp !== undefined) raw.mcp = parseMcpBindings(raw.mcp, dirname(path));
    runtime = raw as Runtime;
    if (runtime.piAgentDir) runtime.piAgentDir = expandPath(runtime.piAgentDir, dirname(path));
  }
  const resolved = parseRunArgs(args, {
    ...env,
    RALPHWORKS_MODEL: env.RALPHWORKS_MODEL ?? runtime.model,
    PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR ?? runtime.piAgentDir,
    RALPHWORKS_PASS_ENV: [...(runtime.passEnv ?? []), env.RALPHWORKS_PASS_ENV ?? ""].join(","),
  });
  if (resolved instanceof Error) throw resolved;
  resolved.mcpBindings ??= runtime.mcp;
  resolved.profile ??= defaults.profile;
  resolved.runtime ??= selector;
  if (!args.includes("--executor")) resolved.executor = runtime.executor ?? resolved.executor;
  resolved.workspace ??= runtime.workspace ?? "current";
  if (resolved.piAgentDir) resolved.piAgentDir = expandPath(resolved.piAgentDir, cwd);
  if (resolved.worktreePath && resolved.workspace !== "worktree") throw new Error("--worktree-path requires --workspace worktree");
  if (resolved.workspace === "worktree" && resolved.executor === "docker-clone")
    throw new Error("worktree workspace cannot be combined with docker-clone; choose host or docker");
  return resolved;
}

async function runtimePath(selector: string, cwd: string, home: string): Promise<string> {
  if (selector.includes("/") || selector.endsWith(".json")) return expandPath(selector, cwd);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(selector)) throw new Error("Invalid runtime name");
  const project = join(cwd, ".ralphworks", "runtimes", `${selector}.json`);
  return (await readOptionalObject(project)) ? project : join(home, "runtimes", `${selector}.json`);
}

async function readOptionalObject(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Expected JSON object: ${path}`);
  return raw as Record<string, unknown>;
}

function validateKeys(raw: Record<string, unknown>, keys: string[], path: string): void {
  if (raw.version !== 1) throw new Error(`Expected version: 1 in ${path}`);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`Unknown configuration field: ${key}`);
}

function optionalString(value: unknown, key: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`${key} must be a non-empty string`);
}

function expandPath(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}
