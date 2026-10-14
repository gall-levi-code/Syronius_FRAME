import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function checkArtifacts({ directory, version, platform, arch }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version || "")
    || !["win", "linux", "mac"].includes(platform) || !["x64", ...(platform === "mac" ? ["arm64"] : [])].includes(arch)) {
    throw new Error("Choose a supported launcher package version, platform, and architecture.");
  }
  const suffix = platform === "linux" ? "x86_64" : arch;
  const extensions = { win: ["exe"], linux: ["AppImage"], mac: ["dmg", "zip"] }[platform];
  const expected = extensions.map((extension) => `FRAME-Setup-${version}-${platform}-${suffix}.${extension}`).sort();
  const actual = (await readdir(directory)).filter((name) => /\.(exe|AppImage|dmg|zip)$/.test(name)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Installer artifacts do not match this build. Expected: ${expected.join(", ")}. Clean stale output and rebuild.`);
  const artifacts = [];
  for (const name of expected) {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.size === 0) throw new Error(`Installer artifact is empty or is not a regular file: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    artifacts.push({ name, bytes: info.size, sha256: hash.digest("hex") });
  }
  return { version, platform, arch, artifacts, scope: "Package filenames, nonempty regular files, and SHA-256 only; signing and downloaded-package acceptance are not established." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const [platform, arch] = process.argv.slice(2);
  const directory = path.resolve(import.meta.dirname, "../release");
  const report = await checkArtifacts({ directory, version: metadata.version, platform, arch });
  await writeFile(path.join(directory, `SHA256SUMS-${platform}-${arch}.txt`), report.artifacts.map((item) => `${item.sha256}  ${item.name}\n`).join(""));
  await writeFile(path.join(directory, `artifact-check-${platform}-${arch}.json`), `${JSON.stringify({ ...report, frameReleaseTag: metadata.frameReleaseTag }, null, 2)}\n`);
  console.log(`Verified ${report.artifacts.length} ${platform}/${arch} candidate packages; SHA-256 checksums written. Native release acceptance remains required.`);
}
