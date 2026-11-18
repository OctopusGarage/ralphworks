import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A bounded same-user POSIX reference check, not a process ownership registry. */
export async function workspaceIsUnused(cwd: string): Promise<boolean> {
  if (process.platform === "win32" || !process.getuid) return false;
  try {
    const result = await exec("lsof", ["-nP", "-a", "-u", String(process.getuid()), "-F0pn"], {
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.stderr.trim() || !result.stdout.endsWith("\n") || !result.stdout.includes("\0")) return false;
    let processSeen = false;
    let nameSeen = false;
    for (const raw of result.stdout.split("\0")) {
      const field = raw.startsWith("\n") ? raw.slice(1) : raw;
      if (/^p[1-9]\d*$/.test(field)) processSeen = true;
      if (!field.startsWith("n")) continue;
      if (!processSeen) return false;
      nameSeen = true;
      const path = field.slice(1);
      if (path === cwd || path.startsWith(`${cwd}/`)) return false;
    }
    return processSeen && nameSeen;
  } catch {
    // Unavailable, timed out, truncated, or unreadable process references cannot prove absence.
    return false;
  }
}
