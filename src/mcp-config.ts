import { resolve } from "node:path";

export type McpBinding =
  | { transport: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { transport: "http"; url: string; headers?: Record<string, string> };
export type McpBindings = Record<string, McpBinding>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP configuration must be an object");
  return value as Record<string, unknown>;
}

function references(value: unknown, headers = false): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, reference] of Object.entries(object(value))) {
    if (!(headers ? /^[!#$%&'*+.^_`|~\w-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key))
      throw new Error("Invalid MCP environment or header name");
    if (typeof reference !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference))
      throw new Error("MCP credentials must reference environment variable names");
    Object.defineProperty(result, key, { value: reference, enumerable: true });
  }
  return result;
}

export function parseMcpBindings(value: unknown, baseDir: string): McpBindings {
  const result: McpBindings = {};
  for (const [alias, raw] of Object.entries(object(value))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias)) throw new Error("Invalid MCP server alias");
    const binding = object(raw);
    const allowed = binding.transport === "stdio" ? ["transport", "command", "args", "cwd", "env"] : ["transport", "url", "headers"];
    if (Object.keys(binding).some((key) => !allowed.includes(key))) throw new Error(`Unknown MCP binding field for ${alias}`);
    let parsed: McpBinding;
    if (binding.transport === "stdio") {
      if (typeof binding.command !== "string" || !binding.command.trim() || binding.command.includes("\0"))
        throw new Error("MCP command is required");
      parsed = { transport: "stdio", command: binding.command };
      if (binding.args !== undefined) {
        if (!Array.isArray(binding.args) || !binding.args.every((arg) => typeof arg === "string" && !arg.includes("\0")))
          throw new Error("MCP args must be strings");
        parsed.args = binding.args;
      }
      if (binding.cwd !== undefined) {
        if (typeof binding.cwd !== "string" || !binding.cwd || binding.cwd.includes("\0")) throw new Error("Invalid MCP cwd");
        parsed.cwd = resolve(baseDir, binding.cwd);
      }
      if (binding.env !== undefined) parsed.env = references(binding.env);
    } else if (binding.transport === "http") {
      if (typeof binding.url !== "string") throw new Error("MCP URL is required");
      const url = new URL(binding.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("MCP URL must use HTTP(S) without embedded credentials");
      parsed = { transport: "http", url: binding.url };
      if (binding.headers !== undefined) parsed.headers = references(binding.headers, true);
    } else throw new Error("MCP transport must be stdio or http");
    Object.defineProperty(result, alias, { value: parsed, enumerable: true });
  }
  return result;
}
