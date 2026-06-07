import http, { type IncomingMessage } from "node:http";
import type { ServiceHealth, ServiceStatus, ServiceSummary } from "./types";

interface DockerContainer {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
}

interface DockerContainerInspect {
  State?: {
    Status?: string;
    StartedAt?: string;
    Health?: { Status?: string };
  };
}

export class DockerClient {
  constructor(
    private readonly socketPath: string,
    private readonly serviceNamePrefix: string,
    private readonly dockerHost?: string,
    private readonly requestTimeoutMs = 3_000,
  ) {}

  async listFrameServices(): Promise<ServiceSummary[]> {
    const containers = await this.requestJson<DockerContainer[]>("GET", "/containers/json?all=1");
    const frameContainers = containers
      .map((container) => ({
        container,
        name: normalizeName(container.Names[0] || container.Id.slice(0, 12)),
      }))
      .filter(({ name }) => name.startsWith(this.serviceNamePrefix));

    return Promise.all(
      frameContainers.map(async ({ container, name }) => {
        const inspected = await this.inspectContainer(container.Id).catch(() => null);
        const state = inspected?.State?.Status || container.State;
        const startedAt = inspected?.State?.StartedAt ? Date.parse(inspected.State.StartedAt) : NaN;
        return {
          name,
          status: mapStatus(state),
          health: mapHealth(inspected?.State?.Health?.Status, container.Status),
          uptime_seconds:
            state === "running" && Number.isFinite(startedAt)
              ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
              : null,
        };
      }),
    ).then((services) => services.sort((a, b) => a.name.localeCompare(b.name)));
  }

  private inspectContainer(id: string): Promise<DockerContainerInspect> {
    return this.requestJson<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(id)}/json`);
  }

  async restartService(name: string): Promise<void> {
    this.assertFrameServiceName(name);
    await this.request("POST", `/containers/${encodeURIComponent(name)}/restart?t=10`);
  }

  async streamLogs(
    name: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertFrameServiceName(name);
    const response = await this.openStream(
      `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=150&follow=1&timestamps=1`,
      signal,
    );
    await consumeDockerLogStream(response, onLine, signal);
  }

  private assertFrameServiceName(name: string): void {
    if (!name.startsWith(this.serviceNamePrefix) || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error("Invalid FRAME service name");
    }
  }

  private async requestJson<T>(method: string, path: string): Promise<T> {
    const response = await this.request(method, path);
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  }

  private request(method: string, path: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        this.requestOptions(method, path),
        (response) => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Docker API returned ${response.statusCode}`));
            response.resume();
            return;
          }
          resolve(response);
        },
      );
      request.on("error", reject);
      request.setTimeout(this.requestTimeoutMs, () => {
        request.destroy(new Error(`Docker API request timed out after ${this.requestTimeoutMs}ms`));
      });
      request.end();
    });
  }

  private openStream(path: string, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.request(this.requestOptions("GET", path), (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`Docker API returned ${response.statusCode}`));
          response.resume();
          return;
        }
        resolve(response);
      });
      const abort = () => request.destroy();
      signal.addEventListener("abort", abort, { once: true });
      request.on("error", (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      request.setTimeout(this.requestTimeoutMs, () => {
        request.destroy(new Error(`Docker API connection timed out after ${this.requestTimeoutMs}ms`));
      });
      request.on("response", () => request.setTimeout(0));
      request.end();
    });
  }

  private requestOptions(method: string, path: string): http.RequestOptions {
    if (!this.dockerHost) {
      return { socketPath: this.socketPath, path, method };
    }

    const dockerUrl = new URL(this.dockerHost);
    if (dockerUrl.protocol !== "http:") {
      throw new Error("DOCKER_HOST must use http://");
    }
    return {
      hostname: dockerUrl.hostname,
      port: dockerUrl.port ? Number.parseInt(dockerUrl.port, 10) : 80,
      path,
      method,
    };
  }
}

function normalizeName(name: string): string {
  return name.replace(/^\/+/, "");
}

function mapStatus(state: string): ServiceStatus {
  if (state === "running") {
    return "running";
  }
  if (state === "exited" || state === "created" || state === "paused") {
    return "stopped";
  }
  if (state === "dead" || state === "restarting" || state === "removing") {
    return "error";
  }
  return "unknown";
}

function mapHealth(healthStatus: string | undefined, summaryStatus: string): ServiceHealth {
  if (healthStatus === "healthy") {
    return "healthy";
  }
  if (healthStatus === "unhealthy") {
    return "unhealthy";
  }
  if (healthStatus === "starting") {
    return "starting";
  }
  if (summaryStatus.includes("(healthy)")) {
    return "healthy";
  }
  if (summaryStatus.includes("(unhealthy)")) {
    return "unhealthy";
  }
  if (summaryStatus.includes("(health: starting)")) {
    return "starting";
  }
  return "unknown";
}

async function consumeDockerLogStream(
  response: IncomingMessage,
  onLine: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let pending = Buffer.alloc(0);
  let textPending = "";

  const emitText = (text: string) => {
    textPending += text;
    const lines = textPending.split(/\r?\n/);
    textPending = lines.pop() ?? "";
    for (const line of lines) {
      if (line) {
        onLine(line);
      }
    }
  };

  for await (const chunk of response) {
    if (signal.aborted) {
      break;
    }
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (pending.length >= 8) {
      const streamType = pending[0];
      const length = pending.readUInt32BE(4);
      const isMultiplexed = streamType >= 0 && streamType <= 2 && pending[1] === 0 && pending[2] === 0;
      if (!isMultiplexed) {
        emitText(pending.toString("utf8"));
        pending = Buffer.alloc(0);
        break;
      }
      if (pending.length < 8 + length) {
        break;
      }
      emitText(pending.subarray(8, 8 + length).toString("utf8"));
      pending = pending.subarray(8 + length);
    }
  }

  if (pending.length) {
    emitText(pending.toString("utf8"));
  }
  if (textPending) {
    onLine(textPending);
  }
}
