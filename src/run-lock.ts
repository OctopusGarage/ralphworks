import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STALE_MS = 60_000;

export async function withRunLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const lockDir = join(cwd, ".ralph", "run.lock");
  const ownerPath = join(lockDir, "owner");
  await mkdir(join(cwd, ".ralph"), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (!isExists(error)) throw error;
    const age = Date.now() - (await stat(ownerPath).catch(() => stat(lockDir))).mtimeMs;
    if (age <= STALE_MS) throw new Error("workspace is locked by another RalphWorks run");
    const staleOwner = await readFile(ownerPath, "utf8").catch(() => "");
    const pid = Number(staleOwner.split(":", 1)[0]);
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
      throw new Error("workspace is locked by another RalphWorks run");
    }
    if ((await readFile(ownerPath, "utf8").catch(() => "")) !== staleOwner) {
      throw new Error("workspace lock changed while checking its owner");
    }
    await rm(lockDir, { recursive: true });
    try {
      await mkdir(lockDir);
    } catch (retryError) {
      if (isExists(retryError)) throw new Error("workspace is locked by another RalphWorks run");
      throw retryError;
    }
  }
  const owner = `${process.pid}:${randomUUID()}`;
  await writeFile(ownerPath, owner);
  const heartbeat = setInterval(() => {
    void writeFile(ownerPath, owner).catch(() => undefined);
  }, 5_000);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    if ((await readFile(ownerPath, "utf8").catch(() => "")) === owner) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
