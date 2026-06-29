import { deriveUploadView, formatBytes, formatDuration, uploadSummary } from "./upload-renderer-core.js";
import { ServiceReloadWatchdog } from "./renderer-core.js";

let payload = window.FRAME_OVERLAY;
let preset = payload.preset;
let config = preset.config || {};
let theme = preset.theme || {};
let eventSource;
let restTimer;
let settingsTimer;
let restInflight = false;
let lastSnapshot;
const reloadWatchdog = new ServiceReloadWatchdog();
const previewMode = new URLSearchParams(location.search).has("preview");
const widget = document.querySelector("#widget");
const status = document.querySelector("#upload-status");
const sourceName = document.querySelector("#source-name");
const adapterLabel = document.querySelector("#adapter-label");
const focusName = document.querySelector("#focus-name");
const summary = document.querySelector("#upload-summary");
const currentProgressName = document.querySelector("#current-progress-name");
const currentProgressValue = document.querySelector("#current-progress-value");
const currentProgressTrack = document.querySelector("#current-progress-track");
const currentProgressFill = document.querySelector("#current-progress-fill");
const overallProgressValue = document.querySelector("#overall-progress-value");
const overallProgressTrack = document.querySelector("#overall-progress-track");
const overallProgressFill = document.querySelector("#overall-progress-fill");
const sentDetail = document.querySelector("#sent-detail");
const speedDetail = document.querySelector("#speed-detail");
const elapsedDetail = document.querySelector("#elapsed-detail");
const sentValue = document.querySelector("#sent-value");
const speedValue = document.querySelector("#speed-value");
const elapsedValue = document.querySelector("#elapsed-value");
const errorValue = document.querySelector("#upload-error");

const query = new URLSearchParams(location.search);
const elementPreviewMode = query.has("elementPreview");
if (previewMode) document.body.classList.add("preview");
if (elementPreviewMode) document.body.classList.add("element-preview");
applyPayload(payload);
if (previewMode) acceptSnapshot(mockSnapshot()); else connectEvents();
setInterval(render, 500);
if (elementPreviewMode) new ResizeObserver(publishPreviewSize).observe(widget);
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "frame-preview" || !event.data.preset) return;
  applyPayload({ ...payload, ...event.data });
});

function applyPayload(next) {
  if (payload && payload.telemetry_identity !== next.telemetry_identity) lastSnapshot = undefined;
  payload = next; preset = payload.preset; config = preset.config || {}; theme = preset.theme || {};
  applyTheme(); applyLayout(); render(); publishPreviewSize();
}

function connectEvents() {
  eventSource?.close();
  if (!payload.events_url || !("EventSource" in window)) return startRestFallback();
  eventSource = new EventSource(payload.events_url);
  eventSource.addEventListener("open", () => { reloadWatchdog.markOnline(); stopRestFallback(); });
  eventSource.addEventListener("telemetry", (event) => { reloadWatchdog.markOnline(); stopRestFallback(); acceptSnapshot(JSON.parse(event.data)); });
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
  try { const response = await fetch(payload.stats_url,{cache:"no-store"}); if(response.ok){reloadWatchdog.markOnline();acceptSnapshot(await response.json());} }
  catch { reloadWatchdog.markOffline(); }
  finally { restInflight = false; }
}
async function refreshSettings() {
  try { const response=await fetch(payload.settings_url,{cache:"no-store"}); if(response.ok){reloadWatchdog.markOnline();const next=await response.json();if(next.revision!==payload.revision)applyPayload(next);} }
  catch { reloadWatchdog.markOffline(); }
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
    adapterLabel.textContent = adapterLabelFor(payload.source?.data_source?.adapters || ["web_upload"]);
    currentProgressName.textContent = "Current file";
    currentProgressName.title = "";
    currentProgressValue.textContent = "--";
    currentProgressTrack.classList.remove("indeterminate");
    currentProgressFill.style.width = "0%";
    overallProgressValue.textContent = "0/0";
    overallProgressTrack.classList.remove("indeterminate");
    overallProgressFill.style.width = "0%";
    errorValue.hidden = true;
    widget.classList.toggle("hidden", !lastSnapshot?.error && config.idle_behavior !== "show_idle");
    return;
  }
  const focus = view.focus;
  widget.classList.remove("hidden");
  status.textContent = phaseStatus(focus.phase);
  sourceName.textContent = payload.source?.display_name || preset.name;
  adapterLabel.textContent = adapterLabelFor(view.adapters.length ? view.adapters : [focus.adapter]);
  focusName.textContent = focusOrdinal(view);
  summary.textContent = uploadSummary(view);
  currentProgressName.textContent = focus.filename || "Unnamed transfer";
  currentProgressName.title = focus.filename || "";
  currentProgressValue.textContent = percentText(view.current_percent);
  currentProgressTrack.classList.toggle("indeterminate", focus.phase === "receiving" && view.current_percent === null);
  currentProgressFill.style.width = `${view.current_percent ?? (focus.phase === "queued" || focus.phase === "processing" || focus.phase === "published" ? 100 : 0)}%`;
  overallProgressValue.textContent = `${view.overall_complete}/${view.overall_total}`;
  overallProgressTrack.classList.remove("indeterminate");
  overallProgressFill.style.width = `${view.overall_percent}%`;
  sentDetail.hidden = config.show_sent === false;
  speedDetail.hidden = config.show_speed === false || view.speed_bps === null;
  elapsedDetail.hidden = config.show_elapsed === false || !focus.capabilities?.elapsed;
  sentValue.textContent = view.current_bytes_total === null ? formatBytes(view.current_bytes_received) : `${formatBytes(view.current_bytes_received)} / ${formatBytes(view.current_bytes_total)}`;
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
  publishPreviewSize();
}

function applyTheme() {
  const root=document.documentElement;
  const vars={"--text":theme.text_color||"#eef8ff","--muted":theme.muted_color||"#9fc6dc","--good":theme.good_color||"#2cb4fb","--warn":theme.warn_color||"#ffd166","--bad":theme.bad_color||"#ff5f6d","--plot-primary":theme.plot_primary||"#2cb4fb","--radius":`${theme.border_radius_px??10}px`,"--blur":`${theme.backdrop_blur_px??4}px`,"--font-size":`${theme.font_size_base_px??16}px`,"--scale":String(preset.layout.scale??1),"--transition":"250ms"};
  for(const [name,value] of Object.entries(vars))root.style.setProperty(name,value);
}
function applyLayout() {
  const pad=`${preset.layout.pad??20}px`;
  const placement={tl:{top:pad,left:pad,origin:"top left"},t:{top:pad,left:"50%",transform:"translateX(-50%)",origin:"top center"},tr:{top:pad,right:pad,origin:"top right"},l:{left:pad,top:"50%",transform:"translateY(-50%)",origin:"center left"},c:{left:"50%",top:"50%",transform:"translate(-50%, -50%)",origin:"center"},r:{right:pad,top:"50%",transform:"translateY(-50%)",origin:"center right"},bl:{bottom:pad,left:pad,origin:"bottom left"},b:{bottom:pad,left:"50%",transform:"translateX(-50%)",origin:"bottom center"},br:{bottom:pad,right:pad,origin:"bottom right"}}[preset.layout.dock||"bl"];
  const {origin,transform="",...position}=placement;
  if(elementPreviewMode){Object.assign(widget.style,{top:"",right:"",bottom:"",left:""});widget.style.transform="scale(var(--scale, 1))";widget.style.transformOrigin="top left";}
  else{Object.assign(widget.style,{top:"",right:"",bottom:"",left:""},position);widget.style.transform=`${transform} scale(var(--scale, 1))`.trim();widget.style.transformOrigin=origin;}
  widget.style.width=`${config.width_px||preset.layout.width_px||520}px`;
}
function publishPreviewSize(){
  if(!elementPreviewMode||window.parent===window)return;
  requestAnimationFrame(()=>{const rect=widget.getBoundingClientRect();if(!rect.width||!rect.height)return;window.parent.postMessage({type:"frame-preview-size",width:Math.ceil(rect.width+28),height:Math.ceil(rect.height+28),content_width:Math.ceil(rect.width),content_height:Math.ceil(rect.height)},"*");});
}
function phaseStatus(phase) {
  if (phase === "receiving") return "UPLOADING";
  if (phase === "queued") return "ACCEPTED";
  return phase.toUpperCase();
}
function focusOrdinal(view) {
  if (!view.overall_total || view.focus_index < 0) return phaseStatus(view.focus?.phase || "receiving");
  return `${phaseStatus(view.focus.phase)} ${view.focus_index + 1}/${view.overall_total}`;
}
function percentText(value) {
  return value === null ? "--" : `${Math.round(value)}%`;
}
function adapterLabelFor(adapters) {
  const labels = (Array.isArray(adapters) ? adapters : []).map((adapter) => String(adapter).replace(/^web_upload$/,"web").replace(/^belabox_agent$/,"belabox").replaceAll("_"," ").toUpperCase());
  return labels.length ? labels.join("+") : "WEB";
}
function mockSnapshot(){const now=new Date();return{sequence:1,observed_at:now.toISOString(),received_at:now.toISOString(),stale:false,transfers:[{transfer_id:"web_upload:preview-a",adapter:"web_upload",phase:"receiving",filename:"FRAME_Adventure_001.jpg",bytes_received:7340032,bytes_total:12582912,speed_bps:1572864,elapsed_ms:4700,started_at:new Date(now-4700).toISOString(),updated_at:now.toISOString(),capabilities:{filename:true,total_bytes:true,speed:true,elapsed:true}},{transfer_id:"web_upload:preview-b",adapter:"web_upload",phase:"queued",filename:"FRAME_Adventure_002.jpg",bytes_received:8388608,bytes_total:8388608,speed_bps:null,elapsed_ms:5200,started_at:new Date(now-5200).toISOString(),updated_at:now.toISOString(),capabilities:{filename:true,total_bytes:true,speed:false,elapsed:true}},{transfer_id:"web_upload:preview-c",adapter:"web_upload",phase:"receiving",filename:"Very_Long_Mobile_Camera_Roll_File_Name_That_Should_Ellipsize_003.jpg",bytes_received:3145728,bytes_total:20971520,speed_bps:524288,elapsed_ms:2600,started_at:new Date(now-2600).toISOString(),updated_at:now.toISOString(),capabilities:{filename:true,total_bytes:true,speed:true,elapsed:true}}]};}
