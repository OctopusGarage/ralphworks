import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLocalJob } from "../src/orchestrator.ts";
import { PiProcessRunner } from "../src/pi-process-runner.ts";
import { resolveTask, stageTaskSkills } from "../src/resolved-task.ts";

test("a generic compatible gateway completes a skill-guided task through real Pi tool execution and checks", {
  timeout: 30_000,
}, async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer fixture-key");
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const first = requests.length === 1;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-result",
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "verified\n" }) },
              },
            ],
          }
        : { role: "assistant", content: "Wrote result.txt and verified the requested artifact.\n<promise>DONE</promise>" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-coder", choices: [choice] })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cwd = await mkdtemp(join(tmpdir(), "ralph-compatible-model-"));
    const agentDir = join(cwd, "agent");
    const profile = join(cwd, "profile");
    await mkdir(agentDir);
    await mkdir(join(profile, "skill"), { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "fixture-gateway": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "fixture-coder", contextWindow: 32000, maxTokens: 1024 }],
          },
        },
      }),
    );
    await writeFile(
      join(profile, "profile.json"),
      JSON.stringify({ version: 1, name: "artifact", prompts: ["method.md"], skills: ["skill"], parameters: { value: null } }),
    );
    await writeFile(join(profile, "method.md"), "Write {{value}} to result.txt using the write tool.");
    await writeFile(
      join(profile, "skill", "SKILL.md"),
      "---\nname: artifact-writing\ndescription: Write and verify the requested artifact\n---\nOnly claim completion after writing the requested content.",
    );
    const preparedTask = await stageTaskSkills(
      await resolveTask("Create the artifact", {
        cwd,
        profile,
        params: { value: "verified" },
        jobOverrides: { maxIterations: 1, maxMinutes: 0.3 },
        checks: ['test "$(cat result.txt)" = verified'],
      }),
      cwd,
    );
    const result = await runLocalJob("Create the artifact", {
      cwd,
      preparedTask,
      runner: new PiProcessRunner({
        piAgentDir: agentDir,
        modelRef: { provider: "fixture-gateway", id: "fixture-coder" },
        skillPaths: preparedTask.skillPaths,
      }),
    });
    assert.equal(result.status, "completed", result.reason);
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "verified\n");
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[0]), /artifact-writing/);
    assert.match(JSON.stringify(requests[0]), /Write verified to result.txt/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
