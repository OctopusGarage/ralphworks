import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfileResourceLoader } from "../src/pi-resources.ts";
import { normalizeTaskEnvironment } from "../src/task-environment.ts";

test("project packages preserve glob inclusion and exclusion of skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ralph-package-globs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const bundle = join(cwd, "bundle");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  for (const name of ["keep", "skip"]) {
    await mkdir(join(bundle, "skills", name), { recursive: true });
    await writeFile(join(bundle, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Test package skill\n---\n${name}`);
  }
  await writeFile(join(bundle, "package.json"), JSON.stringify({ name: "fixture-methods", version: "1.0.0", pi: { skills: ["skills"] } }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: bundle, skills: ["**", "!skills/skip/**"] }] }));
  const loader = await createProfileResourceLoader({
    cwd,
    piAgentDir: agentDir,
    skillPaths: [],
    environment: normalizeTaskEnvironment({ resourceInheritance: "project" }),
  });
  try {
    assert.deepEqual(
      loader.getSkills().skills.map((skill) => skill.name),
      ["keep"],
    );
  } finally {
    await loader.release();
  }
});

test("selected skill snapshots override installed skills while unrelated skills remain discoverable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-pi-resources-"));
  const agentDir = join(cwd, "agent");
  const selected = join(cwd, "selected", "review", "SKILL.md");
  for (const [path, name] of [
    [join(agentDir, "skills", "review", "SKILL.md"), "review"],
    [join(agentDir, "skills", "other", "SKILL.md"), "other"],
    [selected, "review"],
  ]) {
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nname: ${name}\ndescription: Test skill\n---\nInstructions.`);
  }
  const loader = await createProfileResourceLoader({
    cwd,
    piAgentDir: agentDir,
    skillPaths: [selected],
    environment: normalizeTaskEnvironment({ resourceInheritance: "all" }),
  });
  const skills = loader.getSkills().skills;
  assert.equal(skills.find((skill) => skill.name === "review")?.filePath, selected);
  assert.ok(skills.find((skill) => skill.name === "other"));
  await loader.release();
});

test("explicit runtime retry settings preserve resource isolation and project precedence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ralph-inheritance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "global");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const retry = { enabled: true, maxRetries: 2, baseDelayMs: 60000 };
  const globalSettings = `${JSON.stringify({ defaultModel: "runtime-model", retry }, null, 2)}\n`;
  const projectSettings = `${JSON.stringify({ retry: { maxRetries: 1 } }, null, 2)}\n`;
  await writeFile(join(agentDir, "settings.json"), globalSettings);
  await writeFile(join(cwd, ".pi", "settings.json"), projectSettings);
  for (const [base, name] of [
    [join(cwd, ".pi"), "project"],
    [agentDir, "global"],
  ]) {
    await mkdir(join(base, "skills", name), { recursive: true });
    await writeFile(join(base, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: A test skill\n---\n${name}`);
    await writeFile(join(base, "SYSTEM.md"), `${name}-system`);
    await writeFile(
      join(base, "extensions", `${name}.js`),
      `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(join(root, `${name}-loaded`))},'loaded');}`,
    );
  }
  await writeFile(join(cwd, "AGENTS.md"), "project-context");
  await writeFile(join(agentDir, "AGENTS.md"), "global-context");
  const isolated = await createProfileResourceLoader({ cwd, piAgentDir: agentDir, skillPaths: [] });
  assert.deepEqual(isolated.taskSettings.getRetrySettings(), retry);
  assert.equal(isolated.taskSettings.getDefaultModel(), "runtime-model");
  assert.deepEqual(isolated.getSkills().skills, []);
  assert.deepEqual(isolated.getAgentsFiles().agentsFiles, []);
  assert.equal(isolated.getSystemPrompt(), undefined);
  assert.deepEqual(isolated.getExtensions().extensions, []);
  await assert.rejects(readFile(join(root, "global-loaded")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "project-loaded")), { code: "ENOENT" });
  isolated.taskSettings.setRetryEnabled(false);
  await isolated.release();
  const project = await createProfileResourceLoader({
    cwd,
    piAgentDir: agentDir,
    skillPaths: [],
    environment: normalizeTaskEnvironment({ resourceInheritance: "project" }),
  });
  assert.deepEqual(project.taskSettings.getRetrySettings(), { ...retry, maxRetries: 1 });
  assert.ok(project.getSkills().skills.some((skill) => skill.name === "project"));
  assert.ok(!project.getSkills().skills.some((skill) => skill.name === "global"));
  assert.match(project.getSystemPrompt() ?? "", /project-system/);
  assert.deepEqual(
    project.getAgentsFiles().agentsFiles.map((file) => file.content),
    ["project-context"],
  );
  assert.equal(await readFile(join(root, "project-loaded"), "utf8"), "loaded");
  await assert.rejects(readFile(join(root, "global-loaded")), { code: "ENOENT" });
  await project.release();
  const all = await createProfileResourceLoader({
    cwd,
    piAgentDir: agentDir,
    skillPaths: [],
    environment: normalizeTaskEnvironment({ resourceInheritance: "all" }),
  });
  assert.deepEqual(all.taskSettings.getRetrySettings(), { ...retry, maxRetries: 1 });
  assert.ok(all.getSkills().skills.some((skill) => skill.name === "global"));
  assert.equal(await readFile(join(root, "global-loaded"), "utf8"), "loaded");
  await all.release();
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), globalSettings);
  assert.equal(await readFile(join(cwd, ".pi", "settings.json"), "utf8"), projectSettings);
});

for (const resourceInheritance of ["none", "project"] as const) {
  test(`explicit runtime retry preserves false and zero in ${resourceInheritance} mode`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ralph-disabled-retry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const retry = { enabled: false, maxRetries: 0, baseDelayMs: 0 };
    const settings = `${JSON.stringify({ retry })}\n`;
    await writeFile(join(agentDir, "settings.json"), settings);
    const loader = await createProfileResourceLoader({
      cwd: root,
      piAgentDir: agentDir,
      skillPaths: [],
      environment: normalizeTaskEnvironment({ resourceInheritance }),
    });
    try {
      assert.deepEqual(loader.taskSettings.getRetrySettings(), retry);
    } finally {
      await loader.release();
    }
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), settings);
  });
}

test("without an explicit runtime directory ambient retry stays excluded from none and project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ralph-ambient-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "ambient");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  const retry = { enabled: false, maxRetries: 9, baseDelayMs: 40000 };
  const globalSettings = `${JSON.stringify({ defaultModel: "ambient-model", retry })}\n`;
  const projectSettings = `${JSON.stringify({ retry: { maxRetries: 1 } })}\n`;
  await writeFile(join(agentDir, "settings.json"), globalSettings);
  await writeFile(join(cwd, ".pi", "settings.json"), projectSettings);
  const script = `
    import { createProfileResourceLoader } from ${JSON.stringify(new URL("../src/pi-resources.ts", import.meta.url).href)};
    import { normalizeTaskEnvironment } from ${JSON.stringify(new URL("../src/task-environment.ts", import.meta.url).href)};
    import { getAgentDir } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
    const settings = {};
    for (const resourceInheritance of ["none", "project", "all"]) {
      const loader = await createProfileResourceLoader({ cwd: process.cwd(), skillPaths: [], environment: normalizeTaskEnvironment({ resourceInheritance }) });
      try { settings[resourceInheritance] = { retry: loader.taskSettings.getRetrySettings(), model: loader.taskSettings.getDefaultModel() }; }
      finally { await loader.release(); }
    }
    process.stdout.write(JSON.stringify({ agentDir: getAgentDir(), settings }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
    }),
  );
  assert.equal(result.agentDir, agentDir);
  assert.deepEqual(result.settings, {
    none: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 }, model: "ambient-model" },
    project: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 2000 }, model: "ambient-model" },
    all: { retry: { ...retry, maxRetries: 1 }, model: "ambient-model" },
  });
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), globalSettings);
  assert.equal(await readFile(join(cwd, ".pi", "settings.json"), "utf8"), projectSettings);
});
