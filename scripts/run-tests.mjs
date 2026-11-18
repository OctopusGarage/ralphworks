import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One invocation owns one temporary tree, including fixtures created by child CLIs.
// Short POSIX roots leave room for macOS's 104-byte Unix socket paths, even in nested invocations.
const temporary = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "rw-")));
let child;
let forceTimer;
let interrupted;
const stop = (signal) => {
  interrupted = signal;
  child?.kill(signal);
  forceTimer ??= setTimeout(() => child?.kill("SIGKILL"), 2000);
  forceTimer.unref();
};
const onInterrupt = () => stop("SIGINT");
const onTerminate = () => stop("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
try {
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  // A launcher regression may itself run under node:test; this is a fresh invocation.
  delete env.NODE_TEST_CONTEXT;
  child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });
  const [code, signal] = await once(child, "close");
  process.exitCode =
    interrupted === "SIGINT" || signal === "SIGINT" ? 130 : interrupted === "SIGTERM" || signal === "SIGTERM" ? 143 : (code ?? 1);
} finally {
  clearTimeout(forceTimer);
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  await rm(temporary, { recursive: true, force: true });
}
