import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

const source = await readFile(new URL("../apps/frame-setup/src/main.js", import.meta.url), "utf8");
const good = { checks: [{ label: "Host ports", status: "good", detail: "Available" }] };

async function ui(invoke = async () => good, desktop = true) {
  const app = { innerHTML: "", querySelectorAll: () => [] };
  const context = vm.createContext({
    window: desktop ? { frameDesktop: { invoke, listen: () => () => {} } } : {},
    document: {
      querySelector: (selector) => selector === "#app" ? app : null,
      querySelectorAll: () => [], documentElement: { style: { setProperty() {} } },
    },
  });
  vm.runInContext(`${source}\nglobalThis.ui = {state, invalidatePreflight, runPreflight, readinessPassed, applyInstall, portValidation, photoFtpHostValidation, exposedPortsForSelection, buildPlan, applyLoadedPlan, mockInvoke, render};`, context);
  await setImmediate();
  context.ui.state.existingInstall = true;
  return { ...context.ui, app };
}

test("editing a pending preflight rejects its stale result; a failed retry clears success", async () => {
  let complete;
  const page = await ui((command) => command === "detect_host" ? Promise.resolve(good) : new Promise((resolve) => { complete = resolve; }));
  const pending = page.runPreflight();
  assert.equal(page.state.preflightRunning, true);
  assert.equal(page.readinessPassed(), false);
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
