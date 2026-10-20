import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ORIGIN = ".ralphworks-origin.json";
const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
type FileRecord = { path: string; sha256: string; executable: number };
export type SnapshotManifest = { version: 1; snapshot: string; files: FileRecord[] };
export function skillEntrypoint(value: unknown = "SKILL.md"): string {
  if (typeof value !== "string") throw new Error("Invalid skill entrypoint");
  safePath(value);
  if (value.split("/").at(-1) !== "SKILL.md" || /^[A-Za-z]:/.test(value))
    throw new Error("Skill entrypoint must be a relative SKILL.md path");
  return value;
}
function safePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || [".", "..", ".git"].includes(part)) ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error(`Unsafe skill path: ${path}`);
}
export async function snapshotManifest(directory: string, allowOrigin = false, entrypoint = "SKILL.md"): Promise<SnapshotManifest> {
  skillEntrypoint(entrypoint);
  const files: FileRecord[] = [];
  let bytes = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Skill directory must be a regular directory");
    for (const name of (await readdir(directory)).sort()) {
      if (!prefix && name === ORIGIN) {
        if (allowOrigin) {
          if (!(await lstat(join(directory, name))).isFile()) throw new Error("Skill origin symlink or unsupported asset");
          continue;
        }
        throw new Error("Skill integrity failure: unexpected origin metadata");
      }
      const path = `${prefix}${name}`;
      safePath(path);
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) await walk(absolute, `${path}/`);
      else if (info.isFile()) {
        bytes += info.size;
        if (files.length >= 100 || bytes > 1024 * 1024) throw new Error("Skill resources exceed 100 files or 1 MiB");
        files.push({ path, sha256: hash(await readFile(absolute)), executable: info.mode & 0o111 });
      } else throw new Error(`Skill symlink or unsupported asset: ${path}`);
    }
  }
  await walk(directory, "");
  if (!files.some((file) => file.path === entrypoint)) throw new Error(`Skill requires entrypoint ${entrypoint}`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, snapshot: hash(JSON.stringify(files)), files };
}
function objectPath(root: string, snapshot: string): string {
  if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new Error("Invalid skill snapshot digest");
  return join(root, "objects", snapshot);
}
export async function verifySnapshot(root: string, snapshot: string, entrypoint = "SKILL.md"): Promise<string> {
  skillEntrypoint(entrypoint);
  const directory = objectPath(root, snapshot);
  for (const path of [directory, join(directory, "manifest.json")])
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Skill integrity failure: symlink");
  const expected = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const actual = await snapshotManifest(join(directory, "content"), false, entrypoint);
  if (expected.version !== 1 || actual.snapshot !== snapshot || JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Skill integrity failure: corrupt snapshot ${snapshot}`);
  return join(directory, "content", entrypoint);
}
export async function copySnapshotContent(source: string, destination: string, manifest: SnapshotManifest): Promise<void> {
  for (const file of manifest.files) {
    safePath(file.path);
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file.path), target);
    await chmod(target, 0o644 | file.executable);
  }
}
export async function storeSnapshot(root: string, source: string, entrypoint = "SKILL.md"): Promise<string> {
  const manifest = await snapshotManifest(source, true, entrypoint);
  const destination = objectPath(root, manifest.snapshot);
  const exists = await lstat(destination).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (exists) {
    await verifySnapshot(root, manifest.snapshot, entrypoint);
    return manifest.snapshot;
  }
  await mkdir(join(root, "objects"), { recursive: true });
  const temporary = join(root, "objects", `.prepare-${randomUUID()}`);
  try {
    await mkdir(temporary);
    await copySnapshotContent(source, join(temporary, "content"), manifest);
    if ((await snapshotManifest(join(temporary, "content"), false, entrypoint)).snapshot !== manifest.snapshot)
      throw new Error("Skill changed during import");
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
    }
    await verifySnapshot(root, manifest.snapshot, entrypoint);
    return manifest.snapshot;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
