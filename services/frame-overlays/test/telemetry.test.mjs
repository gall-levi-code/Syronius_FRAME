import assert from "node:assert/strict";
import test from "node:test";
import { TelemetryHub, normalizePublisher } from "../dist/telemetry.js";

test("telemetry polling is shared and never overlaps for the same stream", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let resolveFetch;
  const hub = new TelemetryHub(async () => {
    calls += 1; active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => { resolveFetch = resolve; });
    active -= 1;
    return { publisher: { connected:true, bitrate:6200, rtt:80 } };
  });
  const received = [];
  const stopA = hub.subscribe("stream-1", 10_000, (snapshot) => received.push(snapshot));
  const stopB = hub.subscribe("stream-1", 10_000, (snapshot) => received.push(snapshot));
  const duplicateRefresh = hub.refresh("stream-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveFetch();
  await duplicateRefresh;
  assert.equal(maxActive, 1);
  assert.equal(received.length, 2);
  assert.equal(received[0].sequence, 1);
  stopA(); stopB(); hub.stop();
});

test("brief upstream errors retain the last normalized sample without immediately marking it stale", async () => {
  let now = new Date("2026-06-20T12:00:00Z");
  let fail = false;
  const hub = new TelemetryHub(async () => {
    if (fail) throw new Error("temporary timeout");
    return { publisher: { connected:true, bitrate:"7000", rtt:"42", dropped_pkts:3 } };
  }, () => now);
  const first = await hub.refresh("stream-1");
  fail = true; now = new Date("2026-06-20T12:00:01Z");
  const second = await hub.refresh("stream-1");
  assert.equal(first.publisher.bitrate, 7000);
  assert.equal(second.publisher.bitrate, 7000);
  assert.equal(second.stale, false);
  assert.equal(second.sequence, 2);
  hub.stop();
});

test("normalization preserves unavailable BELABOX metrics as null", () => {
  assert.deepEqual(normalizePublisher({ publisher: {
    connected: true,
    bitrate: 6400,
    rtt: null,
    latency: null,
    buffer: null,
    dropped_pkts: 0,
    uptime: 55,
    recovery_rate: null,
  } }), {
    connected: true,
    bitrate: 6400,
    rtt: null,
    latency: null,
    buffer: null,
    dropped_pkts: 0,
    uptime: 55,
    recovery_rate: null,
  });
});
