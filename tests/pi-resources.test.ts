import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfileResourceLoader } from "../src/pi-resources.ts";
import { normalizeTaskEnvironment } from "../src/task-environment.ts";

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

test("resource inheritance defaults to none and independently supports project and all", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ralph-inheritance-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "global");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
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
  assert.deepEqual(isolated.getSkills().skills, []);
  assert.deepEqual(isolated.getAgentsFiles().agentsFiles, []);
  assert.equal(isolated.getSystemPrompt(), undefined);
  assert.deepEqual(isolated.getExtensions().extensions, []);
  await assert.rejects(readFile(join(root, "global-loaded")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "project-loaded")), { code: "ENOENT" });
  await isolated.release();
  const project = await createProfileResourceLoader({
    cwd,
    piAgentDir: agentDir,
    skillPaths: [],
    environment: normalizeTaskEnvironment({ resourceInheritance: "project" }),
  });
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
  assert.ok(all.getSkills().skills.some((skill) => skill.name === "global"));
  assert.equal(await readFile(join(root, "global-loaded"), "utf8"), "loaded");
  await all.release();
});
