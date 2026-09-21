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
    "docs/ARCHITECTURE.md",
    "docs/USAGE.md",
    "docs/assets/ralphworks-overview.svg",
  ]);
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.build.json");
  assert.equal(pkg.scripts.prepack, "pnpm build");
});
