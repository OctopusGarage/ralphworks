import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { normalizeTaskEnvironment, type TaskEnvironment } from "./task-environment.ts";

export async function createProfileResourceLoader(input: {
  cwd: string;
  piAgentDir?: string;
  skillPaths: string[];
  environment?: TaskEnvironment;
}) {
  const { DefaultResourceLoader, getAgentDir, loadSkills, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const environment = input.environment ?? normalizeTaskEnvironment(undefined);
  const mode = environment.resourceInheritance;
  const agentDir = input.piAgentDir ?? getAgentDir();
  const globalSettings = await settingsText(join(agentDir, "settings.json"));
  const projectSettings = mode === "none" ? undefined : await settingsText(join(input.cwd, ".pi", "settings.json"));
  const globalModelSettings: Record<string, unknown> = {};
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"])
    if (globalSettings && Object.hasOwn(globalSettings, key)) globalModelSettings[key] = globalSettings[key];
  const storage = new Map<string, string>();
  storage.set("global", JSON.stringify(mode === "all" ? (globalSettings ?? {}) : globalModelSettings));
  storage.set("project", JSON.stringify(projectSettings ?? {}));
  const settingsManager = SettingsManager.fromStorage(
    {
      withLock(scope, fn) {
        const changed = fn(storage.get(scope));
        if (changed !== undefined) storage.set(scope, changed);
      },
    },
    { projectTrusted: mode !== "none" },
  );
  const selected = loadSkills({ cwd: input.cwd, agentDir, skillPaths: input.skillPaths, includeDefaults: false });
  if (selected.skills.length !== input.skillPaths.length)
    throw new Error(
      `Selected skills must have unique names and valid Agent Skills metadata: ${selected.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
    );
  const names = new Set(selected.skills.map((skill) => skill.name));
  const explicitContext = await Promise.all(
    environment.contextFiles.map(async (path) => ({ path, content: await readFile(path, "utf8") })),
  );
  // Disable native discovery in isolated mode. Project mode supplies its own explicit paths,
  // so the loader never executes a global extension before filtering resources.
  const projectPaths = mode === "project" ? await projectResourcePaths(input.cwd, projectSettings ?? {}) : undefined;
  const isolatedAgentDir = mode === "all" ? undefined : await mkdtemp(join(tmpdir(), "ralphworks-agent-resources-"));
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: isolatedAgentDir ?? agentDir,
    settingsManager,
    noExtensions: mode === "none",
    noSkills: mode === "none",
    noPromptTemplates: mode === "none",
    noThemes: true,
    noContextFiles: mode === "none",
    additionalSkillPaths: input.skillPaths,
    additionalExtensionPaths: environment.extensions,
    skillsOverride: (base) => ({
      skills: [
        ...selected.skills,
        ...base.skills.filter((skill) => !names.has(skill.name) && (mode !== "project" || within(input.cwd, skill.filePath))),
      ],
      diagnostics: [...selected.diagnostics, ...base.diagnostics],
    }),
    agentsFilesOverride: (base) => ({
      agentsFiles: [
        ...base.agentsFiles.filter((file) => mode === "all" || (mode === "project" && within(input.cwd, file.path))),
        ...explicitContext,
      ],
    }),
    systemPromptOverride: (base) => (mode === "none" ? undefined : mode === "project" ? projectPaths?.system : base),
    appendSystemPromptOverride: (base) => (mode === "none" ? [] : mode === "project" ? (projectPaths?.append ?? []) : base),
  });
  try {
    await loader.reload();
    const errors = loader.getExtensions().errors;
    if (errors.length) throw new Error(`Unable to load task extensions: ${errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
  } catch (error) {
    if (isolatedAgentDir) await rm(isolatedAgentDir, { recursive: true, force: true });
    throw error;
  }
  return Object.assign(loader, {
    taskSettings: settingsManager,
    release: async () => {
      await settingsManager.flush();
      if (isolatedAgentDir) await rm(isolatedAgentDir, { recursive: true, force: true });
    },
  });
}

async function settingsText(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await optionalFile(path);
  if (text === undefined) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid Pi settings: ${path}`);
  return parsed as Record<string, unknown>;
}
async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
}
async function projectResourcePaths(cwd: string, _settings: Record<string, unknown>) {
  return {
    system: await optionalFile(join(cwd, ".pi", "SYSTEM.md")),
    append: [await optionalFile(join(cwd, ".pi", "APPEND_SYSTEM.md"))].filter((text): text is string => text !== undefined),
  };
}
