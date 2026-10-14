import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

const source = await readFile(new URL("../apps/frame-setup/src/main.js", import.meta.url), "utf8");
const good = { checks: [{ label: "Host ports", status: "good", detail: "Available" }] };
const defaults = { installRoot: "C:\\managed\\FRAME", dataRoot: "D:\\FRAME data" };
const installation = {
  ...defaults, dashboardUrl: "http://localhost/dashboard", state: "running", detail: "FRAME is running.",
  version: "1.0.0", services: [{ name: "frame-portal", status: "running", health: "healthy" }],
  canStart: false, canStop: true, canRecover: false, canReconfigure: true,
};
const status = (install = installation) => ({ installations: install ? [install] : [], dockerAvailable: true, defaults, observedAt: "2026-09-30T12:00:00Z" });

async function ui(invoke = async () => good, desktop = true, pickDirectory = async () => "E:\\Chosen data", exportReport = async () => ({ report: {}, completed: true })) {
  const app = { innerHTML: "", querySelectorAll: () => [] };
  const events = {};
  const calls = [];
  const opened = [];
  const dispatch = async (command, args) => {
    calls.push({ command, args });
    if (typeof invoke === "object" && invoke[command]) return invoke[command](args);
    if (command === "get_launcher_status") return status(null);
    if (command === "load_draft") return { draft: null };
    if (command === "save_draft" || command === "clear_draft") return {};
    if (command === "get_launcher_preferences") return { keepInTray: true, notifications: true, startAtLogin: false, startAtLoginSupported: false };
    if (typeof invoke === "function") return invoke(command, args);
    return { ...good, defaults };
  };
  const context = vm.createContext({
    URL,
    window: desktop ? { frameDesktop: { invoke: dispatch, pickDirectory, exportReport, openExternal: async (url) => opened.push(url), listen: (name, callback) => { events[name] = callback; return () => { delete events[name]; }; } } } : {},
    document: {
      querySelector: (selector) => selector === "#app" ? app : null,
      querySelectorAll: () => [], documentElement: { style: { setProperty() {} } },
    },
  });
  vm.runInContext(`${source}\nglobalThis.ui = {state, invalidatePreflight, runPreflight, readinessPassed, applyInstall, portValidation, photoFtpHostValidation, exposedPortsForSelection, buildPlan, applyLoadedPlan, mockInvoke, render, acceptLauncherStatus, refreshLauncherStatus, runLauncherAction, setupDraft, saveSetupDraft, discardSetupDraft, continueSetupDraft, selectSetupMode, beginSetup, chooseFolder, reconfigureInstall, openDockerGuide, hostReadyForInstall, refreshHostStatus, portalUrl, openSetup, checkForUpdates, saveLauncherPreference, supportAction, chooseProtectionFolder, protectionAction};`, context);
  await setImmediate();
  context.ui.state.existingInstall = true;
  return { ...context.ui, app, calls, events, opened, document: context.document };
}

test("editing a pending preflight rejects its stale result; a failed retry clears success", async () => {
  let complete;
  const page = await ui((command) => command === "detect_host" ? Promise.resolve(good) : new Promise((resolve) => { complete = resolve; }));
  const pending = page.runPreflight();
  assert.equal(page.state.preflightRunning, true);
  assert.equal(page.readinessPassed(), false);
  await setImmediate();
  page.state.ports.edge = 8081;
  page.invalidatePreflight();
  complete(good);
  await pending;
  assert.equal(page.state.preflight, null);
  assert.equal(page.readinessPassed(), false);

  const failed = await ui(async (command) => {
    if (command === "detect_host") return good;
    throw new Error("inspection timed out");
  });
  failed.state.preflight = good;
  assert.equal(failed.readinessPassed(), true);
  await failed.runPreflight();
  assert.equal(failed.readinessPassed(), false);
  assert.match(failed.state.validationMessage, /timed out/);
});

test("apply requires real current checks and preview cannot save or deploy", async () => {
  const calls = [];
  const page = await ui(async (command) => { calls.push(command); return good; });
  await page.applyInstall();
  assert.ok(!calls.includes("apply_install_plan"));
  page.state.preflight = { checks: [] };
  assert.equal(page.readinessPassed(), false);
  page.state.preflight = { checks: [{ status: "warn" }] };
  assert.equal(page.readinessPassed(), false);
  page.state.preflight = { checks: [{ status: "good" }, { status: "warn" }] };
  assert.equal(page.readinessPassed(), true);
  page.state.preflight.checks.push({ status: "bad" });
  assert.equal(page.readinessPassed(), false);

  const preview = await ui(undefined, false);
  preview.state.preflight = good;
  assert.equal(preview.readinessPassed(), false);
  await assert.rejects(preview.mockInvoke("apply_install_plan", {}), /disabled in browser preview/);
  await assert.rejects(preview.mockInvoke("save_install_plan", {}), /disabled in browser preview/);
  preview.render();
  assert.match(preview.app.innerHTML, /Browser preview/);
});

test("port plan includes active direct services and permits TCP/UDP reuse", async () => {
  const page = await ui();
  page.state.selectedServices["frame-video-relay"] = true;
  page.state.selectedServices["frame-photo-ftp"] = true;
  page.state.ports.srtla = page.state.ports.edge;
  page.state.ports.srtPlayer = page.state.ports.ftpPassiveMin;
  assert.equal(page.portValidation().status, "good");
  page.state.ports.portal = page.state.ports.ftpPassiveMin;
  assert.equal(page.portValidation().status, "bad");
  page.state.ports.portal = page.state.ports.edge;
  assert.equal(page.portValidation().status, "bad");
  const ports = page.exposedPortsForSelection().map((port) => port.key);
  assert.ok(ports.includes("portal") && ports.includes("slsStats") && ports.includes("streams"));
  assert.ok(!ports.includes("audioBridge") && !ports.includes("gallery"));
  assert.equal(page.photoFtpHostValidation().status, "good", "Existing FTP address can be preserved");
  page.state.existingInstall = false;
  assert.equal(page.photoFtpHostValidation().status, "warn", "New FTP requires a reachable address");
  page.state.advancedSettings.PHOTO_FTP_PASSIVE_HOST = "127.0.0.1";
  assert.equal(page.photoFtpHostValidation().status, "bad");
  page.state.advancedSettings.PHOTO_FTP_PASSIVE_HOST = "192.168.1.10";
  assert.equal(page.photoFtpHostValidation().status, "good");
});

test("plan snapshots copy credentials and loaded plans never restore secrets", async () => {
  const page = await ui();
  page.state.credentials.portalPassword = "temporary-test-value";
  const plan = page.buildPlan();
  page.state.credentials.portalPassword = "changed-test-value";
  assert.equal(plan.credentials.portalPassword, "temporary-test-value");
  page.applyLoadedPlan({ ...plan, ports: { ...plan.ports, portal: 4999 }, autoPorts: true, subfolders: { photos: "custom" } });
  assert.equal(page.state.credentials.portalPassword, "");
  assert.equal(page.state.ports.portal, 4999);
  assert.equal(page.state.autoPorts, false);
  assert.equal(page.state.subfolders.photos, "photos");
});

test("historical plans drop Audio Bridge controls and retain Audio Monitor", async () => {
  const page = await ui();
  page.applyLoadedPlan({ ...page.buildPlan(), selectedServices: ["frame-audio-relay", "frame-discord-audio-bridge"],
    ports: { audioMonitor: 4734, audioBridge: 3729 }, credentials: { discordToken: "legacy-secret" } });
  const plan = page.buildPlan();
  assert.deepEqual(Array.from(plan.selectedServices), ["frame-audio-relay"]);
  assert.equal(plan.ports.audioMonitor, 4734);
  assert.equal(plan.ports.audioBridge, undefined);
  assert.equal(plan.credentials.discordToken, undefined);
  page.state.stage = 5;
  page.state.screen = "setup";
  page.render();
  assert.doesNotMatch(page.app.innerHTML, /Discord|Audio Bridge|legacy-secret/);
  assert.match(page.app.innerHTML, /Operator password/);
});

test("launcher renders observed states and only offers supported lifecycle actions", async () => {
  const page = await ui();
  for (const [state, label] of [["running", "FRAME is running"], ["stopped", "FRAME is stopped"], ["starting", "FRAME is starting"], ["needs_attention", "FRAME needs attention"], ["docker_unavailable", "Docker is unavailable"]]) {
    page.acceptLauncherStatus(status({ ...installation, state, detail: label, canStart: state === "stopped", canStop: state === "running" }));
    page.render();
    assert.match(page.app.innerHTML, new RegExp(label));
    assert.equal(/data-stack-action="start_stack"/.test(page.app.innerHTML), state === "stopped");
    assert.equal(/data-stack-action="stop_stack"/.test(page.app.innerHTML), state === "running");
    assert.equal(/data-open-dashboard disabled/.test(page.app.innerHTML), state !== "running");
  }
  page.state.confirmAction = "stop_stack";
  page.render();
  assert.match(page.app.innerHTML, /interrupts active streams, audio, uploads/);
  assert.match(page.app.innerHTML, /configuration and data are retained/);
  page.state.screen = "my-setup";
  page.render();
  assert.ok(page.app.innerHTML.includes(defaults.installRoot));
  assert.ok(page.app.innerHTML.includes(defaults.dataRoot));
  assert.match(page.app.innerHTML, /Docker stores container images separately/);
  assert.match(page.app.innerHTML, /frame-portal/);
});

test("lifecycle uses the observed result and failures require a fresh check", async () => {
  let fail = false;
  const page = await ui({
    get_launcher_status: async () => status({ ...installation, state: "stopped", canStart: true }),
    start_stack: async ({ installRoot }) => {
      assert.equal(installRoot, defaults.installRoot);
      if (fail) throw new Error("Docker connection lost");
      return status({ ...installation, state: "needs_attention", detail: "One service failed to start." });
    },
  });
  await page.runLauncherAction("start_stack");
  assert.equal(page.state.launcher.installations[0].state, "needs_attention");
  assert.match(page.app.innerHTML, /One service failed/);
  page.acceptLauncherStatus(status({ ...installation, state: "stopped", canStart: true }));
  fail = true;
  await page.runLauncherAction("start_stack");
  assert.match(page.state.launcherError, /Docker connection lost/);
  assert.match(page.app.innerHTML, /Recheck its state before retrying/);
  const attempted = page.calls.filter(({ command }) => command === "start_stack").length;
  await page.runLauncherAction("start_stack");
  assert.equal(page.calls.filter(({ command }) => command === "start_stack").length, attempted);
  await page.refreshLauncherStatus();
  assert.equal(page.state.launcherError, "");
  page.acceptLauncherStatus({ ...status({ ...installation, canStart: true }), busy: true });
  await page.runLauncherAction("start_stack");
  assert.equal(page.calls.filter(({ command }) => command === "start_stack").length, attempted);
});

test("status events leave wizard and preference inputs and readiness intact", async () => {
  const page = await ui();
  page.state.screen = "setup";
  page.state.stage = 5;
  page.state.preflight = good;
  page.state.credentials.portalPassword = "typed-secret";
  page.render();
  const markup = page.app.innerHTML;
  page.events["launcher-status"]({ payload: status() });
  assert.equal(page.app.innerHTML, markup);
  assert.equal(page.state.preflight, good);
  assert.equal(page.state.credentials.portalPassword, "typed-secret");
  page.state.screen = "preferences";
  page.render();
  const prefsMarkup = page.app.innerHTML;
  page.events["launcher-status"]({ payload: status({ ...installation, state: "stopped" }) });
  assert.equal(page.app.innerHTML, prefsMarkup);
});

test("fresh Quick clears custom networking and hybrid-only selections; reconfiguration preserves them", async () => {
  const page = await ui();
  const configure = () => {
    page.state.deploymentMode = "HYBRID";
    page.state.publicHostname = "frame.example.com";
    page.state.ports.edge = 8181;
    page.state.credentials.tunnelToken = "temporary-tunnel-token";
    page.state.selectedServices["frame-belabox-manager"] = true;
    page.state.advancedSettings.PUBLIC_RELAY_HOST = "relay.example.com";
  };
  configure();
  page.state.existingInstall = false;
  page.selectSetupMode("quick");
  assert.equal(page.state.deploymentMode, "LAN");
  assert.equal(page.state.publicHostname, "");
  assert.equal(page.state.credentials.tunnelToken, "");
  assert.equal(page.state.ports.edge, 80);
  assert.equal(page.state.selectedServices["frame-belabox-manager"], false);
  assert.equal(page.state.advancedSettings.PUBLIC_RELAY_HOST, "");
  configure();
  page.state.existingInstall = true;
  page.selectSetupMode("quick");
  assert.equal(page.state.deploymentMode, "HYBRID");
  assert.equal(page.state.publicHostname, "frame.example.com");
  assert.equal(page.state.ports.edge, 8181);
  assert.equal(page.state.selectedServices["frame-belabox-manager"], true);
});

test("setup mode buttons announce the selected choice", async () => {
  const page = await ui();
  page.state.screen = "setup";
  page.state.stage = 1;
  page.selectSetupMode("guided");
  assert.match(page.app.innerHTML, /data-mode="guided" type="button" aria-pressed="true"/);
  assert.match(page.app.innerHTML, /data-mode="quick" type="button" aria-pressed="false"/);
  page.selectSetupMode("quick");
  assert.match(page.app.innerHTML, /data-mode="quick" type="button" aria-pressed="true"/);
  assert.match(page.app.innerHTML, /data-mode="guided" type="button" aria-pressed="false"/);
});

test("data folder choice cannot change the managed deployment or relocate an existing install", async () => {
  const page = await ui({});
  page.state.existingInstall = false;
  page.beginSetup();
  assert.equal(page.state.installRoot, defaults.installRoot);
  assert.equal(page.state.dataRoot, defaults.dataRoot);
  await page.chooseFolder();
  assert.equal(page.state.dataRoot, "E:\\Chosen data");
  assert.equal(page.state.installRoot, defaults.installRoot);
  page.applyLoadedPlan({ ...page.buildPlan(), dataRoot: "F:\\Existing photos" });
  await page.chooseFolder();
  assert.equal(page.state.dataRoot, "F:\\Existing photos");
  assert.equal(page.state.installRoot, defaults.installRoot);
});

test("saved drafts redact credentials and readiness; resuming reloads actual installation paths", async () => {
  const page = await ui({
    get_launcher_status: async () => status(),
    load_install_plan: async () => ({ ...defaults, mode: "guided", selectedServices: ["frame-photo-stage"] }),
  });
  page.state.screen = "setup";
  page.state.stage = 6;
  page.state.credentials = { portalUsername: "operator", portalPassword: "secret-password", tunnelToken: "secret-token" };
  page.state.advancedSettings.UNKNOWN_SECRET = "secret-advanced";
  page.state.preflight = good;
  await page.saveSetupDraft();
  const saved = page.calls.filter(({ command }) => command === "save_draft").at(-1).args.draft;
  assert.equal(saved.stage, 5);
  assert.equal(saved.credentials, undefined);
  assert.equal(saved.preflight, undefined);
  assert.equal(saved.existingInstall, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /secret|operator/);
  page.state.screen = "home";
  page.state.pendingDraft = { ...saved, installRoot: defaults.installRoot, dataRoot: "Z:\\Stale folder", credentials: { portalPassword: "do-not-restore" } };
  await page.continueSetupDraft();
  assert.equal(page.state.screen, "setup");
  assert.equal(page.state.dataRoot, defaults.dataRoot);
  assert.equal(page.state.installRoot, defaults.installRoot);
  assert.equal(page.state.credentials.portalPassword, "");
  assert.equal(page.readinessPassed(), false);
  await page.discardSetupDraft();
  assert.equal(page.state.pendingDraft, null);
});

test("successful installation clears its draft and returns to the observed dashboard home", async () => {
  const page = await ui({
    get_launcher_status: async () => status(),
    apply_install_plan: async () => ({ path: "C:\\managed\\FRAME\\plan.json", dashboardUrl: "http://localhost/dashboard" }),
  });
  page.state.screen = "setup";
  page.state.stage = 6;
  page.state.preflight = good;
  page.state.pendingDraft = { mode: "quick" };
  await page.applyInstall();
  assert.equal(page.state.installStatus, "complete");
  assert.equal(page.state.screen, "home");
  assert.equal(page.state.pendingDraft, null);
  assert.equal(page.state.lastSetupUrl, "http://localhost/dashboard");
  assert.match(page.app.innerHTML, /Launch FRAME Portal/);
  assert.ok(page.calls.some(({ command }) => command === "clear_draft"));
});

test("draft persistence waits for readiness checks and then saves edits made during the check", async () => {
  let finish;
  let checking = false;
  const page = await ui({
    run_preflight: () => { checking = true; return new Promise((resolve) => { finish = resolve; }); },
    save_draft: async () => { assert.equal(checking, false, "Draft writes must not collide with the backend check"); },
  });
  page.state.screen = "setup";
  const pending = page.runPreflight();
  await setImmediate();
  page.state.ports.edge = 8282;
  page.invalidatePreflight();
  checking = false;
  finish(good);
  await pending;
  await setImmediate();
  assert.equal(page.state.preflight, null);
  assert.equal(page.calls.filter(({ command }) => command === "save_draft").at(-1).args.draft.ports.edge, 8282);
});

test("Docker guidance follows the reported host platform and opens the matching official guide", async () => {
  for (const [platform, instructions, guide] of [
    ["darwin", /Docker Desktop for Mac/, "https://docs.docker.com/desktop/setup/install/mac-install/"],
    ["win32", /Docker Desktop for Windows with Linux containers/, "https://docs.docker.com/desktop/setup/install/windows-install/"],
    ["linux", /Docker Engine with the Compose plugin/, "https://docs.docker.com/engine/install/"],
  ]) {
    const page = await ui({
      get_launcher_status: async () => ({ ...status(null), platform, arch: "arm64", hostSupported: true, dockerAvailable: false, dockerIssue: "docker_unavailable" }),
      detect_host: async () => ({ platform, arch: "arm64", hostSupported: true, dockerIssue: "docker_unavailable", checks: [{ label: "Docker readiness", status: "bad", detail: "Docker is stopped." }] }),
    });
    page.state.screen = "setup";
    page.render();
    assert.match(page.app.innerHTML, instructions);
    assert.equal(page.hostReadyForInstall(), false);
    if (platform === "darwin") assert.doesNotMatch(page.app.innerHTML, /Docker Desktop for Windows|x64 \(linux\/amd64\) host/);
    await page.openDockerGuide();
    assert.equal(page.opened.at(-1), guide);
  }
});

test("storage warnings stay advisory and remain visible after starting without background storage checks", async () => {
  const warning = { label: "FRAME data storage", status: "warn", detail: "Network storage; low space. You can continue." };
  const page = await ui({ get_launcher_status: async () => status({ ...installation, state: "stopped", canStart: true }),
    start_stack: async () => ({ ...status(), readiness: { installRoot: defaults.installRoot, checks: [warning] } }),
  });
  page.state.preflight = { checks: [...good.checks, warning] };
  assert.equal(page.readinessPassed(), true);
  await page.runLauncherAction("start_stack");
  assert.match(page.app.innerHTML, /FRAME is running/);
  assert.match(page.app.innerHTML, /Storage warnings from the last setup or start check/);
  assert.match(page.app.innerHTML, /Network storage; low space/);
  page.events["launcher-status"]({ payload: status() });
  assert.match(page.app.innerHTML, /Network storage; low space/);
  assert.equal(page.calls.filter(({ command }) => command === "run_preflight").length, 0);
  page.state.preflight.checks.push({ label: "Storage", status: "bad", detail: "Drive is missing." });
  assert.equal(page.readinessPassed(), false);
});

test("Docker prerequisite errors present specific recovery headings", async () => {
  for (const [dockerIssue, heading] of [["docker_cli_missing", "Docker is not installed"], ["docker_compose_missing", "Docker Compose is unavailable"],
    ["docker_permission_denied", "Docker access is denied"], ["docker_engine_unavailable", "Docker is not reachable"],
    ["unsupported_rootless", "This Docker configuration is not supported"], ["unsupported_docker_socket", "This Docker connection is not supported"]]) {
    const page = await ui({ get_launcher_status: async () => ({ ...status(null), dockerAvailable: false, dockerIssue, detail: "Resolve this Docker prerequisite." }) });
    assert.ok(page.app.innerHTML.includes(`<h1>${heading}</h1>`));
    assert.match(page.app.innerHTML, /Resolve this Docker prerequisite/);
  }
});

test("unsupported hosts and engine architectures stay distinct from Docker being stopped", async () => {
  const page = await ui({
    get_launcher_status: async () => ({ ...status(null), platform: "freebsd", arch: "riscv64", hostSupported: false, hostDetail: "freebsd/riscv64 is not supported.", dockerAvailable: false, dockerIssue: "unsupported_host" }),
    detect_host: async () => ({ platform: "freebsd", arch: "riscv64", hostSupported: false, hostDetail: "freebsd/riscv64 is not supported.", checks: [{ label: "Host platform", status: "bad", detail: "Unsupported platform." }] }),
  });
  assert.match(page.app.innerHTML, /This computer is not supported/);
  assert.doesNotMatch(page.app.innerHTML, /<h1>Docker is unavailable/);
  page.state.screen = "setup";
  page.render();
  assert.equal(page.hostReadyForInstall(), false);
  assert.match(page.app.innerHTML, /freebsd\/riscv64 is not supported/);
  assert.doesNotMatch(page.app.innerHTML, /Docker setup is required before continuing/);
  page.state.screen = "home";
  page.acceptLauncherStatus({ ...status(null), platform: "darwin", arch: "arm64", hostSupported: true, dockerAvailable: false, dockerIssue: "unsupported_engine_architecture", detail: "A native ARM64 engine is required." });
  page.render();
  assert.match(page.app.innerHTML, /This Docker engine is not supported/);
  assert.match(page.app.innerHTML, /native ARM64 engine/);
});

test("Mac login preferences use shell support and Linux explicitly reports no startup support", async () => {
  const page = await ui({
    get_launcher_status: async () => ({ ...status(null), platform: "darwin", arch: "arm64", hostSupported: true }),
    get_launcher_preferences: async () => ({ keepInTray: true, notifications: true, startAtLogin: true, startAtLoginSupported: true, trayAvailable: true }),
  });
  page.state.screen = "preferences";
  page.render();
  assert.match(page.app.innerHTML, /menu bar/);
  assert.match(page.app.innerHTML, /data-preference="startAtLogin" checked\s*\/>/);
  page.acceptLauncherStatus({ ...status(null), platform: "linux", arch: "arm64", hostSupported: true });
  page.state.preferences.startAtLogin = false;
  page.state.preferences.startAtLoginSupported = false;
  page.render();
  assert.match(page.app.innerHTML, /data-preference="startAtLogin"\s+disabled/);
  assert.match(page.app.innerHTML, /Startup at sign-in is not available on Linux/);
});

test("startup checklist follows real health and waits for operation success before the running view", async () => {
  let finish;
  const page = await ui({
    get_launcher_status: async () => status({ ...installation, state: "stopped", canStart: true, canStop: false }),
    start_stack: () => new Promise((resolve) => { finish = resolve; }),
  });
  const pending = page.runLauncherAction("start_stack");
  await setImmediate();
  const services = [
    { name: "frame-portal", status: "running", health: "starting" },
    { name: "frame-auth", status: "running", health: "healthy" },
    { name: "frame-edge", status: "running", health: "none" },
    { name: "frame-gallery", status: "waiting", health: "none" },
  ];
  const emitProgress = (phase, offset, list = services) => page.events["launcher-progress"]({ payload: { installRoot: defaults.installRoot, phase, services: list, observedAt: new Date(Date.now() + offset).toISOString() } });
  emitProgress("starting", 0);
  assert.match(page.app.innerHTML, /2 of 4 containers ready/);
  assert.match(page.app.innerHTML, /container-check waiting" data-container="frame-portal"/);
  assert.match(page.app.innerHTML, /Starting · checking health/);
  assert.match(page.app.innerHTML, /container-check good" data-container="frame-auth"/);
  assert.match(page.app.innerHTML, /Running · no health check/);
  assert.match(page.app.innerHTML, /data-open-dashboard disabled/);
  assert.match(page.app.innerHTML, /data-change-setup disabled/);
  const healthy = services.map((service) => ({ ...service, status: "running", health: service.name === "frame-edge" ? "none" : "healthy" }));
  emitProgress("complete", 10, healthy);
  assert.match(page.app.innerHTML, /<h1>FRAME is starting/);
  assert.match(page.app.innerHTML, /data-open-dashboard disabled/);
  finish(status({ ...installation, services: healthy }));
  await pending;
  assert.match(page.app.innerHTML, /<h1>FRAME is running/);
  assert.match(page.app.innerHTML, /FRAME started · View container checks/);
  assert.match(page.app.innerHTML, /data-open-dashboard >Launch FRAME Portal/);
  assert.match(page.app.innerHTML, /data-stack-action="stop_stack" >Stop FRAME/);
  assert.match(page.app.innerHTML, /data-change-setup >Edit configuration/);
  emitProgress("starting", -1000);
  assert.equal(page.state.startupProgress.phase, "complete");
  page.events["launcher-status"]({ payload: { ...status({ ...installation, services: healthy }), busy: true } });
  assert.match(page.app.innerHTML, /<h1>FRAME is running/, "Later busy operations must not replay a completed startup");
  assert.doesNotMatch(page.app.innerHTML, /<h1>FRAME is starting/);
});

test("tray startup updates Home without replacing setup fields and failed progress stays visible", async () => {
  const page = await ui({ get_launcher_status: async () => status({ ...installation, state: "stopped", canStart: true }) });
  const event = { installRoot: defaults.installRoot, phase: "starting", observedAt: new Date().toISOString(), services: [{ name: "frame-portal", status: "running", health: "unhealthy" }] };
  page.events["launcher-status"]({ payload: { ...status({ ...installation, state: "stopped" }), busy: true } });
  page.events["launcher-progress"]({ payload: event });
  assert.match(page.app.innerHTML, /<h1>FRAME is starting/);
  assert.match(page.app.innerHTML, /container-check bad" data-container="frame-portal"/);
  assert.match(page.app.innerHTML, /Unhealthy/);
  page.state.screen = "setup";
  page.state.stage = 5;
  page.state.preflight = good;
  page.state.credentials.portalPassword = "unsaved-secret";
  page.render();
  const markup = page.app.innerHTML;
  page.events["launcher-progress"]({ payload: { ...event, phase: "failed" } });
  assert.equal(page.app.innerHTML, markup);
  assert.equal(page.state.preflight, good);
  assert.equal(page.state.credentials.portalPassword, "unsaved-secret");
  page.events["launcher-progress"]({ payload: { ...event, phase: "complete" } });
  assert.equal(page.state.startupProgress.phase, "failed", "Late completion cannot overwrite failure even while shell is busy");
  page.state.screen = "home";
  page.events["launcher-status"]({ payload: status({ ...installation, state: "needs_attention" }) });
  assert.match(page.app.innerHTML, /Startup needs attention/);
  page.events["launcher-progress"]({ payload: { ...event, phase: "complete" } });
  assert.equal(page.state.startupProgress.phase, "failed", "late progress cannot clear a finished failure");
  page.events["launcher-progress"]({ payload: { ...event, installRoot: "Z:\\Unrelated FRAME" } });
  assert.equal(page.state.startupProgress.installRoot, defaults.installRoot);
});

test("first installation shows live containers and a failed terminal event cannot become success", async () => {
  let finish;
  const page = await ui({ apply_install_plan: () => new Promise((resolve) => { finish = resolve; }) });
  page.state.screen = "setup";
  page.state.stage = 6;
  page.state.preflight = good;
  const pending = page.applyInstall();
  await setImmediate();
  page.events["launcher-progress"]({ payload: { installRoot: defaults.installRoot, phase: "starting", services: [{ name: "frame-portal", status: "created", health: "none" }] } });
  assert.match(page.app.innerHTML, /Created · waiting to start/);
  assert.equal(page.state.screen, "setup");
  page.events["launcher-progress"]({ payload: { installRoot: defaults.installRoot, phase: "failed", services: [{ name: "frame-portal", status: "exited", health: "none" }] } });
  finish({ path: "plan.json", dashboardUrl: "http://localhost/dashboard" });
  await pending;
  assert.equal(page.state.screen, "setup");
  assert.equal(page.state.installStatus, "failed");
  assert.match(page.app.innerHTML, /Not ready · Stopped/);
  assert.equal(page.readinessPassed(), false);
});

test("Edit configuration reloads the installed choices and Portal uses localhost at the configured port", async () => {
  const page = await ui({
    get_launcher_status: async () => status({ ...installation, dashboardUrl: "http://192.168.1.20:8181/dashboard" }),
    load_install_plan: async () => ({ ...defaults, mode: "advanced", deploymentMode: "HYBRID", publicHostname: "public.example", selectedServices: ["frame-audio-relay"], ports: { edge: 8181 } }),
  });
  assert.equal(page.portalUrl(), "http://localhost:8181/dashboard");
  await page.openSetup({ url: page.portalUrl() });
  assert.equal(page.opened.at(-1), "http://localhost:8181/dashboard");
  assert.equal(page.portalUrl({ dashboardUrl: "http://localhost:80/dashboard" }), "http://localhost/dashboard");
  await page.reconfigureInstall(defaults.installRoot);
  assert.equal(page.state.screen, "setup");
  assert.equal(page.state.stage, 5);
  assert.equal(page.state.existingInstall, true);
  assert.equal(page.state.installRoot, defaults.installRoot);
  assert.equal(page.state.dataRoot, defaults.dataRoot);
  assert.equal(page.state.ports.edge, 8181);
  assert.equal(page.state.deploymentMode, "HYBRID");
  assert.equal(page.state.publicHostname, "public.example");
  assert.equal(page.state.selectedServices["frame-audio-relay"], true);
});

test("installation remains on its failure view if final status cannot confirm running", async () => {
  for (const outcome of ["unavailable", "needs_attention"]) {
    let applied = false;
    const page = await ui({
      get_launcher_status: async () => {
        if (applied && outcome === "unavailable") throw new Error("Final Docker check failed");
        return status({ ...installation, state: applied ? outcome : "stopped", detail: "FRAME still needs attention." });
      },
      apply_install_plan: async () => { applied = true; return { path: "plan.json", dashboardUrl: "http://localhost/dashboard" }; },
    });
    page.state.screen = "setup";
    page.state.stage = 6;
    page.state.preflight = good;
    page.state.pendingDraft = { mode: "quick" };
    await page.applyInstall();
    assert.equal(page.state.installStatus, "failed");
    assert.equal(page.state.screen, "setup");
    assert.ok(page.state.pendingDraft, "Unconfirmed installation must not silently discard its draft");
    assert.equal(page.readinessPassed(), false);
    assert.doesNotMatch(page.app.innerHTML, /FRAME started · View container checks/);
  }
});

const updateResult = () => ({ checkedAt: "2026-09-30T12:00:00Z", installRoot: defaults.installRoot,
  launcher: { currentVersion: "1.0.0", tag: "v1.1.0", version: "1.1.0", available: true, notes: "<img src=x onerror=alert(1)>",
    url: "https://github.com/gall-levi-code/Syronius_FRAME/releases/tag/v1.1.0", downloadUrl: "https://github.com/gall-levi-code/Syronius_FRAME/releases/download/v1.1.0/FRAME-Setup-1.1.0-win-x64.exe" },
  frame: { currentVersion: "1.0.0", currentCommit: "a".repeat(40), tag: "v1.1.0", version: "1.1.0", commit: "b".repeat(40), available: true, eligible: true,
    notes: "FRAME improvements", url: "https://github.com/gall-levi-code/Syronius_FRAME/releases/tag/v1.1.0" } });

test("manual update checks show separate versions and escaped release notes without applying an update", async () => {
  const page = await ui({ get_launcher_status: async () => ({ ...status({ ...installation, canRepair: true, canUpdate: true }), launcherVersion: "1.0.0" }),
    check_updates: async () => updateResult() });
  page.state.screen = "updates";
  await page.checkForUpdates();
  assert.match(page.app.innerHTML, /FRAME Launcher/);
  assert.match(page.app.innerHTML, /Installed version: <strong>1.0.0/);
  assert.match(page.app.innerHTML, /Installed release: <strong>1.0.0/);
  assert.match(page.app.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(page.app.innerHTML, /<img src=x/);
  assert.match(page.app.innerHTML, /Download launcher installer/);
  assert.match(page.app.innerHTML, /data-stack-action="update_stack" >/);
  assert.ok(!page.calls.some((call) => ["update_stack", "repair_stack"].includes(call.command)));
  page.acceptLauncherStatus({ ...status(), updates: null });
  page.render();
  assert.equal(page.state.updates, null);
  assert.doesNotMatch(page.app.innerHTML, /data-stack-action="update_stack"/);
});

test("periodic checks are a saved preference and update notifications preserve setup drafts", async () => {
  const page = await ui({ set_launcher_preferences: async ({ preferences }) => preferences });
  page.state.screen = "preferences";
  page.render();
  assert.match(page.app.innerHTML, /data-preference="checkUpdatesAutomatically"/);
  assert.match(page.app.innerHTML, /once a day/);
  await page.saveLauncherPreference("checkUpdatesAutomatically", true);
  assert.equal(page.state.preferences.checkUpdatesAutomatically, true);
  assert.equal(page.calls.at(-1).args.preferences.startAtLogin, false);
  page.state.screen = "setup"; page.state.ports.edge = 8181; page.state.preflight = good;
  const before = page.app.innerHTML;
  page.events["launcher-updates"]({ payload: updateResult() });
  assert.equal(page.app.innerHTML, before); assert.equal(page.state.ports.edge, 8181); assert.equal(page.state.preflight, good);
  const preview = await ui(undefined, false);
  for (const command of ["check_updates", "update_stack", "repair_stack"]) await assert.rejects(preview.mockInvoke(command, {}), /disabled in browser preview/);
});

test("FRAME update confirmation names interruption and sends only the checked tag for the selected installation", async () => {
  const managed = { ...installation, canRepair: true, canUpdate: true };
  const page = await ui({ get_launcher_status: async () => status(managed), update_stack: async () => ({ ...status(managed), updates: null,
    maintenance: { action: "update", success: true, detail: "FRAME updated; stopped services remain stopped." } }) });
  page.state.screen = "updates";
  await page.runLauncherAction("update_stack");
  assert.ok(!page.calls.some((call) => call.command === "update_stack"));
  page.state.updates = updateResult(); page.state.confirmAction = "update_stack"; page.render();
  assert.match(page.app.innerHTML, /Update FRAME to 1.1.0/); assert.match(page.app.innerHTML, /may be interrupted/);
  assert.match(page.app.innerHTML, /deliberately stopped stay stopped/);
  page.acceptLauncherStatus(status({ ...managed, canUpdate: false })); page.render();
  assert.match(page.app.innerHTML, /data-confirm-action disabled/);
  await page.runLauncherAction("update_stack");
  assert.ok(!page.calls.some((call) => call.command === "update_stack"));
  page.acceptLauncherStatus(status(managed));
  await page.runLauncherAction("update_stack");
  const request = page.calls.find((call) => call.command === "update_stack");
  assert.equal(request.args.releaseTag, "v1.1.0"); assert.equal(request.args.installRoot, defaults.installRoot);
  assert.match(page.app.innerHTML, /Operation completed/);
  assert.equal(page.state.updates, null);
});

test("failed update checks and recovered maintenance failures remain distinct from success", async () => {
  const page = await ui({ get_launcher_status: async () => status({ ...installation, canRepair: true }),
    check_updates: async () => { throw new Error("Connection unavailable"); },
    repair_stack: async () => ({ ...status({ ...installation, canRepair: true }), maintenance: {
      action: "repair", success: false, recovered: true, detail: "Repair failed; the original deployment was restored." } }) });
  page.state.screen = "updates"; page.state.updates = updateResult();
  await page.checkForUpdates();
  assert.match(page.app.innerHTML, /Connection unavailable/); assert.match(page.app.innerHTML, /data-stack-action="update_stack" disabled/);
  await page.runLauncherAction("repair_stack");
  assert.match(page.app.innerHTML, /Operation failed; previous deployment recovered/);
  page.events["launcher-status"]({ payload: status(installation) });
  assert.match(page.app.innerHTML, /Repair failed; the original deployment was restored/);
});

test("support reports render as text and copy/save request a fresh native report without sending rendered content", async () => {
  const exports = [];
  const page = await ui({ get_diagnostics: () => ({ schemaVersion: 1, text: "<script>text only</script>" }) }, true, undefined,
    async (kind) => { exports.push(kind); return { report: { schemaVersion: 1, fresh: true }, completed: kind === "copy" }; });
  page.state.screen = "support";
  await page.supportAction("preview");
  assert.match(page.app.innerHTML, /&lt;script&gt;/);
  assert.ok(!page.app.innerHTML.includes("<script>"));
  await page.supportAction("copy");
  assert.deepEqual(exports, ["copy"]);
  assert.equal(page.state.supportReport.fresh, true);
  assert.match(page.state.supportMessage, /copied/);
  await page.supportAction("save");
  assert.match(page.state.supportMessage, /canceled/);
  const preview = await ui(undefined, false);
  await preview.supportAction("copy");
  assert.ok(!preview.calls.some(({ command }) => command === "get_diagnostics"));
});

test("backup and removal require explicit confirmation and current eligibility; restore retains original destinations", async () => {
  const eligible = { ...installation, canBackup: true, canRemove: true };
  const summary = { workspace: defaults.installRoot, dataRoot: defaults.dataRoot, fileCount: 3, totalBytes: 123, createdAt: "2026-09-30T12:00:00Z" };
  const page = await ui({ inspect_backup: () => summary,
    backup_stack: () => ({ ...status(eligible), protection: { action: "backup", success: true, detail: "Backup completed." } }),
    remove_stack: () => ({ ...status(eligible), protection: { action: "remove", success: true, detail: "Containers removed. Data retained." } }),
    restore_backup: () => ({ ...status(eligible), protection: { action: "restore", success: true, detail: "Restored. Use Repair." } }),
  });
  page.state.launcher = status(eligible); page.state.screen = "backups"; page.state.launcherLoading = false;
  await page.chooseProtectionFolder("backup");
  assert.equal(page.state.backupRoot, "E:\\Chosen data");
  await page.protectionAction("backup_stack");
  assert.ok(!page.calls.some(({ command }) => command === "backup_stack"));
  page.state.confirmAction = "backup_stack"; page.render();
  assert.match(page.app.innerHTML, /Large libraries can take a while/);
  await page.protectionAction("backup_stack");
  assert.equal(page.calls.find(({ command }) => command === "backup_stack").args.confirmed, true);
  assert.equal(page.state.backupRoot, "");
  page.state.confirmAction = "remove_stack"; page.state.launcher.installations[0].canRemove = false;
  await page.protectionAction("remove_stack");
  assert.ok(!page.calls.some(({ command }) => command === "remove_stack"));
  await page.chooseProtectionFolder("restore");
  assert.equal(page.state.restoreBackup.workspace, defaults.installRoot);
  page.state.confirmAction = "restore_backup"; page.render();
  assert.match(page.app.innerHTML, /Both destinations must be empty/);
  await page.protectionAction("restore_backup");
  const sent = page.calls.find(({ command }) => command === "restore_backup").args;
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), { confirmed: true, backupRoot: "E:\\Chosen data" });
  assert.match(page.state.protection.detail, /Use Repair/);
});

test("backup failures remain visible and browser preview cannot dispatch protection commands", async () => {
  const page = await ui({ backup_stack: () => { throw new Error("Storage disconnected"); } });
  page.state.launcher = status({ ...installation, canBackup: true }); page.state.screen = "backups";
  page.state.backupRoot = "E:\\Backup"; page.state.confirmAction = "backup_stack";
  await page.protectionAction("backup_stack");
  assert.match(page.state.protectionError, /Storage disconnected/);
  assert.equal(page.state.launcherAction, "");
  assert.match(page.app.innerHTML, /role="alert"/);
  const preview = await ui(undefined, false);
  for (const command of ["backup_stack", "restore_backup", "remove_stack", "inspect_backup"]) await assert.rejects(preview.mockInvoke(command, {}), /disabled in browser preview/);
});

test("status rerender preserves keyboard focus on an enabled matching control", async () => {
  const page = await ui();
  let focused = 0;
  page.document.activeElement = { tagName: "BUTTON", dataset: { screen: "support" } };
  page.app.querySelectorAll = () => [{ tagName: "BUTTON", dataset: { screen: "support" }, focus: () => focused++ }];
  page.render();
  assert.equal(focused, 1);
  page.app.querySelectorAll = () => [{ tagName: "BUTTON", disabled: true, dataset: { screen: "support" }, focus: () => focused++ }];
  page.render();
  assert.equal(focused, 1, "disabled replacement must not receive focus");
  page.document.activeElement = { tagName: "BODY" };
  page.app.querySelectorAll = () => [{ tagName: "BUTTON", dataset: { screen: "support" }, focus: () => focused++ }];
  page.render();
  assert.equal(focused, 2, "focus returns after a temporary busy state enables the control again");
});
