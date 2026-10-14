import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Website tool icons preserve ready links, offline states, and safe unknown tools", async () => {
  const source = await readFile(new URL("../public/portal.js", import.meta.url), "utf8");
  const elements = { toolsGrid: {} };
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const context = vm.createContext({ elements, escapeHtml: escape, escapeAttribute: escape, getToolLinkGroups: () => [] });
  vm.runInContext(source.slice(source.indexOf("const TOOL_ICONS ="), source.indexOf("async function refreshPortalConfig(")), context);
  const tool = { name: "Tool", description: "Description", route: "/audio/admin", access: "lan", accessible: true, readiness: "ready" };
  context.renderTools([
    { ...tool, id: "audio" },
    { ...tool, id: "today", readiness: "offline" },
    { ...tool, id: 'unknown" onclick="bad', name: "<script>" },
    { ...tool, id: "constructor" },
  ]);
  const cards = elements.toolsGrid.innerHTML.split("<article").slice(1);
  assert.match(cards[0], /data-tool="audio"/);
  assert.match(cards[0], /aria-hidden="true" focusable="false"/);
  assert.match(cards[0], /class="tool-card-target" href="\/audio\/admin"/);
  assert.match(cards[1], /disabled readiness-offline/);
  assert.match(cards[1], /<span class="tool-state">Offline<\/span>/);
  assert.doesNotMatch(cards[1], /tool-card-target/);
  assert.doesNotMatch(cards[2], /<svg|<script>|data-tool="unknown"/);
  assert.doesNotMatch(cards[3], /<svg|function Object/);
});
