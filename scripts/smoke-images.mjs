import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { FRAME_IMAGE_SERVICES } from "../installer/frame-release.mjs";

const runFile = promisify(execFile);
const ownerLabel = "frame.image-smoke";
const services = FRAME_IMAGE_SERVICES;
const ports = { "frame-audio-bridge": 3728, "frame-portal": 3730, "frame-streams": 3732,
  "frame-overlays": 3733, "frame-audio": 3734, "frame-pipeline-photos": 3735,
  "frame-photo-upload": 3736, "frame-photo-ftp": 3737, "frame-gallery": 3738,
  "frame-today": 3739, "frame-auth": 3740, "frame-belabox-manager": 3741 };

function options(args) {
  const { values } = parseArgs({ args, options: {
    service: { type: "string" }, image: { type: "string" },
    "self-test": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (!values.help && !values["self-test"]) {
    assert.ok(services.includes(values.service), `--service must be one of: ${services.join(", ")}`);
    assert.ok(values.image && !values.image.startsWith("-") && !/\s/.test(values.image), "--image must name a local runtime image");
  }
  return values;
}

// Run the real bridge web stack without Discord registration/login, which needs a real token.
async function bridgeStartup() {
  const { loadConfig } = require("./dist/config.js");
  const { JsonGuildConfigStore } = require("./dist/storage/jsonStore.js");
  const { SessionManager } = require("./dist/sessions/sessionManager.js");
  const { VoiceManager } = require("./dist/voice/voiceManager.js");
  const { createDiscordClient } = require("./dist/bot/client.js");
  const { createWebServer } = require("./dist/web/server.js");
  const config = loadConfig();
  const store = new JsonGuildConfigStore(config.dataDir);
  await store.init();
  const sessions = new SessionManager(store, config);
  const voice = new VoiceManager(sessions);
  const client = createDiscordClient();
  await createWebServer(config, sessions, voice, client).start();
}

async function nativeChecks(service, port) {
  const assert = require("node:assert/strict");
  const { execFileSync } = require("node:child_process");
  const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.ok(health.ok);
  const payload = await health.json();
  assert.equal(payload.ok, true);
  if (payload.service) assert.equal(payload.service, service);
  if (service === "frame-gallery" || service === "frame-pipeline-photos") {
    const sharp = require("sharp");
    const jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const thumbnail = await sharp(jpeg).resize(8, 6).raw().toBuffer({ resolveWithObject: true });
    assert.equal(thumbnail.info.width, 8);
    assert.equal(thumbnail.info.height, 6);
    assert.equal(thumbnail.data.length, 8 * 6 * 3);
    if (service === "frame-gallery") {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(":memory:");
      assert.equal(db.prepare("SELECT 1 AS ready").get().ready, 1);
      db.close();
    } else {
      assert.equal(typeof require("heic-decode"), "function");
    }
  }
  if (service === "frame-audio") {
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.05", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { timeout: 10000 });
    assert.equal(pcm.length, 48000 * 0.05 * 2 * 2);
    assert.match(execFileSync("ffprobe", ["-version"], { encoding: "utf8", timeout: 10000 }), /ffprobe version/);
  }
  if (service === "frame-audio-bridge") {
    const dave = require("@snazzah/davey");
    const session = new dave.DAVESession(dave.DAVE_PROTOCOL_VERSION, "123456789012345678", "234567890123456789");
    assert.equal(session.protocolVersion, dave.DAVE_PROTOCOL_VERSION);
    session.reset();
    const Opus = require("opusscript");
    const encoder = new Opus(48000, 2, Opus.Application.AUDIO);
    const packet = encoder.encode(Buffer.alloc(960 * 2 * 2), 960);
    const { opus } = require("prism-media");
    const decoder = new opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const decoded = await new Promise((resolve, reject) => {
      decoder.once("data", resolve);
      decoder.once("error", reject);
      decoder.end(packet);
    });
    assert.equal(decoded.length, 960 * 2 * 2);
    decoder.destroy();
    encoder.delete();
  }
  if (service === "frame-photo-ftp") {
    const { createConnection } = require("node:net");
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: 2121 });
      socket.setTimeout(3000, () => socket.destroy(new Error("FTP greeting timed out")));
      socket.once("error", reject);
      socket.once("data", (data) => {
        try { assert.match(data.toString(), /^220/); resolve(); } catch (error) { reject(error); }
        finally { socket.destroy(); }
      });
    });
  }
  if (service === "frame-belabox-manager") {
    execFileSync("ssh", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
    assert.match(execFileSync("sshpass", ["-V"], { encoding: "utf8" }), /sshpass/);
    assert.match(execFileSync("iperf3", ["--version"], { encoding: "utf8" }), /iperf/);
  }
  console.log("runtime dependencies passed");
}

function createArgs(service, imageId, name, token) {
  const env = {
    DATA_ROOT: "/data", DATA_DIR: "/data/bridge", FRAME_MODE: "LAN",
    FRAME_AUTH_SESSION_SECRET: "synthetic-image-smoke-session-secret",
    PORTAL_SERVICE_TOKEN: "synthetic-image-smoke-service-token", SLS_API_KEY: "synthetic-image-smoke-sls-key",
    BELABOX_SSH_CREDENTIAL_KEY: "synthetic-image-smoke-credential-key",
    PHOTO_FTP_PASSWORD: "synthetic-image-smoke-ftp-password",
    DISCORD_TOKEN: "synthetic-no-login", DISCORD_CLIENT_ID: "123456789012345678",
    SLS_API_URL: "http://127.0.0.1:9", STREAMS_API_URL: "http://127.0.0.1:3732",
  };
  const args = ["create", "--pull=never", "--name", name, "--label", `${ownerLabel}=${token}`,
    "--network", "none", "--memory", "1g", "--pids-limit", "256",
    "--health-interval", "1s", "--health-start-period", "0s", "--health-timeout", "5s", "--health-retries", "30"];
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  if (service === "frame-audio-bridge") args.push("--entrypoint", "node");
  args.push(imageId);
  if (service === "frame-audio-bridge") args.push("--input-type=commonjs", "-e", `(${bridgeStartup})().catch(error => { console.error(error); process.exit(1); });`);
  return args;
}

function assertOwned(container, name, token) {
  assert.equal(container.Name, `/${name}`, "Container name changed; refusing cleanup");
  assert.equal(container.Config.Labels?.[ownerLabel], token, "Container ownership changed; refusing cleanup");
}

async function docker(args) {
  try {
    const result = await runFile("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${error.message}\n${error.stdout || ""}`.trim());
  }
}

async function smoke(service, image) {
  const imageInfo = JSON.parse(await docker(["image", "inspect", image]))[0];
  assert.ok(imageInfo.Config.Healthcheck?.Test?.length && imageInfo.Config.Healthcheck.Test[0] !== "NONE", "Runtime image has no health check");
  const token = randomUUID();
  const name = `frame-image-smoke-${token}`;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  process.stderr.write(`Smoke ${service}: ${imageInfo.Id}; owned container ${name}\n`);
  try {
    await docker(createArgs(service, imageInfo.Id, name, token));
    assert.ok(!interrupted, "Smoke interrupted");
    await docker(["start", name]);
    if (service === "frame-overlays") {
      // Its health check requires Streams. Supply only the authenticated empty-list contract on loopback.
      await docker(["exec", "--detach", name, "node", "--input-type=commonjs", "-e",
        'require("node:http").createServer((request, response) => { const ok = request.url === "/internal/streams" && request.headers.authorization === `Bearer ${process.env.SLS_API_KEY}`; response.writeHead(ok ? 200 : 404, { "content-type": "application/json" }); response.end(JSON.stringify(ok ? { streams: [] } : { error: "unexpected smoke request" })); }).listen(3732, "127.0.0.1");']);
    }
    const deadline = Date.now() + 60000;
    let healthy = false;
    while (Date.now() < deadline) {
      assert.ok(!interrupted, "Smoke interrupted");
      const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name]));
      assert.equal(state.Running, true, `Runtime exited (${state.ExitCode}): ${state.Error}`);
      if (state.Health?.Status === "healthy") { healthy = true; break; }
      await delay(500);
    }
    assert.ok(healthy, "Image health check did not pass within 60 seconds");
    if (service === "frame-ingest-video") {
      await docker(["exec", name, "sh", "-ec", "srt-live-transmit -version 2>&1 | grep -F 'SRT Library version: 1.5.6'; tr '\\0' ' ' < /proc/1/cmdline | grep -F supervisord; pidof sls; pidof srtla_rec"]);
    } else {
      await docker(["exec", name, "node", "--input-type=commonjs", "-e", `(${nativeChecks})(${JSON.stringify(service)}, ${ports[service]}).catch(error => { console.error(error); process.exit(1); });`]);
    }
    assert.ok(!interrupted, "Smoke interrupted");
  } catch (error) {
    try {
      const logs = await runFile("docker", ["logs", "--tail", "30", name], { encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 });
      process.stderr.write(`${logs.stdout}${logs.stderr}\n`);
    } catch { /* Container may not have been created. */ }
    throw error;
  } finally {
    try {
      const inspected = await docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`]);
      if (inspected) {
        const container = JSON.parse(await docker(["inspect", inspected]))[0];
        assertOwned(container, name, token);
        await docker(["rm", "--force", "--volumes", container.Id]);
      }
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
  console.log(JSON.stringify({ service, image, imageId: imageInfo.Id, passed: true, checks: ["image-healthcheck", "runtime-dependencies"], discordLogin: service === "frame-audio-bridge" ? "not-tested" : undefined }));
}

function selfTest() {
  assert.equal(new Set(services).size, 13);
  assert.deepEqual(Object.keys(ports).sort(), services.filter(service => service !== "frame-ingest-video").sort());
  assert.throws(() => options(["--service", "unknown", "--image", "candidate"]), /--service/);
  assert.throws(() => options(["--service", "frame-auth"]), /--image/);
  assert.throws(() => options(["--service", "frame-auth", "--image=-oops"]), /--image/);
  for (const service of services) {
    assert.equal(options(["--service", service, "--image", "candidate:local"]).service, service);
    const args = createArgs(service, "sha256:abc", "owned-name", "owned-token");
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--pull=never"));
    assert.ok(!args.some(arg => ["--mount", "--volume", "-v", "--publish", "-p", "-P"].includes(arg)));
    assert.equal(args.includes("--entrypoint"), service === "frame-audio-bridge");
  }
  assertOwned({ Name: "/owned", Config: { Labels: { [ownerLabel]: "token" } } }, "owned", "token");
  assert.throws(() => assertOwned({ Name: "/owned", Config: { Labels: { [ownerLabel]: "wrong" } } }, "owned", "token"), /ownership/);
  new Function(`return (${bridgeStartup})`);
  new Function(`return (${nativeChecks})`);
  console.log("Image smoke self-test passed: 13 service plans, isolated arguments, ownership guard, embedded script syntax.");
}

try {
  const values = options(process.argv.slice(2));
  if (values.help) console.log("Usage: node scripts/smoke-images.mjs --service frame-NAME --image LOCAL_REF\n       node scripts/smoke-images.mjs --self-test\nUses only synthetic container-local data and no published ports or external network. Requires a local built runtime image and Docker.");
  else if (values["self-test"]) selfTest();
  else await smoke(values.service, values.image);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
