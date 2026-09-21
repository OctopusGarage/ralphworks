import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDockerCloneJob } from "../src/docker-clone-executor.ts";

test("runDockerCloneJob runs a container that clones the target GitHub repo", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const outputDir = await mkdtemp(join(tmpdir(), "ralphworks-clone-output-"));

  const result = await runDockerCloneJob({
    jobPath: "docs/plan.md",
    repo: "acme/widgets",
    ref: "main",
    runner: "pi",
    modelRef: { provider: "anthropic", id: "claude-opus-4-5" },
    piAgentDir: "/Users/me/.pi/agent",
    passEnv: ["MY_GATEWAY_API_KEY"],
    contexts: ["spec.md"],
    jobOverrides: { maxMinutes: 30 },
    env: { ANTHROPIC_API_KEY: "sk-test", MY_GATEWAY_API_KEY: "secret", GH_TOKEN: "private-token" },
    outputDir,
    runCommand: async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0, stdout: "container ok", stderr: "" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outputDir, outputDir);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "docker");
  assert.deepEqual(calls[0].args.slice(0, 2), ["run", "--rm"]);
  assert.ok(calls[0].args.includes("--entrypoint"));
  assert.ok(calls[0].args.includes("bash"));
  assert.equal(calls[0].args.at(-2), "-c");
  assert.ok(calls[0].args.includes("RALPH_REPO=acme/widgets"));
  assert.ok(calls[0].args.includes("RALPH_REF=main"));
  assert.ok(calls[0].args.includes("RALPH_JOB=docs/plan.md"));
  assert.ok(calls[0].args.includes("RALPH_RUNNER=pi"));
  assert.ok(calls[0].args.includes("RALPHWORKS_UNATTENDED=1"));
  assert.ok(calls[0].args.includes("RALPHWORKS_MODEL=anthropic/claude-opus-4-5"));
  assert.ok(calls[0].args.includes("PI_CODING_AGENT_DIR=/home/agent/.pi/agent"));
  assert.ok(calls[0].args.includes("/Users/me/.pi/agent:/home/agent/.pi/agent"));
  assert.ok(calls[0].args.includes("ANTHROPIC_API_KEY"));
  assert.ok(calls[0].args.includes("MY_GATEWAY_API_KEY"));
  assert.ok(calls[0].args.includes('RALPHWORKS_CONTEXTS_JSON=["spec.md"]'));
  assert.ok(calls[0].args.includes('RALPHWORKS_JOB_OVERRIDES_JSON={"maxMinutes":30}'));
  assert.ok(calls[0].args.includes("GH_TOKEN"));
  assert.ok(!calls[0].args.some((arg) => arg.includes("private-token")));
  assert.ok(calls[0].args.includes(`${outputDir}:/output`));
  assert.match(calls[0].args.at(-1) ?? "", /git clone --branch "\$RALPH_REF"/);
  assert.match(calls[0].args.at(-1) ?? "", /https:\/\/github.com\/\$RALPH_REPO\.git/);
  assert.match(calls[0].args.at(-1) ?? "", /gh repo clone "\$RALPH_REPO"/);
  assert.match(calls[0].args.at(-1) ?? "", /unset GH_TOKEN/);
  assert.match(calls[0].args.at(-1) ?? "", /git config user\.name/);
  assert.match(calls[0].args.at(-1) ?? "", /git config user\.email/);
  assert.match(calls[0].args.at(-1) ?? "", /npm ci/);
  assert.match(calls[0].args.at(-1) ?? "", /pnpm install --frozen-lockfile/);
  assert.match(calls[0].args.at(-1) ?? "", /ralphworks run "\$RALPH_JOB" --runner "\$RALPH_RUNNER" --executor host/);
  assert.match(calls[0].args.at(-1) ?? "", /git diff --binary/);
  assert.match(calls[0].args.at(-1) ?? "", /git add -N --all\n/);
  assert.match(calls[0].args.at(-1) ?? "", /change\.patch/);
  assert.match(calls[0].args.at(-1) ?? "", /result\.json/);
  assert.match(calls[0].args.at(-1) ?? "", /RALPH_RUN_DIR="\.ralph\/\$RALPH_RUN_DIR"/);
});
