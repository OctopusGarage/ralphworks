import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { skillKey } from "../src/profile-skills.ts";
import { remapTaskPaths, stageTaskSkills } from "../src/resolved-task.ts";
import { SkillHub } from "../src/skill-hub.ts";
import { remoteSkill } from "../src/skill-source.ts";
import { collectProfile, resolveTaskProfile, vendorProfileSkills } from "../src/task-profile.ts";

test("nested entrypoints share an immutable bundle and survive fork, transfer, collection and staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-bundle-"));
  try {
    const bundle = join(root, "upstream");
    for (const name of ["one", "two", "_shared"]) await mkdir(join(bundle, name), { recursive: true });
    for (const name of ["one", "two"]) await writeFile(join(bundle, name, "SKILL.md"), `Read ../_shared/rules.md for ${name}`);
    await writeFile(join(bundle, "_shared/rules.md"), "shared rules");
    await writeFile(join(bundle, "LICENSE"), "license");
    const home = join(root, "home");
    const hub = new SkillHub({ cwd: root, home });
    const one = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("src/cli.ts"), "skills", "add", bundle, "--name", "one", "--scope", "project", "--entrypoint", "one/SKILL.md"],
        { cwd: root, encoding: "utf8", env: { ...process.env, RALPHWORKS_HOME: home } },
      ),
    );
    const two = await hub.add(bundle, "two", "project", "two/SKILL.md");
    assert.equal(one.snapshot, two.snapshot);
    assert.notEqual(await hub.path(one), await hub.path(two));
    await hub.fork("project:one", join(root, "fork"));
    const fork = await hub.add(join(root, "fork"), "fork", "project");
    assert.equal(fork.entrypoint, "one/SKILL.md");
    assert.equal(fork.snapshot, one.snapshot);
    await hub.export("project:one", join(root, "export"));
    const imported = await hub.import(join(root, "export"), "imported", "personal");
    assert.equal(imported.entrypoint, "one/SKILL.md");
    await writeFile(join(root, "profile.json"), JSON.stringify({ version: 1, name: "bundle", skills: ["project:one", "project:two"] }));
    const { updateProfileSkills } = await import("../src/task-profile.ts");
    await updateProfileSkills(join(root, "profile.json"), { cwd: root, home });
    await collectProfile(join(root, "profile.json"), "collected", { cwd: root, home });
    const collected = join(home, "profiles/collected/profile.json");
    await vendorProfileSkills(collected, { cwd: root, home });
    const relocated = join(root, "relocated");
    const { cp } = await import("node:fs/promises");
    await mkdir(relocated);
    await cp(join(root, ".ralphworks"), join(relocated, ".ralphworks"), { recursive: true });
    await cp(dirname(collected), join(relocated, "profile"), { recursive: true });
    await rm(bundle, { recursive: true });
    await rm(home, { recursive: true });
    const profile = await resolveTaskProfile(join(relocated, "profile/profile.json"), { cwd: relocated, home: join(root, "empty") });
    assert.equal(profile.skillPaths.length, 2);
    const task = await stageTaskSkills(
      { job: { task: profile.task } as never, profile, skillPaths: profile.skillPaths, skillRoots: profile.skillRoots },
      relocated,
    );
    assert.notEqual(task.skillPaths[0], task.skillPaths[1]);
    for (const [index, path] of task.skillPaths.entries()) {
      assert.match(path, new RegExp(`skills/${index}/${index === 0 ? "one" : "two"}/SKILL.md$`));
      assert.equal(await readFile(join(dirname(path), "../_shared/rules.md"), "utf8"), "shared rules");
      assert.equal(await readFile(join(dirname(path), "../LICENSE"), "utf8"), "license");
    }
    const remapped = remapTaskPaths(task, [[relocated, "/workspace"]]);
    assert.ok(remapped.skillPaths.every((path) => path.startsWith("/workspace/")));
    assert.ok(remapped.skillRoots?.every((path) => path.startsWith("/workspace/")));
    await writeFile(join(root, ".ralphworks/skills/objects", one.snapshot, "content/_shared/rules.md"), "corrupt");
    await assert.rejects(hub.path(one), /integrity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entrypoints reject unsafe paths, absent files and symlink bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-bundle-invalid-"));
  try {
    const hub = new SkillHub({ cwd: root, home: join(root, "home") });
    await mkdir(join(root, "bundle/nested"), { recursive: true });
    await writeFile(join(root, "bundle/nested/SKILL.md"), "skill");
    for (const entrypoint of [
      "../SKILL.md",
      "/SKILL.md",
      "nested\\SKILL.md",
      "nested/README.md",
      "a\u007f/SKILL.md",
      "nested/../nested/SKILL.md",
      "missing/SKILL.md",
    ])
      await assert.rejects(hub.add(join(root, "bundle"), "invalid", "project", entrypoint));
    await symlink(join(root, "bundle/nested/SKILL.md"), join(root, "bundle/nested/link"));
    await assert.rejects(hub.add(join(root, "bundle"), "invalid", "project", "nested/SKILL.md"), /symlink/);
    await rm(join(root, "bundle/nested/link"));
    await writeFile(
      join(root, "origin.json"),
      JSON.stringify({ scope: "project", snapshot: "a".repeat(64), entrypoint: "nested/SKILL.md" }),
    );
    await symlink(join(root, "origin.json"), join(root, "bundle/.ralphworks-origin.json"));
    await assert.rejects(hub.add(join(root, "bundle"), "origin", "project"), /symlink/);
    const base = { source: "https://github.com/example/skills", path: "skills", ref: "main" };
    const one = remoteSkill({ ...base, entrypoint: "one/SKILL.md" });
    const two = remoteSkill({ ...base, entrypoint: "two/SKILL.md" });
    assert.ok(one);
    assert.ok(two);
    const defaultEntry = remoteSkill({ ...base, entrypoint: "SKILL.md" });
    assert.ok(defaultEntry);
    assert.notEqual(skillKey(one, "profile.json", "profile.json"), skillKey(two, "profile.json", "profile.json"));
    assert.equal(skillKey(defaultEntry, "profile.json", "profile.json"), skillKey(base, "profile.json", "profile.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping bundle and nested local selections count each resource once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-bundle-overlap-"));
  try {
    const bundle = join(root, "bundle");
    await mkdir(join(bundle, "one"), { recursive: true });
    await mkdir(join(bundle, "two"));
    await writeFile(join(bundle, "one/SKILL.md"), "first entrypoint");
    await writeFile(join(bundle, "two/SKILL.md"), "second entrypoint");
    for (let index = 0; index < 55; index++) await writeFile(join(bundle, "two", `${index}.md`), `support ${index}`);
    const home = join(root, "home");
    const hub = new SkillHub({ cwd: root, home });
    const pin = await hub.add(bundle, "overlap", "project", "one/SKILL.md");
    const profilePath = join(root, "profile.json");
    await writeFile(profilePath, JSON.stringify({ version: 1, name: "overlap", skills: ["project:overlap"] }));
    const { updateProfileSkills } = await import("../src/task-profile.ts");
    await updateProfileSkills(profilePath, { cwd: root, home });
    const nested = join(".ralphworks/skills/objects", pin.snapshot, "content/two/SKILL.md");
    await writeFile(profilePath, JSON.stringify({ version: 1, name: "overlap", skills: ["project:overlap", nested] }));
    const profile = await resolveTaskProfile(profilePath, { cwd: root, home });
    assert.equal(profile.manifest.resources.length, 58);
    assert.equal(profile.skillPaths.length, 2);
    assert.match(profile.task, /first entrypoint/);
    assert.match(profile.task, /second entrypoint/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
