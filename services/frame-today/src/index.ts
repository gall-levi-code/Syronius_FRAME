import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "./app.js";
import { type BasicAuthConfig } from "./auth.js";
import { TodayController } from "./controller.js";
import { TodayStore } from "./store.js";
import { attachTodaySockets } from "./viewer-feedback.js";

const port = integer("PORT", 3739, 1, 65535);
const dataRoot = path.resolve(process.env.DATA_ROOT?.trim() || "./data");
const publicBaseUrl = stripTrailingSlash(process.env.PUBLIC_BASE_URL?.trim() || "http://localhost");
const photoPipelineUrl = stripTrailingSlash(process.env.PHOTO_PIPELINE_URL?.trim() || "http://frame-pipeline-photos:3735");
const controller = new TodayController(
  new TodayStore(dataRoot),
  integer("TODAY_DEFAULT_INTERVAL_MS", 10_000, 1_000, 300_000),
  integer("TODAY_REFRESH_MS", 1_000, 250, 60_000),
);
await controller.init();
const recoveredState = controller.state();
console.log(
  recoveredState.date_folder
    ? `[today] recovered ${recoveredState.count_today} photo(s) from ${recoveredState.date_folder}`
    : `[today] no published photos found under ${dataRoot}`,
);
const store = new TodayStore(dataRoot);
const auth: BasicAuthConfig = {
  username: process.env.PORTAL_USERNAME?.trim() || "",
  password: process.env.PORTAL_PASSWORD?.trim() || "",
  realm: process.env.PORTAL_REALM?.trim() || "FRAME Portal",
};
const app = createApp(controller, store, path.resolve(process.cwd(), "public"), auth, publicBaseUrl, photoPipelineUrl);
const server = createServer(app);
const closeSockets = attachTodaySockets(server, controller, auth);

server.listen(port, () => console.log(`[today] listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    controller.close();
    closeSockets();
    server.close(() => process.exit(0));
  });
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
