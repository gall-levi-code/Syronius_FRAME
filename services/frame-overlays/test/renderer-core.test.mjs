import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { QUALITY, QualityStabilizer, ServiceReloadWatchdog, canvasPixelSize, compactTelemetryBlockWidth, formatTelemetryDuration, layoutGrowth, normalizedTelemetryBlockWidth, normalizedTelemetryColumns, previewElementSize, previewVisualBounds, qualityStatusText, resolvedTelemetryColumnCount, shouldResetRuntimeState, telemetryAvailability, telemetryGridPixelWidth, telemetryIsStale } from "../public/renderer-core.js";
import { clampBitrateLevels, clampNumericValue, clampRttLevels, previewFrameDimensions, samplingWindowLabel } from "../public/wizard-core.js";
import { completionDockPosition, deriveJourneyQueue, horizontalJourneyLimit, journeyEtaMs, journeyPercent, journeyStatusText, journeysFromSnapshot, journeysWithActiveGrace, previewJourneySnapshots, stabilizeJourneyOrder, unseenCompletedJourneys } from "../public/upload-renderer-core.js";

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
  assert.deepEqual(previewVisualBounds([
    { getBoundingClientRect:() => ({ left:20, top:30, right:320, bottom:150, width:300, height:120 }) },
    { getBoundingClientRect:() => ({ left:300, top:10, right:430, bottom:70, width:130, height:60 }) },
  ], 28), {
    width: 438,
    height: 168,
    content_width: 410,
    content_height: 140,
  });
});

test("upload preview supports truthful canvas framing and deterministic lifecycle scenes", () => {
  assert.deepEqual(previewFrameDimensions("canvas", { width:20, height:20 }), {
    width:1920,
    height:1080,
    contentWidth:1920,
    contentHeight:1080,
  });
  assert.deepEqual(previewFrameDimensions("detail", { width:300.2, height:180.1, contentWidth:280.4, contentHeight:160.8 }), {
    width:301,
    height:181,
    contentWidth:281,
    contentHeight:161,
  });
  assert.deepEqual(previewFrameDimensions("detail"), {
    width:520,
    height:240,
    contentWidth:520,
    contentHeight:240,
  });

  const now = Date.parse("2026-07-24T12:00:00Z");
  for (const [scenario, phases] of Object.entries({
    uploading:["uploading"],
    staged:["staged"],
    processing:["processing"],
    failed:["uploading", "failed"],
    completed:["processing", "published"],
  })) {
    const snapshots = previewJourneySnapshots(scenario, now);
    assert.deepEqual(snapshots.map(({ journeys }) => journeys[0].phase), phases);
    assert.ok(snapshots.every(({ journeys }) => journeys[0].journey_id === "preview-focus"));
  }
  const failed = previewJourneySnapshots("failed", now).at(-1).journeys[0];
  assert.equal(failed.error, "Transfer interrupted");
  const completed = previewJourneySnapshots("completed", now).at(-1).journeys[0];
  assert.equal(completed.bytes_received, completed.bytes_total);
  assert.ok(completed.transfer_completed_at);
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

test("journey queue ranks lifecycle first, then upload ETA and fallback percentage", () => {
  const journey=(journey_id,phase,extra={})=>({
    journey_id,phase,started_at:"2026-06-21T12:00:00Z",updated_at:"2026-06-21T12:00:02Z",...extra,
  });
  const queue=deriveJourneyQueue([
    journey("unknown-40","uploading",{bytes_received:400,bytes_total:1000,speed_bps:null}),
    journey("slow-eta","uploading",{bytes_received:0,bytes_total:1000,speed_bps:50}),
    journey("published","published"),
    journey("staged","staged"),
    journey("fast-eta","uploading",{bytes_received:900,bytes_total:1000,speed_bps:10}),
    journey("unknown-90-new","uploading",{bytes_received:900,bytes_total:1000,speed_bps:null,started_at:"2026-06-21T12:00:01Z"}),
    journey("unknown-90-old","uploading",{bytes_received:900,bytes_total:1000,speed_bps:null,started_at:"2026-06-21T11:59:59Z"}),
    journey("processing","processing"),
    journey("failed","failed",{updated_at:"2026-06-21T12:00:03Z"}),
  ],10);
  assert.deepEqual(queue.active.map((item)=>item.journey_id),[
    "processing","staged","fast-eta","slow-eta","unknown-90-old","unknown-90-new","unknown-40",
  ]);
  assert.equal(queue.active_total,7);
  assert.equal(queue.hidden_active,0);
});

test("journey queue defaults to five visible active journeys", () => {
  const journeys=Array.from({length:7},(_,index)=>({
    journey_id:`photo-${index}`,phase:"uploading",started_at:`2026-06-21T12:00:0${index}Z`,
  }));
  const queue=deriveJourneyQueue(journeys);
  assert.equal(queue.active.length,5);
  assert.equal(queue.active_total,7);
  assert.equal(queue.hidden_active,2);
});

test("horizontal journey queues cap visible cards to the safe viewport width", () => {
  assert.equal(horizontalJourneyLimit(5,1920,520,7,20),3);
  assert.equal(horizontalJourneyLimit(5,600,520,7,20),1);
});

test("journey progress exposes upload percentage and ETA without inventing unknown values", () => {
  const uploading={phase:"uploading",bytes_received:750,bytes_total:1000,speed_bps:50};
  assert.equal(journeyPercent(uploading),75);
  assert.equal(journeyEtaMs(uploading),5000);
  assert.equal(journeyEtaMs({...uploading,speed_bps:0}),null);
  assert.equal(journeyPercent({phase:"uploading",bytes_received:10,bytes_total:null}),null);
  assert.equal(journeyPercent({phase:"processing"}),100);
});

test("journey status copy is canonical and never exposes transport-local wording", () => {
  assert.equal(
    journeyStatusText({phase:"staged",status_text:"Transfer complete via FTP"}),
    "Upload received; waiting for processing",
  );
  assert.equal(journeyStatusText({phase:"processing",status_text:"Pipeline receipt 42"}),"Preparing photo for publication");
  assert.equal(journeyStatusText({phase:"failed",error:"Decode failed"}),"Decode failed");
});

test("same-membership queue reorder must remain desired for 1000ms before committing", () => {
  const a={journey_id:"a"};
  const b={journey_id:"b"};
  let result=stabilizeJourneyOrder([a,b],undefined,0);
  assert.deepEqual(result.journeys,[a,b]);
  result=stabilizeJourneyOrder([b,a],result.state,100);
  assert.deepEqual(result.journeys,[a,b]);
  result=stabilizeJourneyOrder([b,a],result.state,1099);
  assert.deepEqual(result.journeys,[a,b]);
  result=stabilizeJourneyOrder([b,a],result.state,1100);
  assert.deepEqual(result.journeys,[b,a]);
});

test("queue membership changes apply immediately during order stabilization", () => {
  const a={journey_id:"a"};
  const b={journey_id:"b"};
  const c={journey_id:"c"};
  const initial=stabilizeJourneyOrder([a,b],undefined,0);
  const pending=stabilizeJourneyOrder([b,a],initial.state,100);
  const changed=stabilizeJourneyOrder([c,b,a],pending.state,200);
  assert.deepEqual(changed.journeys,[c,b,a]);
  assert.deepEqual(changed.state.order,["c","b","a"]);
});

test("active journey grace bridges brief omissions and yields to terminal truth", () => {
  const processing={journey_id:"photo-a",phase:"processing"};
  const memory=new Map([["photo-a",{journey:processing,last_seen:100}]]);
  assert.deepEqual(journeysWithActiveGrace([],memory,1299,1200),[processing]);
  assert.deepEqual(journeysWithActiveGrace([{...processing,phase:"published"}],memory,1300,1200),[
    {...processing,phase:"published"},
  ]);
  memory.set("photo-a",{journey:processing,last_seen:100});
  assert.deepEqual(journeysWithActiveGrace([],memory,1300,1200),[]);
  assert.equal(memory.has("photo-a"),false);
});

test("completion dock attaches, flips, and overlaps without leaving the safe viewport", () => {
  const anchor={left:20,top:20,right:540,bottom:120};
  const bubble={width:180,height:50};
  const base={anchor,obstacle:anchor,bubble,gap:8,margin:20,alignment:"start"};
  assert.deepEqual(completionDockPosition({...base,viewport:{width:1920,height:1080},direction:"right"}),{
    direction:"right",left:548,top:20,overlap:false,
  });
  assert.deepEqual(completionDockPosition({...base,viewport:{width:700,height:400},direction:"right"}),{
    direction:"down",left:20,top:128,overlap:false,
  });
  const overlap=completionDockPosition({
    ...base,
    viewport:{width:700,height:400},
    direction:"right",
    allowOverlap:true,
  });
  assert.deepEqual(overlap,{direction:"right",left:360,top:20,overlap:true});
});

test("completion requires published phase and fires once per canonical journey", () => {
  const active={journey_id:"photo",transfer_id:"upload:photo",phase:"processing",transfer_completed_at:"2026-06-21T12:00:02Z"};
  const staged={...active,phase:"staged"};
  const published={...active,transfer_id:"pipeline:photo",phase:"published",updated_at:"2026-06-21T12:00:03Z"};
  const seen=new Map();
  const now=Date.parse("2026-06-21T12:00:04Z");
  assert.deepEqual(unseenCompletedJourneys([active],[staged],seen,now,3000),[]);
  assert.deepEqual(unseenCompletedJourneys([active],[published,published],seen,now,3000),[published]);
  assert.deepEqual(unseenCompletedJourneys([published],[published],seen,now,3000),[]);
});

test("completion memory seeds recovery state and suppresses reappearing journeys", () => {
  const completed=(id)=>({
    journey_id:id,phase:"published",updated_at:"2026-06-21T12:00:03Z",transfer_completed_at:"2026-06-21T12:00:03Z",
  });
  const seen=new Map();
  const now=Date.parse("2026-06-21T12:00:04Z");
  assert.deepEqual(unseenCompletedJourneys(undefined,[completed("a")],seen,now,3000),[]);
  assert.deepEqual(unseenCompletedJourneys([], [completed("a")], seen, now + 100, 3000), []);
  assert.equal(seen.has("a"),true);
});

test("completion recovery never flashes an old receipt as a new photo", () => {
  const completed={journey_id:"old",phase:"published",updated_at:"2026-06-21T12:00:03Z",transfer_completed_at:"2026-06-21T12:00:03Z"};
  const now=Date.parse("2026-06-21T12:00:10Z");
  assert.deepEqual(unseenCompletedJourneys([], [completed], new Map(), now, 3000), []);
});

test("completed cards hold, then release their queue slot when flight begins", async () => {
  const source=await readFile("public/upload-renderer.js","utf8");
  const flight=source.slice(source.indexOf("function animateJourneyFlight"),source.indexOf("function hideCompletionBubble"));
  assert.ok(source.includes("const COMPLETION_HOLD_MS = 300;"));
  assert.ok(source.includes("COMPLETION_HOLD_MS + index * 45"));
  assert.ok(source.includes("visibleCompletions.set"));
  assert.ok(flight.includes("const flight = source.cloneNode(true);"));
  assert.ok(flight.indexOf("visibleCompletions.delete(id);") < flight.indexOf("flight.animate"));
  assert.ok(flight.indexOf("render();") < flight.indexOf("flight.animate"));
  assert.ok(flight.includes("flightDock.remove();"));
  assert.ok(source.includes("if (journeyMotionAnimations.has(animation)) animation.cancel();"));
  assert.ok(source.includes("journeyMotionAnimations.add(animation);"));
  assert.ok(source.includes("const maxWidth = elementPreviewMode"));
  assert.ok(source.includes('uploadStack.style.transformOrigin = "top left";'));
});

test("renderer accepts only canonical journey snapshots", () => {
  const journey={journey_id:"photo-a",phase:"uploading",filename:"same.jpg"};
  assert.deepEqual(journeysFromSnapshot({journeys:[journey]}),[journey]);
  assert.deepEqual(journeysFromSnapshot({transfers:[{transfer_id:"legacy"}]}),[]);
});
