import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const { SessionManager } = require("../dist/sessions/sessionManager.js");
const { BridgeWebSocketServer } = require("../dist/web/websocket.js");

test("websocket clients enforce tokens, redact public snapshots, and report client counts", async () => {
  const fixture = await createFixture();
  try {
    const rejected = createClient(fixture.wsUrl("overlay", fixture.profile.bridgeKey, { obsToken: "wrong" }));
    const closed = rejected.waitClose();
    await closed;
    assert.equal(rejected.closeCode, 1008);

    const control = createClient(
      fixture.wsUrl("control", fixture.profile.bridgeKey, { token: fixture.profile.controlToken }),
    );
    const overlay = createClient(
      fixture.wsUrl("overlay", fixture.profile.bridgeKey, { obsToken: "readonly-token" }),
    );
    await Promise.all([control.open(), overlay.open()]);

    const controlSnapshot = await control.waitJson("snapshot");
    const overlaySnapshot = await overlay.waitJson("overlay-state");

    assert.match(controlSnapshot.snapshot.urls.control, new RegExp(`/bridge/${fixture.profile.bridgeKey}/control\\?token=`));
    assert.equal(overlaySnapshot.snapshot.urls.control, undefined);
    assert.equal(overlaySnapshot.snapshot.urls.audio, controlSnapshot.snapshot.urls.audio);
    assert.equal(overlaySnapshot.snapshot.urls.overlay, controlSnapshot.snapshot.urls.overlay);

    assert.deepEqual(fixture.websockets.getClientCounts(fixture.profile.bridgeKey), {
      audio: 0,
      overlay: 1,
      control: 1,
    });

    await Promise.all([control.close(), overlay.close(), rejected.close()]);
  } finally {
    await fixture.close();
  }
});

test("control websocket messages update snapshots and active audio clients receive PCM chunks", async () => {
  const fixture = await createFixture();
  try {
    await fixture.manager.startSession({
      guildId: "guild-1",
      bridgeKey: fixture.profile.bridgeKey,
      channelId: "voice-1",
      channelName: "Green Room",
      channelBitrate: 96_000,
    });

    const control = createClient(
      fixture.wsUrl("control", fixture.profile.bridgeKey, { token: fixture.profile.controlToken }),
    );
    const audio = createClient(
      fixture.wsUrl("audio", fixture.profile.bridgeKey, { obsToken: "readonly-token" }),
    );
    await Promise.all([control.open(), audio.open()]);

    const initialAudioState = await audio.waitJson("audio-state");
    assert.equal(initialAudioState.active, true);

    control.sendJson({ type: "set-delay", delayMs: 350 });
    const delayedSnapshot = await control.waitJson(
      "snapshot",
      (message) => message.snapshot.defaultDelayMs === 350,
    );
    assert.equal(delayedSnapshot.snapshot.delayMs, 350);

    control.sendJson({
      type: "set-overlay",
      overlaySettings: {
        accentColor: "#123456",
        layout: "persistent",
      },
    });
    const overlaySnapshot = await control.waitJson(
      "snapshot",
      (message) => message.snapshot.overlaySettings.accentColor === "#123456",
    );
    assert.equal(overlaySnapshot.snapshot.overlaySettings.layout, "persistent");

    const pcm = Buffer.from([1, 2, 3, 4]);
    fixture.manager.publishAudioChunk("guild-1", fixture.profile.bridgeKey, {
      pcm,
      sampleRate: 48_000,
      channels: 2,
      createdAt: 123,
    });
    assert.deepEqual([...await audio.waitBinary()], [...pcm]);

    await Promise.all([control.close(), audio.close()]);
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const manager = new SessionManager(new MemoryGuildConfigStore(), config());
  await manager.getOrCreateGuildConfig("guild-1", "admin-1");
  const profile = await manager.getOrCreateBridgeProfile({
    guildId: "guild-1",
    ownerUserId: "streamer-1",
    label: "Streamer One",
  });

  const server = createServer();
  const websockets = new BridgeWebSocketServer(
    server,
    manager,
    config(),
    {},
    { isReady: () => true },
  );
  await listen(server);
  const port = server.address().port;

  return {
    manager,
    profile,
    websockets,
    wsUrl(client, bridgeKey, params = {}) {
      const search = new URLSearchParams({ client, guildKey: bridgeKey, ...params });
      return `ws://127.0.0.1:${port}/bridge/ws?${search.toString()}`;
    },
    async close() {
      manager.stopTimers();
      await websockets.close();
      await closeServer(server);
    },
  };
}

function config() {
  return {
    publicBaseUrl: "http://127.0.0.1",
    defaultAudioDelayMs: 0,
    maxAudioDelayMs: 10_000,
    sessionIdleTimeoutMinutes: 30,
    readonlyObsToken: "readonly-token",
  };
}

function createClient(url) {
  const ws = new WebSocket(url);
  const jsonMessages = [];
  const binaryMessages = [];
  const jsonWaiters = [];
  const binaryWaiters = [];
  let closeCode = null;
  let closeReason = "";

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.from(data);
      const waiter = binaryWaiters.shift();
      if (waiter) {
        waiter.resolve(buffer);
      } else {
        binaryMessages.push(buffer);
      }
      return;
    }

    const message = JSON.parse(data.toString("utf8"));
    const waiterIndex = jsonWaiters.findIndex((waiter) => waiter.matches(message));
    if (waiterIndex >= 0) {
      const [waiter] = jsonWaiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    } else {
      jsonMessages.push(message);
    }
  });

  ws.on("close", (code, reason) => {
    closeCode = code;
    closeReason = reason.toString("utf8");
  });

  return {
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
    open() {
      if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
    },
    waitClose(timeoutMs = 1_000) {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket close")), timeoutMs);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", reject);
      });
    },
    waitJson(type, predicate = () => true, timeoutMs = 1_000) {
      const index = jsonMessages.findIndex((message) => message.type === type && predicate(message));
      if (index >= 0) {
        const [message] = jsonMessages.splice(index, 1);
        return Promise.resolve(message);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
        jsonWaiters.push({
          matches: (message) => message.type === type && predicate(message),
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    waitBinary(timeoutMs = 1_000) {
      if (binaryMessages.length > 0) {
        return Promise.resolve(binaryMessages.shift());
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for binary websocket message")), timeoutMs);
        binaryWaiters.push({
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    sendJson(message) {
      ws.send(JSON.stringify(message));
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      ws.close();
      return this.waitClose();
    },
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
