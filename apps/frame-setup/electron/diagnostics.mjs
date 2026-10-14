// Support reports deliberately contain only these fields and values. Never append
// raw logs, inspection output, settings, paths, URLs, hostnames or error messages.
const SERVICES = new Set(["frame-auth", "frame-audio", "frame-belabox-manager", "frame-gallery", "frame-ingest-video",
  "frame-overlays", "frame-photo-ftp", "frame-photo-upload", "frame-pipeline-photos", "frame-portal", "frame-streams", "frame-today",
  "frame-edge", "frame-docker-proxy", "frame-public-gateway", "frame-tunnel"]);
const STATES = new Set(["running", "stopped", "starting", "needs_attention", "docker_unavailable"]);
const SERVICE_STATES = new Set(["running", "created", "exited", "restarting", "paused", "dead", "removing", "missing", "waiting", "ambiguous", "unknown"]);
const HEALTH = new Set(["healthy", "unhealthy", "starting", "none", "unknown"]);
const MESSAGES = Object.freeze({
  unsupported_host: "The operating system or processor is unsupported.",
  docker_cli_missing: "The Docker command-line tool was not found.",
  docker_compose_missing: "Docker Compose was not found.",
  docker_compose_unavailable: "Docker Compose could not be used.",
  docker_engine_unavailable: "The local Docker engine could not be reached or inspected.",
  docker_permission_denied: "Permission to access Docker was denied.",
  docker_unavailable: "Docker readiness could not be verified.",
  remote_engine: "The selected Docker engine is remote.",
  unsupported_engine_os: "The Docker engine does not run Linux containers.",
  unsupported_engine_architecture: "The Docker engine architecture is unsupported.",
  unsupported_rootless: "Rootless Docker is unsupported by this deployment.",
  unsupported_docker_socket: "The selected Docker socket is unsupported.",
  inspection_failed: "FRAME status could not be fully inspected.",
  recovery_required: "An interrupted deployment requires recovery.",
  installation_needs_attention: "An installation or service requires attention.",
  service_unhealthy: "An installed service reports unhealthy.",
  service_missing: "A configured service container is missing.",
  unsupported_service: "An unrecognized service name was omitted from the report.",
  report_limited: "Some entries were omitted to keep the support report bounded.",
});
const numericVersion = (value) => typeof value === "string" && value.length <= 128 ? /^v?(\d{1,9}(?:\.\d{1,9}){1,3})(?=$|[-+])/.exec(value)?.[1] || null : null;
const releaseTag = (value) => typeof value === "string" && /^v?\d{1,9}\.\d{1,9}\.\d{1,9}(?:-release)?$/.test(value) ? value : null;
const commit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
const pick = (value, allowed, fallback = "unknown") => allowed.has(value) ? value : fallback;

export function buildDiagnostics({ status = {}, engineInfo, launcherVersion, platform, arch, osRelease, inspectionFailed = false } = {}) {
  const errors = new Set();
  const dockerIssue = status.dockerIssue && Object.hasOwn(MESSAGES, status.dockerIssue) ? status.dockerIssue
    : status.dockerAvailable === true ? null : inspectionFailed ? "inspection_failed" : "docker_unavailable";
  if (dockerIssue) errors.add(dockerIssue);
  if (inspectionFailed) errors.add("inspection_failed");
  const rawInstallations = Array.isArray(status.installations) ? status.installations : [];
  if (rawInstallations.length > 16) errors.add("report_limited");
  const installations = rawInstallations.slice(0, 16).map((entry, index) => {
    const issues = new Set(), services = new Map();
    const rawServices = Array.isArray(entry?.services) ? entry.services : [];
    if (rawServices.length > 64) errors.add("report_limited");
    for (const service of rawServices.slice(0, 64)) {
      if (!SERVICES.has(service?.name)) { issues.add("unsupported_service"); continue; }
      if (services.has(service.name)) { services.set(service.name, { name: service.name, status: "ambiguous", health: "unknown" }); continue; }
      const observed = { name: service.name, status: pick(service.status, SERVICE_STATES), health: pick(service.health, HEALTH) };
      if (observed.status === "missing") issues.add("service_missing");
      if (observed.health === "unhealthy") issues.add("service_unhealthy");
      services.set(service.name, observed);
    }
    const state = pick(entry?.state, STATES, "needs_attention");
    if (state === "needs_attention") issues.add("installation_needs_attention");
    if (entry?.canRecover === true) issues.add("recovery_required");
    for (const issue of issues) errors.add(issue);
    const installedCommit = commit(entry?.commit) || commit(entry?.version);
    return { installation: index + 1, version: releaseTag(entry?.version) || installedCommit,
      releaseTag: releaseTag(entry?.releaseTag), commit: installedCommit, state,
      services: [...services.values()].sort((a, b) => a.name.localeCompare(b.name)), issues: [...issues] };
  });
  const enginePlatform = ["linux/amd64", "linux/arm64"].includes(status.enginePlatform) ? status.enginePlatform : null;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(),
    launcher: { version: releaseTag(launcherVersion) || numericVersion(launcherVersion), platform: pick(platform, new Set(["win32", "darwin", "linux"])),
      arch: pick(arch, new Set(["x64", "arm64"])), osRelease: numericVersion(osRelease) },
    docker: { available: status.dockerAvailable === true, version: numericVersion(engineInfo?.ServerVersion), enginePlatform,
      architecture: enginePlatform?.split("/")[1] || null, issue: dockerIssue }, installations,
    errors: [...errors].slice(0, 20).map((code) => ({ code, message: MESSAGES[code] })) };
}
