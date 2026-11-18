import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { parseMcpBindings } from "../src/mcp-config.ts";

test("MCP runtime bindings resolve paths and keep only environment references", () => {
  assert.deepEqual(
    parseMcpBindings(
      {
        repo: { transport: "stdio", command: "node", args: ["server.mjs"], cwd: "tools", env: { TOKEN: "REPO_TOKEN" } },
        web: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "MCP_AUTH" } },
      },
      "/tmp/runtime",
    ),
    {
      repo: { transport: "stdio", command: "node", args: ["server.mjs"], cwd: resolve("/tmp/runtime/tools"), env: { TOKEN: "REPO_TOKEN" } },
      web: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "MCP_AUTH" } },
    },
  );
});

test("MCP binding validation rejects ambiguous or secret-bearing configuration", () => {
  for (const value of [
    null,
    [],
    { "bad.name": { transport: "stdio", command: "node" } },
    { x: { transport: "stdio", command: "" } },
    { x: { transport: "stdio", command: "node", env: { TOKEN: "secret-value" } } },
    { x: { transport: "http", url: "file:///tmp/x" } },
    { x: { transport: "http", url: "http://user:secret@localhost" } },
    { x: { transport: "http", url: "http://localhost", headers: { Authorization: { value: "secret" } } } },
    { x: { transport: "stdio", command: "node", unknown: true } },
  ])
    assert.throws(() => parseMcpBindings(value, "/tmp"));
  assert.deepEqual(parseMcpBindings({}, "/tmp"), {});
});
