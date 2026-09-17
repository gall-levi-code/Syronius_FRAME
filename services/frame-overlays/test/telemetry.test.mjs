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

test("stream polling clamps unsafe intervals", async () => {
  let now = new Date("2026-06-20T12:00:00Z");
  let calls = 0;
  const hub = new TelemetryHub(async () => {
    calls += 1;
    return { publisher: { connected:true, bitrate:7000 } };
  }, () => now);
  const first = await hub.snapshot("stream-1", 20);
  now = new Date("2026-06-20T12:00:00.100Z");
  const second = await hub.snapshot("stream-1", 20);
  now = new Date("2026-06-20T12:00:00.201Z");
  const third = await hub.snapshot("stream-1", 20);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 1);
  assert.equal(third.sequence, 2);
  assert.equal(calls, 2);
  hub.stop();
});

test("stream cadence follows current subscribers and resets after the last one leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 8, 8) });
  let calls = 0;
  const hub = new TelemetryHub(async () => {
    calls += 1;
    return { publisher: { connected: true, bitrate: 7000 } };
  });
  t.after(() => hub.stop());
  // Reusing a callback must still leave each subscription with its own lifetime and interval.
  const listener = () => {};
  const stopSlow = hub.subscribe("stream-1", 1000, listener);
  await flushRefresh();
  t.mock.timers.tick(1000);
  await flushRefresh();
  assert.equal(calls, 2);

  const stopFast = hub.subscribe("stream-1", 200, listener);
  await flushRefresh();
  assert.equal(calls, 3);
  t.mock.timers.tick(200);
  await flushRefresh();
  assert.equal(calls, 4);
  stopFast();
  t.mock.timers.tick(999);
  await flushRefresh();
  assert.equal(calls, 4, "departed fast subscribers must not leave a fast timer behind");
  t.mock.timers.tick(1);
  await flushRefresh();
  assert.equal(calls, 5);

  stopSlow();
  t.mock.timers.tick(10_000);
  await flushRefresh();
  assert.equal(calls, 5, "no subscribers means no recurring polls");
  const stopLater = hub.subscribe("stream-1", 2000, listener);
  await flushRefresh();
  assert.equal(calls, 6);
  t.mock.timers.tick(1999);
  await flushRefresh();
  assert.equal(calls, 6, "a later subscriber must not inherit the old minimum");
  t.mock.timers.tick(1);
  await flushRefresh();
  assert.equal(calls, 7);
  stopLater();
});

test("one-shot snapshots use their own cache interval without changing background cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 8, 8) });
  let calls = 0;
  const hub = new TelemetryHub(async () => {
    calls += 1;
    return { publisher: { connected: true, bitrate: 7000 } };
  });
  t.after(() => hub.stop());
  await hub.snapshot("stream-1", 200);
  t.mock.timers.tick(250);
  assert.equal((await hub.snapshot("stream-1", 2000)).sequence, 1);
  assert.equal(calls, 1, "a previous one-shot interval must not shorten later cache reads");
  t.mock.timers.tick(10_000);
  await flushRefresh();
  assert.equal(calls, 1, "one-shot requests must not start a background timer");

  const unsubscribe = hub.subscribe("stream-1", 2000, () => {});
  await flushRefresh();
  assert.equal(calls, 2);
  t.mock.timers.tick(250);
  assert.equal((await hub.snapshot("stream-1", 200)).sequence, 3);
  t.mock.timers.tick(1750);
  await flushRefresh();
  assert.equal(calls, 4);
  t.mock.timers.tick(1999);
  await flushRefresh();
  assert.equal(calls, 4, "fast one-shot requests must not accelerate active subscribers");
  t.mock.timers.tick(1);
  await flushRefresh();
  assert.equal(calls, 5);
  unsubscribe();
});

test("unsubscribing or stopping during an in-flight refresh cannot restart polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 8, 8) });
  let calls = 0;
  let resolveFetch;
  const hub = new TelemetryHub(async () => {
    calls += 1;
    await new Promise((resolve) => { resolveFetch = resolve; });
    return { publisher: { connected: true, bitrate: 7000 } };
  });
  t.after(() => hub.stop());
  const received = [];
  const unsubscribe = hub.subscribe("stream-1", 200, (snapshot) => received.push(snapshot));
  const pending = hub.refresh("stream-1");
  unsubscribe();
  resolveFetch();
  assert.equal((await pending).sequence, 1);
  t.mock.timers.tick(10_000);
  await flushRefresh();
  assert.equal(calls, 1);
  assert.equal(received.length, 0);

  hub.subscribe("stream-1", 200, () => {});
  const pendingStop = hub.refresh("stream-1");
  hub.stop();
  resolveFetch();
  assert.equal((await pendingStop).sequence, 2);
  t.mock.timers.tick(10_000);
  await flushRefresh();
  assert.equal(calls, 2);
});

function flushRefresh() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
