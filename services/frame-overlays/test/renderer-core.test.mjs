import assert from "node:assert/strict";
import test from "node:test";
import { QUALITY, QualityStabilizer, ServiceReloadWatchdog, canvasPixelSize, compactTelemetryBlockWidth, formatTelemetryDuration, layoutGrowth, normalizedTelemetryBlockWidth, normalizedTelemetryColumns, previewElementSize, qualityStatusText, resolvedTelemetryColumnCount, shouldResetRuntimeState, telemetryAvailability, telemetryGridPixelWidth, telemetryIsStale } from "../public/renderer-core.js";
import { clampBitrateLevels, clampNumericValue, clampRttLevels, samplingWindowLabel } from "../public/wizard-core.js";
import { deriveUploadView, uploadSummary } from "../public/upload-renderer-core.js";

test("quality requires a streak before showing BAD and avoids initial BAD flicker", () => {
  const quality = new QualityStabilizer();
  const config = { bitrate_good_min:5000, bitrate_warn_min:2500, bitrate_streak_bad:2, rtt_streak_bad:2 };
  assert.equal(quality.update({ bitrate:100 }, config), QUALITY.UNKNOWN);
  assert.equal(quality.update({ bitrate:100 }, config), QUALITY.BAD);
  assert.equal(quality.update({ bitrate:7000 }, config), QUALITY.GOOD);
});

test("visual-only revisions preserve runtime state while binding changes reset it", () => {
  assert.equal(shouldResetRuntimeState({ telemetry_identity:"a", revision:"1" }, { telemetry_identity:"a", revision:"2" }), false);
  assert.equal(shouldResetRuntimeState({ telemetry_identity:"a" }, { telemetry_identity:"b" }), true);
});

test("service reload watchdog reloads once after an outage recovers", () => {
  let reloads = 0;
  const watchdog = new ServiceReloadWatchdog({ reload:() => reloads += 1, schedule:(callback) => callback() });
  watchdog.markOffline();
  assert.equal(watchdog.markOnline(), false);
  assert.equal(reloads, 0);
  watchdog.markOffline();
  watchdog.markOffline();
  assert.equal(watchdog.markOnline(), true);
  assert.equal(reloads, 1);
  assert.equal(watchdog.markOnline(), false);
  assert.equal(reloads, 1);
});

test("staleness and high-DPI canvas dimensions are time and pixel aware", () => {
  const received = "2026-06-20T12:00:00Z";
  assert.equal(telemetryIsStale({ received_at:received, stale:false }, 1000, Date.parse("2026-06-20T12:00:04Z")), false);
  assert.equal(telemetryIsStale({ received_at:received, stale:false }, 1000, Date.parse("2026-06-20T12:00:06Z")), true);
  assert.deepEqual(canvasPixelSize(320, 88, 2), { width:640, height:176, ratio:2 });
});

test("bitrate handles clamp independently in warn < good < max order", () => {
  assert.deepEqual(clampBitrateLevels({ warn:7000, good:5000, max:12000 }, "warn"), { warn:4750, good:5000, max:12000 });
  assert.deepEqual(clampBitrateLevels({ warn:2500, good:1000, max:12000 }, "good"), { warn:2500, good:2750, max:12000 });
  assert.deepEqual(clampBitrateLevels({ warn:2500, good:5000, max:4000 }, "max"), { warn:2500, good:5000, max:5250 });
});

test("RTT handles clamp independently in good < bad < max order", () => {
  assert.deepEqual(clampRttLevels({ good:5000, bad:3500, max:6000 }, "good"), { good:3400, bad:3500, max:5000 });
  assert.deepEqual(clampRttLevels({ good:1500, bad:8000, max:6000 }, "bad"), { good:1500, bad:4900, max:5000 });
  assert.deepEqual(clampRttLevels({ good:1500, bad:3500, max:2000 }, "max"), { good:1500, bad:3500, max:3600 });
});

test("compact GOOD status includes bitrate without opening the bitrate card", () => {
  const config = { show_bitrate:true, show_bitrate_in_good:true };
  assert.equal(qualityStatusText(QUALITY.GOOD, { bitrate:7200 }, config, true), "GOOD · 7.20 Mbps");
  assert.equal(qualityStatusText(QUALITY.GOOD, { bitrate:7200 }, { ...config, show_bitrate_in_good:false }, true), "GOOD");
  assert.equal(qualityStatusText(QUALITY.GOOD, { bitrate:7200 }, config, false), "GOOD");
});

test("compact telemetry block width keeps configured width as the floor", () => {
  assert.equal(compactTelemetryBlockWidth(160, 90, 42), 160);
  assert.equal(compactTelemetryBlockWidth(160, 180, 42), 222);
});

test("sampling history reports the visible time window", () => {
  assert.equal(samplingWindowLabel(200, 20), "4 sec");
  assert.equal(samplingWindowLabel(1000, 20), "20 sec");
});

test("numeric sampling controls honor their min, max, and step", () => {
  assert.equal(clampNumericValue(10, 200, 2000, 100), 200);
  assert.equal(clampNumericValue(2200, 200, 2000, 100), 2000);
  assert.equal(clampNumericValue(257, 200, 2000, 100), 300);
});

test("telemetry column wrapping supports auto, fixed counts, and all visible blocks", () => {
  assert.equal(normalizedTelemetryColumns("auto", 8), 0);
  assert.equal(normalizedTelemetryColumns("all", 8), 8);
  assert.equal(normalizedTelemetryColumns(3, 8), 3);
  assert.equal(normalizedTelemetryColumns(12, 8), 8);
  assert.equal(normalizedTelemetryColumns("bad", 8), 0);
  assert.equal(normalizedTelemetryBlockWidth(163), 163);
  assert.equal(normalizedTelemetryBlockWidth(40), 80);
  assert.equal(resolvedTelemetryColumnCount(8, 3, 160, 400), 3);
  assert.equal(resolvedTelemetryColumnCount("all", 8, 160, 400), 8);
  assert.equal(resolvedTelemetryColumnCount("auto", 8, 160, 520), 3);
  assert.equal(telemetryGridPixelWidth(3, 160), 524);
});

test("layout growth defaults inward from anchors and preview size separates viewport from content", () => {
  assert.deepEqual(layoutGrowth({ dock:"br" }), { x:"left", y:"up" });
  assert.deepEqual(layoutGrowth({ dock:"tl" }), { x:"right", y:"down" });
  assert.deepEqual(layoutGrowth({ dock:"c", growth_x:"left", growth_y:"down" }), { x:"left", y:"down" });
  assert.deepEqual(previewElementSize({ offsetWidth:200, scrollWidth:180, offsetHeight:80, scrollHeight:120, getBoundingClientRect:() => ({ width:300, height:180 }) }, 28), {
    width: 328,
    height: 208,
    content_width: 200,
    content_height: 120,
  });
});

test("telemetry uptime shows minutes and seconds before hours", () => {
  assert.equal(formatTelemetryDuration(59), "0m 59s");
  assert.equal(formatTelemetryDuration(3599), "59m 59s");
  assert.equal(formatTelemetryDuration(3661), "1h 1m 1s");
});

test("unavailable feed telemetry is omitted while supported values remain visible", () => {
  assert.deepEqual(telemetryAvailability({
    bitrate: 7200,
    rtt: null,
    latency: null,
    buffer: null,
    dropped_pkts: 0,
    uptime: 120,
    recovery_rate: null,
  }), {
    bitrate: true,
    rtt: false,
    latency: false,
    buffer: false,
    server: true,
    dropped: true,
    uptime: true,
    recovery: false,
    meter: true,
    chart: true,
  });
});

test("upload renderer focuses the most complete active file and does not invent mixed-adapter percentages", () => {
  const transfers=[
    {transfer_id:"web:a",adapter:"web_upload",phase:"receiving",bytes_received:400,bytes_total:1000,speed_bps:100,started_at:"2026-06-21T12:00:00Z",updated_at:"2026-06-21T12:00:02Z"},
    {transfer_id:"ftp:b",adapter:"ftp",phase:"receiving",bytes_received:200,bytes_total:null,speed_bps:50,started_at:"2026-06-21T12:00:01Z",updated_at:"2026-06-21T12:00:02Z"},
    {transfer_id:"web:d",adapter:"web_upload",phase:"receiving",bytes_received:900,bytes_total:1000,speed_bps:75,started_at:"2026-06-21T12:00:02Z",updated_at:"2026-06-21T12:00:02Z"},
    {transfer_id:"web:c",adapter:"web_upload",phase:"queued",bytes_received:100,bytes_total:100,speed_bps:null,started_at:"2026-06-21T11:59:00Z",updated_at:"2026-06-21T12:00:02Z"},
  ];
  const view=deriveUploadView(transfers,5000,Date.parse("2026-06-21T12:00:03Z"));
  assert.equal(view.focus.transfer_id,"web:d");
  assert.equal(view.current_percent,90);
  assert.equal(view.percent,null);
  assert.equal(view.speed_bps,225);
  assert.equal(view.overall_complete,1);
  assert.equal(view.overall_total,4);
  assert.equal(Math.round(view.overall_percent),25);
  assert.deepEqual(view.adapters, ["web_upload", "ftp"]);
  assert.equal(uploadSummary(view),"3 uploading - 1 accepted");
});
