const REPOSITORY = "gall-levi-code/Syronius_FRAME";
const RELEASES = `https://github.com/${REPOSITORY}/releases`;

export async function fetchJson(url, fetchImpl, limit, missingMessage = "No published FRAME release is available.") {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), headers: {
      Accept: "application/vnd.github+json", "User-Agent": "FRAME-Setup", "X-GitHub-Api-Version": "2022-11-28",
    } });
  } catch { throw new Error("Could not reach FRAME releases. Check your connection and try again."); }
  if (response.status === 404) throw new Error(missingMessage);
  if (!response.ok) throw new Error(`FRAME release download failed (HTTP ${response.status}). Check the connection or GitHub rate limit, then retry.`);
  if (response.url) {
    const target = new URL(response.url);
    if (target.protocol !== "https:" || target.username || target.password
      || !["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname)) {
      throw new Error("FRAME release metadata was redirected outside the official download service.");
    }
  }
  if (!response.body) throw new Error("FRAME release download was empty.");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("FRAME release metadata exceeds its size limit.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("FRAME release metadata could not be read. Try checking again later."); }
}

// Unknown version formats never authorize a downgrade or an automatic version choice.
export function isNewerVersion(next, current) {
  const parse = (value) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value || "");
    if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) return null;
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const a = parse(next), b = parse(current);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre || !b.pre) return Boolean(!a.pre && b.pre);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined || b.pre[i] === undefined) return b.pre[i] === undefined;
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i]);
    if (numericA !== numericB) return !numericA;
    return numericA ? BigInt(a.pre[i]) > BigInt(b.pre[i]) : a.pre[i] > b.pre[i];
  }
  return false;
}

function assetUrl(asset, tag, name) {
  if (!asset || asset.name !== name || typeof asset.browser_download_url !== "string") return null;
  const expected = `${RELEASES}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (asset.browser_download_url !== expected) throw new Error("FRAME release asset does not belong to the selected official release.");
  return expected;
}

export async function fetchStableRelease({ fetchImpl = fetch, platform = process.platform, arch = process.arch, enginePlatform, validateManifest }) {
  // GitHub's latest endpoint excludes drafts/prereleases; validate those flags as well.
  // https://docs.github.com/en/rest/releases/releases#get-the-latest-release
  const release = await fetchJson(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, fetchImpl, 1024 * 1024,
    "No stable FRAME release has been published yet. Try checking again later.");
  if (!release || release.draft !== false || release.prerelease !== false
    // FRAME historically used -release for stable builds; alpha/beta/rc tags stay excluded even if misflagged.
    || typeof release.tag_name !== "string" || release.tag_name.length > 128 || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-release)?$/.test(release.tag_name)
    || typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at)) || !Array.isArray(release.assets)) {
    throw new Error("GitHub did not return a valid published stable FRAME release.");
  }
  const tag = release.tag_name, version = tag.replace(/^v(?=\d)/, "");
  const result = { tag, version, publishedAt: release.published_at, url: `${RELEASES}/tag/${encodeURIComponent(tag)}`,
    notes: typeof release.body === "string" ? release.body.slice(0, 32_000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") : "",
    manifest: null, commit: null, frameError: "Docker must be available to select the matching FRAME release.", launcherAsset: null };
  const extension = { win32: "exe", darwin: "dmg", linux: "AppImage" }[platform];
  const os = { win32: "win", darwin: "mac", linux: "linux" }[platform];
  if (extension && (arch === "x64" || platform === "darwin" && arch === "arm64")) {
    const packageArch = platform === "linux" && arch === "x64" ? "x86_64" : arch;
    const name = `FRAME-Setup-${version}-${os}-${packageArch}.${extension}`;
    const assets = release.assets.filter((asset) => asset.name === name);
    if (assets.length > 1) throw new Error("The FRAME release contains duplicate launcher packages.");
    const url = assetUrl(assets[0], tag, name);
    if (url) result.launcherAsset = { name, url };
  }
  if (["linux/amd64", "linux/arm64"].includes(enginePlatform)) {
    const name = enginePlatform === "linux/arm64" ? "frame-images-arm64.json" : "frame-images.json";
    try {
      const assets = release.assets.filter((asset) => asset.name === name);
      if (assets.length !== 1) throw new Error(`This release has no unique ${name} for your Docker engine. Wait for matching release images to be published.`);
      const url = assetUrl(assets[0], tag, name);
      if (!url) throw new Error("The matching FRAME image manifest is unavailable.");
      const manifest = validateManifest(await fetchJson(url, fetchImpl, 64 * 1024, "The matching FRAME image manifest is unavailable."));
      if (manifest.platform !== enginePlatform) throw new Error("The FRAME image manifest does not match this Docker engine's architecture.");
      result.manifest = manifest; result.commit = manifest.commit; result.frameError = "";
    } catch (error) { result.frameError = error.message; }
  }
  return result;
}
