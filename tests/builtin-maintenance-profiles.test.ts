import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveTask, stageTaskSkills } from "../src/resolved-task.ts";
import { resolveRunConfiguration } from "../src/runtime.ts";
import { snapshotManifest, verifySnapshot } from "../src/skill-snapshot.ts";
import { validateTaskOutputs } from "../src/task-contracts.ts";
import { collectProfile, listProfiles, resolveTaskProfile } from "../src/task-profile.ts";

const reports = {
  bugfix: "BUGFIX_REPORT.md",
  "domain-modeling": "MODEL_REPORT.md",
  "ui-implementation": "UI_REPORT.md",
  "ux-review": "UX_REPORT.md",
  performance: "PERFORMANCE_REPORT.md",
  architecture: "ARCHITECTURE_REPORT.md",
  "test-coverage": "COVERAGE_REPORT.md",
  "security-maintenance": "SECURITY_REPORT.md",
};
const selections: Record<string, string[]> = {
  bugfix: ["playwright-cli"],
  "test-coverage": ["brooks-test"],
  "domain-modeling": ["mattpocock-domain-modeling"],
  "ui-implementation": ["anthropic-frontend-design", "playwright-cli"],
  "ux-review": ["playwright-cli"],
  "code-review": ["sentry-code-review"],
  architecture: ["mattpocock-codebase-design", "mattpocock-improve-codebase-architecture"],
};
const builtinNames = [...Object.keys(reports), "code-review"];
const reportOnly = new Set(["ux-review"]);

async function isolated() {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-builtins-"));
  return { cwd, home: join(cwd, "empty-library") };
}

test("all nine built-ins resolve with verified selected skills or prompt-only guidance and no optional services", async () => {
  const options = await isolated();
  assert.deepEqual((await listProfiles(options)).map(({ name }) => name).sort(), builtinNames.sort());
  for (const name of ["code-review"]) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.equal(profile.name, name);
    assert.doesNotMatch(profile.task, /\{\{[^}]+\}\}/);
    for (const pin of profile.manifest.hubSkills ?? [])
      assert.ok(profile.skillPaths.includes(await verifySnapshot(join(process.cwd(), "skills"), pin.snapshot, pin.entrypoint)));
  }
  for (const [name, report] of Object.entries(reports)) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.equal(profile.name, name);
    assert.doesNotMatch(profile.task, /\{\{[^}]+\}\}/);
    assert.equal(profile.environment.resourceInheritance, "none");
    assert.deepEqual(profile.environment.mcp, {});
    assert.deepEqual(profile.environment.requires, {
      commands: ["bugfix", "ui-implementation", "ux-review"].includes(name) ? ["playwright-cli"] : [],
      env: [],
    });
    assert.deepEqual(profile.environment.extensions, []);
    assert.deepEqual(profile.environment.contextFiles, []);
    assert.deepEqual(profile.checks, []);
    assert.equal(profile.defaults.commit, "none");
    assert.ok((profile.defaults.maxIterations ?? 99) <= 6);
    assert.ok((profile.defaults.maxMinutes ?? 99) <= 45);
    assert.deepEqual(profile.outputs, [{ path: report, format: report.endsWith(".json") ? "json" : "text", required: true }]);
    assert.equal(profile.environment.tools?.includes("bash"), true);
    assert.equal(profile.environment.tools?.includes("edit"), !reportOnly.has(name));
    for (const pin of profile.manifest.hubSkills ?? []) {
      assert.equal(pin.scope, "builtin");
      const path = await verifySnapshot(join(process.cwd(), "skills"), pin.snapshot, pin.entrypoint);
      assert.ok(profile.skillPaths.includes(path));
    }
    assert.equal(profile.skillPaths.length, selections[name]?.length ?? 0);
    assert.ok((await validateTaskOutputs(profile.outputs, options.cwd)).every((result) => result.exitCode === 1));
    await writeFile(join(options.cwd, report), report.endsWith(".json") ? '{"suggestions":[]}' : "Evidence and limitations\n");
    assert.ok((await validateTaskOutputs(profile.outputs, options.cwd)).every((result) => result.exitCode === 0));
  }
});

test("maintenance parameters are typed and resolve into the selected method", async () => {
  const options = await isolated();
  const coverage = await resolveTaskProfile("builtin:test-coverage", {
    ...options,
    params: { scope: "src/auth", targetCoverage: "92", includeIntegration: "false", includeE2E: "true" },
  });
  assert.deepEqual(coverage.manifest.parameters, {
    scope: "src/auth",
    targetCoverage: "92",
    includeIntegration: "false",
    includeE2E: "true",
  });
  assert.match(coverage.task, /src\/auth/);
  assert.match(coverage.task, /92/);
  await assert.rejects(resolveTaskProfile("builtin:test-coverage", { ...options, params: { targetCoverage: "lots" } }), /number/);
  await assert.rejects(resolveTaskProfile("builtin:test-coverage", { ...options, params: { includeE2E: "yes" } }), /true or false/);
  await assert.rejects(resolveTaskProfile("builtin:bugfix", { ...options, params: { mode: "random" } }), /allowed|enum|one of/i);
});

test("built-in selections use upstream identities and leave other profiles prompt-only", async () => {
  const options = await isolated();
  for (const name of builtinNames) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.deepEqual(
      profile.manifest.hubSkills?.map(({ logical }) => logical) ?? [],
      (selections[name] ?? []).map((skill) => `builtin:${skill}`),
    );
    const lock = JSON.parse(await readFile(join(process.cwd(), "profiles", name, "profile.lock.json"), "utf8"));
    assert.deepEqual(
      Object.keys(lock.skills),
      (selections[name] ?? []).map((skill) => `builtin:${skill}`),
    );
    assert.doesNotMatch(profile.task, /references\/evidence\.md|[a-z-]+-method/);
    assert.doesNotMatch(profile.task, /(?:^|\n)md\.|[a-z]\.md(?:\.| and)/);
    assert.match(profile.task, /evidence/i);
    if (selections[name]) assert.match(profile.task, /(methodology|methods), not permissions/);
  }
});

test("collected maintenance profiles stage complete pinned skills in a fresh workspace", async (t) => {
  const options = await isolated();
  const previousHome = process.env.RALPHWORKS_HOME;
  process.env.RALPHWORKS_HOME = options.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.RALPHWORKS_HOME;
    else process.env.RALPHWORKS_HOME = previousHome;
  });
  for (const name of builtinNames) {
    const collected = await collectProfile(`builtin:${name}`, `saved-${name}`, options);
    const profile = await resolveTaskProfile(join(collected, "profile.json"), options);
    const staged = await stageTaskSkills(
      await resolveTask("Maintain this repository", { cwd: options.cwd, profile: join(collected, "profile.json") }),
      options.cwd,
    );
    assert.equal(staged.skillPaths.length, profile.skillPaths.length);
    for (const [index, path] of staged.skillPaths.entries()) {
      assert.ok(path.startsWith(join(options.cwd, ".ralph", "inputs")));
      assert.equal(await readFile(path, "utf8"), await readFile(profile.skillPaths[index], "utf8"));
      const source = profile.skillRoots?.[index] ?? dirname(profile.skillPaths[index]);
      const destination = staged.skillRoots?.[index] ?? dirname(path);
      const entrypoint = profile.manifest.hubSkills?.[index]?.entrypoint;
      const manifest = await snapshotManifest(source, false, entrypoint);
      assert.deepEqual(await snapshotManifest(destination, false, entrypoint), manifest);
      for (const file of manifest.files)
        assert.deepEqual(await readFile(join(destination, file.path)), await readFile(join(source, file.path)));
    }
  }
});

test("shipped maintenance policies preserve evidence, completion, and report-only boundaries", async () => {
  const options = await isolated();
  const coverage = await resolveTaskProfile("builtin:test-coverage", options);
  assert.match(coverage.task, /line coverage/);
  assert.match(coverage.task, /Do not signal DONE while the requested threshold remains unresolved/);
  assert.match(coverage.task, /Never invent coverage percentages/);
  assert.match(coverage.task, /metric padding/);
  assert.match(coverage.task, /baseline already meets the target/);
  assert.match(coverage.task, /do not require a production change/);
  assert.match(coverage.task, /do not change correct production code merely to manufacture a failing test/);
  for (const name of Object.keys(reports)) {
    const profile = await resolveTaskProfile(`builtin:${name}`, options);
    assert.match(profile.task, /RalphWorks owns commit policy/);
    assert.doesNotMatch(profile.task, /or contact external services/);
    if (reportOnly.has(name)) {
      assert.deepEqual(profile.environment.tools, ["read", "bash", "write", "grep", "find", "ls"]);
      assert.match(profile.task, /report-only/);
      assert.match(profile.task, /write only/i);
    }
  }
  for (const [name, parameter] of [
    ["ux-review", "maxFindings"],
    ["performance", "maxChanges"],
    ["architecture", "maxChanges"],
    ["bugfix", "maxFixes"],
    ["security-maintenance", "maxFixes"],
    ["test-coverage", "targetCoverage"],
  ]) {
    const profile = await resolveTaskProfile(`builtin:${name}`, { ...options, params: { [parameter]: "-1" } });
    // The schema supports numeric types, while prompt policy must reject out-of-range values before mutation.
    assert.equal(profile.manifest.parameters[parameter], "-1");
    assert.match(profile.task, /Before (editing|writing the report), require/);
    assert.match(profile.task, /needs-input/);
  }
});

test("design and performance profiles expose bounded typed task inputs and categories", async () => {
  const options = await isolated();
  for (const [name, parameter, value, category] of [
    ["ui-implementation", "scope", "src/ui", "design"],
    ["ux-review", "maxFindings", "2", "design"],
    ["performance", "maxChanges", "2", "quality"],
  ]) {
    const profile = await resolveTaskProfile(`builtin:${name}`, { ...options, params: { [parameter]: value } });
    assert.equal(profile.category, category);
    assert.equal(profile.manifest.parameters[parameter], value);
    assert.equal(profile.defaults.maxIterations, 5);
    assert.equal(profile.defaults.maxMinutes, 30);
    if (parameter !== "scope")
      await assert.rejects(resolveTaskProfile(`builtin:${name}`, { ...options, params: { [parameter]: "many" } }), /number/);
  }
  assert.deepEqual((await resolveTaskProfile("builtin:code-review", options)).environment.tools, ["read", "grep", "find", "ls"]);
  const listed = await listProfiles(options);
  for (const entry of listed) assert.equal((await resolveTaskProfile(`builtin:${entry.name}`, options)).category, entry.category);
});

test("all archived built-in snapshots remain valid and current pins match the catalog", async () => {
  const root = join(process.cwd(), "skills");
  const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
  for (const [name, raw] of Object.entries(catalog.entries)) {
    const entry = raw as { current: string; revisions: { snapshot: string; entrypoint?: string }[] };
    assert.ok(entry.revisions.some(({ snapshot }) => snapshot === entry.current));
    for (const revision of entry.revisions) await verifySnapshot(root, revision.snapshot, revision.entrypoint);
    if (Object.values(selections).some((skills) => skills.includes(name))) {
      for (const profileName of builtinNames.filter((profileName) => selections[profileName]?.includes(name))) {
        const profile = await resolveTaskProfile(`builtin:${profileName}`, await isolated());
        assert.equal(profile.manifest.hubSkills?.find(({ logical }) => logical === `builtin:${name}`)?.snapshot, entry.current);
      }
    }
  }
});

test("browser UI example keeps portable method selection separate from runtime connection", async () => {
  const options = await isolated();
  const source = join(process.cwd(), "examples/profiles/browser-ui");
  const profile = await resolveTaskProfile(source, options);
  assert.equal(profile.category, "design");
  assert.deepEqual(profile.environment.mcp, { browser: { required: true, timeoutSeconds: 60 } });
  const builtin = await resolveTaskProfile("builtin:ui-implementation", options);
  assert.deepEqual(profile.outputs, builtin.outputs);
  assert.deepEqual(
    profile.manifest.hubSkills?.map(({ logical }) => logical),
    ["builtin:anthropic-frontend-design", "builtin:playwright-cli"],
  );
  assert.deepEqual(profile.environment.tools, builtin.environment.tools);
  assert.deepEqual(profile.environment.requires, { commands: ["playwright-cli"], env: [] });
  const collected = await collectProfile(source, "browser-ui", options);
  const portable = await resolveTaskProfile(collected, options);
  assert.deepEqual(portable.environment.mcp, profile.environment.mcp);
  assert.deepEqual(portable.outputs, profile.outputs);
  const runtime = await resolveRunConfiguration(["--runtime", join(process.cwd(), "examples/runtimes/browser-http.json")], options.cwd, {});
  assert.deepEqual(runtime.mcpBindings, { browser: { transport: "http", url: "http://127.0.0.1:8319/mcp" } });
});

test("a portable profile lock keeps its original built-in snapshot after catalog improvements", async () => {
  const options = await isolated();
  const directory = await collectProfile(join(process.cwd(), "examples/profiles/coding"), "legacy-coding", options);
  const original = "097967623b631275086b6fa463fba5b93f3d03b3a1cba82f1a2e9e936637b616";
  const manifestPath = join(directory, "profile.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.skills = ["builtin:coding"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    join(directory, "profile.lock.json"),
    JSON.stringify({ version: 1, skills: { "builtin:coding": { scope: "builtin", snapshot: original } } }),
  );
  const legacy = await resolveTaskProfile(directory, options);
  assert.equal(legacy.manifest.hubSkills?.[0].snapshot, original);
  assert.deepEqual(legacy.skillPaths, [await verifySnapshot(join(process.cwd(), "skills"), original)]);
  const current = await resolveTaskProfile(join(process.cwd(), "examples/profiles/coding"), options);
  assert.deepEqual(current.skillPaths, []);
});

const upstreamSources = [
  [
    "mattpocock-improve-codebase-architecture",
    "mattpocock/skills",
    "skills/engineering/improve-codebase-architecture",
    "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    "adbf9c1bfc35459473b615e1c8494a333a8fd413d044f90c35d55a3b54ee6956",
    "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
  ],
  [
    "anthropic-frontend-design",
    "anthropics/skills",
    "skills/frontend-design",
    "dbd4588f9e1033efb41dad4bef2f7947c8993d44",
    "2df8544cbcb4af1e766327b26c989128195e3e8da20fa6fcf780ed53a319f981",
  ],
  [
    "sentry-code-review",
    "getsentry/skills",
    "skills/code-review",
    "f57ada2d0b640406ea7e25b11d636c530e77c58b",
    "07b09e4217d7969fdd0ab39aaa17527b23aab921671fdd8add8cb328f5980ec0",
  ],
  [
    "mattpocock-codebase-design",
    "mattpocock/skills",
    "skills/engineering/codebase-design",
    "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    "9053baae04c550d02369b07fcdbb82038a017be0dfa2550de81d5b1ec023dce0",
  ],
  [
    "web-accessibility",
    "addyosmani/web-quality-skills",
    "skills/accessibility",
    "afa8da942115f2961fdbfa80807ea0b232ff6c00",
    "0538d84d7bca0e7ad4ed1c1cc141b163ebd4544753a33c00724fe9ddb4c8078b",
  ],
  [
    "web-performance",
    "addyosmani/web-quality-skills",
    "skills/performance",
    "afa8da942115f2961fdbfa80807ea0b232ff6c00",
    "4aae51d9c149d3f6ce3af50486073429192bcba983ca24f3995765ae1eaf19a4",
  ],
];

test("curated upstream assets retain exact GitHub provenance, licenses, and supporting resources offline", async () => {
  const root = join(process.cwd(), "skills");
  const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
  for (const [name, repo, path, commit, snapshot, ref = "main"] of upstreamSources) {
    const entry = catalog.entries[name];
    assert.equal(entry.current, snapshot);
    const pin = entry.revisions.find((revision: { snapshot: string }) => revision.snapshot === snapshot);
    assert.equal(pin.scope, "builtin");
    assert.equal(pin.use, `builtin:${name}`);
    assert.deepEqual(pin.source, { source: `https://github.com/${repo}`, path, ref, autoUpdate: false, kind: "github", commit });
    assert.doesNotMatch(JSON.stringify(pin), /\/tmp\/|\/Users\//);
    const skill = await verifySnapshot(root, snapshot);
    const manifest = await snapshotManifest(dirname(skill));
    assert.ok(
      manifest.files.some(({ path }) => /LICENSE/.test(path)),
      `${name} retains its license`,
    );
    const supportFiles: Record<string, string[]> = {
      "mattpocock-improve-codebase-architecture": ["HTML-REPORT.md", "agents/openai.yaml"],
      "mattpocock-codebase-design": ["DEEPENING.md", "DESIGN-IT-TWICE.md", "agents/openai.yaml"],
      "web-accessibility": ["references/A11Y-PATTERNS.md", "references/WCAG.md"],
      "web-performance": ["references/MEASUREMENT.md", "references/RUM.md"],
    };
    for (const support of supportFiles[name] ?? [])
      assert.ok(
        manifest.files.some(({ path }) => path === support),
        `${name} retains ${support}`,
      );
    for (const profileName of builtinNames.filter((profileName) => selections[profileName]?.includes(name))) {
      const lock = JSON.parse(await readFile(join(process.cwd(), "profiles", profileName, "profile.lock.json"), "utf8"));
      assert.deepEqual(lock.skills[`builtin:${name}`], pin);
    }
  }
});

test("optional web profiles add explicit web methodology without services or model bindings", async () => {
  const options = await isolated();
  for (const [name, base] of [["web-performance", "performance"]]) {
    const profile = await resolveTaskProfile(join(process.cwd(), "examples/profiles", name), options);
    const builtin = await resolveTaskProfile(`builtin:${base}`, options);
    assert.deepEqual(
      profile.manifest.hubSkills?.map(({ logical }) => logical),
      [`builtin:${name}`],
    );
    assert.deepEqual(profile.environment, builtin.environment);
    assert.deepEqual(profile.defaults, builtin.defaults);
    assert.deepEqual(profile.outputs, builtin.outputs);
    assert.match(profile.task, /only to web interfaces/);
    assert.match(profile.task, /(methodology|methods), not permissions/);
    const collected = await collectProfile(join(process.cwd(), "examples/profiles", name), name, options);
    const portable = await resolveTaskProfile(collected, options);
    assert.equal(portable.skillPaths.length, 1);
    assert.deepEqual(await snapshotManifest(dirname(portable.skillPaths[0])), await snapshotManifest(dirname(profile.skillPaths[0])));
  }
});

test("deep debugging is a portable bugfix specialization rather than a second built-in task", async () => {
  const options = await isolated();
  assert.ok(!(await listProfiles(options)).some(({ name }) => name === "deep-debug"));
  const source = join(process.cwd(), "examples/profiles/deep-debug");
  const profile = await resolveTaskProfile(source, options);
  const bugfix = await resolveTaskProfile("builtin:bugfix", options);
  assert.deepEqual(profile.outputs, bugfix.outputs);
  assert.deepEqual(profile.environment, bugfix.environment);
  assert.deepEqual(profile.defaults, bugfix.defaults);
  assert.equal(profile.category, "delivery");
  assert.deepEqual(
    profile.manifest.hubSkills?.map(({ logical }) => logical),
    ["builtin:playwright-cli", "builtin:mattpocock-diagnosing-bugs"],
  );
  assert.match(profile.task, /Do not run git bisect/);
  const saved = await collectProfile(source, "my-debug", options);
  const collected = await resolveTaskProfile(saved, options);
  assert.deepEqual(collected.outputs, profile.outputs);
  assert.equal(collected.manifest.hubSkills?.[0].snapshot, profile.manifest.hubSkills?.[0].snapshot);
  assert.equal(await readFile(collected.skillPaths[0], "utf8"), await readFile(profile.skillPaths[0], "utf8"));
});

test("bugfix unifies reported defects and bounded discovery without changing report contracts", async () => {
  const options = await isolated();
  const reported = await resolveTaskProfile("builtin:bugfix", options);
  const discover = await resolveTaskProfile("builtin:bugfix", {
    ...options,
    params: { mode: "discover", scope: "src/state", maxFixes: "2" },
  });
  assert.equal(reported.manifest.parameters.mode, "reported");
  assert.equal(reported.manifest.parameters.maxFixes, "1");
  assert.equal(discover.manifest.parameters.mode, "discover");
  assert.match(discover.task, /src\/state/);
  assert.match(discover.task, /no confirmed findings/);
  assert.deepEqual(discover.environment, reported.environment);
  assert.deepEqual(discover.outputs, reported.outputs);
});

test("combined methods keep only their owning report and adapt upstream interactive side effects", async () => {
  const options = await isolated();
  const architecture = await resolveTaskProfile("builtin:architecture", options);
  assert.match(architecture.task, /Do not open a browser/);
  assert.match(architecture.task, /needs-input/);
  assert.equal(architecture.skillPaths.length, 2);
  const coverage = await resolveTaskProfile("builtin:test-coverage", options);
  assert.match(coverage.task, /test-quality findings/);
  assert.match(coverage.task, /Skip upstream history tracking/);
  assert.deepEqual(coverage.outputs, [{ path: "COVERAGE_REPORT.md", format: "text", required: true }]);
});
