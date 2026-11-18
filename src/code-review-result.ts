import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_BYTES = 1024 * 1024;
const SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const HASH = /^[a-fA-F0-9]{64}$/;
type RevisionKey = "baseSha" | "headSha" | "diffSha256";
type Verdict = "clean" | "findings" | "incomplete";

export async function reviewCommand(command: string | undefined, args: string[]): Promise<number> {
  try {
    const [file, ...flags] = args;
    if (command !== "validate" || !file || file.startsWith("--")) {
      throw new Error("Usage: ralph review validate <file> [--base-sha SHA] [--head-sha SHA] [--diff-sha256 HASH]");
    }
    const expectations: Partial<Record<RevisionKey, string>> = {};
    for (let index = 0; index < flags.length; index += 2) {
      const flag = flags[index];
      const key =
        flag === "--base-sha" ? "baseSha" : flag === "--head-sha" ? "headSha" : flag === "--diff-sha256" ? "diffSha256" : undefined;
      const value = flags[index + 1];
      if (!key || !value || expectations[key] !== undefined || !(key === "diffSha256" ? HASH : SHA).test(value)) {
        throw new Error(`Invalid or duplicate review revision flag: ${flag}`);
      }
      expectations[key] = value;
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Code review input must be a regular file");
      bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("Code review input exceeds 1048576 bytes");
      bytes = bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
    const result = validateCodeReviewResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), expectations);
    console.log(JSON.stringify({ schemaVersion: 1, valid: true, ...result }));
    return 0;
  } catch (error) {
    console.error(`Invalid code review: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function validateCodeReviewResult(
  value: unknown,
  expectations: Partial<Record<RevisionKey, string>> = {},
): { verdict: Verdict; findingCount: number } {
  const result = object(value, ["schemaVersion", "revision", "verdict", "reviewedScope", "findings", "limitations"], "review");
  if (result.schemaVersion !== 1) fail("schemaVersion must be 1");
  const revision = object(result.revision, ["baseSha", "headSha", "diffSha256"], "revision");
  for (const key of ["baseSha", "headSha", "diffSha256"] as const) {
    const fact = revision[key];
    if (fact !== null && (typeof fact !== "string" || !(key === "diffSha256" ? HASH : SHA).test(fact))) fail(`Invalid revision.${key}`);
    if (expectations[key] !== undefined && expectations[key] !== fact) fail(`revision.${key} does not match expectation`);
  }
  if (!["clean", "findings", "incomplete"].includes(result.verdict as string)) fail("Invalid verdict");
  text(result.reviewedScope, "reviewedScope");
  const findings = array(result.findings, "findings", 500);
  for (const item of findings) {
    const finding = object(item, ["severity", "path", "line", "title", "trigger", "consequence", "remedy", "evidence"], "finding");
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity as string)) fail("Invalid finding severity");
    text(finding.path, "finding.path", 4096);
    const path = finding.path as string;
    if (
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    )
      fail("Invalid finding path: expected a normalized relative file path");
    if (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1) fail("Invalid finding line");
    text(finding.title, "finding.title", 512);
    for (const key of ["trigger", "consequence", "remedy"]) text(finding[key], `finding.${key}`);
    const evidence = array(finding.evidence, "finding.evidence", 100);
    if (!evidence.length) fail("finding.evidence must be nonempty");
    for (const entry of evidence) text(entry, "finding.evidence");
  }
  for (const entry of array(result.limitations, "limitations", 100)) text(entry, "limitation");
  if (result.verdict === "clean" && findings.length) fail("clean verdict cannot contain findings");
  if (result.verdict === "findings" && !findings.length) fail("findings verdict requires findings");
  return { verdict: result.verdict as Verdict, findingCount: findings.length };
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) fail(`Invalid ${label} fields`);
  return record;
}
function text(value: unknown, label: string, max = 16384): void {
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    fail(`${label} must be nonempty text of at most ${max} characters`);
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array of at most ${max} entries`);
  return value as unknown[];
}
function fail(message: string): never {
  throw new Error(`Invalid code review: ${message}`);
}
