import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assessAudit, verifyPicomatch } from "./audit-dependencies.mjs";

const id = "GHSA-fc5q-39xc-vjpf";
const finding = {
  github_advisory_id: id,
  module_name: "picomatch",
  severity: "high",
  findings: [{ version: "4.0.7", paths: [".>tool>picomatch"] }],
};
const report = (...items) => ({
  advisories: Object.fromEntries(items.map((item, index) => [index, item])),
  metadata: { vulnerabilities: { low: 0, moderate: 0, high: items.length, critical: 0 } },
});

test("only the verified exact package, version and advisory are locally remediated", () => {
  assert.equal(assessAudit(report(finding), true).remediated.length, 1);
  assert.equal(assessAudit(report(finding), false).blocking.length, 1);
  for (const changed of [
    { github_advisory_id: "GHSA-new-advisory" },
    { module_name: "another-package" },
    { findings: [{ version: "4.0.6" }] },
    { findings: [{ version: "4.0.7" }, { version: "4.0.6" }] },
    { findings: [] },
  ]) {
    assert.equal(assessAudit(report({ ...finding, ...changed }), true).blocking.length, 1);
  }
});

test("new findings retain the configured severity threshold", () => {
  const moderate = { ...finding, github_advisory_id: "new", severity: "moderate" };
  assert.equal(assessAudit(report(finding, moderate), true).blocking.length, 1);
  assert.equal(assessAudit(report(finding, moderate), true, "high").blocking.length, 0);
  assert.equal(assessAudit(report(finding, { ...moderate, severity: "critical" }), true, "high").blocking.length, 1);
});

test("malformed, unavailable and incomplete reports fail closed", () => {
  for (const invalid of [
    null,
    {},
    { error: "registry unavailable" },
    { advisories: [] },
    { ...report(), metadata: { vulnerabilities: { high: 1 } } },
    report({ ...finding, severity: "unknown" }),
  ]) {
    assert.throws(() => assessAudit(invalid, true));
  }
  assert.equal(assessAudit(report(), true).blocking.length, 0);
});

test("installed dependency paths, source bytes and the patch must agree", () => {
  const root = resolve(import.meta.dirname, "..");
  const result = spawnSync("pnpm", ["list", "picomatch", "--depth", "Infinity", "--json"], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  verifyPicomatch(root, graph);
  assert.throws(() => verifyPicomatch(root, []), /graph/);
  assert.throws(() => verifyPicomatch(root, [{}]), /No installed/);

  const fixture = mkdtempSync(join(tmpdir(), "picomatch-remediation-"));
  try {
    for (const file of ["package.json", "pnpm-lock.yaml", "patches"]) cpSync(join(root, file), join(fixture, file), { recursive: true });
    const hash = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pnpm.patchedDependencies["picomatch@4.0.7"];
    const patch = join(fixture, hash);
    const original = readFileSync(patch);
    writeFileSync(patch, "unreviewed patch");
    assert.throws(() => verifyPicomatch(fixture, graph), /patch changed/);
    writeFileSync(patch, original);

    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const digest = /picomatch@4\.0\.7:\s+hash: (\w+)/.exec(lock)[1];
    const relative = `node_modules/.pnpm/picomatch@4.0.7_patch_hash=${digest}/node_modules/picomatch`;
    mkdirSync(join(fixture, relative, "lib"), { recursive: true });
    cpSync(join(root, relative), join(fixture, relative), { recursive: true });
    symlinkSync(join(fixture, relative), join(fixture, "node_modules/picomatch"));
    const child = { version: "4.0.7", path: join(fixture, relative) };
    const tree = [{ path: fixture, dependencies: { picomatch: child } }];
    verifyPicomatch(fixture, tree);
    // Use a fresh consumer path: Node caches module resolution within a process.
    const otherConsumer = join(fixture, "other-consumer");
    mkdirSync(join(otherConsumer, "node_modules"), { recursive: true });
    symlinkSync(join(root, relative), join(otherConsumer, "node_modules/picomatch"));
    assert.throws(() => verifyPicomatch(fixture, [{ path: otherConsumer, dependencies: { picomatch: child } }]), /Consumer resolves/);
    writeFileSync(join(fixture, relative, "lib/parse.js"), "unpatched source");
    assert.throws(() => verifyPicomatch(fixture, tree), /source does not match/);
    assert.throws(() => verifyPicomatch(fixture, [{ dependencies: { picomatch: { ...child, version: "4.0.6" } } }]), /Unreviewed/);
    assert.throws(() => verifyPicomatch(fixture, graph), /Unpatched/);
    const config = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
    delete config.pnpm.patchedDependencies;
    writeFileSync(join(fixture, "package.json"), JSON.stringify(config));
    assert.throws(() => verifyPicomatch(fixture, tree), /Missing picomatch/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
