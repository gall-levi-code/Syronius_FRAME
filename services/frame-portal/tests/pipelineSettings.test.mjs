import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/portal.js", import.meta.url), "utf8");
const settingsFunctions = source.slice(source.indexOf("async function loadPipelineSettings("), source.indexOf("function updatePipelineQualityLabel("));

function settingsPage(fetchJson) {
  const elements = Object.fromEntries([
    "pipelineLongEdge", "pipelineQuality", "pipelineMaxOutput", "pipelineArchiveRetention", "pipelineSave",
  ].map((name) => [name, { value: "", disabled: false, textContent: "Save" }]));
  const issues = new Map();
  const notices = [];
  const context = vm.createContext({
    elements, fetchJson, pipelineSettingsLoaded: false, pipelineSettingsLoading: false,
    updatePipelineQualityLabel() {}, showToast(message) { notices.push(message); },
    window: { FrameFeedback: {
      issue(key, details) { issues.set(key, details); },
      clearIssue(key, options) { if (issues.delete(key) && options?.notify) notices.push(options.notify); },
    } },
  });
  vm.runInContext(settingsFunctions, context);
  return { context, elements, issues, notices };
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
  assert.equal(elements.pipelineSave.disabled, false);
  assert.equal(elements.pipelineSave.textContent, "Save");
});

test("Pipeline save keeps processing fields and displays server-validated retention", async () => {
  let request;
  const page = settingsPage(async (url, options) => {
    assert.equal(url, "/pipeline/api/settings");
    assert.equal(options.method, "PUT");
    assert.equal(page.elements.pipelineSave.disabled, true);
    assert.equal(page.elements.pipelineSave.textContent, "Saving…");
    request = JSON.parse(options.body);
    return { settings: { ...request, archive_retention_days: 28 } };
  });
  page.context.renderPipelineSettings({ long_edge_px: 2560, jpeg_quality: 87, max_output_mb: 5.5, archive_retention_days: 0 });
  page.context.pipelineSettingsLoaded = true;
  let prevented = false;
  await page.context.savePipelineSettings({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(request, { long_edge_px: 2560, jpeg_quality: 87, max_output_mb: 5.5, archive_retention_days: 0 });
  assert.equal(page.elements.pipelineArchiveRetention.value, "28");
  assert.equal(page.elements.pipelineSave.disabled, false);
  assert.equal(page.elements.pipelineSave.textContent, "Save");
  assert.deepEqual(page.notices, ["Pipeline settings saved."]);
  assert.equal(page.issues.size, 0);
});

test("Pipeline cannot save defaults before a successful load, and retry recovers quietly", async () => {
  let fail = true;
  let calls = 0;
  const page = settingsPage(async (_url, options) => {
    calls++;
    assert.equal(options, undefined, "Saving must remain unavailable before settings load");
    assert.equal(page.elements.pipelineSave.disabled, true);
    assert.equal(page.elements.pipelineSave.textContent, "Loading…");
    if (fail) throw new Error("Pipeline host unavailable: full diagnostic details");
    return { settings: { archive_retention_days: 0 } };
  });
  await page.context.savePipelineSettings({ preventDefault() {} });
  assert.equal(calls, 0);
  await page.context.loadPipelineSettings();
  assert.equal(page.elements.pipelineSave.disabled, true);
  assert.equal(page.context.pipelineSettingsLoaded, false);
  const problem = page.issues.get("pipeline-load");
  assert.equal(problem.message, "Pipeline host unavailable: full diagnostic details");
  assert.equal(problem.target, ".pipeline-actions");
  await page.context.savePipelineSettings({ preventDefault() {} });
  assert.equal(calls, 1);
  fail = false;
  await problem.action.onClick();
  assert.equal(page.elements.pipelineSave.disabled, false);
  assert.equal(page.elements.pipelineArchiveRetention.value, "0");
  assert.equal(page.issues.size, 0);
  assert.deepEqual(page.notices, ["Pipeline settings are available again."]);
});

test("Pipeline refreshes preserve edited fields, and a failed save retains the draft and full error", async () => {
  let calls = 0;
  const page = settingsPage(async (_url, options) => {
    calls++;
    if (options?.method === "PUT") throw new Error("Validation failed: backup path unavailable\nStorage diagnostic");
    return { settings: { long_edge_px: 1920, archive_retention_days: 14 } };
  });
  await page.context.loadPipelineSettings();
  assert.deepEqual(page.notices, [], "Healthy initial load must stay quiet");
  page.elements.pipelineLongEdge.value = "2560";
  page.elements.pipelineArchiveRetention.value = "0";
  await page.context.loadPipelineSettings();
  assert.equal(calls, 1, "Background navigation refresh cannot reload an edited form");
  await page.context.savePipelineSettings({ preventDefault() {} });
  assert.equal(page.elements.pipelineLongEdge.value, "2560");
  assert.equal(page.elements.pipelineArchiveRetention.value, "0");
  assert.equal(page.elements.pipelineSave.disabled, false);
  assert.equal(page.elements.pipelineSave.textContent, "Save");
  assert.equal(page.issues.get("pipeline-save").message, "Validation failed: backup path unavailable\nStorage diagnostic");
  assert.deepEqual(page.notices, [], "An unsuccessful save cannot announce success");
});
