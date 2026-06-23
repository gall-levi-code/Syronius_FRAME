import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { SessionManager } = require("../dist/sessions/sessionManager.js");

test("multi-profile sessions share one guild voice session and stop independently", async () => {
  const manager = new SessionManager(new MemoryGuildConfigStore(), config());
  const stopped = [];
  manager.on("sessionStopped", (event) => stopped.push(event));

  await manager.getOrCreateGuildConfig("guild-1", "admin-1");
  const first = await manager.getOrCreateBridgeProfile({
    guildId: "guild-1",
    ownerUserId: "streamer-1",
    label: "Streamer One",
  });
  const second = await manager.getOrCreateBridgeProfile({
    guildId: "guild-1",
    ownerUserId: "streamer-2",
    label: "Streamer Two",
  });

  await manager.startSession(sessionInput(first.bridgeKey));
  const session = await manager.startSession(sessionInput(second.bridgeKey));

  assert.equal(session.active, true);
  assert.deepEqual(new Set(session.activeBridgeKeys), new Set([first.bridgeKey, second.bridgeKey]));
  assert.deepEqual(
    (await manager.getActiveProfileSummaries("guild-1")).map((profile) => profile.label).sort(),
    ["Streamer One", "Streamer Two"],
  );
  await assert.rejects(
    manager.startSession({ ...sessionInput(first.bridgeKey), channelId: "voice-2", channelName: "Other Room" }),
    /already active/,
  );

  const afterFirstStop = await manager.stopProfile("guild-1", first.bridgeKey, "test");
  assert.equal(afterFirstStop.active, true);
  assert.deepEqual(afterFirstStop.activeBridgeKeys, [second.bridgeKey]);
  assert.equal(stopped.length, 0);

  const afterSecondStop = await manager.stopProfile("guild-1", second.bridgeKey, "test");
  assert.equal(afterSecondStop.active, false);
  assert.deepEqual(afterSecondStop.activeBridgeKeys, []);
  assert.equal(stopped.length, 1);
  assert.deepEqual(stopped[0], { guildId: "guild-1", reason: "test" });

  manager.stopTimers();
});

test("profile controls drive snapshots, mix inputs, tokens, and audio chunk publication", async () => {
  const manager = new SessionManager(new MemoryGuildConfigStore(), config());
  const chunks = [];
  manager.on("audioChunk", (chunk) => chunks.push(chunk));

  await manager.getOrCreateGuildConfig("guild-1", "admin-1");
  const profile = await manager.getOrCreateBridgeProfile({
    guildId: "guild-1",
    ownerUserId: "streamer-1",
    label: "Streamer One",
  });

  assert.equal(await manager.validateObsToken(profile.bridgeKey, "readonly-token"), true);
  assert.equal(await manager.validateObsToken(profile.bridgeKey, "wrong-token"), false);
  assert.equal(await manager.validateControlToken(profile.bridgeKey, profile.controlToken), true);
  assert.equal(await manager.validateControlToken(profile.bridgeKey, "wrong-token"), false);

  const publicSnapshot = await manager.getSnapshotByGuildKey(profile.bridgeKey, false);
  assert.equal(publicSnapshot.urls.audio, `https://bridge.example/bridge/${profile.bridgeKey}/audio?obsToken=readonly-token`);
  assert.equal(publicSnapshot.urls.overlay, `https://bridge.example/bridge/${profile.bridgeKey}/overlay?obsToken=readonly-token`);
  assert.equal(publicSnapshot.urls.control, undefined);

  await manager.startSession(sessionInput(profile.bridgeKey));
  await manager.updateSpeaking(
    "guild-1",
    { discordUserId: "user-1", displayName: "Guest One", avatarUrl: "https://avatar.example/1.png" },
    true,
  );
  await manager.setUserControls(profile.bridgeKey, "user-1", { muted: true, volume: 1.5, hidden: true });
  await manager.setDelay(profile.bridgeKey, 123);
  await manager.setDelayEnabled(profile.bridgeKey, false);
  await manager.setOverlaySettings(profile.bridgeKey, {
    layout: "vertical",
    accentColor: "#ABCDEF",
    avatarSizePx: 500,
  });
  await assert.rejects(manager.setOverlaySettings(profile.bridgeKey, { accentColor: "blue" }), /Accent color/);

  const snapshot = await manager.getSnapshotByGuildKey(profile.bridgeKey, true);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.delayEnabled, false);
  assert.equal(snapshot.defaultDelayMs, 100);
  assert.equal(snapshot.delayMs, 0);
  assert.equal(snapshot.overlaySettings.layout, "vertical");
  assert.equal(snapshot.overlaySettings.accentColor, "#abcdef");
  assert.equal(snapshot.overlaySettings.avatarSizePx, 128);
  assert.equal(snapshot.users[0].muted, true);
  assert.equal(snapshot.users[0].volume, 1.5);
  assert.equal(snapshot.users[0].hidden, true);
  assert.match(snapshot.urls.control, new RegExp(`/bridge/${profile.bridgeKey}/control\\?token=`));

  const [mixInput] = await manager.getActiveProfileMixInputs("guild-1");
  assert.equal(mixInput.bridgeKey, profile.bridgeKey);
  assert.equal(mixInput.delayMs, 0);
  assert.equal(mixInput.users[0].muted, true);

  manager.publishAudioChunk("guild-1", profile.bridgeKey, {
    pcm: Buffer.from([1, 2, 3, 4]),
    sampleRate: 48_000,
    channels: 2,
    createdAt: 123,
  });
  manager.publishAudioChunk("guild-1", "unknown-bridge", {
    pcm: Buffer.from([5, 6]),
    sampleRate: 48_000,
    channels: 2,
    createdAt: 124,
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].guildKey, profile.bridgeKey);
  assert.deepEqual([...chunks[0].pcm], [1, 2, 3, 4]);

  await manager.stopProfile("guild-1", profile.bridgeKey);
  manager.publishAudioChunk("guild-1", profile.bridgeKey, {
    pcm: Buffer.from([7, 8]),
    sampleRate: 48_000,
    channels: 2,
    createdAt: 125,
  });
  assert.equal(chunks.length, 1);

  manager.stopTimers();
});

function config() {
  return {
    publicBaseUrl: "https://bridge.example",
    defaultAudioDelayMs: 2_000,
    maxAudioDelayMs: 10_000,
    sessionIdleTimeoutMinutes: 30,
    readonlyObsToken: "readonly-token",
  };
}

function sessionInput(bridgeKey) {
  return {
    guildId: "guild-1",
    bridgeKey,
    channelId: "voice-1",
    channelName: "Green Room",
    channelBitrate: 96_000,
  };
}

class MemoryGuildConfigStore {
  #configsByGuildId = new Map();

  async init() {}

  async getByGuildId(guildId) {
    return clone(this.#configsByGuildId.get(guildId) ?? null);
  }

  async getByBridgeKey(bridgeKey) {
    for (const config of this.#configsByGuildId.values()) {
      const profile = config.profiles.find((entry) => entry.bridgeKey === bridgeKey);
      if (profile) {
        return {
          config: clone(config),
          profile: clone(profile),
        };
      }
    }
    return null;
  }

  async listGuildConfigs() {
    return [...this.#configsByGuildId.values()].map(clone);
  }

  async upsertGuildConfig(config) {
    this.#configsByGuildId.set(config.guildId, clone(config));
    return clone(config);
  }
}

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}
