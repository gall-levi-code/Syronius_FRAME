import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("stream routes reuse the registry, share stats and invalidate them on profile mutations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-streams-"));
  const registryPath = path.join(root, "state", "custom-streams.json");
  let profiles = [
    { player: "main_feed", publisher: "main_publish", description: "Main" },
    { player: "other_feed", publisher: "other_publish", description: "Other" },
  ];
  const statsCalls = new Map();
  const upstream = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/stream-ids" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      profiles.push(JSON.parse(Buffer.concat(chunks)));
    } else if (request.method === "DELETE") {
      profiles = profiles.filter((profile) => profile.player !== request.url.split("/").pop());
    } else if (request.url.startsWith("/stats/")) {
      statsCalls.set(request.url, (statsCalls.get(request.url) ?? 0) + 1);
      if (request.url === "/stats/stalled_feed" && statsCalls.get(request.url) === 1) {
        response.write('{"publisher":');
        return;
      }
      response.end(JSON.stringify({ publisher: { connected: true, bitrate: 6400 } }));
      return;
    }
    response.end(JSON.stringify({ data: profiles }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  await fs.mkdir(path.dirname(registryPath));
  await fs.writeFile(registryPath, JSON.stringify({ version: 1, streams: [{
    id: "custom_feed", description: "Custom", adapter: "belabox", statsUrl: `${upstreamUrl}/stats/custom`,
  }] }));

  // Observe actual route IO without adding a production-only dependency injection layer.
  const originalRead = fs.readFile;
  let registryReads = 0;
  fs.readFile = (file, ...args) => {
    if (file === registryPath) registryReads += 1;
    return originalRead(file, ...args);
  };
  const express = require("express");
  const originalListen = express.application.listen;
  let server;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  express.application.listen = function () {
    server = originalListen.call(this, 0, "127.0.0.1", started);
    return server;
  };
  const settings = {
    PORT: "3732", DATA_ROOT: root, SLS_API_URL: upstreamUrl, SLS_API_KEY: "test-service-key",
    OVERLAYS_API_URL: "", STREAMS_USERNAME: "", STREAMS_PASSWORD: "", REQUEST_TIMEOUT_MS: "500",
  };
  const previousSettings = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(async () => {
    fs.readFile = originalRead;
    express.application.listen = originalListen;
    for (const [key, value] of Object.entries(previousSettings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([server, upstream].filter(Boolean).map((listener) => new Promise((resolve) => listener.close(resolve))));
    await fs.rm(root, { recursive: true, force: true });
  });
  require("../dist/index.js");
  await ready;
  express.application.listen = originalListen;
  const base = `http://127.0.0.1:${server.address().port}`;
  const getStats = async (id) => {
    const response = await fetch(`${base}/slsui/api/stats/${id}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const createStream = async (body) => {
    const response = await fetch(`${base}/slsui/api/streams`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.ok(response.ok);
    return response.json();
  };

  registryReads = 0;
  const listing = await fetch(`${base}/slsui/api/streams`).then((response) => response.json());
  assert.equal(listing.streams.length, 3);
  assert.equal(registryReads, 1, "the entire listing loads its custom registry once");

  const custom = await createStream({ source_type: "custom", description: "New custom", stats_url: "testrelay123" });
  const beforeConcurrent = statsCalls.get("/stats/main_feed");
  await Promise.all(Array.from({ length: 5 }, () => getStats("main_feed")));
  assert.equal(statsCalls.get("/stats/main_feed"), beforeConcurrent + 1, "custom creation invalidates old stats and callers share one refresh");

  await createStream({ player: "new_feed", publisher: "new_publish", description: "New SLS" });
  await getStats("main_feed");
  assert.equal(statsCalls.get("/stats/main_feed"), beforeConcurrent + 2, "SLS creation invalidates stats");
  assert.ok((await fetch(`${base}/internal/streams`, { headers: { Authorization: "Bearer test-service-key" } }).then((r) => r.json()))
    .streams.some((stream) => stream.id === "new_feed"));

  assert.equal((await fetch(`${base}/slsui/api/streams/new_feed`, { method: "DELETE" })).status, 200);
  const beforeDeleted = statsCalls.get("/stats/main_feed");
  await getStats("main_feed");
  assert.equal(statsCalls.get("/stats/main_feed"), beforeDeleted + 1, "SLS deletion invalidates stats");

  await getStats("custom_feed");
  assert.equal((await fetch(`${base}/slsui/api/streams/custom_feed`, { method: "DELETE" })).status, 200);
  await getStats("custom_feed");
  assert.equal(statsCalls.get("/stats/custom_feed"), 1, "custom deletion discards cached BELABOX stats and resolves the source again");
  assert.equal((await fetch(`${base}/slsui/api/streams/${custom.stream.id}`, { method: "DELETE" })).status, 200);

  const stalled = await fetch(`${base}/slsui/api/stats/stalled_feed`, { signal: AbortSignal.timeout(2000) });
  assert.equal(stalled.status, 500, "the configured upstream timeout also covers a stalled JSON body");
  await getStats("stalled_feed");
  assert.equal(statsCalls.get("/stats/stalled_feed"), 2, "a timed-out load does not poison the shared cache");
});
