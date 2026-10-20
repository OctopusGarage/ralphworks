import { parseRunArgs } from "./run-args.ts";
import {
  collectProfile,
  listProfiles,
  removeCollectedProfile,
  resolveTaskProfile,
  updateProfileSkills,
  vendorProfileSkills,
} from "./task-profile.ts";

export async function profileCommand(action: string | undefined, args: string[]): Promise<number> {
  const options = { cwd: process.cwd() };
  if (action === "list" && !args.length) console.log(JSON.stringify(await listProfiles(options), null, 2));
  else if (action === "vendor" && args.length === 1) console.log(`lock=${await vendorProfileSkills(args[0], options)}`);
  else if (action === "update" && args.length === 1) console.log(JSON.stringify(await updateProfileSkills(args[0], options), null, 2));
  else if (action === "add" && args.length === 2) console.log(`collected=${await collectProfile(args[0], args[1], options)}`);
  else if (action === "remove" && args.length === 1) {
    await removeCollectedProfile(args[0]);
    console.log(`removed=${args[0]}`);
  } else if (action === "show" && args[0]) {
    const rest = args.slice(1);
    for (let index = 0; index < rest.length; index += 2)
      if (rest[index] !== "--param") throw new Error("profiles show accepts only --param key=value");
    const parsed = parseRunArgs(rest, {});
    if (parsed instanceof Error) throw parsed;
    console.log(JSON.stringify(await resolveTaskProfile(args[0], { ...options, params: parsed.params }), null, 2));
  } else
    throw new Error(
      "Usage: ralphworks profiles list | show NAME [--param key=value] | add SOURCE NAME | update NAME | vendor NAME | remove NAME",
    );
  return 0;
}
