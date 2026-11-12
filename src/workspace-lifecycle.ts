import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withRunLock } from "./run-lock.ts";
import { resolveStateDirectory } from "./run-state.ts";
import { archiveWorkspace, durableFile, syncDirectory, verifyWorkspaceArchive, workspaceGit } from "./workspace-recovery.ts";
import { workspaceIsUnused } from "./workspace-use.ts";

export type OwnedWorkspace = {
  version: 1;
  id: string;
  cwd: string;
  sourceCwd: string;
  commonDir: string;
  branch: string;
  baseHead: string;
  recordPath: string;
  stateDir: string;
  archivePath: string;
  executor: "host" | "docker";
  keep: boolean;
  preservePaths: string[];
  owner: { pid: number; nonce: string };
  phase: "preparing" | "running" | "terminal" | "quiescent" | "archived" | "removed";
  managedGroups?: number[];
  gitDir?: string;
  device?: number;
  inode?: number;
  head?: string;
  resultPath?: string;
  status?: string;
  archiveSha256?: string;
  reason?: string;
};
export type CleanupResult = { id: string; cwd: string; cleanup: "removed" | "retained" | "eligible"; recovery?: string; reason?: string };

export async function saveWorkspace(record: OwnedWorkspace): Promise<void> {
  await mkdir(dirname(record.recordPath), { recursive: true, mode: 0o700 });
  const temporary = `${record.recordPath}.${randomUUID()}.tmp`;
  try {
    await durableFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, record.recordPath);
    await syncDirectory(dirname(record.recordPath));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function withinWorkspace(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

async function assertWorkspaceIdentity(record: OwnedWorkspace): Promise<void> {
  const info = await lstat(record.cwd);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== record.device ||
    info.ino !== record.inode ||
    (await realpath(record.cwd)) !== record.cwd ||
    record.cwd === (await realpath(record.sourceCwd))
  )
    throw new Error("Owned workspace filesystem identity changed");
  if (
    (await workspaceGit(record.cwd, ["rev-parse", "--show-toplevel"])).trim() !== record.cwd ||
    (await workspaceGit(record.cwd, ["rev-parse", "--absolute-git-dir"])).trim() !== record.gitDir ||
    (await workspaceGit(record.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim() !== record.commonDir ||
    (await workspaceGit(record.sourceCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim() !== record.commonDir ||
    (await workspaceGit(record.cwd, ["symbolic-ref", "--short", "HEAD"])).trim() !== record.branch
  )
    throw new Error("Owned workspace Git identity changed");
  // State/archives must survive removal, including paths reached through ancestor aliases.
  for (const path of [record.stateDir, dirname(record.recordPath), dirname(record.archivePath)]) {
    await resolveStateDirectory(record.cwd, path);
    if (withinWorkspace(record.cwd, await realpath(path))) throw new Error("Recovery state is inside the owned workspace");
  }
}

function heldByLiveOwner(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Only direct managed group absence is used. Unknown or unsupported proof retains the worktree. */
function managedProcessesStopped(pids: Set<number>): boolean {
  if (pids.size && process.platform === "win32") return false;
  return [...pids].every((pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(-pid, 0);
      return false;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  });
}

function retention(record: OwnedWorkspace): string | undefined {
  if (record.keep) return "explicit --keep-worktree";
  if (record.executor !== "host") return "Docker workspace retained: container absence and external state are not proven";
  if (!["terminal", "quiescent", "archived", "removed"].includes(record.phase)) return "in-flight ownership is not proven quiescent";
  return undefined;
}

/** Caller holds the worktree run lock, or has proved an archived worktree is already absent. */
export async function cleanupWorkspace(record: OwnedWorkspace): Promise<CleanupResult> {
  const result: CleanupResult = { id: record.id, cwd: record.cwd, cleanup: "retained" };
  const reason = retention(record);
  if (reason) return { ...result, reason };
  try {
    if (record.phase === "terminal") {
      if (
        !Array.isArray(record.managedGroups) ||
        !managedProcessesStopped(new Set(record.managedGroups)) ||
        !(await workspaceIsUnused(record.cwd))
      )
        throw new Error("Terminal workspace remains in use or process reference proof is unavailable; cleanup can retry");
      record.phase = "quiescent";
      await saveWorkspace(record);
    }
    const present = await lstat(record.cwd).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    if (!present) {
      if (record.phase !== "archived" && record.phase !== "removed") throw new Error("Workspace disappeared before verified recovery");
      const actual = await verifyWorkspaceArchive(record, false);
      if (actual !== record.archiveSha256) throw new Error("Recovery manifest changed");
      const registered = (await workspaceGit(record.sourceCwd, ["worktree", "list", "--porcelain", "-z"])).split("\0");
      if (registered.includes(`worktree ${record.cwd}`))
        throw new Error("Missing workspace still has a Git registration; retained for inspection");
    } else {
      await assertWorkspaceIdentity(record);
      if (record.head !== (await workspaceGit(record.cwd, ["rev-parse", "HEAD"])).trim()) throw new Error("Terminal HEAD changed");
      const actual = await archiveWorkspace(record);
      if (record.archiveSha256 && record.archiveSha256 !== actual) throw new Error("Recovery manifest changed");
      record.archiveSha256 = actual;
      record.phase = "archived";
      record.reason = undefined;
      await saveWorkspace(record);
      await assertWorkspaceIdentity(record);
      await verifyWorkspaceArchive(record);
      if (!(await workspaceIsUnused(record.cwd))) throw new Error("Workspace remains in use or process reference proof is unavailable");
      await assertWorkspaceIdentity(record);
      await workspaceGit(record.sourceCwd, ["worktree", "remove", "--force", "--", record.cwd]);
    }
    record.phase = "removed";
    record.reason = undefined;
    await saveWorkspace(record);
    return { ...result, cleanup: "removed", recovery: record.archivePath };
  } catch (error) {
    record.reason = error instanceof Error ? error.message : String(error);
    await saveWorkspace(record).catch(() => undefined);
    return { ...result, reason: record.reason, recovery: record.archiveSha256 ? record.archivePath : undefined };
  }
}

async function records(source: string, stateDir?: string): Promise<{ path: string; record?: OwnedWorkspace }[]> {
  const root = await resolveStateDirectory(source, stateDir);
  const directory = join(root, "workspaces");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) => {
        const path = join(directory, name);
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.size > 64 * 1024) return { path };
          const value = JSON.parse(await readFile(path, "utf8")) as OwnedWorkspace;
          if (
            value.version !== 1 ||
            !/^[a-f0-9-]{36}$/.test(value.id) ||
            name !== `${value.id}.json` ||
            value.recordPath !== path ||
            value.branch !== `ralphworks/${value.id}` ||
            !Array.isArray(value.preservePaths) ||
            !value.preservePaths.every((item) => typeof item === "string") ||
            !Number.isInteger(value.owner?.pid) ||
            value.owner.pid <= 0 ||
            typeof value.cwd !== "string" ||
            !isAbsolute(value.cwd) ||
            value.sourceCwd !== (await realpath(source)) ||
            value.archivePath !== join(root, "workspace-recovery", value.id) ||
            typeof value.stateDir !== "string" ||
            typeof value.commonDir !== "string" ||
            typeof value.baseHead !== "string"
          )
            return { path };
          return { path, record: value };
        } catch {
          return { path };
        }
      }),
  );
}

export async function reconcileWorkspaces(source: string, stateDir?: string, apply = false): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  for (const entry of await records(source, stateDir)) {
    const record = entry.record;
    if (!record) {
      results.push({ id: basename(entry.path), cwd: "unknown", cleanup: "retained", reason: "legacy or invalid ownership record" });
      continue;
    }
    const reason =
      retention(record) ?? (record.phase !== "removed" && heldByLiveOwner(record.owner.pid) ? "owner is live or unknown" : undefined);
    if (reason || record.phase === "removed") {
      results.push({
        id: record.id,
        cwd: record.cwd,
        cleanup: record.phase === "removed" ? "removed" : "retained",
        reason,
        recovery: record.archiveSha256 ? record.archivePath : undefined,
      });
      continue;
    }
    if (!apply) {
      results.push({
        id: record.id,
        cwd: record.cwd,
        cleanup: "eligible",
        recovery: record.archiveSha256 ? record.archivePath : undefined,
      });
      continue;
    }
    try {
      const exists = await lstat(record.cwd).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      );
      if (exists) {
        await assertWorkspaceIdentity(record);
        results.push(await withRunLock(record.cwd, () => cleanupWorkspace(record), { existingOnly: true }));
      } else results.push(await cleanupWorkspace(record));
    } catch (error) {
      results.push({ id: record.id, cwd: record.cwd, cleanup: "retained", reason: String(error) });
    }
  }
  return results;
}

export async function workspaceCommand(action: string, args: string[]): Promise<number> {
  let stateDir: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--state-dir" && args[index + 1] && !args[index + 1].startsWith("--") && stateDir === undefined)
      stateDir = resolve(args[++index]);
    else if (args[index] === "--dry-run" && !dryRun && action === "prune") dryRun = true;
    else throw new Error(`Unknown workspace option: ${args[index]}`);
  }
  if (action !== "list" && action !== "prune") throw new Error("Use workspaces list or workspaces prune [--dry-run]");
  const results = await reconcileWorkspaces(process.cwd(), stateDir, action === "prune" && !dryRun);
  console.log(JSON.stringify(results, null, 2));
  return action === "prune" && !dryRun && results.some((entry) => entry.cleanup === "retained") ? 1 : 0;
}
