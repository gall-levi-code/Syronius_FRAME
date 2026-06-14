import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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

test("portal routes and implemented Compose profiles stay aligned with the registry", async () => {
  const [portalStackConfig, composeTemplate] = await Promise.all([
    readFile("services/frame-portal/src/stackConfig.ts", "utf8"),
    readFile("installer/templates/docker-compose.yml", "utf8"),
  ]);
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.ok(portalStackConfig.includes(`${name}: "${route}"`), `Portal route ${name} drifted`);
  }
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

test("implemented capability profiles are stable and ordered", () => {
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  for (const name of IMPLEMENTED_CAPABILITIES) capabilities[name] = true;
  assert.deepEqual(computeComposeProfiles(capabilities, "LAN"), [
    "audio-bridge",
    "audio-monitor",
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

test("prefix normalization removes duplicates and child routes", () => {
  assert.deepEqual(normalizePrefixes(["/today/viewer", "/today", "/today", "/status"]), [
    "/today",
    "/status",
  ]);
});

async function assertSameFile(left, right) {
  const [leftContents, rightContents] = await Promise.all([
    readFile(left, "utf8"),
    readFile(right, "utf8"),
  ]);
  assert.equal(rightContents, leftContents, `${right} drifted from ${left}`);
}
