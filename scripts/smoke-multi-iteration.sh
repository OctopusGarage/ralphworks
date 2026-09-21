#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/ralphworks-multi-smoke.XXXXXX")"
cleanup() {
  if [ "$?" -eq 0 ]; then
    rm -rf -- "$smoke_dir"
  else
    printf 'Smoke fixture retained for inspection: %s\n' "$smoke_dir" >&2
  fi
}
trap cleanup EXIT
workspace="$smoke_dir/repo"
mkdir "$workspace"

pnpm --dir "$repo_root" build >/dev/null
git -C "$workspace" init -q
git -C "$workspace" config user.name 'RalphWorks Smoke'
git -C "$workspace" config user.email 'smoke@example.invalid'
printf '.ralph/\n' > "$workspace/.gitignore"
cat > "$workspace/task.md" <<'TASK'
# Two-step Ralph task

Goal: finish both items. Work on the highest-priority unfinished item in each iteration.

- [ ] Create first.txt containing exactly first-ready followed by a newline.
- [ ] After the independent check gives you a token, create ack.txt containing exactly that token followed by a newline.

Do not edit task.md or make Git commits. The token is supplied only by the check failure; use its feedback from the next iteration's progress. Report completion only after both items and the check are satisfied.
TASK
git -C "$workspace" add .gitignore task.md
git -C "$workspace" commit -qm 'test: prepare two-step Ralph task'
baseline="$(git -C "$workspace" rev-parse HEAD)"

cat > "$smoke_dir/check.sh" <<'CHECK'
#!/usr/bin/env bash
set -euo pipefail
token_path="$(dirname "$0")/feedback-token"
if [ ! -f "$token_path" ]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))" > "$token_path"
  printf 'Check failed: create ack.txt containing exactly %s followed by a newline.\n' "$(cat "$token_path")" >&2
  exit 17
fi
test "$(cat first.txt 2>/dev/null)" = first-ready
test "$(cat ack.txt 2>/dev/null)" = "$(cat "$token_path")"
CHECK
chmod +x "$smoke_dir/check.sh"

args=(run task.md --check "$smoke_dir/check.sh" --commit verified --max-iterations 3 --max-minutes 10 --max-cost-usd 1)
if [ -n "${RALPHWORKS_SMOKE_MODEL:-}" ]; then args+=(--model "$RALPHWORKS_SMOKE_MODEL"); fi
run_output="$(cd "$workspace" && node "$repo_root/dist/cli.js" "${args[@]}")"
printf '%s\n' "$run_output"
if [[ "$run_output" == *"failedCheck="* ]]; then
  echo 'A completed run displayed a historical failed check as its final failure' >&2
  exit 1
fi

SMOKE_WORKSPACE="$workspace" SMOKE_DIR="$smoke_dir" SMOKE_BASELINE="$baseline" node <<'NODE'
const { readFileSync, readdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const workspace = process.env.SMOKE_WORKSPACE;
const smokeDir = process.env.SMOKE_DIR;
const run = readFileSync(join(workspace, '.ralph', 'current'), 'utf8').trim();
const result = JSON.parse(readFileSync(join(workspace, '.ralph', run, 'result.json'), 'utf8'));
if (result.status !== 'completed' || result.iterations < 2) throw new Error(`Expected multi-iteration completion, got ${result.status} after ${result.iterations}`);
if (result.checks[0]?.exitCode !== 17 || result.checks.at(-1)?.exitCode !== 0) throw new Error('Expected failed check followed by a passing check');
if (!result.commits.length) throw new Error('Expected a verified commit');
const token = readFileSync(join(smokeDir, 'feedback-token'), 'utf8');
if (readFileSync(join(workspace, 'first.txt'), 'utf8') !== 'first-ready\n') throw new Error('First item is incorrect');
if (readFileSync(join(workspace, 'ack.txt'), 'utf8') !== `${token}\n`) throw new Error('Agent did not apply check feedback');
const progressDir = join(workspace, '.ralph', 'progress');
const progress = readdirSync(progressDir).map((name) => readFileSync(join(progressDir, name), 'utf8')).join('\n');
if (!progress.includes(token) || !progress.includes('Check failed:')) throw new Error('Failed check feedback was not saved in progress');
execFileSync('git', ['-C', workspace, 'diff', '--exit-code', process.env.SMOKE_BASELINE, 'HEAD', '--', 'task.md']);
if (execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Smoke workspace is not clean');
console.log(`smoke=pi/multi-iteration-completed iterations=${result.iterations} checks=${result.checks.length} commits=${result.commits.length}`);
NODE
