import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** Runtime bookkeeping must not become ordinary project input or verified edits. */
export async function resolveStateDirectory(cwd: string, stateDir?: string): Promise<string> {
  const workspace = resolve(cwd);
  if (stateDir === undefined) return join(workspace, ".ralph");
  if (!stateDir.trim()) throw new Error("state-dir requires a non-empty path value");
  const root = resolve(workspace, stateDir);
  assertOutsideRunLock(root);
  const canonicalRoot = await canonicalPath(root);
  assertOutsideRunLock(canonicalRoot);
  for (const [project, candidate] of [
    [workspace, root],
    [await canonicalPath(workspace), canonicalRoot],
  ]) {
    if (within(project, candidate) && !within(join(project, ".ralph"), candidate))
      throw new Error("State directory must be outside the workspace or inside its reserved .ralph namespace");
  }
  const info = await stat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (info && !info.isDirectory()) throw new Error("State directory must be a directory");
  return root;
}

function assertOutsideRunLock(path: string): void {
  // Cleanup owns this private subtree; reserve it even across case and mount aliases.
  const parts = normalize(path)
    .split(sep)
    .map((part) => part.toLowerCase());
  if (parts.some((part, index) => part === ".ralph" && parts[index + 1] === "run.lock"))
    throw new Error("State directory cannot use the reserved .ralph/run.lock namespace");
}

/** Explicit progress outside the reserved relative namespace retains its meaning. */
export function stateProgressFile(path: string, stateDir: string): string {
  if (isAbsolute(path)) return path;
  const normalized = normalize(path);
  return normalized === ".ralph" || normalized.startsWith(`.ralph${sep}`) ? join(stateDir, relative(".ralph", normalized)) : path;
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

// Resolve existing ancestors without creating a directory, including dangling aliases.
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info?.isSymbolicLink()) return canonicalPath(resolve(dirname(path), await readlink(path)));
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
