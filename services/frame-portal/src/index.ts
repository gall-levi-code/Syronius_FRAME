import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { loadConfig } from "./config";
import { DockerClient } from "./dockerClient";
import { buildPortalTools, loadStackConfig } from "./stackConfig";
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

app.get("/api/portal", async (_request, response, next) => {
  try {
    const [stackConfig, status] = await Promise.all([
      loadStackConfig(appConfig),
      statusCollector.collect(),
    ]);
    response.json({
      mode: stackConfig.config.mode,
      config_source: stackConfig.source,
      tools: buildPortalTools(stackConfig, status.services),
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

app.get(["/", "/dashboard", "/status"], (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[portal]", error);
    response.status(500).json({ error: "FRAME Portal request failed." });
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
