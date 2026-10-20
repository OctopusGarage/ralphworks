import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { connectMcpTools } from "../src/mcp-client.ts";
import { resolveRunConfiguration } from "../src/runtime.ts";
import { SkillHub } from "../src/skill-hub.ts";
import { snapshotManifest } from "../src/skill-snapshot.ts";
import { checkTaskPrerequisites, validateMcpRequirements, validateTaskOutputs } from "../src/task-contracts.ts";
import { collectProfile, resolveTaskProfile } from "../src/task-profile.ts";

const example = (name: string) => resolve("examples/profiles", name);
const isolated = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-capability-"));
  return { cwd, home: join(cwd, "home") };
};

test("coverage selects the complete upstream test-quality bundle with repair tools", async () => {
  const options = await isolated();
  const profile = await resolveTaskProfile("builtin:test-coverage", options);
  const pin = profile.manifest.hubSkills?.[0];
  assert.ok(pin);
  assert.equal(pin.logical, "builtin:brooks-test");
  assert.equal(pin.entrypoint, "brooks-test/SKILL.md");
  const { logical: _logical, ...selectedPin } = pin;
  const root = await new SkillHub(options).directory(selectedPin);
  const manifest = await snapshotManifest(root, false, pin.entrypoint);
  for (const required of ["_shared/common.md", "_shared/source-coverage.md", ".upstream/LICENSE", "brooks-test/SKILL.md"])
    assert.ok(
      manifest.files.some(({ path }) => path === required),
      required,
    );
  assert.ok(profile.environment.tools.includes("edit"));
  assert.deepEqual(profile.outputs, [{ path: "COVERAGE_REPORT.md", format: "text", required: true }]);
  assert.equal((await validateTaskOutputs(profile.outputs, options.cwd))[0].exitCode, 1);
});

test("browser variants compose upstream expertise and require an explicitly installed command", async () => {
  const options = await isolated();
  for (const name of [
    "ui-with-playwright",
    "ux-with-playwright",
    "accessibility-with-playwright",
    "coverage-with-playwright",
    "web-performance-with-playwright",
  ]) {
    const profile = await resolveTaskProfile(example(name), options);
    assert.ok(profile.manifest.hubSkills?.some(({ logical }) => logical === "builtin:playwright-cli"));
    assert.ok(profile.environment.tools.includes("bash"));
    assert.deepEqual(profile.environment.requires.commands, ["playwright-cli"]);
    assert.deepEqual(profile.environment.mcp, {});
    assert.equal(profile.environment.resourceInheritance, "none");
    await assert.rejects(
      checkTaskPrerequisites(profile.environment, options.cwd, { PATH: join(options.cwd, "empty-bin") }),
      /playwright-cli/,
    );
    const collected = await collectProfile(example(name), name, options);
    const portable = await resolveTaskProfile(collected, options);
    assert.deepEqual(portable.outputs, profile.outputs);
    assert.equal(portable.skillPaths.length, profile.skillPaths.length);
  }
  const ui = await resolveTaskProfile(example("ui-with-playwright"), options);
  assert.deepEqual(
    ui.manifest.hubSkills?.map(({ logical }) => logical),
    ["builtin:anthropic-frontend-design", "builtin:playwright-cli"],
  );
  const ux = await resolveTaskProfile(example("ux-with-playwright"), options);
  assert.equal(ux.environment.tools.includes("edit"), false);
  assert.deepEqual(ux.outputs, [{ path: "UX_REPORT.md", format: "text", required: true }]);
  assert.equal((await resolveTaskProfile(example("coverage-with-playwright"), options)).manifest.parameters.includeE2E, "true");
});

test("documentation and graph variants preserve task tool limits and expose precise optional services", async () => {
  const options = await isolated();
  for (const name of ["coding-with-docs", "bugfix-with-docs", "docs-with-docs", "review-with-docs"]) {
    const profile = await resolveTaskProfile(example(name), options);
    assert.deepEqual(profile.environment.mcp, {
      docs: { tools: ["resolve-library-id", "query-docs"], required: false, timeoutSeconds: 30 },
    });
    validateMcpRequirements(profile.environment, {});
    const unavailable = await connectMcpTools(profile.environment.mcp, {}, { cwd: options.cwd });
    assert.equal(unavailable.inventory[0].status, "unavailable");
    assert.equal(unavailable.tools.length, 0);
    await unavailable.close();
  }
  for (const name of ["architecture-with-codegraph", "review-with-codegraph"]) {
    const profile = await resolveTaskProfile(example(name), options);
    assert.deepEqual(profile.environment.mcp, { graph: { tools: ["codegraph_explore"], required: false, timeoutSeconds: 30 } });
    validateMcpRequirements(profile.environment, {});
  }
  for (const name of ["review-with-docs", "review-with-codegraph"])
    assert.deepEqual((await resolveTaskProfile(example(name), options)).environment.tools, ["read", "grep", "find", "ls"]);
});

test("DeepWiki research requires an explicit repository and provider binding", async () => {
  const options = await isolated();
  await assert.rejects(resolveTaskProfile(example("repository-research-with-deepwiki"), options), /repository/);
  const profile = await resolveTaskProfile(example("repository-research-with-deepwiki"), {
    ...options,
    params: { repository: "microsoft/playwright" },
  });
  assert.deepEqual(profile.environment.tools, ["read", "write", "grep", "find", "ls"]);
  assert.deepEqual(profile.environment.mcp, {
    wiki: { tools: ["read_wiki_structure", "read_wiki_contents", "ask_wiki_question"], required: true, timeoutSeconds: 60 },
  });
  assert.throws(() => validateMcpRequirements(profile.environment, {}), /wiki/);
  const runtime = await resolveRunConfiguration(["--runtime", resolve("examples/runtimes/deepwiki.json")], options.cwd, {});
  validateMcpRequirements(profile.environment, runtime.mcpBindings ?? {});
  assert.deepEqual(runtime.mcpBindings?.wiki, { transport: "http", url: "https://mcp.deepwiki.com/mcp" });
});

test("runtime templates keep models and credentials independent from capability selection", async () => {
  const options = await isolated();
  const docs = await resolveRunConfiguration(["--runtime", resolve("examples/runtimes/context7.json")], options.cwd, {});
  assert.deepEqual(docs.mcpBindings?.docs, {
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    headers: { Authorization: "CONTEXT7_AUTHORIZATION" },
  });
  const graph = await resolveRunConfiguration(["--runtime", resolve("examples/runtimes/codegraph.json")], options.cwd, {});
  assert.deepEqual(graph.mcpBindings?.graph, { transport: "stdio", command: "codegraph", args: ["serve", "--mcp"] });
  for (const name of ["context7", "codegraph", "deepwiki"]) {
    const raw = JSON.parse(await readFile(resolve("examples/runtimes", `${name}.json`), "utf8"));
    assert.equal(raw.model, undefined);
    assert.equal(raw.executor, undefined);
    assert.equal(raw.workspace, undefined);
    assert.doesNotMatch(JSON.stringify(raw), /\/Users\/|alcove/i);
  }
});

test("provider tool allowlists connect through MCP and exclude unrelated mutation tools", async () => {
  const options = await isolated();
  for (const [name, alias, params] of [
    ["review-with-docs", "docs", {}],
    ["review-with-codegraph", "graph", {}],
    ["repository-research-with-deepwiki", "wiki", { repository: "public/example" }],
  ] as const) {
    const profile = await resolveTaskProfile(example(name), { ...options, params });
    const connected = await connectMcpTools(
      profile.environment.mcp,
      { [alias]: { transport: "stdio", command: process.execPath, args: [resolve("tests/fixtures/capability-mcp-server.mjs")] } },
      { cwd: options.cwd, env: { PATH: process.env.PATH } },
    );
    try {
      const selected = profile.environment.mcp[alias].tools ?? [];
      assert.deepEqual(
        connected.tools.map(({ name }) => name),
        selected.map((tool) => `mcp__${alias}__${tool}`),
      );
      assert.equal(
        connected.tools.some(({ name }) => name.includes("mutate_repository")),
        false,
      );
      const tool = connected.tools[0];
      const result = await tool.execute(
        "fixture",
        { query: "public fixture" },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      );
      const content = result.content[0];
      assert.equal(content.type, "text");
      if (content.type === "text") assert.equal(JSON.parse(content.text).name, selected[0]);
    } finally {
      await connected.close();
    }
  }
});

test("built-in bugfix and design tasks carry an executable browser contract and preserve UX source boundaries", async () => {
  const options = await isolated();
  const bin = await mkdtemp(join(tmpdir(), "ralph-browser-bin-"));
  const command = join(bin, "playwright-cli");
  for (const name of ["bugfix", "ui-implementation", "ux-review"]) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.ok(profile.manifest.hubSkills?.some(({ logical }) => logical === "builtin:playwright-cli"));
    assert.ok(profile.environment.tools.includes("bash"));
    assert.equal(profile.environment.tools.includes("playwright-cli"), false);
    assert.deepEqual(profile.environment.requires.commands, ["playwright-cli"]);
    await assert.rejects(checkTaskPrerequisites(profile.environment, options.cwd, { PATH: join(bin, "missing") }), /playwright-cli/);
    assert.match(profile.task, /short unique task-owned named browser session/);
    assert.match(profile.task, /Close only the task's own session/);
    assert.match(profile.task, /Do not run npx/);
    if (name === "ux-review") {
      assert.equal(profile.environment.tools.includes("edit"), false);
      assert.match(profile.task, /do not edit implementation, tests or configuration/);
    }
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    await checkTaskPrerequisites(profile.environment, options.cwd, { PATH: bin });
  }
});

test("bugfix exposes Playwright in both reported and discovery modes", async () => {
  const options = await isolated();
  for (const mode of ["reported", "discover"]) {
    const profile = await resolveTaskProfile("builtin:bugfix", { ...options, params: { mode } });
    assert.equal(profile.manifest.parameters.mode, mode);
    assert.deepEqual(profile.outputs, [{ path: "BUGFIX_REPORT.md", format: "text", required: true }]);
    assert.deepEqual(profile.environment.requires.commands, ["playwright-cli"]);
    assert.match(profile.task, /Browser actions alone do not confirm a defect/);
  }
  for (const name of ["test-coverage", "performance"]) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.deepEqual(profile.environment.requires.commands, []);
    assert.ok(!profile.manifest.hubSkills?.some(({ logical }) => logical === "builtin:playwright-cli"));
  }
});
