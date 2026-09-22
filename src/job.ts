import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";

export type RalphJob = {
  name: string;
  task: string;
  promptFile?: string;
  progressFile: string;
  completionPromise?: string;
  maxIterations: number;
  maxMinutes?: number;
  maxCostUsd?: number;
  mode: "local";
  checks: string[];
  checkTimeoutSeconds: number;
  commit: "none" | "verified";
};

function defaultProgressFile(name: string, task: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task";
  const identity = createHash("sha256").update(task).digest("hex").slice(0, 12);
  return `.ralph/progress/${slug}-${identity}.md`;
}

export async function loadJob(jobPath: string): Promise<RalphJob> {
  let text: string;
  try {
    text = await readFile(jobPath, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (looksLikePath(jobPath)) throw error;
    return parseTaskFile("task", jobPath);
  }
  if (!isYamlJob(jobPath)) {
    return parseTaskFile(jobPath, text);
  }
  return parseJob(text);
}

export async function prepareJob(job: RalphJob, cwd: string, contexts: string[]): Promise<RalphJob> {
  let task = job.task;
  if (job.promptFile) task += `\n\n${await readFile(resolveInputPath(cwd, job.promptFile), "utf8")}`;
  if (contexts.length) task += await loadContexts(cwd, contexts);
  return {
    ...job,
    task,
    progressFile: job.progressFile === defaultProgressFile(job.name, job.task) ? defaultProgressFile(job.name, task) : job.progressFile,
  };
}

async function loadContexts(cwd: string, sources: string[]): Promise<string> {
  const files: string[] = [];
  for (const source of sources) {
    const absolute = resolveInputPath(cwd, source);
    const info = await stat(absolute);
    if (info.isFile()) files.push(absolute);
    else if (info.isDirectory()) await collectContextFiles(absolute, files);
    else throw new Error(`Context source must be a file or directory: ${source}`);
  }
  if (files.length > 100) throw new Error("Context sources contain more than 100 files; narrow the context paths");
  let total = 0;
  const sections: string[] = [];
  for (const file of files.sort()) {
    const content = await readFile(file);
    if (content.includes(0)) continue;
    total += content.length;
    if (total > 1024 * 1024) throw new Error("Context sources exceed 1 MiB; narrow the context paths");
    sections.push(`\n\nContext file: ${relative(cwd, file)}\n\n${content.toString("utf8")}`);
  }
  return sections.join("");
}

async function collectContextFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".ralph", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectContextFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function resolveInputPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

export function parseJob(text: string): RalphJob {
  const raw = parseSimpleYaml(text);
  const name = stringValue(raw.name, "name");
  const task = stringValue(raw.task, "task");

  return {
    name,
    task,
    promptFile: optionalStringValue(raw.prompt_file),
    progressFile: optionalStringValue(raw.progress_file) ?? defaultProgressFile(name, task),
    completionPromise: optionalStringValue(raw.completion_promise) ?? "DONE",
    maxIterations: numberValue(raw.max_iterations, "max_iterations", 5),
    maxMinutes: optionalNumberValue(raw.max_minutes),
    maxCostUsd: optionalNumberValue(raw.max_cost_usd),
    mode: modeValue(raw.mode),
    checks: listValue(raw.checks),
    checkTimeoutSeconds: positiveNumberValue(raw.check_timeout_seconds, "check_timeout_seconds") ?? 60,
    commit: commitValue(raw.commit),
  };
}

function parseTaskFile(jobPath: string, text: string): RalphJob {
  const task = text.trim();
  if (!task) {
    throw new Error("Task file must not be empty");
  }
  return {
    name: basename(jobPath, extname(jobPath)),
    task,
    progressFile: defaultProgressFile(basename(jobPath, extname(jobPath)), task),
    completionPromise: "DONE",
    maxIterations: 5,
    mode: "local",
    checks: [],
    checkTimeoutSeconds: 60,
    commit: "none",
  };
}

function isYamlJob(jobPath: string): boolean {
  const extension = extname(jobPath).toLowerCase();
  return extension === ".yaml" || extension === ".yml";
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const allowed = new Set([
    "name",
    "task",
    "prompt_file",
    "progress_file",
    "completion_promise",
    "max_iterations",
    "max_minutes",
    "max_cost_usd",
    "mode",
    "checks",
    "check_timeout_seconds",
    "commit",
  ]);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^\s/.test(line)) throw new Error(`Unsupported job line: ${line}`);

    const match = /^([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      throw new Error(`Unsupported job line: ${line}`);
    }

    const [, key, value = ""] = match;
    if (!allowed.has(key)) throw new Error(`Unknown job field: ${key}`);
    if (Object.hasOwn(out, key)) throw new Error(`Duplicate job field: ${key}`);
    if (key === "checks" && value !== "") throw new Error("Job field checks must be a list of strings");
    if (key !== "checks" && value === "") throw new Error(`Job field ${key} must have a value`);
    if (key !== "task" && value === "|") throw new Error(`Job field ${key} cannot be a block`);
    if (value === "|") {
      const block: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith("  ") || !lines[i + 1].trim())) {
        i += 1;
        block.push(lines[i].startsWith("  ") ? lines[i].slice(2) : "");
      }
      out[key] = trimTrailingBlankLines(block).join("\n");
      continue;
    }

    if (key === "checks") {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const item = /^ {2}-\s*(.*)$/.exec(next);
        if (!item) {
          break;
        }
        i += 1;
        items.push(unquote(item[1]));
      }
      out[key] = items;
      continue;
    }

    out[key] = parseScalar(value);
  }

  return out;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length && copy[copy.length - 1] === "") {
    copy.pop();
  }
  return copy;
}

function parseScalar(value: string): string | number {
  const clean = unquote(value.trim());
  if (/^-?\d+(\.\d+)?$/.test(clean)) {
    return Number(clean);
  }
  return clean;
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Job field ${name} must be a non-empty string`);
  }
  return value;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Job field ${name} must be a positive integer`);
  }
  return value;
}

function optionalNumberValue(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Optional numeric job fields must be non-negative numbers");
  }
  return value;
}

function positiveNumberValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Job field ${name} must be positive`);
  }
  return value;
}

function modeValue(value: unknown): "local" {
  if (value === undefined) {
    return "local";
  }
  if (value === "local") {
    return value;
  }
  if (value === "remote") throw new Error("Job field mode: remote is unsupported; use the remote CLI command");
  throw new Error("Job field mode must be local or remote");
}

function listValue(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Job field checks must be a list of strings");
  }
  if (value.some((item) => !item.trim())) throw new Error("Job field checks must contain non-empty commands");
  return value;
}

function commitValue(value: unknown): "none" | "verified" {
  if (value === undefined || value === "none") return "none";
  if (value === "verified") return "verified";
  throw new Error("Job field commit must be none or verified");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /^[^\s]+\.[A-Za-z0-9]+$/.test(value);
}
