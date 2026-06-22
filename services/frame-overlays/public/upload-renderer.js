import { deriveUploadView, formatBytes, formatDuration, uploadSummary } from "./upload-renderer-core.js";

let payload = window.FRAME_OVERLAY;
let preset = payload.preset;
let config = preset.config || {};
let theme = preset.theme || {};
let eventSource;
let restTimer;
let settingsTimer;
let restInflight = false;
let lastSnapshot;
const previewMode = new URLSearchParams(location.search).has("preview");
const widget = document.querySelector("#widget");
const status = document.querySelector("#upload-status");
const sourceName = document.querySelector("#source-name");
const adapterLabel = document.querySelector("#adapter-label");
const focusName = document.querySelector("#focus-name");
const summary = document.querySelector("#upload-summary");
const progressTrack = document.querySelector("#progress-track");
const progressFill = document.querySelector("#progress-fill");
const sentDetail = document.querySelector("#sent-detail");
const speedDetail = document.querySelector("#speed-detail");
const elapsedDetail = document.querySelector("#elapsed-detail");
const sentValue = document.querySelector("#sent-value");
const speedValue = document.querySelector("#speed-value");
const elapsedValue = document.querySelector("#elapsed-value");
const errorValue = document.querySelector("#upload-error");

if (previewMode) document.body.classList.add("preview");
applyPayload(payload);
if (previewMode) acceptSnapshot(mockSnapshot()); else connectEvents();
setInterval(render, 500);
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "frame-preview" || !event.data.preset) return;
  applyPayload({ ...payload, ...event.data });
});

function applyPayload(next) {
  if (payload && payload.telemetry_identity !== next.telemetry_identity) lastSnapshot = undefined;
  payload = next; preset = payload.preset; config = preset.config || {}; theme = preset.theme || {};
  applyTheme(); applyLayout(); render();
}

function connectEvents() {
  eventSource?.close();
  if (!payload.events_url || !("EventSource" in window)) return startRestFallback();
  eventSource = new EventSource(payload.events_url);
  eventSource.addEventListener("open", stopRestFallback);
  eventSource.addEventListener("telemetry", (event) => { stopRestFallback(); acceptSnapshot(JSON.parse(event.data)); });
  eventSource.addEventListener("config", (event) => applyPayload(JSON.parse(event.data)));
  eventSource.onerror = startRestFallback;
  clearInterval(settingsTimer);
  settingsTimer = setInterval(refreshSettings, 15_000);
}

function startRestFallback() {
  if (restTimer) return;
  void refreshTelemetry();
  restTimer = setInterval(refreshTelemetry, config.active_poll_ms || 200);
}
function stopRestFallback() { clearInterval(restTimer); restTimer = undefined; }
async function refreshTelemetry() {
  if (restInflight || !payload.stats_url) return;
  restInflight = true;
  try { const response = await fetch(payload.stats_url,{cache:"no-store"}); if(response.ok) acceptSnapshot(await response.json()); }
  finally { restInflight = false; }
}
async function refreshSettings() {
  try { const response=await fetch(payload.settings_url,{cache:"no-store"}); if(response.ok){const next=await response.json();if(next.revision!==payload.revision)applyPayload(next);} }
  catch { /* Keep last-known configuration while SSE reconnects. */ }
}
function acceptSnapshot(snapshot) { if(lastSnapshot && snapshot.sequence < lastSnapshot.sequence)return; lastSnapshot=snapshot; render(); }

function render() {
  if (preset.enabled === false || payload.source?.enabled === false) return widget.classList.add("hidden");
  const view = deriveUploadView(lastSnapshot?.transfers, config.complete_hide_ms ?? 5000);
  if (!view.focus) {
    status.textContent = lastSnapshot?.error ? "UNAVAILABLE" : config.idle_label || "WAITING FOR UPLOAD";
    sourceName.textContent = payload.source?.display_name || preset.name;
    focusName.textContent = lastSnapshot?.error || "No active transfers";
    summary.textContent = "";
    progressTrack.classList.remove("indeterminate"); progressFill.style.width="0%";
    errorValue.hidden = true;
    widget.classList.toggle("hidden", config.idle_behavior !== "show_idle");
    return;
  }
  const focus = view.focus;
  widget.classList.remove("hidden");
  status.textContent = focus.phase === "receiving" ? "UPLOADING" : focus.phase.toUpperCase();
  sourceName.textContent = payload.source?.display_name || preset.name;
  adapterLabel.textContent = focus.adapter.replaceAll("_"," ").toUpperCase();
  focusName.textContent = focus.filename || "Unnamed transfer";
  summary.textContent = uploadSummary(view);
  progressTrack.classList.toggle("indeterminate", view.receiving > 0 && view.percent === null);
  progressFill.style.width = `${view.percent ?? (focus.phase === "queued" || focus.phase === "published" ? 100 : 0)}%`;
  sentDetail.hidden = config.show_sent === false;
  speedDetail.hidden = config.show_speed === false || view.speed_bps === null;
  elapsedDetail.hidden = config.show_elapsed === false || !focus.capabilities?.elapsed;
  sentValue.textContent = view.bytes_total === null ? formatBytes(view.bytes_received) : `${formatBytes(view.bytes_received)} / ${formatBytes(view.bytes_total)}`;
  speedValue.textContent = view.speed_bps === null ? "--" : `${formatBytes(view.speed_bps)}/s`;
  elapsedValue.textContent = formatDuration(focus.elapsed_ms);
  errorValue.hidden = focus.phase !== "failed"; errorValue.textContent = focus.error || "Upload failed";
  const stateColor = focus.phase === "failed" ? theme.bad_color || "#ff5f6d" : focus.phase === "receiving" ? theme.good_color || "#2cb4fb" : theme.warn_color || "#ffd166";
  const stateOpacity = focus.phase === "failed"
    ? theme.bg_opacity_bad ?? .72
    : focus.phase === "receiving"
      ? theme.bg_opacity_good ?? .34
      : theme.bg_opacity_warn ?? .52;
  document.documentElement.style.setProperty("--quality",stateColor);
  document.documentElement.style.setProperty("--widget-opacity",String(stateOpacity));
}

function applyTheme() {
  const root=document.documentElement;
  const vars={"--text":theme.text_color||"#eef8ff","--muted":theme.muted_color||"#9fc6dc","--good":theme.good_color||"#2cb4fb","--warn":theme.warn_color||"#ffd166","--bad":theme.bad_color||"#ff5f6d","--plot-primary":theme.plot_primary||"#2cb4fb","--radius":`${theme.border_radius_px??10}px`,"--blur":`${theme.backdrop_blur_px??4}px`,"--font-size":`${theme.font_size_base_px??16}px`,"--scale":String(preset.layout.scale??1),"--transition":"250ms"};
  for(const [name,value] of Object.entries(vars))root.style.setProperty(name,value);
}
function applyLayout() {
  const pad=`${preset.layout.pad??20}px`;
  const placement={tl:{top:pad,left:pad,origin:"top left"},t:{top:pad,left:"50%",transform:"translateX(-50%)",origin:"top center"},tr:{top:pad,right:pad,origin:"top right"},l:{left:pad,top:"50%",transform:"translateY(-50%)",origin:"center left"},c:{left:"50%",top:"50%",transform:"translate(-50%, -50%)",origin:"center"},r:{right:pad,top:"50%",transform:"translateY(-50%)",origin:"center right"},bl:{bottom:pad,left:pad,origin:"bottom left"},b:{bottom:pad,left:"50%",transform:"translateX(-50%)",origin:"bottom center"},br:{bottom:pad,right:pad,origin:"bottom right"}}[preset.layout.dock||"bl"];
  const {origin,transform="",...position}=placement;Object.assign(widget.style,{top:"",right:"",bottom:"",left:""},position);widget.style.transform=`${transform} scale(var(--scale, 1))`.trim();widget.style.transformOrigin=origin;widget.style.width=`${config.width_px||preset.layout.width_px||520}px`;
}
function mockSnapshot(){const now=new Date();return{sequence:1,observed_at:now.toISOString(),received_at:now.toISOString(),stale:false,transfers:[{transfer_id:"web_upload:preview-a",adapter:"web_upload",phase:"receiving",filename:"FRAME_Adventure_001.jpg",bytes_received:7340032,bytes_total:12582912,speed_bps:1572864,elapsed_ms:4700,started_at:new Date(now-4700).toISOString(),updated_at:now.toISOString(),capabilities:{filename:true,total_bytes:true,speed:true,elapsed:true}},{transfer_id:"web_upload:preview-b",adapter:"web_upload",phase:"queued",filename:"FRAME_Adventure_002.jpg",bytes_received:8388608,bytes_total:8388608,speed_bps:null,elapsed_ms:5200,started_at:new Date(now-5200).toISOString(),updated_at:now.toISOString(),capabilities:{filename:true,total_bytes:true,speed:false,elapsed:true}}]};}
