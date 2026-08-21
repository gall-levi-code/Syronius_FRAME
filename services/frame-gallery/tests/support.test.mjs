import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORT_PLATFORMS, buildSupportUrl, detectSupportPlatform, resolveSupportPlatform } from "../public/support.js";

test("detects support providers while keeping Custom first and the rest alphabetical", () => {
  assert.equal(SUPPORT_PLATFORMS[0].label, "Custom");
  const labels = SUPPORT_PLATFORMS.slice(1).map(({ label }) => label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
  assert.equal(detectSupportPlatform("https://paypal.me/frame"), "paypal");
  assert.equal(detectSupportPlatform("https://monzo.me/frame"), "monzo");
  assert.equal(detectSupportPlatform("https://buy.stripe.com/example"), "stripe");
  assert.equal(detectSupportPlatform("https://example.com/tip"), "custom");
  assert.equal(resolveSupportPlatform("https://ko-fi.com/frame", "custom"), "kofi");
  assert.equal(buildSupportUrl("paypal.me/frame"), "https://paypal.me/frame");
  assert.throws(() => buildSupportUrl("not a link"), /valid public payment/);
});
