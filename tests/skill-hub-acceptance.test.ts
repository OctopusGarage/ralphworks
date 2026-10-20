import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cliPath = resolve("src/cli.ts");

test("a vendored project retains independent pins and executes offline after relocation and upstream deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-hub-acceptance-"));
  try {
    const upstream = join(root, "upstream");
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(upstream, "skills/review/references"), { recursive: true });
    await mkdir(join(project, ".ralphworks/profiles/review"), { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf8" }).trim();
    git(upstream, "init", "-b", "main");
    git(upstream, "config", "user.name", "Test");
    git(upstream, "config", "user.email", "test@example.com");
    await writeFile(join(upstream, "LICENSE"), "Fixture license\n");
    await writeFile(
      join(upstream, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review fixture changes.\n---\nVersion one\n",
    );
    await writeFile(join(upstream, "skills/review/references/guide.md"), "Review guide\n");
    await writeFile(join(upstream, "skills/review/check.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(upstream, "skills/review/check.sh"), 0o755);
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "first skill");
    const firstCommit = git(upstream, "rev-parse", "HEAD");
    const config = join(root, "gitconfig");
    await writeFile(config, `[url "file://${upstream}"]\n insteadOf = https://github.com/example/hub-skills\n`);
    const cli = (cwd: string, selectedHome: string, args: string[], expected = 0) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, RALPHWORKS_HOME: selectedHome, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stderr || result.stdout);
      return result.stdout;
    };
    await writeFile(
      join(project, ".ralphworks/profiles/review/profile.json"),
      JSON.stringify({ version: 1, name: "review", skills: ["project:review"] }),
    );
    cli(project, home, [
      "skills",
      "add",
      "https://github.com/example/hub-skills",
      "--path",
      "skills/review",
      "--ref",
      "main",
      "--name",
      "review",
      "--scope",
      "project",
    ]);
    cli(project, home, ["profiles", "update", "review"]);
    await mkdir(join(project, ".ralphworks/profiles/other"));
    await writeFile(
      join(project, ".ralphworks/profiles/other/profile.json"),
      JSON.stringify({ version: 1, name: "other", skills: ["project:review"] }),
    );
    cli(project, home, ["profiles", "update", "other"]);
    const originalLock = await readFile(join(project, ".ralphworks/profiles/review/profile.lock.json"), "utf8");
    assert.equal(originalLock.includes(project), false);
    assert.equal(originalLock.includes(home), false);
    const first = JSON.parse(cli(project, home, ["profiles", "show", "review"]));
    assert.match(first.task, /Version one/);
    assert.ok(JSON.stringify(first.manifest).includes(firstCommit));
    await writeFile(
      join(upstream, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review fixture changes.\n---\nVersion two\n",
    );
    git(upstream, "commit", "-qam", "second skill");
    cli(project, home, ["skills", "update", "project:review"]);
    assert.equal(await readFile(join(project, ".ralphworks/profiles/review/profile.lock.json"), "utf8"), originalLock);
    assert.match(JSON.parse(cli(project, home, ["profiles", "show", "other"])).task, /Version one/);
    cli(project, home, ["profiles", "update", "other"]);
    assert.match(JSON.parse(cli(project, home, ["profiles", "show", "other"])).task, /Version two/);
    cli(project, home, ["profiles", "vendor", "review"]);
    const moved = join(root, "relocated");
    const emptyHome = join(root, "empty-home");
    await cp(project, moved, { recursive: true });
    await rm(upstream, { recursive: true });
    await rm(home, { recursive: true, force: true });
    const plan = JSON.parse(cli(moved, emptyHome, ["plan", "Review the changes", "--profile", "review"]));
    assert.match(plan.profile.task, /Version one/);
    assert.equal(await readFile(join(plan.skillPaths[0], "../.upstream/LICENSE"), "utf8"), "Fixture license\n");
    assert.equal(await readFile(join(plan.skillPaths[0], "../references/guide.md"), "utf8"), "Review guide\n");
    const run = cli(
      moved,
      emptyHome,
      ["run", "Review the changes", "--profile", "review", "--runner", "dry-run", "--max-iterations", "1"],
      1,
    );
    assert.match(run, /RalphWorks run max_iterations/);
    const pointer = (await readFile(join(moved, ".ralph/current"), "utf8")).trim();
    const task = JSON.parse(await readFile(join(moved, ".ralph", pointer, "task.json"), "utf8"));
    assert.match(task.skillPaths[0], /\.ralph\/inputs\//);
    assert.match(await readFile(task.skillPaths[0], "utf8"), /Version one/);
    await writeFile(
      join(moved, ".ralphworks/profiles/review/profile.json"),
      JSON.stringify({ version: 1, name: "review", skills: [{ use: "project:review", autoUpdate: true }] }),
    );
    await writeFile(join(moved, ".gitignore"), ".ralph/\n");
    git(moved, "init", "-b", "main");
    git(moved, "config", "user.name", "Test");
    git(moved, "config", "user.email", "test@example.com");
    git(moved, "add", ".");
    git(moved, "commit", "-qm", "portable project");
    const offlineRun = cli(
      moved,
      emptyHome,
      ["run", "Review again", "--profile", "review", "--workspace", "worktree", "--runner", "dry-run", "--max-iterations", "1"],
      1,
    );
    assert.match(offlineRun, /RalphWorks run max_iterations/);
    assert.equal(git(moved, "status", "--porcelain"), "");
    assert.equal(await readFile(join(moved, ".ralphworks/profiles/review/profile.lock.json"), "utf8"), originalLock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI bundles and editable forks retain content and provenance without their original store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-hub-bundle-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    const source = join(root, "source");
    await mkdir(cwd);
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "Original content\n");
    const cli = (args: string[], expected = 0) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, RALPHWORKS_HOME: home },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stderr || result.stdout);
      return result.stdout;
    };
    cli(["skills", "add", source, "--name", "constructor", "--scope", "project"]);
    const original = JSON.parse(cli(["skills", "inspect", "project:constructor"]));
    const bundle = join(root, "bundle");
    const fork = join(root, "fork");
    cli(["skills", "export", "project:constructor", bundle]);
    cli(["skills", "fork", "project:constructor", fork]);
    await writeFile(join(fork, "SKILL.md"), "Customized content\n");
    await rm(source, { recursive: true });
    await rm(join(cwd, ".ralphworks/skills"), { recursive: true });
    const custom = JSON.parse(cli(["skills", "add", fork, "--name", "custom", "--scope", "personal"]));
    assert.equal(custom.derivedFrom.snapshot, original.current);
    assert.notEqual(custom.snapshot, original.current);
    cli(["skills", "import", bundle, "--name", "imported", "--scope", "project"]);
    assert.equal(JSON.parse(cli(["skills", "inspect", "project:imported"])).current, original.current);
    assert.equal(JSON.parse(cli(["skills", "verify", "project:imported"])).verified, true);
    await mkdir(join(cwd, ".ralphworks/profiles/imported"), { recursive: true });
    await writeFile(
      join(cwd, ".ralphworks/profiles/imported/profile.json"),
      JSON.stringify({ version: 1, name: "imported", skills: ["project:imported"] }),
    );
    cli(["profiles", "update", "imported"]);
    const lock = await readFile(join(cwd, ".ralphworks/profiles/imported/profile.lock.json"), "utf8");
    assert.equal(lock.includes(root), false, lock);
    assert.match(JSON.parse(cli(["profiles", "show", "imported"])).task, /Original content/);
    await writeFile(join(bundle, "objects", original.current, "content/SKILL.md"), "Corrupted bundle\n");
    cli(["skills", "import", bundle, "--name", "corrupt", "--scope", "personal"], 1);
    assert.equal(
      JSON.parse(cli(["skills", "list", "--scope", "personal"])).some((entry: { use: string }) => entry.use === "personal:corrupt"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
