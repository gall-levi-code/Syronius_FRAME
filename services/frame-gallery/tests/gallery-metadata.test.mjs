import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createApp } from "../dist/app.js";
import { GalleryStore } from "../dist/store.js";

test("renders safe public metadata and serves only visible share media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-metadata-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  const store = new GalleryStore(root, 320, 80);
  let server;

  try {
    await mkdir(gallery, { recursive: true });
    await publish(gallery, "cover", "2026-06-13T12:00:00.000Z", "#2cb4fb");
    await publish(gallery, "selected", "2026-06-13T13:00:00.000Z", "#c8911b");
    await store.updateBranding({
      brand_name: "Brand $& $` $' <North>",
      gallery_title: "Gallery $& $` $' & Co",
    });
    const logo = await sharp({ create: { width: 900, height: 260, channels: 4, background: "#ff6600" } })
      .png()
      .toBuffer();
    const branding = await store.saveLogo({ data_url: `data:image/png;base64,${logo.toString("base64")}` });
    const revision = await store.galleryRevision(date);

    process.env.PUBLIC_BASE_URL = "https://gallery.example.test";
    const app = await createApp(store, path.resolve("public"));
    server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const localOrigin = `http://127.0.0.1:${address.port}`;
    const hostileHeaders = {
      host: "attacker.example",
      "x-forwarded-host": "forwarded-attacker.example",
      "x-forwarded-proto": "http",
    };
    const iconPath = `/gallery/branding/icon.png?v=${encodeURIComponent(branding.logo.updated_at)}`;
    const selectedPreview = `https://gallery.example.test/gallery/share/${date}/selected.jpg?v=${revision}`;

    const selectedHtml = await fetch(`${localOrigin}/gallery/${date}?view=explore&photo=selected`, {
      headers: hostileHeaders,
    }).then((response) => response.text());
    assert.equal((selectedHtml.match(/<!doctype html>/g) || []).length, 1);
    assert.equal(selectedHtml.match(/<title>.*?<\/title>/)?.[0],
      "<title>June 13, 2026 · Gallery $&amp; $` $&#39; &amp; Co · Brand $&amp; $` $&#39; &lt;North&gt;</title>",
    );
    assert.doesNotMatch(selectedHtml, /attacker\.example/);
    assert.ok(selectedHtml.includes(
      `<link rel="canonical" href="https://gallery.example.test/today/gallery/${date}/?view=explore&amp;photo=selected">`,
    ));
    assert.ok(selectedHtml.includes(`<link rel="icon" href="${iconPath}" type="image/png">`));
    assert.ok(selectedHtml.includes(`<link rel="apple-touch-icon" href="${iconPath}" sizes="512x512">`));
    assert.ok(selectedHtml.includes(`<meta property="og:image" content="${selectedPreview}">`));
    assert.ok(selectedHtml.includes('<meta property="og:image:type" content="image/jpeg">'));
    assert.ok(selectedHtml.includes('<meta property="og:image:width" content="1200">'));
    assert.ok(selectedHtml.includes('<meta property="og:image:height" content="630">'));
    assert.ok(selectedHtml.includes('<meta name="twitter:card" content="summary_large_image">'));

    const coverHtml = await fetch(`${localOrigin}/gallery/${date}?photo=missing`, { headers: hostileHeaders })
      .then((response) => response.text());
    assert.ok(coverHtml.includes(
      `<meta property="og:image" content="https://gallery.example.test/gallery/share/${date}/cover.jpg?v=${revision}">`,
    ));
    assert.doesNotMatch(coverHtml, /photo=missing/);

    const rootHtml = await fetch(`${localOrigin}/gallery/`, { headers: hostileHeaders }).then((response) => response.text());
    assert.ok(rootHtml.includes(`<meta property="og:image" content="https://gallery.example.test${iconPath}">`));
    assert.ok(rootHtml.includes('<meta property="og:image:width" content="512">'));
    assert.ok(rootHtml.includes('<meta property="og:image:height" content="512">'));
    assert.ok(rootHtml.includes('<meta name="twitter:card" content="summary">'));

    const iconResponse = await fetch(`${localOrigin}${iconPath}`);
    assert.equal(iconResponse.status, 200);
    assert.match(iconResponse.headers.get("content-type") || "", /^image\/png/);
    assert.deepEqual(
      await sharp(Buffer.from(await iconResponse.arrayBuffer())).metadata()
        .then(({ format, width, height }) => ({ format, width, height })),
      { format: "png", width: 512, height: 512 },
    );

    const previewResponse = await fetch(`${localOrigin}/gallery/share/${date}/selected.jpg?v=${revision}`);
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get("content-type") || "", /^image\/jpeg/);
    assert.deepEqual(
      await sharp(Buffer.from(await previewResponse.arrayBuffer())).metadata()
        .then(({ format, width, height }) => ({ format, width, height })),
      { format: "jpeg", width: 1200, height: 630 },
    );

    await writeFile(path.join(gallery, "selected.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
    const trashedPreview = await fetch(`${localOrigin}/gallery/share/${date}/selected.jpg?v=${revision}`);
    assert.equal(trashedPreview.status, 404);
    assert.doesNotMatch(trashedPreview.headers.get("cache-control") || "", /public/);
  } finally {
    if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
    if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function publish(directory, base, processedAt, background) {
  await sharp({ create: { width: 400, height: 300, channels: 3, background } })
    .jpeg()
    .toFile(path.join(directory, `${base}.jpg`));
  await writeFile(path.join(directory, `${base}.json`), JSON.stringify({
    original_name: `${base}.jpg`,
    width: 400,
    height: 300,
    orientation: 0,
    processed_at: processedAt,
  }));
  await writeFile(path.join(directory, `${base}.ready`), "ready\n");
}
