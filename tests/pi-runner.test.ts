import assert from "node:assert/strict";
import test from "node:test";
import type { RalphJob } from "../src/job.ts";
import { PiSdkRunner, type PiSessionEvent } from "../src/pi-runner.ts";

test("PiSdkRunner builds a Ralph prompt and normalizes Pi session events", async () => {
  const job: RalphJob = {
    name: "pi-job",
    task: "Implement one safe change.",
    progressFile: ".ralph/progress.md",
    completionPromise: "DONE",
    maxIterations: 3,
    mode: "local",
    checkTimeoutSeconds: 60,
    commit: "none",
    checks: ["pnpm test"],
  };

  let capturedPrompt = "";
  let listener: ((event: PiSessionEvent) => void) | undefined;
  let unsubscribed = false;

  const runner = new PiSdkRunner({
    createSession: async () => ({
      subscribe: (next) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
      prompt: async (prompt) => {
        capturedPrompt = prompt;
      },
      waitForIdle: async () => {
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "working" },
        });
        listener?.({ type: "tool_execution_start", toolName: "bash" });
        listener?.({ type: "tool_execution_end", toolName: "bash", isError: false });
      },
      dispose: () => {},
    }),
  });

  const result = await runner.runIteration({ job, iteration: 2, cwd: process.cwd() });

  assert.equal(result.status, "continue");
  assert.equal(result.summary, "working");
  assert.equal(result.output, "working");
  assert.match(capturedPrompt, /Implement one safe change/);
  assert.match(capturedPrompt, /Iteration: 2/);
  assert.match(capturedPrompt, /<promise>DONE<\/promise>/);
  assert.match(capturedPrompt, /Do not make Git commits/);
  assert.match(capturedPrompt, /highest-priority unfinished item/);
  assert.match(capturedPrompt, /use saved progress to identify the highest-priority unfinished item/);
  assert.match(capturedPrompt, /address its feedback from progress/);
  assert.match(capturedPrompt, /item addressed, evidence from checks, files changed/);
  assert.match(capturedPrompt, /<needs-input>one concrete question and the relevant findings<\/needs-input>/);
  assert.equal(unsubscribed, true);
  assert.deepEqual(
    result.events?.map((event) => event.type),
    ["pi_tool_start", "pi_tool_end"],
  );
});

test("PiSdkRunner blocks when the Pi provider returns an assistant error", async () => {
  const job: RalphJob = {
    name: "pi-error-job",
    task: "Implement one safe change.",
    progressFile: ".ralph/progress.md",
    completionPromise: "DONE",
    maxIterations: 3,
    mode: "local",
    checkTimeoutSeconds: 60,
    commit: "none",
    checks: [],
  };

  let listener: ((event: PiSessionEvent) => void) | undefined;

  const runner = new PiSdkRunner({
    createSession: async () => ({
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
      prompt: async () => {},
      waitForIdle: async () => {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "nvidia",
            model: "nvidia/nemotron-3-super-120b-a12b",
            stopReason: "error",
            errorMessage: "403 status code (no body)",
          },
        });
      },
    }),
  });

  const result = await runner.runIteration({ job, iteration: 1, cwd: process.cwd() });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /403 status code/);
  assert.match(result.output ?? "", /403 status code/);
  assert.deepEqual(result.events, [
    {
      type: "pi_assistant_error",
      details: {
        provider: "nvidia",
        model: "nvidia/nemotron-3-super-120b-a12b",
        errorMessage: "403 status code (no body)",
      },
    },
  ]);
});

test("PiSdkRunner recognizes a final request for human input", async () => {
  let listener: ((event: PiSessionEvent) => void) | undefined;
  const runner = new PiSdkRunner({
    createSession: async () => ({
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
      prompt: async () => {},
      waitForIdle: async () => {
        listener?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Checked the existing API.\n<needs-input>Which compatibility behavior should remain?</needs-input>",
          },
        });
      },
    }),
  });
  const job: RalphJob = {
    name: "human-input",
    task: "Implement the API change",
    progressFile: ".ralph/progress.md",
    completionPromise: "DONE",
    maxIterations: 3,
    mode: "local",
    checkTimeoutSeconds: 60,
    commit: "none",
    checks: [],
  };
  const result = await runner.runIteration({ job, iteration: 1, cwd: process.cwd() });
  assert.equal(result.status, "needs_input");
  assert.equal(result.summary, "Which compatibility behavior should remain?");
});

test("PiSdkRunner uses the last assistant handoff without the completion marker", async () => {
  let listener: ((event: PiSessionEvent) => void) | undefined;
  const runner = new PiSdkRunner({
    createSession: async () => ({
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
      prompt: async () => {},
      waitForIdle: async () => {
        listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Investigating." } });
        listener?.({ type: "message_end", message: { role: "assistant" } });
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Updated src/app.ts; next run tests. <promise>DONE</promise>" },
        });
        listener?.({ type: "message_end", message: { role: "assistant" } });
      },
    }),
  });
  const job: RalphJob = {
    name: "handoff",
    task: "Update app",
    progressFile: ".ralph/progress.md",
    maxIterations: 1,
    mode: "local",
    checkTimeoutSeconds: 60,
    commit: "none",
    checks: [],
    completionPromise: "DONE",
  };
  const result = await runner.runIteration({ job, iteration: 1, cwd: process.cwd() });
  assert.equal(result.summary, "Updated src/app.ts; next run tests.");
  assert.match(result.output ?? "", /<promise>DONE<\/promise>$/);
});

test("PiSdkRunner passes configured provider/model to the session factory", async () => {
  const job: RalphJob = {
    name: "pi-model-job",
    task: "Use the configured model.",
    progressFile: ".ralph/progress.md",
    completionPromise: "DONE",
    maxIterations: 1,
    mode: "local",
    checkTimeoutSeconds: 60,
    commit: "none",
    checks: [],
  };

  const captured: Array<{
    cwd: string;
    modelRef?: { provider: string; id: string };
    piAgentDir?: string;
  }> = [];

  const runner = new PiSdkRunner({
    modelRef: { provider: "anthropic", id: "claude-opus-4-5" },
    piAgentDir: "/tmp/pi-agent",
    createSession: async (input) => {
      captured.push(input);
      return {
        subscribe: () => () => {},
        prompt: async () => {},
        waitForIdle: async () => {},
      };
    },
  });

  await runner.runIteration({ job, iteration: 1, cwd: "/tmp/project" });

  assert.deepEqual(captured, [
    {
      cwd: "/tmp/project",
      modelRef: { provider: "anthropic", id: "claude-opus-4-5" },
      piAgentDir: "/tmp/pi-agent",
    },
  ]);
});
