import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { JsonGuildConfigStore } = require("../dist/storage/jsonStore.js");
const { SessionManager } = require("../dist/sessions/sessionManager.js");
const { defaultOverlaySettings, defaultUserControls } = require("../dist/sessions/guildConfig.js");
const iterations = 2_000;
const samples = 5;
console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: os.cpus()[0].model, iterations, samples }));

for (const [profiles, users] of [[1, 8], [8, 64]]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-bridge-bench-"));
  const store = new JsonGuildConfigStore(root);
  const manager = new SessionManager(store, {
    publicBaseUrl: "http://localhost", defaultAudioDelayMs: 0, maxAudioDelayMs: 10_000,
    sessionIdleTimeoutMinutes: 30,
  });
  try {
    await store.init();
    const timestamp = "2026-09-08T00:00:00.000Z";
    const config = {
      guildId: "benchmark-guild", adminUserIds: ["admin"], emptyChannelTimeoutMinutes: 5,
      createdAt: timestamp, updatedAt: timestamp,
      profiles: Array.from({ length: profiles }, (_, index) => ({
        guildId: "benchmark-guild", bridgeKey: `bridge-${index}`, controlToken: `test-token-${index}`,
        ownerUserId: `owner-${index}`, ownerUserIds: [`owner-${index}`], label: `Profile ${index}`,
        defaultDelayMs: 0, delayEnabled: true, overlaySettings: defaultOverlaySettings(),
        userControls: Object.fromEntries(Array.from({ length: users }, (_, user) => [`user-${user}`, defaultUserControls()])),
        createdAt: timestamp, updatedAt: timestamp,
      })),
    };
    await store.upsertGuildConfig(config);
    for (const profile of config.profiles) {
      await manager.startSession({ guildId: config.guildId, bridgeKey: profile.bridgeKey, channelId: "voice", channelName: "Benchmark" });
    }
    for (let user = 0; user < users; user += 1) {
      await manager.updateSpeaking(config.guildId, { discordUserId: `user-${user}`, displayName: `User ${user}`, avatarUrl: "" }, true);
    }
    const inputs = await manager.getActiveProfileMixInputs(config.guildId);
    assert.equal(inputs.length, profiles);
    assert.equal(inputs[0].users.length, users);
    for (const [operation, run] of [
      ["config clone", () => store.getByGuildId(config.guildId)],
      ["mix inputs (includes clone)", () => manager.getActiveProfileMixInputs(config.guildId)],
    ]) {
      for (let warmup = 0; warmup < 200; warmup += 1) await run();
      const timings = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration += 1) await run();
        const wallMs = (performance.now() - start) / iterations;
        const cpu = process.cpuUsage(cpuStart);
        timings.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 / iterations });
      }
      const median = (key) => timings.map((value) => value[key]).sort((a, b) => a - b)[Math.floor(samples / 2)];
      console.log(JSON.stringify({
        profiles, users, configBytes: Buffer.byteLength(JSON.stringify(config)), operation,
        medianWallMs: median("wallMs"), medianCpuMs: median("cpuMs"),
        corePercentAt50Hz: median("cpuMs") * 50 / 10,
      }));
    }
  } finally {
    manager.stopTimers();
    await rm(root, { recursive: true, force: true });
  }
}
