import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copySnapshotContent, ORIGIN, skillEntrypoint, snapshotManifest, storeSnapshot, verifySnapshot } from "./skill-snapshot.ts";
import { type GitHubSkill, installSkill, remoteSkill } from "./skill-source.ts";

export type Scope = "builtin" | "project" | "personal";
export type HubOptions = { cwd: string; home?: string };
type SkillOrigin = { kind: "local"; path: string } | (GitHubSkill & { kind: "github"; commit: string });
export type HubPin = {
  scope: Scope;
  snapshot: string;
  entrypoint?: string;
  source?: SkillOrigin;
  importedAt?: string;
  derivedFrom?: { scope: Scope; snapshot: string };
  use?: string;
  autoUpdate?: boolean;
  status?: "pinned" | "updated" | "fallback";
  warning?: { code: string; message: string };
};
export type HubEntry = { current: string; revisions: HubPin[] };
type Catalog = { version: 1; entries: Record<string, HubEntry> };
export function hubReference(value: unknown): { use: string; autoUpdate?: boolean } | undefined {
  if (typeof value === "string" && !/^(builtin|project|personal):/.test(value)) return undefined;
  const raw = typeof value === "string" ? { use: value } : value;
  if (!raw || typeof raw !== "object" || !("use" in raw)) return undefined;
  const ref = raw as { use: unknown; autoUpdate?: unknown };
  if (
    typeof ref.use !== "string" ||
    !/^(builtin|project|personal):[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ref.use) ||
    Object.keys(ref).some((key) => !["use", "autoUpdate"].includes(key)) ||
    (ref.autoUpdate !== undefined && typeof ref.autoUpdate !== "boolean")
  )
    throw new Error("Invalid scoped skill reference");
  return ref as { use: string; autoUpdate?: boolean };
}
function nameCheck(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
}
export class SkillHub {
  readonly options: HubOptions;
  constructor(options: HubOptions) {
    this.options = { ...options, cwd: realpathSync(options.cwd) };
  }
  root(scope: Scope): string {
    if (scope === "builtin") return fileURLToPath(new URL("../skills/", import.meta.url));
    if (scope === "project") return join(this.options.cwd, ".ralphworks", "skills");
    if (scope === "personal")
      return join(resolve(this.options.home ?? process.env.RALPHWORKS_HOME ?? join(homedir(), ".config", "ralphworks")), "skills");
    throw new Error("Invalid skill scope");
  }
  private async catalog(scope: Scope): Promise<Catalog> {
    try {
      const catalog = JSON.parse(await readFile(join(this.root(scope), "catalog.json"), "utf8"));
      if (catalog.version !== 1 || !catalog.entries || typeof catalog.entries !== "object") throw new Error("Invalid skill catalog");
      for (const [name, entry] of Object.entries(catalog.entries)) {
        nameCheck(name);
        validateEntry(entry);
      }
      return catalog;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { version: 1, entries: Object.create(null) };
      throw error;
    }
  }
  private async save(scope: Scope, catalog: Catalog): Promise<void> {
    if (scope === "builtin") throw new Error("Built-in skills are immutable; fork or collect them first");
    await atomicJson(join(this.root(scope), "catalog.json"), catalog);
  }
  async path(pin: HubPin): Promise<string> {
    validatePin(pin);
    return verifySnapshot(this.root(pin.scope), pin.snapshot, pin.entrypoint);
  }
  async directory(pin: HubPin): Promise<string> {
    await this.path(pin);
    return join(this.root(pin.scope), "objects", pin.snapshot, "content");
  }
  async inspect(ref: string): Promise<HubEntry> {
    const parsed = hubReference(ref);
    if (!parsed) throw new Error("Expected a scoped skill reference");
    const [scope, name] = ref.split(":") as [Scope, string];
    const entries = (await this.catalog(scope)).entries;
    const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
    if (!entry) throw new Error(`Skill not found: ${ref}`);
    return entry;
  }
  async current(ref: string): Promise<HubPin> {
    const entry = await this.inspect(ref);
    const revision = [...entry.revisions].reverse().find((item) => item.snapshot === entry.current);
    if (!revision) throw new Error("Invalid skill catalog revision");
    const pin = { ...revision, use: ref };
    await this.path(pin);
    return pin;
  }
  async list(scope?: Scope): Promise<{ use: string; current: string; revisions: number }[]> {
    const result = [];
    for (const selected of scope ? [scope] : (["builtin", "project", "personal"] as Scope[]))
      for (const [name, entry] of Object.entries((await this.catalog(selected)).entries))
        result.push({ use: `${selected}:${name}`, current: entry.current, revisions: entry.revisions.length });
    return result;
  }
  async capture(directory: string, scope: Scope, metadata: Partial<HubPin> = {}): Promise<HubPin> {
    if (scope === "builtin") throw new Error("Built-in skills are immutable; fork or collect them first");
    const snapshot = await storeSnapshot(this.root(scope), directory, metadata.entrypoint);
    return { ...metadata, scope, snapshot, importedAt: metadata.importedAt ?? new Date().toISOString() };
  }
  async copy(pin: HubPin, scope: Scope): Promise<HubPin> {
    return this.capture(await this.directory(pin), scope, pin);
  }
  private async mutate(scope: Scope, change: (catalog: Catalog) => void): Promise<void> {
    if (scope === "builtin") throw new Error("Built-in skills are immutable");
    const root = this.root(scope);
    await mkdir(root, { recursive: true });
    const guard = join(root, ".catalog.lock");
    await mkdir(guard).catch(() => {
      throw new Error("Skill catalog is busy; retry the command");
    });
    try {
      const catalog = await this.catalog(scope);
      change(catalog);
      await this.save(scope, catalog);
    } finally {
      await rm(guard, { recursive: true, force: true });
    }
  }
  private async record(name: string, pin: HubPin): Promise<HubPin> {
    nameCheck(name);
    await this.mutate(pin.scope, (catalog) => {
      const entry = (Object.hasOwn(catalog.entries, name) ? catalog.entries[name] : undefined) ?? { current: pin.snapshot, revisions: [] };
      entry.current = pin.snapshot;
      entry.revisions.push(pin);
      catalog.entries[name] = entry;
    });
    return { ...pin, use: `${pin.scope}:${name}` };
  }
  async add(source: string | GitHubSkill, name: string, scope: Scope, entrypoint?: string): Promise<HubPin> {
    nameCheck(name);
    if (entrypoint !== undefined) skillEntrypoint(entrypoint);
    if (scope === "builtin") throw new Error("Built-in skills are immutable; fork or collect them first");
    const remote = typeof source === "object" || /^https:/.test(source) ? remoteSkill(source) : undefined;
    if (remote) {
      const fetched = await installSkill(
        { ...remote, ...(entrypoint ? { entrypoint } : {}) },
        resolve(this.options.home ?? process.env.RALPHWORKS_HOME ?? join(homedir(), ".config", "ralphworks")),
      );
      return this.record(
        name,
        await this.capture(fetched.contentRoot ?? dirname(fetched.skillPath), scope, {
          ...(fetched.entrypoint ? { entrypoint: fetched.entrypoint } : {}),
          source: { ...remote, ...(fetched.entrypoint ? { entrypoint: fetched.entrypoint } : {}), kind: "github", commit: fetched.commit },
        }),
      );
    }
    const requested = resolve(this.options.cwd, source as string);
    if ((await lstat(requested)).isSymbolicLink()) throw new Error("Skill source symlinks are unsupported");
    let directory = await realpath(requested);
    if ((await lstat(directory)).isFile()) directory = dirname(directory);
    let derivedFrom: HubPin["derivedFrom"];
    try {
      if (!(await lstat(join(directory, ORIGIN))).isFile()) throw new Error("Skill origin symlink or unsupported asset");
      const origin = JSON.parse(await readFile(join(directory, ORIGIN), "utf8"));
      validatePin(origin);
      derivedFrom = { scope: origin.scope, snapshot: origin.snapshot };
      entrypoint ??= origin.entrypoint;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    return this.record(
      name,
      await this.capture(directory, scope, {
        source: { kind: "local", path: directory },
        ...(entrypoint ? { entrypoint } : {}),
        ...(derivedFrom ? { derivedFrom } : {}),
      }),
    );
  }
  async refresh(pin: HubPin, scope: Scope): Promise<HubPin> {
    await this.path(pin);
    if (!pin.source) throw new Error("Skill has no tracked source");
    const { importedAt: _importedAt, status: _status, warning: _warning, ...metadata } = pin;
    if (pin.source.kind === "local") {
      const requested = resolve(this.options.cwd, pin.source.path);
      if ((await lstat(requested)).isSymbolicLink()) throw new Error("Skill source symlinks are unsupported");
      const directory = await realpath(requested);
      return this.capture(directory, scope, { ...metadata, source: { kind: "local", path: directory }, status: "updated" });
    }
    const { kind: _kind, commit: _commit, ...source } = pin.source;
    const fetched = await installSkill(
      source,
      resolve(this.options.home ?? process.env.RALPHWORKS_HOME ?? join(homedir(), ".config", "ralphworks")),
    );
    return this.capture(fetched.contentRoot ?? dirname(fetched.skillPath), scope, {
      ...metadata,
      source: { ...source, kind: "github", commit: fetched.commit },
      status: "updated",
    });
  }
  async archiveRunPin(pin: HubPin, logical: string): Promise<HubPin> {
    const archived = pin.scope === "personal" ? pin : await this.copy(pin, "personal");
    const tracked =
      archived.source?.kind === "github" ? [archived.source.source, archived.source.path, archived.source.ref] : archived.source?.path;
    const name = `auto-${createHash("sha256")
      .update(JSON.stringify([logical, tracked]))
      .digest("hex")
      .slice(0, 24)}`;
    await this.record(name, archived);
    return archived;
  }
  async update(ref: string): Promise<HubPin> {
    const pin = await this.current(ref);
    if (pin.scope === "builtin") throw new Error("Built-in skills are immutable; fork or collect them first");
    return this.record(ref.split(":")[1], await this.refresh(pin, pin.scope));
  }
  async export(ref: string, destination: string): Promise<void> {
    const entry = await this.inspect(ref);
    await mkdir(destination);
    try {
      for (const pin of entry.revisions) {
        await this.path(pin);
        await storeSnapshot(destination, await this.directory(pin), pin.entrypoint);
      }
      await atomicJson(join(destination, "bundle.json"), { version: 1, entry });
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
  async import(bundle: string, name: string, scope: Scope): Promise<HubPin> {
    nameCheck(name);
    if (scope === "builtin") throw new Error("Built-in skills are immutable");
    const raw = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8"));
    if (raw.version !== 1 || !raw.entry || !Array.isArray(raw.entry.revisions)) throw new Error("Invalid skill bundle");
    const entry = raw.entry as HubEntry;
    validateEntry(entry);
    for (const pin of entry.revisions) await verifySnapshot(bundle, pin.snapshot, pin.entrypoint);
    const revisions: HubPin[] = [];
    for (const pin of entry.revisions) revisions.push(await this.capture(join(bundle, "objects", pin.snapshot, "content"), scope, pin));
    await this.mutate(scope, (catalog) => {
      const old = Object.hasOwn(catalog.entries, name) ? catalog.entries[name] : undefined;
      catalog.entries[name] = { current: entry.current, revisions: [...(old?.revisions ?? []), ...revisions] };
    });
    return this.current(`${scope}:${name}`);
  }
  async fork(ref: string, destination: string): Promise<void> {
    const pin = await this.current(ref);
    const source = await this.directory(pin);
    await mkdir(destination);
    try {
      await copySnapshotContent(source, destination, await snapshotManifest(source, false, pin.entrypoint));
      await atomicJson(join(destination, ORIGIN), pin);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validatePin(value: unknown): asserts value is HubPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill pin");
  const pin = value as HubPin;
  if (
    Object.keys(pin).some(
      (key) =>
        !["scope", "snapshot", "entrypoint", "source", "importedAt", "derivedFrom", "use", "autoUpdate", "status", "warning"].includes(key),
    ) ||
    !["builtin", "personal", "project"].includes(pin.scope) ||
    typeof pin.snapshot !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.snapshot) ||
    (pin.autoUpdate !== undefined && typeof pin.autoUpdate !== "boolean")
  )
    throw new Error("Invalid skill pin");
  if (pin.entrypoint !== undefined) skillEntrypoint(pin.entrypoint);
  if (pin.use !== undefined)
    hubReference(pin.use) ??
      (() => {
        throw new Error("Invalid skill pin reference");
      })();
  if (pin.importedAt !== undefined && (typeof pin.importedAt !== "string" || !Number.isFinite(Date.parse(pin.importedAt))))
    throw new Error("Invalid skill import timestamp");
  if (pin.status !== undefined && !["pinned", "updated", "fallback"].includes(pin.status)) throw new Error("Invalid skill refresh status");
  if (pin.warning !== undefined && (pin.warning?.code !== "SKILL_REFRESH_FAILED" || typeof pin.warning.message !== "string"))
    throw new Error("Invalid skill refresh warning");
  if (pin.derivedFrom) {
    if (Object.keys(pin.derivedFrom).some((key) => !["scope", "snapshot"].includes(key))) throw new Error("Invalid skill origin");
    validatePin(pin.derivedFrom);
  }
  if (pin.source) {
    if (pin.source.kind === "local") {
      if (
        Object.keys(pin.source).some((key) => !["kind", "path"].includes(key)) ||
        typeof pin.source.path !== "string" ||
        !pin.source.path ||
        [...pin.source.path].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("Invalid local skill source");
    } else if (pin.source.kind === "github") {
      const { kind: _kind, commit, ...source } = pin.source;
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid skill source commit");
      remoteSkill(source);
    } else throw new Error("Invalid skill source kind");
  }
}
function validateEntry(value: unknown): asserts value is HubEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill catalog entry");
  const entry = value as HubEntry;
  if (
    Object.keys(entry).some((key) => !["current", "revisions"].includes(key)) ||
    !Array.isArray(entry.revisions) ||
    !entry.revisions.length ||
    !entry.revisions.some((pin) => pin.snapshot === entry.current)
  )
    throw new Error("Invalid skill catalog revisions");
  for (const pin of entry.revisions) validatePin(pin);
}
