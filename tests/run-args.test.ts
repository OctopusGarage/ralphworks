import assert from "node:assert/strict";
import test from "node:test";

import { parseRunArgs } from "../src/run-args.ts";

test("parseRunArgs accepts repeatable checks for Markdown tasks", () => {
  const result = parseRunArgs(["--check", "npm test -- --run", "--check", "npm run build"], {});
  assert.ok(!(result instanceof Error));
  assert.deepEqual(result.checks, ["npm test -- --run", "npm run build"]);
});

test("parseRunArgs defaults to the Pi runner on the host executor", () => {
  assert.deepEqual(parseRunArgs([]), {
    runner: "pi",
    executor: "host",
  });
});

test("parseRunArgs accepts docker as the local Docker executor", () => {
  assert.deepEqual(parseRunArgs(["--executor", "docker"]), {
    runner: "pi",
    executor: "docker",
  });
});

test("parseRunArgs accepts docker-clone as the remote clone Docker executor", () => {
  assert.deepEqual(parseRunArgs(["--executor", "docker-clone"]), {
    runner: "pi",
    executor: "docker-clone",
  });
});

test("parseRunArgs accepts a provider/model value", () => {
  assert.deepEqual(parseRunArgs(["--model", "anthropic/claude-opus-4-5"]), {
    runner: "pi",
    executor: "host",
    modelRef: {
      provider: "anthropic",
      id: "claude-opus-4-5",
    },
  });
});

test("parseRunArgs accepts provider and model as separate options", () => {
  assert.deepEqual(parseRunArgs(["--provider", "openai", "--model", "gpt-5-codex"]), {
    runner: "pi",
    executor: "host",
    modelRef: {
      provider: "openai",
      id: "gpt-5-codex",
    },
  });
});

test("parseRunArgs reads provider/model from environment", () => {
  assert.deepEqual(parseRunArgs([], { RALPHWORKS_MODEL: "anthropic/claude-sonnet-4-5" }), {
    runner: "pi",
    executor: "host",
    modelRef: {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    },
  });
});

test("parseRunArgs lets CLI provider/model override environment defaults", () => {
  assert.deepEqual(
    parseRunArgs(["--provider", "openai", "--model", "gpt-5-codex"], {
      RALPHWORKS_MODEL: "anthropic/claude-sonnet-4-5",
    }),
    {
      runner: "pi",
      executor: "host",
      modelRef: {
        provider: "openai",
        id: "gpt-5-codex",
      },
    },
  );
});

test("parseRunArgs requires a provider when model id has no provider prefix", () => {
  const result = parseRunArgs(["--model", "claude-sonnet-4-5"]);
  assert.ok(result instanceof Error);
  assert.match(result.message, /provider/);
});

test("parseRunArgs accepts repeated pass-through environment variables", () => {
  assert.deepEqual(parseRunArgs(["--pass-env", "MY_GATEWAY_API_KEY", "--pass-env", "HTTP_PROXY"]), {
    runner: "pi",
    executor: "host",
    passEnv: ["MY_GATEWAY_API_KEY", "HTTP_PROXY"],
  });
});

test("parseRunArgs reads pass-through environment variables from env", () => {
  assert.deepEqual(parseRunArgs([], { RALPHWORKS_PASS_ENV: "MY_GATEWAY_API_KEY,HTTP_PROXY" }), {
    runner: "pi",
    executor: "host",
    passEnv: ["MY_GATEWAY_API_KEY", "HTTP_PROXY"],
  });
});

test("parseRunArgs accepts a Pi agent directory", () => {
  assert.deepEqual(parseRunArgs(["--pi-agent-dir", ".ralph/pi"]), {
    runner: "pi",
    executor: "host",
    piAgentDir: ".ralph/pi",
  });
});

test("parseRunArgs accepts contexts and job overrides", () => {
  assert.deepEqual(parseRunArgs([
    "--context", "spec.md", "--context", "docs/api",
    "--max-iterations", "8", "--max-minutes", "30", "--max-cost-usd", "4.5",
    "--check-timeout", "120", "--commit", "verified", "--completion-promise", "FINISHED",
  ]), {
    runner: "pi", executor: "host", contexts: ["spec.md", "docs/api"],
    jobOverrides: { maxIterations: 8, maxMinutes: 30, maxCostUsd: 4.5, checkTimeoutSeconds: 120, commit: "verified", completionPromise: "FINISHED" },
  });
});
