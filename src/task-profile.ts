import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProfileSkillEntry, ProfileSkills, profileLockPath, type SkillDeclaration, skillKey } from "./profile-skills.ts";
import type { JobOverrides } from "./run-args.ts";
import { type HubPin, hubReference } from "./skill-hub.ts";
import { type RemoteSkillPin, remoteSkill, type SkillUpdate } from "./skill-source.ts";
import { normalizeOutputs, normalizeTaskEnvironment, type OutputRequirement, type TaskEnvironment } from "./task-environment.ts";

type ParameterDescriptor = {
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  required?: boolean;
  enum?: (string | number | boolean)[];
};
type Parameter = string | null | ParameterDescriptor;
type LibraryOptions = { cwd: string; home?: string };
type Profile = {
  version: 1;
  name: string;
  description?: string;
  category?: string;
  extends?: string[];
  prompts?: string[];
  skills?: SkillDeclaration[];
  parameters?: Record<string, Parameter>;
  defaults?: JobOverrides;
  checks?: string[];
  artifacts?: string[];
  environment?: Partial<TaskEnvironment>;
  outputs?: OutputRequirement[];
};
type Composition = {
  name: string;
  description?: string;
  category?: string;
  prompts: string[];
  skills: string[];
  parameters: Record<string, Parameter>;
  defaults: JobOverrides;
  checks?: string[];
  artifacts: string[];
  sources: string[];
  skillEntries: ProfileSkillEntry[];
  remoteSkills: RemoteSkillPin[];
  environmentLayers: Partial<TaskEnvironment>[];
  outputs: OutputRequirement[];
};
type ProfileManifest = {
  version: 1;
  sources: string[];
  resources: { path: string; sha256: string }[];
  parameters: Record<string, string>;
  remoteSkills?: RemoteSkillPin[];
  hubSkills?: (HubPin & { logical: string })[];
};
export type ResolvedTaskProfile = {
  name: string;
  category?: string;
  task: string;
  defaults: JobOverrides;
  checks?: string[];
  skillPaths: string[];
  skillRoots?: string[];
  environment: TaskEnvironment;
  outputs: OutputRequirement[];
  manifest: ProfileManifest;
};

export async function resolveTaskProfile(
  selector: string,
  options: LibraryOptions & { params?: Record<string, string>; updateSkills?: "all" | "auto" },
): Promise<ResolvedTaskProfile> {
  const path = await locate(selector, options);
  const sources = new ProfileSkills(path, { ...options, home: libraryHome(options.home) }, options.updateSkills);
  const profile = await compose(path, options, [], sources);
  const parameters: Record<string, string> = Object.create(null);
  for (const key of Object.keys(options.params ?? {})) {
    if (!Object.hasOwn(profile.parameters, key)) throw new Error(`Unknown profile parameter: ${key}`);
    if (typeof options.params?.[key] !== "string") throw new Error(`Profile parameter ${key} must be a string`);
  }
  for (const [key, fallback] of Object.entries(profile.parameters)) {
    const supplied = options.params && Object.hasOwn(options.params, key) ? options.params[key] : undefined;
    parameters[key] = resolveParameter(key, fallback, supplied);
  }
  const resources = await fingerprint(profile);
  const environment = mergeEnvironment(profile.environmentLayers);
  const sections: string[] = [];
  for (const path of profile.prompts) sections.push(await readFile(path, "utf8"));
  for (const path of profile.skills) sections.push(`Skill: ${path}\n\n${await readFile(path, "utf8")}`);
  if (profile.artifacts.length) sections.push(`Expected artifacts:\n${profile.artifacts.map((path) => `- ${path}`).join("\n")}`);
  const task = sections.join("\n\n").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(parameters, key)) throw new Error(`Unresolved profile parameter: ${key}`);
    return parameters[key];
  });
  await sources.save();
  return {
    name: profile.name,
    ...(profile.category !== undefined ? { category: profile.category } : {}),
    task,
    defaults: profile.defaults,
    checks: profile.checks,
    skillPaths: profile.skills,
    skillRoots: profile.skills.map((path) => profile.skillEntries.find((entry) => entry.path === path)?.contentRoot ?? dirname(path)),
    environment,
    outputs: profile.outputs,
    manifest: {
      version: 1,
      sources: profile.sources,
      resources,
      parameters: { ...parameters },
      remoteSkills: profile.remoteSkills,
      hubSkills: profile.skillEntries.flatMap((entry) => (entry.hub ? [{ ...entry.hub, logical: entry.key }] : [])),
    },
  };
}

const builtinDirectory = fileURLToPath(new URL("../profiles/", import.meta.url));

function libraryHome(home?: string): string {
  return resolve(home ?? process.env.RALPHWORKS_HOME ?? join(homedir(), ".config", "ralphworks"));
}
function validName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid profile name: ${name}`);
}
async function locate(selector: string, options: LibraryOptions, base = options.cwd): Promise<string> {
  if (selector.startsWith("builtin:")) {
    const name = selector.slice(8);
    validName(name);
    return realpath(join(builtinDirectory, name, "profile.json"));
  }
  if (isAbsolute(selector) || selector.startsWith(".") || selector.includes("/") || selector.endsWith(".json")) {
    const path = resolve(base, selector);
    return realpath((await lstat(path)).isDirectory() ? join(path, "profile.json") : path);
  }
  validName(selector);
  for (const directory of [join(options.cwd, ".ralphworks/profiles"), join(libraryHome(options.home), "profiles"), builtinDirectory]) {
    const path = join(directory, selector, "profile.json");
    try {
      return await realpath(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  throw new Error(`Profile not found: ${selector}`);
}
async function compose(path: string, options: LibraryOptions, stack: string[] = [], sources: ProfileSkills): Promise<Composition> {
  if (stack.includes(path)) throw new Error(`Profile inheritance cycle: ${[...stack, path].join(" -> ")}`);
  if (stack.length >= 32) throw new Error("Profile inheritance exceeds 32 levels");
  const profile = validateProfile(JSON.parse(await readFile(path, "utf8")));
  const out: Composition = {
    name: profile.name,
    description: profile.description,
    prompts: [],
    skills: [],
    parameters: Object.create(null),
    defaults: {},
    artifacts: [],
    sources: [],
    skillEntries: [],
    remoteSkills: [],
    environmentLayers: [],
    outputs: [],
  };
  for (const parent of profile.extends ?? []) {
    const inherited = await compose(await locate(parent, options, dirname(path)), options, [...stack, path], sources);
    if (inherited.category !== undefined) out.category = inherited.category;
    out.prompts.push(...inherited.prompts);
    out.skills.push(...inherited.skills);
    out.skillEntries.push(...inherited.skillEntries);
    out.remoteSkills.push(...inherited.remoteSkills);
    Object.assign(out.parameters, inherited.parameters);
    Object.assign(out.defaults, inherited.defaults);
    if (inherited.checks !== undefined) out.checks = inherited.checks;
    out.artifacts.push(...inherited.artifacts);
    out.sources.push(...inherited.sources);
    out.environmentLayers.push(...inherited.environmentLayers);
    out.outputs.push(...inherited.outputs);
  }
  if (profile.category !== undefined) out.category = profile.category;
  for (const prompt of profile.prompts ?? []) out.prompts.push(await regularFile(resolve(dirname(path), prompt)));
  for (const skill of profile.skills ?? []) {
    const entry = await sources.resolve(skill, path);
    out.skills.push(entry.path);
    out.skillEntries.push(entry);
  }
  if (profile.environment) {
    const layer = { ...profile.environment };
    if (layer.extensions) {
      layer.extensions = [];
      for (const extension of profile.environment.extensions ?? []) {
        const source = resolve(dirname(path), extension);
        const info = await lstat(source);
        if (info.isSymbolicLink()) throw new Error(`Profile asset symlink is unsupported: ${source}`);
        if (info.isDirectory()) {
          const files: string[] = [];
          await skillFiles(source, files);
          layer.extensions.push(await realpath(source));
        } else layer.extensions.push(await regularFile(source));
      }
    }
    if (layer.contextFiles) {
      layer.contextFiles = [];
      for (const context of profile.environment.contextFiles ?? [])
        layer.contextFiles.push(await regularFile(resolve(dirname(path), context)));
    }
    out.environmentLayers.push(layer);
  }
  out.outputs.push(...(profile.outputs ?? []));
  out.outputs = [...new Map(out.outputs.map((output) => [output.path, output])).values()];
  Object.assign(out.parameters, profile.parameters);
  Object.assign(out.defaults, profile.defaults);
  if (profile.checks !== undefined) out.checks = profile.checks;
  out.artifacts.push(...(profile.artifacts ?? []));
  out.sources.push(path);
  out.prompts = unique(out.prompts);
  out.skillEntries = [...new Map(out.skillEntries.map((entry) => [entry.key, sources.entries.get(entry.key) ?? entry])).values()];
  out.skills = unique(out.skillEntries.map((entry) => entry.path));
  out.remoteSkills = out.skillEntries.flatMap((entry) => (entry.remote ? [entry.remote] : []));
  out.sources = unique(out.sources);
  out.artifacts = unique(out.artifacts);
  return out;
}
async function regularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Profile asset symlink is unsupported: ${path}`);
  if (!info.isFile()) throw new Error(`Profile asset must be a regular file: ${path}`);
  return realpath(path);
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))
    throw new Error(`${label} must be an array of non-empty strings`);
}
function validateProfile(value: unknown): Profile {
  const raw = object(value, "Profile");
  const allowed = [
    "version",
    "name",
    "description",
    "category",
    "extends",
    "prompts",
    "skills",
    "parameters",
    "defaults",
    "checks",
    "artifacts",
    "environment",
    "outputs",
  ];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error(`Unknown profile field: ${key}`);
  if (raw.version !== 1) throw new Error("Profile version must be 1");
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Profile name must be a non-empty string");
  if (raw.description !== undefined && typeof raw.description !== "string") throw new Error("Profile description must be a string");
  if (raw.category !== undefined && (typeof raw.category !== "string" || !raw.category.trim()))
    throw new Error("Profile category must be a non-empty string");
  for (const key of ["extends", "prompts", "checks", "artifacts"]) if (raw[key] !== undefined) strings(raw[key], key);
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) throw new Error("skills must be an array");
    for (const skill of raw.skills) {
      if (!hubReference(skill) && !remoteSkill(skill) && (typeof skill !== "string" || !skill.trim() || isAbsolute(skill)))
        throw new Error("Profile skills paths must be relative");
    }
  }
  for (const key of ["prompts"]) {
    for (const path of (raw[key] as string[] | undefined) ?? [])
      if (isAbsolute(path)) throw new Error(`Profile ${key} paths must be relative`);
  }
  for (const path of (raw.artifacts as string[] | undefined) ?? []) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("Artifact paths must be relative without parent traversal");
  }
  if (raw.parameters !== undefined) {
    for (const [key, fallback] of Object.entries(object(raw.parameters, "parameters"))) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid profile parameter: ${key}`);
      validateParameter(key, fallback);
    }
  }
  if (raw.environment !== undefined) normalizeTaskEnvironment(raw.environment);
  normalizeOutputs(raw.outputs);
  if (raw.defaults !== undefined) validateDefaults(object(raw.defaults, "defaults"));
  return raw as Profile;
}
function validateDefaults(defaults: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (key === "commit" && (value === "none" || value === "verified")) continue;
    if (key === "completionPromise" && typeof value === "string" && value.trim()) continue;
    if (key === "maxIterations" && typeof value === "number" && Number.isInteger(value) && value > 0) continue;
    if (["maxMinutes", "maxCostUsd"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) continue;
    if (key === "checkTimeoutSeconds" && typeof value === "number" && Number.isFinite(value) && value > 0) continue;
    throw new Error(`Invalid profile default: ${key}`);
  }
}
async function skillFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Profile asset symlink is unsupported: ${path}`);
    if (entry.isDirectory()) await skillFiles(path, files);
    else if (entry.isFile()) {
      if (!files.includes(path)) files.push(path);
    } else throw new Error(`Unsupported profile asset: ${path}`);
    if (files.length > 100) throw new Error("Profile resources exceed 100 files");
  }
}
async function fingerprint(profile: Composition): Promise<ProfileManifest["resources"]> {
  const environment = mergeEnvironment(profile.environmentLayers);
  const files = unique([...profile.sources, ...profile.prompts, ...environment.contextFiles]);
  for (const extension of environment.extensions) {
    const source = (await lstat(extension)).isDirectory() ? extension : dirname(extension);
    await skillFiles(source, files);
  }
  for (const root of unique(profile.skillEntries.map((entry) => entry.contentRoot ?? dirname(entry.path)))) await skillFiles(root, files);
  const resources: ProfileManifest["resources"] = [];
  let total = 0;
  for (const path of unique(files).sort()) {
    if (resources.length >= 100) throw new Error("Profile resources exceed 100 files");
    const info = await lstat(path);
    total += info.size;
    if (total > 1024 * 1024) throw new Error("Profile resources exceed 1 MiB");
    const content = await readFile(path);
    resources.push({ path, sha256: createHash("sha256").update(content).digest("hex") });
  }
  return resources;
}

// Listing reads metadata without resolving skills or requiring their upstream resources.
async function profileCategory(path: string, profile: Profile, options: LibraryOptions, stack: string[] = []): Promise<string | undefined> {
  if (stack.includes(path)) throw new Error(`Profile inheritance cycle: ${[...stack, path].join(" -> ")}`);
  if (stack.length >= 32) throw new Error("Profile inheritance exceeds 32 levels");
  let category: string | undefined;
  for (const parent of profile.extends ?? []) {
    const parentPath = await locate(parent, options, dirname(path));
    const inherited = await profileCategory(parentPath, validateProfile(JSON.parse(await readFile(parentPath, "utf8"))), options, [
      ...stack,
      path,
    ]);
    if (inherited !== undefined) category = inherited;
  }
  return profile.category ?? category;
}

export async function listProfiles(
  options: LibraryOptions,
): Promise<{ name: string; description?: string; category?: string; source: string }[]> {
  const entries = new Map<string, { name: string; description?: string; category?: string; source: string }>();
  for (const directory of [builtinDirectory, join(libraryHome(options.home), "profiles"), join(options.cwd, ".ralphworks/profiles")]) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const name of names.sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
      if (!(await lstat(join(directory, name))).isDirectory()) continue;
      const source = join(directory, name, "profile.json");
      let text: string;
      try {
        text = await readFile(source, "utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const profile = validateProfile(JSON.parse(text));
      const category = await profileCategory(source, profile, options);
      entries.set(name, { name, description: profile.description, ...(category !== undefined ? { category } : {}), source });
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function collectProfile(source: string, destName: string, options: LibraryOptions): Promise<string> {
  validName(destName);
  const sourcePath = await locate(source, options);
  const sources = new ProfileSkills(sourcePath, { ...options, home: libraryHome(options.home) });
  const profile = await compose(sourcePath, options, [], sources);
  await fingerprint(profile);
  const destination = join(libraryHome(options.home), "profiles", destName);
  // Reserve the destination before copying; failed collections never leave partial bundles.
  await mkdir(destination, { recursive: false }).catch(async (error: unknown) => {
    if (isMissing(error)) {
      await mkdir(dirname(destination), { recursive: true });
      await mkdir(destination);
    } else throw error;
  });
  try {
    const prompts: string[] = [];
    const skills: SkillDeclaration[] = [];
    const collectedPins: Record<string, HubPin> = Object.create(null);
    for (const [index, path] of profile.prompts.entries()) {
      const target = `prompts/${index}.md`;
      await mkdir(join(destination, "prompts"), { recursive: true });
      await copyFile(path, join(destination, target));
      prompts.push(target);
    }
    for (const [index, entry] of profile.skillEntries.entries()) {
      const { path, remote } = entry;
      const archived = (await sources.portable([entry], "personal"))[entry.key];
      if (hubReference(entry.declaration)) {
        skills.push(entry.declaration);
        collectedPins[skillKey(entry.declaration, join(destination, "profile.json"), join(destination, "profile.json"))] = archived;
        continue;
      }
      if (remote) {
        const { source, path: skillPath, ref, autoUpdate, entrypoint } = remote;
        const declaration = {
          source,
          path: skillPath,
          ref,
          ...(entrypoint ? { entrypoint } : {}),
          ...(autoUpdate !== undefined ? { autoUpdate } : {}),
        };
        skills.push(declaration);
        collectedPins[skillKey(declaration, join(destination, "profile.json"), join(destination, "profile.json"))] = archived;
        continue;
      }
      const target = `skills/${index}`;
      const files: string[] = [];
      const sourceRoot = entry.contentRoot ?? dirname(path);
      await skillFiles(sourceRoot, files);
      for (const file of files) {
        const to = join(destination, target, relative(sourceRoot, file));
        await mkdir(dirname(to), { recursive: true });
        await copyFile(file, to);
      }
      const declaration = `${target}/${relative(sourceRoot, path)}`;
      skills.push(declaration);
      collectedPins[skillKey(declaration, join(destination, "profile.json"), join(destination, "profile.json"))] = archived;
    }
    const environment = mergeEnvironment(profile.environmentLayers);
    const extensions: string[] = [];
    for (const [index, extension] of environment.extensions.entries()) {
      const directory = (await lstat(extension)).isDirectory() ? extension : dirname(extension);
      const target = `extensions/${index}`;
      const files: string[] = [];
      await skillFiles(directory, files);
      for (const file of files) {
        const to = join(destination, target, relative(directory, file));
        await mkdir(dirname(to), { recursive: true });
        await copyFile(file, to);
      }
      extensions.push((await lstat(extension)).isDirectory() ? target : `${target}/${basename(extension)}`);
    }
    const contextFiles: string[] = [];
    for (const [index, context] of environment.contextFiles.entries()) {
      const target = `context/${index}-${basename(context)}`;
      await mkdir(dirname(join(destination, target)), { recursive: true });
      await copyFile(context, join(destination, target));
      contextFiles.push(target);
    }
    const flattened: Profile = {
      version: 1,
      name: destName,
      description: profile.description,
      ...(profile.category !== undefined ? { category: profile.category } : {}),
      prompts,
      skills,
      parameters: profile.parameters,
      defaults: profile.defaults,
      checks: profile.checks,
      artifacts: profile.artifacts,
      environment: { ...environment, extensions, contextFiles },
      outputs: profile.outputs,
    };
    await writeFile(join(destination, "profile.json.tmp"), `${JSON.stringify(flattened, null, 2)}\n`);
    await rename(join(destination, "profile.json.tmp"), join(destination, "profile.json"));
    await sources.legacy.save(await realpath(join(destination, "profile.json")));
    await sources.saveLock(collectedPins, join(destination, "profile.json"));
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function removeCollectedProfile(name: string, options: { home?: string } = {}): Promise<void> {
  validName(name);
  const path = join(libraryHome(options.home), "profiles", name);
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`Profile symlink is unsupported: ${path}`);
  await rm(path, { recursive: true });
}
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function mergeEnvironment(layers: Partial<TaskEnvironment>[]): TaskEnvironment {
  const out = normalizeTaskEnvironment(undefined);
  for (const layer of layers) {
    if (layer.resourceInheritance !== undefined) out.resourceInheritance = layer.resourceInheritance;
    if (layer.tools !== undefined) out.tools = [...layer.tools];
    out.extensions = unique([...out.extensions, ...(layer.extensions ?? [])]);
    out.contextFiles = unique([...out.contextFiles, ...(layer.contextFiles ?? [])]);
    out.mcp = { ...out.mcp, ...layer.mcp };
    out.requires.commands = unique([...out.requires.commands, ...(layer.requires?.commands ?? [])]);
    out.requires.env = unique([...out.requires.env, ...(layer.requires?.env ?? [])]);
  }
  return out;
}

function validateParameter(key: string, value: unknown): void {
  if (value === null || typeof value === "string") return;
  const raw = object(value, `parameter ${key}`);
  if (Object.keys(raw).some((field) => !["type", "default", "required", "enum"].includes(field)))
    throw new Error(`Invalid profile parameter: ${key}`);
  if (!["string", "number", "boolean"].includes(raw.type as string)) throw new Error(`Invalid profile parameter type: ${key}`);
  if (raw.required !== undefined && typeof raw.required !== "boolean") throw new Error(`Invalid parameter required: ${key}`);
  if (raw.default === undefined && raw.required !== true) throw new Error(`Parameter ${key} needs a default or required: true`);
  if (raw.default !== undefined && (typeof raw.default !== raw.type || (typeof raw.default === "number" && !Number.isFinite(raw.default))))
    throw new Error(`Invalid parameter default: ${key}`);
  if (raw.enum !== undefined) {
    if (
      !Array.isArray(raw.enum) ||
      raw.enum.length === 0 ||
      raw.enum.some((entry) => typeof entry !== raw.type || (typeof entry === "number" && !Number.isFinite(entry)))
    )
      throw new Error(`Invalid parameter enum: ${key}`);
    if (raw.default !== undefined && !raw.enum.includes(raw.default)) throw new Error(`Parameter default is outside enum: ${key}`);
  }
}
function resolveParameter(key: string, declaration: Parameter, supplied?: string): string {
  if (declaration === null || typeof declaration === "string") {
    const value = supplied ?? declaration;
    if (value === null) throw new Error(`Required profile parameter: ${key}`);
    return value;
  }
  let value: string | number | boolean | undefined = supplied ?? declaration.default;
  if (value === undefined) throw new Error(`Required profile parameter: ${key}`);
  if (supplied !== undefined && declaration.type === "number") {
    if (!supplied.trim() || !Number.isFinite(Number(supplied))) throw new Error(`Parameter ${key} must be a number`);
    value = Number(supplied);
  }
  if (supplied !== undefined && declaration.type === "boolean") {
    if (supplied !== "true" && supplied !== "false") throw new Error(`Parameter ${key} must be true or false`);
    value = supplied === "true";
  }
  if (declaration.enum && !declaration.enum.includes(value)) throw new Error(`Parameter ${key} is outside enum`);
  return String(value);
}

export async function updateProfileSkills(selector: string, options: LibraryOptions): Promise<SkillUpdate[]> {
  const path = await locate(selector, options);
  if (path.startsWith(builtinDirectory)) throw new Error("Built-in profiles are immutable; collect them before updating");
  const sources = new ProfileSkills(path, { ...options, home: libraryHome(options.home) }, "all");
  const profile = await compose(path, options, [], sources);
  await fingerprint(profile);
  await sources.save();
  return sources.legacy.updates;
}

export async function vendorProfileSkills(selector: string, options: LibraryOptions): Promise<string> {
  const path = await locate(selector, options);
  if (path.startsWith(builtinDirectory)) throw new Error("Built-in profiles are immutable; collect them before vendoring");
  const sources = new ProfileSkills(path, { ...options, home: libraryHome(options.home) });
  const profile = await compose(path, options, [], sources);
  await fingerprint(profile);
  await sources.saveLock(await sources.portable(profile.skillEntries, "project"));
  return profileLockPath(path);
}
