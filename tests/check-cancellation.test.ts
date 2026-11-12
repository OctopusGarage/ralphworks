import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCheck } from "../src/check-runner.ts";

const exec = promisify(execFile);

test("cancelled checks do not leave TERM-ignoring descendants after the parent closes its pipes", {
  skip: process.platform === "win32",
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ralphworks-cancel-group-"));
  const grandchild =
    "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)";
  const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});c.unref();setInterval(()=>{},1000)`;
  const command = `${JSON.stringify(process.execPath)} -e '${parent.replaceAll("'", "'\\''")}'`;
  const abort = new AbortController();
  const pending = runCheck(command, cwd, 10000, abort.signal);
  let pid: number | undefined;
  try {
    for (
      let i = 0;
      i < 300 &&
      !(await stat(join(cwd, "child.pid")).then(
        () => true,
        () => false,
      ));
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    pid = Number(await readFile(join(cwd, "child.pid"), "utf8"));
    abort.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    let live = true;
    for (let i = 0; i < 30 && live; i++) {
      live = await exec("ps", ["-p", String(pid), "-o", "stat="]).then(
        (r) => !r.stdout.trim().startsWith("Z"),
        () => false,
      );
      if (live) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(live, false, "the check returned while its TERM-ignoring child could still run");
  } finally {
    abort.abort();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await pending;
  }
});
