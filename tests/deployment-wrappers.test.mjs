import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const imageIds = { "frame-auth": `sha256:${"a".repeat(64)}`, "frame-portal": `sha256:${"b".repeat(64)}` };
const releaseModule = new URL("../installer/frame-release.mjs", import.meta.url).href;
const shells = process.platform === "win32"
  ? [
    { name: "PowerShell", command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"], file: "stack.ps1" },
    { name: "POSIX", command: "C:/Program Files/Git/bin/bash.exe", args: ["--noprofile", "--norc"], file: "stack.sh" },
  ]
  : [{ name: "POSIX", command: "/bin/sh", args: [], file: "stack.sh" }];

// This executable replaces Docker entirely. Its installer commands use the real
// snapshot helpers; no test can pull, build, stop, or restart a real container.
const fakeDocker = String.raw`
import fs from "node:fs";
import path from "node:path";
const { snapshotDeployment, restoreDeployment, completeDeployment } = await import(process.env.FRAME_TEST_RELEASE_MODULE);
const root = process.env.FRAME_TEST_ROOT;
const scenario = JSON.parse(fs.readFileSync(path.join(root, "scenario.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify(args) + "\n");
const dataRoot = path.join(root, "data");
const compose = { name: "syronius-frame", services: {
  "frame-auth": { image: "previous-auth:local", build: { context: root }, environment: { SECRET: "literal$dollar", UNICODE: "café_日本語" } },
  "frame-portal": { image: "previous-portal:local", profiles: ["optional"], depends_on: { "frame-auth": { condition: "service_started" } } }
} };
const ids = { "frame-auth": "sha256:" + "a".repeat(64), "frame-portal": "sha256:" + "b".repeat(64) };
if (args[0] === "ps") {
  if (!scenario.firstInstall) process.stdout.write("fixture-auth\nfixture-portal\n");
} else if (args[0] === "inspect") {
  for (const [service, image] of Object.entries(ids)) {
    process.stdout.write(args.includes("{{.Image}} {{json .Config.Labels}}")
      ? image + " " + JSON.stringify({ "com.docker.compose.service": service }) + "\n"
      : JSON.stringify(service) + ":" + JSON.stringify(image) + ",\n");
  }
} else if (args[0] === "compose") {
  if (args.includes("config") && args.includes("json")) process.stdout.write(JSON.stringify(compose));
  if (args.includes("pull") && scenario.pullFailure) process.exitCode = 23;
  if (args.includes("up")) {
    const recovery = args.some((arg) => arg.includes(".frame-deployment-backup"));
    if ((!recovery && scenario.healthFailure) || (recovery && scenario.recoveryFailure)) process.exitCode = 24;
  }
} else if (args[0] === "run") {
  const command = args[args.indexOf("installer/frame-installer.mjs") + 1];
  if (command === "deployment-snapshot") {
    const input = JSON.parse(fs.readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
    await snapshotDeployment({ workspace: root, dataRoot, ...input });
  } else if (command === "deployment-restore") {
    await restoreDeployment({ workspace: root, dataRoot });
  } else if (command === "deployment-complete") {
    await completeDeployment(root);
  } else if (command === "install") {
    fs.writeFileSync(path.join(root, "docker-compose.yml"), JSON.stringify(compose));
    const nextDataRoot = scenario.changeDataRoot ? path.join(root, "new-data") : dataRoot;
    fs.mkdirSync(nextDataRoot, { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "FRAME_MODE=LAN\nFRAME_DATA_ROOT=" + nextDataRoot.replaceAll("\\", "/") + "\nGENERATION=candidate\n");
    fs.writeFileSync(path.join(dataRoot, "state", "public-routes.yml"), "candidate routes\n");
  }
}
`;

for (const shell of shells) {
  test(`${shell.name} deployment wrapper recovery`, async (t) => {
    try {
      await exec(shell.command, shell.name === "PowerShell" ? ["-NoProfile", "-Command", "exit 0"] : ["-c", "exit 0"]);
    } catch {
      t.skip(`${shell.name} is unavailable`);
      return;
    }
    for (const scenario of [
      { name: "source success" },
      { name: "release success", release: true },
      { name: "release pull failure", release: true, pullFailure: true },
      { name: "host preflight blocks before image pull", release: true, preflightFailAt: 1 },
      { name: "late host preflight blocks before container replacement", release: true, preflightFailAt: 2 },
      { name: "failed health restores exact images", release: true, healthFailure: true },
      { name: "failed initial health stops only the candidate", release: true, healthFailure: true, firstInstall: true },
      { name: "failed recovery retains pending backup", healthFailure: true, recoveryFailure: true },
      { name: "recovery mounts the original external data root", healthFailure: true, changeDataRoot: true },
      { name: "configure before failed start preserves the old running configuration", configure: true, healthFailure: true },
      { name: "manual recovery", recover: true },
      { name: "update forwards manifest and preserves nested snapshot", release: true, update: true },
    ]) {
      await t.test(scenario.name, async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "frame wrapper "));
        t.after(() => rm(root, { recursive: true, force: true }));
        await mkdir(path.join(root, "installer"));
        await mkdir(path.join(root, "bin"));
        await mkdir(path.join(root, "data", "state"), { recursive: true });
        await writeFile(path.join(root, "scenario.json"), JSON.stringify(scenario));
        await writeFile(path.join(root, "commands.jsonl"), "");
        await writeFile(path.join(root, "fake-docker.mjs"), fakeDocker);
        const preflightScript = path.join(root, "fake preflight.mjs");
        await writeFile(preflightScript, `import fs from "node:fs";
import path from "node:path";
const root = process.env.FRAME_TEST_ROOT;
const file = path.join(root, "commands.jsonl");
const previous = fs.readFileSync(file, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(file, JSON.stringify(["host-preflight", process.argv[2], process.env.ELECTRON_RUN_AS_NODE]) + "\\n");
const scenario = JSON.parse(fs.readFileSync(path.join(root, "scenario.json"), "utf8"));
if (previous.filter((args) => args[0] === "host-preflight").length + 1 === scenario.preflightFailAt) process.exitCode = 29;
`);
        const nodePath = process.execPath.replaceAll("\\", "/");
        const fakePath = path.join(root, "fake-docker.mjs").replaceAll("\\", "/");
        await writeFile(path.join(root, "bin", "docker"), `#!/bin/sh\nexec '${nodePath.replaceAll("'", "'\\''")}' -- '${fakePath.replaceAll("'", "'\\''")}' "$@"\n`);
        await chmod(path.join(root, "bin", "docker"), 0o755);
        await writeFile(path.join(root, "bin", "docker.cmd"), `@echo off\r\n"${process.execPath}" -- "${path.join(root, "fake-docker.mjs")}" %*\r\n`);
        for (const file of ["stack.ps1", "stack.sh"]) {
          let source = (await readFile(new URL(`../installer/${file}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
          source = file.endsWith("ps1")
            ? source.replace('if ($Command -notin @(', 'function Start-FrameDiscovery {}\n\nif ($Command -notin @(')
            : source.replace('\nassert_docker\n', '\nstart_frame_discovery() { :; }\nassert_docker\n');
          await writeFile(path.join(root, "installer", file), source);
        }
        for (const file of ["stack.cmd", "stack.sh"]) {
          await writeFile(path.join(root, file), (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n"));
        }
        const oldEnv = `FRAME_MODE=LAN\nFRAME_DATA_ROOT=${path.join(root, "data").replaceAll("\\", "/")}\nGENERATION=previous\n`;
        if (!scenario.firstInstall) {
          await writeFile(path.join(root, ".env"), oldEnv);
          await writeFile(path.join(root, "docker-compose.yml"), "previous compose\n");
          await writeFile(path.join(root, "data", "state", "public-routes.yml"), "previous routes\n");
        }
        if (scenario.release) await writeFile(path.join(root, "docker-compose.release.json"), '{"services":{}}');
        const env = { ...process.env, FRAME_TEST_ROOT: root, FRAME_TEST_RELEASE_MODULE: releaseModule, MSYS_NO_PATHCONV: "1" };
        delete env.FRAME_PREFLIGHT_NODE;
        delete env.FRAME_PREFLIGHT_SCRIPT;
        if (scenario.preflightFailAt) {
          env.FRAME_PREFLIGHT_NODE = process.execPath.replaceAll("\\", "/");
          env.FRAME_PREFLIGHT_SCRIPT = preflightScript.replaceAll("\\", "/");
        }
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
        env[pathKey] = `${path.join(root, "bin")}${path.delimiter}${env[pathKey] ?? ""}`;
        const run = (command, ...args) => exec(shell.command, [...shell.args, path.join(root, "installer", shell.file), command, ...args], { env, cwd: root, timeout: 30_000, windowsHide: true });
        if (scenario.recover) await run("start");
        if (scenario.configure) await run("install");
        const result = await run(scenario.recover ? "recover" : scenario.update ? "update" : "start", ...(scenario.update ? ["--image-manifest", "next release.json"] : [])).then((value) => ({ ...value, code: 0 }), (error) => error);
        const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
        const compose = commands.filter((args) => args[0] === "compose");
        for (const snapshotConfig of compose.filter((args) => args.includes("config") && args.includes("json"))) {
          assert.equal(snapshotConfig[snapshotConfig.indexOf("--profile") + 1], "*", "snapshots must retain definitions for every running profile");
        }
        const ups = compose.filter((args) => args.includes("up"));
        const candidateUps = ups.filter((args) => !args.some((arg) => arg.includes(".frame-deployment-backup")));
        const recoveryUps = ups.filter((args) => args.some((arg) => arg.includes(".frame-deployment-backup")));
        const failed = scenario.pullFailure || scenario.healthFailure || scenario.preflightFailAt;
        assert.equal(result.code === 0, !failed, result.stderr || result.stdout);
        assert.ok(!commands.some((args) => args.includes("down")), "recovery must not remove volumes or the complete project");
        if (scenario.pullFailure) {
          assert.equal(ups.length, 0, "pull failure must not recreate the running stack");
          assert.equal(compose.filter((args) => args.includes("stop")).length, 0, "pull failure must leave running containers alone");
        }
        if (scenario.preflightFailAt) {
          const gates = commands.filter((args) => args[0] === "host-preflight");
          assert.equal(gates.length, scenario.preflightFailAt);
          assert.ok(gates.every((args) => args[2] === "1"), "the packaged Electron executable must run as Node");
          assert.equal(ups.length, 0, "failed host validation must not create or replace containers");
          assert.equal(compose.filter((args) => args.includes("stop")).length, 0, "failed host validation must leave the running stack alone");
          assert.equal(compose.filter((args) => args.includes("pull")).length, scenario.preflightFailAt - 1);
          assert.ok(!compose.some((args) => args.includes("build")));
        }
        if (scenario.firstInstall) {
          assert.equal(compose.filter((args) => args.includes("stop")).length, 1);
          assert.equal(recoveryUps.length, 0);
          await assert.rejects(access(path.join(root, "docker-compose.yml")));
        } else if (scenario.healthFailure || scenario.recover) {
          assert.equal(recoveryUps.length, 1);
          const recovery = JSON.parse(await readFile(path.join(root, ".frame-deployment-backup", "compose.json"), "utf8"));
          assert.deepEqual(Object.fromEntries(Object.entries(recovery.services).map(([service, config]) => [service, config.image])), imageIds);
          assert.equal(recovery.services["frame-auth"].environment.UNICODE, "café_日本語", "snapshot pipes must preserve UTF-8 values");
          assert.ok(recoveryUps[0].includes("--no-build") && recoveryUps[0].includes("never") && recoveryUps[0].includes("--wait"));
        }
        if ((failed || scenario.recover) && !scenario.firstInstall) {
          assert.equal(await readFile(path.join(root, ".env"), "utf8"), oldEnv);
          assert.equal(await readFile(path.join(root, "data", "state", "public-routes.yml"), "utf8"), "previous routes\n");
        }
        if (scenario.release && !scenario.pullFailure && !scenario.preflightFailAt) {
          assert.ok(candidateUps.every((args) => args.includes("--no-build") && !args.includes("--build")));
          assert.ok(candidateUps.every((args) => args.some((arg) => arg.endsWith("docker-compose.release.json"))));
          assert.ok(compose.findIndex((args) => args.includes("pull")) < compose.findIndex((args) => args.includes("up")));
        } else if (!scenario.pullFailure) {
          assert.ok(candidateUps.every((args) => args.includes("--build")));
        }
        if (scenario.update) {
          const sourceUpdate = commands.find((args) => args.includes("source-update"));
          assert.deepEqual(sourceUpdate.slice(-3), ["source-update", "--image-manifest", "next release.json"]);
          assert.equal(commands.filter((args) => args.includes("deployment-snapshot")).length, 1);
        }
        if (scenario.configure) {
          const snapshotIndex = commands.findIndex((args) => args.includes("deployment-snapshot"));
          const installIndex = commands.findIndex((args) => args.includes("install"));
          assert.ok(snapshotIndex >= 0 && snapshotIndex < installIndex, "snapshot must precede configuration writes");
          assert.equal(commands.filter((args) => args.includes("deployment-snapshot")).length, 1, "start must retain the snapshot captured before configuration");
        }
        if (scenario.changeDataRoot) {
          const restoration = commands.find((args) => args.includes("deployment-restore"));
          const mounts = restoration.filter((arg) => arg.startsWith("type=bind,source=")).map((arg) => arg.replaceAll("\\", "/"));
          assert.ok(mounts.includes(`type=bind,source=${path.join(root, "data").replaceAll("\\", "/")},target=/frame-data`));
          assert.ok(!mounts.some((arg) => arg.includes("new-data")));
        }
        const snapshot = JSON.parse(await readFile(path.join(root, ".frame-deployment-backup", "snapshot.json"), "utf8"));
        assert.equal(snapshot.pending, Boolean(scenario.recoveryFailure));
      });
    }
  });
}
