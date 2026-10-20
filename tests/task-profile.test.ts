import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectProfile, listProfiles, removeCollectedProfile, resolveTaskProfile } from "../src/task-profile.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-profile-"));
  return { cwd, home: join(cwd, "personal") };
}
async function bundle(path: string, data: object, files: Record<string, string> = {}) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "profile.json"), JSON.stringify({ version: 1, name: "sample", ...data }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(path, name, ".."), { recursive: true });
    await writeFile(join(path, name), text);
  }
  return path;
}

test("composes profiles, substitutes parameters and fingerprints supporting skill files", async () => {
  const options = await fixture();
  const base = await bundle(
    join(options.cwd, "base"),
    {
      prompts: ["prompt.md"],
      skills: ["skill"],
      parameters: { target: null, style: "brief" },
      defaults: { maxIterations: 3 },
      checks: ["base check"],
    },
    { "prompt.md": "Fix {{target}}.", "skill/SKILL.md": "Use {{style}} steps.", "skill/references/guide.md": "Supporting guidance" },
  );
  const child = await bundle(
    join(options.cwd, "child"),
    {
      extends: [base],
      parameters: { style: "careful" },
      prompts: ["extra.md"],
      defaults: { maxMinutes: 12 },
      checks: [],
      artifacts: ["report.md"],
    },
    { "extra.md": "Explain {{target}}." },
  );
  const result = await resolveTaskProfile(child, { ...options, params: { target: "login" } });
  assert.match(result.task, /Fix login\./);
  assert.match(result.task, /Use careful steps\./);
  assert.match(result.task, /Explain login\./);
  assert.match(result.task, /report.md/);
  assert.deepEqual(result.defaults, { maxIterations: 3, maxMinutes: 12 });
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.skillPaths, [await realpath(join(base, "skill", "SKILL.md"))]);
  assert.ok(result.manifest.resources.some((entry) => entry.path.endsWith("references/guide.md") && /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(result.manifest.parameters, { target: "login", style: "careful" });
  const previous = result.manifest.resources;
  await writeFile(join(base, "skill/references/guide.md"), "Changed");
  assert.notDeepEqual((await resolveTaskProfile(child, { ...options, params: { target: "login" } })).manifest.resources, previous);
});

test("project profiles override personal names and list deterministic entries", async () => {
  const options = await fixture();
  await bundle(join(options.home, "profiles", "review"), { description: "personal" });
  await bundle(join(options.cwd, ".ralphworks/profiles/review"), { description: "project" });
  assert.equal((await listProfiles(options)).find((p) => p.name === "review")?.description, "project");
  assert.equal((await resolveTaskProfile("review", options)).name, "sample");
});

test("rejects unknown fields, invalid defaults and invalid parameter declarations", async () => {
  const options = await fixture();
  for (const data of [
    { model: "provider/model" },
    { executor: "host" },
    { defaults: { maxIterations: 0 } },
    { defaults: { maxMinutes: "five" } },
    { defaults: { model: "x" } },
    { parameters: { target: 3 } },
    { prompts: "p.md" },
    { version: 2 },
    { checks: [""] },
    { artifacts: ["../outside"] },
  ]) {
    const path = await bundle(join(options.cwd, "invalid"), data);
    await assert.rejects(resolveTaskProfile(path, options));
  }
});

test("rejects missing resources, cycles and unresolved parameters before executing", async () => {
  const options = await fixture();
  const path = join(options.cwd, "profile");
  await bundle(path, { prompts: ["missing.md"] });
  await assert.rejects(resolveTaskProfile(path, options), /ENOENT/);
  await bundle(path, { extends: ["."] });
  await assert.rejects(resolveTaskProfile(path, options), /cycl/i);
  await bundle(path, { parameters: { target: null }, prompts: ["p.md"] }, { "p.md": "{{target}}" });
  await assert.rejects(resolveTaskProfile(path, options), /required.*target/i);
  await assert.rejects(resolveTaskProfile(path, { ...options, params: { typo: "x" } }), /unknown.*typo/i);
  await bundle(path, { prompts: ["p.md"] }, { "p.md": "{{undefined}}" });
  await assert.rejects(resolveTaskProfile(path, options), /undefined/);
});

test("collection flattens inheritance and preserves complete skills without overwriting", async () => {
  const options = await fixture();
  const originalNames = (await listProfiles(options)).map((profile) => profile.name);
  const base = await bundle(
    join(options.cwd, "base"),
    { prompts: ["p.md"], skills: ["skill"], parameters: { target: null } },
    {
      "p.md": "Fix {{target}}",
      "skill/SKILL.md": "Consult references/help.md",
      "skill/references/help.md": "Advice",
      "skill/scripts/run.sh": "echo checked",
    },
  );
  const child = await bundle(join(options.cwd, "child"), { extends: [base], checks: ["true"] });
  const destination = await collectProfile(child, "saved", options);
  await assert.rejects(collectProfile(child, "saved", options), /exist/i);
  await rm(base, { recursive: true });
  await rm(child, { recursive: true });
  const result = await resolveTaskProfile("saved", { ...options, params: { target: "bug" } });
  assert.match(result.task, /Fix bug/);
  assert.equal(await readFile(join(result.skillPaths[0], "../references/help.md"), "utf8"), "Advice");
  assert.equal(JSON.parse(await readFile(join(destination, "profile.json"), "utf8")).extends, undefined);
  await removeCollectedProfile("saved", options);
  assert.deepEqual(
    (await listProfiles(options)).map((p) => p.name),
    originalNames,
  );
  await assert.rejects(removeCollectedProfile("../outside", options), /name/i);
});

test("collection rejects symlinks and resolution enforces bounded resources", async () => {
  const options = await fixture();
  const path = await bundle(join(options.cwd, "profile"), { skills: ["skill"] }, { "skill/SKILL.md": "Instructions" });
  await symlink(join(path, "skill/SKILL.md"), join(path, "skill/link.md"));
  await assert.rejects(collectProfile(path, "saved", options), /symlink/i);
  await rm(join(path, "skill/link.md"));
  await writeFile(join(path, "skill/huge.md"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(resolveTaskProfile(path, options), /1 MiB/);
});

test("required parameters named like object properties remain required", async () => {
  const options = await fixture();
  const path = await bundle(
    join(options.cwd, "profile"),
    { parameters: { constructor: null }, prompts: ["p.md"] },
    { "p.md": "{{constructor}}" },
  );
  await assert.rejects(resolveTaskProfile(path, { ...options, params: {} }), /Required profile parameter: constructor/);
});

test("repeated inherited resources are deduplicated and checks use the last declared ancestor", async () => {
  const options = await fixture();
  await bundle(
    join(options.cwd, ".ralphworks/profiles/base"),
    { prompts: ["p.md"], defaults: { maxIterations: 2, commit: "none" }, checks: ["first"] },
    { "p.md": "Shared instructions" },
  );
  await bundle(join(options.cwd, ".ralphworks/profiles/other"), { extends: ["base"], checks: ["second"] });
  const path = await bundle(join(options.cwd, "profile"), { extends: ["base", "other"], defaults: { commit: "verified" } });
  const result = await resolveTaskProfile(path, options);
  assert.equal(result.task, "Shared instructions");
  assert.deepEqual(result.checks, ["second"]);
  assert.deepEqual(result.defaults, { maxIterations: 2, commit: "verified" });
  assert.equal(result.manifest.sources.length, 3);
});

test("resource count bounds reject oversized skills before collection", async () => {
  const options = await fixture();
  const path = await bundle(join(options.cwd, "profile"), { skills: ["skill"] }, { "skill/SKILL.md": "Instructions" });
  for (let index = 0; index < 101; index++) await writeFile(join(path, "skill", `${index}.md`), "small");
  await assert.rejects(resolveTaskProfile(path, options), /100 files/);
  await assert.rejects(collectProfile(path, "saved", options), /100 files/);
});

test("rejects invalid profile schemas and numeric defaults", async () => {
  const options = await fixture();
  const invalid = [
    null,
    [],
    { version: 1, name: "" },
    { version: 1, name: "x", description: 1 },
    ...[
      { defaults: [] },
      { parameters: [] },
      { parameters: { "bad-name": null } },
      { defaults: { maxCostUsd: -1 } },
      { defaults: { checkTimeoutSeconds: 0 } },
      { defaults: { completionPromise: "" } },
      { defaults: { commit: "always" } },
      { prompts: ["/absolute.md"] },
      { skills: ["/skill"] },
      { skills: [""] },
    ].map((item) => ({ version: 1, name: "x", ...item })),
  ];
  const path = await bundle(join(options.cwd, "profile"), {});
  for (const data of invalid) {
    await writeFile(join(path, "profile.json"), JSON.stringify(data));
    await assert.rejects(resolveTaskProfile(path, options));
  }
  await assert.rejects(resolveTaskProfile("missing", options), /not found/);
});

test("personal library removal leaves project profiles intact", async () => {
  const options = await fixture();
  await bundle(join(options.cwd, ".ralphworks/profiles/review"), { description: "project" });
  await bundle(join(options.home, "profiles/review"), { description: "personal" });
  await removeCollectedProfile("review", options);
  assert.equal((await listProfiles(options)).find((p) => p.name === "review")?.description, "project");
});

test("skill file references must identify SKILL.md", async () => {
  const options = await fixture();
  const path = await bundle(join(options.cwd, "profile"), { skills: ["instructions.md"] }, { "instructions.md": "Instructions" });
  await assert.rejects(resolveTaskProfile(path, options), /SKILL.md/);
});

test("template parameter values are inserted literally once", async () => {
  const options = await fixture();
  const path = await bundle(
    join(options.cwd, "profile"),
    { parameters: { target: null }, prompts: ["p.md"] },
    { "p.md": "Target: {{ target }}" },
  );
  const result = await resolveTaskProfile(path, { ...options, params: { target: "{{unknown}} $& $1" } });
  assert.equal(result.task, "Target: {{unknown}} $& $1");
});

test("listing skips unrelated files and incomplete bundles but reports invalid manifests", async () => {
  const options = await fixture();
  const originalNames = (await listProfiles(options)).map((profile) => profile.name);
  await bundle(join(options.home, "profiles/valid"), {});
  await writeFile(join(options.home, "profiles/notes.txt"), "Personal notes");
  await mkdir(join(options.home, "profiles/incomplete"));
  assert.deepEqual(
    (await listProfiles(options)).map((profile) => profile.name),
    [...originalNames, "valid"].sort(),
  );
  await bundle(join(options.home, "profiles/invalid"), { model: "unsupported" });
  await assert.rejects(listProfiles(options), /Unknown profile field: model/);
});

test("environment inheritance preserves explicit fields and collects portable complete extensions", async () => {
  const options = await fixture();
  const base = await bundle(
    join(options.cwd, "base"),
    {
      environment: {
        resourceInheritance: "project",
        tools: ["read"],
        extensions: ["extension"],
        contextFiles: ["context.md"],
        mcp: { repo: { tools: ["get"] } },
        requires: { commands: ["git"], env: ["TOKEN"] },
      },
      outputs: [{ path: "report.json", format: "json" }],
    },
    { "extension/index.ts": "import './support.ts'", "extension/support.ts": "export const x = 1", "context.md": "Project knowledge" },
  );
  const sibling = await bundle(join(options.cwd, "sibling"), { environment: { requires: { commands: ["node"] } } });
  const child = await bundle(join(options.cwd, "child"), {
    extends: [base, sibling],
    environment: { tools: [], mcp: { repo: { required: false } }, requires: { commands: ["git"] } },
    outputs: [{ path: "report.json", format: "text" }],
  });
  const result = await resolveTaskProfile(child, options);
  assert.equal(result.environment.resourceInheritance, "project");
  assert.deepEqual(result.environment.tools, []);
  assert.deepEqual(result.environment.requires, { commands: ["git", "node"], env: ["TOKEN"] });
  assert.deepEqual(result.environment.mcp, { repo: { required: false } });
  assert.deepEqual(result.outputs, [{ path: "report.json", format: "text" }]);
  assert.ok(result.manifest.resources.some((r) => r.path.endsWith("extension/support.ts")));
  const saved = await collectProfile(child, "saved", options);
  await rm(base, { recursive: true });
  await rm(child, { recursive: true });
  await rm(sibling, { recursive: true });
  const collected = await resolveTaskProfile("saved", options);
  assert.equal(await readFile(join(collected.environment.extensions[0], "support.ts"), "utf8"), "export const x = 1");
  assert.equal(await readFile(collected.environment.contextFiles[0], "utf8"), "Project knowledge");
  assert.ok(collected.environment.extensions[0].startsWith(await realpath(saved)));
  assert.deepEqual(collected.outputs, result.outputs);
});

test("built-in bundles work directly and explicit builtin names bypass shadowing", async () => {
  const options = await fixture();
  for (const name of ["bugfix", "code-review"]) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.equal(profile.environment.resourceInheritance, "none");
    assert.ok(profile.task.length > 100);
    assert.equal(profile.skillPaths.length, 1);
  }
  await bundle(join(options.cwd, ".ralphworks/profiles/bugfix"), { name: "custom" });
  assert.equal((await resolveTaskProfile("bugfix", options)).name, "custom");
  assert.equal((await resolveTaskProfile("builtin:bugfix", options)).name, "bugfix");
});

test("output and environment manifests reject invalid fields and unsafe output paths", async () => {
  const options = await fixture();
  for (const data of [
    { environment: { inheritGlobalResources: true } },
    { outputs: [{ path: "../escape" }] },
    { outputs: [{ path: "x", format: "xml" }] },
    { outputs: [{ path: "x", required: "yes" }] },
    { outputs: [{ path: "x", other: true }] },
    { outputs: {} },
    { environment: { extensions: ["missing"] } },
  ]) {
    const path = await bundle(join(options.cwd, "invalid"), data);
    await assert.rejects(resolveTaskProfile(path, options));
  }
});

test("typed parameters validate values and defaults before literal substitution", async () => {
  const options = await fixture();
  const path = await bundle(
    join(options.cwd, "typed"),
    {
      parameters: {
        count: { type: "number", default: 3 },
        enabled: { type: "boolean", default: true },
        mode: { type: "string", enum: ["fast", "careful"], required: true },
      },
      prompts: ["prompt.md"],
    },
    { "prompt.md": "{{count}} {{enabled}} {{mode}}" },
  );
  assert.equal(
    (await resolveTaskProfile(path, { ...options, params: { count: "4", enabled: "false", mode: "fast" } })).task,
    "4 false fast",
  );
  assert.equal((await resolveTaskProfile(path, { ...options, params: { mode: "careful" } })).task, "3 true careful");
  for (const params of [{ mode: "other" }, { mode: "fast", count: "abc" }, { mode: "fast", enabled: "yes" }, {}] as Record<
    string,
    string
  >[])
    await assert.rejects(resolveTaskProfile(path, { ...options, params }));
  for (const declaration of [
    { type: "number", default: "3" },
    { type: "boolean", default: true, other: 1 },
    { type: "unknown" },
    { type: "number", required: false },
    { type: "number", default: 3, enum: ["3"] },
    { type: "string", default: "x", enum: ["y"] },
  ]) {
    await bundle(path, { parameters: { x: declaration } });
    await assert.rejects(resolveTaskProfile(path, options));
  }
});

test("resource inheritance is opt-in and descendant declarations override ancestors", async () => {
  const options = await fixture();
  const base = await bundle(join(options.cwd, "base"), { environment: { resourceInheritance: "all", tools: ["read"] } });
  const child = await bundle(join(options.cwd, "child"), { extends: [base], environment: { resourceInheritance: "none" } });
  assert.equal((await resolveTaskProfile(child, options)).environment.resourceInheritance, "none");
  assert.deepEqual((await resolveTaskProfile(child, options)).environment.tools, ["read"]);
  const basic = await bundle(join(options.cwd, "basic"), {});
  assert.equal((await resolveTaskProfile(basic, options)).environment.resourceInheritance, "none");
});

test("extension support and context changes affect fingerprints and symlinks are rejected", async () => {
  const options = await fixture();
  const path = await bundle(
    join(options.cwd, "source"),
    { environment: { extensions: ["extensions/tool.ts"], contextFiles: ["context.md"] } },
    { "extensions/tool.ts": "import './helper.ts'", "extensions/helper.ts": "initial", "context.md": "initial" },
  );
  const initial = await resolveTaskProfile(path, options);
  await writeFile(join(path, "extensions/helper.ts"), "changed");
  const changed = await resolveTaskProfile(path, options);
  assert.notDeepEqual(changed.manifest.resources, initial.manifest.resources);
  await writeFile(join(path, "context.md"), "changed");
  assert.notDeepEqual((await resolveTaskProfile(path, options)).manifest.resources, changed.manifest.resources);
  const saved = await collectProfile(path, "saved-file", options);
  await rm(path, { recursive: true });
  const collected = await resolveTaskProfile("saved-file", options);
  assert.equal(await readFile(join(collected.environment.extensions[0], "../helper.ts"), "utf8"), "changed");
  await symlink(join(saved, "profile.json"), join(saved, "extensions/0/link.json"));
  await assert.rejects(resolveTaskProfile("saved-file", options), /symlink/);
});

test("category is optional open metadata with ordered inheritance and portable collection", async () => {
  const options = await fixture();
  const first = await bundle(join(options.cwd, "first"), { category: "custom-team" });
  const second = await bundle(join(options.cwd, "second"), { category: "quality" });
  const child = await bundle(join(options.cwd, ".ralphworks/profiles/child"), { extends: [first, second] });
  assert.equal((await resolveTaskProfile(child, options)).category, "quality");
  // Listing exposes the composed category, including profiles that only inherit it.
  assert.equal((await listProfiles(options)).find(({ name }) => name === "child")?.category, "quality");
  await bundle(child, { extends: [first, second], category: "design" });
  assert.equal((await resolveTaskProfile(child, options)).category, "design");
  const saved = await collectProfile(child, "saved-category", options);
  assert.equal(JSON.parse(await readFile(join(saved, "profile.json"), "utf8")).category, "design");
  await rm(first, { recursive: true });
  await rm(second, { recursive: true });
  assert.equal((await resolveTaskProfile(saved, options)).category, "design");
  const plain = await bundle(join(options.cwd, "plain"), {});
  assert.equal(Object.hasOwn(await resolveTaskProfile(plain, options), "category"), false);
  const collectedPlain = await collectProfile(plain, "plain", options);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(collectedPlain, "profile.json"), "utf8")), "category"), false);
  for (const category of ["", "  ", 1, null, []]) {
    const invalid = await bundle(join(options.cwd, "invalid-category"), { category });
    await assert.rejects(resolveTaskProfile(invalid, options), /category.*non-empty string/i);
  }
});

test("category listing detects inheritance cycles and depth without resolving skill assets", async () => {
  const options = await fixture();
  const parent = await bundle(join(options.cwd, "parent"), { category: "custom", skills: ["unavailable"] });
  const child = await bundle(join(options.cwd, ".ralphworks/profiles/child"), { extends: [parent] });
  assert.equal((await listProfiles(options)).find(({ name }) => name === "child")?.category, "custom");
  await assert.rejects(resolveTaskProfile(child, options), /ENOENT/);
  await bundle(child, { extends: ["."] });
  await assert.rejects(listProfiles(options), /cycle/);
  let ancestor = await bundle(join(options.cwd, "level-0"), { category: "custom" });
  for (let index = 1; index <= 32; index++) ancestor = await bundle(join(options.cwd, `level-${index}`), { extends: [ancestor] });
  await bundle(child, { extends: [ancestor] });
  await assert.rejects(listProfiles(options), /32 levels/);
});
