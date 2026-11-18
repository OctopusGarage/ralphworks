import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { RalphRunResult } from "./orchestrator.ts";
import type { ResolvedTask } from "./resolved-task.ts";

type RunReceipt = {
  schemaVersion: 1;
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  workspace: { path: string; baseHead: string | null; head: string | null };
  taskInputSha256: string;
  profile: { name: string; fingerprint: string } | null;
  result: RalphRunResult;
  outputs: { path: string; required: boolean; format: "text" | "json"; sha256: string | null }[];
};

/** Reserve one caller-owned destination; publish only a complete terminal receipt. */
export async function reserveRunReceipt(path: string, invocationId: string, target: string, cwd: string) {
  const destination = resolve(cwd, path);
  const lock = `${destination}.lock`;
  await mkdir(dirname(destination), { recursive: true });
  await assertAbsent(destination);
  const reservation = await open(lock, "wx", 0o600);
  const startedAt = new Date().toISOString();
  try {
    // Recheck after reservation so a competing receipt never starts another agent.
    await assertAbsent(destination);
    const inputPath = resolve(cwd, target);
    const input = await lstat(inputPath).then(
      () => readFile(inputPath),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return Buffer.from(target);
        throw error;
      },
    );
    const taskInputSha256 = digest(input);
    return {
      async publish(input: { cwd: string; baseHead?: string; head?: string; task: ResolvedTask; result: RalphRunResult }): Promise<void> {
        const outputs: RunReceipt["outputs"] = [];
        for (const output of input.task.outputs ?? []) {
          outputs.push({
            path: output.path,
            required: output.required !== false,
            format: output.format ?? "text",
            sha256: await outputDigest(input.cwd, output.path),
          });
        }
        const profile = input.task.profile;
        const receipt: RunReceipt = {
          schemaVersion: 1,
          invocationId,
          startedAt,
          finishedAt: new Date().toISOString(),
          workspace: { path: await realpath(input.cwd), baseHead: input.baseHead ?? null, head: input.head ?? null },
          taskInputSha256,
          profile: profile
            ? {
                name: profile.name,
                fingerprint: digest(
                  JSON.stringify({
                    manifest: profile.manifest,
                    task: profile.task,
                    environment: profile.environment,
                    outputs: profile.outputs,
                  }),
                ),
              }
            : null,
          result: input.result,
          outputs,
        };
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          // A hard link publishes complete bytes atomically and refuses replacement.
          await link(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      async close(): Promise<void> {
        await reservation.close();
        await rm(lock, { force: true });
      },
    };
  } catch (error) {
    await reservation.close();
    await rm(lock, { force: true });
    throw error;
  }
}

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertAbsent(path: string): Promise<void> {
  const exists = await lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) throw new Error(`Receipt destination already exists: ${path}`);
}

// Invalid outputs must not prevent recording an unsuccessful terminal run.
async function outputDigest(cwd: string, path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const candidate = resolve(cwd, path);
    if (!(await lstat(candidate)).isFile()) return null;
    const canonical = await realpath(candidate);
    const suffix = relative(await realpath(cwd), canonical);
    if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) return null;
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    const limit = 1024 * 1024;
    if (!info.isFile() || info.size === 0 || info.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size > 0 && size <= limit ? digest(buffer.subarray(0, size)) : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
