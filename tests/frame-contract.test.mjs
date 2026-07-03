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
} from "../installer/frame-contract.mjs";

const execFileAsync = promisify(execFile);

test("canonical registry matches the published stack-config schema", async () => {
  const schema = JSON.parse(await readFile("docs/schemas/stack-config.schema.json", "utf8"));
  assert.deepEqual(schema.properties.capabilities.required, CAPABILITIES);
  assert.deepEqual(Object.keys(schema.properties.capabilities.properties), CAPABILITIES);
  assert.deepEqual(schema.properties.routes.required, Object.keys(ROUTES));
  assert.deepEqual(Object.keys(schema.properties.routes.properties), Object.keys(ROUTES));
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
  const [compose, brokerConfig] = await Promise.all([
    readFile("installer/templates/docker-compose.yml", "utf8"),
    readFile("services/frame-belabox-broker/mosquitto.conf", "utf8"),
  ]);
  const photoUpload = composeServiceBlock(compose, "frame-photo-upload");
  const photoFtp = composeServiceBlock(compose, "frame-photo-ftp");
  const belaboxBroker = composeServiceBlock(compose, "frame-belabox-broker");
  const belabox = composeServiceBlock(compose, "frame-belabox-manager");
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
  assert.ok(belaboxBroker.includes("image: eclipse-mosquitto@sha256:"));
  assert.ok(belaboxBroker.includes("BELABOX_MQTT_PASSWORD: ${BELABOX_MQTT_PASSWORD:-}"));
  assert.ok(belaboxBroker.includes("Path(`/mqtt`) || PathPrefix(`/mqtt/`)"));
  assert.ok(brokerConfig.includes("acl_file /mosquitto/data/acl"));
  assert.ok(!belaboxBroker.includes("ports:"));
  assert.ok(belabox.includes("BELABOX_HOST: ${BELABOX_HOST:-}"));
  assert.ok(belabox.includes("BELABOX_SSH_CREDENTIAL_KEY: ${BELABOX_SSH_CREDENTIAL_KEY:-}"));
  assert.ok(belabox.includes("BELABOX_AGENT_COMMANDS_ENABLED: ${BELABOX_AGENT_COMMANDS_ENABLED:-false}"));
  assert.ok(belabox.includes("BELABOX_MQTT_INTERNAL_URL: ${BELABOX_MQTT_INTERNAL_URL:-mqtt://frame-belabox-broker:1883}"));
  assert.ok(belabox.includes("BELABOX_MQTT_PASSWORD: ${BELABOX_MQTT_PASSWORD:-}"));
  assert.ok(belabox.includes("BELABOX_CHUNK_UPLOAD_URL: ${BELABOX_CHUNK_UPLOAD_URL:-}"));
  assert.ok(belabox.includes("Path(`/belabox-chunks`) || PathPrefix(`/belabox-chunks/`)"));
  assert.ok(belabox.includes("BELABOX_DIAGNOSTIC_UPLOAD_BYTES: ${BELABOX_DIAGNOSTIC_UPLOAD_BYTES:-8388608}"));
  assert.ok(belabox.includes("BELABOX_BROKER_DATA_DIR: /broker-data"));
  assert.ok(belabox.includes("frame-belabox-broker:"));
  assert.ok(!belabox.includes("ports:"));
  assert.ok(overlays.includes("PORTAL_SERVICE_TOKEN: ${PORTAL_SERVICE_TOKEN}"));
  assert.ok(overlays.includes("PHOTO_UPLOAD_API_URL: http://frame-photo-upload:3736"));
  assert.ok(overlays.includes("PHOTO_FTP_API_URL: http://frame-photo-ftp:3737"));
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
  assert.ok(html.includes("app.js?v=stream-delete-dialog-v1"), "SLSUI app cache key should change when management behavior changes");
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
  const [frontend, html, styles, renderer, uploadRenderer, rendererStyles] = await Promise.all([
    readFile("services/frame-overlays/public/app.js", "utf8"),
    readFile("services/frame-overlays/public/index.html", "utf8"),
    readFile("services/frame-overlays/public/styles.css", "utf8"),
    readFile("services/frame-overlays/public/renderer.js", "utf8"),
    readFile("services/frame-overlays/public/upload-renderer.js", "utf8"),
    readFile("services/frame-overlays/public/renderer.css", "utf8"),
  ]);
  assert.ok(html.includes("FRAME Overlay Wizard"));
  assert.ok(html.includes("FrameTheme"), "Overlay Wizard should inherit the shared FRAME theme");
  assert.ok(html.includes("THEME_PROFILE_KEY"), "Overlay Wizard bootstrap should read Portal theme profiles");
  assert.ok(html.includes('id="dashboard-link"'), "Overlay Wizard logo should link to the dashboard");
  assert.ok(html.includes("portal-theme-v2"), "Overlay Wizard assets should cache-bust theme chrome updates");
  assert.ok(html.includes("M21 12.8A9 9 0 1 1 11.2 3"), "Overlay Wizard theme toggle should use the Portal moon icon path");
  assert.ok(html.includes("M4.93 4.93l1.42 1.42"), "Overlay Wizard theme toggle should use the Portal sun icon path");
  assert.ok(frontend.includes("THEME_STORAGE_KEYS"), "Overlay Wizard should listen for Portal theme storage changes");
  assert.ok(frontend.includes("THEME_PROFILE_ID_KEY"), "Overlay Wizard should react when the Portal theme preset changes");
  assert.ok(frontend.includes("dashboardLink.href = dashboardUrl()"), "Overlay Wizard logo should route through the configured public base");
  assert.ok(frontend.includes('new URL("/dashboard", state.config.public_base_url || location.origin).href'));
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
  assert.ok(html.includes("Use fake telemetry data"));
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

test("photo pipeline is internal and activated by every photo capability", () => {
  assert.equal(SERVICE_REGISTRY.internalServices["frame-auth"].userSelectable, false);
  assert.equal(SERVICE_REGISTRY.internalServices["frame-pipeline-photos"].userSelectable, false);
  for (const [name, definition] of Object.entries(SERVICE_REGISTRY.capabilities)) {
    if (!name.startsWith("frame-photo-")) continue;
    assert.ok(definition.profiles.includes("photo-pipeline"), `${name} must activate photo-pipeline`);
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

test("Belabox pairing UI hides MQTT implementation details", async () => {
  const [html, frontend, backend, dockerfile, agent, styles] = await Promise.all([
    readFile("services/frame-belabox-manager/public/index.html", "utf8"),
    readFile("services/frame-belabox-manager/public/app.js", "utf8"),
    readFile("services/frame-belabox-manager/src/index.ts", "utf8"),
    readFile("services/frame-belabox-manager/Dockerfile", "utf8"),
    readFile("services/frame-belabox-manager/agent/belabox-agent.mjs", "utf8"),
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
  assert.ok(frontend.includes("SSH Maintenance"));
  assert.ok(frontend.includes("MQTT Controls"));
  assert.ok(frontend.includes("/belabox/api/pair"));
  assert.ok(frontend.includes("/belabox/api/pair/jobs"));
  assert.ok(frontend.includes("/belabox/api/ftp-connector/jobs"));
  assert.ok(frontend.includes("Enable Chunk Relay"));
  assert.ok(frontend.includes("Run Upload Speed Test"));
  assert.ok(frontend.includes("SSH required"));
  assert.ok(frontend.includes("remember_ssh"));
  assert.ok(frontend.includes("Forget Saved SSH"));
  assert.ok(frontend.includes("detailsOpen"));
  assert.ok(frontend.includes("setButtonBusy"));
  assert.ok(frontend.includes("rememberFormInput"));
  assert.ok(frontend.includes("panelHasEditableFocus"));
  assert.ok(frontend.includes("data-remove-device"));
  assert.ok(frontend.includes('method: "DELETE"'));
  assert.ok(backend.includes("ftp_connectors:"));
  assert.ok(backend.includes("ssh_credentials:"));
  assert.ok(backend.includes("aes-256-gcm"));
  assert.ok(backend.includes("safeFtpPassword"));
  assert.ok(backend.includes("if (!device.last_heartbeat_at) return false"));
  assert.ok(backend.includes("/belabox/api/diagnostics/speed-test"));
  assert.ok(backend.includes("network_speed_test"));
  assert.ok(backend.includes("isProvisionedDevice(parsedTopic.deviceId)"));
  assert.ok(dockerfile.includes("sshpass"));
  assert.ok(dockerfile.includes("iperf3"));
  assert.ok(agent.includes("network_speed_test"));
  assert.ok(agent.includes("BELABOX_CHUNK_UPLOAD_TOKEN"));
  assert.ok(!html.includes("MQTT password"));
  assert.ok(!frontend.includes("BELABOX_MQTT_PASSWORD"));
});

test("Belabox agent rejects invalid signed commands", async () => {
  await execFileAsync("node", ["services/frame-belabox-manager/agent/belabox-agent.mjs", "--self-test"]);
});

test("Hybrid exposes only authenticated Belabox MQTT and not the Belabox manager UI", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  capabilities["frame-belabox-manager"] = true;
  const prefixes = computeEffectivePublicPrefixes({
    mode: "HYBRID",
    capabilities,
    public_route_prefixes: [...PUBLIC_PREFIXES, "/belabox"],
  });
  assert.ok(prefixes.includes("/mqtt"));
  assert.ok(prefixes.includes("/belabox-chunks"));
  assert.ok(!prefixes.includes("/belabox"));
});

test("FRAME Edge denies management surfaces when a tunnel bypasses the public gateway", async () => {
  const composeTemplate = await readFile("installer/templates/docker-compose.yml", "utf8");
  assert.ok(composeTemplate.includes("traefik.http.routers.frame-public-deny.rule"));
  for (const route of ["/slsui", "/audio/admin", "/audio/capture", "/audio/api", "/belabox", "/pipeline", "/overlays/setup", "/overlays/api"]) {
    assert.ok(composeTemplate.includes(`Path(\`${route}\`)`), `${route} is missing from the Edge deny router`);
  }
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
  }
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
  for (const expected of ["EDGE_HTTP_PORT", "PHOTO_FTP_PORT", "PHOTO_FTP_PASSIVE_MIN", "PHOTO_FTP_PASSIVE_MAX", "PHOTO_FTP_PASSIVE_MIN/MAX", "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_FTP_MAX_SESSIONS", "PHOTO_UPLOAD_MAX_FILES", "PHOTO_UPLOAD_MAX_SESSIONS", "SRTLA_PORT", "SRT_PLAYER_PORT", "SRT_SENDER_PORT"]) {
    assert.ok(frontend.includes(expected), `${expected} is missing from exposed port planning`);
  }
  assert.match(frontend, /key: "ftpPassiveMax"[\s\S]*?defaultValue: 30019/, "Photo FTP passive max should default to the wider installer range");
  assert.match(frontend, /key: "PHOTO_FTP_MAX_SESSIONS"[\s\S]*?defaultValue: "20"/, "Photo FTP max sessions should match the installer default");
  assert.match(frontend, /key: "PHOTO_UPLOAD_MAX_FILES"[\s\S]*?defaultValue: "100"/, "Browser uploads should allow the larger queue by default");
  assert.match(frontend, /key: "PHOTO_UPLOAD_MAX_SESSIONS"[\s\S]*?defaultValue: "2"/, "Browser uploads should default to two concurrent sessions");
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
  for (const expected of ["docker", "compose", "docker-compose.yml", "COMPOSE_PROFILES", "find_stack_source", "frame-stack", "resource_dir", "hidden_command", "CREATE_NO_WINDOW", "BUILDKIT_PROGRESS", "advanced_settings", "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_UPLOAD_MAX_FILES"]) {
    assert.ok(rust.includes(expected), `${expected} is missing from native install/apply backend`);
  }
  assert.ok(rust.includes("30000-30019"), "Native setup should describe the current FTP passive range");
  assert.match(rust, /"PHOTO_FTP_MAX_SESSIONS"[\s\S]*?"20"/, "Native setup should write the current FTP session default");
  assert.match(rust, /"PHOTO_UPLOAD_MAX_FILES"[\s\S]*?"100"/, "Native setup should write the current browser upload queue default");
  assert.match(rust, /"PHOTO_UPLOAD_MAX_SESSIONS"[\s\S]*?"2"/, "Native setup should write the current browser upload concurrency default");
  assert.ok(tauriConfig.bundle.resources["../../../services/"], "setup app must bundle FRAME services");
  assert.ok(tauriConfig.bundle.resources["../../../config/"], "setup app must bundle FRAME config");
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
