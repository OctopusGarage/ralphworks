import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpBinding, McpBindings } from "./mcp-config.ts";
import type { McpRequirement } from "./task-environment.ts";

interface Inventory {
  server: string;
  tools: string[];
  status: "connected" | "unavailable";
  reason?: string;
}
interface Connection {
  client: Client;
  transport: Transport;
}
const MAX_TOOLS = 100;
const MAX_RESULT_BYTES = 1024 * 1024;

function mapped(references: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, name] of Object.entries(references ?? {})) {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`Missing MCP environment variable ${name}`);
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}

function transportFor(binding: McpBinding, cwd: string, env: NodeJS.ProcessEnv): Transport {
  if (binding.transport === "http")
    return new StreamableHTTPClientTransport(new URL(binding.url), { requestInit: { headers: mapped(binding.headers, env) } });
  const childEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  Object.assign(childEnv, mapped(binding.env, env));
  return new StdioClientTransport({
    command: binding.command,
    args: binding.args,
    cwd: binding.cwd ?? cwd,
    env: childEnv,
    stderr: "ignore",
    maxBufferSize: MAX_RESULT_BYTES,
  });
}

async function closeConnection(connection: Connection): Promise<void> {
  // SDK stdio close escalates from EOF through SIGTERM to SIGKILL.
  await bounded(connection.client.close(), AbortSignal.timeout(5000)).catch(() => undefined);
  await bounded(connection.transport.close(), AbortSignal.timeout(5000)).catch(() => undefined);
}

function safeReason(error: unknown, bindings: McpBindings, env: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : "MCP connection failed";
  for (const binding of Object.values(bindings)) {
    for (const name of Object.values(binding.transport === "stdio" ? (binding.env ?? {}) : (binding.headers ?? {}))) {
      const value = env[name];
      if (value) message = message.split(value).join("[REDACTED]");
    }
  }
  return message.slice(0, 500);
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("MCP operation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function definition(
  alias: string,
  tool: Tool,
  client: Client,
  timeout: number,
  sanitize: (error: unknown) => string,
  outerSignal?: AbortSignal,
): ToolDefinition {
  const name = `mcp__${alias}__${tool.name}`;
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > 128) throw new Error(`Unsupported MCP tool name on ${alias}`);
  return {
    name,
    label: `${alias}: ${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name} from ${alias}`,
    parameters: tool.inputSchema as ToolDefinition["parameters"],
    async execute(_id, args, signal) {
      try {
        const signals = [signal, outerSignal].filter((item): item is AbortSignal => Boolean(item));
        const combined = signals.length ? AbortSignal.any(signals) : undefined;
        combined?.throwIfAborted();
        const result = CallToolResultSchema.parse(
          await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, CallToolResultSchema, {
            signal: combined,
            timeout,
            maxTotalTimeout: timeout,
          }),
        );
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new Error(`MCP result exceeds ${MAX_RESULT_BYTES} bytes`);
        const content: Awaited<ReturnType<ToolDefinition["execute"]>>["content"] = [];
        for (const block of result.content) {
          if (block.type === "text") content.push({ type: "text", text: block.text });
          else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
          else content.push({ type: "text", text: JSON.stringify(block) });
        }
        if (result.isError) content.unshift({ type: "text", text: "MCP tool reported an error." });
        return { content, details: { isError: result.isError === true } };
      } catch (error) {
        throw new Error(`MCP tool ${name}: ${sanitize(error)}`);
      }
    },
  };
}

export async function connectMcpTools(
  requirements: Record<string, McpRequirement>,
  bindings: McpBindings,
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ tools: ToolDefinition[]; inventory: Inventory[]; close(): Promise<void> }> {
  const env = options.env ?? process.env;
  const tools: ToolDefinition[] = [];
  const inventory: Inventory[] = [];
  const connections: Connection[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    options.signal?.removeEventListener("abort", onAbort);
    closing ??= Promise.all(connections.map(closeConnection)).then(() => undefined);
    return closing;
  };
  const onAbort = () => {
    void close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    for (const [alias, requirement] of Object.entries(requirements)) {
      let connection: Connection | undefined;
      try {
        options.signal?.throwIfAborted();
        const binding = Object.hasOwn(bindings, alias) ? bindings[alias] : undefined;
        if (!binding) throw new Error(`Missing MCP runtime binding for ${alias}`);
        const timeout = (requirement.timeoutSeconds ?? 30) * 1000;
        const connectTimeout = (requirement.timeoutSeconds ?? 10) * 1000;
        const deadline = AbortSignal.timeout(connectTimeout);
        const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        const client = new Client({ name: "ralphworks", version: "1" }, { capabilities: {} });
        connection = { client, transport: transportFor(binding, options.cwd, env) };
        await bounded(client.connect(connection.transport), signal);
        const available: Tool[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: connectTimeout });
          available.push(...page.tools);
          if (available.length > MAX_TOOLS) throw new Error(`MCP server ${alias} exceeds ${MAX_TOOLS} tools`);
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error(`MCP pagination cycle on ${alias}`);
          if (cursor) cursors.add(cursor);
          if (cursors.size > MAX_TOOLS) throw new Error(`MCP pagination limit on ${alias}`);
        } while (cursor);
        const names = new Set<string>();
        for (const item of available) {
          if (names.has(item.name)) throw new Error(`Duplicate MCP tool ${item.name} on ${alias}`);
          names.add(item.name);
        }
        for (const requested of requirement.tools ?? [])
          if (!names.has(requested)) throw new Error(`Missing MCP tool ${requested} on ${alias}`);
        const selected = available.filter((item) => requirement.tools === undefined || requirement.tools.includes(item.name));
        const definitions = selected.map((item) =>
          definition(alias, item, client, timeout, (error) => safeReason(error, bindings, env), options.signal),
        );
        for (const item of definitions)
          if (tools.some((existing) => existing.name === item.name)) throw new Error(`Duplicate MCP tool namespace ${item.name}`);
        tools.push(...definitions);
        inventory.push({ server: alias, tools: definitions.map((item) => item.name), status: "connected" });
        connections.push(connection);
      } catch (error) {
        if (connection) await closeConnection(connection);
        const reason = safeReason(error, bindings, env);
        if (options.signal?.aborted || requirement.required !== false) throw new Error(`MCP server ${alias}: ${reason}`);
        inventory.push({ server: alias, tools: [], status: "unavailable", reason });
      }
    }
    return { tools, inventory, close };
  } catch (error) {
    await close();
    throw error;
  }
}
