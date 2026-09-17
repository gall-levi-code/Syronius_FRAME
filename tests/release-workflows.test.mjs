import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FRAME_IMAGE_SERVICES, RELEASE_IMAGE_PREFIX } from "../installer/frame-release.mjs";

const commit = "c".repeat(40);
const service = FRAME_IMAGE_SERVICES[0];
const imageRef = `${RELEASE_IMAGE_PREFIX}/${service}:${commit}`;
const imageId = `sha256:${"d".repeat(64)}`;
const registryRef = `${RELEASE_IMAGE_PREFIX}/${service}@sha256:${"e".repeat(64)}`;

async function inline(workflow, marker) {
  const source = await readFile(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
  const script = [...source.matchAll(/^\s*node --input-type=module <<'NODE'\r?\n([\s\S]*?)^\s*NODE\s*$/gm)]
    .map((match) => match[1].replace(/^ {10}/gm, "")).find((body) => body.includes(marker));
  assert.ok(script, `Missing workflow operation: ${marker}`);
  return script;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-release-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(path.join(root, "installer")), mkdir(path.join(root, "image-artifact")), mkdir(path.join(root, "digests"))]);
  await copyFile(new URL("../installer/frame-release.mjs", import.meta.url), path.join(root, "installer", "frame-release.mjs"));
  const mock = path.join(root, "inspect-only.cjs");
  await writeFile(mock, `
const childProcess = require("node:child_process");
childProcess.execFileSync = (command, args) => {
  if (command === "docker" && args[0] === "image" && args[1] === "inspect") return process.env.TEST_IMAGE;
  if (command === "git" && args[0] === "rev-parse") return args.includes("--verify") ? process.env.TEST_TAG_COMMIT : process.env.TEST_HEAD_COMMIT;
  throw new Error("Unexpected command in isolated workflow test: " + command);
};
require("node:module").syncBuiltinESMExports();
`);
  const image = { Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [registryRef] };
  return {
    root,
    image,
    run(script, env = {}) {
      return spawnSync(process.execPath, ["--require", mock, "--input-type=module"], {
        cwd: root, input: script, encoding: "utf8", timeout: 5000,
        env: {
          ...process.env, SERVICE: service, SOURCE_COMMIT: commit, IMAGE_PREFIX: RELEASE_IMAGE_PREFIX,
          IMAGE: imageRef, VERSION_TAG: "", RELEASE_TAG: "", GITHUB_OUTPUT: path.join(root, "outputs"),
          TEST_HEAD_COMMIT: commit, TEST_TAG_COMMIT: commit, TEST_IMAGE: JSON.stringify([image]), ...env,
        },
      });
    },
  };
}

test("release planning uses the actual checked-out tag commit and the canonical image matrix", async (t) => {
  const setup = await fixture(t);
  const script = await inline("build-images.yml", "const commit =");
  const result = setup.run(script, { RELEASE_TAG: "v1.0.0-Alpha", GITHUB_SHA: "a".repeat(40) });
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries((await readFile(path.join(setup.root, "outputs"), "utf8")).trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(outputs.commit, commit);
  assert.deepEqual(JSON.parse(outputs.services), FRAME_IMAGE_SERVICES);
  assert.equal(FRAME_IMAGE_SERVICES.length, 13);
  assert.equal(outputs.prefix, RELEASE_IMAGE_PREFIX);
  assert.notEqual(setup.run(script, { RELEASE_TAG: "v1.0.0-Alpha", TEST_TAG_COMMIT: "b".repeat(40) }).status, 0);
});

test("publishing validates the tested artifact identity and records only its own registry digest", async (t) => {
  const setup = await fixture(t);
  await writeFile(path.join(setup.root, "image-artifact", "metadata.json"), JSON.stringify({
    commit, service, image: imageRef, image_id: imageId,
  }));
  const check = await inline("release-images.yml", "const metadata =");
  assert.equal(setup.run(check).status, 0);
  for (const image of [{ ...setup.image, Id: `sha256:${"f".repeat(64)}` }, { ...setup.image, Architecture: "arm64" }]) {
    assert.notEqual(setup.run(check, { TEST_IMAGE: JSON.stringify([image]) }).status, 0);
  }
  assert.notEqual(setup.run(check, { SOURCE_COMMIT: "a".repeat(40) }).status, 0);
  const record = await inline("release-images.yml", "const reference =");
  assert.equal(setup.run(record).status, 0);
  assert.equal(JSON.parse(await readFile(path.join(setup.root, "digests", `${service}.json`))).image, registryRef);
  for (const reference of [`ghcr.io/other/project@sha256:${"e".repeat(64)}`, `${registryRef}0`, `${RELEASE_IMAGE_PREFIX}/${service}@sha256:bad@sha256:${"e".repeat(64)}`]) {
    const invalid = { ...setup.image, RepoDigests: [reference] };
    assert.notEqual(setup.run(record, { TEST_IMAGE: JSON.stringify([invalid]) }).status, 0);
  }
});

test("release manifest merging requires all 13 unique image results from one source commit", async (t) => {
  const setup = await fixture(t);
  const script = await inline("release-images.yml", "const manifest =");
  const records = FRAME_IMAGE_SERVICES.map((name) => ({ commit, service: name, image: `${RELEASE_IMAGE_PREFIX}/${name}@sha256:${"e".repeat(64)}` }));
  const save = (record, index) => writeFile(path.join(setup.root, "digests", `${FRAME_IMAGE_SERVICES[index]}.json`), JSON.stringify(record));
  await Promise.all(records.map(save));
  const valid = setup.run(script);
  assert.equal(valid.status, 0, valid.stderr);
  const output = path.join(setup.root, "frame-images.json");
  const manifest = JSON.parse(await readFile(output));
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.platform, "linux/amd64");
  assert.equal(Object.keys(manifest.images).length, 13);
  await rm(output);
  for (const invalid of [{ ...records[0], commit: "a".repeat(40) }, records[1]]) {
    await save(invalid, 0);
    assert.notEqual(setup.run(script).status, 0);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  await save(records[0], 0);
  await rm(path.join(setup.root, "digests", `${service}.json`));
  assert.notEqual(setup.run(script).status, 0);
  await assert.rejects(readFile(output), { code: "ENOENT" });
});
