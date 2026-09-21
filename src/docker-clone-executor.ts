import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { type RunCommand, runDockerContainer } from "./docker-command.ts";
import { checksEnv, jobOptionsEnv, modelEnv, piAgentEnv, piAgentMount, providerEnv } from "./docker-env.ts";
import type { JobOverrides, ModelRef } from "./run-args.ts";

export type DockerCloneResult = {
  status: "completed" | "failed" | "timed_out";
  exitCode: number;
  stdout: string;
  stderr: string;
  outputDir: string;
};

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
  totalMinutes?: number;
};

export async function runDockerCloneJob(options: DockerCloneOptions): Promise<DockerCloneResult> {
  const outputDir = options.outputDir ?? join(process.cwd(), ".ralph", "exports", `${Date.now()}-${process.pid}`);
  await mkdir(outputDir, { recursive: true });
  const result = await runDockerContainer(dockerCloneArgs(options, outputDir), options.totalMinutes, options.runCommand);
  return {
    status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed",
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
    "--user",
    "root",
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
    "OUTPUT_UID=$(stat -c %u /output)",
    'if [ "$OUTPUT_UID" -ne 0 ] && [ "$OUTPUT_UID" -ne "$(id -u agent)" ]; then usermod --non-unique --uid "$OUTPUT_UID" agent; fi',
    "su agent -s /bin/bash <<'RALPHWORKS_SCRIPT'",
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
    "RALPH_BASE=$(git rev-parse HEAD)",
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
    "RALPHWORKS_SCRIPT",
  ].join("\n");
}
