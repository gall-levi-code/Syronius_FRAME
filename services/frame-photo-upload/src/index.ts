import path from "node:path";
import { createApp } from "./app.js";

const port = readInteger("PORT", 3736, 1, 65535);
const dataRoot = path.resolve(process.env.DATA_ROOT?.trim() || "./data");
const maxInputBytes = readInteger("PHOTO_MAX_INPUT_MB", 50, 1, 2048) * 1024 * 1024;
const maxFiles = readInteger("PHOTO_UPLOAD_MAX_FILES", 10, 1, 100);
const maxSessions = readInteger("PHOTO_UPLOAD_MAX_SESSIONS", 10, 1, 100);
const publicDir = path.resolve(process.cwd(), "public");
const app = await createApp({
  dataRoot,
  maxInputBytes,
  maxFiles,
  maxSessions,
  publicDir,
  auth: {
    username: process.env.PORTAL_USERNAME?.trim() || "",
    password: process.env.PORTAL_PASSWORD?.trim() || "",
    realm: process.env.PORTAL_REALM?.trim() || "FRAME Portal",
  },
});
const server = app.listen(port, () => console.log(`[photo-upload] listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
