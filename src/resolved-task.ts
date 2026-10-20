import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadJob, prepareJob, type RalphJob } from "./job.ts";
import type { JobOverrides } from "./run-args.ts";
import { normalizeTaskEnvironment, type OutputRequirement, type TaskEnvironment } from "./task-environment.ts";
import { type ResolvedTaskProfile, resolveTaskProfile } from "./task-profile.ts";

export type ResolvedTask = {
  job: RalphJob;
  profile?: ResolvedTaskProfile;
  skillPaths: string[];
  skillRoots?: string[];
  environment?: TaskEnvironment;
  outputs?: OutputRequirement[];
  runtime?: Record<string, unknown>;
};
export type TaskOptions = {
  cwd: string;
  autoUpdateSkills?: boolean;
  profile?: string;
  defaultProfile?: string;
  params?: Record<string, string>;
  checks?: string[];
  contexts?: string[];
  jobOverrides?: JobOverrides;
};

export async function resolveTask(target: string, options: TaskOptions): Promise<ResolvedTask> {
  const absolute = resolve(options.cwd, target);
  const exists = await stat(absolute).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  let job = await loadJob(exists ? absolute : target);
  const selector = options.profile ?? job.profile ?? options.defaultProfile;
  const profile = selector
    ? await resolveTaskProfile(selector, {
        cwd: options.cwd,
        params: options.params,
        updateSkills: options.autoUpdateSkills ? "auto" : undefined,
      })
    : undefined;
  if (!profile && Object.keys(options.params ?? {}).length) throw new Error("--param requires a task profile");
  if (profile) {
    const provided = new Set(job.providedFields ?? []);
    const fields = {
      maxIterations: "max_iterations",
      maxMinutes: "max_minutes",
      maxCostUsd: "max_cost_usd",
      checkTimeoutSeconds: "check_timeout_seconds",
      commit: "commit",
      completionPromise: "completion_promise",
    } as const;
    const defaults = Object.fromEntries(
      Object.entries(profile.defaults).filter(([key]) => !provided.has(fields[key as keyof typeof fields])),
    );
    job = { ...job, ...defaults, ...(provided.has("checks") || profile.checks === undefined ? {} : { checks: profile.checks }) };
  }
  job = { ...job, ...options.jobOverrides, ...(options.checks ? { checks: options.checks } : {}) };
  const resourceIdentity = profile
    ? createHash("sha256")
        .update(JSON.stringify(profile.manifest.resources.map((resource) => resource.sha256).sort()))
        .digest("hex")
    : "";
  const instructions = profile
    ? `${profile.task}\n\nOutput requirements:\n${profile.outputs.map((output) => `${output.path} (${output.format ?? "text"}; ${output.required === false ? "optional" : "required"})`).join("\n")}\n\nProfile: ${profile.name}\nResource fingerprint: ${resourceIdentity}`
    : undefined;
  let identityInstructions = instructions;
  for (const [index, path] of (profile?.skillPaths ?? []).entries())
    identityInstructions = identityInstructions?.split(dirname(path)).join(`skill:${index}`);
  job = await prepareJob(job, options.cwd, options.contexts ?? [], instructions, identityInstructions);
  return {
    job,
    ...(profile ? { profile } : {}),
    skillPaths: profile?.skillPaths ?? [],
    ...(profile?.skillRoots ? { skillRoots: profile.skillRoots } : {}),
    environment: profile?.environment ?? normalizeTaskEnvironment(undefined),
    outputs: profile?.outputs ?? [],
  };
}

export async function stageTaskSkills(task: ResolvedTask, cwd: string): Promise<ResolvedTask> {
  const environment = task.environment ?? task.profile?.environment;
  if (!task.skillPaths.length && !environment?.extensions.length && !environment?.contextFiles.length) return task;
  const root = join(cwd, ".ralph", "inputs", randomUUID(), "skills");
  const mappings: [string, string][] = [];
  const stagedSkills: string[] = [];
  const stagedRoots: string[] = [];
  for (const [index, path] of task.skillPaths.entries()) {
    const source = task.skillRoots?.[index] ?? task.profile?.skillRoots?.[index] ?? dirname(path);
    const destination = join(root, String(index));
    for (const resource of task.profile?.manifest.resources ?? []) {
      const suffix = relative(source, resource.path);
      if (suffix.startsWith("../") || suffix === "..") continue;
      const content = await readFile(resource.path);
      if (createHash("sha256").update(content).digest("hex") !== resource.sha256)
        throw new Error(`Profile resource changed during preparation: ${resource.path}`);
      const target = join(destination, suffix);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { mode: (await stat(resource.path)).mode });
    }
    mappings.push([path, join(destination, relative(source, path))]);
    stagedSkills.push(join(destination, relative(source, path)));
    stagedRoots.push(destination);
  }
  for (const [index, path] of (environment?.extensions ?? []).entries()) {
    const info = await stat(path);
    const source = info.isDirectory() ? path : dirname(path);
    const destination = join(root, "..", "extensions", String(index));
    for (const resource of task.profile?.manifest.resources ?? []) {
      const suffix = relative(source, resource.path);
      if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) continue;
      const content = await readFile(resource.path);
      if (createHash("sha256").update(content).digest("hex") !== resource.sha256)
        throw new Error(`Profile resource changed during preparation: ${resource.path}`);
      const target = join(destination, suffix);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { mode: (await stat(resource.path)).mode });
    }
    mappings.push([source, destination]);
  }
  // Context files are inert text: stage each file without copying unrelated sibling files.
  for (const [index, path] of (environment?.contextFiles ?? []).entries()) {
    const destination = join(root, "..", "context", `${index}.md`);
    const content = await readFile(path);
    const fingerprint = task.profile?.manifest.resources.find((resource) => resource.path === path);
    if (!fingerprint || createHash("sha256").update(content).digest("hex") !== fingerprint.sha256)
      throw new Error(`Profile resource changed during preparation: ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    mappings.push([path, destination]);
  }
  const staged = remapTaskPaths(task, mappings);
  return {
    ...staged,
    skillPaths: stagedSkills,
    skillRoots: stagedRoots,
    ...(staged.profile ? { profile: { ...staged.profile, skillPaths: stagedSkills, skillRoots: stagedRoots } } : {}),
  };
}

export function remapTaskPaths(task: ResolvedTask, mappings: [string, string][]): ResolvedTask {
  const replace = (value: string): string => {
    for (const [source, destination] of [...mappings].sort((a, b) => b[0].length - a[0].length))
      value = value.split(source).join(destination);
    return value;
  };
  const remapEnvironment = (environment: TaskEnvironment): TaskEnvironment => ({
    ...environment,
    extensions: environment.extensions.map(replace),
    contextFiles: environment.contextFiles.map(replace),
  });
  return {
    ...task,
    ...(task.environment ? { environment: remapEnvironment(task.environment) } : {}),
    job: { ...task.job, task: replace(task.job.task) },
    skillPaths: task.skillPaths.map(replace),
    ...(task.skillRoots ? { skillRoots: task.skillRoots.map(replace) } : {}),
    ...(task.profile
      ? {
          profile: {
            ...task.profile,
            task: replace(task.profile.task),
            skillPaths: task.profile.skillPaths.map(replace),
            ...(task.profile.skillRoots ? { skillRoots: task.profile.skillRoots.map(replace) } : {}),
            environment: remapEnvironment(task.profile.environment),
          },
        }
      : {}),
  };
}
