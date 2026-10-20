import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("CLI keeps plan pins, updates explicitly, and refreshes opted-in skills before staging a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-profile-command-"));
  try {
    const repo = join(root, "upstream");
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(repo, "review"), { recursive: true });
    await mkdir(join(cwd, ".ralphworks/profiles/review"), { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    const advance = async (text: string) => {
      await writeFile(join(repo, "review/SKILL.md"), text);
      git("add", ".");
      git("commit", "-qm", text);
      return git("rev-parse", "HEAD");
    };
    const first = await advance("First version");
    const config = join(root, "gitconfig");
    await writeFile(config, `[url "file://${repo}"]\n insteadOf = https://github.com/example/command-skills\n`);
    await writeFile(
      join(cwd, ".ralphworks/profiles/review/profile.json"),
      JSON.stringify({
        version: 1,
        name: "review",
        skills: [{ source: "https://github.com/example/command-skills", path: "review", ref: "main", autoUpdate: true }],
      }),
    );
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, RALPHWORKS_HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, args[0] === "run" ? 1 : 0, result.stderr || result.stdout);
      return result.stdout;
    };
    const planCommit = () => JSON.parse(cli("plan", "Review", "--profile", "review")).profile.manifest.remoteSkills[0].commit;
    assert.equal(planCommit(), first);
    const second = await advance("Second version");
    assert.equal(JSON.parse(cli("profiles", "show", "review")).manifest.remoteSkills[0].commit, first);
    assert.equal(planCommit(), first);
    const updated = JSON.parse(cli("profiles", "update", "review"));
    assert.equal(updated[0].previousCommit, first);
    assert.equal(updated[0].commit, second);
    const third = await advance("Third version");
    const output = cli("run", "Review", "--profile", "review", "--runner", "dry-run", "--max-iterations", "1");
    assert.match(output, /RalphWorks run max_iterations/);
    const pointer = (await readFile(join(cwd, ".ralph/current"), "utf8")).trim();
    const task = JSON.parse(await readFile(join(cwd, ".ralph", pointer, "task.json"), "utf8"));
    assert.equal(task.profile.manifest.remoteSkills[0].commit, third);
    assert.match(task.skillPaths[0], /\.ralph\/inputs\//);
    assert.equal(await readFile(task.skillPaths[0], "utf8"), "Third version");
    await advance("Fourth version");
    cli("profiles", "update", "review");
    assert.equal(await readFile(task.skillPaths[0], "utf8"), "Third version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
