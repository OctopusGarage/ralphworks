import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}

export async function currentGitHead(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ["rev-parse", "HEAD"])).trim();
  } catch {
    return undefined;
  }
}

async function changedPaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["-c", "status.renames=false", "status", "--porcelain", "--untracked-files=all", "-z"]);
  return output.split("\0").filter(Boolean).map((entry) => entry.slice(3)).filter((path) => path !== ".ralph" && !path.startsWith(".ralph/"));
}

export async function verifyCleanGitWorkspace(cwd: string): Promise<string | undefined> {
  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(root) !== await realpath(cwd)) return "verified commits require running at the Git repository root";
    const paths = await changedPaths(cwd);
    if (paths.length) return `verified commits require a clean Git workspace: ${paths.slice(0, 5).join(", ")}`;
    return undefined;
  } catch (error) {
    return `verified commits require Git: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function commitVerifiedChanges(cwd: string, jobName: string, iteration: number): Promise<string | undefined> {
  const paths = await changedPaths(cwd);
  if (!paths.length) return undefined;
  await git(cwd, ["add", "-A", "--", ...paths]);
  try {
    await git(cwd, [
      "-c", "user.name=ralphworks[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "-m", `ralphworks: ${jobName} (iteration ${iteration})`,
    ]);
  } catch (error) {
    await git(cwd, ["restore", "--staged", "--", ...paths]).catch(() => undefined);
    throw error;
  }
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function workspaceFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256");
    hash.update(await git(cwd, ["rev-parse", "HEAD"]));
    hash.update(await git(cwd, ["diff", "--binary", "HEAD", "--", ".", ":!.ralph"]));
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter((path) => path && !path.startsWith(".ralph/"));
    for (const path of untracked) {
      hash.update(path);
      hash.update(await readFile(`${cwd}/${path}`));
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
