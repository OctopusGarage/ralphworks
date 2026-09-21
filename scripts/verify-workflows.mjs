import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { initProject } from "../src/init.ts";

const run = promisify(execFile);
const version = "1.7.12";
const checksums = {
  "darwin-arm64": "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  "darwin-x64": "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  "linux-arm64": "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
  "linux-x64": "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
};

const platform = `${process.platform}-${process.arch}`;
const expected = checksums[platform];
if (!expected) throw new Error(`Unsupported actionlint platform: ${platform}`);

const root = resolve(import.meta.dirname, "..");
const cacheRoot = join(homedir(), ".cache", "ralphworks", "actionlint");
const cache = join(cacheRoot, `${version}-${platform}`);
const binary = join(cache, "actionlint");
const generated = await mkdtemp(join(tmpdir(), "ralphworks-workflows-"));

try {
  try {
    await run(binary, ["-version"]);
  } catch {
    const assetPlatform = process.arch === "x64" ? "amd64" : process.arch;
    const asset = `actionlint_${version}_${process.platform}_${assetPlatform}.tar.gz`;
    const response = await fetch(`https://github.com/rhysd/actionlint/releases/download/v${version}/${asset}`);
    if (!response.ok) throw new Error(`Failed to download ${asset}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}`);
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(cacheRoot, ".install-"));
    try {
      const archivePath = join(staging, asset);
      await writeFile(archivePath, archive);
      await run("tar", ["-xzf", archivePath, "-C", staging, "actionlint"]);
      try {
        await rename(staging, cache);
      } catch (error) {
        await run(binary, ["-version"]).catch(() => {
          throw error;
        });
        await rm(staging, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  await initProject(generated);
  const tracked = join(root, ".github", "workflows");
  const files = [tracked, join(generated, ".github", "workflows")];
  const paths = (
    await Promise.all(
      files.map(async (directory) =>
        (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).map((file) => join(directory, file)),
      ),
    )
  ).flat();
  await run(binary, paths, { cwd: root });
  console.log(`Validated ${paths.length} workflow files with actionlint v${version}`);
} finally {
  await rm(generated, { recursive: true, force: true });
}
