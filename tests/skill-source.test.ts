import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveTask, stageTaskSkills } from "../src/resolved-task.ts";
import { collectProfile, resolveTaskProfile, updateProfileSkills } from "../src/task-profile.ts";

test("GitHub skills pin offline, update explicitly or before runs, and retain collection provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-skills-"));
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    const repo = join(root, "upstream");
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(repo, "skills/review"), { recursive: true });
    await mkdir(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "skills/review/SKILL.md"), "Version one");
    git("add", ".");
    git("commit", "-qm", "one");
    const firstCommit = git("rev-parse", "HEAD");
    const config = join(root, "gitconfig");
    await writeFile(config, `[url "file://${repo}"]\n insteadOf = https://github.com/example/skills\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const source = { source: "https://github.com/example/skills", path: "skills/review", ref: "main", autoUpdate: false };
    await writeFile(join(cwd, "profile.json"), JSON.stringify({ version: 1, name: "review", skills: [source] }));
    const options = { cwd, home };
    const first = await resolveTaskProfile("./profile.json", options);
    assert.match(first.task, /Version one/);
    assert.equal(first.manifest.remoteSkills?.[0].commit, firstCommit);
    await writeFile(join(repo, "skills/review/SKILL.md"), "Version two");
    git("commit", "-qam", "two");
    assert.match((await resolveTaskProfile("./profile.json", { ...options, updateSkills: "auto" })).task, /Version one/);
    const collected = await collectProfile("./profile.json", "saved", options);
    assert.deepEqual(JSON.parse(await readFile(join(collected, "profile.json"), "utf8")).skills, [source]);
    const updates = await updateProfileSkills("./profile.json", options);
    assert.equal(updates[0].previousCommit, firstCommit);
    assert.match((await resolveTaskProfile("./profile.json", options)).task, /Version two/);
    assert.match((await resolveTaskProfile("saved", options)).task, /Version one/);
    await writeFile(join(cwd, "profile.json"), JSON.stringify({ version: 1, name: "review", skills: [{ ...source, autoUpdate: true }] }));
    await writeFile(join(repo, "skills/review/SKILL.md"), "Version three");
    git("commit", "-qam", "three");
    assert.match((await resolveTaskProfile("./profile.json", options)).task, /Version two/);
    assert.match((await resolveTaskProfile("./profile.json", { ...options, updateSkills: "auto" })).task, /Version three/);
    const oldHome = process.env.RALPHWORKS_HOME;
    process.env.RALPHWORKS_HOME = home;
    let staged: Awaited<ReturnType<typeof stageTaskSkills>>;
    try {
      staged = await stageTaskSkills(await resolveTask("Review", { cwd, profile: "./profile.json" }), cwd);
    } finally {
      if (oldHome === undefined) delete process.env.RALPHWORKS_HOME;
      else process.env.RALPHWORKS_HOME = oldHome;
    }
    await rm(repo, { recursive: true });
    assert.match((await resolveTaskProfile("./profile.json", options)).task, /Version two/);
    await assert.rejects(updateProfileSkills("./profile.json", options));
    assert.match((await resolveTaskProfile("./profile.json", options)).task, /Version two/);
    assert.equal(await readFile(staged.skillPaths[0], "utf8"), "Version two");
    await writeFile((await resolveTaskProfile("./profile.json", options)).skillPaths[0], "tampered");
    await assert.rejects(resolveTaskProfile("./profile.json", options), /changed|corrupt/);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub sources reject unsafe URLs and paths before fetching", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-skill-invalid-"));
  try {
    for (const source of [
      "http://github.com/a/b/tree/main/skill",
      "https://evil.com/a/b",
      { source: "https://github.com/a/b", path: "../secret" },
      { source: "https://github.com/a/b", path: "skills\\bad" },
    ]) {
      await writeFile(join(root, "profile.json"), JSON.stringify({ version: 1, name: "bad", skills: [source] }));
      await assert.rejects(resolveTaskProfile("./profile.json", { cwd: root, home: join(root, "home") }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(
  run: (value: {
    root: string;
    repo: string;
    cwd: string;
    home: string;
    git: (...args: string[]) => string;
    source: { source: string; path: string; ref: string };
    profile: (skills: unknown[], extra?: Record<string, unknown>) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ralph-remote-skill-"));
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    const repo = join(root, "upstream");
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(repo, "skills/review"), { recursive: true });
    await mkdir(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(repo, "skills/review/SKILL.md"), "original");
    await writeFile(join(repo, "skills/review/run.sh"), "#!/bin/sh\nexit 0\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    const config = join(root, "gitconfig");
    await writeFile(config, `[url "file://${repo}"]\n insteadOf = https://github.com/example/skills\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const source = { source: "https://github.com/example/skills", path: "skills/review", ref: "main" };
    const profile = (skills: unknown[], extra: Record<string, unknown> = {}) =>
      writeFile(join(cwd, "profile.json"), JSON.stringify({ version: 1, name: "test", skills, ...extra }));
    await run({ root, repo, cwd, home, git, source, profile });
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("failed multi-source refresh preserves every old pin and staged snapshot", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await mkdir(join(repo, "other"));
    await writeFile(join(repo, "other/SKILL.md"), "other original");
    git("add", ".");
    git("commit", "-qm", "other");
    await profile([source, { ...source, path: "other" }]);
    const options = { cwd, home };
    const first = await resolveTaskProfile("./profile.json", options);
    const staged = await stageTaskSkills(
      { job: { task: first.task } as never, profile: first, skillPaths: first.skillPaths, environment: first.environment },
      cwd,
    );
    await writeFile(join(repo, "skills/review/SKILL.md"), "new upstream");
    await rm(join(repo, "other"), { recursive: true });
    git("add", ".");
    git("commit", "-qm", "broken update");
    await assert.rejects(updateProfileSkills("./profile.json", options), /SKILL.md/);
    const after = await resolveTaskProfile("./profile.json", options);
    assert.deepEqual(after.manifest.remoteSkills, first.manifest.remoteSkills);
    assert.equal(await readFile(staged.skillPaths[0], "utf8"), "original");
  });
});

test("inherited duplicate source honors opt-in auto update once and resolves one version", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await writeFile(join(cwd, "parent.json"), JSON.stringify({ version: 1, name: "parent", skills: [source] }));
    await profile([{ ...source, autoUpdate: true }], { extends: ["./parent.json"] });
    const options = { cwd, home };
    const first = await resolveTaskProfile("./profile.json", options);
    await writeFile(join(repo, "skills/review/SKILL.md"), "updated");
    git("commit", "-qam", "updated");
    const updated = await resolveTaskProfile("./profile.json", { ...options, updateSkills: "auto" });
    assert.equal(updated.skillPaths.length, 1);
    assert.match(updated.task, /updated/);
    assert.notEqual(updated.manifest.remoteSkills?.[0].commit, first.manifest.remoteSkills?.[0].commit);
  });
});

test("remote symlinks and literal wildcard paths cannot escape the selected skill", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/passwd", join(repo, "skills/review/link"));
    git("add", ".");
    git("commit", "-qm", "symlink");
    await profile([source]);
    await assert.rejects(resolveTaskProfile("./profile.json", { cwd, home }), /symlink/);
    await profile([{ ...source, path: "skills/*" }]);
    await assert.rejects(resolveTaskProfile("./profile.json", { cwd, home }), /SKILL.md/);
  });
});

test("cache permission edits are rejected and full tree/blob links install", async () => {
  await fixture(async ({ cwd, home, profile }) => {
    await profile(["https://github.com/example/skills/blob/main/skills/review/SKILL.md"]);
    const resolved = await resolveTaskProfile("./profile.json", { cwd, home });
    const { chmod } = await import("node:fs/promises");
    await chmod(resolved.skillPaths[0], 0o755);
    await assert.rejects(resolveTaskProfile("./profile.json", { cwd, home }), /changed|corrupt/);
  });
});

test("repository root skills support root blob URLs and explicit dot paths", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await writeFile(join(repo, "SKILL.md"), "root skill");
    git("add", ".");
    git("commit", "-qm", "root skill");
    for (const entry of ["https://github.com/example/skills/blob/main/SKILL.md", { ...source, path: "." }]) {
      await profile([entry]);
      assert.match((await resolveTaskProfile("./profile.json", { cwd, home })).task, /root skill/);
    }
  });
});

test("Git hook environment cannot redirect skill repository operations and file modes ignore umask", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    const { chmod, stat } = await import("node:fs/promises");
    await chmod(join(repo, "skills/review/run.sh"), 0o755);
    git("add", ".");
    git("commit", "-qm", "executable");
    await profile([source]);
    const previous = process.env.GIT_DIR;
    const mask = process.umask(0o077);
    try {
      process.env.GIT_DIR = join(repo, ".git");
      const resolved = await resolveTaskProfile("./profile.json", { cwd, home });
      assert.equal((await stat(join(resolved.skillPaths[0], "../run.sh"))).mode & 0o777, 0o755);
      await assert.rejects(readFile(join(repo, ".git/FETCH_HEAD")), { code: "ENOENT" });
    } finally {
      process.umask(mask);
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});

test("collecting inherited duplicate declarations retains opt-in updates", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await writeFile(join(cwd, "parent.json"), JSON.stringify({ version: 1, name: "parent", skills: [source] }));
    await profile([{ ...source, autoUpdate: true }], { extends: ["./parent.json"] });
    const options = { cwd, home };
    assert.equal((await resolveTaskProfile("./profile.json", options)).manifest.remoteSkills?.[0].autoUpdate, true);
    const collected = await collectProfile("./profile.json", "inherited", options);
    assert.equal(JSON.parse(await readFile(join(collected, "profile.json"), "utf8")).skills[0].autoUpdate, true);
    await writeFile(join(repo, "skills/review/SKILL.md"), "after collection");
    git("commit", "-qam", "next");
    assert.match((await resolveTaskProfile("inherited", { ...options, updateSkills: "auto" })).task, /after collection/);
  });
});

test("collection retains distinct refs that initially share a cached skill", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    git("tag", "v1");
    await mkdir(join(cwd, "local"));
    await writeFile(join(cwd, "local/SKILL.md"), "local instructions");
    await profile([{ ...source, autoUpdate: true }, "local", { ...source, ref: "v1" }]);
    const options = { cwd, home };
    const first = await resolveTaskProfile("./profile.json", options);
    assert.equal(first.skillPaths.length, 2);
    assert.deepEqual(
      first.manifest.remoteSkills?.map((pin) => pin.ref),
      ["main", "v1"],
    );
    const collected = await collectProfile("./profile.json", "refs", options);
    assert.deepEqual(
      JSON.parse(await readFile(join(collected, "profile.json"), "utf8")).skills.map((skill: { ref: string } | string) =>
        typeof skill === "string" ? "local" : skill.ref,
      ),
      ["main", "local", "v1"],
    );
    await writeFile(join(repo, "skills/review/SKILL.md"), "moving branch");
    git("commit", "-qam", "advance main");
    const updated = await resolveTaskProfile("refs", { ...options, updateSkills: "auto" });
    assert.equal(updated.skillPaths.length, 3);
    assert.match(updated.task, /moving branch/);
    assert.match(updated.task, /original/);
    assert.notEqual(updated.manifest.remoteSkills?.[0].commit, updated.manifest.remoteSkills?.[1].commit);
  });
});

test("remote snapshots preserve root and selected licenses and legacy auto failures retain verified pins", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await writeFile(join(repo, "LICENSE"), "upstream license");
    await writeFile(join(repo, "NOTICE"), "upstream notice");
    await writeFile(join(repo, "skills/review/LICENSE"), "selected license");
    git("add", ".");
    git("commit", "-qm", "licenses");
    await profile([{ ...source, autoUpdate: true }]);
    const original = await resolveTaskProfile("./profile.json", { cwd, home });
    assert.equal(await readFile(join(original.skillPaths[0], "../LICENSE"), "utf8"), "selected license");
    assert.equal(await readFile(join(original.skillPaths[0], "../.upstream/LICENSE"), "utf8"), "upstream license");
    await rm(repo, { recursive: true });
    const fallback = await resolveTaskProfile("./profile.json", { cwd, home, updateSkills: "auto" });
    assert.equal(await readFile(fallback.skillPaths[0], "utf8"), await readFile(original.skillPaths[0], "utf8"));
    assert.equal(fallback.manifest.hubSkills?.[0].scope, "personal");
    assert.equal(fallback.manifest.hubSkills?.[0].status, "fallback");
    assert.equal(fallback.manifest.remoteSkills?.[0].status, "fallback");
  });
});

test("pre-license cache pins migrate to a versioned cache without altering old snapshots", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    const { createHash } = await import("node:crypto");
    const { readdir, lstat, rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    await writeFile(join(repo, "LICENSE"), "root license");
    await writeFile(join(repo, "skills/review/a.md"), "a");
    await writeFile(join(repo, "skills/review/B.md"), "B");
    git("add", ".");
    git("commit", "-qm", "license");
    await profile([source]);
    const original = await resolveTaskProfile("./profile.json", { cwd, home });
    const pin = original.manifest.remoteSkills?.[0];
    assert.ok(pin);
    const directory = dirname(pin.skillPath);
    await rm(join(directory, ".upstream"), { recursive: true });
    const files: [string, string, number][] = [];
    for (const name of await readdir(directory))
      files.push([name, hash(await readFile(join(directory, name))), (await lstat(join(directory, name))).mode & 0o111]);
    files.sort(([a], [b]) => a.localeCompare(b));
    const old = join(home, "cache", "skills", hash(`${source.source}\n${source.path}\n${pin.commit}`));
    if (old !== directory) await rename(directory, old);
    const locks = join(home, "cache", "skill-locks");
    const lockName = (await readdir(locks)).find((name) => name.endsWith(".json"));
    assert.ok(lockName);
    const lockPath = join(locks, lockName);
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.skills[Object.keys(lock.skills)[0]] = { ...pin, skillPath: join(old, "SKILL.md"), sha256: hash(JSON.stringify(files)) };
    await writeFile(lockPath, JSON.stringify(lock));
    assert.match((await resolveTaskProfile("./profile.json", { cwd, home })).task, /original/);
    await updateProfileSkills("./profile.json", { cwd, home });
    const updated = await resolveTaskProfile("./profile.json", { cwd, home });
    assert.equal(await readFile(join(updated.skillPaths[0], "../.upstream/LICENSE"), "utf8"), "root license");
    assert.notEqual(updated.skillPaths[0], join(old, "SKILL.md"));
    await assert.rejects(readFile(join(old, ".upstream/LICENSE")));
  });
});

test("legacy run archival failures retain the previous verified cache pin", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await profile([{ ...source, autoUpdate: true }]);
    const first = await resolveTaskProfile("./profile.json", { cwd, home });
    await writeFile(join(repo, "skills/review/SKILL.md"), "new version");
    git("commit", "-qam", "next");
    await mkdir(join(home, "skills", ".catalog.lock"), { recursive: true });
    const fallback = await resolveTaskProfile("./profile.json", { cwd, home, updateSkills: "auto" });
    assert.equal(await readFile(fallback.skillPaths[0], "utf8"), "original");
    assert.equal(fallback.manifest.remoteSkills?.[0].commit, first.manifest.remoteSkills?.[0].commit);
    assert.equal(fallback.manifest.remoteSkills?.[0].status, "fallback");
  });
});

test("nested GitHub bundle entrypoints retain whole archives through inline caching, collection and automatic refresh", async () => {
  await fixture(async ({ repo, cwd, home, git, source, profile }) => {
    await mkdir(join(repo, "skills/_shared"));
    await mkdir(join(repo, "skills/other"));
    await writeFile(join(repo, "skills/_shared/rules.md"), "shared original");
    await writeFile(join(repo, "skills/other/SKILL.md"), "other skill");
    await writeFile(join(repo, "LICENSE"), "upstream license");
    git("add", ".");
    git("commit", "-qm", "bundle");
    const selected = { ...source, path: "skills", entrypoint: "review/SKILL.md", autoUpdate: true };
    await profile([selected, { ...selected, entrypoint: "other/SKILL.md", autoUpdate: false }]);
    const options = { cwd, home };
    const original = await resolveTaskProfile("./profile.json", options);
    assert.equal(original.skillPaths.length, 2);
    assert.equal(original.manifest.remoteSkills?.[0].sha256, original.manifest.remoteSkills?.[1].sha256);
    assert.notEqual(original.skillPaths[0], original.skillPaths[1]);
    assert.ok(original.skillRoots);
    assert.equal(original.skillRoots[0], original.skillRoots[1]);
    assert.equal(await readFile(join(original.skillRoots[0], ".upstream/LICENSE"), "utf8"), "upstream license");
    const collected = await collectProfile("./profile.json", "nested", options);
    assert.equal(JSON.parse(await readFile(join(collected, "profile.json"), "utf8")).skills[0].entrypoint, selected.entrypoint);
    await writeFile(join(repo, "skills/_shared/rules.md"), "shared refreshed");
    git("commit", "-qam", "refresh shared sibling");
    const refreshed = await resolveTaskProfile("nested", { ...options, updateSkills: "auto" });
    assert.ok(refreshed.skillRoots);
    assert.equal(refreshed.manifest.hubSkills?.[0].entrypoint, selected.entrypoint);
    assert.equal(refreshed.manifest.hubSkills?.[0].source?.kind, "github");
    assert.equal(await readFile(join(refreshed.skillRoots[0], "_shared/rules.md"), "utf8"), "shared refreshed");
    assert.equal(await readFile(join(refreshed.skillRoots[1], "_shared/rules.md"), "utf8"), "shared original");
    const baseline = await resolveTaskProfile("nested", options);
    assert.equal(await readFile(join(baseline.skillRoots?.[0] ?? "", "_shared/rules.md"), "utf8"), "shared original");
    await rm(repo, { recursive: true });
    const fallback = await resolveTaskProfile("nested", { ...options, updateSkills: "auto" });
    assert.ok(fallback.skillRoots);
    assert.equal(fallback.manifest.hubSkills?.[0].entrypoint, selected.entrypoint);
    assert.equal(fallback.manifest.hubSkills?.[0].status, "fallback");
    assert.equal(await readFile(join(fallback.skillRoots[0], "_shared/rules.md"), "utf8"), "shared original");
    await writeFile(join(original.skillRoots[0], "_shared/rules.md"), "corrupted sibling");
    await assert.rejects(resolveTaskProfile("./profile.json", options), /corrupt|changed/);
  });
});
