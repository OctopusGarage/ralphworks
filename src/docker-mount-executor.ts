import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { checksEnv, jobOptionsEnv, modelEnv, piAgentEnv, piAgentMount, providerEnv } from "./docker-env.ts";
import type { JobOverrides, ModelRef } from "./run-args.ts";

const execFileAsync = promisify(execFile);

export type DockerMountResult = {
  status: "completed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunCommand = (file: string, args: string[]) => Promise<CommandResult>;

export type DockerMountOptions = {
  cwd: string;
  jobPath: string;
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
};

export async function runDockerMountJob(options: DockerMountOptions): Promise<DockerMountResult> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const result = await runCommand("docker", dockerMountArgs(options));
  return {
    status: result.exitCode === 0 ? "completed" : "failed",
    ...result,
  };
}

function dockerMountArgs(options: DockerMountOptions): string[] {
  return [
    "run",
    "--rm",
    "--entrypoint",
    "bash",
    "--user",
    "root",
    "-v",
    `${options.cwd}:/workspace`,
    ...linkedWorktreeGitMount(options.cwd),
    "--tmpfs",
    "/workspace/node_modules:rw,exec",
    ...piAgentMount(options.piAgentDir),
    "-e",
    `RALPH_JOB=${options.jobPath}`,
    "-e",
    `RALPH_RUNNER=${options.runner}`,
    "-e",
    "RALPHWORKS_UNATTENDED=1",
    ...modelEnv(options.modelRef),
    ...checksEnv(options.checks),
    ...jobOptionsEnv(options.contexts, options.jobOverrides),
    ...piAgentEnv(options.piAgentDir),
    ...providerEnv(options.env ?? process.env, options.passEnv),
    options.image ?? "ralphworks-sandbox:latest",
    "-c",
    dockerMountScript(),
  ];
}

function linkedWorktreeGitMount(cwd: string): string[] {
  try {
    if (!statSync(join(cwd, ".git")).isFile()) return [];
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    return ["-v", `${commonDir}:${commonDir}`];
  } catch {
    return [];
  }
}

function dockerMountScript(): string {
  return [
    "set -euo pipefail",
    "WORKSPACE_UID=$(stat -c %u /workspace)",
    'if [ "$WORKSPACE_UID" -ne 0 ] && [ "$WORKSPACE_UID" -ne "$(id -u agent)" ]; then usermod --non-unique --uid "$WORKSPACE_UID" agent; fi',
    "chown agent:node /workspace/node_modules",
    "su agent -s /bin/bash -c '",
    "set -euo pipefail",
    "cd /workspace",
    "git config --global --add safe.directory /workspace",
    'git config --global user.name "ralphworks[bot]"',
    'git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"',
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
    'ralphworks run "$RALPH_JOB" --runner "$RALPH_RUNNER" --executor host',
    "'",
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
