#!/usr/bin/env bash
set -euo pipefail

mode="${1:-host}"
case "$mode" in
  host|docker|docker-clone|docker-timeout) ;;
  *) echo "Usage: scripts/smoke.sh [host|docker|docker-clone|docker-timeout]" >&2; exit 2 ;;
esac

runner="${RALPHWORKS_SMOKE_RUNNER:-pi}"
case "$runner" in
  pi|dry-run) ;;
  *) echo "RALPHWORKS_SMOKE_RUNNER must be pi or dry-run" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/ralphworks-smoke.XXXXXX")"
trap 'rm -rf -- "$smoke_dir"' EXIT

pnpm --dir "$repo_root" build >/dev/null
if [ "$mode" != host ]; then
  docker build -q -f "$repo_root/docker/ralphworks-sandbox.Dockerfile" -t ralphworks-sandbox:latest "$repo_root" >/dev/null
fi

if [ "$mode" = docker-timeout ]; then
  (cd "$repo_root" && node --input-type=module <<'NODE'
import { runDockerContainer } from './dist/docker-command.js';
const result = await runDockerContainer(['run', '--rm', '--entrypoint', 'bash', 'ralphworks-sandbox:latest', '-c', 'sleep 30'], 0.02);
if (!result.timedOut || result.exitCode !== 124 || !result.stderr.includes('exceeded 0.02 minutes')) {
  throw new Error(`Expected a bounded Docker timeout, got ${JSON.stringify(result)}`);
}
console.log('smoke=docker/outer-timeout');
NODE
  )
  if [ -n "$(docker ps -a --filter name=ralphworks- --format '{{.Names}}')" ]; then
    echo 'Timed-out RalphWorks container was not removed' >&2
    exit 1
  fi
  exit 0
fi

if [ "$mode" = docker-clone ]; then
  task_path='scripts/smoke-task.md'
  source_repo="${RALPHWORKS_SMOKE_REPO:-OctopusGarage/ralphworks}"
  source_ref="${RALPHWORKS_SMOKE_REF:-main}"
  baseline=''
else
  git -C "$smoke_dir" init -q
  git -C "$smoke_dir" config user.name 'RalphWorks Smoke'
  git -C "$smoke_dir" config user.email 'smoke@example.invalid'
  printf '.ralph/\n' > "$smoke_dir/.gitignore"
  cp "$repo_root/scripts/smoke-task.md" "$smoke_dir/task.md"
  git -C "$smoke_dir" add .gitignore task.md
  git -C "$smoke_dir" commit -qm 'test: prepare RalphWorks smoke task'
  baseline="$(git -C "$smoke_dir" rev-parse HEAD)"
  task_path='task.md'
fi

args=(run "$task_path" --runner "$runner" --executor "$mode" --max-iterations 3 --max-minutes 5)
if [ "$mode" = docker-clone ]; then args+=(--repo "$source_repo" --ref "$source_ref"); fi
if [ "$runner" = pi ]; then
  args+=(--check 'test "$(cat ralphworks-smoke-output.txt 2>/dev/null)" = ralph-smoke-ok' --commit verified --max-cost-usd 0.5)
  pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  args+=(--pi-agent-dir "$pi_dir")
  if [ -n "${RALPHWORKS_SMOKE_MODEL:-}" ]; then args+=(--model "$RALPHWORKS_SMOKE_MODEL"); fi
else
  args+=(--max-iterations 1)
fi

if [ "$runner" = dry-run ]; then
  if (cd "$smoke_dir" && node "$repo_root/dist/cli.js" "${args[@]}"); then
    echo "Dry-run unexpectedly reported completion" >&2
    exit 1
  fi
else
  (cd "$smoke_dir" && node "$repo_root/dist/cli.js" "${args[@]}")
fi

SMOKE_DIR="$smoke_dir" SMOKE_RUNNER="$runner" SMOKE_BASELINE="$baseline" SMOKE_MODE="$mode" node <<'NODE'
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const cwd = process.env.SMOKE_DIR;
const clone = process.env.SMOKE_MODE === 'docker-clone';
const resultPath = clone
  ? join(cwd, '.ralph', 'exports', readdirSync(join(cwd, '.ralph', 'exports'))[0], 'result.json')
  : join(cwd, '.ralph', readFileSync(join(cwd, '.ralph', 'current'), 'utf8').trim(), 'result.json');
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const expected = process.env.SMOKE_RUNNER === 'pi' ? 'completed' : 'max_iterations';
if (result.status !== expected) throw new Error(`Expected ${expected}, got ${result.status}: ${result.reason ?? ''}`);
if (expected === 'completed') {
  if (clone) {
    const patch = readFileSync(join(cwd, '.ralph', 'exports', readdirSync(join(cwd, '.ralph', 'exports'))[0], 'change.patch'), 'utf8');
    if (!patch.includes('ralphworks-smoke-output.txt') || !patch.includes('+ralph-smoke-ok')) throw new Error('Expected smoke patch');
  } else {
    if (readFileSync(join(cwd, 'ralphworks-smoke-output.txt'), 'utf8') !== 'ralph-smoke-ok\n') throw new Error('Unexpected smoke output');
    if (execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === process.env.SMOKE_BASELINE) {
    throw new Error('Verified commit was not created');
    }
  }
}
console.log(`smoke=${process.env.SMOKE_RUNNER}/${expected}`);
NODE
