import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createProfileResourceLoader } from "../src/pi-resources.ts";
import { normalizeTaskEnvironment } from "../src/task-environment.ts";

async function contextRunner(loader: Awaited<ReturnType<typeof createProfileResourceLoader>>, cwd: string) {
  const loaded = loader.getExtensions();
  const models = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const history = SessionManager.inMemory(cwd);
  history.appendMessage({ role: "user", content: "Refactor one seam.", timestamp: 0 });
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, history, new ModelRegistry(models));
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  return { runner, history, errors };
}

test("deadline context refreshes each request without accumulating notes or changing stored history", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-deadline-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configured = join(cwd, "configured.js");
  await writeFile(
    configured,
    `export default function(pi) {
    pi.on("context", event => ({messages: [...event.messages,
      {role: "user", content: "Configured extension context", timestamp: 0}]}));
  }`,
  );
  const marker = join(cwd, "implicit-loaded");
  const agentDir = join(cwd, "agent");
  for (const directory of [join(cwd, ".pi", "extensions"), join(agentDir, "extensions")]) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "implicit.js"),
      `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)}, 'loaded');}`,
    );
  }
  const start = Date.parse("2026-10-23T12:00:00.000Z");
  const deadline = start + 120_000;
  const input = {
    cwd,
    piAgentDir: agentDir,
    skillPaths: [],
    deadline,
    environment: { ...normalizeTaskEnvironment(undefined), extensions: [configured] },
  };
  const loader = await createProfileResourceLoader(input);
  t.after(() => loader.release());
  const { runner, history, errors } = await contextRunner(loader, cwd);
  const stored = structuredClone(history.getEntries());
  const original = history.buildSessionContext().messages;
  const snapshot = structuredClone(original);
  let now = start;
  t.mock.method(Date, "now", () => now);
  for (const [elapsed, remaining] of [
    [0, 120],
    [41_001, 78],
    [121_000, 0],
  ]) {
    now = start + elapsed;
    const messages = await runner.emitContext(original);
    assert.equal(messages.length, original.length + 2);
    const configuredMessage = messages.at(-2);
    assert.ok(configuredMessage?.role === "user");
    assert.equal(configuredMessage.content, "Configured extension context");
    const note = messages.at(-1);
    assert.equal(note?.role, "user");
    assert.equal(typeof note?.content, "string");
    const text = String(note?.content);
    assert.match(text, /RalphWorks execution context/);
    assert.ok(text.includes(new Date(now).toISOString()));
    assert.ok(text.includes(new Date(deadline).toISOString()));
    assert.ok(text.includes(`Remaining: ${remaining} seconds`));
    assert.match(text, /report, handoff and scheduled checks/);
    assert.equal(
      messages.filter((message) => message.role === "user" && String(message.content).includes("RalphWorks execution context")).length,
      1,
    );
    assert.deepEqual(original, snapshot);
    assert.deepEqual(history.getEntries(), stored);
  }
  assert.deepEqual(errors, []);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(loader.getExtensions().extensions.length, 2);
});

test("without a deadline the SDK loader adds no internal extension or execution context", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-no-deadline-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const loader = await createProfileResourceLoader({ cwd, piAgentDir: join(cwd, "agent"), skillPaths: [] });
  t.after(() => loader.release());
  assert.deepEqual(loader.getExtensions().extensions, []);
  const { runner, history, errors } = await contextRunner(loader, cwd);
  const original = history.buildSessionContext().messages;
  assert.deepEqual(await runner.emitContext(original), original);
  assert.deepEqual(errors, []);
});
