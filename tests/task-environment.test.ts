import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskEnvironment } from "../src/task-environment.ts";

test("environment defaults isolate resources and allow explicit empty tools", () => {
  assert.deepEqual(normalizeTaskEnvironment(undefined), {
    resourceInheritance: "none",
    tools: ["read", "bash", "edit", "write"],
    extensions: [],
    contextFiles: [],
    mcp: {},
    requires: { commands: [], env: [] },
  });
  assert.deepEqual(normalizeTaskEnvironment({ tools: [] }).tools, []);
  assert.equal(normalizeTaskEnvironment({ resourceInheritance: "project" }).resourceInheritance, "project");
});

test("environment validates MCP selection and required capabilities", () => {
  assert.deepEqual(
    normalizeTaskEnvironment({
      mcp: { repository: { tools: ["get_pr"], required: false, timeoutSeconds: 30 } },
      requires: { commands: ["git"], env: ["API_TOKEN"] },
    }).mcp,
    { repository: { tools: ["get_pr"], required: false, timeoutSeconds: 30 } },
  );
  for (const value of [
    null,
    [],
    { inheritGlobalResources: true },
    { resourceInheritance: "yes" },
    { tools: [""] },
    { tools: ["bad tool"] },
    { extensions: ["/tmp/ext.ts"] },
    { contextFiles: ["/tmp/context"] },
    { mcp: { "bad alias": {} } },
    { mcp: { x: { url: "http://localhost" } } },
    { mcp: { x: { required: 1 } } },
    { mcp: { x: { tools: [""] } } },
    { mcp: { x: { timeoutSeconds: 0 } } },
    { mcp: { x: { timeoutSeconds: 601 } } },
    { requires: { env: ["BAD-NAME"] } },
    { requires: { other: [] } },
  ]) {
    assert.throws(() => normalizeTaskEnvironment(value));
  }
});
