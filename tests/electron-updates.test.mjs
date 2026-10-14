import assert from "node:assert/strict";
import test from "node:test";
import { fetchJson, fetchStableRelease, isNewerVersion } from "../apps/frame-setup/electron/updates.mjs";
import { FRAME_IMAGE_SERVICES, validateReleaseManifest } from "../installer/frame-release.mjs";

const base = "https://github.com/gall-levi-code/Syronius_FRAME/releases";
const tag = "v1.2.0";
const asset = (name) => ({ name, browser_download_url: `${base}/download/${tag}/${name}` });
const release = { tag_name: tag, draft: false, prerelease: false, published_at: "2026-09-30T12:00:00Z", body: "Release notes <script>not executable</script>",
  assets: [asset("frame-images.json"), asset("frame-images-arm64.json"), asset("FRAME-Setup-1.2.0-win-x64.exe"), asset("FRAME-Setup-1.2.0-mac-arm64.dmg")] };
const manifest = (platform) => ({ schema_version: 1, commit: "a".repeat(40), platform,
  images: Object.fromEntries(FRAME_IMAGE_SERVICES.map((name) => [name, `ghcr.io/gall-levi-code/syronius-frame/${name}@sha256:${"b".repeat(64)}`])) });
const options = (changes = {}, platform = "linux/amd64") => ({ platform: "win32", arch: "x64", enginePlatform: platform, validateManifest: validateReleaseManifest,
  fetchImpl: async (url) => Response.json(url.includes("api.github.com") ? { ...release, ...changes } : manifest(platform)) });

test("stable update lookup returns bounded notes, exact architecture images and the matching launcher download", async () => {
  const requests = [], params = options();
  const result = await fetchStableRelease({ ...params, fetchImpl: async (url, init) => { requests.push(url); assert.ok(init.signal); return params.fetchImpl(url); } });
  assert.equal(result.tag, tag); assert.equal(result.commit, "a".repeat(40));
  assert.equal(result.launcherAsset.url, `${base}/download/${tag}/FRAME-Setup-1.2.0-win-x64.exe`);
  assert.equal(requests.length, 2); assert.match(requests[0], /releases\/latest$/);
  assert.equal(result.notes, release.body, "UI must render release notes as text");
  const arm = await fetchStableRelease({ ...options({}, "linux/arm64"), platform: "darwin", arch: "arm64" });
  assert.equal(arm.manifest.platform, "linux/arm64"); assert.match(arm.launcherAsset.name, /mac-arm64.dmg$/);
  const linux = await fetchStableRelease({ ...options({ assets: [...release.assets, asset("FRAME-Setup-1.2.0-linux-x86_64.AppImage")] }), platform: "linux" });
  assert.match(linux.launcherAsset.name, /linux-x86_64.AppImage$/);
  const unsupported = await fetchStableRelease({ ...options(), arch: "arm64" });
  assert.equal(unsupported.launcherAsset, null, "Windows ARM must not be offered an x64 launcher");
});

test("drafts, previews, invalid metadata and unofficial launcher downloads cannot authorize updates", async () => {
  for (const change of [{ draft: true }, { prerelease: true }, { prerelease: undefined }, { published_at: null }, { tag_name: "../other" },
    { tag_name: "v2.0.0-beta.1" }, { tag_name: "v2.0.0-alpha.1" }, { tag_name: "v2.0.0-rc.1" }]) {
    await assert.rejects(fetchStableRelease(options(change)), /valid published stable/);
  }
  await assert.rejects(fetchStableRelease(options({ assets: [ { ...asset("FRAME-Setup-1.2.0-win-x64.exe"), browser_download_url: "https://other.test/file.exe" } ] })), /official release/);
});

test("missing, invalid or wrong-platform manifests keep launcher updates available and FRAME updates unverified", async () => {
  const missing = await fetchStableRelease(options({ assets: release.assets.filter((asset) => !asset.name.endsWith(".json")) }));
  assert.equal(missing.manifest, null); assert.match(missing.frameError, /no unique/); assert.ok(missing.launcherAsset);
  const wrong = await fetchStableRelease({ ...options({}, "linux/arm64"), fetchImpl: async (url) => Response.json(url.includes("api.github.com") ? release : manifest("linux/amd64")) });
  assert.equal(wrong.manifest, null); assert.match(wrong.frameError, /architecture/);
  const offline = await fetchStableRelease({ ...options(), enginePlatform: null });
  assert.ok(offline.launcherAsset); assert.equal(offline.manifest, null);
  const invalid = await fetchStableRelease(options({ assets: [{ ...asset("frame-images.json"), browser_download_url: `${base}/download/v9.0.0/frame-images.json` }] }));
  assert.equal(invalid.manifest, null); assert.match(invalid.frameError, /official release/);
});

test("update version comparisons prevent downgrades and leave unknown version formats unverified", () => {
  for (const [a, b, expected] of [["v1.2.0", "1.1.9", true], ["1.1.9", "1.2.0", false], ["1.2.0", "1.2.0", false],
    ["1.0.0", "1.0.0-release", true], ["1.0.0-rc.10", "1.0.0-rc.2", true], ["1.0.0-rc.1", "1.0.0", false],
    ["next", "1.0.0", null], ["1.0.0", "abcdef", null], ["1.2.0+build2", "1.2.0+build1", false]]) assert.equal(isNewerVersion(a, b), expected);
});

test("bounded release metadata gives safe offline, malformed and HTTP failures", async () => {
  await assert.rejects(fetchJson("https://api.github.com", async () => { throw new Error("secret-token"); }, 100), /Check your connection/);
  await assert.rejects(fetchJson("https://api.github.com", async () => new Response("123456"), 3), /size limit/);
  await assert.rejects(fetchJson("https://api.github.com", async () => new Response("invalid"), 100), /could not be read/);
  await assert.rejects(fetchJson("https://api.github.com", async () => new Response(null, { status: 403 }), 100), /HTTP 403/);
  await assert.rejects(fetchJson("https://api.github.com", async () => ({ ok: true, url: "https://outside.example/release" }), 100), /outside the official/);
});
