import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runLocalJob } from "../src/orchestrator.ts";
import { PiProcessRunner } from "../src/pi-process-runner.ts";
import { resolveTask, stageTaskSkills } from "../src/resolved-task.ts";

test("an isolated Pi worker uses selected extension and MCP tools and closes their lifecycle", { timeout: 30_000 }, async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const index = requests.length;
    const tool =
      index === 1
        ? { name: "mcp__docs__echo", arguments: JSON.stringify({ text: "from-mcp" }) }
        : { name: "profile_greet", arguments: "{}" };
    const delta =
      index < 3
        ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: tool }] }
        : { role: "assistant", content: "Verified both tools.\n<promise>DONE</promise>" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: index < 3 ? "tool_calls" : "stop" },
    ])
      res.write(
        `data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cwd = await mkdtemp(join(tmpdir(), "ralph-env-integration-"));
    const agentDir = join(cwd, "agent");
    const profile = join(cwd, "profile");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(profile, "plugin"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "must-not-load.js"), "throw new Error('global extension was inherited');");
    await writeFile(join(agentDir, "SYSTEM.md"), "GLOBAL_SYSTEM_MUST_NOT_APPEAR");
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }],
          },
        },
      }),
    );
    await writeFile(
      join(profile, "profile.json"),
      JSON.stringify({
        version: 1,
        name: "tools",
        environment: { tools: ["profile_greet"], extensions: ["plugin"], contextFiles: ["context.md"], mcp: { docs: { tools: ["echo"] } } },
        defaults: { maxIterations: 1, maxMinutes: 0.3 },
      }),
    );
    await writeFile(join(profile, "context.md"), "EXPLICIT_TASK_CONTEXT");
    await writeFile(join(profile, "plugin", "helper.js"), "export const greeting='hello-from-extension';");
    await writeFile(
      join(profile, "plugin", "index.js"),
      `import {writeFileSync,mkdirSync} from 'node:fs'; import {join} from 'node:path'; import {greeting} from './helper.js'; export default function(pi){ pi.on('session_start',(_event,ctx)=>{mkdirSync(join(ctx.cwd,'.ralph'),{recursive:true});writeFileSync(join(ctx.cwd,'.ralph','extension-started'),'yes');});pi.on('session_shutdown',(_event,ctx)=>{writeFileSync(join(ctx.cwd,'.ralph','extension-stopped'),'yes');});pi.registerTool({name:'profile_greet',label:'Greet',description:'Return a greeting',parameters:{type:'object',properties:{}},async execute(){return{content:[{type:'text',text:greeting}],details:{}};}});}`,
    );
    const task = await stageTaskSkills(await resolveTask("Call the selected MCP and extension tools", { cwd, profile }), cwd);
    const result = await runLocalJob("Call tools", {
      cwd,
      preparedTask: task,
      runner: new PiProcessRunner({
        piAgentDir: agentDir,
        modelRef: { provider: "fixture", id: "fixture" },
        mcpBindings: {
          docs: {
            transport: "stdio",
            command: process.execPath,
            args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
          },
        },
      }),
    });
    assert.equal(result.status, "completed", result.reason);
    assert.equal(requests.length, 3);
    const first = requests[0] as { tools?: { function: { name: string } }[] };
    assert.deepEqual(first.tools?.map((tool) => tool.function.name).sort(), ["mcp__docs__echo", "profile_greet"]);
    assert.match(JSON.stringify(first), /EXPLICIT_TASK_CONTEXT/);
    assert.ok(!JSON.stringify(first).includes("GLOBAL_SYSTEM_MUST_NOT_APPEAR"));
    assert.match(JSON.stringify(requests[1]), /from-mcp/);
    assert.match(JSON.stringify(requests[2]), /hello-from-extension/);
    assert.equal(await readFile(join(cwd, ".ralph", "extension-started"), "utf8"), "yes");
    assert.equal(await readFile(join(cwd, ".ralph", "extension-stopped"), "utf8"), "yes");
    const inventory = JSON.parse(await readFile(join(result.runDir, "environment-1.json"), "utf8"));
    assert.deepEqual(inventory.tools.sort(), ["mcp__docs__echo", "profile_greet"]);
    const events = await readFile(result.eventsPath, "utf8");
    assert.match(events, /pi_environment_ready/);
    assert.match(events, /mcp__docs__echo/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
