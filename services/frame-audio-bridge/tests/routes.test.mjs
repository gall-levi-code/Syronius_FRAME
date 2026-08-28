import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const express = require("express");
const { SessionManager } = require("../dist/sessions/sessionManager.js");
const { registerRoutes } = require("../dist/web/routes.js");

test("control URL copying requires browser-confirmed clipboard success", async () => {
  const script = await readFile(new URL("../public/control.js", import.meta.url), "utf8");
  assert.match(script, /navigator\.clipboard\?\.writeText/);
  assert.match(script, /clipboardData\.setData\("text\/plain", text\)/);
  assert.match(script, /document\.execCommand\("copy"\) && copied/);
  assert.match(script, /Automatic copy was blocked\. Press and hold this URL to copy it:/);
});

test("portal status is disabled without a service token and enforces bearer auth", async () => {
  const disabled = await createFixture({ portalServiceToken: undefined });
  try {
    const disabledResponse = await disabled.fetch("/api/internal/portal-status");
    assert.equal(disabledResponse.status, 404);
    assert.deepEqual(await disabledResponse.json(), { error: "Not found" });
  } finally {
    await disabled.close();
  }

  const fixture = await createFixture({ portalServiceToken: "portal-token" });
  try {
    fixture.setClientCounts(fixture.profile.bridgeKey, { audio: 2, overlay: 1, control: 1 });
    fixture.setClientCounts(fixture.secondProfile.bridgeKey, { audio: 1, overlay: 3, control: 0 });

    await fixture.manager.startSession({
      guildId: "guild-1",
      bridgeKey: fixture.profile.bridgeKey,
      channelId: "voice-1",
      channelName: "Green Room",
      channelBitrate: 96_000,
    });

    const missing = await fixture.fetch("/api/internal/portal-status");
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "Unauthorized" });

    const wrong = await fixture.fetch("/api/internal/portal-status", {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401);

    const ok = await fixture.fetch("/api/internal/portal-status", {
      headers: { authorization: "Bearer portal-token" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");

    const body = await ok.json();
    assert.equal(body.bot_connected, true);
    assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.guilds.length, 1);

    const guild = body.guilds[0];
    assert.equal(guild.guildId, "guild-1");
    assert.equal(guild.active, true);
    assert.equal(guild.channelName, "Green Room");
    assert.equal(guild.voice_connection, "connected:guild-1");
    assert.deepEqual(guild.clients, { audio: 3, overlay: 4, control: 1 });
    assert.equal(Object.hasOwn(guild, "bridgeKeys"), false);
    assert.deepEqual(guild.activeProfiles, [{ label: "Streamer One" }]);
  } finally {
    await fixture.close();
  }
});

test("bridge browser-source and control pages enforce tokens and serve cache-disabled HTML", async () => {
  const fixture = await createFixture();
  try {
    const cases = [
      {
        path: `/bridge/${fixture.profile.bridgeKey}/audio`,
        query: { obsToken: "readonly-token" },
        wrongQuery: { obsToken: "wrong-token" },
        title: "FRAME Audio Bridge Audio",
      },
      {
        path: `/bridge/${fixture.profile.bridgeKey}/overlay`,
        query: { obsToken: "readonly-token" },
        wrongQuery: { obsToken: "wrong-token" },
        title: "FRAME Audio Bridge Overlay",
      },
      {
        path: `/bridge/${fixture.profile.bridgeKey}/control`,
        query: { token: fixture.profile.controlToken },
        wrongQuery: { token: "wrong-token" },
        title: "FRAME Audio Bridge Control",
      },
    ];

    for (const route of cases) {
      const missing = await fixture.fetch(route.path);
      assert.equal(missing.status, 403);

      const wrong = await fixture.fetch(route.path, { query: route.wrongQuery });
      assert.equal(wrong.status, 403);

      const ok = await fixture.fetch(route.path, { query: route.query });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("cache-control"), "no-store");
      assert.match(ok.headers.get("content-type") ?? "", /text\/html/);

      const html = await ok.text();
      assert.match(html, new RegExp(`<title>${route.title}</title>`));
      assert.equal(html.includes("__ASSET_VERSION__"), false);
    }
  } finally {
    await fixture.close();
  }
});

test("control snapshot API requires the private token and returns the private snapshot", async () => {
  const fixture = await createFixture();
  try {
    const path = `/api/bridge/${fixture.profile.bridgeKey}/snapshot`;

    const missing = await fixture.fetch(path);
    assert.equal(missing.status, 403);
    assert.deepEqual(await missing.json(), { error: "Unauthorized" });

    const wrong = await fixture.fetch(path, { query: { token: "wrong-token" } });
    assert.equal(wrong.status, 403);

    const unknown = await fixture.fetch("/api/bridge/unknown-bridge/snapshot", {
      query: { token: fixture.profile.controlToken },
    });
    assert.equal(unknown.status, 403);

    const ok = await fixture.fetch(path, { query: { token: fixture.profile.controlToken } });
    assert.equal(ok.status, 200);

    const body = await ok.json();
    assert.equal(body.snapshot.guildId, "guild-1");
    assert.equal(body.snapshot.guildKey, fixture.profile.bridgeKey);
    assert.equal(body.snapshot.active, false);
    assert.equal(body.snapshot.voiceActive, false);
    assert.equal(body.snapshot.urls.audio, `https://bridge.example/bridge/${fixture.profile.bridgeKey}/audio?obsToken=readonly-token`);
    assert.equal(body.snapshot.urls.overlay, `https://bridge.example/bridge/${fixture.profile.bridgeKey}/overlay?obsToken=readonly-token`);
    assert.equal(
      body.snapshot.urls.control,
      `https://bridge.example/bridge/${fixture.profile.bridgeKey}/control?token=${encodeURIComponent(
        fixture.profile.controlToken,
      )}`,
    );
  } finally {
    await fixture.close();
  }
});

async function createFixture(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: "128kb" }));

  const appConfig = config(overrides);
  const manager = new SessionManager(new MemoryGuildConfigStore(), appConfig);
  await manager.getOrCreateGuildConfig("guild-1", "admin-1");
  const profile = await manager.getOrCreateBridgeProfile({
    guildId: "guild-1",
    ownerUserId: "streamer-1",
    label: "Streamer One",
  });
  const secondProfile = await manager.getOrCreateBridgeProfile({
    guildId: "guild-1",
    ownerUserId: "streamer-2",
    label: "Streamer Two",
  });

  const clientCounts = new Map();
  const voiceManager = {
    getConnectionStatus: (guildId) => `connected:${guildId}`,
  };
  const discordClient = {
    isReady: () => true,
  };
  const websocketServer = {
    getClientCounts: (bridgeKey) => clientCounts.get(bridgeKey) ?? { audio: 0, overlay: 0, control: 0 },
  };

  registerRoutes(
    app,
    manager,
    appConfig,
    path.resolve(process.cwd(), "public"),
    voiceManager,
    discordClient,
    websocketServer,
  );

  const server = createServer(app);
  await listen(server);
  const port = server.address().port;

  return {
    manager,
    profile,
    secondProfile,
    setClientCounts(bridgeKey, counts) {
      clientCounts.set(bridgeKey, counts);
    },
    fetch(routePath, options = {}) {
      const url = new URL(`http://127.0.0.1:${port}${routePath}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }
      return fetch(url, {
        headers: options.headers,
      });
    },
    async close() {
      manager.stopTimers();
      await closeServer(server);
    },
  };
}

function config(overrides = {}) {
  return {
    publicBaseUrl: "https://bridge.example",
    defaultAudioDelayMs: 0,
    maxAudioDelayMs: 10_000,
    sessionIdleTimeoutMinutes: 30,
    readonlyObsToken: "readonly-token",
    portalServiceToken: "portal-token",
    ...overrides,
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
