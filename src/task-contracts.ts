import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type { CheckResult } from "./check-runner.ts";
import type { McpBindings } from "./mcp-config.ts";
import type { OutputRequirement, TaskEnvironment } from "./task-environment.ts";

export function validateMcpRequirements(environment: TaskEnvironment, bindings: McpBindings): void {
  for (const [alias, requirement] of Object.entries(environment.mcp))
    if (requirement.required !== false && !Object.hasOwn(bindings, alias)) throw new Error(`Required MCP binding is missing: ${alias}`);
}
export async function checkTaskPrerequisites(
  environment: TaskEnvironment,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const name of environment.requires.env) if (!env[name]) throw new Error(`Required environment variable is missing: ${name}`);
  for (const command of environment.requires.commands) {
    let found = false;
    for (const directory of (env.PATH ?? "").split(delimiter)) {
      const candidates =
        process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => command + ext) : [command];
      for (const name of candidates) {
        try {
          await access(resolve(cwd, directory, name), constants.X_OK);
          found = true;
          break;
        } catch {}
      }
      if (found) break;
    }
    if (!found) throw new Error(`Required command is unavailable: ${command}`);
  }
}

export async function validateTaskOutputs(outputs: OutputRequirement[], cwd: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const output of outputs) {
    let error: string | undefined;
    try {
      const path = join(cwd, output.path);
      const info = await stat(path);
      const suffix = relative(await realpath(cwd), await realpath(path));
      if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) throw new Error("Output resolves outside the task workspace");
      if (!info.isFile() || info.size === 0) throw new Error("Output must be a non-empty regular file");
      if (info.size > 1024 * 1024) throw new Error("Output exceeds the 1 MiB validation limit");
      if (output.format === "json") {
        try {
          JSON.parse(await readFile(path, "utf8"));
        } catch {
          throw new Error("Output is not valid JSON");
        }
      }
    } catch (cause) {
      if (!(output.required === false && cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"))
        error = cause instanceof Error ? cause.message : "Output validation failed";
    }
    checks.push({
      command: `output: ${output.path}`,
      exitCode: error ? 1 : 0,
      stdout: error ? "" : "Output requirement satisfied",
      stderr: error ? `${output.path}: ${error}` : "",
    });
  }
  return checks;
}
