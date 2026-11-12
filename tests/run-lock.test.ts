import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withRunLock } from "../src/run-lock.ts";

test("an old heartbeat cannot reclaim a lock held by a live process", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-live-lock-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lock = join(cwd, ".ralph", "run.lock");
  await mkdir(lock, { recursive: true });
  const owner = join(lock, "owner");
  await writeFile(owner, `${process.pid}:active`);
  const old = new Date(Date.now() - 120_000);
  await utimes(owner, old, old);
  await assert.rejects(
    withRunLock(cwd, async () => "unexpected"),
    /locked by another/,
  );
  assert.equal(await readFile(owner, "utf8"), `${process.pid}:active`);
});

test("a stale lock whose owner is gone can be reclaimed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-dead-lock-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lock = join(cwd, ".ralph", "run.lock");
  await mkdir(lock, { recursive: true });
  const owner = join(lock, "owner");
  await writeFile(owner, "99999999:dead");
  const old = new Date(Date.now() - 120_000);
  await utimes(owner, old, old);
  assert.equal(await withRunLock(cwd, async () => "reclaimed"), "reclaimed");
});

test("cleanup lock acquisition never recreates a missing worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ralphworks-missing-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "removed");
  await assert.rejects(
    withRunLock(cwd, async () => "must not run", { existingOnly: true }),
    /ENOENT/,
  );
  await assert.rejects(stat(cwd), { code: "ENOENT" });
});
