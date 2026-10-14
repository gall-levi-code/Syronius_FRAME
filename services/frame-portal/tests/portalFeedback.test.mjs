import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/portal.js", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../public/frame-theme.js", import.meta.url), "utf8");
const functions = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test("Portal healthy polling only clears its connection issue and retains full unavailable-data details", () => {
  const issueCalls = [];
  const clearCalls = [];
  let notified = false;
  const context = vm.createContext({
    elements: { footerState: {} }, refreshDashboard() {},
    window: { FrameFeedback: {
      issue: (...args) => issueCalls.push(args), clearIssue: (...args) => clearCalls.push(args),
      notify() { notified = true; },
    } },
  });
  vm.runInContext(functions("function setConnected(", "function scheduleRefresh("), context);
  context.setConnected();
  assert.equal(notified, false);
  assert.equal(issueCalls.length, 0);
  const detail = "Status host unavailable\n" + "Full storage diagnostic ".repeat(30);
  context.setDisconnected(new Error(detail));
  context.setDisconnected(new Error(detail));
  assert.deepEqual(issueCalls.map(([key]) => key), ["portal-connection", "portal-connection"]);
  assert.equal(issueCalls[0][1].target, ".portal-nav");
  assert.ok(issueCalls[0][1].message.endsWith(detail));
  assert.equal(issueCalls[0][1].action.label, "Retry");
  context.setConnected();
  assert.deepEqual(clearCalls.map(([key]) => key), ["portal-connection", "portal-connection"]);
  assert.equal(notified, false, "The helper decides whether recovery needs a notice; healthy polls cannot toast");
});

test("Restart failure remains beside that service, and only a successful retry announces completion", async () => {
  const issues = new Map();
  const notices = [];
  const button = { disabled: false, textContent: "Restart" };
  let failing = true;
  const context = vm.createContext({
    CSS: { escape: (value) => value }, refreshStatus() {},
    async fetchJson() {
      assert.equal(button.disabled, true);
      assert.equal(button.textContent, "Restarting…");
      if (failing) throw new Error("Docker refused the restart: full diagnostic");
      return {};
    },
    showToast: (message) => notices.push(message),
    window: { confirm: () => true, setTimeout() {}, FrameFeedback: {
      issue: (key, details) => issues.set(key, details), clearIssue: (key) => issues.delete(key),
    } },
  });
  vm.runInContext(functions("async function restartService(", "function openLogs("), context);
  await context.restartService("frame-today", button);
  assert.equal(issues.get("restart-frame-today").target, '[data-restart="frame-today"]');
  assert.equal(issues.get("restart-frame-today").message, "Docker refused the restart: full diagnostic");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Restart");
  assert.deepEqual(notices, []);
  failing = false;
  await context.restartService("frame-today", button);
  assert.equal(issues.size, 0);
  assert.deepEqual(notices, ["frame-today restart requested."]);
});

test("Theme save optionally exposes failures without changing other tools' local fallback", async () => {
  const saveSource = themeSource.slice(themeSource.indexOf("async function save("), themeSource.indexOf("async function requestTheme("));
  const context = vm.createContext({
    state: { mode: "night" }, normalizeState: (value) => value, apply: (value) => value,
    async requestTheme() { throw new Error("Theme request failed: 503"); },
  });
  vm.runInContext(saveSource, context);
  let reported;
  const draft = await context.save({ mode: "day" }, { onError: (error) => { reported = error.message; } });
  assert.equal(reported, "Theme request failed: 503");
  assert.equal(draft.mode, "day");
  assert.equal((await context.save({ mode: "day" })).mode, "day", "Existing callers retain their local fallback");
});

test("Portal marks failed theme persistence, and Retry restores the selected draft after an unrelated refresh", async () => {
  const issues = new Map();
  const original = { mode: "day", profileId: "custom", customProfiles: [{ id: "custom" }] };
  let failing = true;
  const saved = [];
  const context = vm.createContext({
    themeSettings: original, selectedThemeProfile: () => ({ id: "custom" }), renderThemeControls() {},
    localStorage: { setItem() {} },
    THEME_MODE_KEY: "mode", THEME_PROFILE_ID_KEY: "profileId", THEME_CUSTOM_PROFILES_KEY: "custom", THEME_PROFILE_KEY: "profile",
    window: { FrameTheme: { async save(value, options) {
      saved.push(value);
      if (failing) options.onError(new Error("Theme store unavailable: full error"));
      return value;
    } }, FrameFeedback: {
      issue: (key, details) => issues.set(key, details), clearIssue: (key) => issues.delete(key),
    } },
  });
  vm.runInContext(functions("async function persistThemeSettings(", "function renderThemeControls("), context);
  context.applyThemeSettings = () => context.persistThemeSettings();
  assert.equal(await context.persistThemeSettings(), false);
  assert.equal(context.themeSettings, original, "A failed save cannot discard the local selection");
  const problem = issues.get("theme-save");
  assert.ok(problem.message.endsWith("Theme store unavailable: full error"));
  assert.equal(problem.target, ".portal-footer");
  context.themeSettings = { mode: "night", profileId: "frame-blue", customProfiles: [] };
  failing = false;
  assert.equal(await problem.action.onClick(), true);
  assert.equal(saved[1].profileId, "custom");
  assert.equal(saved[1].mode, "day");
  assert.equal(issues.size, 0);
});
