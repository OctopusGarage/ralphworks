import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { connectMcpTools } from "../src/mcp-client.ts";

const binding = {
  transport: "stdio" as const,
  command: process.execPath,
  args: [resolve("tests/fixtures/mcp-server.mjs")],
  env: { FIXTURE_TOKEN: "TEST_MCP_TOKEN" },
};
const options = { cwd: process.cwd(), env: { PATH: process.env.PATH, TEST_MCP_TOKEN: "test-secret", SHOULD_NOT_INHERIT: "private" } };
const execute = (tool: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal) =>
  tool.execute("call", args, signal, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);

test("MCP tools connect over stdio, select tools, map arguments and isolate child credentials", async () => {
  const connected = await connectMcpTools({ repo: { tools: ["echo"] } }, { repo: binding }, options);
  try {
    assert.deepEqual(connected.inventory, [{ server: "repo", tools: ["mcp__repo__echo"], status: "connected" }]);
    const output = await execute(connected.tools[0], { text: "hello" });
    assert.equal(output.content[0].type, "text");
    const result = JSON.parse((output.content[0] as { text: string }).text);
    assert.equal(result.text, "hello");
    assert.equal(result.token, "test-secret");
    assert.equal(result.leaked, undefined);
  } finally {
    await connected.close();
    await connected.close();
  }
});

test("missing MCP bindings and environment references obey required/optional policy", async () => {
  await assert.rejects(connectMcpTools({ repo: {} }, {}, options), /repo/);
  const skipped = await connectMcpTools({ repo: { required: false } }, {}, options);
  assert.equal(skipped.inventory[0].status, "unavailable");
  await skipped.close();
  await assert.rejects(connectMcpTools({ repo: {} }, { repo: binding }, { ...options, env: {} }), /TEST_MCP_TOKEN/);
});

test("missing selected tools fail and clean up the server", async () => {
  await assert.rejects(connectMcpTools({ repo: { tools: ["absent"] } }, { repo: binding }, options), /absent/);
  const skipped = await connectMcpTools({ repo: { tools: ["absent"], required: false } }, { repo: binding }, options);
  assert.equal(skipped.inventory[0].status, "unavailable");
  assert.deepEqual(skipped.tools, []);
  await skipped.close();
});

test("MCP cancellation interrupts a running tool and closes its process", async () => {
  const connected = await connectMcpTools({ repo: {} }, { repo: binding }, options);
  const controller = new AbortController();
  const pending = execute(connected.tools.find((t) => t.name.endsWith("__wait")) as ToolDefinition, {}, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  await connected.close();
});

test("empty tool selection exposes no tools and pre-aborted setup starts no server", async () => {
  const connected = await connectMcpTools({ repo: { tools: [] } }, { repo: binding }, options);
  assert.deepEqual(connected.tools, []);
  await connected.close();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connectMcpTools({ repo: {} }, { repo: binding }, { ...options, signal: controller.signal }));
});

test("HTTP MCP connects with runtime-bound authentication and calls tools", async () => {
  const { createServer } = await import("node:http");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const sessions: { server: InstanceType<typeof Server>; transport: InstanceType<typeof StreamableHTTPServerTransport> }[] = [];
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer test") {
      response.writeHead(401).end();
      return;
    }
    const server = new Server({ name: "http-fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    sessions.push({ server, transport });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as import("node:net").AddressInfo;
  try {
    const connected = await connectMcpTools(
      { remote: {} },
      { remote: { transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "TEST_AUTH" } } },
      { cwd: process.cwd(), env: { TEST_AUTH: "Bearer test" } },
    );
    try {
      assert.deepEqual((await execute(connected.tools[0], {})).content, [{ type: "text", text: "pong" }]);
    } finally {
      await connected.close();
    }
  } finally {
    await Promise.all(sessions.map(({ server }) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
  }
});

test("closing a connection terminates its stdio child", async () => {
  const connected = await connectMcpTools({ repo: { tools: ["echo"] } }, { repo: binding }, options);
  const result = await execute(connected.tools[0], {});
  const pid = JSON.parse((result.content[0] as { text: string }).text).pid as number;
  process.kill(pid, 0);
  await connected.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("a hanging MCP handshake times out and terminates the spawned process", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(`${tmpdir()}/ralph-mcp-`);
  const pidFile = `${directory}/pid`;
  try {
    await assert.rejects(
      connectMcpTools(
        { repo: { timeoutSeconds: 0.2 } },
        {
          repo: {
            transport: "stdio",
            command: process.execPath,
            args: [
              "--input-type=module",
              "-e",
              "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)",
              pidFile,
            ],
          },
        },
        options,
      ),
      /timeout|aborted/i,
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP output preserves images, serializes resource blocks and signals tool errors", async () => {
  const connected = await connectMcpTools({ repo: { tools: ["media"] } }, { repo: binding }, options);
  try {
    const result = await execute(connected.tools[0], {});
    assert.deepEqual(result.details, { isError: true });
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(result.content[1], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    assert.match((result.content[2] as { text: string }).text, /test:\/\/result/);
  } finally {
    await connected.close();
  }
});

test("aborting the task closes established MCP child processes", async () => {
  const controller = new AbortController();
  const connected = await connectMcpTools({ repo: { tools: ["echo"] } }, { repo: binding }, { ...options, signal: controller.signal });
  const result = await execute(connected.tools[0], {});
  const pid = JSON.parse((result.content[0] as { text: string }).text).pid as number;
  controller.abort();
  await connected.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("MCP optional connection errors redact explicitly mapped secrets of any length", async () => {
  const result = await connectMcpTools(
    { repo: { required: false } },
    {
      repo: { transport: "stdio", command: process.execPath, args: ["--input-type=module", "-e", "process.exit(1)"], env: { T: "SHORT" } },
    },
    { ...options, env: { SHORT: "closed" } },
  );
  assert.equal(result.inventory[0].status, "unavailable");
  assert.equal(result.inventory[0].reason?.includes("closed"), false);
  assert.match(result.inventory[0].reason ?? "", /REDACTED/);
  await result.close();
});

test("MCP request failures redact credential values", async () => {
  const connected = await connectMcpTools({ repo: { tools: ["throws"] } }, { repo: binding }, options);
  try {
    await assert.rejects(
      execute(connected.tools[0], {}),
      (error) => error instanceof Error && !error.message.includes("test-secret") && error.message.includes("REDACTED"),
    );
  } finally {
    await connected.close();
  }
});

test("pre-aborted MCP setup rejects even without declared servers", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Task cancelled before setup"));
  await assert.rejects(connectMcpTools({}, {}, { ...options, signal: controller.signal }), /Task cancelled before setup/);
});
