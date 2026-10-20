import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillHub } from "../src/skill-hub.ts";

test("hub retains exact snapshots, revisions and executable modes independently of source", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "first");
    await writeFile(join(source, "run.sh"), "echo hi");
    await chmod(join(source, "run.sh"), 0o755);
    const hub = new SkillHub({ cwd: root, home: join(root, "home") });
    const first = await hub.add(source, "example", "project");
    await writeFile(join(source, "SKILL.md"), "second");
    const second = await hub.update("project:example");
    assert.notEqual(first.snapshot, second.snapshot);
    await rm(source, { recursive: true });
    assert.equal(await readFile(await hub.path(first), "utf8"), "first");
    assert.equal((await hub.inspect("project:example")).revisions.length, 2);
    await chmod(join(await hub.path(first), "../run.sh"), 0o644);
    await assert.rejects(hub.path(first), /integrity|corrupt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable export/import and fork isolate editable copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "original");
    const hub = new SkillHub({ cwd: root, home: join(root, "home") });
    const original = await hub.add(source, "one", "project");
    await hub.export("project:one", join(root, "bundle"));
    await hub.import(join(root, "bundle"), "two", "personal");
    assert.equal((await hub.inspect("personal:two")).current, original.snapshot);
    await hub.fork("project:one", join(root, "fork"));
    await writeFile(join(root, "fork", "SKILL.md"), "edited");
    const edited = await hub.add(join(root, "fork"), "edited", "personal");
    assert.equal(edited.derivedFrom?.snapshot, original.snapshot);
    assert.equal(await readFile(await hub.path(original), "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { collectProfile, resolveTaskProfile, updateProfileSkills, vendorProfileSkills } from "../src/task-profile.ts";

test("profiles require explicit hub pins and vendor survives project relocation with empty home", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-profile-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, ".ralphworks", "profiles", "task"), { recursive: true });
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "snapshot one");
    const options = { cwd, home };
    const hub = new SkillHub(options);
    await hub.add(source, "test", "personal");
    const profile = join(cwd, ".ralphworks", "profiles", "task", "profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, name: "task", skills: ["personal:test"] }));
    await assert.rejects(resolveTaskProfile("task", options), /profiles update/);
    await updateProfileSkills("task", options);
    const first = await resolveTaskProfile("task", options);
    await writeFile(join(source, "SKILL.md"), "snapshot two");
    await hub.update("personal:test");
    assert.equal((await resolveTaskProfile("task", options)).task, first.task);
    await vendorProfileSkills("task", options);
    await rm(source, { recursive: true });
    await rm(home, { recursive: true });
    const relocated = join(root, "relocated");
    await (await import("node:fs/promises")).rename(cwd, relocated);
    assert.match((await resolveTaskProfile("task", { cwd: relocated, home })).task, /snapshot one/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vendor pins local paths before checking missing original source, and collections have independent durable snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-local-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(cwd);
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "local content");
    await writeFile(join(cwd, "profile.json"), JSON.stringify({ version: 1, name: "task", skills: ["../source"] }));
    await vendorProfileSkills("./profile.json", { cwd, home });
    const collected = await collectProfile("./profile.json", "saved", { cwd, home });
    await rm(source, { recursive: true });
    await rm(join(cwd, ".ralphworks"), { recursive: true });
    assert.match((await resolveTaskProfile(collected, { cwd, home })).task, /local content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt empty objects and unexpected origin metadata fail verification without repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-corrupt-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "content");
    const hub = new SkillHub({ cwd: root, home: join(root, "home") });
    const pin = await hub.add(source, "one", "project");
    const content = join(await hub.path(pin), "..");
    await writeFile(join(content, ".ralphworks-origin.json"), "{}");
    await assert.rejects(hub.path(pin), /origin|integrity/i);
    await rm(join(content, ".ralphworks-origin.json"));
    await rm(join(content, "..", "manifest.json"));
    await assert.rejects(hub.add(source, "two", "project"));
    await assert.rejects(readFile(join(content, "..", "manifest.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit updates adopt edits to collected local skills without changing existing pins on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-edit-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, "method"), { recursive: true });
    await writeFile(join(cwd, "method", "SKILL.md"), "first");
    await writeFile(join(cwd, "profile.json"), JSON.stringify({ version: 1, name: "local", skills: ["method"] }));
    const collected = await collectProfile("./profile.json", "saved", { cwd, home });
    const declaration = JSON.parse(await readFile(join(collected, "profile.json"), "utf8")).skills[0];
    await writeFile(join(collected, declaration), "edited");
    assert.match((await resolveTaskProfile("saved", { cwd, home })).task, /first/);
    await updateProfileSkills("saved", { cwd, home });
    assert.match((await resolveTaskProfile("saved", { cwd, home })).task, /edited/);
    await rm(join(collected, "skills"), { recursive: true });
    await assert.rejects(updateProfileSkills("saved", { cwd, home }));
    assert.match((await resolveTaskProfile("saved", { cwd, home })).task, /edited/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local provenance locks are relative and custom manifest files keep independent locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-locks-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, "method"), { recursive: true });
    await writeFile(join(cwd, "method", "SKILL.md"), "one");
    const options = { cwd, home };
    const hub = new SkillHub(options);
    await hub.add("method", "constructor", "project");
    for (const name of ["a", "b"])
      await writeFile(join(cwd, name + ".json"), JSON.stringify({ version: 1, name, skills: ["project:constructor"] }));
    await updateProfileSkills("./a.json", options);
    await writeFile(join(cwd, "method", "SKILL.md"), "two");
    await hub.update("project:constructor");
    await updateProfileSkills("./b.json", options);
    assert.match((await resolveTaskProfile("./a.json", options)).task, /one/);
    assert.match((await resolveTaskProfile("./b.json", options)).task, /two/);
    assert.equal((await readFile(join(cwd, "a.lock.json"), "utf8")).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inherited hub auto policy follows current declarations and refreshes once despite historical opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-policy-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, "method"), { recursive: true });
    await writeFile(join(cwd, "method", "SKILL.md"), "before");
    const options = { cwd, home };
    const hub = new SkillHub(options);
    await hub.add("method", "method", "project");
    await writeFile(join(cwd, "parent.json"), JSON.stringify({ version: 1, name: "parent", skills: ["project:method"] }));
    await writeFile(
      join(cwd, "profile.json"),
      JSON.stringify({ version: 1, name: "task", extends: ["./parent.json"], skills: [{ use: "project:method", autoUpdate: true }] }),
    );
    await updateProfileSkills("./profile.json", options);
    const lock = await readFile(join(cwd, "profile.lock.json"), "utf8");
    await writeFile(join(cwd, "method", "SKILL.md"), "after");
    const refreshed = await resolveTaskProfile("./profile.json", { ...options, updateSkills: "auto" });
    assert.match(refreshed.task, /after/);
    assert.equal(refreshed.skillPaths.length, 1);
    assert.equal(refreshed.manifest.hubSkills?.[0].autoUpdate, true);
    assert.equal(await readFile(join(cwd, "profile.lock.json"), "utf8"), lock);
    const aliases = await hub.list("personal");
    assert.equal(aliases.length, 1);
    assert.equal((await hub.inspect(aliases[0].use)).revisions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run refresh archival failure falls back to the verified project pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-archive-fail-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, "method"), { recursive: true });
    await writeFile(join(cwd, "method", "SKILL.md"), "before");
    const options = { cwd, home };
    const hub = new SkillHub(options);
    await hub.add("method", "method", "project");
    await writeFile(
      join(cwd, "profile.json"),
      JSON.stringify({ version: 1, name: "task", skills: [{ use: "project:method", autoUpdate: true }] }),
    );
    await updateProfileSkills("./profile.json", options);
    await writeFile(join(cwd, "method", "SKILL.md"), "after");
    await mkdir(join(home, "skills", ".catalog.lock"), { recursive: true });
    const fallback = await resolveTaskProfile("./profile.json", { ...options, updateSkills: "auto" });
    assert.match(fallback.task, /before/);
    assert.equal(fallback.manifest.hubSkills?.[0].status, "fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal automatic local revisions retain their originating project and fresh successful metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-origin-"));
  try {
    const cwd = join(root, "A");
    const other = join(root, "B");
    const home = join(root, "home");
    for (const project of [cwd, other]) await mkdir(join(project, "method"), { recursive: true });
    await writeFile(join(cwd, "method", "SKILL.md"), "A");
    await writeFile(join(other, "method", "SKILL.md"), "B");
    const hub = new SkillHub({ cwd, home });
    const pin = await hub.add("method", "method", "project");
    await writeFile(
      join(cwd, "profile.json"),
      JSON.stringify({ version: 1, name: "task", skills: [{ use: "project:method", autoUpdate: true }] }),
    );
    await updateProfileSkills("./profile.json", { cwd, home });
    await resolveTaskProfile("./profile.json", { cwd, home, updateSkills: "auto" });
    const alias = (await hub.list("personal"))[0].use;
    const hubB = new SkillHub({ cwd: other, home });
    await writeFile(join(cwd, "method", "SKILL.md"), "A updated");
    await hubB.update(alias);
    assert.equal(await readFile(await hubB.path(await hubB.current(alias)), "utf8"), "A updated");
    const refreshed = await hub.refresh(
      {
        ...pin,
        importedAt: "2000-01-01T00:00:00.000Z",
        status: "fallback",
        warning: { code: "SKILL_REFRESH_FAILED", message: "previous failure" },
      },
      "personal",
    );
    assert.notEqual(refreshed.importedAt, "2000-01-01T00:00:00.000Z");
    assert.equal(refreshed.warning, undefined);
    assert.equal(refreshed.status, "updated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
