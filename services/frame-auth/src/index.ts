import { createApp } from "./app.js";
import { SessionSigner } from "./session.js";

const port = integer("PORT", 3740, 1, 65535);
const sessionDays = integer("FRAME_AUTH_SESSION_DAYS", 7, 1, 30);
const app = createApp({
  portal: credentials("PORTAL"),
  streams: credentials("STREAMS"),
  overlays: credentials("OVERLAYS"),
  sessionSigner: new SessionSigner(required("FRAME_AUTH_SESSION_SECRET"), sessionDays * 24 * 60 * 60),
  sessionDays,
});
const server = app.listen(port, () => console.log(`[auth] FRAME SSO listening on ${port}; session duration ${sessionDays} day(s)`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function credentials(prefix: string): { username: string; password: string } {
  return {
    username: process.env[`${prefix}_USERNAME`]?.trim() || "",
    password: process.env[`${prefix}_PASSWORD`]?.trim() || "",
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim() || "";
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
