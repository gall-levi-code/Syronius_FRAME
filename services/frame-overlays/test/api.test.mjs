import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFrameOverlaysApp } from "../dist/app.js";
import { OverlayStore } from "../dist/store.js";
import { storeFixtureOptions } from "./helpers.mjs";

test("source creation returns a keyed URL, rejects stale writes, and stock templates are read-only", async (t) => {
  const fixture = await startFixture(t);
  const catalog = await json(`${fixture.base}/overlays/api/catalog`);
  const created = await json(`${fixture.base}/overlays/api/sources`, {
    method:"POST",
    body:JSON.stringify({ expected_revision:catalog.revision, template_id:"default-connectivity", preset_name:"Main Preset", display_name:"Main Camera", slug:"main-camera", data_source:{kind:"stream",stream_profile_id:"stream-1"} }),
  });
  assert.match(created.source.public_url, /\/overlays\/view\/main-camera\/[A-Za-z0-9_-]{24}$/);
  assert.equal((await fetch(`${fixture.base}${new URL(created.source.public_url).pathname}`)).status, 200);
  assert.equal((await fetch(`${fixture.base}/overlays/api/templates/default-connectivity`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:"{}" })).status, 405);
  const invalidRttOrder = await fetch(`${fixture.base}/overlays/api/presets/${created.preset.id}`, {
    method:"PUT",
    headers:{"Content-Type":"application/json","If-Match":"1"},
    body:JSON.stringify({ preset:{ ...created.preset, config:{ ...created.preset.config, rtt_warn_max:1500, rtt_bad_max:7000, chart_rtt_max:6000 } } }),
  });
  assert.equal(invalidRttOrder.status, 400);
  const invalidPreset = await fetch(`${fixture.base}/overlays/api/presets/${created.preset.id}`, { method:"PUT", headers:{"Content-Type":"application/json","If-Match":"1"}, body:JSON.stringify({name:"Invalid",enabled:true,type:"connectivity",layout:{},theme:{},config:{}}) });
  assert.equal(invalidPreset.status, 400);
  const conflict = await fetch(`${fixture.base}/overlays/api/sources/${created.source.id}`, { method:"PUT", headers:{"Content-Type":"application/json","If-Match":"0"}, body:JSON.stringify({display_name:"Stale"}) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).current_revision, 1);
  assert.equal((await fetch(`${fixture.base}/overlays/stats/secret-player`)).status, 410);
  const bindings = await json(`${fixture.base}/internal/streams/overlay-bindings`, { headers:{Authorization:"Bearer test-key"} });
  assert.deepEqual(bindings.bindings, [{ stream_profile_id:"stream-1", source_id:created.source.id, display_name:"Main Camera", slug:"main-camera", preset_name:"Main Preset", enabled:true }]);
  assert.equal((await fetch(`${fixture.base}/internal/streams/overlay-bindings`)).status, 401);
  const uploadSource = await json(`${fixture.base}/overlays/api/sources`, {
    method:"POST",
    body:JSON.stringify({ expected_revision:1, template_id:"default-upload-progress", preset_name:"Uploads Preset", display_name:"Photo Uploads", slug:"photo-uploads", data_source:{kind:"upload_progress",adapters:["web_upload","ftp","belabox_agent"]} }),
  });
  assert.equal(uploadSource.preset.type, "upload_progress");
  assert.deepEqual(uploadSource.source.data_source, { kind:"upload_progress", adapters:["web_upload","ftp","belabox_agent"] });
  const uploadView = await fetch(`${fixture.base}${new URL(uploadSource.source.public_url).pathname}`);
  assert.equal(uploadView.status, 200);
  assert.match(await uploadView.text(), /journey-list/);
  const uploadStats = await json(`${fixture.base}${new URL(uploadSource.source.public_url).pathname}/stats`);
  assert.equal(uploadStats.schema_version, "2.0");
  assert.equal(uploadStats.transfers.some((transfer) => transfer.adapter === "ftp" && transfer.status_text === "Receiving via FTP"), true);
  assert.equal(uploadStats.transfers.some((transfer) => transfer.adapter === "belabox_agent" && transfer.status_text === "Uploading 42%"), true);
  assert.equal(uploadStats.transfers.filter((transfer) => transfer.journey_id === "photo-journey-1").length, 3);
  assert.equal(uploadStats.journeys.filter((journey) => journey.journey_id === "photo-journey-1").length, 1);
  assert.equal(uploadStats.journeys.find((journey) => journey.journey_id === "photo-journey-1").stages.length, 3);
  assert.equal(uploadStats.journeys.find((journey) => journey.journey_id === "photo-journey-1").phase, "processing");
  assert.equal(uploadStats.journeys.find((journey) => journey.journey_id === "photo-journey-1").transfer_completed_at, null);
  assert.equal(uploadStats.aggregate.processing, 1);
  const duplicateName = await fetch(`${fixture.base}/overlays/api/sources`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ expected_revision:uploadSource.revision, template_id:"default-upload-progress", preset_name:"Duplicate Uploads Preset", display_name:"photo uploads", slug:"photo-uploads-copy", data_source:{kind:"upload_progress",adapters:["web_upload"]} }),
  });
  assert.equal(duplicateName.status, 409);
  const crossType = await fetch(`${fixture.base}/overlays/api/sources/${created.source.id}`, {
    method:"PUT",
    headers:{"Content-Type":"application/json","If-Match":"2"},
    body:JSON.stringify({ preset_id:uploadSource.preset.id }),
  });
  assert.equal(crossType.status, 409);
  const deleteUpload = await fetch(`${fixture.base}/overlays/api/sources/${uploadSource.source.id}`, { method:"DELETE", headers:{"If-Match":String(uploadSource.revision)} });
  assert.equal(deleteUpload.status, 204);
  const afterDelete = await json(`${fixture.base}/overlays/api/catalog`);
  assert.equal(afterDelete.sources.some((source) => source.id === uploadSource.source.id), false);
  assert.equal(afterDelete.presets.some((preset) => preset.id === uploadSource.preset.id), false);
});

test("upload sources preserve explicit adapter exclusions across design saves", async (t) => {
  const fixture = await startFixture(t);
  const catalog = await json(`${fixture.base}/overlays/api/catalog`);
  const created = await json(`${fixture.base}/overlays/api/sources`, {
    method:"POST",
    body:JSON.stringify({ expected_revision:catalog.revision, template_id:"default-upload-progress", preset_name:"FTP Only", display_name:"FTP Only", slug:"ftp-only", data_source:{kind:"upload_progress",adapters:["web_upload","ftp"]} }),
  });
  const sourceUpdate = await json(`${fixture.base}/overlays/api/sources/${created.source.id}`, {
    method:"PUT",
    headers:{"If-Match":String(created.revision)},
    body:JSON.stringify({ ...created.source, data_source:{kind:"upload_progress",adapters:["ftp"]} }),
  });
  assert.deepEqual(sourceUpdate.source.data_source.adapters, ["ftp"]);
  await json(`${fixture.base}/overlays/api/presets/${created.preset.id}`, {
    method:"PUT",
    headers:{"If-Match":String(sourceUpdate.revision)},
    body:JSON.stringify({ preset:{ ...created.preset, config:{ ...created.preset.config, max_visible_journeys:3 } } }),
  });
  const saved = await json(`${fixture.base}/overlays/api/catalog`);
  assert.deepEqual(saved.sources.find(({ id }) => id === created.source.id).data_source.adapters, ["ftp"]);
});

test("a migrated V1 OBS URL still renders through its legacy alias", async (t) => {
  const fixture = await startFixture(t, { schema_version:"1.0", default_preset_id:"old-camera", presets:[{ id:"old-camera",name:"Old Camera",type:"connectivity",enabled:true,layout:{dock:"br",pad:20},theme:{},config:{stream_profile_id:null,poll_ms:1000} }] });
  const response = await fetch(`${fixture.base}/overlays/view/old-camera`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Old Camera/);
});

async function startFixture(t, initialState) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-overlay-api-"));
  const statePath = path.join(root,"state","overlay-presets.json");
  if(initialState){await mkdir(path.dirname(statePath),{recursive:true});await writeFile(statePath,JSON.stringify(initialState));}
  const store = new OverlayStore(await storeFixtureOptions(statePath));
  const runtime = await createFrameOverlaysApp({ config:{publicBaseUrl:"http://placeholder",requestTimeoutMs:1000,slsApiKey:"test-key"}, store, publicDir:path.resolve("public"), streamsFetch:async()=>new Response(JSON.stringify({streams:[]}),{status:200,headers:{"Content-Type":"application/json"}}), photoUploadFetch:async()=>new Response(JSON.stringify({transfers:[]}),{status:200,headers:{"Content-Type":"application/json"}}), photoFtpFetch:async()=>new Response(JSON.stringify({transfers:[{transfer_id:"ftp-1",journey_id:"photo-journey-1",adapter:"ftp",phase:"receiving",filename:"IMG_1234.JPG",bytes_received:2048,bytes_total:null,speed_bps:512,elapsed_ms:4000,started_at:"2026-06-21T12:00:00Z",updated_at:"2026-06-21T12:00:04Z",status_text:"Receiving via FTP"}]}),{status:200,headers:{"Content-Type":"application/json"}}), photoPipelineFetch:async()=>new Response(JSON.stringify({journeys:[{journey_id:"photo-journey-1",original_name:"IMG_1234.JPG",received_at:"2026-06-21T12:00:00Z",updated_at:"2026-06-21T12:00:04Z",job_id:"pipeline-job-1",state:"processing",ingest:{adapter:"belabox_agent",transfer_id:"ftp-1",bytes_received:2048}}]}),{status:200,headers:{"Content-Type":"application/json"}}), belaboxManagerFetch:async()=>new Response(JSON.stringify({transfers:[{transfer_id:"belabox-1:file",journey_id:"photo-journey-1",adapter:"belabox_agent",phase:"receiving",filename:"IMG_1234.JPG",bytes_received:420,bytes_total:1000,speed_bps:100,elapsed_ms:1000,started_at:"2026-06-21T12:00:00Z",updated_at:"2026-06-21T12:00:01Z",status_text:"Uploading 42%"}]}),{status:200,headers:{"Content-Type":"application/json"}}) });
  const server = runtime.app.listen(0);
  await new Promise((resolve)=>server.once("listening",resolve));
  const address=server.address(); const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{runtime.close();await new Promise((resolve)=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return { base, store };
}

async function json(url, options) { const response=await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options?.headers||{})}}); if(!response.ok)assert.fail(`${response.status}: ${await response.text()}`); return response.json(); }
