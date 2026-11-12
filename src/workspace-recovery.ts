import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { OwnedWorkspace } from "./workspace-lifecycle.ts";

const exec = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const generated = new Set(["node_modules", "dist", "build", ".cache", ".next", ".turbo"]);
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;
const MAX_ENTRIES = 4096;
type Asset = { path: string; mode: number; sha256?: string; target?: string; tracked?: true };
type Snapshot = {
  head: string;
  staged: string;
  unstaged: string;
  files: Asset[];
  modes: { path: string; mode: number }[];
  excluded: string[];
  trackedSha256: string;
};

export async function workspaceGit(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000, killSignal: "SIGKILL" })).stdout;
}

async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Recovery byte limit exceeded or nonregular file");
    // One extra byte detects growth without allocating unbounded buffers.
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== info.size || (await handle.stat()).size !== size) throw new Error("Recovery file changed while reading");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

export async function durableFile(path: string, bytes: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Patches preserve the index separately; additional files are blobs, never followed symlinks. */
async function snapshot(record: OwnedWorkspace, destination?: string): Promise<Snapshot> {
  const deadline = Date.now() + 30000;
  const cwd = record.cwd;
  const head = (await workspaceGit(cwd, ["rev-parse", "HEAD"])).trim();
  const entries = (await workspaceGit(cwd, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
  if (entries.some((entry) => !/^\d+ [a-f0-9]+ 0\t/.test(entry) || entry.startsWith("160000 ")))
    throw new Error("Recovery requires a resolved index without submodules");
  const flags = (await workspaceGit(cwd, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
  if (flags.some((entry) => entry.startsWith("S ") || /^[a-z] /.test(entry)))
    throw new Error("Unsupported index flags: assume-unchanged or skip-worktree; workspace retained");
  const tracked = new Map(
    entries.map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, blob] = entry.slice(0, tab).split(" ");
      return [entry.slice(tab + 1), { mode: Number.parseInt(mode, 8) & 0o777, blob }];
    }),
  );
  const objectFormat = (await workspaceGit(cwd, ["rev-parse", "--show-object-format"])).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format");
  const preserved = record.preservePaths.map((path) => relative(cwd, resolve(cwd, path)).split(sep).join("/"));
  const diff = async (args: string[]) =>
    (
      await exec("git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", ...args], {
        cwd,
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10000,
        killSignal: "SIGKILL",
      })
    ).stdout;
  const stagedBytes = await diff(["--cached", "HEAD"]);
  const unstagedBytes = await diff([]);
  const staged = stagedBytes.toString("base64");
  const unstaged = unstagedBytes.toString("base64");
  let bytesLeft = MAX_BYTES - stagedBytes.length - unstagedBytes.length;
  let metadata = 0;
  let count = 0;
  const files: Asset[] = [];
  const modes: Snapshot["modes"] = [];
  const excluded: string[] = [];
  const trackedHashes = new Map<string, string>();
  function account(path: string, extra = 0): void {
    if (++count > MAX_ENTRIES) throw new Error("Recovery entry limit exceeded");
    metadata += Buffer.byteLength(path) + extra + 256;
    if (metadata > MAX_METADATA) throw new Error("Recovery metadata limit exceeded");
  }
  async function store(bytes: Buffer): Promise<string> {
    const sha256 = digest(bytes);
    if (destination) {
      await durableFile(join(destination, "files", sha256), bytes).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    return sha256;
  }
  async function walk(directory: string, prefix = ""): Promise<void> {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Recovery directory changed while reading");
    for await (const entry of await opendir(directory)) {
      if (Date.now() > deadline) throw new Error("Recovery snapshot time limit exceeded");
      const name = entry.name;
      const path = prefix + name;
      if (path === ".git" || path === ".ralph/run.lock") continue;
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        const required = preserved.some((value) => value === "" || value === path || value.startsWith(`${path}/`));
        if (generated.has(name) && !required && ![...tracked.keys()].some((value) => value.startsWith(`${path}/`))) {
          const ignored = await workspaceGit(cwd, ["check-ignore", "--", path]).then(
            () => true,
            () => false,
          );
          if (ignored) {
            account(path);
            excluded.push(path);
            continue;
          }
        }
        await walk(absolute, `${path}/`);
      } else if (tracked.has(path)) {
        const indexed = tracked.get(path);
        if (!indexed) throw new Error("Tracked index entry disappeared");
        const mode = info.mode & 0o777;
        const hash = createHash("sha256").update(String(mode));
        let overlaid = false;
        if (info.isSymbolicLink()) {
          const target = await readlink(absolute);
          const bytes = Buffer.from(target);
          hash.update(bytes);
          const blob = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
          if (blob !== indexed.blob) {
            account(path, bytes.length);
            files.push({ path, mode, target, tracked: true });
            overlaid = true;
          }
        } else if (info.isFile()) {
          const blob = createHash(objectFormat).update(`blob ${info.size}\0`);
          // Fingerprint clean tracked assets without copying them or applying the capture byte cap.
          const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const buffer = Buffer.alloc(128 * 1024);
            let position = 0;
            while (position <= info.size) {
              if (Date.now() > deadline) throw new Error("Recovery snapshot time limit exceeded");
              const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size + 1 - position), position);
              if (!bytesRead) break;
              hash.update(buffer.subarray(0, bytesRead));
              blob.update(buffer.subarray(0, bytesRead));
              position += bytesRead;
            }
            const after = await handle.stat();
            if (position !== info.size || after.size !== info.size || after.dev !== info.dev || after.ino !== info.ino)
              throw new Error("Tracked file changed while fingerprinting");
          } finally {
            await handle.close();
          }
          const rawBlob = blob.digest("hex");
          if (rawBlob !== indexed.blob) {
            account(path);
            const bytes = await boundedRead(absolute, bytesLeft);
            bytesLeft -= bytes.length;
            if (createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== rawBlob)
              throw new Error("Tracked raw bytes changed while capturing overlay");
            files.push({ path, mode, sha256: await store(bytes), tracked: true });
            overlaid = true;
          }
        } else throw new Error(`Unsupported tracked recovery file: ${path}`);
        trackedHashes.set(path, hash.digest("hex"));
        // core.filemode=false can hide even a normal 0644/0755 change from patches.
        if (info.isFile() && mode !== indexed.mode && !overlaid) {
          account(path);
          modes.push({ path, mode });
        }
      } else if (info.isSymbolicLink()) {
        if (info.size > 4096) throw new Error("Recovery symlink limit exceeded");
        const target = await readlink(absolute);
        account(path, Buffer.byteLength(target));
        files.push({ path, mode: info.mode & 0o777, target });
      } else if (info.isFile()) {
        account(path);
        const bytes = await boundedRead(absolute, bytesLeft);
        bytesLeft -= bytes.length;
        const sha256 = await store(bytes);
        files.push({ path, mode: info.mode & 0o777, sha256 });
      } else throw new Error(`Unsupported recovery file: ${path}`);
    }
  }
  await walk(cwd);
  files.sort((a, b) => a.path.localeCompare(b.path));
  modes.sort((a, b) => a.path.localeCompare(b.path));
  excluded.sort();
  const trackedHash = createHash("sha256");
  for (const path of [...tracked.keys()].sort()) trackedHash.update(`${path}\0${trackedHashes.get(path) ?? "deleted"}\0`);
  return { head, staged, unstaged, files, modes, excluded, trackedSha256: trackedHash.digest("hex") };
}

export async function verifyWorkspaceArchive(record: OwnedWorkspace, compareWorkspace = true): Promise<string> {
  const path = record.archivePath;
  const raw = (await boundedRead(join(path, "manifest.json"), 2 * MAX_METADATA)).toString("utf8");
  if (record.archiveSha256 && record.archiveSha256 !== digest(raw)) throw new Error("Recovery manifest changed");
  const manifest = JSON.parse(raw);
  if (manifest.version !== 1 || manifest.id !== record.id || manifest.baseHead !== record.baseHead || manifest.head !== record.head)
    throw new Error("Recovery manifest identity mismatch");
  const staged = await boundedRead(join(path, "staged.patch"), MAX_BYTES);
  const unstaged = await boundedRead(join(path, "unstaged.patch"), MAX_BYTES - staged.length);
  let remaining = MAX_BYTES - staged.length - unstaged.length;
  if (digest(staged) !== manifest.stagedSha256 || digest(unstaged) !== manifest.unstagedSha256)
    throw new Error("Recovery patch integrity failure");
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_ENTRIES) throw new Error("Invalid recovery file inventory");
  for (const file of manifest.files as Asset[]) {
    if (file.sha256) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Recovery file integrity failure");
      const bytes = await boundedRead(join(path, "files", file.sha256), remaining);
      remaining -= bytes.length;
      if (digest(bytes) !== file.sha256) throw new Error("Recovery file integrity failure");
    }
  }
  const ref = `refs/ralphworks/recovery/${record.id}`;
  if ((await workspaceGit(record.sourceCwd, ["rev-parse", ref])).trim() !== record.head)
    throw new Error("Recovery commit reference changed");
  if (compareWorkspace && digest(JSON.stringify(await snapshot(record))) !== manifest.snapshotSha256)
    throw new Error("Workspace changed since recovery snapshot");
  return digest(raw);
}

export async function archiveWorkspace(record: OwnedWorkspace): Promise<string> {
  if (
    await lstat(record.archivePath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    )
  )
    return verifyWorkspaceArchive(record);
  await mkdir(dirname(record.archivePath), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(`${record.archivePath}.pending-`);
  try {
    await mkdir(join(temporary, "files"), { mode: 0o700 });
    const state = await snapshot(record, temporary);
    if (state.head !== record.head) throw new Error("Workspace HEAD changed before recovery");
    const ref = `refs/ralphworks/recovery/${record.id}`;
    const old = await workspaceGit(record.sourceCwd, ["rev-parse", "--verify", ref]).then(
      (value) => value.trim(),
      () => "",
    );
    if (old && old !== state.head) throw new Error("Recovery reference already points to another commit");
    if (!old) await workspaceGit(record.sourceCwd, ["update-ref", ref, state.head, ""]);
    await durableFile(join(temporary, "staged.patch"), Buffer.from(state.staged, "base64"));
    await durableFile(join(temporary, "unstaged.patch"), Buffer.from(state.unstaged, "base64"));
    await durableFile(
      join(temporary, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          id: record.id,
          sourceCwd: record.sourceCwd,
          commonDir: record.commonDir,
          baseHead: record.baseHead,
          head: state.head,
          recoveryRef: ref,
          stagedSha256: digest(Buffer.from(state.staged, "base64")),
          unstagedSha256: digest(Buffer.from(state.unstaged, "base64")),
          files: state.files,
          modes: state.modes,
          excluded: state.excluded,
          trackedSha256: state.trackedSha256,
          snapshotSha256: digest(JSON.stringify(state)),
        },
        null,
        2,
      ) + "\n",
    );
    await syncDirectory(join(temporary, "files"));
    await syncDirectory(temporary);
    if (digest(JSON.stringify(await snapshot(record))) !== digest(JSON.stringify(state)))
      throw new Error("Workspace changed while archiving");
    await rename(temporary, record.archivePath);
    await syncDirectory(dirname(record.archivePath));
    return verifyWorkspaceArchive(record);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
