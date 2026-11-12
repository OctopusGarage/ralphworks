import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateTaskOutputs } from "../src/task-contracts.ts";
import { resolveTaskProfile } from "../src/task-profile.ts";

const exec = promisify(execFile);
const cli = resolve("src/cli.ts");
const sha = "a".repeat(40);
const hash = "b".repeat(64);
const finding = {
  severity: "P2",
  path: "src/example.ts",
  line: 1,
  title: "Missing guard",
  trigger: "Empty input",
  consequence: "Throws",
  remedy: "Validate input",
  evidence: ["src/example.ts:1"],
};
function report() {
  return {
    schemaVersion: 1,
    revision: { baseSha: sha, headSha: sha, diffSha256: hash },
    verdict: "clean",
    reviewedScope: "Supplied diff",
    findings: [] as unknown[],
    limitations: [] as string[],
  };
}
async function invoke(value: unknown, flags: string[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-review-"));
  await writeFile(join(cwd, "CODE_REVIEW.json"), typeof value === "string" ? value : JSON.stringify(value));
  return exec("node", [cli, "review", "validate", "CODE_REVIEW.json", ...flags], { cwd });
}
async function invalid(value: unknown, flags: string[] = []) {
  await assert.rejects(invoke(value, flags), (error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /code.review|review|revision|SHA|flag|JSON|byte|file/i);
    return true;
  });
}

test("review validation emits a versioned receipt without agent execution", async () => {
  const { stdout, stderr } = await invoke(report(), ["--base-sha", sha, "--head-sha", sha, "--diff-sha256", hash]);
  assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, valid: true, verdict: "clean", findingCount: 0 });
  assert.equal(stderr, "");
});

test("all severities count as findings; incomplete reports remain valid but distinct", async () => {
  for (const severity of ["P0", "P1", "P2", "P3"]) {
    const value = { ...report(), verdict: "findings", findings: [{ ...finding, severity }] };
    assert.equal(JSON.parse((await invoke(value)).stdout).findingCount, 1);
    await invalid({ ...value, verdict: "clean" });
  }
  for (const findings of [[], [finding]])
    assert.equal(JSON.parse((await invoke({ ...report(), verdict: "incomplete", findings })).stdout).verdict, "incomplete");
  await invalid({ ...report(), verdict: "findings" });
});

test("review validation rejects malformed shapes, unsafe locations and excessive input", async () => {
  for (const value of [
    null,
    [],
    "{",
    { ...report(), extra: true },
    { ...report(), reviewedScope: " " },
    { ...report(), limitations: [""] },
    { ...report(), schemaVersion: 2 },
    { ...report(), revision: { baseSha: sha } },
  ])
    await invalid(value);
  for (const path of ["/tmp/x", "../x", "src/../x", "C:/x", "src\\x", "./x", "src//x", "x\u0000y"])
    await invalid({ ...report(), verdict: "findings", findings: [{ ...finding, path }] });
  for (const patch of [
    { line: 0 },
    { line: 1.5 },
    { severity: "critical" },
    { title: " " },
    { evidence: [] },
    { evidence: [""] },
    { unexpected: true },
  ])
    await invalid({ ...report(), verdict: "findings", findings: [{ ...finding, ...patch }] });
  await invalid(" ".repeat(1024 * 1024 + 1));
});

test("revision expectations require non-null exact facts and strict arguments", async () => {
  const unknown = { ...report(), revision: { baseSha: null, headSha: null, diffSha256: null } };
  assert.equal(JSON.parse((await invoke(unknown)).stdout).valid, true);
  await invalid(unknown, ["--base-sha", sha]);
  await invalid(report(), ["--base-sha", "c".repeat(40)]);
  await invalid(report(), ["--head-sha", sha.toUpperCase()]);
  for (const flags of [
    ["--unknown", sha],
    ["toString", sha],
    ["constructor", sha],
    ["__proto__", sha],
    ["--base-sha"],
    ["--base-sha", "bad"],
    ["--diff-sha256", sha],
    ["--base-sha", sha, "--base-sha", sha],
    ["extra.json"],
  ])
    await invalid(report(), flags);
  await invalid({ ...report(), revision: { baseSha: "bad", headSha: sha, diffSha256: hash } });
});

test("code-review profile requires structured report and limits writes to its report", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralph-review-profile-"));
  const profile = await resolveTaskProfile("builtin:code-review", { cwd, home: join(cwd, "home") });
  assert.deepEqual(profile.outputs, [{ path: "CODE_REVIEW.json", format: "json", required: true }]);
  assert.deepEqual(profile.environment.tools, ["read", "write", "grep", "find", "ls"]);
  assert.deepEqual(profile.checks, []);
  assert.equal((await validateTaskOutputs(profile.outputs, cwd))[0].exitCode, 1);
  await writeFile(join(cwd, "CODE_REVIEW.json"), "not json");
  assert.equal((await validateTaskOutputs(profile.outputs, cwd))[0].exitCode, 1);
  await writeFile(join(cwd, "CODE_REVIEW.json"), JSON.stringify(report()));
  assert.equal((await validateTaskOutputs(profile.outputs, cwd))[0].exitCode, 0);
  assert.match(profile.task, /write only CODE_REVIEW.json/i);
  assert.match(profile.task, /never fabricate/i);
  assert.match(profile.task, /incomplete/);
  const security = await resolveTaskProfile("builtin:security-maintenance", {
    cwd,
    home: join(cwd, "home"),
    params: { allowStaticAnalysisFixes: "false" },
  });
  assert.equal(security.manifest.parameters.allowStaticAnalysisFixes, "false");
  assert.match(security.task, /Static.analysis fixes allowed: false/);
  assert.match(security.task, /deferred/);
  assert.equal(
    (await resolveTaskProfile("builtin:security-maintenance", { cwd, home: join(cwd, "home") })).manifest.parameters
      .allowStaticAnalysisFixes,
    "true",
  );
  await assert.rejects(
    resolveTaskProfile("builtin:security-maintenance", { cwd, home: join(cwd, "home"), params: { allowStaticAnalysisFixes: "yes" } }),
    /true or false/,
  );
});

test("published schema describes strict versioned shape and conditional verdicts", async () => {
  const schema = JSON.parse(await readFile("docs/schemas/code-review-result-v1.schema.json", "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(report()).sort());
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.deepEqual([...schema.properties.findings.items.required].sort(), Object.keys(finding).sort());
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, ["P0", "P1", "P2", "P3"]);
  assert.ok(schema.allOf.length >= 2);
});

test("pure validation bounds findings, evidence and Unicode text without truncation", async () => {
  const { validateCodeReviewResult: validate } = await import("../src/code-review-result.ts");
  assert.deepEqual(validate(report()), { verdict: "clean", findingCount: 0 });
  assert.deepEqual(validate({ ...report(), verdict: "findings", findings: [finding] }), { verdict: "findings", findingCount: 1 });
  for (const patch of [
    { findings: Array(501).fill(finding), verdict: "findings" },
    { limitations: Array(101).fill("Unavailable") },
    { reviewedScope: "x".repeat(16385) },
    { limitations: null },
    { findings: null },
    { verdict: "unknown" },
    { findings: [{ ...finding, title: "x".repeat(513) }], verdict: "findings" },
    { findings: [{ ...finding, path: "x".repeat(4097) }], verdict: "findings" },
    { findings: [{ ...finding, evidence: Array(101).fill("evidence") }], verdict: "findings" },
    { findings: [{ ...finding, line: Number.MAX_SAFE_INTEGER + 1 }], verdict: "findings" },
  ])
    assert.throws(() => validate({ ...report(), ...patch }), /code review/i);
  assert.equal(validate({ ...report(), reviewedScope: "😀".repeat(16384) }).verdict, "clean");
  for (const key of ["baseSha", "headSha", "diffSha256"] as const) {
    assert.throws(() => validate(report(), { [key]: "0".repeat(64) }), /expectation/);
  }
  const sha256 = "A".repeat(64);
  assert.equal(validate({ ...report(), revision: { baseSha: sha256, headSha: sha256, diffSha256: sha256 } }).verdict, "clean");
});

test("schema path constraints agree with public validation for repository file names", async () => {
  const { validateCodeReviewResult: validate } = await import("../src/code-review-result.ts");
  const schema = JSON.parse(await readFile("docs/schemas/code-review-result-v1.schema.json", "utf8"));
  const pathPattern = new RegExp(schema.properties.findings.items.properties.path.allOf[0].pattern);
  for (const path of [
    "x",
    ".gitignore",
    ":",
    "src/line\u2028name.ts",
    "src\u2028/../x",
    "src/file.ts",
    "src/空 白.ts",
    "/tmp/x",
    "../x",
    "src/../x",
    "C:/x",
    "src\\x",
    "./x",
    "src//x",
    "x\u0000y",
    "src/",
    ".",
    "..",
    "x\ny",
    "x\u007fy",
  ]) {
    const value = { ...report(), verdict: "findings", findings: [{ ...finding, path }] };
    let valid = true;
    try {
      validate(value);
    } catch {
      valid = false;
    }
    assert.equal(pathPattern.test(path), valid, path);
  }
});
