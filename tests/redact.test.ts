import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveValues } from "../src/redact.ts";

test("redactSensitiveValues masks configured credential values in persisted text", () => {
  assert.equal(
    redactSensitiveValues("failed: credential-123; ordinary-value", {
      MY_API_KEY: "credential-123",
      ORDINARY_VALUE: "ordinary-value",
    }),
    "failed: [REDACTED]; ordinary-value",
  );
});
