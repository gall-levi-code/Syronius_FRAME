import path from "node:path";
import { createApp } from "./app.js";
import { GalleryStore } from "./store.js";

const port = integer("PORT", 3738, 1, 65535);
const dataRoot = path.resolve(process.env.DATA_ROOT?.trim() || "./data");
const store = new GalleryStore(
  dataRoot,
  integer("GALLERY_THUMB_WIDTH", 720, 160, 2560),
  integer("GALLERY_THUMB_QUALITY", 82, 30, 100),
);
const app = await createApp(store, path.resolve(process.cwd(), "public"), {
  pipelineUrl: process.env.PHOTO_PIPELINE_URL?.trim() || "http://frame-pipeline-photos:3735",
  serviceToken: process.env.PORTAL_SERVICE_TOKEN?.trim() || "",
  auth: {
    username: process.env.PORTAL_USERNAME?.trim() || "",
    password: process.env.PORTAL_PASSWORD?.trim() || "",
    realm: process.env.PORTAL_REALM?.trim() || "FRAME Portal",
  },
});
const recoveredDates = await store.listDates();
console.log(
  `[gallery] recovered ${recoveredDates.reduce((total, date) => total + date.count, 0)} photo(s) across ${recoveredDates.length} day(s)`,
);
const server = app.listen(port, () => console.log(`[gallery] listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
