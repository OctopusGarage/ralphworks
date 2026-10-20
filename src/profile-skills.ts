import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicJson, type HubOptions, type HubPin, hubReference, SkillHub } from "./skill-hub.ts";
import { type GitHubSkill, type RemoteSkillPin, remoteSkill, SkillSources } from "./skill-source.ts";
export type SkillDeclaration = string | GitHubSkill | { use: string; autoUpdate?: boolean };
export type ProfileSkillEntry = {
  path: string;
  contentRoot?: string;
  key: string;
  declaration: SkillDeclaration;
  remote?: RemoteSkillPin;
  hub?: HubPin;
};
export function profileLockPath(top: string): string {
  return join(dirname(top), basename(top).replace(/\.json$/, "") + ".lock.json");
}
export function skillKey(skill: SkillDeclaration, declaring: string, top: string): string {
  const hub = hubReference(skill);
  if (hub) return hub.use;
  const remote = remoteSkill(skill);
  if (remote)
    return JSON.stringify([
      remote.source,
      remote.path,
      remote.ref,
      ...(remote.entrypoint && remote.entrypoint !== "SKILL.md" ? [remote.entrypoint] : []),
    ]);
  return JSON.stringify(["local", relative(dirname(top), declaring).split("\\").join("/"), skill]);
}
export class ProfileSkills {
  readonly hub: SkillHub;
  readonly legacy: SkillSources;
  readonly entries = new Map<string, ProfileSkillEntry>();
  private locked: Record<string, HubPin> = Object.create(null);
  private loaded = false;
  readonly top: string;
  private readonly update?: "all" | "auto";
  constructor(top: string, options: HubOptions & { home: string }, update?: "all" | "auto") {
    this.top = top;
    this.hub = new SkillHub(options);
    this.legacy = new SkillSources(top, options.home, update);
    this.update = update;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const lock = JSON.parse(await readFile(profileLockPath(this.top), "utf8"));
      if (lock.version !== 1 || !lock.skills || typeof lock.skills !== "object" || Array.isArray(lock.skills))
        throw new Error("Invalid portable profile skill lock");
      this.locked = lock.skills;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.loaded = true;
  }
  async resolve(skill: SkillDeclaration, declaring: string): Promise<ProfileSkillEntry> {
    await this.load();
    const key = skillKey(skill, declaring, this.top);
    const named = hubReference(skill);
    const remote = named ? undefined : remoteSkill(skill);
    const autoUpdate = named?.autoUpdate ?? remote?.autoUpdate;
    const already = this.entries.get(key);
    if (already && !(autoUpdate && !already.hub?.autoUpdate && !already.remote?.autoUpdate)) return already;
    let pin = this.locked[key];
    if (pin) await this.hub.path(pin);
    if (named && (this.update === "all" || (!pin && named.use.startsWith("builtin:")))) pin = await this.hub.current(named.use);
    if (named && !pin) throw new Error(`Skill ${named.use} is not pinned. Run ralphworks profiles update ${basename(dirname(this.top))}`);
    if (!named && !remote && this.update === "all") {
      const source = resolve(dirname(declaring), skill as string);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error("Profile asset symlink is unsupported");
      const directory = info.isDirectory() ? source : dirname(source);
      if (!info.isDirectory() && basename(source) !== "SKILL.md") throw new Error("Profile skills must reference a directory or SKILL.md");
      pin = await this.hub.capture(directory, pin?.scope === "project" ? "project" : "personal", {
        source: { kind: "local", path: directory },
      });
    }
    if (pin && remote && this.update === "all") pin = await this.hub.refresh(pin, pin.scope === "builtin" ? "personal" : pin.scope);
    if (pin && this.update === "auto" && autoUpdate) {
      try {
        pin = await this.hub.archiveRunPin({ ...(await this.hub.refresh(pin, "personal")), status: "updated" }, key);
      } catch {
        pin = {
          ...pin,
          status: "fallback",
          warning: { code: "SKILL_REFRESH_FAILED", message: "Skill refresh failed; using the verified pinned snapshot" },
        };
      }
    }
    let entry: ProfileSkillEntry;
    if (pin) {
      pin = {
        ...pin,
        ...(named ? { use: named.use } : {}),
        ...(autoUpdate !== undefined ? { autoUpdate } : {}),
        status: this.update === "auto" && autoUpdate ? (pin.status ?? "updated") : "pinned",
      };
      if (autoUpdate === undefined) delete pin.autoUpdate;
      const path = await this.hub.path(pin);
      const tracked = pin.source?.kind === "github" ? pin.source : undefined;
      entry = {
        path,
        contentRoot: await this.hub.directory(pin),
        key,
        declaration: skill,
        hub: pin,
        ...(tracked && remote
          ? {
              remote: {
                ...remote,
                commit: tracked.commit,
                skillPath: path,
                contentRoot: await this.hub.directory(pin),
                sha256: pin.snapshot,
              },
            }
          : {}),
      };
    } else if (remote) {
      const fetched = await this.legacy.resolve(remote);
      entry = {
        path: fetched.skillPath,
        contentRoot: fetched.contentRoot ?? dirname(fetched.skillPath),
        key,
        declaration: skill,
        remote: fetched,
      };
      if (this.update === "auto" && autoUpdate) {
        const metadata = {
          ...(fetched.entrypoint ? { entrypoint: fetched.entrypoint } : {}),
          source: {
            kind: "github" as const,
            source: fetched.source,
            path: fetched.path,
            ref: fetched.ref,
            commit: fetched.commit,
            ...(fetched.entrypoint ? { entrypoint: fetched.entrypoint } : {}),
          },
          autoUpdate,
          status: fetched.status ?? ("updated" as const),
          ...(fetched.warning ? { warning: fetched.warning } : {}),
        };
        try {
          const archived = await this.hub.archiveRunPin(
            await this.hub.capture(fetched.contentRoot ?? dirname(fetched.skillPath), "personal", metadata),
            key,
          );
          entry = { ...entry, path: await this.hub.path(archived), contentRoot: await this.hub.directory(archived), hub: archived };
        } catch (error) {
          const previous = this.legacy.prior(remote);
          if (!previous) throw error;
          const fallback: RemoteSkillPin = {
            ...previous,
            ...remote,
            status: "fallback",
            warning: { code: "SKILL_REFRESH_FAILED", message: "Skill refresh failed; using the verified pinned snapshot" },
          };
          entry = {
            path: fallback.skillPath,
            contentRoot: fallback.contentRoot ?? dirname(fallback.skillPath),
            key,
            declaration: skill,
            remote: fallback,
          };
        }
      }
    } else {
      const path = resolve(dirname(declaring), skill as string);
      const file = (await lstat(path)).isDirectory() ? join(path, "SKILL.md") : path;
      if (basename(file) !== "SKILL.md") throw new Error("Profile skills must reference a directory or SKILL.md");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Profile skill must be a regular file");
      entry = { path: file, key, declaration: skill };
    }
    this.entries.set(key, entry);
    return entry;
  }
  async portable(entries: ProfileSkillEntry[], scope: "personal" | "project"): Promise<Record<string, HubPin>> {
    const pins: Record<string, HubPin> = Object.create(null);
    for (const entry of entries) {
      const source = entry.remote ? { ...entry.remote, kind: "github" as const } : undefined;
      const metadata: Partial<HubPin> =
        entry.hub ??
        (source
          ? {
              ...(source.entrypoint ? { entrypoint: source.entrypoint } : {}),
              source: {
                kind: "github",
                source: source.source,
                path: source.path,
                ref: source.ref,
                commit: source.commit,
                ...(source.entrypoint ? { entrypoint: source.entrypoint } : {}),
              },
              autoUpdate: source.autoUpdate,
            }
          : { source: { kind: "local", path: dirname(entry.path) } });
      pins[entry.key] = await this.hub.capture(entry.contentRoot ?? dirname(entry.path), scope, metadata);
    }
    return pins;
  }
  async saveLock(pins: Record<string, HubPin>, top = this.top): Promise<void> {
    pins = Object.fromEntries(
      Object.entries(pins).map(([key, pin]) => [
        key,
        pin.source?.kind === "local" && isAbsolute(pin.source.path)
          ? { ...pin, source: { kind: "local", path: relative(this.hub.options.cwd, pin.source.path).split("\\").join("/") || "." } }
          : pin,
      ]),
    );
    await atomicJson(profileLockPath(top), { version: 1, skills: pins });
  }
  async save(): Promise<void> {
    // Run refreshes are ephemeral. Explicit updates atomically publish the complete portable pin set.
    if (this.update === "all") {
      const pins = await this.portable(
        [...this.entries.values()].filter((entry) => !entry.hub),
        "personal",
      );
      for (const [key, entry] of this.entries) if (entry.hub) pins[key] = entry.hub;
      await this.legacy.save();
      await this.saveLock(pins);
    } else if (this.update !== "auto") await this.legacy.save();
  }
}
