import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { buildPortalTools } from "../dist/stackConfig.js";
import { collectToolLinkGroups } from "../dist/toolLinks.js";

test("collects only sanitized generated links and keeps them on the public dashboard", async () => {
  const payloads = new Map([
    ["streams.test/slsui/api/config", { relay_host: "relay.example.com", ports: { srtla: 5000, sender: 4001, player: 4000 } }],
    ["streams.test/internal/streams", { streams: [
      { id: "play_main", player: "play_main", publisher: "live_main", description: "Main feed", source_type: "sls" },
      { id: "custom_safe", player: "custom_safe", description: "External telemetry", source_type: "custom", statsUrl: "https://not-exposed.test/secret" },
    ] }],
    ["overlays.test/overlays/api/catalog", {
      presets: [
        { id: "signal-preset", type: "connectivity", enabled: true },
        { id: "disabled-preset", type: "connectivity", enabled: false },
      ],
      sources: [
        { display_name: "Signal overlay", slug: "signal-overlay", source_key: "abcdefghijklmnopqrstuvwx", preset_id: "signal-preset", enabled: true },
        { display_name: "Disabled overlay", slug: "disabled-overlay", source_key: "abcdefghijklmnopqrstuvwx", preset_id: "disabled-preset", enabled: true },
        { display_name: "Unsafe overlay", slug: "../escape", source_key: "abcdefghijklmnopqrstuvwx", preset_id: "signal-preset", enabled: true },
      ],
    }],
    ["audio.test/audio/api/streams", { streams: [
      { streamId: "stage-audio", name: "Stage audio", listenUrl: "https://ignored.test/listen", captureUrl: "http://lan-only.test/capture" },
    ] }],
    ["belabox.test/belabox/api/status", {
      remote_belaui: { enabled: true },
      provisioning: { devices: [{ device_id: "encoder-1", display_name: "Encoder One", mqtt_password: "not-exposed" }] },
    }],
  ]);
  const seenAuthorization = new Map();
  const request = async (input, init) => {
    const url = new URL(input);
    seenAuthorization.set(`${url.hostname}${url.pathname}`, new Headers(init?.headers).get("authorization"));
    const body = payloads.get(`${url.hostname}${url.pathname}`);
    return new Response(JSON.stringify(body ?? {}), {
      status: body ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  const config = {
    streamsApiUrl: "http://streams.test",
    streamsApiKey: "service-key",
    streamsUsername: "streams-user",
    streamsPassword: "streams-pass",
    overlaysApiUrl: "http://overlays.test",
    overlaysUsername: "overlay-user",
    overlaysPassword: "overlay-pass",
    audioApiUrl: "http://audio.test",
    belaboxApiUrl: "http://belabox.test",
    requestTimeoutMs: 1000,
  };
  const stack = {
    mode: "HYBRID",
    capabilities: {
      "frame-video-relay": true,
      "frame-overlays": true,
      "frame-audio-relay": true,
      "frame-belabox-manager": true,
      "frame-discord-audio-bridge": false,
    },
    routes: {
      video_relay_ui: "/slsui",
      video_relay_stats: "/stats",
      overlays_root: "/overlays",
      overlays_wizard: "/overlays/setup",
      audio_admin: "/audio/admin",
      audio_listen: "/audio/listen",
      belabox_manager: "/belabox",
      belabox_remote: "/belabox/remote",
      status: "/status",
    },
    public_route_prefixes: ["/stats", "/overlays/view", "/audio/listen", "/belabox/remote"],
  };

  const groups = await collectToolLinkGroups(config, stack, request);
  assert.deepEqual(groups.streams[0].links, [
    { label: "SRTLA publisher", url: "srtla://relay.example.com:5000?streamid=live_main", openable: false },
    { label: "Direct SRT publisher", url: "srt://relay.example.com:4001?streamid=live_main", openable: false },
    { label: "SRT player", url: "srt://relay.example.com:4000?streamid=play_main", openable: false },
    { label: "FRAME statistics", url: "/stats/play_main", openable: true },
    { label: "BBox Receiver statistics", url: "/stats/play_main?output=bbox_receiver", openable: true },
  ]);
  assert.equal(groups.overlays.length, 1);
  assert.equal(groups.audio[0].links[0].url, "/audio/listen/stage-audio");
  assert.equal(groups.belabox[0].links[0].url, "/belabox/remote?key=encoder-1");
  assert.ok(seenAuthorization.get("streams.test/slsui/api/config")?.startsWith("Basic "));
  assert.equal(seenAuthorization.get("streams.test/internal/streams"), "Bearer service-key");
  assert.ok(seenAuthorization.get("overlays.test/overlays/api/catalog")?.startsWith("Basic "));
  const serialized = JSON.stringify(groups);
  assert.ok(!serialized.includes("not-exposed"));
  assert.ok(!serialized.includes("lan-only"));

  const services = ["frame-streams", "frame-overlays", "frame-audio", "frame-belabox-manager", "frame-portal"]
    .map((name) => ({ name, status: "running", health: "healthy", uptime_seconds: 1 }));
  const groupsWithLanOnly = structuredClone(groups);
  groupsWithLanOnly.streams.push({
    label: "Should stay on LAN",
    links: [{ label: "Management", url: "/slsui/private", openable: true }],
  });
  const publicTools = buildPortalTools({ config: stack, source: "file" }, services, "public", groupsWithLanOnly);
  assert.equal(publicTools.find((tool) => tool.id === "streams").route, "");
  assert.deepEqual(publicTools.find((tool) => tool.id === "streams").link_groups, groups.streams);
  assert.deepEqual(publicTools.find((tool) => tool.id === "audio-bridge").link_groups, []);
  const lanTools = buildPortalTools({ config: stack, source: "file" }, services, "lan", groupsWithLanOnly);
  assert.equal(lanTools.find((tool) => tool.id === "streams").link_groups.at(-1).label, "Should stay on LAN");

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const partial = await collectToolLinkGroups(config, stack, async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/slsui/api/config") return new Response("", { status: 401 });
      return request(input, init);
    });
    assert.deepEqual(partial.streams[0].links, [
      { label: "FRAME statistics", url: "/stats/play_main", openable: true },
      { label: "BBox Receiver statistics", url: "/stats/play_main?output=bbox_receiver", openable: true },
    ]);

    const unavailable = await collectToolLinkGroups(config, stack, async () => { throw new Error("offline"); });
    assert.deepEqual(unavailable, { streams: [], overlays: [], audio: [], belabox: [] });
  } finally {
    console.warn = originalWarn;
  }
});

test("rejects credentials and query strings in internal service URLs", () => {
  const previousMode = process.env.FRAME_MODE;
  const previousStreamsUrl = process.env.STREAMS_API_URL;
  process.env.FRAME_MODE = "LAN";
  try {
    process.env.STREAMS_API_URL = "http://user:secret@streams.test";
    assert.throws(() => loadConfig(), /must not include credentials/);
    process.env.STREAMS_API_URL = "http://streams.test?token=secret";
    assert.throws(() => loadConfig(), /must not include a query or fragment/);
  } finally {
    if (previousMode === undefined) delete process.env.FRAME_MODE;
    else process.env.FRAME_MODE = previousMode;
    if (previousStreamsUrl === undefined) delete process.env.STREAMS_API_URL;
    else process.env.STREAMS_API_URL = previousStreamsUrl;
  }
});
