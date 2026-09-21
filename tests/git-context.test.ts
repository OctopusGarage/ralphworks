import assert from "node:assert/strict";
import test from "node:test";

import { inferGitContext, parseGitHubRepo } from "../src/git-context.ts";

test("parseGitHubRepo supports https and ssh GitHub remotes", () => {
  assert.equal(parseGitHubRepo("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseGitHubRepo("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(parseGitHubRepo("git@github_kingson4wu:OctopusGarage/mbti-lab.git"), "OctopusGarage/mbti-lab");
});

test("inferGitContext reads the current origin repo and branch", async () => {
  const calls: string[][] = [];

  const context = await inferGitContext({
    runCommand: async (file, args) => {
      calls.push([file, ...args]);
      if (args.join(" ") === "remote get-url origin") {
        return "git@github.com:acme/widgets.git\n";
      }
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return "feature/ralph\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(calls, [
    ["git", "remote", "get-url", "origin"],
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
  ]);
  assert.deepEqual(context, { repo: "acme/widgets", ref: "feature/ralph" });
});
