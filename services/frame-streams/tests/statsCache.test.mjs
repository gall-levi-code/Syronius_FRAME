import assert from "node:assert/strict";
import test from "node:test";
import { createStatsCache } from "../dist/statsCache.js";

test("stats share pending requests and expire after 200 ms", async () => {
  let time = 0;
  let calls = 0;
  let release;
  const cache = createStatsCache(() => time);
  const load = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return calls;
  };
  const first = cache.read("main", load);
  const concurrent = cache.read("main", load);
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 1);
  time = 199;
  assert.equal(await cache.read("main", load), 1);
  time = 200;
  assert.equal(await cache.read("main", async () => ++calls), 2);
});

test("failed stats recover immediately and invalidated pending loads cannot restore old data", async () => {
  const cache = createStatsCache(() => 0);
  await assert.rejects(cache.read("main", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.read("main", async () => "recovered"), "recovered");
  cache.invalidate();
  let release;
  const previous = cache.read("main", () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  cache.invalidate();
  assert.equal(await cache.read("main", async () => "new"), "new");
  release("old");
  assert.equal(await previous, "old");
  assert.equal(await cache.read("main", async () => "unexpected"), "new");
});

test("arbitrary public IDs cannot retain more than 256 cache entries", async () => {
  const cache = createStatsCache(() => 0);
  for (let index = 0; index < 257; index += 1) {
    assert.equal(await cache.read(String(index), async () => index), index);
  }
  assert.equal(await cache.read("1", async () => "unexpected"), 1);
  assert.equal(await cache.read("0", async () => "reloaded"), "reloaded");
});
