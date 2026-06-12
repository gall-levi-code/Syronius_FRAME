import { readFile } from "node:fs/promises";

const registryUrl = new URL("../config/frame-services.json", import.meta.url);

export const SERVICE_REGISTRY = JSON.parse(await readFile(registryUrl, "utf8"));
export const CAPABILITIES = Object.freeze(Object.keys(SERVICE_REGISTRY.capabilities));
export const IMPLEMENTED_CAPABILITIES = new Set(
  CAPABILITIES.filter((name) => SERVICE_REGISTRY.capabilities[name].implemented),
);
export const ROUTES = Object.freeze({ ...SERVICE_REGISTRY.routes });
export const PUBLIC_PREFIXES = Object.freeze(
  SERVICE_REGISTRY.publicRoutes.map((route) => route.prefix),
);
export const PUBLIC_PREFIX_CAPABILITIES = Object.freeze(
  Object.fromEntries(SERVICE_REGISTRY.publicRoutes.map((route) => [route.prefix, route.capability])),
);
export const FORBIDDEN_PUBLIC_PREFIXES = Object.freeze([
  ...SERVICE_REGISTRY.forbiddenPublicPrefixes,
]);

export function enforceDependencies(capabilities) {
  const warnings = [];
  for (const [name, definition] of Object.entries(SERVICE_REGISTRY.capabilities)) {
    if (!capabilities[name]) continue;

    const missing = definition.requires.filter((dependency) => !capabilities[dependency]);
    if (missing.length > 0) {
      capabilities[name] = false;
      warnings.push(`${name} was disabled because ${missing.join(", ")} is disabled.`);
      continue;
    }

    if (
      definition.requiresAny.length > 0 &&
      !definition.requiresAny.some((dependency) => capabilities[dependency])
    ) {
      capabilities[name] = false;
      warnings.push(
        `${name} was disabled because none of ${definition.requiresAny.join(", ")} is enabled.`,
      );
    }
  }
  return warnings;
}

export function computeComposeProfiles(capabilities, mode) {
  const enabledProfiles = new Set();
  for (const [name, definition] of Object.entries(SERVICE_REGISTRY.capabilities)) {
    if (!capabilities[name]) continue;
    for (const profile of definition.profiles) enabledProfiles.add(profile);
  }
  if (mode === "HYBRID") enabledProfiles.add("hybrid");
  return SERVICE_REGISTRY.profileOrder.filter((profile) => enabledProfiles.has(profile));
}

export function computeEffectivePublicPrefixes(config, onWarning = () => undefined) {
  if (config.mode !== "HYBRID") return [];
  const effective = [];
  for (const prefix of config.public_route_prefixes) {
    if (FORBIDDEN_PUBLIC_PREFIXES.some((forbidden) => pathMatchesPrefix(prefix, forbidden))) {
      onWarning(`${prefix} is LAN-only and was removed from Hybrid exposure.`);
      continue;
    }
    const capability = PUBLIC_PREFIX_CAPABILITIES[prefix];
    if (capability === undefined || (capability && !config.capabilities[capability])) continue;
    effective.push(prefix);
  }
  return normalizePrefixes(effective);
}

export function normalizePrefixes(prefixes) {
  const sorted = [...new Set(prefixes)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return sorted.filter(
    (prefix, index) =>
      !sorted.slice(0, index).some((parent) => pathMatchesPrefix(prefix, parent)),
  );
}

export function pathMatchesPrefix(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}/`);
}
