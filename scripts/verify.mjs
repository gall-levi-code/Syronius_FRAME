import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

run(process.execPath, ["--test", "tests/frame-contract.test.mjs"], "contract and behavior tests");

const syntaxFiles = [
  "installer/frame-installer.mjs",
  "installer/frame-contract.mjs",
  ...(await findJavaScriptFiles(path.join(root, "services"))),
  ...(await findJavaScriptFiles(path.join(root, "apps"))),
].filter((file) => !file.includes(`${path.sep}dist${path.sep}`));

for (const file of syntaxFiles) {
  run(process.execPath, ["--check", file], `syntax check: ${path.relative(root, file)}`);
}

console.log(`FRAME verification passed: tests plus ${syntaxFiles.length} JavaScript syntax checks.`);

async function findJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJavaScriptFiles(fullPath)));
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      files.push(fullPath);
    }
  }
  return files;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}
