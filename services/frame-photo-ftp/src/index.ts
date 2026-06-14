import express from "express";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { StabilityGate } from "./stabilityGate.js";

const dataRoot = path.resolve(process.env.DATA_ROOT?.trim() || "./data");
const inbox = path.join(dataRoot, "inbox");
const staging = path.join(dataRoot, "staging");
await Promise.all([mkdir(inbox, { recursive: true }), mkdir(staging, { recursive: true })]);

const healthPort = integer("PORT", 3737, 1, 65535);
const gate = new StabilityGate(inbox, staging, integer("PHOTO_FTP_STABLE_MS", 3000, 1000, 60000));
await gate.init();
const scanTimer = setInterval(() => void gate.runOnce(), integer("PHOTO_FTP_SCAN_MS", 1000, 250, 10000));
scanTimer.unref();

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_request, response) => {
  response.json({ ok: true, service: "frame-photo-ftp", ...gate.status });
});
const healthServer = app.listen(healthPort, () => console.log(`[photo-ftp] health listening on ${healthPort}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(scanTimer);
    healthServer.close();
    process.exit(0);
  });
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
