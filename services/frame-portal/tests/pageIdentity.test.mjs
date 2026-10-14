import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Portal navigation sets each page identity, keeps one view active, and preserves Pipeline access restrictions", async () => {
  const source = await readFile(new URL("../public/portal.js", import.meta.url), "utf8");
  const pages = source.slice(source.indexOf("const PORTAL_PAGES ="), source.indexOf("const builtInThemeProfiles ="));
  const views = ["dashboard", "status", "pipeline", "theme"].map((name) => ({ dataset: { portalView: name } }));
  const links = views.map((view) => ({
    dataset: { portalNav: view.dataset.portalView },
    classList: { toggle(_class, active) { this.active = active; } },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  }));
  const elements = { pageTitle: {}, pageDescription: {}, pageIcon: {} };
  let settingsLoads = 0;
  let replacement;
  const window = { location: { pathname: "/dashboard" }, history: { replaceState(_state, _title, path) { replacement = path; } } };
  const document = {
    body: { dataset: {} },
    querySelectorAll: (selector) => selector === "[data-portal-view]" ? views : links,
  };
  const context = vm.createContext({
    elements, window, document, portalConfig: { pipeline_enabled: true, access_context: "lan" }, currentView: "dashboard",
    loadPipelineSettings() { settingsLoads += 1; },
  });
  vm.runInContext(pages + source.slice(source.indexOf("function pipelineVisible("), source.indexOf("async function loadPipelineSettings(")), context);
  const expected = [
    ["/dashboard", "FRAME Portal", "portal"],
    ["/status", "System Status", "status"],
    ["/pipeline", "Photo Pipeline", "pipeline"],
    ["/theme", "Theme", "theme"],
  ];
  for (const [route, title, tool] of expected) {
    window.location.pathname = route;
    context.initializeView();
    assert.equal(elements.pageTitle.textContent, title);
    assert.equal(document.body.dataset.frameTool, tool);
    assert.ok(elements.pageDescription.textContent.length > 10);
    assert.match(elements.pageIcon.innerHTML, /<path|<rect/);
    assert.equal(document.title, tool === "portal" ? title : `FRAME ${title}`);
    assert.equal(views.filter((view) => !view.hidden).length, 1);
    assert.equal(links.filter((link) => link["aria-current"] === "page").length, 1);
  }
  assert.equal(settingsLoads, 1);
  for (const config of [
    { pipeline_enabled: true, access_context: "public" },
    { pipeline_enabled: false, access_context: "lan" },
  ]) {
    context.portalConfig = config;
    window.location.pathname = "/pipeline";
    context.initializeView();
    assert.equal(replacement, "/dashboard");
    assert.equal(elements.pageTitle.textContent, "FRAME Portal");
    assert.equal(document.body.dataset.frameTool, "portal");
  }
  assert.equal(settingsLoads, 1, "An unavailable Pipeline must never load settings");
});
