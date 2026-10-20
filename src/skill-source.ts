import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { skillEntrypoint } from "./skill-snapshot.ts";

export type GitHubSkill = { source: string; path: string; ref: string; autoUpdate?: boolean; entrypoint?: string };
export type RemoteSkillPin = GitHubSkill & {
  commit: string;
  skillPath: string;
  contentRoot?: string;
  sha256: string;
  status?: "fallback";
  warning?: { code: string; message: string };
};
export type SkillUpdate = GitHubSkill & { previousCommit?: string; commit: string };
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function remoteSkill(value: unknown): GitHubSkill | undefined {
  if (typeof value === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  let raw: Record<string, unknown>;
  if (typeof value === "string") {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (!["tree", "blob"].includes(parts[2]) || parts.length < 5) throw new Error("GitHub skill URLs must include tree/REF/PATH");
    raw = { source: `${url.origin}/${parts[0]}/${parts[1]}`, ref: parts[3], path: parts.slice(4).join("/") };
    if (url.username || url.password || url.search || url.hash) throw new Error("Invalid GitHub skill URL");
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill must be a local path or GitHub source");
    raw = value as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !["source", "path", "ref", "autoUpdate", "entrypoint"].includes(key)))
      throw new Error("Unknown GitHub skill field");
  }
  if (typeof raw.source !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(raw.source))
    throw new Error("Skill source must be an HTTPS GitHub repository URL");
  if (
    typeof raw.path !== "string" ||
    !raw.path ||
    (raw.path !== "." && raw.path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) ||
    raw.path.includes("\\") ||
    [...raw.path].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("GitHub skill path must be relative without traversal");
  const path = raw.path === "SKILL.md" ? "." : raw.path.endsWith("/SKILL.md") ? raw.path.slice(0, -9) : raw.path;
  if (
    !path ||
    (raw.ref !== undefined && (typeof raw.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(raw.ref) || raw.ref.includes("..")))
  )
    throw new Error("Invalid GitHub skill ref or path");
  if (raw.autoUpdate !== undefined && typeof raw.autoUpdate !== "boolean") throw new Error("GitHub skill autoUpdate must be boolean");
  const entrypoint = skillEntrypoint(raw.entrypoint);
  return {
    ...(entrypoint !== "SKILL.md" ? { entrypoint } : {}),
    source: raw.source.replace(/\.git$/, ""),
    path,
    ref: (raw.ref as string | undefined) ?? "HEAD",
    ...(raw.autoUpdate !== undefined ? { autoUpdate: raw.autoUpdate as boolean } : {}),
  };
}

function identity(skill: GitHubSkill): string {
  return hash(
    JSON.stringify([
      skill.source,
      skill.path,
      skill.ref,
      ...(skill.entrypoint && skill.entrypoint !== "SKILL.md" ? [skill.entrypoint] : []),
    ]),
  );
}
async function treeHash(directory: string, legacy = false, entrypoint = "SKILL.md"): Promise<string> {
  skillEntrypoint(entrypoint);
  const files: [string, string, number][] = [];
  let bytes = 0;
  async function walk(path: string, prefix: string): Promise<void> {
    if (!(await lstat(path)).isDirectory()) throw new Error(`Skill cache corrupt: ${path}`);
    for (const name of (await readdir(path)).sort()) {
      const absolute = join(path, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) await walk(absolute, `${prefix}${name}/`);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 1024 * 1024 || files.length >= 100) throw new Error("Skill resources exceed 100 files or 1 MiB");
        files.push([`${prefix}${name}`, hash(await readFile(absolute)), info.mode & 0o111]);
      } else throw new Error(`Skill symlink or unsupported asset: ${absolute}`);
    }
  }
  await walk(directory, "");
  if (!files.some(([path]) => path === entrypoint)) throw new Error(`Remote skill requires entrypoint ${entrypoint}`);
  return hash(JSON.stringify(files.sort(([a], [b]) => (legacy ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0))));
}
const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ])
    delete env[key];
  const result = await exec(
    "git",
    ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "protocol.ext.allow=never", ...args],
    {
      cwd,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "buffer",
      env,
    },
  );
  return result.stdout;
}
export async function installSkill(skill: GitHubSkill, home: string): Promise<RemoteSkillPin> {
  skillEntrypoint(skill.entrypoint);
  const root = join(home, "cache", "skills");
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, ".fetch-"));
  try {
    await git(temporary, ["init", "--bare", "repository"]);
    const repository = join(temporary, "repository");
    await git(repository, ["fetch", "--depth=1", "--no-tags", "--", skill.source, skill.ref]);
    const commit = (await git(repository, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString().trim();
    const listing = (
      await git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...(skill.path === "." ? [] : [`${skill.path}/`])])
    ).toString();
    const content = join(temporary, "content");
    await mkdir(content);
    let count = 0;
    let bytes = 0;
    for (const entry of listing.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
      if (!match) throw new Error("Remote skill contains symlink or unsupported asset");
      if (
        (skill.path !== "." && !match[3].startsWith(`${skill.path}/`)) ||
        [...match[3]].some((character) => character.charCodeAt(0) < 32) ||
        match[3].includes("\\")
      )
        throw new Error("Unsafe remote skill path");
      const path = skill.path === "." ? match[3] : match[3].slice(skill.path.length + 1);
      if (!path || path.split("/").some((part) => part === ".git" || part === "..")) throw new Error("Unsafe remote skill path");
      const data = await git(repository, ["cat-file", "blob", match[2]]);
      bytes += data.length;
      if (++count > 100 || bytes > 1024 * 1024) throw new Error("Skill resources exceed 100 files or 1 MiB");
      const target = join(content, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { mode: match[1] === "100755" ? 0o755 : 0o644 });
      await chmod(target, match[1] === "100755" ? 0o755 : 0o644);
    }
    if (skill.path !== ".") {
      const rootEntries = (await git(repository, ["ls-tree", "-z", commit])).toString().split("\0").filter(Boolean);
      const licenses = rootEntries.filter((entry) => /\t(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT)(?:[.-][^/]*)?$/i.test(entry));
      if (licenses.length) {
        try {
          await lstat(join(content, ".upstream"));
          throw new Error("Selected skill conflicts with reserved .upstream license directory");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        for (const entry of licenses) {
          const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
          if (!match) throw new Error("Upstream license must be a regular file");
          const data = await git(repository, ["cat-file", "blob", match[2]]);
          bytes += data.length;
          if (++count > 100 || bytes > 1024 * 1024) throw new Error("Skill resources exceed 100 files or 1 MiB");
          await mkdir(join(content, ".upstream"), { recursive: true });
          await writeFile(join(content, ".upstream", match[3]), data, { mode: match[1] === "100755" ? 0o755 : 0o644 });
          await chmod(join(content, ".upstream", match[3]), match[1] === "100755" ? 0o755 : 0o644);
        }
      }
    }
    const sha256 = await treeHash(content, false, skill.entrypoint);
    const destination = join(root, hash(`v2\n${skill.source}\n${skill.path}\n${commit}`));
    try {
      await rename(content, destination);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
      if ((await treeHash(destination, false, skill.entrypoint)) !== sha256)
        throw new Error(`Skill cache changed or corrupt: ${destination}`);
    }
    return {
      ...skill,
      commit,
      skillPath: join(destination, skill.entrypoint ?? "SKILL.md"),
      ...(skill.entrypoint ? { contentRoot: destination } : {}),
      sha256,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export class SkillSources {
  readonly pins = new Map<string, RemoteSkillPin>();
  readonly updates: SkillUpdate[] = [];
  private original?: string;
  private readonly entries: Record<string, RemoteSkillPin> = Object.create(null);
  private loaded = false;
  private dirty = false;
  private readonly refreshed = new Set<string>();
  private readonly priorPins = new Map<string, RemoteSkillPin>();
  private readonly profile: string;
  private readonly home: string;
  private readonly update?: "all" | "auto";
  constructor(profile: string, home: string, update?: "all" | "auto") {
    this.profile = profile;
    this.home = home;
    this.update = update;
  }
  private lockPath(profile = this.profile): string {
    return join(this.home, "cache", "skill-locks", `${hash(profile)}.json`);
  }
  prior(skill: GitHubSkill): RemoteSkillPin | undefined {
    return this.priorPins.get(identity(skill));
  }
  async resolve(skill: GitHubSkill): Promise<RemoteSkillPin> {
    if (!this.loaded) {
      try {
        this.original = await readFile(this.lockPath(), "utf8");
        const lock = JSON.parse(this.original);
        if (lock.version !== 1 || !lock.skills || typeof lock.skills !== "object") throw new Error("Invalid skill lock");
        Object.assign(this.entries, lock.skills);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      this.loaded = true;
    }
    const key = identity(skill);
    const already = this.pins.get(key);
    if (already && !(this.update === "auto" && skill.autoUpdate && !already.autoUpdate && !this.refreshed.has(key))) {
      const merged = skill.autoUpdate ? { ...already, autoUpdate: true } : already;
      this.pins.set(key, merged);
      return merged;
    }
    const previous = this.entries[key];
    if (previous) {
      const original = join(
        this.home,
        "cache",
        "skills",
        hash(`${skill.source}\n${skill.path}\n${previous.commit}`),
        skill.entrypoint ?? "SKILL.md",
      );
      const current = join(
        this.home,
        "cache",
        "skills",
        hash(`v2\n${skill.source}\n${skill.path}\n${previous.commit}`),
        skill.entrypoint ?? "SKILL.md",
      );
      const supported = previous.skillPath === original || previous.skillPath === current;
      if (!supported || !/^[a-f0-9]{40,64}$/.test(previous.commit))
        throw new Error(`Skill cache changed or corrupt: ${previous.skillPath}`);
      const contentRoot = join(
        this.home,
        "cache",
        "skills",
        hash(`${previous.skillPath === original ? "" : "v2\n"}${skill.source}\n${skill.path}\n${previous.commit}`),
      );
      if (previous.contentRoot !== undefined && previous.contentRoot !== contentRoot)
        throw new Error("Skill cache changed or corrupt: content root");
      const actual = await treeHash(contentRoot, false, skill.entrypoint);
      if (
        actual !== previous.sha256 &&
        !(previous.skillPath === original && (await treeHash(contentRoot, true, skill.entrypoint)) === previous.sha256)
      )
        throw new Error(`Skill cache changed or corrupt: ${previous.skillPath}`);
    }
    if (previous && !this.priorPins.has(key)) this.priorPins.set(key, previous);
    const shouldUpdate = this.update === "all" || (this.update === "auto" && skill.autoUpdate);
    let pin: RemoteSkillPin;
    try {
      pin = !previous || shouldUpdate ? await installSkill(skill, this.home) : { ...previous, ...skill };
    } catch (error) {
      if (this.update !== "auto" || !previous) throw error;
      pin = {
        ...previous,
        ...skill,
        status: "fallback",
        warning: { code: "SKILL_REFRESH_FAILED", message: "Skill refresh failed; using the verified pinned snapshot" },
      };
    }
    if (skill.autoUpdate === undefined) delete pin.autoUpdate;
    this.pins.set(key, pin);
    if (!previous || shouldUpdate) {
      this.refreshed.add(key);
      this.entries[key] = pin;
      this.dirty = true;
      this.updates.push({ ...skill, previousCommit: previous?.commit, commit: pin.commit });
    }
    return pin;
  }
  async save(destinationProfile?: string): Promise<void> {
    if (!this.dirty && !destinationProfile) return;
    const destination = this.lockPath(destinationProfile);
    await mkdir(dirname(destination), { recursive: true });
    const guard = `${destination}.lock`;
    await mkdir(guard).catch((error: unknown) => {
      throw new Error("Skill lock is busy; retry resolution", { cause: error });
    });
    try {
      if (!destinationProfile) {
        const current = await readFile(destination, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (current !== this.original) throw new Error("Skill lock changed concurrently; retry resolution");
      }
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, skills: this.entries }, null, 2)}\n`);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      await rm(guard, { recursive: true, force: true });
    }
  }
}
