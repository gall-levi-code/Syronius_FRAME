import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  container: { type: "string", default: "frame-pipeline-photos" },
  image: { type: "string", default: "node:22.23.2-alpine" },
  output: { type: "string" },
  "self-test": { type: "boolean", default: false },
} });
const marker = ".frame-storage-benchmark-owner";
const label = "frame.storage-benchmark";
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; process.stderr.write(data); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`docker ${args[0]} failed (${code}): ${stderr.trim()}`)));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
}

async function assertScratchOwner(directory, parent, token) {
  assert.equal(path.basename(directory), `.frame-storage-bench-${token}`);
  assert.equal(path.dirname(await realpath(directory)), await realpath(parent));
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(directory, marker), "utf8"), token);
}

async function worker(options) {
  const { mkdir, readdir, readFile, stat, open, rename, rm, realpath, lstat } = await import("node:fs/promises");
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { Transform } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { performance } = await import("node:perf_hooks");
  const path = (await import("node:path")).default;
  const { root, token, photos = 1000, bytes = 50 * 1024 ** 2, rounds = 3, renames = 500, syncWrites = 32 } = options;
  const owner = path.join(root, ".frame-storage-benchmark-owner");
  const dataset = path.join(root, "dataset");
  if (await readFile(owner, "utf8") !== token) throw new Error("Scratch ownership marker does not match.");
  await mkdir(dataset);
  const results = [];
  try {
    const json = JSON.stringify({ processed_at: "2026-09-08T12:00:00.000Z", camera: "Synthetic benchmark", padding: "x".repeat(512) });
    const albums = Array.from({ length: 10 }, (_, i) => path.join(dataset, `album-${i}`));
    for (const album of albums) await mkdir(album);
    for (let i = 0; i < photos; i += 1) {
      const base = path.join(albums[i % albums.length], `photo-${i}`);
      await Promise.all([["json", json], ["txt", "Synthetic camera metadata\n"], ["ready", "ready\n"]].map(async ([extension, contents]) => {
        const file = await open(`${base}.${extension}`, "wx");
        try { await file.writeFile(contents); } finally { await file.close(); }
      }));
    }
    const source = path.join(dataset, "source.bin");
    const destination = path.join(dataset, "copy.bin");
    const block = Buffer.alloc(Math.min(bytes, 256 * 1024), 0x5a);
    const seed = await open(source, "wx");
    const expected = createHash("sha256");
    try {
      for (let remaining = bytes; remaining > 0;) {
        const chunk = block.subarray(0, Math.min(remaining, block.length));
        await seed.writeFile(chunk);
        expected.update(chunk);
        remaining -= chunk.length;
      }
    } finally { await seed.close(); }
    const digest = expected.digest("hex");
    const renameA = path.join(dataset, "rename-a");
    const renameB = path.join(dataset, "rename-b");
    const initial = await open(renameA, "wx");
    await initial.close();
    let currentRename = renameA;
    const operations = {
      async galleryScan() {
        const bases = [];
        for (const album of await readdir(dataset, { withFileTypes: true })) {
          if (!album.isDirectory()) continue;
          const directory = path.join(dataset, album.name);
          for (const name of await readdir(directory)) if (name.endsWith(".ready")) bases.push(path.join(directory, name.slice(0, -6)));
        }
        if (bases.length !== photos) throw new Error("Synthetic gallery count mismatch.");
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(32, bases.length) }, async () => {
          for (let index; (index = cursor++) < bases.length;) {
            const base = bases[index];
            if (JSON.parse(await readFile(`${base}.json`, "utf8")).camera !== "Synthetic benchmark") throw new Error("Sidecar mismatch.");
            if ((await stat(`${base}.ready`)).size !== 6) throw new Error("Ready marker mismatch.");
            if (await readFile(`${base}.txt`, "utf8") !== "Synthetic camera metadata\n") throw new Error("Text mismatch.");
          }
        }));
      },
      async copyHash() {
        const hash = createHash("sha256");
        await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, callback) {
          hash.update(chunk); callback(null, chunk);
        } }), createWriteStream(destination));
        if (hash.digest("hex") !== digest || (await stat(destination)).size !== bytes) throw new Error("Copy/hash mismatch.");
      },
      async atomicRename() {
        for (let i = 0; i < renames; i += 1) {
          const target = currentRename === renameA ? renameB : renameA;
          await rename(currentRename, target);
          currentRename = target;
        }
        if ((await stat(currentRename)).size !== 0) throw new Error("Rename payload mismatch.");
      },
      async fsyncWrite() {
        for (let i = 0; i < syncWrites; i += 1) {
          const file = await open(path.join(dataset, "sync.bin"), "w");
          try { await file.writeFile(Buffer.alloc(4096, 0x5a)); await file.sync(); } finally { await file.close(); }
        }
      },
    };
    for (let round = 0; round <= rounds; round += 1) {
      const measurements = {};
      for (const [name, operation] of Object.entries(operations)) {
        const start = performance.now();
        await operation();
        measurements[name] = performance.now() - start;
      }
      if (round) results.push(measurements);
      console.error(`${options.name ?? "self-test"}: ${round ? `measured run ${round}/${rounds}` : "warmup"} complete`);
    }
    return { node: process.version, platform: process.platform, photos, metadataFiles: photos * 3, readConcurrency: 32, copyBytes: bytes, renames, syncWrites, runs: results };
  } finally {
    if (await readFile(owner, "utf8") !== token || (await lstat(dataset)).isSymbolicLink()
      || path.dirname(await realpath(dataset)) !== await realpath(root)) throw new Error("Refusing cleanup of an unowned scratch directory.");
    await rm(dataset, { recursive: true });
  }
}

async function selfTest() {
  assert.equal(median([9, 1, 5]), 5);
  const parent = await mkdtemp(path.join(os.tmpdir(), "frame-storage-test-"));
  const token = randomUUID();
  const directory = path.join(parent, `.frame-storage-bench-${token}`);
  await mkdir(directory);
  await writeFile(path.join(directory, marker), token);
  try {
    await assert.rejects(assertScratchOwner(directory, parent, "wrong-token"));
    await assertScratchOwner(directory, parent, token);
    const result = await worker({ root: directory, token, photos: 2, bytes: 1024, rounds: 1, renames: 3, syncWrites: 2 });
    assert.equal(result.runs.length, 1);
    assert.ok(Object.values(result.runs[0]).every((value) => Number.isFinite(value) && value >= 0));
    await assert.rejects(lstat(path.join(directory, "dataset")), { code: "ENOENT" });
    await writeFile(path.join(directory, marker), "changed");
    await assert.rejects(assertScratchOwner(directory, parent, token));
    await writeFile(path.join(directory, marker), token);
  } finally {
    await assertScratchOwner(directory, parent, token);
    await rm(directory, { recursive: true });
    await rmdir(parent);
  }
  console.log("Storage benchmark self-check passed.");
}

async function main() {
  const token = randomUUID();
  const mounts = JSON.parse(await docker(["inspect", values.container, "--format", "{{json .Mounts}}"]));
  const mount = mounts.find((entry) => entry.Destination === "/data");
  if (mount?.Type !== "bind") throw new Error("The selected container must bind-mount /data.");
  const parent = await realpath(mount.Source);
  const directory = path.join(parent, `.frame-storage-bench-${token}`);
  if (directory.includes(",")) throw new Error("Docker --mount does not accept a comma in this scratch path.");
  const image = JSON.parse(await docker(["image", "inspect", values.image]))[0];
  const volume = `frame-storage-bench-${token}`;
  const container = `frame-storage-bench-${token}`;
  console.error(`Scratch directory: ${directory}\nScratch volume/container: ${volume}`);
  let scratchCreated = false;
  let volumeCreated = false;
  const report = { measuredAt: new Date().toISOString(), bindSource: parent, image: values.image, imageId: image.Id,
    docker: JSON.parse(await docker(["info", "--format", "{{json .}}"])).OperatingSystem, backends: {} };
  const removeScratch = async () => {
    await assertScratchOwner(directory, parent, token);
    await rm(directory, { recursive: true });
    scratchCreated = false;
  };
  try {
    await mkdir(directory);
    await writeFile(path.join(directory, marker), token);
    scratchCreated = true;
    for (const name of ["windowsBind", "namedVolume"]) {
      if (name === "namedVolume") {
        await docker(["volume", "create", "--label", `${label}=${token}`, volume]);
        volumeCreated = true;
      }
      const options = { root: "/probe", token, name };
      const script = `import {writeFile} from 'node:fs/promises';\n${name === "namedVolume" ? `await writeFile('/probe/${marker}', ${JSON.stringify(token)}, {flag:'wx'});\n` : ""}
        if(!process.version.startsWith('v22.')) throw new Error('Use a Node 22 image.');
        const result=await (${worker.toString()})(${JSON.stringify(options)}); console.log(JSON.stringify(result));`;
      const result = JSON.parse(await docker(["run", "--rm", "-i", "--pull=never", "--name", container,
        "--label", `${label}=${token}`, "--network", "none", "--read-only", "--memory", "512m", "--pids-limit", "64",
        "--mount", name === "windowsBind" ? `type=bind,source=${directory},target=/probe` : `type=volume,source=${volume},target=/probe`,
        image.Id, "node", "--input-type=module"], script));
      report.backends[name] = { ...result, medianMs: Object.fromEntries(Object.keys(result.runs[0]).map((key) => [key, median(result.runs.map((run) => run[key]))])) };
      if (name === "windowsBind") await removeScratch();
    }
  } finally {
    const containers = await docker(["container", "ls", "--all", "--filter", `label=${label}=${token}`, "--format", "{{.Names}}"]);
    if (containers.split("\n").includes(container)) await docker(["rm", "--force", container]);
    if (scratchCreated) await removeScratch();
    if (volumeCreated) {
      const owned = JSON.parse(await docker(["volume", "inspect", volume]))[0];
      assert.equal(owned.Name, volume);
      assert.equal(owned.Labels[label], token);
      await docker(["volume", "rm", volume]);
    }
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) await writeFile(values.output, output, { flag: "wx" });
  process.stdout.write(output);
}

try { await (values["self-test"] ? selfTest() : main()); }
catch (error) { console.error(error); process.exitCode = 1; }
