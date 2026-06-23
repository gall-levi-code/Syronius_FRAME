import express, { type Express, type Request } from "express";
import path from "node:path";
import { SessionSigner, safeEqual } from "./session.js";

const COOKIE_NAME = "frame_session";
const FRAME_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800.88 800"><path fill="#4cb0e3" d="M330.88.06H22.82C10.24 0 0 10.74 0 24.02v751.96c0 13.23 10.17 23.96 22.71 23.96l247.49.06 27.76-83.77-211.46.86V85.38l216.39 1.01L330.88.06Z"/><polygon fill="#4cb0e3" points="393.88 0 800.88 0 746.61 181.88 334.71 181.88 393.88 0"/><path fill="#4cb0e3" d="M800.88 491.26v284.78c0 13.23-10.17 23.96-22.71 23.96H335.24l28.02-83.93h353.98V491.26h83.65Z"/><polygon fill="#4cb0e3" points="317.7 244.54 731.94 244.54 679.95 428.76 393.44 428.76 318.31 654.98 172.75 654.98 317.7 244.54"/></svg>';
const FRAME_LOGO_DATA_URI = `data:image/svg+xml,${encodeURIComponent(FRAME_LOGO_SVG)}`;

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
  const publicDir = path.resolve(process.cwd(), "public");
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
  app.use(
    "/assets",
    (_request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      next();
    },
    express.static(publicDir),
  );

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

  app.all("/auth/error/:status", (request, response) => {
    const status = errorStatus(request.params.status);
    response.status(status).type("html").send(errorPage(status, errorCopy(status)));
  });

  app.all("/auth/public-denied", (_request, response) => {
    response.status(404).type("html").send(errorPage(404, errorCopy(404)));
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
  if (!value || value === "/" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/auth")) return "/dashboard";
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

interface ErrorPageCopy {
  eyebrow: string;
  title: string;
  message: string;
}

const ERROR_COPY: Record<number, ErrorPageCopy> = {
  400: {
    eyebrow: "400",
    title: "Request not accepted",
    message: "FRAME could not read that public request.",
  },
  401: {
    eyebrow: "401",
    title: "Sign in required",
    message: "This FRAME page needs a valid session before it can open.",
  },
  403: {
    eyebrow: "403",
    title: "Access not available",
    message: "This public FRAME link cannot open that address.",
  },
  404: {
    eyebrow: "404",
    title: "Page not found",
    message: "That FRAME address is not available from this public link.",
  },
  429: {
    eyebrow: "429",
    title: "Too many attempts",
    message: "FRAME is slowing this request down for a moment.",
  },
  500: {
    eyebrow: "500",
    title: "FRAME hit an error",
    message: "The request reached FRAME, but something failed while handling it.",
  },
  502: {
    eyebrow: "502",
    title: "Service did not answer",
    message: "FRAME could not reach this service.\nIt may still be starting.",
  },
  503: {
    eyebrow: "503",
    title: "FRAME is unavailable",
    message: "The requested FRAME service is not ready right now.",
  },
  504: {
    eyebrow: "504",
    title: "Request timed out",
    message: "FRAME did not finish answering before the gateway stopped waiting.",
  },
};

function errorStatus(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 400 || parsed > 599) return 500;
  return parsed;
}

function errorCopy(status: number): ErrorPageCopy {
  const known = ERROR_COPY[status];
  if (known) return known;
  if (status >= 500) {
    return {
      eyebrow: String(status),
      title: "FRAME could not complete the request",
      message: "The public gateway reached an unexpected service error.",
    };
  }
  return {
    eyebrow: String(status),
    title: "This address cannot be opened",
    message: "FRAME could not serve that public address.",
  };
}

function errorPage(status: number, copy: ErrorPageCopy): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#06151e">
  <title>${status} - ${escapeHtml(copy.title)} - Syronius FRAME</title>
  <link rel="icon" href="${FRAME_LOGO_DATA_URI}" type="image/svg+xml">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #e9f8ff; background: #06151e; --cyan: #2cb4fb; --ice: #e9f8ff; --deep: #06151e; --gold: #ffb454; --muted: #b9d3df; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 18px;
      overflow: hidden;
      background:
        linear-gradient(135deg, #06151e 0%, #0e2a36 26%, #184a68 48%, #2cb4fb 72%, #e9f8ff 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        linear-gradient(180deg, rgb(3 12 18 / 34%), rgb(3 12 18 / 64%)),
        linear-gradient(90deg, rgb(44 180 251 / 18%), transparent 38%, rgb(255 180 84 / 16%));
      pointer-events: none;
    }
    main {
      position: relative;
      isolation: isolate;
      width: min(100%, 760px);
      min-height: min(760px, calc(100vh - 36px));
      display: grid;
      place-items: center;
    }
    .mark {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      pointer-events: none;
      z-index: 0;
    }
    .mark img,
    .mark .fill,
    .mark .glow {
      position: absolute;
      width: min(80vw, 590px);
      aspect-ratio: 1;
    }
    .mark img {
      object-fit: contain;
      opacity: .18;
      filter: drop-shadow(0 0 26px rgb(233 248 255 / 35%));
    }
    .mark .fill,
    .mark .glow {
      background: linear-gradient(315deg, var(--ice) 0%, var(--cyan) 34%, #0b2230 62%, var(--gold) 100%);
      -webkit-mask: url("${FRAME_LOGO_DATA_URI}") center / contain no-repeat;
      mask: url("${FRAME_LOGO_DATA_URI}") center / contain no-repeat;
    }
    .mark .fill {
      opacity: .9;
      filter:
        drop-shadow(0 0 10px rgb(233 248 255 / 72%))
        drop-shadow(0 0 32px rgb(44 180 251 / 62%))
        drop-shadow(0 0 74px rgb(255 180 84 / 24%));
    }
    .mark .glow {
      opacity: .5;
      transform: scale(1.035);
      filter: blur(18px);
    }
    .copy {
      position: relative;
      z-index: 1;
      width: min(100%, 560px);
      min-height: 320px;
      display: grid;
      place-items: center;
      align-content: center;
      gap: 12px;
      padding: 56px 28px;
      text-align: center;
      background: radial-gradient(ellipse at center, rgb(2 9 14 / 92%) 0%, rgb(2 9 14 / 78%) 38%, rgb(2 9 14 / 0%) 72%);
    }
    .status {
      margin: 0;
      color: var(--ice);
      font-size: 7rem;
      line-height: .82;
      font-weight: 950;
      text-shadow: 0 0 18px rgb(233 248 255 / 46%), 0 0 54px rgb(44 180 251 / 42%);
    }
    h1 {
      margin: 0;
      max-width: 14ch;
      color: var(--ice);
      font-size: 2.15rem;
      line-height: 1.05;
      font-weight: 900;
    }
    p {
      margin: 0;
      max-width: 34rem;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.5;
    }
    @media (max-width: 560px) {
      main { min-height: calc(100vh - 36px); }
      .mark img, .mark .fill, .mark .glow { width: min(104vw, 430px); }
      .copy { min-height: 270px; padding: 42px 18px; }
      .status { font-size: 4.8rem; }
      h1 { font-size: 1.55rem; }
      p { font-size: .95rem; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">
      <img src="${FRAME_LOGO_DATA_URI}" alt="">
      <div class="glow"></div>
      <div class="fill"></div>
    </div>
    <section class="copy" aria-labelledby="error-title">
      <p class="status" aria-label="HTTP status ${status}">${escapeHtml(copy.eyebrow)}</p>
      <h1 id="error-title">${escapeHtml(copy.title)}</h1>
      <p>${formatMessage(copy.message)}</p>
    </section>
  </main>
</body>
</html>`;
}

function formatMessage(value: string): string {
  return value.split("\n").map(escapeHtml).join("<br>");
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
