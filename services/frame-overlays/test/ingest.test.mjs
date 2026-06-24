import assert from "node:assert/strict";
import test from "node:test";
import { UploadProgressHub, aggregateTransfers } from "../dist/ingest.js";

const transfer = (overrides = {}) => ({
  transfer_id:"web_upload:a",
  adapter:"web_upload",
  phase:"receiving",
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
