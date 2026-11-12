import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyCleanGitWorkspace } from "./git-transaction.ts";
import { canonicalPath, resolveStateDirectory } from "./run-state.ts";
import { type OwnedWorkspace, saveWorkspace, withinWorkspace } from "./workspace-lifecycle.ts";

const exec = promisify(execFile);
export type Workspace = { cwd: string; branch?: string; baseHead?: string; recordPath?: string; owned?: OwnedWorkspace; stateDir?: string };

export async function prepareWorkspace(
  cwd: string,
  options: {
    kind: "current" | "worktree";
    path?: string;
    stateDir?: string;
    keep?: boolean;
    executor?: "host" | "docker";
    preservePaths?: string[];
  },
): Promise<Workspace> {
  cwd = resolve(cwd);
  const stateRoot = await resolveStateDirectory(cwd, options.stateDir);
  if (options.kind === "current") return { cwd };
  const reason = await verifyCleanGitWorkspace(cwd);
  if (reason) throw new Error(`Cannot create task worktree: ${reason}`);
  const id = randomUUID();
  cwd = await realpath(cwd);
  const path = await canonicalPath(resolve(options.path ?? join(dirname(cwd), ".ralphworks-worktrees", basename(cwd), id)));
  const stateDir = options.stateDir === undefined ? join(stateRoot, "workspace-runs", id) : stateRoot;
  await resolveStateDirectory(path, stateDir);
  if (
    withinWorkspace(path, await canonicalPath(stateRoot)) ||
    withinWorkspace(path, await canonicalPath(stateDir)) ||
    withinWorkspace(path, cwd)
  )
    throw new Error("Owned workspace must not contain its source or recovery state");
  if (
    await lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error(`Worktree path already exists: ${path}`);
  const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const branch = `ralphworks/${id}`;
  const recordPath = join(stateRoot, "workspaces", `${id}.json`);
  const record: OwnedWorkspace = {
    version: 1,
    id,
    cwd: path,
    sourceCwd: cwd,
    commonDir: (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })).stdout.trim(),
    branch,
    baseHead,
    recordPath,
    stateDir,
    archivePath: join(stateRoot, "workspace-recovery", id),
    executor: options.executor ?? "host",
    keep: options.keep ?? false,
    preservePaths: options.preservePaths ?? [],
    owner: { pid: process.pid, nonce: randomUUID() },
    phase: "preparing",
  };
  await saveWorkspace(record);
  try {
    await mkdir(dirname(path), { recursive: true });
    await exec("git", ["worktree", "add", "-b", branch, path, baseHead], { cwd });
    const info = await lstat(path);
    record.gitDir = (await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: path })).stdout.trim();
    record.device = info.dev;
    record.inode = info.ino;
    record.phase = "running";
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(record.archivePath), { recursive: true, mode: 0o700 });
    await saveWorkspace(record);
  } catch (error) {
    throw new Error(`Worktree retained at ${path} on ${branch}, but recording its location failed: ${String(error)}`);
  }
  return { cwd: path, branch, baseHead, recordPath, owned: record, ...(record.executor === "host" ? { stateDir } : {}) };
}
