import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { type RunCommand, runDockerContainer } from "./docker-command.ts";
import { checksEnv, jobOptionsEnv, modelEnv, piAgentEnv, piAgentMount, providerEnv } from "./docker-env.ts";
import type { JobOverrides, ModelRef } from "./run-args.ts";

export type DockerMountResult = {
  status: "completed" | "failed" | "timed_out";
  exitCode: number;
  stdout: string;
  stderr: string;
};

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
  totalMinutes?: number;
};

export async function runDockerMountJob(options: DockerMountOptions): Promise<DockerMountResult> {
  const result = await runDockerContainer(dockerMountArgs(options), options.totalMinutes, options.runCommand);
  return {
    status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed",
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
