import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/portal.js", import.meta.url), "utf8");
const settingsFunctions = source.slice(source.indexOf("async function loadPipelineSettings("), source.indexOf("function updatePipelineQualityLabel("));

function settingsPage(fetchJson) {
  const elements = Object.fromEntries([
    "pipelineLongEdge", "pipelineQuality", "pipelineMaxOutput", "pipelineArchiveRetention", "pipelineSave",
  ].map((name) => [name, { value: "", disabled: false }]));
  const states = [];
  const context = vm.createContext({
    elements, fetchJson, pipelineSettingsLoaded: false,
    updatePipelineQualityLabel() {}, showToast() {},
    setPipelineState(label) { states.push(label); },
  });
  vm.runInContext(settingsFunctions, context);
  return { context, elements, states };
}

test("Pipeline form loads archive retention, preserves disabled expiry, and defaults to 14 days", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /Original backup retention \(days\)/);
  assert.match(html, /id="pipeline-archive-retention"[^>]*min="0"[^>]*max="36500"[^>]*step="1"[^>]*value="14"[^>]*required/);
  assert.match(html, /Gallery photos and trash are never deleted automatically/);
  const { context, elements } = settingsPage(async (url) => {
    assert.equal(url, "/pipeline/api/settings");
    return { settings: { long_edge_px: 2560, jpeg_quality: 87, max_output_mb: 5.5, archive_retention_days: 0 } };
  });
  context.renderPipelineSettings({});
  assert.equal(elements.pipelineArchiveRetention.value, "14");
  await context.loadPipelineSettings();
  assert.equal(elements.pipelineArchiveRetention.value, "0");
  assert.equal(elements.pipelineLongEdge.value, "2560");
  assert.equal(elements.pipelineQuality.value, "87");
  assert.equal(elements.pipelineMaxOutput.value, "5.5");
});

test("Pipeline save keeps processing fields and displays server-validated retention", async () => {
  let request;
  const page = settingsPage(async (url, options) => {
    assert.equal(url, "/pipeline/api/settings");
    assert.equal(options.method, "PUT");
    assert.equal(page.elements.pipelineSave.disabled, true);
    request = JSON.parse(options.body);
    return { settings: { ...request, archive_retention_days: 28 } };
  });
  page.context.renderPipelineSettings({ long_edge_px: 2560, jpeg_quality: 87, max_output_mb: 5.5, archive_retention_days: 0 });
  let prevented = false;
  await page.context.savePipelineSettings({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(request, { long_edge_px: 2560, jpeg_quality: 87, max_output_mb: 5.5, archive_retention_days: 0 });
  assert.equal(page.elements.pipelineArchiveRetention.value, "28");
  assert.equal(page.elements.pipelineSave.disabled, false);
  assert.deepEqual(page.states, ["Saving", "Saved"]);
});
