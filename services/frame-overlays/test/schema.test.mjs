import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

test("runtime schema/default copies and the canonical V2 example stay synchronized and valid", async () => {
  const [runtimeSchemaText, canonicalSchemaText, runtimeDefaultText, canonicalDefaultText, exampleText, editorText, modelText, uploadRendererText, uploadRendererCss] = await Promise.all([
    readFile("config/overlay-presets.schema.json", "utf8"),
    readFile("../../docs/schemas/overlay-presets.schema.json", "utf8"),
    readFile("config/overlay-presets.default.json", "utf8"),
    readFile("../../docs/schemas/overlay-presets.default.json", "utf8"),
    readFile("../../docs/schemas/overlay-presets.example.json", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/model.ts", "utf8"),
    readFile("public/upload-renderer.js", "utf8"),
    readFile("public/upload-renderer.css", "utf8"),
  ]);
  assert.equal(runtimeSchemaText, canonicalSchemaText);
  assert.equal(runtimeDefaultText, canonicalDefaultText);
  const ajv = new Ajv2020({ allErrors:true, strict:false });
  addFormats(ajv);
  const schema = JSON.parse(runtimeSchemaText);
  const defaults = JSON.parse(runtimeDefaultText);
  const validate = ajv.compile(schema);
  assert.equal(validate(defaults), true, JSON.stringify(validate.errors));
  assert.equal(validate(JSON.parse(exampleText)), true, JSON.stringify(validate.errors));

  const uploadConfig = schema.$defs.upload_progress_config.properties;
  const theme = schema.$defs.theme.properties;
  assert.equal(uploadConfig.max_visible_journeys.maximum, 5);
  assert.equal(theme.completion_radius_px.maximum, 48);
  assert.deepEqual(uploadConfig.completion_direction.enum, ["auto", "left", "right", "up", "down"]);
  assert.deepEqual(uploadConfig.completion_alignment.enum, ["start", "end"]);
  for (const removed of ["complete_poll_ms", "complete_hide_ms", "fetch_timeout_ms"]) assert.equal(removed in uploadConfig, false);

  const uploadDefaults = defaults.templates.find(({ type }) => type === "upload_progress");
  assert.equal(uploadDefaults.config.completion_window_seconds, 3);
  assert.equal(uploadDefaults.config.max_visible_journeys, 5);
  assert.equal(uploadDefaults.config.queue_opacity_step, 0.18);
  assert.equal(uploadDefaults.config.completion_direction, "auto");
  assert.equal(uploadDefaults.config.completion_alignment, "start");
  assert.equal(uploadDefaults.config.completion_overlap, false);
  assert.equal(uploadDefaults.config.status_text_position, "under_filename");
  assert.equal(uploadDefaults.theme.completion_radius_px, 24);
  assert.equal(uploadDefaults.theme.completion_bg_alpha, 1);
  assert.equal(uploadDefaults.theme.journey_gap_px, 8);
  assert.ok(editorText.includes('["theme.journey_gap_px", "Card spacing", 0, 40, 1]'));
  assert.ok(uploadRendererText.includes("theme.journey_gap_px"));
  assert.ok(uploadRendererCss.includes("var(--journey-gap"));
  assert.ok(editorText.includes('["theme.completion_radius_px", "Corner radius", 0, 48, 1]'));
  assert.ok(editorText.includes('editorGroup("Bubble"'));
  assert.deepEqual(
    ["uploading", "staged", "processing", "completed", "failed"].map((state) => uploadDefaults.theme[`${state}_color`]),
    ["#38bdf8", "#f59e0b", "#facc15", "#22c55e", "#ef4444"],
  );
  assert.ok(editorText.includes('key:"upload:all"'));
  assert.ok(editorText.includes("uploadLifecycleColorFields"));
  for (const field of [
    "uploading_color",
    "staged_color",
    "processing_color",
    "completed_color",
    "failed_color",
    "completion_window_seconds",
    "max_visible_journeys",
    "queue_opacity_step",
    "completion_direction",
    "completion_alignment",
    "completion_overlap",
    "status_text_position",
    "completion_bg_color",
    "completion_border_color",
    "completion_text_color",
    "completion_muted_color",
    "completion_glow_color",
    "completion_bg_alpha",
    "completion_border_width_px",
    "completion_radius_px",
    "completion_backdrop_blur_px",
    "completion_padding_x_px",
    "completion_padding_y_px",
    "completion_glow_blur_px",
    "completion_glow_spread_px",
    "completion_glow_offset_x_px",
    "completion_glow_offset_y_px",
    "completion_font_family",
    "completion_font_size_px",
    "completion_font_weight",
    "journey_gap_px",
  ]) assert.ok(modelText.includes(field), `model.ts is missing ${field}`);
  for (const removed of ["complete_poll_ms", "complete_hide_ms", "fetch_timeout_ms"]) {
    assert.equal(modelText.includes(removed), false, `model.ts still declares ${removed}`);
  }
});
