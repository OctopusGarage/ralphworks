import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import { withRunLock } from "../src/run-lock.ts";

test("an old heartbeat cannot reclaim a lock held by a live process", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-live-lock-"));
  const lock = join(cwd, ".ralph", "run.lock");
  await mkdir(lock, { recursive: true });
  const owner = join(lock, "owner");
  await writeFile(owner, `${process.pid}:active`);
  const old = new Date(Date.now() - 120_000);
  await utimes(owner, old, old);
  await assert.rejects(withRunLock(cwd, async () => "unexpected"), /locked by another/);
  assert.equal(await readFile(owner, "utf8"), `${process.pid}:active`);
});

test("a stale lock whose owner is gone can be reclaimed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-dead-lock-"));
  const lock = join(cwd, ".ralph", "run.lock");
  await mkdir(lock, { recursive: true });
  const owner = join(lock, "owner");
  await writeFile(owner, "99999999:dead");
  const old = new Date(Date.now() - 120_000);
  await utimes(owner, old, old);
  assert.equal(await withRunLock(cwd, async () => "reclaimed"), "reclaimed");
});
