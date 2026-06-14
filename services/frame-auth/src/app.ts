import express, { type Express, type Request } from "express";
import { SessionSigner, safeEqual } from "./session.js";

const COOKIE_NAME = "frame_session";

export interface CredentialPair {
  username: string;
  password: string;
}

export interface AuthConfig {
  portal: CredentialPair;
  streams: CredentialPair;
  overlays: CredentialPair;
  sessionSigner: SessionSigner;
  sessionDays: number;
}

interface AttemptState {
  failures: number[];
}

export function createApp(config: AuthConfig): Express {
  const app = express();
  const attempts = new Map<string, AttemptState>();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, service: "frame-auth", configured: configured(config.portal), session_days: config.sessionDays });
  });

  app.get("/auth/check", (request, response) => {
    if (!configured(config.portal)) {
      response.status(200).end();
      return;
    }
    const session = config.sessionSigner.verify(readCookie(request, COOKIE_NAME));
    if (!session) {
      response.redirect(302, publicUrl(
        request,
        `/auth/login?return_to=${encodeURIComponent(returnTarget(request.header("x-forwarded-uri")))}`,
      ));
      return;
    }
    const downstream = downstreamCredentials(request.header("x-forwarded-uri") || "/", config);
    if (configured(downstream)) {
      response.setHeader("Authorization", `Basic ${Buffer.from(`${downstream.username}:${downstream.password}`).toString("base64")}`);
    }
    response.setHeader("X-Frame-Authenticated-User", session.sub);
    response.status(200).end();
  });

  app.get("/auth/login", (request, response) => {
    const target = returnTarget(stringValue(request.query.return_to));
    if (config.sessionSigner.verify(readCookie(request, COOKIE_NAME))) {
      response.redirect(303, target);
      return;
    }
    response.type("html").send(loginPage(target, "", config.sessionDays, configured(config.portal)));
  });

  app.post("/auth/login", (request, response) => {
    const target = returnTarget(stringValue(request.body.return_to));
    if (!configured(config.portal)) {
      response.status(503).type("html").send(loginPage(target, "FRAME login has not been configured.", config.sessionDays, false));
      return;
    }
    const key = clientKey(request);
    if (rateLimited(attempts, key)) {
      response.status(429).type("html").send(loginPage(target, "Too many attempts. Try again in a few minutes.", config.sessionDays, true));
      return;
    }
    const username = stringValue(request.body.username);
    const password = stringValue(request.body.password);
    if (!safeEqual(username, config.portal.username) || !safeEqual(password, config.portal.password)) {
      recordFailure(attempts, key);
      response.status(401).type("html").send(loginPage(target, "That username or password was not accepted.", config.sessionDays, true));
      return;
    }
    attempts.delete(key);
    response.setHeader("Set-Cookie", sessionCookie(config.sessionSigner.create(username), config.sessionSigner.durationSeconds, isSecure(request)));
    response.redirect(303, target);
  });

  app.get("/auth/logout", (request, response) => {
    response.setHeader("Set-Cookie", sessionCookie("", 0, isSecure(request)));
    response.redirect(303, "/auth/login");
  });

  return app;
}

function downstreamCredentials(uri: string, config: AuthConfig): CredentialPair {
  if (uri === "/slsui" || uri.startsWith("/slsui/")) return config.streams;
  if (uri === "/overlays" || uri.startsWith("/overlays/")) return config.overlays;
  return config.portal;
}

function configured(pair: CredentialPair): boolean {
  return Boolean(pair.username && pair.password);
}

function readCookie(request: Request, name: string): string | undefined {
  for (const item of (request.header("cookie") || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function isSecure(request: Request): boolean {
  return request.secure
    || forwardedValue(request, "x-forwarded-proto") === "https"
    || (request.header("cf-visitor") || "").includes('"scheme":"https"');
}

function publicUrl(request: Request, target: string): string {
  const candidate = forwardedValue(request, "x-forwarded-host") || request.header("host") || "localhost";
  const host = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(candidate) ? candidate : "localhost";
  return `${isSecure(request) ? "https" : "http"}://${host}${target}`;
}

function forwardedValue(request: Request, name: string): string {
  return (request.header(name) || "").split(",")[0]?.trim() || "";
}

function returnTarget(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/auth")) return "/dashboard";
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clientKey(request: Request): string {
  return (request.header("x-forwarded-for") || request.ip || "unknown").split(",")[0]?.trim() || "unknown";
}

function rateLimited(attempts: Map<string, AttemptState>, key: string): boolean {
  const cutoff = Date.now() - 15 * 60_000;
  const state = attempts.get(key);
  if (!state) return false;
  state.failures = state.failures.filter((time) => time >= cutoff);
  return state.failures.length >= 10;
}

function recordFailure(attempts: Map<string, AttemptState>, key: string): void {
  const state = attempts.get(key) ?? { failures: [] };
  state.failures.push(Date.now());
  attempts.set(key, state);
}

function loginPage(returnTo: string, error: string, sessionDays: number, enabled: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#06151e">
  <title>Sign in to Syronius FRAME</title>
  <link rel="icon" href="/assets/frame-logo-square.svg" type="image/svg+xml">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #e9f8ff; background: #06151e; --accent: #2cb4fb; --surface: #0b222e; --border: #205069; --muted: #9bbdcd; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 18px; background: #06151e; }
    main { width: min(100%, 390px); padding: 22px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: 0 18px 50px rgb(0 0 0 / 30%); }
    header { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; }
    img { width: 58px; height: 58px; object-fit: contain; }
    h1 { margin: 0; font-size: 22px; }
    header span, p { color: var(--muted); }
    form { display: grid; gap: 13px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 700; }
    input { width: 100%; min-height: 46px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 6px; background: #06151e; color: #e9f8ff; font: inherit; }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    button { min-height: 47px; border: 1px solid #168fd1; border-radius: 6px; background: var(--accent); color: #03131c; font: inherit; font-weight: 900; cursor: pointer; }
    p { margin: 15px 0 0; font-size: 12px; line-height: 1.45; }
    .error { margin: 0 0 13px; padding: 9px 10px; border-left: 3px solid #ff7182; background: rgb(255 113 130 / 10%); color: #ffb2bb; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <header><img src="/assets/frame-logo-square.svg" alt=""><div><h1>Sign in to FRAME</h1><span>One login for protected panels</span></div></header>
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/auth/login">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <label>Username<input name="username" autocomplete="username" required ${enabled ? "" : "disabled"}></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required ${enabled ? "" : "disabled"}></label>
      <button type="submit" ${enabled ? "" : "disabled"}>Sign in</button>
    </form>
    <p>This browser will stay signed in for ${sessionDays} day${sessionDays === 1 ? "" : "s"}. Signing out or clearing site data ends the session.</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}
