import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const publishStep = workflow.split("      - name: Publish GitHub release\n")[1];
assert.ok(publishStep, "release workflow has a publish step");
const script = publishStep
  .split("        run: |\n")[1]
  ?.split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");
assert.ok(script, "publish step has a shell script");

test("release workflow requires matching versioned notes and passes them to GitHub", () => {
  const dir = mkdtempSync(join(tmpdir(), "ralphworks-release-"));
  mkdirSync(join(dir, "docs/releases"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "package.json"), '{"version":"0.1.2"}');
  writeFileSync(join(dir, "docs/releases/v0.1.2.md"), "Release notes\n");
  writeFileSync(join(dir, "bin/gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\n[ "$1" != release ] || [ "$2" != view ]\n', {
    mode: 0o755,
  });
  const calls = join(dir, "gh-calls");
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_CALLS: calls };

  const invalid = spawnSync("bash", ["-c", script], {
    cwd: dir,
    env: { ...env, GITHUB_REF_NAME: "v0.1.3" },
  });
  assert.notEqual(invalid.status, 0);
  assert.throws(() => readFileSync(calls));

  const valid = spawnSync("bash", ["-c", script], {
    cwd: dir,
    env: { ...env, GITHUB_REF_NAME: "v0.1.2" },
  });
  assert.equal(valid.status, 0, valid.stderr.toString());
  assert.match(
    readFileSync(calls, "utf8"),
    /release create v0\.1\.2 .*--title RalphWorks v0\.1\.2 --notes-file docs\/releases\/v0\.1\.2\.md --verify-tag/,
  );
});
