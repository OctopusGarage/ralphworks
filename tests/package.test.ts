import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package publishes compiled JavaScript CLI bins", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(pkg.bin, {
    ralph: "./dist/cli.js",
    ralphworks: "./dist/cli.js",
  });
  assert.deepEqual(pkg.files, [
    "dist/",
    "examples/",
    "profiles/",
    "skills/",
    "docs/ARCHITECTURE.md",
    "docs/ISSUE_WORKFLOWS.md",
    "docs/USAGE.md",
    "docs/TASK_PROFILES.md",
    "docs/TASK_PROFILE_EVALUATION.md",
    "docs/CAPABILITY_PROFILES.md",
    "docs/assets/ralphworks-overview.svg",
  ]);
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.build.json");
  assert.equal(pkg.scripts.prepack, "pnpm build");
});
