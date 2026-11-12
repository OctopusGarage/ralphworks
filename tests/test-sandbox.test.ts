import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function waitFor(check: () => boolean, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test-owned process evidence");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const fail of [false, true]) {
  test(`test invocation removes its private TMP after ${fail ? "failure" : "success"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ralph-sandbox-control-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = join(root, "observed.json");
    const file = join(root, "case.test.mjs");
    await writeFile(
      file,
      `import test from 'node:test'; import {tmpdir} from 'node:os'; import {writeFile} from 'node:fs/promises'; import {join} from 'node:path'; test('fixture',async()=>{ const path=join(tmpdir(),'fixture-file'); await writeFile(path,'owned'); await writeFile(${JSON.stringify(result)},JSON.stringify({path,tmp:tmpdir(),temp:process.env.TEMP})); ${fail ? "throw Error('expected failure');" : ""} });`,
    );
    const child = spawnSync(process.execPath, [resolve("scripts/run-tests.mjs"), file], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, fail ? 1 : 0, child.stderr);
    assert.ok(existsSync(result), "the fixture must run inside the owned TMP sandbox");
    const observed = JSON.parse(await readFile(result, "utf8"));
    assert.equal(observed.tmp, observed.temp);
    assert.notEqual(observed.tmp, tmpdir());
    assert.equal(existsSync(observed.path), false);
    assert.equal(existsSync(observed.tmp), false);
  });
}

test("SIGINT waits for the launched test to exit and removes only its owned TMP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ralph-sandbox-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const barrier = join(root, "ready.json");
  const sentinel = join(root, "outside.txt");
  await writeFile(sentinel, "keep outside evidence");
  const file = join(root, "signal.test.mjs");
  // Publish readiness only after all worker metadata is written.
  await writeFile(
    file,
    `import test from 'node:test';import{tmpdir}from'node:os';import{writeFile,rename}from'node:fs/promises';test('wait',async()=>{const ready=${JSON.stringify(barrier)};await writeFile(ready+'.tmp',JSON.stringify({pid:process.pid,tmp:tmpdir()}));await rename(ready+'.tmp',ready);await new Promise(r=>setTimeout(r,5000));});`,
  );
  const child = spawn(process.execPath, [resolve("scripts/run-tests.mjs"), file], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  const closed = once(child, "close");
  let worker: { pid: number; tmp: string } | undefined;
  const alive = () => {
    if (!worker) return false;
    try {
      process.kill(worker.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await waitFor(() => existsSync(barrier));
    worker = JSON.parse(await readFile(barrier, "utf8"));
    assert.ok(worker);
    assert.ok(existsSync(worker.tmp));
    assert.equal(child.kill("SIGINT"), true);
    const [code, signal] = await closed;
    assert.equal(signal, null);
    assert.equal(code, 130);
    await waitFor(() => !alive(), 2000);
    assert.equal(existsSync(worker.tmp), false);
    assert.equal(await readFile(sentinel, "utf8"), "keep outside evidence");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    // The fixture self-terminates after five seconds even if the control fails.
    await waitFor(() => !alive(), 6000);
  }
});

test("real default discovery excludes the actual launcher and cleans its sandbox", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ralph-discovery-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const launcher = pkg.scripts.test.split(" ")[1] as string;
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, launcher), await readFile(launcher));
  const observed = join(root, "observed.json");
  const sentinel = join(root, "outside.txt");
  const ledger = join(root, "processes.jsonl");
  const guard = join(root, "discovery-guard.cjs");
  await writeFile(sentinel, "outside remains");
  // A future filename regression fails after at most three generations, never a fork storm.
  await writeFile(
    guard,
    `const fs=require('node:fs');const n=Number(process.env.RALPH_DISCOVERY_DEPTH||0)+1;process.env.RALPH_DISCOVERY_DEPTH=String(n);fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,depth:n})+'\\n');if(n>3)process.exit(82);`,
  );
  await writeFile(
    join(root, "fixture.test.mjs"),
    `import test from 'node:test';import{tmpdir}from'node:os';import{writeFile}from'node:fs/promises';test('default fixture',async()=>{await writeFile(${JSON.stringify(observed)},JSON.stringify({tmp:tmpdir(),executed:true}));});`,
  );
  const child = spawn(process.execPath, [join(root, launcher)], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RALPH_DISCOVERY_DEPTH: "0",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(guard)}`,
    },
  });
  let output = "";
  child.stdout.on("data", (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16000);
  });
  child.stderr.on("data", (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16000);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  }, 10000);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(timedOut, false, output);
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    const result = JSON.parse(await readFile(observed, "utf8"));
    assert.equal(result.executed, true);
    assert.equal(existsSync(result.tmp), false);
    const processes = (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(processes.length, 3, "launcher, coordinator and one fixture process only");
    assert.ok(processes.every((entry) => entry.depth <= 3));
    assert.equal(await readFile(sentinel, "utf8"), "outside remains");
  } finally {
    clearTimeout(timer);
  }
});
