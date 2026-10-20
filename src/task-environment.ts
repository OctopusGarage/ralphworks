import { isAbsolute } from "node:path";

export type McpRequirement = { tools?: string[]; required?: boolean; timeoutSeconds?: number };
export type OutputRequirement = { path: string; format?: "text" | "json"; required?: boolean };
export type TaskEnvironment = {
  resourceInheritance: "none" | "project" | "all";
  tools: string[];
  extensions: string[];
  contextFiles: string[];
  mcp: Record<string, McpRequirement>;
  requires: { commands: string[]; env: string[] };
};

export function normalizeTaskEnvironment(value: unknown): TaskEnvironment {
  const raw = value === undefined ? {} : record(value, "environment");
  known(raw, ["resourceInheritance", "tools", "extensions", "contextFiles", "mcp", "requires"], "environment");
  if (raw.resourceInheritance !== undefined && !["none", "project", "all"].includes(raw.resourceInheritance as string))
    throw new Error("resourceInheritance must be none, project, or all");
  const tools = stringArray(raw.tools, "environment.tools", ["read", "bash", "edit", "write"]);
  for (const name of tools) if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`);
  const extensions = stringArray(raw.extensions, "environment.extensions");
  const contextFiles = stringArray(raw.contextFiles, "environment.contextFiles");
  for (const path of [...extensions, ...contextFiles]) if (isAbsolute(path)) throw new Error("Environment resource paths must be relative");
  const mcp: Record<string, McpRequirement> = {};
  for (const [alias, value] of Object.entries(raw.mcp === undefined ? {} : record(raw.mcp, "environment.mcp"))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias)) throw new Error(`Invalid MCP alias: ${alias}`);
    const entry = record(value, `MCP ${alias}`);
    known(entry, ["tools", "required", "timeoutSeconds"], `MCP ${alias}`);
    if (entry.required !== undefined && typeof entry.required !== "boolean") throw new Error(`MCP ${alias} required must be boolean`);
    if (
      entry.timeoutSeconds !== undefined &&
      (typeof entry.timeoutSeconds !== "number" ||
        !Number.isFinite(entry.timeoutSeconds) ||
        entry.timeoutSeconds <= 0 ||
        entry.timeoutSeconds > 600)
    )
      throw new Error(`MCP ${alias} timeoutSeconds must be between 0 and 600`);
    const requirement: McpRequirement = {};
    if (entry.tools !== undefined) requirement.tools = stringArray(entry.tools, `MCP ${alias} tools`);
    if (entry.required !== undefined) requirement.required = entry.required as boolean;
    if (entry.timeoutSeconds !== undefined) requirement.timeoutSeconds = entry.timeoutSeconds as number;
    Object.defineProperty(mcp, alias, { value: requirement, enumerable: true, configurable: true, writable: true });
  }
  const requires = raw.requires === undefined ? {} : record(raw.requires, "environment.requires");
  known(requires, ["commands", "env"], "environment.requires");
  const commands = stringArray(requires.commands, "environment.requires.commands");
  const env = stringArray(requires.env, "environment.requires.env");
  for (const name of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  for (const name of commands) if (!/^[A-Za-z0-9_.+-]+$/.test(name)) throw new Error(`Invalid required command: ${name}`);
  return {
    resourceInheritance: (raw.resourceInheritance ?? "none") as TaskEnvironment["resourceInheritance"],
    tools,
    extensions,
    contextFiles,
    mcp,
    requires: { commands, env },
  };
}

export function normalizeOutputs(value: unknown): OutputRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("outputs must be an array");
  return value.map((item) => {
    const raw = record(item, "output");
    known(raw, ["path", "format", "required"], "output");
    if (
      typeof raw.path !== "string" ||
      !raw.path.trim() ||
      isAbsolute(raw.path) ||
      raw.path.split(/[\\/]/).includes("..") ||
      raw.path === "."
    )
      throw new Error("Output path must be relative without parent traversal");
    if (raw.format !== undefined && raw.format !== "text" && raw.format !== "json") throw new Error("Output format must be text or json");
    if (raw.required !== undefined && typeof raw.required !== "boolean") throw new Error("Output required must be boolean");
    return { ...raw } as OutputRequirement;
  });
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function known(raw: Record<string, unknown>, fields: string[], label: string): void {
  for (const field of Object.keys(raw)) if (!fields.includes(field)) throw new Error(`Unknown ${label} field: ${field}`);
}
function stringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))
    throw new Error(`${label} must be an array of non-empty strings`);
  return [...new Set(value)];
}
