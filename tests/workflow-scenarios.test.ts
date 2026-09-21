import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ISSUE_WORKFLOW } from "../src/issue-workflow.ts";
import { PRD_SPLIT_WORKFLOW } from "../src/prd-split-workflow.ts";
import { QUEUE_WORKFLOW } from "../src/queue-workflow.ts";

const run = promisify(execFile);

test("issue failure reports the human question from a run artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralphworks-feedback-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(directory, "result.json"), JSON.stringify({ status: "needs_input", reason: "Keep the legacy API?" }));
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "run download" ]; then
  mkdir -p "$RUNNER_TEMP/ralph-feedback/runs"
  cp "$MOCK_RESULT" "$RUNNER_TEMP/ralph-feedback/runs/result.json"
elif [ "$1 $2" = "issue comment" ]; then
  cp "$5" "$MOCK_COMMENT"
fi
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: "123",
    GH_TOKEN: "test-token",
    GH_REPO: "owner/repo",
    ISSUE_NUMBER: "42",
    RUN_URL: "https://github.com/owner/repo/actions/runs/123",
    MOCK_RESULT: join(directory, "result.json"),
    MOCK_COMMENT: join(directory, "comment.md"),
  };
  await run("bash", ["-e", "-c", stepScript(ISSUE_WORKFLOW, "Report failure on issue").replace("${{ github.token }}", "test-token")], {
    env,
  });
  const comment = await readFile(join(directory, "comment.md"), "utf8");
  assert.match(comment, /RalphWorks needs human input:/);
  assert.match(comment, /Keep the legacy API\?/);
  assert.match(comment, /re-add ralphworks:run/);

  await writeFile(join(directory, "result.json"), JSON.stringify({ status: "failed", reason: "dependency install failed" }));
  await run("bash", ["-e", "-c", stepScript(ISSUE_WORKFLOW, "Report failure on issue").replace("${{ github.token }}", "test-token")], {
    env,
  });
  const fallback = await readFile(join(directory, "comment.md"), "utf8");
  assert.match(fallback, /could not create a PR/);
  assert.doesNotMatch(fallback, /needs human input/);
});

function stepScript(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1);
  const runIndex = lines.findIndex((line, index) => index > start && line === "        run: |");
  assert.notEqual(runIndex, -1);
  const commands: string[] = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (!line.startsWith("          ")) break;
    commands.push(line.slice(10));
  }
  return commands.join("\n");
}

async function mockGitHub(directory: string, state: object): Promise<{ bin: string; statePath: string }> {
  const bin = join(directory, "bin");
  const statePath = join(directory, "github.json");
  await mkdir(bin);
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = process.env.MOCK_GH_STATE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(path, JSON.stringify(state));
if (args[0] === "api" && args[1]?.endsWith("/sub_issues")) {
  console.log(args.includes("--jq") ? String(state.children?.length ?? 0) : JSON.stringify(state.children ?? []));
} else if (args[0] === "api" && args[1] === "--method") {
  state.posts = (state.posts ?? 0) + 1;
  if (state.failOnPost === state.posts) {
    save();
    process.exit(1);
  }
  const title = args.find((value) => value.startsWith("title=")).slice(6);
  const body = args.find((value) => value.startsWith("body=")).slice(5);
  const child = { number: 100 + state.posts, title, body };
  state.children.push(child);
  save();
  console.log(JSON.stringify(child));
} else if (args[0] === "api" && args.includes("--jq") && args.at(-1) === ".id") {
  console.log("42");
} else if (args[0] === "issue") {
  state.edits = (state.edits ?? 0) + (args[1] === "edit" ? 1 : 0);
  save();
} else {
  console.error("Unexpected gh call:", args.join(" "));
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return { bin, statePath };
}

test("queue promotion examines issues beyond the first API page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralphworks-queue-test-"));
  const bin = join(directory, "bin");
  const edits = join(directory, "edits");
  await mkdir(bin);
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env bash
if [[ "$*" == *--paginate* ]]; then seq 1 101
elif [[ "$*" == *dependencies/blocked_by* || "$*" == *sub_issues* ]]; then echo 0
elif [[ "$1 $2" == "issue edit" ]]; then echo "$3" >> "$MOCK_GH_EDITS"
fi
`,
    { mode: 0o755 },
  );
  const script = stepScript(QUEUE_WORKFLOW, "Promote unblocked queued issues");
  await run("bash", ["-c", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_GH_EDITS: edits, GH_TOKEN: "test", GITHUB_REPOSITORY: "acme/widgets" },
  });
  assert.equal((await readFile(edits, "utf8")).trim().split("\n").length, 202);
});

test("failed PRD delivery resumes the same proposal without duplicating sub-issues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralphworks-prd-test-"));
  const { bin, statePath } = await mockGitHub(directory, { children: [], failOnPost: 2 });
  const artifact = join(directory, "split");
  await mkdir(join(artifact, "runs"), { recursive: true });
  await writeFile(join(artifact, "runs", "result.json"), JSON.stringify({ status: "completed" }));
  await writeFile(
    join(artifact, "subissues.json"),
    JSON.stringify([
      { title: "First", body: "First acceptance criteria" },
      { title: "Second", body: "Second acceptance criteria" },
    ]),
  );
  const script = stepScript(PRD_SPLIT_WORKFLOW, "Create sub-issues");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_GH_STATE: statePath,
    RUNNER_TEMP: directory,
    GH_TOKEN: "test",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_RUN_ID: "12345",
    ISSUE_NUMBER: "9",
    RUN_URL: "https://github.com/acme/widgets/actions/runs/12345",
  };
  let firstError = "";
  await assert.rejects(run("bash", ["-c", script], { env }), (error: unknown) => {
    assert.ok(error instanceof Error);
    firstError = String((error as Error & { stderr?: string }).stderr);
    return true;
  });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).children.length, 1, firstError);
  await run("bash", ["-c", script], { env });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.children.length, 2);
  assert.equal(state.posts, 3);
  assert.match(state.children[0].body, /^<!-- ralphworks-prd-split:12345:1 -->/);
  assert.match(state.children[1].body, /^<!-- ralphworks-prd-split:12345:2 -->/);
  await run("bash", ["-c", script], { env });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).posts, 3);

  state.children[0].body = "Changed after creation";
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(run("bash", ["-c", script], { env }));
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).posts, 3);
});
