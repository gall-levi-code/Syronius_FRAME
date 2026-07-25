import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OverlayStore, StoreConflictError } from "../dist/store.js";
import { storeFixtureOptions } from "./helpers.mjs";

test("V1 migration, backup, serialized writes, and optimistic conflicts are enforced", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-overlay-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const statePath = path.join(stateDir, "overlay-presets.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify({
    schema_version: "1.0", default_preset_id: "camera-main",
    presets: [{ id:"camera-main", name:"Camera Main", type:"connectivity", enabled:true, layout:{dock:"br",pad:20}, theme:{}, config:{stream_profile_id:"publisher_1",poll_ms:1000} }],
  }));
  const store = new OverlayStore(await storeFixtureOptions(statePath));
  const migrated = await store.init();
  assert.equal(migrated.schema_version, "2.0");
  assert.equal(migrated.legacy_aliases["camera-main"], "legacy-camera-main");
  assert.equal(migrated.sources[0].data_source.stream_profile_id, "publisher_1");
  assert.equal("stream_profile_id" in migrated.presets[0].config, false);
  assert.match(migrated.sources[0].source_key, /^[A-Za-z0-9_-]{24}$/);
  assert.ok((await readdir(stateDir)).some((name) => name.includes(".v1-") && name.endsWith(".bak")));

  const results = await Promise.allSettled([
    store.mutate(migrated.revision, () => undefined),
    store.mutate(migrated.revision, () => undefined),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof StoreConflictError);
  assert.ok((await readFile(`${statePath}.bak`, "utf8")).includes('"schema_version": "2.0"'));
  assert.equal((await readdir(stateDir)).some((name) => name.includes(".tmp-")), false);
});

test("built-in templates cannot be changed by a state mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-overlay-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "overlay-presets.json");
  const store = new OverlayStore(await storeFixtureOptions(statePath));
  const document = await store.init();
  await assert.rejects(store.mutate(document.revision, (draft) => { draft.templates[0].name = "Edited"; }), /immutable/);
  assert.equal((await store.read()).templates[0].name, "Default Connectivity");
});

test("a shipped template revision replaces the persisted stock catalog without changing user data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-overlay-stock-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "overlay-presets.json");
  const options = await storeFixtureOptions(statePath);
  const originalStore = new OverlayStore(options);
  const original = await originalStore.init();
  const updatedStock = structuredClone(options.stockDocument);
  updatedStock.templates[0].config.history_len = 33;
  const upgradedStore = new OverlayStore({ ...options, stockDocument:updatedStock });
  const upgraded = await upgradedStore.init();
  assert.equal(upgraded.templates[0].config.history_len, 33);
  assert.equal(upgraded.revision, original.revision + 1);
  assert.deepEqual(upgraded.presets, original.presets);
  assert.ok(await readFile(`${statePath}.bak`, "utf8"));
});

test("obsolete V2 design keys are pruned during startup sync", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-overlay-v2-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "overlay-presets.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const options = await storeFixtureOptions(statePath);
  const template = structuredClone(options.stockDocument.templates[0]);
  const preset = {
    ...template,
    id:"custom-camera",
    template_id:template.id,
    revision:1,
    created_at:"2026-06-21T12:00:00Z",
    updated_at:"2026-06-21T12:00:00Z",
  };
  delete preset.builtin;
  delete preset.readonly;
  preset.layout.legacy_growth = "left";
  preset.theme.legacy_font_family = "Inter";
  preset.config.chart_line_width_px = 2;
  await writeFile(statePath, JSON.stringify({
    ...options.stockDocument,
    revision:7,
    presets:[preset],
    sources:[{id:"source-custom-camera",slug:"custom-camera",source_key:"ABCDEFGHIJKLMNOPQRSTUVWX",display_name:"Custom Camera",preset_id:"custom-camera",enabled:true,data_source:{kind:"stream",stream_profile_id:null},revision:1,created_at:preset.created_at,updated_at:preset.updated_at}],
  }));
  const store = new OverlayStore(options);
  const synced = await store.init();
  assert.equal(synced.revision, 8);
  assert.equal("legacy_growth" in synced.presets[0].layout, false);
  assert.equal("legacy_font_family" in synced.presets[0].theme, false);
  assert.equal("chart_line_width_px" in synced.presets[0].config, false);
});

test("startup clamps persisted values to supported ranges", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-overlay-poll-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "overlay-presets.json");
  const options = await storeFixtureOptions(statePath);
  const document = structuredClone(options.stockDocument);
  document.revision = 7;
  document.presets.push({
    id:"too-fast",
    template_id:"default-connectivity",
    revision:1,
    created_at:"2026-06-20T12:00:00.000Z",
    updated_at:"2026-06-20T12:00:00.000Z",
    name:"Too Fast",
    enabled:true,
    type:"connectivity",
    layout:{dock:"br",pad:20},
    theme:{},
    config:{poll_ms:20},
  });
  const uploadTemplate = structuredClone(document.templates.find((template) => template.type === "upload_progress"));
  const oversizedCompletionRadius = {
    ...uploadTemplate,
    id:"oversized-completion-radius",
    template_id:uploadTemplate.id,
    revision:1,
    created_at:"2026-06-20T12:00:00.000Z",
    updated_at:"2026-06-20T12:00:00.000Z",
    name:"Oversized completion radius",
    theme:{...uploadTemplate.theme,completion_radius_px:999},
  };
  delete oversizedCompletionRadius.builtin;
  delete oversizedCompletionRadius.readonly;
  document.presets.push(oversizedCompletionRadius);
  await writeFile(statePath, JSON.stringify(document));
  const store = new OverlayStore(options);
  const upgraded = await store.init();
  assert.equal(upgraded.presets.find((preset) => preset.id === "too-fast").config.poll_ms, 200);
  assert.equal(upgraded.presets.find((preset) => preset.id === "oversized-completion-radius").theme.completion_radius_px, 48);
  assert.equal(upgraded.revision, 8);
});
