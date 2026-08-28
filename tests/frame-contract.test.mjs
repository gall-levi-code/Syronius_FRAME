import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
  CAPABILITIES,
  IMPLEMENTED_CAPABILITIES,
  PUBLIC_PREFIXES,
  ROUTES,
  SERVICE_REGISTRY,
  computeComposeProfiles,
  computeEffectivePublicPrefixes,
  enforceDependencies,
  normalizePrefixes,
  upgradeStackConfig,
} from "../installer/frame-contract.mjs";

const execFileAsync = promisify(execFile);

test("canonical registry matches the published stack-config schema", async () => {
  const schema = JSON.parse(await readFile("docs/schemas/stack-config.schema.json", "utf8"));
  assert.deepEqual(schema.properties.capabilities.required, CAPABILITIES);
  assert.deepEqual(Object.keys(schema.properties.capabilities.properties), CAPABILITIES);
  assert.deepEqual(schema.properties.routes.required, Object.keys(ROUTES));
  assert.deepEqual(Object.keys(schema.properties.routes.properties), Object.keys(ROUTES));
});

test("verification, spec, and ignores keep their canonical project contracts", async () => {
  const [workflow, spec, gitignore] = await Promise.all([
    readFile(".github/workflows/verify.yml", "utf8"),
    readFile("docs/spec/v1.1.md", "utf8"),
    readFile(".gitignore", "utf8"),
  ]);
  assert.match(workflow, /^\s+- frame-belabox-manager\s*$/m);
  assert.match(workflow, /^\s+- run: npm test\s*$/m);
  assert.ok(!workflow.includes("contains(fromJSON("), "Every service must run its test script");
  const schemaAppendix = spec.slice(spec.indexOf("### Appendix A — Canonical JSON Schema"));
  assert.ok(schemaAppendix.includes("](../schemas/stack-config.schema.json)"));
  assert.ok(!schemaAppendix.includes("```json"), "The spec must not embed a second schema copy");
  assert.match(gitignore, /^\/\.codex-remote-attachments\/$/m);
});

test("runtime overlay schema and stock defaults match their canonical copies", async () => {
  await assertSameFile(
    "docs/schemas/overlay-presets.schema.json",
    "services/frame-overlays/config/overlay-presets.schema.json",
  );
  await assertSameFile(
    "docs/schemas/overlay-presets.default.json",
    "services/frame-overlays/config/overlay-presets.default.json",
  );
});

test("installer Compose template stays synchronized with the service contracts", async () => {
  const compose = await readFile("installer/templates/docker-compose.yml", "utf8");
  const photoUpload = composeServiceBlock(compose, "frame-photo-upload");
  const photoFtp = composeServiceBlock(compose, "frame-photo-ftp");
  const photoPipeline = composeServiceBlock(compose, "frame-pipeline-photos");
  const belabox = composeServiceBlock(compose, "frame-belabox-manager");
  const today = composeServiceBlock(compose, "frame-today");
  const streams = composeServiceBlock(compose, "frame-streams");
  const overlays = composeServiceBlock(compose, "frame-overlays");
  assert.ok(photoUpload.includes("PORTAL_SERVICE_TOKEN: ${PORTAL_SERVICE_TOKEN}"));
  assert.ok(photoUpload.includes("PHOTO_UPLOAD_MAX_FILES: ${PHOTO_UPLOAD_MAX_FILES:-100}"));
  assert.ok(photoUpload.includes("PHOTO_UPLOAD_MAX_SESSIONS: ${PHOTO_UPLOAD_MAX_SESSIONS:-2}"));
  assert.ok(photoFtp.includes("PHOTO_FTP_MAX_SESSIONS: ${PHOTO_FTP_MAX_SESSIONS:-20}"));
  assert.ok(photoFtp.includes("PHOTO_FTP_MAX_SESSIONS_PER_IP: ${PHOTO_FTP_MAX_SESSIONS_PER_IP:-10}"));
  assert.ok(photoFtp.includes("PHOTO_FTP_PASSIVE_MAX: ${PHOTO_FTP_PASSIVE_MAX:-30019}"));
  assert.ok(photoFtp.includes("PORTAL_SERVICE_TOKEN: ${PORTAL_SERVICE_TOKEN}"));
  assert.ok(photoFtp.includes("${PHOTO_FTP_PASSIVE_MIN:-30000}-${PHOTO_FTP_PASSIVE_MAX:-30019}:${PHOTO_FTP_PASSIVE_MIN:-30000}-${PHOTO_FTP_PASSIVE_MAX:-30019}"));
  assert.ok(photoPipeline.includes("PIPELINE_CONCURRENCY: ${PIPELINE_CONCURRENCY:-2}"));
  assert.ok(photoPipeline.includes("PORTAL_SERVICE_TOKEN: ${PORTAL_SERVICE_TOKEN}"));
  assert.ok(!compose.includes("frame-belabox-broker"));
  assert.ok(!compose.includes("mosquitto"));
  assert.ok(!compose.includes("Path(`/mqtt`)"));
  assert.ok(belabox.includes("BELABOX_HOST: ${BELABOX_HOST:-}"));
  assert.ok(belabox.includes("FRAME_MODE: ${FRAME_MODE:-LAN}"));
  assert.ok(belabox.includes("BELABOX_SSH_CREDENTIAL_KEY: ${BELABOX_SSH_CREDENTIAL_KEY:-}"));
  assert.ok(belabox.includes("BELABOX_AGENT_COMMANDS_ENABLED: ${BELABOX_AGENT_COMMANDS_ENABLED:-false}"));
  assert.ok(belabox.includes("BELABOX_CONTROL_PUBLIC_URL: ${BELABOX_CONTROL_PUBLIC_URL:-ws://localhost/belabox/control}"));
  assert.ok(belabox.includes("BELABOX_CONTROL_RECONNECT_MS: ${BELABOX_CONTROL_RECONNECT_MS:-5000}"));
  assert.ok(belabox.includes("BELABOX_CONTROL_HEARTBEAT_MS: ${BELABOX_CONTROL_HEARTBEAT_MS:-10000}"));
  assert.ok(belabox.includes("traefik.http.routers.frame-belabox-control.priority: \"270\""));
  assert.ok(belabox.includes("traefik.http.routers.frame-belabox-control.rule: Path(`/belabox/control`)"));
  assert.ok(!belabox.includes("traefik.http.routers.frame-belabox-control.middlewares"));
  assert.ok(belabox.includes("BELABOX_CHUNK_UPLOAD_URL: ${BELABOX_CHUNK_UPLOAD_URL:-}"));
  assert.ok(belabox.includes("Path(`/belabox-chunks`) || PathPrefix(`/belabox-chunks/`)"));
  assert.ok(belabox.includes("BELABOX_DIAGNOSTIC_UPLOAD_BYTES: ${BELABOX_DIAGNOSTIC_UPLOAD_BYTES:-8388608}"));
  assert.ok(!belabox.includes("ports:"));
  assert.ok(overlays.includes("PORTAL_SERVICE_TOKEN: ${PORTAL_SERVICE_TOKEN}"));
  assert.ok(overlays.includes("PHOTO_UPLOAD_API_URL: http://frame-photo-upload:3736"));
  assert.ok(overlays.includes("PHOTO_FTP_API_URL: http://frame-photo-ftp:3737"));
  assert.ok(overlays.includes("PHOTO_PIPELINE_URL: http://frame-pipeline-photos:3735"));
  assert.ok(today.includes("PUBLIC_BASE_URL: ${EDGE_PUBLIC_BASE_URL:-http://localhost}"));
  assert.ok(streams.includes("STREAMS_PUBLIC_BASE_URL: ${STREAMS_PUBLIC_BASE_URL:-http://localhost}"));
  assert.ok(streams.includes("Path(`/stats`) || PathPrefix(`/stats/`)"));
  assert.ok(!streams.includes("traefik.http.routers.frame-streams-stats.middlewares"));
});

test("portal routes and implemented Compose profiles stay aligned with the registry", async () => {
  const [portalStackConfig, composeTemplate] = await Promise.all([
    readFile("services/frame-portal/src/stackConfig.ts", "utf8"),
    readFile("installer/templates/docker-compose.yml", "utf8"),
  ]);
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.ok(portalStackConfig.includes(`${name}: "${route}"`), `Portal route ${name} drifted`);
  }
  assert.ok(portalStackConfig.includes("stripBom(text)"), "Portal must tolerate BOM-prefixed stack config");
  for (const name of IMPLEMENTED_CAPABILITIES) {
    for (const profile of SERVICE_REGISTRY.capabilities[name].profiles) {
      assert.ok(composeTemplate.includes(`"${profile}"`), `Compose profile ${profile} is missing`);
    }
  }
});

test("global theme is Portal-backed and available to public surfaces", async () => {
  const [composeTemplate, portalBackend, portalFrontend, themeClient, todayViewer, registry] = await Promise.all([
    readFile("installer/templates/docker-compose.yml", "utf8"),
    readFile("services/frame-portal/src/index.ts", "utf8"),
    readFile("services/frame-portal/public/portal.js", "utf8"),
    readFile("services/frame-portal/public/frame-theme.js", "utf8"),
    readFile("services/frame-today/public/viewer.html", "utf8"),
    readFile("config/frame-services.json", "utf8"),
  ]);
  assert.ok(registry.includes('"prefix": "/api/theme"'), "Hybrid public routes must expose read-only theme state");
  assert.ok(composeTemplate.includes("THEME_CONFIG_PATH: /data/portal-theme/theme.json"));
  assert.ok(composeTemplate.includes("${FRAME_DATA_ROOT:-./data}/portal-theme:/data/portal-theme"));
  assert.ok(composeTemplate.includes("Method(`GET`) && (Path(`/api/theme`) || Path(`/api/portal/theme`))"), "Only Portal theme reads may bypass SSO");
  assert.ok(portalBackend.includes('"/api/theme"'), "Portal must serve global theme reads");
  assert.ok(portalBackend.includes('"/api/portal/theme"'), "Portal must serve the installer-stable theme route");
  assert.ok(portalBackend.includes("app.put(themeApiPaths"), "Portal must persist protected theme writes");
  assert.ok(themeClient.includes('"/api/theme"'), "Shared theme client must read Portal state");
  assert.ok(themeClient.includes('"/api/portal/theme"'), "Shared theme client must support existing public tunnel allowlists");
  assert.ok(!portalFrontend.includes("sanitizeCustomProfiles"), "Portal startup must not call orphaned theme helpers");
  assert.ok(themeClient.includes("setInterval(load"), "Open pages must pick up global theme changes");
  assert.ok(todayViewer.includes("/assets/frame-theme.js"), "Photo Stage viewer must inherit global theme");
});

test("service URL utilities use icon-only Copy and Open controls", async () => {
  const paths = [
    "services/frame-audio/public/admin.js",
    "services/frame-audio-bridge/public/control.html",
    "services/frame-belabox-manager/public/app.js",
    "services/frame-overlays/public/app.js",
    "services/frame-portal/public/portal.js",
    "services/frame-streams/public/app.js",
    "services/frame-today/public/dashboard.html",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  for (const [index, source] of sources.entries()) {
    assert.doesNotMatch(source, /<(?:button|a)\b[^>]*>\s*(?:Copy|Open)\b/i, `${paths[index]} must use an icon for Copy/Open utilities`);
  }
});

test("service URL copy helpers require browser-confirmed clipboard success", async () => {
  const implementations = [
    ["Portal", "services/frame-portal/public/portal.js", "async function copyText", "async function fetchJson"],
    ["Overlay Wizard", "services/frame-overlays/public/app.js", "async function copyText", "function showNotice"],
    ["Belabox Manager", "services/frame-belabox-manager/public/app.js", "async function writeClipboardText", "async function forgetSavedSsh"],
    ["Stream Management", "services/frame-streams/public/app.js", "async function copyText", "function formatBitrate"],
    ["Today Dashboard", "services/frame-today/public/dashboard.js", "async function copyText", "refresh();"],
    ["Audio Management", "services/frame-audio/public/admin.js", "async function copyText", "async function api"],
    ["Audio Bridge", "services/frame-audio-bridge/public/control.js", "async function copyText", "async function copyUrl"],
  ];
  const url = "http://frame.local/example";

  for (const [label, path, startMarker, endMarker] of implementations) {
    const source = await readFile(path, "utf8");
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${label} clipboard helper could not be isolated`);
    const compile = (document, navigator) => Function(
      "document",
      "navigator",
      `return (${source.slice(start, end).trim()});`,
    )(document, navigator);

    const modern = clipboardHarness(false);
    let modernValue = null;
    await compile(modern.document, {
      clipboard: { writeText: async (value) => { modernValue = value; } },
    })(url, modern.button);
    assert.equal(modernValue, url, `${label} did not use the modern Clipboard API`);
    assert.equal(modern.state.command, undefined, `${label} used the legacy fallback after modern success`);

    const accepted = clipboardHarness(true);
    await compile(accepted.document, {})(url, accepted.button);
    assert.equal(accepted.state.selector, "dialog[open]", `${label} did not resolve the fallback host from the clicked control`);
    assert.equal(accepted.state.appended, accepted.textarea, `${label} did not mount its fallback in the active host`);
    assert.deepEqual(accepted.state.clipboard, ["text/plain", url], `${label} did not write the exact URL`);
    assert.deepEqual(accepted.state.selection, [0, url.length], `${label} did not select the complete URL`);
    assert.equal(accepted.state.prevented, true, `${label} did not handle the copy event`);
    assert.deepEqual(accepted.state.restored, { preventScroll: true }, `${label} did not restore focus`);

    const falsePositive = clipboardHarness(false);
    await assert.rejects(
      compile(falsePositive.document, {})(url, falsePositive.button),
      /Copy unavailable/,
      `${label} accepted execCommand=true without a copy event`,
    );
  }

  for (const path of [
    "services/frame-portal/public/index.html",
    "services/frame-overlays/public/index.html",
    "services/frame-belabox-manager/public/index.html",
    "services/frame-streams/public/index.html",
    "services/frame-today/public/dashboard.html",
    "services/frame-audio/public/admin.html",
  ]) {
    assert.match(await readFile(path, "utf8"), /\.js\?v=clipboard-confirmed-v1/, `${path} has a stale clipboard script cache key`);
  }
});

function clipboardHarness(fireCopyEvent) {
  const state = {};
  let copyListener = null;
  const textarea = {
    style: {},
    focus: (options) => { state.focused = options; },
    select: () => { state.selected = true; },
    setSelectionRange: (from, to) => { state.selection = [from, to]; },
    remove: () => { state.removed = true; },
  };
  const host = {
    append: (element) => { state.appended = element; },
    appendChild: (element) => { state.appended = element; },
  };
  const previousFocus = {
    isConnected: true,
    focus: (options) => { state.restored = options; },
  };
  const document = {
    activeElement: previousFocus,
    body: host,
    createElement: (tag) => { state.created = tag; return textarea; },
    addEventListener: (_type, listener) => { copyListener = listener; },
    removeEventListener: (_type, listener) => { if (copyListener === listener) copyListener = null; },
    execCommand: (command) => {
      state.command = command;
      if (fireCopyEvent) {
        copyListener?.({
          clipboardData: { setData: (type, value) => { state.clipboard = [type, value]; } },
          preventDefault: () => { state.prevented = true; },
        });
      }
      return true;
    },
  };
  const button = {
    closest: (selector) => { state.selector = selector; return host; },
  };
  return { button, document, state, textarea };
}

test("LAN tool headers return to Dashboard and use the shared sign-out icon", async () => {
  const [photoUpload, photoStage, audioAdmin, audioFrontend, audioStyles] = await Promise.all([
    readFile("services/frame-photo-upload/public/index.html", "utf8"),
    readFile("services/frame-today/public/dashboard.html", "utf8"),
    readFile("services/frame-audio/public/admin.html", "utf8"),
    readFile("services/frame-audio/public/admin.js", "utf8"),
    readFile("services/frame-audio/public/styles.css", "utf8"),
  ]);
  const logoutIcon = "M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4";
  assert.ok(photoUpload.includes('class="brand" href="/dashboard"'), "Photo Upload logo should return to FRAME Dashboard");
  assert.ok(photoStage.includes('class="brand" href="/dashboard"'), "Photo Stage logo should return to FRAME Dashboard");
  assert.ok(audioAdmin.includes('class="brand brand-link" href="/dashboard"'), "Audio Monitor logo should return to FRAME Dashboard");
  for (const source of [photoUpload, photoStage, audioAdmin]) {
    assert.ok(source.includes('href="/auth/logout" aria-label="Sign out of FRAME" title="Sign out"'));
    assert.ok(source.includes(logoutIcon), "Sign-out controls should match the Portal icon");
  }
  for (const icon of ["microphoneIcon()", "headphonesIcon()", "copyIcon()", "pencilIcon()", "trashIcon()"]) {
    assert.ok(audioFrontend.includes(icon), `Audio Monitor should render ${icon}`);
  }
  assert.ok(audioStyles.includes(".capture-action { color: var(--good)"), "Audio capture should use the green action style");
  assert.ok(audioStyles.includes(".danger-action { color: var(--bad)"), "Audio delete should use the danger action style");
});

test("implemented Node services expose build and typecheck scripts", async () => {
  for (const service of [
    "frame-auth",
    "frame-audio",
    "frame-audio-bridge",
    "frame-belabox-manager",
    "frame-overlays",
    "frame-portal",
    "frame-streams",
    "frame-pipeline-photos",
    "frame-photo-upload",
    "frame-photo-ftp",
    "frame-gallery",
    "frame-today",
  ]) {
    const manifest = JSON.parse(await readFile(`services/${service}/package.json`, "utf8"));
    assert.equal(typeof manifest.scripts?.build, "string", `${service} is missing build`);
    assert.equal(typeof manifest.scripts?.typecheck, "string", `${service} is missing typecheck`);
  }
});

test("Stream Management supports a direct add-stream deep link", async () => {
  const [frontend, html] = await Promise.all([
    readFile("services/frame-streams/public/app.js", "utf8"),
    readFile("services/frame-streams/public/index.html", "utf8"),
  ]);
  assert.ok(frontend.includes('window.addEventListener("hashchange", openDialogForHash)'), "SLSUI must react to hash changes");
  assert.ok(frontend.includes('"#add-stream"'), "SLSUI must recognize /slsui#add-stream");
  assert.ok(frontend.includes("clearAddStreamHash"), "SLSUI must clear the add-stream hash after the dialog closes");
  assert.ok(html.includes('class="brand brand-link" href="/dashboard"'), "Stream Management logo should return to the LAN dashboard");
  assert.ok(html.includes("app.js?v=clipboard-confirmed-v1"), "SLSUI app cache key should change when management behavior changes");
});

test("Stream Management keeps SRT player links local", async () => {
  const frontend = await readFile("services/frame-streams/public/app.js", "utf8");
  assert.ok(frontend.includes('["SRT player", `srt://localhost:${ports.player}?streamid=${stream.player}`]'));
  assert.ok(frontend.includes('["SRTLA publisher", `srtla://${host}:${ports.srtla}?streamid=${stream.publisher}`]'));
  assert.ok(frontend.includes('["Direct SRT publisher", `srt://${host}:${ports.sender}?streamid=${stream.publisher}`]'));
});

test("Stream Management deletes streams through a themed unbind dialog", async () => {
  const [frontend, html] = await Promise.all([
    readFile("services/frame-streams/public/app.js", "utf8"),
    readFile("services/frame-streams/public/index.html", "utf8"),
  ]);
  assert.ok(frontend.includes("deleteStreamDialog"), "SLSUI must use the in-browser delete dialog");
  assert.ok(frontend.includes("confirmDeleteStream"), "SLSUI must confirm stream deletion in app code");
  assert.ok(frontend.includes("boundOverlaysMarkup"), "SLSUI delete dialog must list affected overlay bindings");
  assert.ok(!frontend.includes("confirm(`Delete"), "SLSUI stream deletion must not use the native confirm dialog");
  assert.ok(html.includes('id="delete-stream-dialog"'), "SLSUI delete dialog markup is missing");
  assert.ok(html.includes("Related OBS overlay sources will be unbound, not deleted."), "SLSUI delete dialog must explain unbinding");
});

test("Overlay Wizard presents OBS sources as the only editable objects", async () => {
  const [frontend, html, styles, renderer, uploadRenderer, rendererStyles, uploadStyles] = await Promise.all([
    readFile("services/frame-overlays/public/app.js", "utf8"),
    readFile("services/frame-overlays/public/index.html", "utf8"),
    readFile("services/frame-overlays/public/styles.css", "utf8"),
    readFile("services/frame-overlays/public/renderer.js", "utf8"),
    readFile("services/frame-overlays/public/upload-renderer.js", "utf8"),
    readFile("services/frame-overlays/public/renderer.css", "utf8"),
    readFile("services/frame-overlays/public/upload-renderer.css", "utf8"),
  ]);
  assert.ok(html.includes("FRAME Overlay Wizard"));
  assert.ok(html.includes("FrameTheme"), "Overlay Wizard should inherit the shared FRAME theme");
  assert.ok(html.includes("THEME_PROFILE_KEY"), "Overlay Wizard bootstrap should read Portal theme profiles");
  assert.ok(html.includes('id="dashboard-link" class="brand brand-link" href="/dashboard"'), "Overlay Wizard logo should stay on the current LAN origin");
  assert.ok(html.includes("portal-theme-v2"), "Overlay Wizard assets should cache-bust theme chrome updates");
  assert.ok(html.includes("M21 12.8A9 9 0 1 1 11.2 3"), "Overlay Wizard theme toggle should use the Portal moon icon path");
  assert.ok(html.includes("M4.93 4.93l1.42 1.42"), "Overlay Wizard theme toggle should use the Portal sun icon path");
  assert.ok(frontend.includes("THEME_STORAGE_KEYS"), "Overlay Wizard should listen for Portal theme storage changes");
  assert.ok(frontend.includes("THEME_PROFILE_ID_KEY"), "Overlay Wizard should react when the Portal theme preset changes");
  assert.ok(frontend.includes("function publicBaseUrl()"), "Overlay Wizard should normalize configured public URLs");
  assert.ok(frontend.includes('url.protocol = "https:"'), "Overlay Wizard should force HTTPS for non-local public links");
  assert.ok(frontend.includes('window.location.href = "/slsui#add-stream"'), "Overlay Wizard should not hardcode localhost for SLSUI");
  assert.ok(styles.includes(".theme-day .moon-icon"), "Overlay Wizard should support Portal body theme class selectors");
  assert.ok(styles.includes("--surface-muted"), "Overlay Wizard chrome should derive surfaces from the global theme");
  assert.ok(styles.includes(".brand-link"), "Overlay Wizard linked logo should not inherit button chrome");
  assert.ok(!styles.includes("background:#0b2635"), "Overlay Wizard should avoid hardcoded raised-panel blues");
  assert.ok(!styles.includes("background:#081b27"), "Overlay Wizard should avoid hardcoded section blues");
  assert.ok(!styles.includes("color:#03121b"), "Overlay Wizard primary button text should use themed contrast");
  assert.ok(html.includes('id="source-tabs"'), "Overlay Wizard must use source tabs");
  assert.ok(html.includes('role="tablist"'), "Overlay source navigation must be exposed as tabs");
  assert.ok(frontend.includes('role="tab"'), "Overlay source entries must be tab controls");
  assert.ok(frontend.includes('<a href="#" role="tab"'), "Overlay source entries should be tabs, not action buttons");
  assert.ok(!frontend.includes('<button class="source-tab'), "Overlay source entries must not render as button-looking source pills");
  assert.ok(frontend.includes("Welcome to the Overlay Wizard! Let's get started!"));
  assert.ok(frontend.includes("Create OBS Overlay Source"));
  assert.ok(frontend.includes("New +"));
  assert.ok(frontend.includes("frame-overlays-upload-advanced-view"), "Upload customization level should stay local to the Overlay Wizard");
  assert.ok(frontend.includes("data-upload-editor"), "Upload sources should expose a scoped customization workspace");
  assert.ok(frontend.includes('data-upload-view-mode="simple"') && frontend.includes('data-upload-view-mode="advanced"'), "Upload customization should offer Simple and Advanced modes");
  assert.ok(frontend.includes('role="tab" class="upload-category-tab'), "Upload customization categories should use keyboard-accessible tabs");
  assert.ok(frontend.includes("data-upload-settings-panel"), "Upload customization categories should own matching tab panels");
  assert.ok(frontend.includes("data-reset-upload-section"), "Every upload customization category should expose a section reset");
  assert.ok(frontend.includes('event.key === "ArrowLeft"') && frontend.includes('event.key === "Home"'), "Upload category tabs should support arrow and boundary keys");
  assert.ok(frontend.indexOf("sourceDetailsMarkup(source, preset)") < frontend.indexOf("uploadDesignMarkup(state.designDraft)"), "Upload adapters should stay outside customization disclosure");
  assert.ok(frontend.includes('state.sourceDraft?.id === savedSourceId') && frontend.includes('state.designDraft?.id === savedPresetId'), "Autosave responses must not overwrite another selected source");
  assert.ok(frontend.includes('!state.pendingSave.has("source")') && frontend.includes('!state.pendingSave.has("design")'), "Autosave responses must not overwrite newer editor input");
  assert.ok(frontend.includes('structuredClone(state.sourceDraft)') && frontend.includes('structuredClone(state.designDraft)'), "A mixed autosave must preserve both drafts before awaiting either request");
  assert.ok(html.includes("Use fake data"));
  assert.ok(frontend.includes("Reset to base template"));
  assert.ok(frontend.includes("Blocks per row"), "Layout controls should expose telemetry wrapping as blocks per row");
  assert.ok(!frontend.includes("Overlay width"), "Connectivity overlay width should be automatic from block width and blocks per row");
  assert.ok(frontend.includes("<summary>Theme</summary>"), "Theme controls should share one section");
  assert.ok(["Panel", "Block", "Text", "Subheader", "Plot"].every((name) => frontend.includes(`themeGroup("${name}"`)), "Theme controls should keep their grouped panels");
  assert.ok(frontend.includes("State coloring"), "Quality colors should live in a renamed state coloring section");
  assert.ok(frontend.includes('colorControl("muted_color", "Color"'), "Muted overlay copy color should stay editable in the subheader group");
  assert.ok(!frontend.includes("Block sizing"), "Old block sizing section should not return");
  assert.ok(frontend.includes('data-telemetry-columns-range'), "Blocks per row should use the auto-to-all slider");
  assert.ok(frontend.includes('sliderValueToTelemetryColumns'), "Blocks per row slider should persist to a concrete telemetry column setting");
  assert.ok(frontend.includes('data-block-density'), "Block height should be exposed as density presets instead of a large raw slider");
  assert.ok(frontend.includes("anchorIcon"), "Anchor positions should use icon controls");
  assert.ok(frontend.includes("icons.grip"), "Telemetry drag handles should share the Audio Bridge grip icon");
  assert.ok(frontend.includes("Advanced timing"), "Timing controls should live in an advanced section");
  assert.ok(frontend.includes("Chart Sample Rates"), "Telemetry sampling controls should use user-facing chart sample rate wording");
  assert.ok(frontend.includes('id="chart-timing-section"'), "Chart timing controls should be hideable when the chart block is disabled");
  assert.ok(!frontend.includes('"Minimum height"'), "Overlay height should not be a normal wizard slider");
  assert.ok(frontend.includes('data-telemetry-visible'), "Telemetry visibility should be combined with ordered block rows");
  assert.ok(frontend.includes('draggable="true"'), "Telemetry block rows should support desktop drag ordering");
  assert.ok(!frontend.includes("Touch-safe order"), "Telemetry ordering should not be split into a second touch-only control set");
  assert.ok(!frontend.includes("<h3>Sampling</h3>"), "Old sampling heading should not return");
  assert.ok(frontend.includes("elementPreview=1"), "Overlay Wizard previews should use element-sized renderer mode");
  assert.ok(html.includes('data-preview-view="canvas"') && html.includes('data-preview-view="detail"'), "Upload previews should offer truthful Canvas and readable Detail framing");
  assert.ok(html.includes('id="preview-scenario"'), "Upload previews should expose lifecycle scenes");
  assert.ok(frontend.includes("previewFrameDimensions(effectivePreviewView()"), "Preview sizing should distinguish full canvas from measured detail");
  assert.ok(frontend.includes('state.previewView: "canvas"') || frontend.includes('previewView: "canvas"'), "Upload preview should default to the OBS canvas");
  assert.ok(frontend.includes("frame-preview-size"), "Overlay Wizard should resize the preview from renderer measurements");
  assert.ok(html.includes("preview-scale-shell"), "Overlay Wizard should scale the measured preview element, not the full OBS canvas");
  assert.ok(styles.includes(".layout-editor"), "Layout controls should split anchors and sliders into desktop columns");
  assert.ok(frontend.includes("level-control-grid"), "Desktop behavior controls should be able to sit side by side");
  assert.ok(styles.includes("@media (min-width:901px)"), "Desktop wizard density rules should not affect the mobile layout");
  assert.ok(styles.includes(".telemetry-block-list { width:min(100%,620px); }"), "Telemetry order should stay in a constrained one-column list");
  assert.ok(styles.includes(".telemetry-block-list { grid-template-columns:1fr; }"), "Desktop density rules must not split telemetry order into columns");
  assert.ok(styles.includes(".field-action"), "Source detail actions should align with their related fields");
  assert.ok(styles.includes("button.icon-reset"), "Slider reset controls should use compact icon buttons");
  assert.ok(styles.includes(".state-theme-row"), "Theme state colors and opacity sliders should share rows");
  assert.ok(styles.includes("grid-template-areas:\"notice notice\" \"tabs preview\" \"content preview\""), "Desktop wizard layout must reserve a right preview column");
  assert.ok(styles.includes("grid-template-areas:\"notice\" \"tabs\" \"content\""), "Mobile wizard layout must keep tabs and editor in the scrollable page");
  assert.ok(styles.includes("body.has-preview { padding-bottom:calc(min(50vh, 430px)"), "Mobile editor must leave room for the fixed bottom preview");
  assert.ok(styles.includes(".preview-dock { position:fixed;"), "Mobile preview must be fixed while editor controls scroll");
  assert.ok(styles.includes("height:min(50vh,430px)"), "Mobile preview must occupy the lower half without taking the whole screen");
  assert.ok(styles.includes("border-radius:12px 12px 0 0"), "Source tabs should visually attach to the editor panel");
  assert.ok(styles.includes(".source-tabs-shell { margin-bottom:0; overflow-x:auto; }"), "Mobile source tabs should not leave a gap above the editor panel");
  assert.ok(renderer.includes("elementPreviewMode"), "Connectivity renderer must support element-sized preview mode");
  assert.ok(renderer.includes("resolvedTelemetryColumnCount"), "Connectivity renderer must resolve fixed telemetry columns without clipping");
  assert.ok(renderer.includes("telemetryGridPixelWidth"), "Connectivity renderer must calculate widget width from block width and columns");
  assert.ok(renderer.includes("widget.style.width = `${layoutWidth || telemetryGridPixelWidth"), "Connectivity renderer width must follow the telemetry grid");
  assert.ok(rendererStyles.includes("max-width: none"), "Renderer widget must not clamp wide telemetry rows to the viewport max width");
  assert.ok(uploadRenderer.includes("elementPreviewMode"), "Upload renderer must support element-sized preview mode");
  assert.ok(uploadStyles.includes("body.element-preview") && uploadStyles.includes("place-items: start"), "Upload detail previews must align transformed bounds from a stable origin");
  assert.ok(rendererStyles.includes("body.element-preview"), "Renderer stylesheet must detach preview mode from the full OBS canvas");
  assert.ok(!html.includes("Overlay Studio"), "Overlay setup should no longer present itself as studio");
});

test("implemented capability profiles are stable and ordered", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  for (const name of IMPLEMENTED_CAPABILITIES) capabilities[name] = true;
  assert.deepEqual(computeComposeProfiles(capabilities, "LAN"), [
    "audio-bridge",
    "audio-monitor",
    "belabox",
    "video-relay",
    "overlays",
    "photo-pipeline",
    "photo-ftp",
    "photo-webupload",
    "photo-gallery",
    "photo-today",
  ]);
  assert.deepEqual(computeComposeProfiles(capabilities, "HYBRID"), [
    "audio-bridge",
    "audio-monitor",
    "belabox",
    "video-relay",
    "overlays",
    "photo-pipeline",
    "photo-ftp",
    "photo-webupload",
    "photo-gallery",
    "photo-today",
    "hybrid",
  ]);
});

test("legacy Belabox MQTT config upgrades to the canonical control routes", () => {
  const legacyCapabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, name === "frame-belabox-manager"]));
  legacyCapabilities["frame-belabox-broker"] = true;
  const legacyRoutes = {
    ...Object.fromEntries(Object.entries(ROUTES).filter(([name]) => !["belabox_mixer", "belabox_control"].includes(name))),
    belabox_mqtt: "/mqtt",
  };
  const legacyPrefixes = PUBLIC_PREFIXES.filter((prefix) => !["/belabox/mixer", "/belabox/control"].includes(prefix));
  legacyPrefixes.push("/mqtt");

  const upgraded = upgradeStackConfig({
    mode: "HYBRID",
    capabilities: legacyCapabilities,
    routes: legacyRoutes,
    public_route_prefixes: legacyPrefixes,
  });

  assert.deepEqual(Object.keys(upgraded.capabilities), CAPABILITIES);
  assert.equal("frame-belabox-broker" in upgraded.capabilities, false);
  assert.deepEqual(Object.keys(upgraded.routes), Object.keys(ROUTES));
  assert.equal("belabox_mqtt" in upgraded.routes, false);
  assert.equal(upgraded.routes.belabox_control, "/belabox/control");
  assert.equal(upgraded.routes.belabox_mixer, "/belabox/mixer");
  assert.deepEqual(upgraded.public_route_prefixes, [...PUBLIC_PREFIXES]);
  assert.equal(upgraded.public_route_prefixes.includes("/mqtt"), false);
});

test("photo pipeline is internal and activated by every photo capability", () => {
  assert.equal(SERVICE_REGISTRY.internalServices["frame-auth"].userSelectable, false);
  assert.equal(SERVICE_REGISTRY.internalServices["frame-pipeline-photos"].userSelectable, false);
  for (const [name, definition] of Object.entries(SERVICE_REGISTRY.capabilities)) {
    if (!name.startsWith("frame-photo-")) continue;
    assert.ok(definition.profiles.includes("photo-pipeline"), `${name} must activate photo-pipeline`);
  }
});

test("photo pipeline reports per-file outcomes for transfer UX", async () => {
  const [source, pipelineServer, overlayServer] = await Promise.all([
    readFile("services/frame-pipeline-photos/src/pipeline.ts", "utf8"),
    readFile("services/frame-pipeline-photos/src/index.ts", "utf8"),
    readFile("services/frame-overlays/src/index.ts", "utf8"),
  ]);
  assert.ok(source.includes("last_publish_file"));
  assert.ok(source.includes("last_quarantine_file"));
  assert.ok(source.includes("last_quarantine_at"));
  const archiveExpiry = source.match(/private async pruneExpiredArchives[\s\S]*?private async verifiedTrackedArchive/)?.[0] ?? "";
  assert.match(archiveExpiry, /this\.withPublishLock\(async \(\) => \{[\s\S]*?sidecar\?\.journey_id !== journeyId[\s\S]*?await rm\(/, "Archive expiry must recheck the alternate gallery copy and remove the archive under the publication lock");
  assert.match(archiveExpiry, /receipt\.journey_id !== journeyId/, "Archive expiry must reject a receipt stored under the wrong journey ID");
  assert.ok(pipelineServer.includes('request.header("x-frame-service-token")'));
  assert.ok(overlayServer.includes('headers.set("X-Frame-Service-Token", config.ingestApiToken)'));
});

test("canonical photo journey schema protects identity and content integrity", async () => {
  const [schema, sidecar, error] = await Promise.all([
    readFile("docs/schemas/photo-journey.schema.json", "utf8").then(JSON.parse),
    readFile("docs/schemas/photo-sidecar.schema.json", "utf8").then(JSON.parse),
    readFile("docs/schemas/photo-error.schema.json", "utf8").then(JSON.parse),
  ]);
  assert.ok(schema.required.includes("content_sha256"));
  assert.equal(new RegExp(schema.properties.content_sha256.pattern).test("a".repeat(64)), true);
  assert.equal(new RegExp(schema.properties.journey_id.pattern).test("journey__ambiguous"), false);
  assert.ok(schema.properties.ingest.properties.adapter.enum.includes("legacy_staging"));
  for (const historicalSchema of [sidecar, error]) {
    assert.ok(historicalSchema.properties.journey_id);
    assert.equal(historicalSchema.required.includes("journey_id"), false);
  }
});

test("Portal hides pipeline settings unless photo pipeline capabilities are enabled", async () => {
  const [stackConfig, portalServer, frontend, html] = await Promise.all([
    readFile("services/frame-portal/src/stackConfig.ts", "utf8"),
    readFile("services/frame-portal/src/index.ts", "utf8"),
    readFile("services/frame-portal/public/portal.js", "utf8"),
    readFile("services/frame-portal/public/index.html", "utf8"),
  ]);
  assert.ok(stackConfig.includes("isPhotoPipelineEnabled"));
  assert.ok(stackConfig.includes('name.startsWith("frame-photo-")'));
  assert.ok(portalServer.includes("pipeline_enabled: isPhotoPipelineEnabled"));
  assert.ok(frontend.includes("portalConfig?.pipeline_enabled === true"));
  assert.ok(html.includes('data-portal-nav="pipeline" hidden'));
});

test("shared login route is always available through Hybrid routing", () => {
  assert.ok(PUBLIC_PREFIXES.includes("/auth"));
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  assert.ok(computeEffectivePublicPrefixes({
    mode: "HYBRID",
    capabilities,
    public_route_prefixes: [...PUBLIC_PREFIXES],
  }).includes("/auth"));
});

test("dependency enforcement disables overlays and photo outputs with missing dependencies", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  capabilities["frame-overlays"] = true;
  capabilities["frame-photo-gallery"] = true;
  capabilities["frame-photo-todaytools"] = true;
  const warnings = enforceDependencies(capabilities);
  assert.equal(capabilities["frame-overlays"], false);
  assert.equal(capabilities["frame-photo-gallery"], false);
  assert.equal(capabilities["frame-photo-todaytools"], false);
  assert.equal(warnings.length, 3);
});

test("hybrid exposure removes forbidden and disabled capability routes", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  capabilities["frame-audio-relay"] = true;
  const warnings = [];
  const prefixes = computeEffectivePublicPrefixes(
    {
      mode: "HYBRID",
      capabilities,
      public_route_prefixes: [...PUBLIC_PREFIXES, "/audio/admin"],
    },
    (warning) => warnings.push(warning),
  );
  assert.ok(prefixes.includes("/audio/listen"));
  assert.ok(!prefixes.includes("/bridge"));
  assert.ok(!prefixes.includes("/audio/admin"));
  assert.equal(warnings.length, 1);
});

test("Hybrid exposes unauthenticated read-only stream stats without exposing Stream Management", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  capabilities["frame-video-relay"] = true;
  const prefixes = computeEffectivePublicPrefixes({
    mode: "HYBRID",
    capabilities,
    public_route_prefixes: [...PUBLIC_PREFIXES],
  });
  assert.ok(prefixes.includes("/stats"));
  assert.ok(!prefixes.includes("/slsui"));
});

test("Belabox pairing UI hides transport implementation details", async () => {
  const [html, frontend, backend, dockerfile, agent, photoAgent, styles] = await Promise.all([
    readFile("services/frame-belabox-manager/public/index.html", "utf8"),
    readFile("services/frame-belabox-manager/public/app.js", "utf8"),
    readFile("services/frame-belabox-manager/src/index.ts", "utf8"),
    readFile("services/frame-belabox-manager/Dockerfile", "utf8"),
    readFile("services/frame-belabox-manager/agent/belabox-agent.mjs", "utf8"),
    readFile("services/frame-belabox-manager/agent/photo-agent.py", "utf8"),
    readFile("services/frame-belabox-manager/public/styles.css", "utf8"),
  ]);
  assert.ok(html.includes('role="tablist"'), "Belabox devices should render like Overlay Wizard source tabs");
  assert.ok(html.includes("FrameTheme"), "Belabox Manager should inherit the shared FRAME theme");
  assert.ok(frontend.includes("THEME_PROFILE_ID_KEY"), "Belabox Manager should read Portal theme profile settings");
  assert.ok(frontend.includes("THEME_CUSTOM_PROFILES_KEY"), "Belabox Manager should listen for Portal custom theme changes");
  assert.ok(html.includes("header-status"), "Belabox Manager should keep action feedback in the header");
  assert.ok(html.includes("frame-logo-square.svg"), "Belabox Manager should use the FRAME header identity");
  assert.ok(html.includes('class="brand brand-link" href="/dashboard"'), "FRAME logo should link back to the dashboard");
  assert.ok(!html.includes('href="/dashboard">Dashboard</a>'), "Belabox Manager should not duplicate the dashboard button");
  assert.ok(html.includes("M21 12.8A9 9 0 1 1 11.2 3"), "Theme toggle should use the Portal moon icon path");
  assert.ok(html.includes("M4.93 4.93l1.42 1.42"), "Theme toggle should use the Portal sun icon path");
  assert.ok(frontend.includes("THEME_STORAGE_KEYS"));
  assert.ok(frontend.includes("handleThemeStorageChange"));
  assert.ok(styles.includes(".brand-link"));
  assert.ok(styles.includes(".theme-day .moon-icon"));
  assert.ok(frontend.includes("Add Device"), "Zero-device state should enter the add-device wizard");
  assert.ok(frontend.includes("Welcome to the Belabox Manager Agent Installation Wizard"));
  assert.ok(frontend.includes("Belabox FTP Photo Agent"));
  assert.ok(frontend.includes("Stream Safe Photo Transfer"));
  assert.ok(frontend.includes("/belabox/api/ssh/check"));
  assert.ok(frontend.includes("LAST_DEVICE_KEY"), "Belabox Manager should restore the last viewed device");
  assert.ok(frontend.includes('user: formValue(form, "pair-user", "user").trim()'), "Wizard submit should preserve the default SSH username");
  assert.ok(frontend.includes('id="pair-display-name"'), "Wizard should ask for a friendly name and derive the technical device ID");
  assert.ok(frontend.includes("displayNameExists"), "Wizard should reject duplicate friendly names before SSH work");
  assert.ok(backend.includes("safeDisplayName"), "Pairing and rename APIs should share device-name validation");
  assert.ok(frontend.includes("elements.deviceTabs.hidden = state.selectedDeviceId === ADD_DEVICE_ID"), "Add Device wizard should hide device tabs");
  assert.ok(!frontend.includes("ssh_credentials?.devices || []).some"), "Stale saved SSH credentials must not block re-adding a removed host");
  assert.ok(frontend.includes("SSH Maintenance"));
  assert.ok(frontend.includes("criticalAction"));
  assert.ok(frontend.includes("beginCriticalAction"));
  assert.ok(frontend.includes("blockCriticalNavigation"));
  assert.ok(frontend.includes("handleCriticalBeforeUnload"));
  assert.ok(frontend.includes("panelHoldKey"), "Heartbeat refreshes should not replace an active device panel");
  assert.ok(frontend.includes("panelRenderHeld(panelKey)"), "Device panel rendering should respect the interaction hold");
  assert.ok(frontend.includes('form.querySelector("#pair-output") || elements.devicePanel.querySelector("#pair-output")'), "Repair jobs should use the panel-level SSH log");
  assert.ok(frontend.includes("Photo Transfer"));
  assert.ok(frontend.includes("Protect Stream"));
  assert.ok(frontend.includes("What is slowing things down?"));
  assert.ok(frontend.includes('aria-label="Open ${escapeAttr(displayName)} encoder remote in a new tab"'));
  assert.ok(frontend.includes("Photo Agent"));
  assert.ok(frontend.includes("/belabox/api/pair"));
  assert.ok(frontend.includes("/belabox/api/pair/jobs"));
  assert.ok(frontend.includes("/belabox/api/ftp-connector/jobs"));
  assert.ok(frontend.includes('role="switch"'), "Photo transport should expose one mutually exclusive mode switch");
  assert.ok(frontend.includes('sliderControl("photo-jpeg-quality"'), "Photo quality should use the shared slider control");
  assert.ok(frontend.includes('sliderControl("photo-max-output"'), "Maximum prepared image size should use the shared slider control");
  assert.ok(frontend.includes('id="photo-resize-enabled"'), "Dimension resizing should use an explicit control");
  assert.ok(frontend.includes('id="photo-size-limit-enabled"'), "Output size limiting should use an explicit control");
  assert.ok(frontend.includes('"Maximum output", 1, 25, 0.5'), "Prepared JPEG size should use a practical 25 MiB range");
  assert.ok(frontend.includes('"Chunk size", 262144, chunkSizeMax'), "Chunk sliders should respect the receiver limit and 8 MiB UI cap");
  assert.ok(frontend.includes('id="photo-upload-uncapped"'), "Upload caps should use an explicit uncapped control");
  assert.ok(frontend.includes("Apply changes to"), "Pending settings should expose the large device-specific apply action");
  assert.ok(frontend.includes("updateFormPendingState"), "Editable settings should expose acknowledged and pending states");
  assert.ok(frontend.includes("Discard changes"), "Users should be able to discard staged settings");
  assert.ok(frontend.includes('if (event.target.matches("#chunk-form")) return runTransferSubmit(event);'), "Transfer settings should apply through one form action");
  assert.ok(!frontend.includes('applyPhotoTransport(requested ? "chunked_https"'), "Changing transfer mode should remain local until Apply is pressed");
  assert.ok(styles.includes(".form-commit .form-apply-button"), "Pending actions should span their settings section");
  assert.ok(!frontend.includes('id="enable-chunk-relay"'), "Transport mode should not expose competing action buttons");
  assert.ok(frontend.includes("Run Interface Speed Test"));
  assert.ok(frontend.includes("Hybrid required"));
  assert.ok(frontend.includes("remember_ssh"));
  assert.ok(!frontend.includes("Private key"), "Belabox Manager should not ask users for SSH private keys");
  assert.ok(frontend.includes('type="range"'), "Wizard transfer controls should use sliders");
  assert.ok(styles.includes(".device-tabs::-webkit-scrollbar"), "Device tabs should not show a scrollbar");
  assert.ok(styles.includes(".device-panel:has(#device-wizard) .wizard-step"), "Add wizard pages should use the Overlay Wizard panel rhythm");
  assert.ok(styles.includes('grid-template-areas: "notice" "tabs" "content"'), "Belabox Manager should keep one compact manager shell");
  assert.ok(frontend.includes('class="workspace-section status-workspace"'), "Daily device status should be grouped into one overview");
  assert.ok(frontend.includes('class="workspace-section photo-workspace"'), "Photo Transfer should be the primary work surface");
  for (const tab of ["overview", "photos", "connections", "diagnostics", "system"]) {
    assert.ok(frontend.includes(`data-workspace-pane="${tab}"`), `Belabox workspace should include the ${tab} tab`);
  }
  assert.ok(frontend.includes('...(mixerInstalled ? [["mixer", "Video Mixer"]] : [])'), "Video Mixer should be a capability-driven tab");
  assert.ok(frontend.includes("LAST_WORKSPACE_TAB_KEY"), "Belabox Manager should restore the selected workflow tab");
  assert.ok(frontend.includes('elements.devicePanel.addEventListener("keydown", handleWorkspaceTabKeydown);'), "Workspace tabs should register keyboard navigation");
  assert.ok(frontend.includes('["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)'), "Workspace tabs should support arrow and boundary keys");
  assert.ok(frontend.includes("if (activeWorkspaceTab !== state.workspaceTab)"), "Unavailable capability tabs should normalize the saved selection");
  assert.ok(frontend.includes('if (!event.target.closest?.("input, textarea, select, [contenteditable=\'true\']")) return;'), "Passive panel actions must not freeze status refreshes");
  assert.ok(frontend.includes("holdCurrentPanelRender(event);"), "Editable form input should retain the panel render hold");
  assert.ok(!frontend.includes("holdCurrentPanelRender();"), "Render holds must not be activated without an editable event target");
  assert.ok(frontend.includes("ADVANCED_VIEW_KEY"), "Belabox Manager should restore the Simple/Advanced preference");
  assert.ok(frontend.includes('data-view-mode="simple"') && frontend.includes('data-view-mode="advanced"'), "Technical details should use an explicit Simple/Advanced segmented control");
  assert.ok(frontend.includes('querySelectorAll("[data-view-mode]")'), "Simple/Advanced state should stay synchronized without replacing the panel");
  assert.ok(frontend.includes('class="advanced-only system-advanced"'), "Raw telemetry and logs should stay behind Advanced");
  assert.ok(styles.includes('.device-panel[data-advanced-view="false"] .advanced-only'), "Simple view should hide advanced information");
  assert.ok(!html.includes('id="mqtt-state"'), "The manager shell should not expose protocol status cards");
  assert.ok(frontend.includes('id="device-name-form"'), "Paired devices should have editable display names");
  assert.ok(frontend.includes('class="agent-card"'), "Installed agent health should be visible without opening Advanced");
  assert.ok(frontend.includes("Agent update available"), "Agent version drift should have a quiet update state");
  assert.ok(backend.includes('app.patch("/belabox/api/devices/:deviceId"'), "Display names should persist through the manager API");
  assert.ok(backend.includes("bundled_version: bundledAgentVersion"), "Agent status should publish the bundled update target");
  assert.ok(backend.includes("Device name is already assigned"), "Display names should remain unique");
  assert.ok(frontend.includes("transferResultNotice"), "Recent transfer outcomes should remain visible after the active card advances");
  assert.ok(frontend.includes("FRAME Processing"), "Belabox acceptance and FRAME publication should be separate states");
  assert.ok(frontend.includes('aria-label="Photo upload progress"'), "Live upload status should expose visual progress");
  assert.ok(frontend.includes("egressLaneCards"), "Connections should expose lane-level Upload, Ready, and Down states");
  assert.ok(frontend.includes("photoTelemetryReady ? streamSafetyLabel"), "Unknown photo telemetry should not be presented as Direct FTP");
  assert.ok(agent.includes("last_result: transferResult(status.last_result)"), "Belabox telemetry should carry the last authoritative transfer result");
  assert.ok(backend.includes('adapter === "belabox_chunked" && transferId ? fallbackJourneyId(transferId) : null'), "Chunk progress should recover the manifest journey ID from its exact transfer ID");
  assert.ok(!backend.includes("duplicatesByFilename"), "Journey reduction must not correlate photos by filename");
  assert.ok(backend.includes("completedJourneyId"), "Completed observations must require canonical journey identity");
  assert.ok(photoAgent.includes('last_result = {"status": "completed"'), "Photo Agent should retain the completed filename for result feedback");
  assert.ok(photoAgent.includes("next_scale_percent"), "Photo Agent should adapt dimensions when quality alone cannot meet the size target");
  assert.ok(!photoAgent.includes("MAX_OUTPUT_DEFAULT_LONG_EDGE"), "A size limit should not silently force a 2400 px edge");
  assert.ok(backend.includes("photoPipelineStatus"), "Manager status should include FRAME pipeline health");
  assert.ok(styles.includes(".install-action"), "Install action should use the large action button style");
  assert.ok(styles.includes(".critical-action-modal"), "Critical SSH work should use a blocking progress dialog");
  assert.ok(styles.includes(".critical-action-active"), "Critical SSH work should lock page scrolling");
  assert.ok(frontend.includes("setManagerInert(true)"), "Blocking work should remove background controls from keyboard navigation");
  assert.ok(styles.includes(":focus-visible"), "Manager controls should expose keyboard focus");
  assert.ok(html.includes('role="tabpanel"'), "Device content should be associated with the tab interface");
  assert.ok(frontend.includes("ensureConfirmationDialog"), "Destructive actions should share a themed confirmation dialog");
  assert.ok(!frontend.includes("if (!confirm("), "Destructive actions should not use native confirmation prompts");
  assert.ok(frontend.includes('sendPhotoCommand("photo_queue_reset"'), "Maintenance should expose guarded photo queue recovery");
  assert.ok(agent.includes("archivePhotoQueue"), "Queue reset should archive managed spool files on the Belabox");
  assert.ok(backend.includes('"photo_queue_reset"'), "Queue reset should be a signed allowlisted command");
  assert.ok(!agent.includes("?."), "Belabox agent syntax should remain compatible with the image's Node runtime");
  assert.ok(backend.includes('"$node_bin" --check "$agent_dir/belabox-agent.mjs"'), "Repair should validate agent syntax before stopping the working service");
  assert.ok(backend.includes("waitForFreshHeartbeat(record.device_id, installedAt"), "Repair should only accept a post-install heartbeat");
  assert.ok(frontend.includes("Forget Saved SSH"));
  assert.ok(frontend.includes("detailsOpen"));
  assert.ok(frontend.includes("setButtonBusy"));
  assert.ok(frontend.includes("rememberFormInput"));
  assert.ok(frontend.includes("panelHasEditableFocus"));
  assert.ok(frontend.includes("data-remove-device"));
  assert.ok(frontend.includes('method: "DELETE"'));
  assert.ok(backend.includes("ftp_connectors:"));
  assert.ok(backend.includes("ssh_credentials:"));
  assert.ok(backend.includes('"/belabox/api/ssh/check"'));
  assert.ok(backend.includes("parsePairJobInput(request.body)"), "Repair jobs should allow saved SSH credentials");
  assert.ok(backend.includes("Saved SSH credential is not available"), "Repair jobs should explain missing saved SSH");
  assert.ok(backend.includes("Belabox host/IP is already assigned"));
  assert.ok(backend.includes("SSH password is required."));
  assert.ok(backend.includes("aes-256-gcm"));
  assert.ok(backend.includes("safeFtpPassword"));
  assert.ok(backend.includes("controlConnections.get(device.device_id)?.socket.readyState === WebSocket.OPEN"), "The live WSS connection should be authoritative for online state");
  assert.ok(backend.includes("/belabox/api/diagnostics/speed-test"));
  assert.ok(backend.includes("network_speed_test"));
  assert.ok(backend.includes('app.get("/belabox-chunks/api/diagnostics/speed-test"'), "FRAME diagnostics should provide authenticated downloads");
  assert.ok(backend.includes('phase === "published" && completedJourneyId && completedJourneyId === journeyId'), "Completed photo telemetry must deduplicate by canonical journey identity");
  assert.ok(backend.includes("streamDiagnosticBytes"), "FRAME diagnostic downloads should stream without buffering the full response");
  assert.ok(backend.includes('mode: "interface_speed_test"'), "Manager diagnostics should request the per-interface agent test");
  assert.ok(backend.includes("interface_name: input.interfaceName"), "Manager diagnostics should preserve the selected interface");
  assert.equal((backend.match(/safePositiveInt\([^\n]+config\.chunkUpload\.chunkSizeBytes\)/g) || []).length, 2, "Chunk manifests and commands must respect the receiver body limit");
  assert.ok(backend.includes("controlProof(provisioned.control_secret"), "Device sessions must authenticate with their provisioned secret");
  assert.ok(backend.includes('type: "proxy_open"'));
  assert.ok(backend.includes("sendControlBinary"), "Proxy bodies must use binary streaming frames");
  assert.ok(backend.includes("agent-wss-only"));
  assert.ok(backend.includes("This encoder is offline."));
  assert.ok(backend.includes('response.setHeader("Refresh", "2")'));
  assert.ok(backend.includes('`${REMOTE_BELAUI_ROUTE_PREFIX}/status`'));
  assert.ok(backend.includes("remoteBelauiShellPage"));
  assert.ok(backend.includes("REMOTE_BELAUI_STATUS_POLL_MS"));
  assert.ok(backend.includes("REMOTE_BELAUI_READY_STATUS_POLL_MS"));
  assert.ok(backend.includes("REMOTE_BELAUI_OFFLINE_FAILURES"));
  assert.ok(backend.includes("noteOffline"));
  assert.ok(backend.includes('const ready = remoteState === "reachable"'));
  assert.ok(backend.includes("Reconnecting to encoder..."));
  assert.ok(backend.includes("frame-belabox-remote-offline"));
  assert.ok(frontend.includes('/belabox/remote?key=${encodeURIComponent(deviceId)}'));
  assert.ok(dockerfile.includes("sshpass"));
  assert.ok(dockerfile.includes("iperf3"));
  assert.ok(agent.includes("network_speed_test"));
  assert.ok(agent.includes('EXTERNAL_SPEEDTEST_BASE_URL = "https://speed.cloudflare.com"'), "External diagnostics should use Cloudflare's published speed endpoint");
  assert.ok(agent.includes("downloadDiagnosticBytes"), "Agent diagnostics should measure download throughput");
  assert.ok(agent.includes("localAddress: lane.address"), "Every diagnostic request should bind to its tested interface");
  assert.ok(agent.includes("selectDiagnosticLanes"), "Agent diagnostics should reject unroutable interfaces");
  assert.ok(agent.includes("BELABOX_CHUNK_UPLOAD_TOKEN"));
  assert.ok(agent.includes("BELABOX_EGRESS_STATUS_PATH"));
  assert.ok(agent.includes("proxy_open"));
  assert.ok(agent.includes("routeForSource"));
  assert.ok(agent.includes("agent-wss-proxy"));
  assert.ok(photoAgent.includes("source_address="));
  assert.ok(photoAgent.includes("healthy_egress_lanes"));
  assert.ok(photoAgent.includes("FRAME_EGRESS_STATUS_PATH"));
  assert.ok(photoAgent.includes('return "pillow"'), "Photo Agent should prefer a single-decode Pillow processor");
  assert.ok(photoAgent.includes("request_json_with_lanes"), "Chunk control requests should use healthy egress lanes");
  assert.ok(photoAgent.includes("create_ipv4_connection"), "Chunk uploads should avoid unusable IPv6 routes");
  assert.ok(backend.includes("python3-pil"), "Photo Agent repair should install the Pillow decoder");
  assert.ok(frontend.includes('name="diagnostic_target"'), "Diagnostics should expose Internet and FRAME targets");
  assert.ok(frontend.includes('id="speed-test-interface"'), "Diagnostics should expose an interface selector");
  assert.ok(frontend.includes("diagnosticResultsMarkup"), "Diagnostics should present per-interface results");
  assert.ok(frontend.includes("relayProbeMarkup"), "Diagnostics should present continuous relay probe results");
  assert.ok(frontend.includes("FRAME Control Path"), "Relay diagnostics should distinguish control-path RTT from SRTLA RTT");
  assert.ok(frontend.includes("probe_host"), "Relay diagnostics should identify the endpoint being measured");
  assert.ok(frontend.includes("Sample age"), "Relay diagnostics should expose stale probe samples");
  assert.ok(frontend.includes('class="result-badge ${badgeTone}"'), "Diagnostic results should expose authoritative status badges");
  assert.ok(frontend.includes("waitForDiagnosticCompletion"), "Diagnostics should wait for final telemetry after command acknowledgement");
  assert.ok(frontend.includes('state.workspaceTab = "diagnostics"'), "Completed diagnostics should remain on their result tab");
  assert.ok(styles.includes(".diagnostic-target-selector"), "Diagnostic targets should use a segmented selector");
  assert.ok(backend.includes("frame-belabox-photo-agent.service"));
  assert.ok(backend.includes("photo-agent.py"));
  assert.ok(backend.includes('dependencies: { ws: "8.21.1" }'), "Generated agent installs must pin the tested WebSocket dependency");
  assert.ok(backend.includes("refresh_photo_agent_upload_credentials"), "Agent repair must refresh an existing Photo Agent upload credential");
  assert.ok(backend.includes("mv -f \"$photo_env_tmp\" \"$photo_env\""), "Photo Agent credential refresh must replace its env atomically");
  assert.ok(backend.includes("restart_existing_photo_agent"), "Agent repair must restart the existing Photo Agent after credential refresh");
  assert.ok(backend.includes("photo_upload_token=\"$(printf %s '${b64(device.upload_token)}' | base64 -d)\""), "Photo Agent refresh must install the separate upload token");
  assert.ok(!html.includes("MQTT password"));
  assert.ok(!frontend.includes("BELABOX_MQTT_PASSWORD"));
  assert.ok(!frontend.includes("mqtt_status"));
});

test("Photo Stage exposes Open and Copy actions for its Hybrid links", async () => {
  const [html, frontend, backend] = await Promise.all([
    readFile("services/frame-today/public/dashboard.html", "utf8"),
    readFile("services/frame-today/public/dashboard.js", "utf8"),
    readFile("services/frame-today/src/app.ts", "utf8"),
  ]);
  assert.ok(backend.includes("public_base_url: publicBaseUrl"), "Today dashboard API should expose the configured public base");
  for (const [label, path] of [
    ["All Galleries", "/today/gallery"],
    ["Gallery Management", "/today/gallery/admin"],
    ["Viewer Remote", "/today/remote"],
    ["Viewer OBS Source", "/today/viewer"],
    ["Photo Upload", "/photos/upload"],
  ]) {
    assert.ok(html.includes(`<strong>${label}</strong>`), `Today dashboard should label ${label}`);
    assert.ok(html.includes(`data-copy-path="${path}"`), `Today dashboard should copy ${path}`);
  }
  assert.ok(html.includes('<strong>Current Gallery</strong>'), "Today dashboard should label Current Gallery");
  assert.ok(html.includes('id="today-gallery-copy-button"'), "Today dashboard should offer a Current Gallery Copy action");
  assert.ok(frontend.includes('const galleryPath = `/today/gallery/${gallery.date_folder}/`'), "Today dashboard should generate the current gallery path");
  assert.ok(frontend.includes('elements.galleryLink.removeAttribute("href")'), "Today dashboard should disable an unavailable Current Gallery link");
  assert.ok(frontend.includes("publicUrl(button.dataset.copyPath)"), "Today dashboard should copy every tool using the Hybrid public base");
  assert.ok(frontend.includes('url.protocol = "https:"'), "Today dashboard should force HTTPS for non-local public links");
});

test("Hybrid public URL configs force external HTTPS", async () => {
  const files = await Promise.all([
    readFile("services/frame-streams/src/index.ts", "utf8"),
    readFile("services/frame-overlays/src/index.ts", "utf8"),
    readFile("services/frame-audio/src/config.ts", "utf8"),
    readFile("services/frame-audio-bridge/src/config.ts", "utf8"),
    readFile("services/frame-belabox-manager/src/index.ts", "utf8"),
  ]);
  for (const source of files) {
    assert.ok(source.includes("function normalizePublicUrl"), "Public URL config should normalize external links");
    assert.ok(source.includes('url.protocol = "https:"') || source.includes('parsed.protocol = "https:"'));
  }
});

test("Belabox agent rejects invalid signed commands", async () => {
  await execFileAsync("node", ["services/frame-belabox-manager/agent/belabox-agent.mjs", "--self-test"]);
});

test("Belabox Video Mixer proxy stays fixed, namespaced, and fail-closed", async () => {
  const [backend, agent, frontend] = await Promise.all([
    readFile("services/frame-belabox-manager/src/index.ts", "utf8"),
    readFile("services/frame-belabox-manager/agent/belabox-agent.mjs", "utf8"),
    readFile("services/frame-belabox-manager/public/app.js", "utf8"),
  ]);

  assert.ok(backend.includes('const VIDEO_MIXER_ROUTE_PREFIX = "/belabox/mixer";'));
  assert.ok(backend.includes('app.get(`${VIDEO_MIXER_ROUTE_PREFIX}/status`'));
  assert.ok(backend.includes("videoMixerShellPage(remoteBelauiKey(key))"));
  assert.ok(backend.includes('`${VIDEO_MIXER_ROUTE_PREFIX}/:deviceId/*`'));
  assert.ok(backend.includes('proxyRemoteBelaui(request, response, next, "video_mixer")'));
  assert.ok(backend.includes('return remoteProxyStatusPayload(deviceId, "video_mixer");'));

  assert.ok(backend.includes('const VIDEO_MIXER_LOCAL_URL = "http://127.0.0.1:9080";'));
  assert.ok(backend.includes("target: parsed.target"), "Mixer WebSocket upgrades must retain their fixed target");
  assert.ok(backend.includes('parsed.path !== "/wsenc"'), "Manager must reject unrecognized mixer WebSocket paths");
  assert.ok(backend.includes('request.method !== "GET"'), "Manager must reject non-GET mixer WebSocket upgrades");
  assert.ok(backend.includes('String(upgrade || "").toLowerCase() !== "websocket"'), "Manager must require the WebSocket upgrade token");
  assert.ok(agent.includes('const VIDEO_MIXER_LOCAL_URL = "http://127.0.0.1:9080";'));
  assert.ok(agent.includes('if (requested === "video_mixer")'));
  assert.ok(agent.includes('return { id: "video_mixer", label: "video mixer", localUrl: VIDEO_MIXER_LOCAL_URL };'));
  assert.ok(agent.includes('throw new Error("proxy target is not allowed")'), "The agent must reject arbitrary proxy targets");
  assert.ok(agent.includes("video_mixer: videoMixerState"), "Mixer availability must be reported in telemetry");
  assert.ok(agent.includes('rawPath !== "/wsenc"'), "Only the exact raw mixer encoder bridge path may leave port 9080");
  assert.ok(agent.includes('target: localProxyUrl(belaui.localUrl, "/")'), "Mixer encoder WebSockets must use the allowlisted belaUI root");
  assert.ok(agent.includes('path: "/wsenc?port=65535"'), "The agent self-test must prove browser port input is ignored");
  assert.ok(agent.includes('path: "//anything/wsenc"'), "The agent self-test must reject URL-normalized path confusion");
  assert.ok(agent.includes('"missing mixer websocket upgrade"'), "The agent self-test must require an explicit WebSocket upgrade");
  assert.ok(agent.includes('"mixer encoder bridge cookie isolation"'), "Mixer session cookies must not reach belaUI");

  assert.ok(backend.includes("if (mixer && !videoMixerInstalled(live))"));
  assert.ok(backend.includes('stringValue(mixer.target) === "video_mixer"'), "Mixer capability telemetry must identify its fixed target");
  assert.ok(backend.includes("mixer?.installed === true"), "Mixer installation must remain distinct from service reachability");
  assert.ok(backend.includes('throw new RequestError(409, "Video Mixer is not installed.");'));
  assert.ok(agent.includes('const unit = "irlplus-video-mixer.service";'), "Agent must detect the real IRL+ unit");
  assert.ok(agent.includes("videoMixerSnapshot(probe.state, true)"), "Agent must publish installation independently from port state");
  assert.ok(agent.includes("agent_session_id: agentSessionId"), "Agent status and telemetry must carry a process-session capability marker");
  assert.ok(agent.includes("if (proxyStateRefreshPromise) return proxyStateRefreshPromise;"), "Mixer probes must be single-flight");
  assert.ok(!agent.includes("http.validateHeaderName"), "WebSocket header validation must support the Belabox image's Node runtime");
  assert.ok(agent.includes('"proxy WebSocket upgrade header"'), "Agent self-test must prove WebSocket upgrade headers survive validation");
  assert.ok(agent.includes("void refreshProxyStatesAndPublish(true);"), "Agent connect must probe mixer availability before publishing telemetry");
  assert.ok(agent.includes("await refreshProxyStatesAndPublish(true);"), "Manual telemetry refresh must include a fresh mixer probe");
  assert.ok(backend.includes('if (target === "video_mixer") return rewriteVideoMixerText(route, text);'));
  assert.ok(backend.includes("(api|media|wsenc)(?=[/?#"), "Only the mixer's known absolute routes should be rewritten");

  assert.ok(backend.includes("videoMixerUpstreamCookie(deviceId, headers.cookie)"));
  assert.ok(backend.includes("rewriteVideoMixerSetCookie(deviceId, value)"));
  assert.ok(!backend.includes("REMOTE_BELAUI_MAX_HTTP_BODY_BYTES"), "Remote media must not have a total body-size ceiling");
  assert.ok(backend.includes("CONTROL_SEND_HIGH_WATER_BYTES"), "Remote media must use bounded backpressure");
  assert.ok(
    backend.includes("request.iterator({ destroyOnReturn: false })"),
    "Remote request bodies must stream without destroying early-response uploads",
  );
  assert.ok(backend.includes('return `frame_mixer_${createHash("sha256").update(deviceId)'));
  assert.ok(backend.includes('const cookiePath = `${remoteProxyDeviceRoute(deviceId, "video_mixer")}/`;'));
  assert.ok(agent.includes('(proxy.id !== "video_mixer" && PROXY_RESPONSE_HEADER_BLOCKLIST.has(lower))'));

  assert.ok(frontend.includes("const mixerReachable = Boolean(live?.online && videoMixer?.state === \"reachable\");"));
  assert.ok(frontend.includes("const mixerInstalled = videoMixer?.installed === true;"));
  assert.ok(frontend.includes('data-workspace-pane="mixer"'));
  assert.ok(frontend.includes("The access link remains available and will reconnect when the mixer service is running."));
  assert.ok(frontend.includes('const path = `/belabox/mixer?key=${encodeURIComponent(deviceId)}`;'));
});

test("Stream Management exports FRAME destinations through the remote BelaUI bridge", async () => {
  const [streams, manager, agent] = await Promise.all([
    readFile("services/frame-streams/src/index.ts", "utf8"),
    readFile("services/frame-belabox-manager/src/index.ts", "utf8"),
    readFile("services/frame-belabox-manager/agent/belabox-agent.mjs", "utf8"),
  ]);
  assert.ok(streams.includes('app.get("/internal/belabox-relay-catalog"'));
  assert.ok(streams.includes('profile.source_type === "sls" && profile.publisher'));
  assert.ok(manager.includes('publishSignedCommand(deviceId, "relay_catalog_sync"'));
  assert.ok(manager.includes("frameRelayBridgeScript"));
  assert.ok(manager.includes("WebSocket.prototype.send"));
  assert.ok(agent.includes('relayCatalogSnapshot("cached"'));
});

test("Hybrid exposes Belabox agent routes and remote UI without exposing the manager UI/API", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  capabilities["frame-belabox-manager"] = true;
  const prefixes = computeEffectivePublicPrefixes({
    mode: "HYBRID",
    capabilities,
    public_route_prefixes: [...PUBLIC_PREFIXES, "/belabox", "/belabox/api", "/belabox/assets"],
  });
  assert.ok(prefixes.includes("/belabox/remote"));
  assert.ok(prefixes.includes("/belabox/mixer"));
  assert.ok(prefixes.includes("/belabox/control"));
  assert.ok(prefixes.includes("/belabox-chunks"));
  assert.ok(!prefixes.includes("/belabox"));
  assert.ok(!prefixes.includes("/belabox/api"));
  assert.ok(!prefixes.includes("/belabox/assets"));
});

test("FRAME Edge denies management surfaces when a tunnel bypasses the public gateway", async () => {
  const composeTemplate = await readFile("installer/templates/docker-compose.yml", "utf8");
  assert.ok(composeTemplate.includes("traefik.http.routers.frame-public-deny.rule"));
  const denyRule =
    composeTemplate
      .split("\n")
      .find((line) => line.includes("traefik.http.routers.frame-public-deny.rule")) ?? "";
  for (const route of ["/slsui", "/audio/admin", "/audio/capture", "/audio/api", "/belabox", "/belabox/api", "/belabox/assets", "/pipeline", "/overlays/setup", "/overlays/api"]) {
    assert.ok(denyRule.includes(`Path(\`${route}\`)`), `${route} is missing from the Edge deny router`);
  }
  assert.ok(!denyRule.includes("PathPrefix(`/belabox/`)"), "Remote belaUI must be able to reach the SSO-protected Belabox router");
});

test("Hybrid public gateway forwards the exact root when the dashboard is public", async () => {
  const installer = await readFile("installer/frame-installer.mjs", "utf8");
  assert.ok(installer.includes('prefixes.includes("/dashboard")'));
  assert.ok(installer.includes('frame-public-root:'));
  assert.ok(installer.includes('rule: "Path(\\`/\\`)"'));
});

test("Hybrid public gateway serves branded external error pages", async () => {
  const installer = await readFile("installer/frame-installer.mjs", "utf8");
  assert.ok(installer.includes("frame-public-errors:"));
  assert.ok(installer.includes('query: "/auth/error/{status}"'));
  assert.ok(installer.includes("frame-public-not-found:"));
  assert.ok(installer.includes('rule: "PathPrefix(\\`/\\`)"'));
  assert.ok(installer.includes("frame-public-not-found-path:"));
  assert.ok(installer.includes("path: /auth/error/404"));
});

test("Stream Management opens overlay management through the LAN edge", async () => {
  const composeTemplate = await readFile("installer/templates/docker-compose.yml", "utf8");
  assert.ok(composeTemplate.includes("OVERLAY_WIZARD_URL: /overlays/setup"));
  assert.ok(
    !composeTemplate.includes("OVERLAY_WIZARD_URL: ${EDGE_PUBLIC_BASE_URL:-http://localhost}/overlays/setup"),
  );
});

test("prefix normalization removes duplicates and child routes", () => {
  assert.deepEqual(normalizePrefixes(["/today/viewer", "/today", "/today", "/status"]), [
    "/today",
    "/status",
  ]);
});

test("Windows and Unix wrappers preserve direct commands while offering the numbered command center", async () => {
  const [powershell, shell, installer] = await Promise.all([
    readFile("installer/stack.ps1", "utf8"),
    readFile("installer/stack.sh", "utf8"),
    readFile("installer/frame-installer.mjs", "utf8"),
  ]);
  for (const wrapper of [powershell, shell]) {
    assert.ok(wrapper.includes("Guided setup"));
    assert.ok(wrapper.includes("Configure services"));
    assert.ok(wrapper.includes("Validate and verify"));
    assert.ok(wrapper.includes("Start or update stack"));
    assert.ok(wrapper.includes("set-discord-auth"));
    assert.ok(wrapper.includes("set-service-auth"));
    assert.ok(wrapper.includes("PHOTO_ARCHIVE_RETENTION_DAYS"));
    assert.ok(wrapper.includes("PHOTO_TRASH_RETENTION_DAYS"));
  }
  assert.ok(
    powershell.includes('"--force-recreate", "--no-deps"') &&
      powershell.includes('"frame-public-gateway"'),
    "Windows Hybrid startup must recreate the public gateway after regenerating routes",
  );
  assert.ok(
    shell.includes("compose up -d --force-recreate --no-deps") &&
      shell.includes("frame-public-gateway"),
    "Unix Hybrid startup must recreate the public gateway after regenerating routes",
  );
  assert.ok(
    powershell.includes('Invoke-Runtime @("install")'),
    "Windows startup must migrate an existing stack configuration before validating it",
  );
  assert.ok(
    shell.includes("runtime install"),
    "Unix startup must migrate an existing stack configuration before validating it",
  );
  assert.ok(installer.includes('"set"'));
  assert.ok(installer.includes("CUSTOMIZABLE_ENV_KEYS"));
  assert.ok(installer.includes("setDiscordAuth"));
  assert.ok(installer.includes("setServiceAuth"));
  assert.ok(installer.includes("PORTAL_USERNAME and PORTAL_PASSWORD are required before starting FRAME."));
  assert.ok(installer.includes("value = JSON.parse(value)"), "quoted .env values must remain idempotent");
  assert.ok(!powershell.includes("$(if"), "PowerShell wrapper must not execute inline if expressions as commands");
  assert.ok(!powershell.includes("= if ("), "PowerShell wrapper must remain compatible with Windows PowerShell 5");
  assert.ok(!powershell.includes("return if ("), "PowerShell wrapper must not return an if expression");
  const oldPhotoBranding = ["Today", "Tools"].join(" ");
  assert.ok(!powershell.includes(oldPhotoBranding), "Windows wrapper should avoid old photo branding");
  assert.ok(!shell.includes(oldPhotoBranding), "Unix wrapper should avoid old photo branding");
  assert.ok(powershell.includes("Get-HostLanIPv4Candidates"), "Windows wrapper must detect host LAN IP candidates for passive FTP");
  assert.ok(powershell.includes("Read-PhotoFtpPassiveHost"), "Windows wrapper must prompt with a passive FTP LAN host helper");
  assert.ok(powershell.includes("Portal login needs setup."), "Windows setup must require Portal credentials in every mode");
  assert.ok(powershell.includes('$current -and $current -ne "127.0.0.1"'), "Passive FTP prompt must not preserve loopback as the default");
  assert.ok(shell.includes("lan_ipv4_candidates"), "Unix wrapper must detect host LAN IP candidates for passive FTP");
  assert.ok(shell.includes("read_photo_ftp_passive_host"), "Unix wrapper must prompt with a passive FTP LAN host helper");
  assert.ok(shell.includes("Portal login needs setup."), "Unix setup must require Portal credentials in every mode");
  assert.ok(shell.includes('[ "$current" != "127.0.0.1" ]'), "Unix passive FTP prompt must not preserve loopback as the default");
  assert.ok(powershell.includes("Start-FrameDiscovery"));
  assert.ok(powershell.includes("Stop-FrameDiscovery"));
  assert.ok(powershell.includes("discovery-watch"), "Windows discovery must recover after user sign-in");
  assert.ok(powershell.includes("frame-mdns-watch.json"), "Windows discovery must track its watchdog safely");
  assert.ok(powershell.includes("Test-FrameEdgeReachable"), "Windows discovery must follow Edge availability");
  assert.ok(powershell.includes("Start Menu\\Programs\\Startup"), "Windows discovery must install a per-user startup entry");
  assert.ok(shell.includes("start_frame_discovery"));
  assert.ok(shell.includes("stop_frame_discovery"));
  assert.ok(powershell.includes("frame.local") && shell.includes("frame.local"));
});

test("Belabox agent installation is Hybrid/WSS-only across both installers", async () => {
  const [installer, powershell, shell, setupFrontend, setupBackend, installerReadme, managerReadme] = await Promise.all([
    readFile("installer/frame-installer.mjs", "utf8"),
    readFile("installer/stack.ps1", "utf8"),
    readFile("installer/stack.sh", "utf8"),
    readFile("apps/frame-setup/src/main.js", "utf8"),
    readFile("apps/frame-setup/src-tauri/src/lib.rs", "utf8"),
    readFile("installer/README.md", "utf8"),
    readFile("services/frame-belabox-manager/README.md", "utf8"),
  ]);

  assert.ok(installer.includes("assertBelaboxManagerDeployment(mode, capabilities)"));
  assert.ok(installer.includes('parsed.protocol !== "wss:"'));
  assert.ok(installer.includes("must be a public wss:// URL ending in /belabox/control"));
  assert.ok(installer.includes("normalizeControlUrl(controlWebSocketUrl(edgePublicBaseUrl))"));
  assert.ok(installer.includes("must be derived from EDGE_PUBLIC_BASE_URL"));
  assert.ok(
    setupBackend.includes('"--force-recreate"') &&
      setupBackend.includes('"frame-public-gateway"'),
    "FRAME Setup must recreate the Hybrid public gateway after regenerating routes",
  );
  const importableSettings = installer.match(/const IMPORTABLE_ENV_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  const customizableSettings = installer.match(/const CUSTOMIZABLE_ENV_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.ok(!importableSettings.includes("BELABOX_CONTROL_PUBLIC_URL"));
  assert.ok(!customizableSettings.includes("BELABOX_CONTROL_PUBLIC_URL"));
  assert.ok(!powershell.includes('"BELABOX_CONTROL_PUBLIC_URL"'));
  assert.ok(!shell.includes("\nBELABOX_CONTROL_PUBLIC_URL\n"));
  assert.match(
    powershell,
    /\$needsBelaboxHybrid[\s\S]*?Read-Default "Cloudflare public hostname \(or 0 to cancel\)"[\s\S]*?IsNullOrWhiteSpace\(\$hostname\)[\s\S]*?Invoke-Runtime \(@\("install", "--mode", "HYBRID", "--public-hostname", \$hostname\) \+ \$arguments\)/,
    "Windows service selection must require a hostname and stage Hybrid without losing the selected services",
  );
  assert.match(
    shell,
    /\[ "\$capability" = "frame-belabox-manager" \][\s\S]*?read_default "Cloudflare public hostname \(or 0 to cancel\)"[\s\S]*?\[ -z "\$REPLY" \][\s\S]*?if runtime install --mode HYBRID --public-hostname "\$REPLY" --enable "\$capability"; then/,
    "Unix service selection must retry invalid hostnames without triggering set -e",
  );
  assert.ok(setupFrontend.includes("hybridOnly: true"));
  assert.ok(!setupFrontend.includes('["BELABOX_CONTROL_PUBLIC_URL"'));
  assert.ok(setupFrontend.includes('state.deploymentMode = "HYBRID";'));
  assert.ok(setupFrontend.includes('state.selectedServices["frame-belabox-manager"] = false;'));
  assert.ok(setupBackend.includes("validate_install_plan(plan)?;"));
  assert.ok(setupBackend.includes("requires Hybrid mode and a public WSS control endpoint"));
  assert.match(setupBackend, /"BELABOX_CONTROL_PUBLIC_URL"[\s\S]*?default_belabox_control_url/);
  assert.ok(installerReadme.includes("cannot be enabled in LAN mode"));
  assert.ok(managerReadme.includes("Belabox agent install and repair are Hybrid-only"));
});

test("FRAME Setup app captures the approved GUI installer decisions", async () => {
  const [manifest, frontend, styles, cargo, tauriConfig, rust, buildScript, appReadme, adr] = await Promise.all([
    readFile("apps/frame-setup/package.json", "utf8").then(JSON.parse),
    readFile("apps/frame-setup/src/main.js", "utf8"),
    readFile("apps/frame-setup/src/styles.css", "utf8"),
    readFile("apps/frame-setup/src-tauri/Cargo.toml", "utf8"),
    readFile("apps/frame-setup/src-tauri/tauri.conf.json", "utf8").then(JSON.parse),
    readFile("apps/frame-setup/src-tauri/src/lib.rs", "utf8"),
    readFile("apps/frame-setup/scripts/build-windows.ps1", "utf8"),
    readFile("apps/frame-setup/README.md", "utf8"),
    readFile("docs/adr/0011-native-frame-setup-app.md", "utf8"),
  ]);
  assert.equal(manifest.name, "@syronius-frame/setup");
  assert.equal(tauriConfig.productName, "FRAME Setup");
  for (const expected of ["Quick Start", "Guided Setup", "Advanced", "Welcome to FRAME", "Install FRAME"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from the setup flow`);
  }
  for (const expected of ["SETUP_STAGES", "stageStatusLabel", "Locked", "canProceedFromStage", "Run readiness checks", "syncProgressControls", "readinessPassed"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from the staged wizard flow`);
  }
  for (const expected of ["Browse folder", "usePreviewFolder", "hostReadyForInstall", "dockerBlockingChecks", "Install Docker first"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from the guarded install flow`);
  }
  for (const expected of ["Installer", "stage-check", "publicHostnameValidation", "isValidPublicHostname", "step-page animate"]) {
    assert.ok(frontend.includes(expected) || styles.includes(expected), `${expected} is missing from the installer UX flow`);
  }
  for (const expected of ["validationMessageForStage", "renderStageNotice", "portValidation", "numericPortInput", "network-controls"]) {
    assert.ok(frontend.includes(expected) || styles.includes(expected), `${expected} is missing from installer validation`);
  }
  for (const expected of ["Advertised SRTLA host", "PUBLIC_RELAY_HOST", "publicRelayHostValidation", "isValidRelayHost"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from relay host setup`);
  }
  for (const expected of ["renderGuidedServicePanel", "guidedServiceIndex", "guidedReviewedServices", "Next service", "Finish service review", "markCurrentGuidedServiceReviewed", "service-detail-card"]) {
    assert.ok(frontend.includes(expected) || styles.includes(expected), `${expected} is missing from guided service review`);
  }
  for (const expected of ["installStatus", "startInstallLogListener", "install-log", "isTauriRuntime", "Open FRAME Setup", "finishInstaller", "lastSetupUrl"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from install progress handling`);
  }
  for (const expected of ["What it does", "Why you might want it", "Ports and exposure", "What comes next in localhost/setup", "service-info-block"]) {
    assert.ok(frontend.includes(expected) || styles.includes(expected), `${expected} is missing from guided service explanations`);
  }
  assert.ok(frontend.includes("stage-viewport"));
  assert.ok(styles.includes("grid-template-rows: minmax(0, 1fr) auto"));
  assert.ok(styles.includes(".stage-viewport"));
  for (const expected of ['value.includes("://")', 'value.includes("/")', 'value.includes(":")', '!value.includes(".")']) {
    assert.ok(frontend.includes(expected), `${expected} is missing from public hostname malformed checks`);
  }
  assert.ok(!frontend.includes("window.prompt"), "Storage selection should use the native folder picker, not typed browser prompts");
  for (const expected of ["EDGE_HTTP_PORT", "PHOTO_FTP_PORT", "PHOTO_FTP_PASSIVE_MIN", "PHOTO_FTP_PASSIVE_MAX", "PHOTO_FTP_PASSIVE_MIN/MAX", "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_FTP_MAX_SESSIONS", "PHOTO_UPLOAD_MAX_FILES", "PHOTO_UPLOAD_MAX_SESSIONS", "PHOTO_ARCHIVE_RETENTION_DAYS", "PHOTO_TRASH_RETENTION_DAYS", "SRTLA_PORT", "SRT_PLAYER_PORT", "SRT_SENDER_PORT"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from exposed port planning`);
  }
  assert.match(frontend, /key: "ftpPassiveMax"[\s\S]*?defaultValue: 30019/, "Photo FTP passive max should default to the wider installer range");
  assert.match(frontend, /key: "PHOTO_FTP_MAX_SESSIONS"[\s\S]*?defaultValue: "20"/, "Photo FTP max sessions should match the installer default");
  assert.match(frontend, /key: "PHOTO_UPLOAD_MAX_FILES"[\s\S]*?defaultValue: "100"/, "Browser uploads should allow the larger queue by default");
  assert.match(frontend, /key: "PHOTO_UPLOAD_MAX_SESSIONS"[\s\S]*?defaultValue: "2"/, "Browser uploads should default to two concurrent sessions");
  assert.match(frontend, /key: "PHOTO_ARCHIVE_RETENTION_DAYS"[\s\S]*?defaultValue: "0"[\s\S]*?min: 0[\s\S]*?max: 36500/, "Archive retention should be opt-in and bounded");
  assert.match(frontend, /key: "PHOTO_TRASH_RETENTION_DAYS"[\s\S]*?defaultValue: "0"[\s\S]*?min: 0[\s\S]*?max: 36500/, "Trash retention should be opt-in and bounded");
  assert.ok(frontend.includes('photoFtpPassive: "30000-30019"'), "Initial install plan should use the wider FTP passive range");
  assert.ok(frontend.includes("selectedServices"));
  assert.ok(frontend.includes("subfolders"));
  assert.ok(frontend.includes("state/frame-install-plan.json"));
  assert.ok(frontend.includes("frame-logo-square.png"));
  assert.ok(styles.includes("--frame-accent: #2cb4fb"));
  assert.ok(!frontend.includes("day mode"));
  assert.ok(cargo.includes("tauri-plugin-dialog"));
  assert.ok(cargo.includes("tauri-plugin-opener"));
  for (const expected of ["detect_previous_installations", "run_preflight", "save_install_plan", "apply_install_plan", "frame-install.json", "record_installation"]) {
    assert.ok(rust.includes(expected), `${expected} is missing from host setup commands`);
  }
  for (const expected of ["docker", "compose", "docker-compose.yml", "COMPOSE_PROFILES", "find_stack_source", "frame-stack", "resource_dir", "hidden_command", "CREATE_NO_WINDOW", "BUILDKIT_PROGRESS", "advanced_settings", "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_UPLOAD_MAX_FILES", "PHOTO_ARCHIVE_RETENTION_DAYS", "PHOTO_TRASH_RETENTION_DAYS"]) {
    assert.ok(rust.includes(expected), `${expected} is missing from native install/apply backend`);
  }
  assert.ok(rust.includes("is_valid_relay_host"), "Native setup must validate the advertised SRTLA host");
  assert.ok(rust.includes("30000-30019"), "Native setup should describe the current FTP passive range");
  assert.match(rust, /"PHOTO_FTP_MAX_SESSIONS"[\s\S]*?"20"/, "Native setup should write the current FTP session default");
  assert.match(rust, /"PHOTO_UPLOAD_MAX_FILES"[\s\S]*?"100"/, "Native setup should write the current browser upload queue default");
  assert.match(rust, /"PHOTO_UPLOAD_MAX_SESSIONS"[\s\S]*?"2"/, "Native setup should write the current browser upload concurrency default");
  assert.match(rust, /"PHOTO_ARCHIVE_RETENTION_DAYS"[\s\S]*?"0"[\s\S]*?0,[\s\S]*?36500/, "Native setup should validate and persist archive retention");
  assert.match(rust, /"PHOTO_TRASH_RETENTION_DAYS"[\s\S]*?"0"[\s\S]*?0,[\s\S]*?36500/, "Native setup should validate and persist trash retention");
  assert.ok(tauriConfig.bundle.resources["../../../services/"], "setup app must bundle FRAME services");
  assert.ok(tauriConfig.bundle.resources["../../../config/"], "setup app must bundle FRAME config");
  assert.ok(tauriConfig.bundle.resources["../../../installer/stack.ps1"], "setup app must bundle the Windows stack launcher");
  assert.ok(tauriConfig.bundle.resources["../../../installer/stack.sh"], "setup app must bundle the Unix stack launcher");
  assert.ok(rust.includes('"discovery-start"'), "native setup must enable discovery through the shared launcher");
  assert.ok(tauriConfig.bundle.icon.includes("icons/icon.ico"));
  assert.ok((await readFile("apps/frame-setup/src-tauri/src/main.rs", "utf8")).includes("windows_subsystem"));
  assert.ok(frontend.includes("apply_install_plan"), "Install FRAME must call the native apply backend");
  assert.ok(styles.includes("install-frame-button"), "Install FRAME should use the Audio Bridge action button treatment");
  assert.ok(rust.includes("Start Docker, then recheck."), "Docker Engine must be a blocking readiness check");
  assert.ok(buildScript.includes("npm install"));
  assert.ok(buildScript.includes("npm run tauri build"));
  assert.ok(appReadme.includes("Windows installer build"));
  assert.ok(appReadme.includes("Microsoft C++ Build Tools"));
  assert.ok(adr.includes("native Windows host"));
});

async function assertSameFile(left, right) {
  const [leftContents, rightContents] = await Promise.all([
    readFile(left, "utf8"),
    readFile(right, "utf8"),
  ]);
  assert.equal(rightContents, leftContents, `${right} drifted from ${left}`);
}

function composeServiceBlock(compose, service) {
  compose = compose.replaceAll("\r\n", "\n");
  const marker = `  ${service}:\n`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `${service} is missing from the installer Compose template`);
  const followingService = compose.slice(start + marker.length).match(/\n  [A-Za-z0-9_-]+:\n/);
  const end = followingService
    ? start + marker.length + followingService.index
    : -1;
  return compose.slice(start, end === -1 ? undefined : end);
}
