import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyCleanGitWorkspace } from "./git-transaction.ts";

const exec = promisify(execFile);
export type Workspace = { cwd: string; branch?: string; baseHead?: string; recordPath?: string };

export async function prepareWorkspace(cwd: string, options: { kind: "current" | "worktree"; path?: string }): Promise<Workspace> {
  cwd = resolve(cwd);
  if (options.kind === "current") return { cwd };
  const reason = await verifyCleanGitWorkspace(cwd);
  if (reason) throw new Error(`Cannot create task worktree: ${reason}`);
  const id = randomUUID();
  const path = resolve(options.path ?? join(dirname(cwd), ".ralphworks-worktrees", basename(cwd), id));
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
  await mkdir(dirname(path), { recursive: true });
  await exec("git", ["worktree", "add", "-b", branch, path, baseHead], { cwd });
  const recordPath = join(cwd, ".ralph", "workspaces", `${id}.json`);
  const workspace = { cwd: path, branch, baseHead, recordPath };
  try {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify(workspace, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    throw new Error(`Worktree retained at ${path} on ${branch}, but recording its location failed: ${String(error)}`);
  }
  return workspace;
}
