import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTrace } from "../src/trace.ts";

test("readTrace summarizes event types in order", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralphworks-trace-"));
  const eventsPath = join(workspace, "events.jsonl");
  await writeFile(
    eventsPath,
    [
      JSON.stringify({ type: "run_started", at: "2026-09-17T00:00:00.000Z", job: "sample" }),
      JSON.stringify({ type: "iteration_started", at: "2026-09-17T00:00:01.000Z", job: "sample", iteration: 1 }),
      JSON.stringify({
        type: "check_finished",
        at: "2026-09-17T00:00:02.000Z",
        job: "sample",
        iteration: 1,
        details: { exitCode: 0 },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const trace = await readTrace(eventsPath);

  assert.equal(trace.totalEvents, 3);
  assert.deepEqual(trace.eventTypes, ["run_started", "iteration_started", "check_finished"]);
  assert.equal(trace.firstAt, "2026-09-17T00:00:00.000Z");
  assert.equal(trace.lastAt, "2026-09-17T00:00:02.000Z");
});
