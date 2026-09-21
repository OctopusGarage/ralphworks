import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitContext = {
  repo: string;
  ref: string;
};

export type GitContextOptions = {
  cwd?: string;
  runCommand?: (file: string, args: string[], cwd?: string) => Promise<string>;
};

export async function inferGitContext(options: GitContextOptions = {}): Promise<GitContext> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const remote = (await runCommand("git", ["remote", "get-url", "origin"], options.cwd)).trim();
  const branch = (await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], options.cwd)).trim();
  const repo = parseGitHubRepo(remote);
  if (!repo) {
    throw new Error(`Could not infer GitHub repo from origin remote: ${remote}`);
  }
  if (!branch || branch === "HEAD") {
    throw new Error("Could not infer the current git branch; pass --ref explicitly");
  }
  return { repo, ref: branch };
}

export function parseGitHubRepo(remote: string): string | undefined {
  const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }
  const sshMatch = remote.match(/^git@[^:]+:([^/]+\/[^/.]+)(?:\.git)?$/);
  return sshMatch?.[1];
}

async function defaultRunCommand(file: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
