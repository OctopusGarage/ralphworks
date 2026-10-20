import { type Scope, SkillHub } from "./skill-hub.ts";
import { remoteSkill } from "./skill-source.ts";

export async function skillCommand(action: string | undefined, args: string[]): Promise<number> {
  const hub = new SkillHub({ cwd: process.cwd() });
  const positional: string[] = [];
  const flags: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (
        !["--name", "--scope", "--path", "--ref", "--entrypoint"].includes(arg) ||
        !args[index + 1] ||
        args[index + 1].startsWith("--") ||
        flags[arg]
      )
        throw new Error(`Invalid skills option: ${arg}`);
      flags[arg] = args[++index];
    } else positional.push(arg);
  }
  const scope = flags["--scope"] as Scope | undefined;
  if (scope && !["builtin", "project", "personal"].includes(scope)) throw new Error("Invalid skill scope");
  const allowed =
    action === "list"
      ? ["--scope"]
      : action === "add"
        ? ["--name", "--scope", "--path", "--ref", "--entrypoint"]
        : action === "import"
          ? ["--name", "--scope"]
          : [];
  if (Object.keys(flags).some((flag) => !allowed.includes(flag))) throw new Error("Unsupported skills option");
  let result: unknown;
  if (action === "list" && !positional.length) result = await hub.list(scope);
  else if ((action === "add" || action === "import") && positional.length === 1 && flags["--name"] && scope && scope !== "builtin") {
    if (action === "import") result = await hub.import(positional[0], flags["--name"], scope);
    else {
      const source = positional[0];
      const remote = /^https:/.test(source)
        ? flags["--path"]
          ? remoteSkill({ source, path: flags["--path"], ref: flags["--ref"] })
          : remoteSkill(source)
        : undefined;
      if (!remote && (flags["--path"] || flags["--ref"])) throw new Error("--path and --ref require a GitHub source");
      result = await hub.add(
        remote ? { ...remote, ...(flags["--ref"] ? { ref: flags["--ref"] } : {}) } : source,
        flags["--name"],
        scope,
        flags["--entrypoint"],
      );
    }
  } else if (positional.length === 1 && ["update", "inspect", "verify"].includes(action ?? "")) {
    if (action === "update") result = await hub.update(positional[0]);
    else if (action === "inspect") result = await hub.inspect(positional[0]);
    else {
      const entry = await hub.inspect(positional[0]);
      for (const revision of entry.revisions) await hub.path(revision);
      result = { use: positional[0], verified: true, revisions: entry.revisions.length };
    }
  } else if (positional.length === 2 && (action === "export" || action === "fork")) {
    await hub[action](positional[0], positional[1]);
    result = { destination: positional[1] };
  } else
    throw new Error(
      "Usage: ralphworks skills list [--scope SCOPE] | add SOURCE --name NAME --scope project|personal [--path PATH --ref REF] [--entrypoint PATH/SKILL.md] | update REF | inspect REF | verify REF | export REF DEST | import BUNDLE --name NAME --scope project|personal | fork REF DEST",
    );
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
