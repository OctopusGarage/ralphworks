import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRunConfiguration } from "../src/runtime.ts";

test("profiles and runtime choices resolve independently with CLI over environment over preset", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-runtime-"));
  const home = join(cwd, "personal");
  await mkdir(join(home, "runtimes"), { recursive: true });
  await mkdir(join(cwd, ".ralphworks"));
  await writeFile(
    join(home, "runtimes", "coding.json"),
    JSON.stringify({
      version: 1,
      model: "gateway/coder",
      executor: "docker",
      workspace: "worktree",
      piAgentDir: "../pi",
      passEnv: ["GATEWAY_KEY"],
    }),
  );
  await writeFile(join(cwd, ".ralphworks", "config.json"), JSON.stringify({ version: 1, profile: "bugfix", runtime: "coding" }));
  const resolved = await resolveRunConfiguration(["--model", "other/coder", "--executor", "host", "--param", "scope=login"], cwd, {
    RALPHWORKS_HOME: home,
    RALPHWORKS_MODEL: "env/model",
  });
  assert.equal(resolved.profile, "bugfix");
  assert.equal(resolved.executor, "host");
  assert.equal(resolved.workspace, "worktree");
  assert.deepEqual(resolved.modelRef, { provider: "other", id: "coder" });
  assert.equal(resolved.piAgentDir, join(home, "pi"));
  assert.deepEqual(resolved.params, { scope: "login" });
  assert.deepEqual(resolved.passEnv, ["GATEWAY_KEY"]);
  const inherited = await resolveRunConfiguration([], cwd, { RALPHWORKS_HOME: home, RALPHWORKS_MODEL: "env/model" });
  assert.deepEqual(inherited.modelRef, { provider: "env", id: "model" });
});

test("runtime presets reject task methods and invalid execution settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-runtime-"));
  const path = join(cwd, "runtime.json");
  for (const invalid of [
    { version: 1, skills: [] },
    { version: 2 },
    { version: 1, executor: "cloud" },
    { version: 1, passEnv: ["A=secret"] },
    { version: 1, workspace: "temporary" },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(resolveRunConfiguration(["--runtime", path], cwd, {}));
  }
  await assert.rejects(resolveRunConfiguration(["--param", "missing-equals"], cwd, {}), /key=value/);
  await assert.rejects(resolveRunConfiguration(["--param", "key=one", "--param", "key=two"], cwd, {}), /Duplicate/);
  await assert.rejects(resolveRunConfiguration(["--worktree-path", "somewhere"], cwd, {}), /worktree/);
});

test("project runtime overrides personal runtime and explicit config errors are not swallowed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-runtime-"));
  const home = join(cwd, "personal");
  for (const dir of [join(home, "runtimes"), join(cwd, ".ralphworks", "runtimes")]) await mkdir(dir, { recursive: true });
  await writeFile(join(home, "runtimes", "dev.json"), JSON.stringify({ version: 1, model: "personal/model" }));
  await writeFile(join(cwd, ".ralphworks", "runtimes", "dev.json"), JSON.stringify({ version: 1, model: "project/model" }));
  assert.deepEqual((await resolveRunConfiguration(["--runtime", "dev"], cwd, { RALPHWORKS_HOME: home })).modelRef, {
    provider: "project",
    id: "model",
  });
  await writeFile(join(cwd, ".ralphworks", "config.json"), JSON.stringify({ version: 1, unknown: true }));
  await assert.rejects(resolveRunConfiguration([], cwd, { RALPHWORKS_HOME: home }), /Unknown/);
});

test("runtime binds logical MCP requirements through environment variable references", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-runtime-mcp-"));
  const path = join(cwd, "runtime.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      mcp: { docs: { transport: "stdio", command: "node", args: ["server.mjs"], cwd: "services", env: { TOKEN: "DOCS_TOKEN" } } },
    }),
  );
  const resolved = await resolveRunConfiguration(["--runtime", path], cwd, {});
  assert.deepEqual(resolved.mcpBindings?.docs, {
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    cwd: join(cwd, "services"),
    env: { TOKEN: "DOCS_TOKEN" },
  });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      mcp: { docs: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "literal-secret-value" } } },
    }),
  );
  await assert.rejects(resolveRunConfiguration(["--runtime", path], cwd, {}), /environment variable/);
});
