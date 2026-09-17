import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseEnv } from "../installer/frame-env.mjs";

const execFileAsync = promisify(execFile);

test("shared environment parser preserves quotes, escapes, literal shell text and duplicate settings", () => {
  assert.deepEqual(parseEnv([
    " # comment", "ignored", "=ignored", "EMPTY=", "DUPLICATE=first", "DUPLICATE=last",
    `JSON=${JSON.stringify('line\nwith "quotes"')}`,
    "SINGLE='literal $HOME # comment'", "PLAIN=$(do-not-execute)=value", 'FALLBACK="invalid\\q"',
  ].join("\r\n")), {
    EMPTY: "", DUPLICATE: "last", JSON: 'line\nwith "quotes"',
    SINGLE: "literal $HOME # comment", PLAIN: "$(do-not-execute)=value", FALLBACK: "invalid\\q",
  });
});

test("host installer uses its explicit workspace for configuration, credentials and update commands", async (t) => {
  const { workspace, run } = await createRuntime(t);
  await run("install", "--data-root", "./FRAME data");
  const configPath = path.join(workspace, "FRAME data", "state", "stack-config.json");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "LAN");
  assert.equal(await readFile(path.join(workspace, "docker-compose.yml"), "utf8"),
    await readFile(new URL("../installer/templates/docker-compose.yml", import.meta.url), "utf8"));
  assert.match((await run("validate")).stdout, /valid for installation/);
  await assert.rejects(run("validate", "--for-start"), /PORTAL_USERNAME and PORTAL_PASSWORD/);
  const credentials = run("set-portal-auth");
  credentials.child.stdin.end("frame-user\na password with spaces\n");
  await credentials;
  await run("install");
  assert.match((await run("validate", "--for-start")).stdout, /valid for startup/);
  assert.match(await readFile(path.join(workspace, ".env"), "utf8"), /^PORTAL_PASSWORD="a password with spaces"$/m);

  const stateDirectory = path.dirname(configPath);
  const buildId = "a".repeat(40);
  await writeFile(path.join(stateDirectory, "pending-source-update.json"), JSON.stringify({ schema_version: 1, build_id: buildId }));
  await run("finalize-source-update");
  assert.equal(JSON.parse(await readFile(path.join(stateDirectory, "installed-build.json"), "utf8")).build_id, buildId);
  await assert.rejects(readFile(path.join(stateDirectory, "pending-source-update.json")), { code: "ENOENT" });
  await writeFile(path.join(workspace, "invalid-release.json"), "{}");
  await assert.rejects(run("source-update", "--image-manifest", "invalid-release.json"), /Invalid FRAME release manifest/);
});

test("host installer uses absolute data paths directly and preserves an explicit container mount", async (t) => {
  const { workspace, run } = await createRuntime(t);
  const dataRoot = path.join(path.dirname(workspace), "external FRAME data");
  await run("install", "--data-root", dataRoot);
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, "state", "stack-config.json"), "utf8")).mode, "LAN");
  assert.match((await run("validate")).stdout, /valid for installation/);

  const buildId = "b".repeat(40);
  await writeFile(path.join(dataRoot, "state", "pending-source-update.json"), JSON.stringify({ schema_version: 1, build_id: buildId }));
  const containerEnv = { ...process.env };
  delete containerEnv.FRAME_WORKSPACE;
  delete containerEnv.FRAME_INSTALLER_DATA_ROOT;
  await assert.rejects(execFileAsync(process.execPath, ["--input-type=module", "--eval",
    `import { finalizeSourceUpdate } from ${JSON.stringify(new URL("../installer/frame-updater.mjs", import.meta.url).href)};
     await finalizeSourceUpdate({ workspace: process.argv[1] });`, workspace,
  ], { env: containerEnv }), /external FRAME_DATA_ROOT is not mounted/);
  await run("finalize-source-update");
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, "state", "installed-build.json"), "utf8")).build_id, buildId);

  const mountedRoot = path.join(path.dirname(workspace), "mounted FRAME data");
  const mountedRun = runtimeRunner(workspace, { FRAME_INSTALLER_DATA_ROOT: mountedRoot });
  await mountedRun("install", "--enable", "frame-audio-relay");
  assert.equal(JSON.parse(await readFile(path.join(mountedRoot, "state", "stack-config.json"), "utf8")).capabilities["frame-audio-relay"], true);
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, "state", "stack-config.json"), "utf8")).capabilities["frame-audio-relay"], false);
  assert.match((await mountedRun("validate")).stdout, /valid for installation/);
  await writeFile(path.join(mountedRoot, "state", "pending-source-update.json"), JSON.stringify({ schema_version: 1, build_id: "c".repeat(40) }));
  await mountedRun("finalize-source-update");
  assert.equal(JSON.parse(await readFile(path.join(mountedRoot, "state", "installed-build.json"), "utf8")).build_id, "c".repeat(40));
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, "state", "installed-build.json"), "utf8")).build_id, buildId);
});

test("host installer rejects empty and relative workspace overrides before writing files", async (t) => {
  const { workspace } = await createRuntime(t);
  for (const value of ["", "relative-directory"]) {
    await assert.rejects(runtimeRunner(workspace, { FRAME_WORKSPACE: value })("install"), /FRAME_WORKSPACE must be an absolute path/);
  }
  await assert.rejects(readFile(path.join(workspace, ".env")), { code: "ENOENT" });
});

test("configuration permits TCP/UDP reuse and rejects active same-protocol and FTP-range collisions", async (t) => {
  const { workspace, run } = await createRuntime(t);
  await run("install", "--enable", "frame-video-relay", "--enable", "frame-photo-ftp", "--set", "SRTLA_PORT=3730");
  await run("validate");
  await assert.rejects(run("install", "--set", "SRT_PLAYER_PORT=3730"), /3730\/udp conflicts with SRTLA ingest/);
  await assert.rejects(run("install", "--edge-http-port", "3730"), /3730\/tcp conflicts with FRAME Edge/);
  await assert.rejects(run("install", "--set", "PHOTO_FTP_PASSIVE_MIN=3730"), /3730\/tcp conflicts with Portal/);
  await run("install", "--set", "SRTLA_PORT=30000");
  await run("validate");
  const envPath = path.join(workspace, ".env");
  const saved = await readFile(envPath, "utf8");
  await writeFile(envPath, saved.replace("PHOTO_FTP_PASSIVE_MIN=30000", "PHOTO_FTP_PASSIVE_MIN=3730"));
  await assert.rejects(run("validate"), /3730\/tcp conflicts with Portal/);
  await run("install", "--disable", "frame-photo-ftp");
  await run("validate");
});

async function createRuntime(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "FRAME host runtime "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "installation with spaces");
  await mkdir(path.join(workspace, "installer", "templates"), { recursive: true });
  await mkdir(path.join(workspace, "config"));
  await copyFile(new URL("../config/frame-services.json", import.meta.url), path.join(workspace, "config", "frame-services.json"));
  for (const file of ["frame-installer.mjs", "frame-contract.mjs", "frame-env.mjs", "frame-updater.mjs", "frame-release.mjs", "templates/docker-compose.yml"]) {
    await copyFile(new URL(`../installer/${file}`, import.meta.url), path.join(workspace, "installer", file));
  }
  return { workspace, run: runtimeRunner(workspace) };
}

function runtimeRunner(workspace, overrides = {}) {
  const env = { ...process.env, FRAME_WORKSPACE: workspace };
  delete env.FRAME_INSTALLER_DATA_ROOT;
  return (...args) => execFileAsync(process.execPath, [path.join(workspace, "installer", "frame-installer.mjs"), ...args], {
    cwd: path.dirname(workspace),
    env: { ...env, ...overrides },
  });
}
