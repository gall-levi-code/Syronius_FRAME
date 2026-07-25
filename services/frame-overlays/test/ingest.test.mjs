import assert from "node:assert/strict";
import test from "node:test";
import { UploadProgressHub, aggregateTransfers, reduceJourneys } from "../dist/ingest.js";

const transfer = (overrides = {}) => ({
  transfer_id:"web_upload:a",
  adapter:"web_upload",
  phase:"uploading",
  filename:"a.jpg",
  bytes_received:400,
  bytes_total:1000,
  speed_bps:200,
  elapsed_ms:2000,
  started_at:"2026-06-21T12:00:00Z",
  updated_at:"2026-06-21T12:00:02Z",
  capabilities:{filename:true,total_bytes:true,speed:true,elapsed:true},
  ...overrides,
});

test("multi-file aggregate is byte-weighted and becomes indeterminate when any total is unknown", () => {
  let aggregate = aggregateTransfers([transfer(), transfer({transfer_id:"web_upload:b",bytes_received:100,bytes_total:500,speed_bps:50})]);
  assert.equal(aggregate.percent, 500 / 1500 * 100);
  assert.equal(aggregate.speed_bps, 250);
  assert.equal(aggregate.focus_transfer_id, "web_upload:a");
  aggregate = aggregateTransfers([transfer(), transfer({transfer_id:"ftp:b",adapter:"ftp",bytes_total:null})]);
  assert.equal(aggregate.percent, null);
  assert.equal(aggregate.bytes_total, null);
});

test("journey reducer correlates exact IDs, retains adapter stages, and never sums duplicate observers", () => {
  const journeys = reduceJourneys([
    transfer({ transfer_id:"belabox:a", journey_id:"photo-a", adapter:"belabox_agent", bytes_received:600, bytes_total:1000, speed_bps:200 }),
    transfer({ transfer_id:"ftp:a", journey_id:"photo-a", adapter:"ftp", bytes_received:580, bytes_total:null, speed_bps:50 }),
  ]);
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].journey_id, "photo-a");
  assert.equal(journeys[0].adapter, "belabox_agent");
  assert.deepEqual(journeys[0].adapters, ["belabox_agent", "ftp"]);
  assert.equal(journeys[0].stages.length, 2);
  const aggregate = aggregateTransfers(journeys[0].stages);
  assert.equal(aggregate.uploading, 1);
  assert.equal(aggregate.bytes_received, 600);
  assert.equal(aggregate.speed_bps, 200);
});

test("journey reducer never merges matching filenames without a canonical ID", () => {
  const journeys = reduceJourneys([
    transfer({ transfer_id:"web:a", adapter:"web_upload", filename:"same.jpg" }),
    transfer({ transfer_id:"ftp:a", adapter:"ftp", filename:"same.jpg" }),
  ]);
  assert.equal(journeys.length, 2);
  assert.notEqual(journeys[0].journey_id, journeys[1].journey_id);
});

test("pipeline publication wins lifecycle while retaining richer transport telemetry", () => {
  const [journey] = reduceJourneys([
    transfer({ transfer_id:"pipeline:a", journey_id:"photo-a", adapter:"pipeline", phase:"published", speed_bps:null, elapsed_ms:null, updated_at:"2026-06-21T12:00:03Z", transfer_completed_at:"2026-06-21T12:00:03Z", status_text:"Photo published" }),
    transfer({ transfer_id:"belabox:a", journey_id:"photo-a", adapter:"belabox_agent", phase:"uploading", bytes_received:900, speed_bps:200, updated_at:"2026-06-21T12:00:04Z" }),
  ]);
  assert.equal(journey.phase, "published");
  assert.equal(journey.adapter, "belabox_agent");
  assert.equal(journey.speed_bps, 200);
  assert.equal(journey.status_text, "Photo published");
  assert.equal(journey.transfer_completed_at, "2026-06-21T12:00:03Z");
  const [failed] = reduceJourneys([
    transfer({ transfer_id:"pipeline:a", journey_id:"photo-a", adapter:"pipeline", phase:"failed", updated_at:"2026-06-21T12:00:03Z", error:"Decode failed" }),
    transfer({ transfer_id:"belabox:a", journey_id:"photo-a", adapter:"belabox_agent", phase:"uploading", updated_at:"2026-06-21T12:00:04Z" }),
  ]);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "Decode failed");
});

test("upload hub shares one non-overlapping adapter request across subscribers", async () => {
  let calls=0; let active=0; let maxActive=0; let release;
  const hub=new UploadProgressHub(async()=>{calls+=1;active+=1;maxActive=Math.max(maxActive,active);await new Promise((resolve)=>{release=resolve;});active-=1;return{transfers:[{transfer_id:"a",phase:"receiving",filename:"a.jpg",bytes_received:10,bytes_total:100,speed_bps:5,elapsed_ms:2000,started_at:"2026-06-21T12:00:00Z",updated_at:"2026-06-21T12:00:02Z"}]};},()=>new Date("2026-06-21T12:00:02Z"));
  const snapshots=[];
  const stopA=hub.subscribe(["web_upload"],1000,2000,(snapshot)=>snapshots.push(snapshot));
  const stopB=hub.subscribe(["web_upload"],1000,2000,(snapshot)=>snapshots.push(snapshot));
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(calls,1);
  release();
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(maxActive,1);
  assert.ok(snapshots.some((snapshot)=>snapshot.transfers.length===1));
  stopA();stopB();hub.stop();
});

test("upload hub preserves raw observations while publishing one canonical journey", async () => {
  const hub = new UploadProgressHub(async (adapter) => ({ transfers:[{
    transfer_id:`${adapter}-stage`, journey_id:"photo-a", phase:"receiving", filename:"a.jpg",
    bytes_received:adapter === "belabox_agent" ? 600 : 580,
    bytes_total:adapter === "belabox_agent" ? 1000 : null,
    speed_bps:adapter === "belabox_agent" ? 200 : null,
    elapsed_ms:2000, started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:02Z",
  }] }), () => new Date("2026-06-21T12:00:02Z"));
  const snapshot = await hub.snapshot(["web_upload", "belabox_agent"], 200, 1000);
  assert.equal(snapshot.schema_version, "2.0");
  assert.equal(snapshot.transfers.length, 2);
  assert.equal(snapshot.journeys.length, 1);
  assert.equal(snapshot.journeys[0].stages.length, 2);
  assert.equal(snapshot.journeys[0].adapter, "belabox_agent");
  assert.equal(snapshot.journeys[0].phase, "uploading");
  assert.equal(snapshot.aggregate.uploading, 1);
  hub.stop();
});

test("raw transport completion becomes staged and is not masked by lingering upload telemetry", async () => {
  const hub = new UploadProgressHub(async () => ({ transfers:[
    {
      transfer_id:"web-stage", journey_id:"photo-a", phase:"published", filename:"a.jpg",
      bytes_received:1000, bytes_total:1000, speed_bps:null, elapsed_ms:2000,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:02Z",
      transfer_completed_at:"2026-06-21T12:00:02Z",
    },
    {
      transfer_id:"web-linger", journey_id:"photo-a", phase:"receiving", filename:"a.jpg",
      bytes_received:900, bytes_total:1000, speed_bps:100, elapsed_ms:3000,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:03Z",
    },
  ] }), () => new Date("2026-06-21T12:00:03Z"));
  const snapshot = await hub.snapshot(["web_upload"], 200, 1000);
  assert.equal(snapshot.journeys[0].phase, "staged");
  assert.equal(snapshot.journeys[0].transfer_completed_at, null);
  assert.equal(snapshot.aggregate.published, 0);
  hub.stop();
});

test("Belabox preparation is omitted until file transit begins", async () => {
  const hub = new UploadProgressHub(async () => ({ transfers:[
    {
      transfer_id:"preparing", journey_id:"photo-a", phase:"processing", filename:"a.jpg",
      bytes_received:0, bytes_total:1000, speed_bps:0, elapsed_ms:100,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:00Z",
      status_text:"Processing image",
    },
    {
      transfer_id:"uploading", journey_id:"photo-b", phase:"receiving", filename:"b.jpg",
      bytes_received:100, bytes_total:1000, speed_bps:100, elapsed_ms:1000,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:01Z",
      status_text:"Uploading 10%",
    },
  ] }), () => new Date("2026-06-21T12:00:01Z"));
  const snapshot = await hub.snapshot(["belabox_agent"], 200, 1000);
  assert.deepEqual(snapshot.journeys.map((journey) => journey.journey_id), ["photo-b"]);
  assert.equal(snapshot.journeys[0].phase, "uploading");
  hub.stop();
});

test("pipeline milestones supplement only their originating upload source", async () => {
  const now = () => new Date("2026-06-21T12:00:04Z");
  const hub = new UploadProgressHub(async (adapter) => adapter === "pipeline" ? { transfers:[
    { transfer_id:"pipeline-web", journey_id:"photo-web", phase:"processing", filename:"web.jpg", bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:null, started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:04Z", source_adapter:"web_upload" },
    { transfer_id:"pipeline-ftp", journey_id:"photo-ftp", phase:"published", filename:"ftp.jpg", bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:null, started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:04Z", transfer_completed_at:"2026-06-21T12:00:02Z", source_adapter:"ftp" },
  ] } : { transfers:[] }, now, ["pipeline"]);
  const snapshot = await hub.snapshot(["web_upload"], 200, 1000);
  assert.deepEqual(snapshot.journeys.map((journey) => journey.journey_id), ["photo-web"]);
  assert.equal(snapshot.journeys[0].phase, "processing");
  assert.equal(snapshot.journeys[0].transfer_completed_at, null);
  hub.stop();
});

test("staged journeys keep the active polling cadence", async () => {
  let now = new Date("2026-06-21T12:00:00Z");
  let calls = 0;
  const hub = new UploadProgressHub(async () => {
    calls += 1;
    return { transfers:[{
      transfer_id:"staged", journey_id:"photo-a", phase:"queued", filename:"a.jpg",
      bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:1000,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:00Z",
    }] };
  }, () => now);
  await hub.snapshot(["web_upload"], 200, 1000);
  now = new Date("2026-06-21T12:00:00.500Z");
  await hub.snapshot(["web_upload"], 200, 1000);
  assert.equal(calls, 2);
  hub.stop();
});

test("supplemental pipeline follows a selected journey's active cadence until publication", async () => {
  let now = new Date("2026-06-21T12:00:00Z");
  const calls = { web_upload:0, pipeline:0 };
  const hub = new UploadProgressHub(async (adapter) => {
    calls[adapter] += 1;
    if (adapter === "pipeline") return { transfers:calls.pipeline === 1 ? [] : [{
      transfer_id:"published", journey_id:"photo-a", source_adapter:"web_upload", phase:"published", filename:"a.jpg",
      bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:null,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:00.500Z",
    }] };
    return { transfers:[{
      transfer_id:"staged", journey_id:"photo-a", phase:"queued", filename:"a.jpg",
      bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:1000,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:00Z",
    }] };
  }, () => now, ["pipeline"]);
  await hub.snapshot(["web_upload"], 200, 1000);
  now = new Date("2026-06-21T12:00:00.500Z");
  await hub.snapshot(["web_upload"], 200, 1000);
  assert.deepEqual(calls, { web_upload:2, pipeline:2 });
  now = new Date("2026-06-21T12:00:01Z");
  await hub.snapshot(["web_upload"], 200, 1000);
  assert.deepEqual(calls, { web_upload:3, pipeline:2 });
  hub.stop();
});

test("live supplemental pipeline polling adopts the selected journey's active timer", async (t) => {
  let pipelineCalls = 0;
  let resolveSecondPipeline;
  const secondPipeline = new Promise((resolve) => { resolveSecondPipeline = resolve; });
  const hub = new UploadProgressHub(async (adapter) => {
    if (adapter === "pipeline") {
      pipelineCalls += 1;
      if (pipelineCalls === 2) resolveSecondPipeline();
      return { transfers:[] };
    }
    return { transfers:[{
      transfer_id:"staged", journey_id:"photo-a", phase:"queued", filename:"a.jpg",
      bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:1000,
      started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:00Z",
    }] };
  }, undefined, ["pipeline"]);
  const unsubscribe = hub.subscribe(["web_upload"], 200, 1000, () => {});
  t.after(() => { unsubscribe(); hub.stop(); });
  await Promise.race([
    secondPipeline,
    new Promise((_, reject) => setTimeout(() => reject(new Error("pipeline stayed on idle cadence")), 700)),
  ]);
  assert.equal(pipelineCalls, 2);
});

test("shared ingress observers do not leak another upload route into the selection", async () => {
  const hub = new UploadProgressHub(async (adapter) => adapter === "web_upload" ? { transfers:[
    { transfer_id:"web", journey_id:"photo-web", source_adapter:"web_upload", phase:"receiving", filename:"web.jpg", bytes_received:10, bytes_total:100, speed_bps:5, elapsed_ms:2000, started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:02Z" },
    { transfer_id:"chunk", journey_id:"photo-belabox", source_adapter:"belabox_chunked", phase:"queued", filename:"belabox.jpg", bytes_received:100, bytes_total:100, speed_bps:null, elapsed_ms:2000, started_at:"2026-06-21T12:00:00Z", updated_at:"2026-06-21T12:00:02Z" },
  ] } : { transfers:[] }, () => new Date("2026-06-21T12:00:02Z"));
  const snapshot = await hub.snapshot(["web_upload"], 200, 1000);
  assert.deepEqual(snapshot.journeys.map((journey) => journey.journey_id), ["photo-web"]);
  hub.stop();
});

test("supplemental pipeline freshness cannot hide a selected adapter outage", async () => {
  const hub = new UploadProgressHub(async (adapter) => {
    if (adapter === "web_upload") throw new Error("Web upload unavailable");
    return { transfers:[] };
  }, () => new Date("2026-06-21T12:00:02Z"), ["pipeline"]);
  const snapshot = await hub.snapshot(["web_upload"], 200, 1000);
  assert.equal(snapshot.received_at, null);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.error, "Web upload unavailable");
  assert.equal(snapshot.adapter_errors.web_upload, "Web upload unavailable");
  hub.stop();
});

test("supplemental failures stay diagnostic without hiding healthy selected progress", async () => {
  const hub = new UploadProgressHub(async (adapter) => {
    if (adapter === "pipeline") throw new Error("Pipeline progress unavailable");
    return { transfers:[] };
  }, () => new Date("2026-06-21T12:00:02Z"), ["pipeline"]);
  const snapshot = await hub.snapshot(["web_upload"], 200, 1000);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.adapter_errors.pipeline, "Pipeline progress unavailable");
  hub.stop();
});
