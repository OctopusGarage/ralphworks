import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RalphJob } from "../src/job.ts";
import { runLocalJob } from "../src/orchestrator.ts";
import { PiSdkRunner, type PiSessionEvent } from "../src/pi-runner.ts";

test("PiSdkRunner tells the agent its actual deadline and independently scheduled checks", async () => {
  let prompt = "";
  let sessionDeadline: unknown;
  const deadline = Date.now() + 120_000;
  const runner = new PiSdkRunner({
    createSession: async (input) => {
      sessionDeadline = Reflect.get(input, "deadline");
      return {
        subscribe: () => () => {},
        prompt: async (text) => {
          prompt = text;
        },
      };
    },
  });
  await runner.runIteration({
    job: {
      name: "bounded",
      task: "Refactor one seam.",
      progressFile: ".ralph/progress.md",
      maxIterations: 2,
      mode: "local",
      checkTimeoutSeconds: 45,
      commit: "none",
      checks: ["npm test", "npm run typecheck"],
    },
    iteration: 1,
    cwd: process.cwd(),
    deadline,
  });
  assert.equal(sessionDeadline, deadline);
  assert.ok(prompt.includes(new Date(deadline).toISOString()));
  assert.match(prompt, /Remaining at prompt creation: \d+ seconds/);
  assert.match(prompt, /after you return/);
  assert.ok(prompt.includes(JSON.stringify("npm test")));
  assert.ok(prompt.includes(JSON.stringify("npm run typecheck")));
  assert.match(prompt, /45 seconds per check/);
  assert.match(prompt, /Never report scheduled checks as already passed/);
});

for (const commit of ["none", "verified"] as const) {
  test(`PiSdkRunner describes actual commit ownership for ${commit}`, async () => {
    let prompt = "";
    const job: RalphJob = {
      name: "commit-ownership",
      task: "Implement the parser repair and preserve its public contract.",
      progressFile: ".ralph/progress.md",
      completionPromise: "REPAIR_COMPLETE",
      maxIterations: 2,
      mode: "local",
      checkTimeoutSeconds: 60,
      commit,
      checks: ["npm test"],
    };
    const runner = new PiSdkRunner({
      createSession: async () => ({
        subscribe: () => () => {},
        prompt: async (text) => {
          prompt = text;
        },
      }),
    });
    await runner.runIteration({ job, iteration: 1, cwd: process.cwd() });
    assert.ok(prompt.includes(job.task));
    assert.match(prompt, /Do not make Git commits/);
    if (commit === "none") {
      assert.match(prompt, /leaves changes uncommitted/);
      assert.doesNotMatch(prompt, /handles verified commits/);
    } else {
      assert.match(prompt, /handles verified commits after checks/);
    }
    assert.match(prompt, /<promise>REPAIR_COMPLETE<\/promise>/);
    assert.match(prompt, /task's acceptance criteria/);
    assert.match(prompt, /checks run independently.*after you return/);
    assert.ok(prompt.includes(JSON.stringify(job.checks[0])));
    assert.match(prompt, /completion after running checks and validating outputs/);
  });
}

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

for (const scenario of [
  {
    name: "accepts the successful final handoff after SDK retry",
    beforeError: "",
    afterError: "Verified the change. <promise>DONE</promise>",
    finalStopReason: "stop",
    status: "continue",
    output: "Verified the change. <promise>DONE</promise>",
    summary: "Verified the change.",
  },
  {
    name: "discards a failed partial completion promise after SDK retry",
    beforeError: "Partial response. <promise>DONE</promise>",
    afterError: "The acceptance check still needs work.",
    finalStopReason: "stop",
    status: "continue",
    output: "The acceptance check still needs work.",
    summary: "The acceptance check still needs work.",
  },
  {
    name: "discards a failed completion promise before a recovered needs-input handoff",
    beforeError: "<promise>DONE</promise>",
    afterError: "<needs-input>Which API version should be preserved?</needs-input>",
    finalStopReason: "stop",
    status: "needs_input",
    output: "<needs-input>Which API version should be preserved?</needs-input>",
    summary: "Which API version should be preserved?",
  },
  {
    name: "does not reuse a failed completion promise after an empty successful response",
    beforeError: "<promise>DONE</promise>",
    afterError: "",
    finalStopReason: "stop",
    status: "continue",
    output: "",
    summary: "Pi iteration 1 finished without a text handoff",
  },
  {
    name: "blocks when SDK retry gives up after an earlier completion promise",
    beforeError: "<promise>DONE</promise>",
    afterError: "",
    finalStopReason: "error",
    status: "blocked",
    output: "503 server overloaded",
    summary: "Pi iteration 1 blocked: 503 server overloaded",
  },
  {
    name: "does not treat an aborted retry as a successful completion",
    beforeError: "<promise>DONE</promise>",
    afterError: "<promise>DONE</promise>",
    finalStopReason: "aborted",
    status: "blocked",
    output: "Pi assistant aborted",
    summary: "Pi iteration 1 blocked: Pi assistant aborted",
  },
]) {
  test(`PiSdkRunner ${scenario.name}`, async () => {
    let listener: ((event: PiSessionEvent) => void) | undefined;
    let prompts = 0;
    const runner = new PiSdkRunner({
      createSession: async () => ({
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        prompt: async () => {
          prompts += 1;
          const sequence: Array<PiSessionEvent & { attempt?: number; success?: boolean }> = [
            { type: "message_start", message: { role: "assistant" } },
            { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: scenario.beforeError } },
            { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "503 server overloaded" } },
            { type: "auto_retry_start", attempt: 1 },
            { type: "message_start", message: { role: "assistant" } },
            { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: scenario.afterError } },
            {
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: scenario.finalStopReason,
                ...(scenario.finalStopReason === "error" ? { errorMessage: "503 server overloaded" } : {}),
              },
            },
            { type: "auto_retry_end", attempt: 1, success: scenario.finalStopReason !== "error" },
          ];
          for (const event of sequence) listener?.(event);
        },
        waitForIdle: async () => {},
      }),
    });
    const job: RalphJob = {
      name: "sdk-retry",
      task: "Finish the change",
      progressFile: ".ralph/progress.md",
      completionPromise: "DONE",
      maxIterations: 1,
      mode: "local",
      checkTimeoutSeconds: 60,
      commit: "none",
      checks: [],
    };
    const result = await runner.runIteration({ job, iteration: 1, cwd: process.cwd() });
    assert.equal(result.output, scenario.output);
    assert.equal(result.status, scenario.status);
    assert.equal(result.summary, scenario.summary);
    assert.equal(prompts, 1);
    assert.equal(
      result.events?.filter((event) => event.type === "pi_assistant_error").length,
      scenario.finalStopReason === "error" ? 2 : 1,
    );
    assert.equal(result.events?.[0]?.details.errorMessage, "503 server overloaded");
  });
}

for (const terminalError of [false, true]) {
  test(`PiSdkRunner discards an earlier successful completion promise before a final ${terminalError ? "error" : "incomplete handoff"}`, async () => {
    let listener: ((event: PiSessionEvent) => void) | undefined;
    const runner = new PiSdkRunner({
      createSession: async () => ({
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        prompt: async () => {
          for (const [index, text] of ["<promise>DONE</promise>", "Verification found unfinished work."].entries()) {
            listener?.({ type: "message_start", message: { role: "assistant" } });
            listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
            listener?.({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: terminalError && index === 1 ? "error" : "stop",
                ...(terminalError && index === 1 ? { errorMessage: "403 forbidden" } : {}),
              },
            });
          }
        },
      }),
    });
    const result = await runner.runIteration({
      job: {
        name: "final-handoff",
        task: "Finish",
        progressFile: "progress.md",
        maxIterations: 1,
        mode: "local",
        checkTimeoutSeconds: 60,
        commit: "none",
        checks: [],
        completionPromise: "DONE",
      },
      iteration: 1,
      cwd: process.cwd(),
    });
    assert.equal(result.status, terminalError ? "blocked" : "continue");
    assert.equal(result.output, terminalError ? "403 forbidden" : "Verification found unfinished work.");
  });
}

test("a recovered SDK error cannot complete the loop using a failed partial promise", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-recovered-error-"));
  const jobPath = join(cwd, "job.yaml");
  await writeFile(
    jobPath,
    'name: retry-boundary\ntask: Finish the change\nmax_iterations: 1\ncompletion_promise: DONE\nchecks:\n  - node -e "process.exit(0)"\n',
  );
  let listener: ((event: PiSessionEvent) => void) | undefined;
  const runner = new PiSdkRunner({
    createSession: async () => ({
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
      prompt: async () => {
        listener?.({ type: "message_start", message: { role: "assistant" } });
        listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<promise>DONE</promise>" } });
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "503 server overloaded",
            content: [{ type: "text", text: "<promise>DONE</promise>" }],
          },
        });
        listener?.({ type: "auto_retry_start" });
        listener?.({ type: "message_start", message: { role: "assistant" } });
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Another implementation step remains." },
        });
        listener?.({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Another implementation step remains." }] },
        });
        listener?.({ type: "auto_retry_end" });
      },
      waitForIdle: async () => {},
    }),
  });
  const result = await runLocalJob(jobPath, { cwd, runner });
  assert.equal(result.status, "max_iterations");
  assert.equal(result.iterations, 1);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0]?.exitCode, 0);
  const events = (await readFile(result.eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "pi_assistant_error").length, 1);
  assert.equal(events.find((event) => event.type === "pi_assistant_error")?.details.errorMessage, "503 server overloaded");
});

for (const scenario of [
  {
    name: "reads final-only SDK completion text",
    delta: "",
    text: "Verified. <promise>DONE</promise>",
    stopReason: "stop",
    status: "continue",
    output: "Verified. <promise>DONE</promise>",
  },
  {
    name: "reads a final-only SDK needs-input request",
    delta: "",
    text: "<needs-input>Choose a version?</needs-input>",
    stopReason: "stop",
    status: "needs_input",
    output: "<needs-input>Choose a version?</needs-input>",
  },
  {
    name: "uses final SDK content instead of stale streamed completion text",
    delta: "<promise>DONE</promise>",
    text: "Another step remains.",
    stopReason: "stop",
    status: "continue",
    output: "Another step remains.",
  },
  {
    name: "respects explicitly empty final SDK content",
    delta: "<promise>DONE</promise>",
    text: "",
    stopReason: "stop",
    status: "continue",
    output: "",
  },
  {
    name: "blocks terminal SDK error content containing a completion promise",
    delta: "",
    text: "<promise>DONE</promise>",
    stopReason: "error",
    status: "blocked",
    output: "503 server overloaded",
  },
  {
    name: "blocks terminal SDK aborted content containing a completion promise",
    delta: "",
    text: "<promise>DONE</promise>",
    stopReason: "aborted",
    status: "blocked",
    output: "Pi assistant aborted",
  },
]) {
  test(`PiSdkRunner ${scenario.name}`, async () => {
    let listener: ((event: PiSessionEvent) => void) | undefined;
    const runner = new PiSdkRunner({
      createSession: async () => ({
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        prompt: async () => {
          const message = {
            role: "assistant",
            stopReason: scenario.stopReason,
            content: scenario.text
              ? [
                  { type: "text", text: scenario.text },
                  { type: "thinking", thinking: "internal" },
                ]
              : [],
            ...(scenario.stopReason === "error" ? { errorMessage: "503 server overloaded" } : {}),
          };
          listener?.({ type: "message_start", message: { role: "assistant" } });
          if (scenario.delta) listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: scenario.delta } });
          listener?.({ type: "message_end", message });
        },
      }),
    });
    const result = await runner.runIteration({
      job: {
        name: "final-content",
        task: "Finish",
        progressFile: "progress.md",
        maxIterations: 1,
        mode: "local",
        checkTimeoutSeconds: 60,
        commit: "none",
        checks: [],
        completionPromise: "DONE",
      },
      iteration: 1,
      cwd: process.cwd(),
    });
    assert.equal(result.output, scenario.output);
    assert.equal(result.status, scenario.status);
  });
}

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

test("PiSdkRunner passes explicitly selected skills to resource discovery independently of model choice", async () => {
  let captured: { skillPaths?: string[]; modelRef?: { provider: string; id: string } } | undefined;
  const runner = new PiSdkRunner({
    skillPaths: ["/library/review/SKILL.md"],
    modelRef: { provider: "any-provider", id: "coder" },
    createSession: async (input) => {
      captured = input;
      return { subscribe: () => () => {}, prompt: async () => {} };
    },
  });
  await runner.runIteration({
    job: {
      name: "test",
      task: "Review",
      progressFile: "progress.md",
      maxIterations: 1,
      mode: "local",
      checks: [],
      checkTimeoutSeconds: 60,
      commit: "none",
    },
    iteration: 1,
    cwd: process.cwd(),
  });
  assert.deepEqual(captured?.skillPaths, ["/library/review/SKILL.md"]);
  assert.equal(captured?.modelRef?.provider, "any-provider");
});

test("PiSdkRunner forwards task environment and awaits asynchronous session cleanup", async () => {
  const { normalizeTaskEnvironment } = await import("../src/task-environment.ts");
  const environment = normalizeTaskEnvironment({ tools: ["read"], mcp: { docs: { tools: ["lookup"] } } });
  let closed = false;
  const runner = new PiSdkRunner({
    environment,
    mcpBindings: { docs: { transport: "http", url: "http://localhost:9000/mcp" } },
    createSession: async (input) => {
      assert.deepEqual(input.environment, environment);
      assert.ok(input.mcpBindings?.docs);
      return {
        subscribe: () => () => {},
        prompt: async () => {},
        dispose: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          closed = true;
        },
      };
    },
  });
  await runner.runIteration({
    job: {
      name: "test",
      task: "Read",
      progressFile: "progress.md",
      maxIterations: 1,
      mode: "local",
      checks: [],
      checkTimeoutSeconds: 60,
      commit: "none",
    },
    iteration: 1,
    cwd: process.cwd(),
  });
  assert.equal(closed, true);
});

test("cancellation during asynchronous session creation prevents prompting and still disposes", async () => {
  const controller = new AbortController();
  let prompted = false;
  let disposed = false;
  const runner = new PiSdkRunner({
    createSession: async () => {
      controller.abort("cancel during startup");
      return {
        subscribe: () => () => {},
        prompt: async () => {
          prompted = true;
        },
        dispose: () => {
          disposed = true;
        },
      };
    },
  });
  await assert.rejects(
    runner.runIteration({
      job: {
        name: "test",
        task: "Read",
        progressFile: "progress.md",
        maxIterations: 1,
        mode: "local",
        checks: [],
        checkTimeoutSeconds: 60,
        commit: "none",
      },
      iteration: 1,
      cwd: process.cwd(),
      signal: controller.signal,
    }),
  );
  assert.equal(prompted, false);
  assert.equal(disposed, true);
});
