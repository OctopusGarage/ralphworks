#!/usr/bin/env bash
set -euo pipefail

target_repo="${RALPHWORKS_SMOKE_TARGET_REPO:?Set RALPHWORKS_SMOKE_TARGET_REPO to a configured GitHub repository}"
[[ "$target_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid target repository" >&2; exit 2; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/ralphworks-remote-smoke.XXXXXX")"
smoke_branch="ralphworks/smoke-$(date +%s)-$$"
branch_pushed=0

cleanup() {
  if [ "$branch_pushed" = 1 ]; then
    git -C "$smoke_dir/repo" -c credential.helper='!gh auth git-credential' push origin ":refs/heads/$smoke_branch" || true
  fi
  rm -rf -- "$smoke_dir"
}
trap cleanup EXIT

pnpm --dir "$repo_root" build >/dev/null
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' clone --depth 1 "https://github.com/$target_repo.git" "$smoke_dir/repo" >/dev/null
test -f "$smoke_dir/repo/.github/workflows/ralphworks.yml" || { echo "Target repository has no RalphWorks workflow" >&2; exit 1; }
git -C "$smoke_dir/repo" switch -q -c "$smoke_branch"
git -C "$smoke_dir/repo" config user.name 'RalphWorks Smoke'
git -C "$smoke_dir/repo" config user.email 'smoke@example.invalid'
cat > "$smoke_dir/repo/ralphworks-smoke.yaml" <<'TASK'
name: remote-smoke
task: |
  Create ralphworks-smoke-output.txt containing exactly ralph-smoke-ok followed by a newline.
  Do not change other tracked files. Report completion only after the file is correct.
max_iterations: 3
max_minutes: 5
max_cost_usd: 0.5
commit: verified
checks:
  - test "$(cat ralphworks-smoke-output.txt 2>/dev/null)" = ralph-smoke-ok
TASK
git -C "$smoke_dir/repo" add ralphworks-smoke.yaml
git -C "$smoke_dir/repo" -c commit.gpgsign=false commit -qm 'test: prepare RalphWorks remote smoke task'
baseline="$(git -C "$smoke_dir/repo" rev-parse HEAD)"
git -C "$smoke_dir/repo" -c credential.helper='!gh auth git-credential' push origin "HEAD:refs/heads/$smoke_branch"
branch_pushed=1

(cd "$smoke_dir/repo" && node "$repo_root/dist/cli.js" remote ralphworks-smoke.yaml --repo "$target_repo" --ref "$smoke_branch")

SMOKE_DIR="$smoke_dir/repo" SMOKE_BASELINE="$baseline" node <<'NODE'
const { readFileSync, readdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const cwd = process.env.SMOKE_DIR;
const runs = readdirSync(join(cwd, '.ralph', 'remote'));
if (runs.length !== 1) throw new Error(`Expected one downloaded run, got ${runs.length}`);
const artifact = join(cwd, '.ralph', 'remote', runs[0]);
const result = JSON.parse(readFileSync(join(artifact, 'runs', readdirSync(join(artifact, 'runs'))[0], 'result.json'), 'utf8'));
if (result.status !== 'completed') throw new Error(`Remote task status: ${result.status}: ${result.reason ?? ''}`);
const patch = readFileSync(join(artifact, 'export', 'change.patch'), 'utf8');
if (!patch.includes('ralphworks-smoke-output.txt') || !patch.includes('+ralph-smoke-ok')) throw new Error('Expected smoke patch');
if (execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.SMOKE_BASELINE) {
  throw new Error('Remote run changed the source branch');
}
console.log('smoke=remote/completed');
NODE
