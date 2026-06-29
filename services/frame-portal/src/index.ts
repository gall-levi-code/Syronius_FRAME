import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { loadConfig } from "./config";
import { DockerClient } from "./dockerClient";
import { buildPortalTools, isPhotoPipelineEnabled, loadStackConfig } from "./stackConfig";
import { StatusCollector } from "./statusCollector";

const appConfig = loadConfig();
const dockerClient = new DockerClient(
  appConfig.dockerSocketPath,
  appConfig.serviceNamePrefix,
  appConfig.dockerHost,
  appConfig.requestTimeoutMs,
  appConfig.dockerComposeProject,
);
const statusCollector = new StatusCollector(appConfig, dockerClient);
const app = express();
const publicDir = path.resolve(process.cwd(), "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(
  "/assets",
  (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  },
  express.static(publicDir),
);

app.get("/healthz", (_request, response) => {
  response.json({ ok: true, service: "frame-portal" });
});

app.use((request, response, next) => {
  if (!appConfig.portalUsername || !appConfig.portalPassword) {
    next();
    return;
  }
  const credentials = readBasicCredentials(request.header("authorization"));
  if (
    credentials &&
    safeEqual(credentials.username, appConfig.portalUsername) &&
    safeEqual(credentials.password, appConfig.portalPassword)
  ) {
    next();
    return;
  }
  response.setHeader("WWW-Authenticate", `Basic realm="${appConfig.portalRealm}", charset="UTF-8"`);
  response.status(401).send("Authentication required.");
});

app.get("/api/portal", async (request, response, next) => {
  try {
    const [stackConfig, status] = await Promise.all([
      loadStackConfig(appConfig),
      statusCollector.collect(),
    ]);
    const accessContext = isPublicRequest(request.header("host"), appConfig.publicHostname)
      ? "public"
      : "lan";
    response.json({
      mode: stackConfig.config.mode,
      access_context: accessContext,
      config_source: stackConfig.source,
      pipeline_enabled: isPhotoPipelineEnabled(stackConfig),
      tools: buildPortalTools(stackConfig, status.services, accessContext),
      restarts_enabled: appConfig.enableContainerRestarts,
      refresh_ms: appConfig.statusRefreshMs,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/status/api", async (_request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await statusCollector.collect());
  } catch (error) {
    next(error);
  }
});

app.post("/status/services/:name/restart", async (request, response) => {
  if (!appConfig.enableContainerRestarts) {
    response.status(403).json({ error: "Container restarts are disabled." });
    return;
  }

  try {
    await dockerClient.restartService(request.params.name);
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: errorMessage(error) });
  }
});

app.get("/pipeline/api/settings", async (_request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await photoPipelineRequest("/api/internal/photo-pipeline/settings"));
  } catch (error) {
    next(error);
  }
});

app.put("/pipeline/api/settings", async (request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await photoPipelineRequest("/api/internal/photo-pipeline/settings", request.body));
  } catch (error) {
    next(error);
  }
});

app.get("/status/logs/:name", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  try {
    await dockerClient.streamLogs(
      request.params.name,
      (line) => response.write(`data: ${JSON.stringify({ line })}\n\n`),
      abortController.signal,
    );
  } catch (error) {
    if (!abortController.signal.aborted) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage(error) })}\n\n`);
    }
  } finally {
    response.end();
  }
});

app.get("/", (_request, response) => {
  response.redirect(302, "/dashboard");
});

app.get(["/dashboard", "/status", "/theme"], (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(publicDir, "index.html"));
});

app.get("/pipeline", async (request, response, next) => {
  try {
    const stackConfig = await loadStackConfig(appConfig);
    const accessContext = isPublicRequest(request.header("host"), appConfig.publicHostname)
      ? "public"
      : "lan";
    if (!isPhotoPipelineEnabled(stackConfig) || accessContext !== "lan") {
      response.redirect(302, "/dashboard");
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(publicDir, "index.html"));
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? Number((error as { status: number }).status)
      : 500;
    if (status === 500) console.error("[portal]", error);
    response.status(status).json({ error: status === 500 ? "FRAME Portal request failed." : errorMessage(error) });
  },
);

app.listen(appConfig.port, () => {
  console.log(`[portal] FRAME Portal listening on port ${appConfig.port}`);
  console.log(
    `[portal] Container restarts ${appConfig.enableContainerRestarts ? "enabled" : "disabled"}`,
  );
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function photoPipelineRequest(pathname: string, body?: unknown): Promise<unknown> {
  if (!isPhotoPipelineEnabled(await loadStackConfig(appConfig))) {
    const error = new Error("Photo Pipeline is not enabled.");
    Object.assign(error, { status: 404 });
    throw error;
  }
  if (!appConfig.photoPipelineUrl || !appConfig.photoPipelineToken) {
    const error = new Error("Photo Pipeline is not configured.");
    Object.assign(error, { status: 503 });
    throw error;
  }
  let response;
  try {
    response = await fetch(`${appConfig.photoPipelineUrl.replace(/\/+$/, "")}${pathname}`, {
      method: body === undefined ? "GET" : "PUT",
      headers: {
        accept: "application/json",
        "x-frame-service-token": appConfig.photoPipelineToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const error = new Error("Photo Pipeline is unavailable.");
    Object.assign(error, { status: 503 });
    throw error;
  }
  const result = await response.json().catch(() => ({ error: `Photo Pipeline request failed (${response.status}).` })) as { error?: unknown };
  if (!response.ok) {
    const error = new Error(typeof result.error === "string" ? result.error : `Photo Pipeline request failed (${response.status}).`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return result;
}

function readBasicCredentials(authorization: string | undefined): {
  username: string;
  password: string;
} | null {
  if (!authorization?.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isPublicRequest(hostHeader: string | undefined, publicHostname: string | undefined): boolean {
  if (!publicHostname) return false;
  const host = (hostHeader || "").split(":", 1)[0]?.trim().toLowerCase();
  return host === publicHostname;
}
