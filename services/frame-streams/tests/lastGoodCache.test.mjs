import assert from "node:assert/strict";
import test from "node:test";
import { createLastGoodCache } from "../dist/lastGoodCache.js";

test("keeps the last good value through expiry and a failed refresh", async () => {
  let time = 0;
  let calls = 0;
  const staleErrors = [];
  const cache = createLastGoodCache(async () => {
    calls += 1;
    if (calls === 2) throw new Error("rate limited");
    return ["main-feed"];
  }, 10, (error) => staleErrors.push(error.message), () => time);

  assert.deepEqual(await cache.read(), ["main-feed"]);
  assert.deepEqual(await cache.read(), ["main-feed"]);
  assert.equal(calls, 1);

  time = 11;
  assert.deepEqual(await cache.read(), ["main-feed"]);
  assert.equal(calls, 2);
  assert.deepEqual(staleErrors, ["rate limited"]);

  cache.invalidate();
  assert.deepEqual(await cache.read(), ["main-feed"]);
  assert.equal(calls, 3);
});
