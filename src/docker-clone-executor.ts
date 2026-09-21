import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { checksEnv, jobOptionsEnv, modelEnv, piAgentEnv, piAgentMount, providerEnv } from "./docker-env.ts";
import type { JobOverrides, ModelRef } from "./run-args.ts";

const execFileAsync = promisify(execFile);

export type DockerCloneResult = {
  status: "completed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  outputDir: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RunCommand = (file: string, args: string[]) => Promise<CommandResult>;

export type DockerCloneOptions = {
  jobPath: string;
  repo: string;
  ref: string;
  runner: "dry-run" | "pi";
  modelRef?: ModelRef;
  piAgentDir?: string;
  passEnv?: string[];
  checks?: string[];
  contexts?: string[];
  jobOverrides?: JobOverrides;
  env?: NodeJS.ProcessEnv;
  image?: string;
  runCommand?: RunCommand;
  outputDir?: string;
};

export async function runDockerCloneJob(options: DockerCloneOptions): Promise<DockerCloneResult> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const outputDir = options.outputDir ?? join(process.cwd(), ".ralph", "exports", `${Date.now()}-${process.pid}`);
  await mkdir(outputDir, { recursive: true });
  const result = await runCommand("docker", dockerCloneArgs(options, outputDir));
  return {
    status: result.exitCode === 0 ? "completed" : "failed",
    ...result,
    outputDir,
  };
}

function dockerCloneArgs(options: DockerCloneOptions, outputDir: string): string[] {
  return [
    "run",
    "--rm",
    "--entrypoint",
    "bash",
    "-v",
    `${outputDir}:/output`,
    ...piAgentMount(options.piAgentDir),
    "-e",
    `RALPH_REPO=${options.repo}`,
    "-e",
    `RALPH_REF=${options.ref}`,
    "-e",
    `RALPH_JOB=${options.jobPath}`,
    "-e",
    `RALPH_RUNNER=${options.runner}`,
    "-e",
    "RALPHWORKS_UNATTENDED=1",
    ...((options.env ?? process.env).GH_TOKEN ? ["-e", "GH_TOKEN"] : []),
    ...modelEnv(options.modelRef),
    ...checksEnv(options.checks),
    ...jobOptionsEnv(options.contexts, options.jobOverrides),
    ...piAgentEnv(options.piAgentDir),
    ...providerEnv(options.env ?? process.env, options.passEnv),
    options.image ?? "ralphworks-sandbox:latest",
    "-c",
    dockerCloneScript(),
  ];
}

function dockerCloneScript(): string {
  return [
    "set -euo pipefail",
    "rm -rf /home/agent/workspace",
    'if [ -n "${GH_TOKEN:-}" ]; then',
    '  gh repo clone "$RALPH_REPO" /home/agent/workspace -- --branch "$RALPH_REF" --single-branch',
    "else",
    '  git clone --branch "$RALPH_REF" --single-branch "https://github.com/$RALPH_REPO.git" /home/agent/workspace',
    "fi",
    "unset GH_TOKEN",
    "cd /home/agent/workspace",
    "git config user.name 'ralphworks[bot]'",
    "git config user.email '41898282+github-actions[bot]@users.noreply.github.com'",
    'RALPH_BASE=$(git rev-parse HEAD)',
    "corepack enable || true",
    "if [ -f pnpm-lock.yaml ]; then",
    "  pnpm install --frozen-lockfile",
    "elif [ -f package-lock.json ]; then",
    "  npm ci",
    "elif [ -f yarn.lock ]; then",
    "  yarn install --frozen-lockfile",
    "elif [ -f package.json ]; then",
    "  npm install",
    "fi",
    "set +e",
    'ralphworks run "$RALPH_JOB" --runner "$RALPH_RUNNER" --executor host',
    "RALPH_EXIT=$?",
    "set -e",
    "git add -N --all",
    'git diff --binary "$RALPH_BASE" -- . ":!.ralph" > /output/change.patch',
    'if [ -f .ralph/current ]; then RALPH_RUN_DIR=$(cat .ralph/current); case "$RALPH_RUN_DIR" in /*) ;; *) RALPH_RUN_DIR=".ralph/$RALPH_RUN_DIR";; esac; cp "$RALPH_RUN_DIR/result.json" /output/result.json; cp "$RALPH_RUN_DIR/events.jsonl" /output/events.jsonl; fi',
    'exit "$RALPH_EXIT"',
  ].join("\n");
}

async function defaultRunCommand(file: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 1024 * 1024 * 10 });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: exitCode(error),
      stdout: output(error, "stdout"),
      stderr: output(error, "stderr"),
    };
  }
}

function exitCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "number") {
    return error.code;
  }
  return 1;
}

function output(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return "";
  }
  const value = (error as Record<"stdout" | "stderr", unknown>)[key];
  return typeof value === "string" ? value : "";
}
