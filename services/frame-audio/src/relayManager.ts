import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RawData, WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import { errorContext, logAudio } from "./logger.js";
import { AudioStreamStore, type AudioStreamConfig, StoreError } from "./store.js";

type RelayMode = "offline" | "silence" | "publisher";
export const PUBLISHER_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const PUBLISHER_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const PUBLISHER_MAX_PENDING_CHUNKS = 128;
const PUBLISHER_STALL_MS = 10_000;

interface RelayRuntime {
  mode: RelayMode;
  deleting?: boolean;
  process?: ChildProcessWithoutNullStreams;
  publisherSocket?: WebSocket;
  publisherCleanup?: () => void;
  startToken?: symbol;
  startedAt?: string;
  lastError?: string;
  inputBytes: number;
  inputKbps: number;
  bitrateKbps?: number;
  bitrateTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
}

export interface RelayStatus {
  streamId: string;
  instanceId: string;
  name: string;
  bitrateKbps: number;
  activeBitrateKbps: number;
  listenerLimit: number;
  alwaysOn: boolean;
  generation: number;
  mode: RelayMode;
  publisherActive: boolean;
  listenerCount: number;
  inputKbps: number;
  playlistReady: boolean;
  playlistUrl: string;
  captureUrl: string;
  listenUrl: string;
  startedAt?: string;
  lastError?: string;
}

export class RelayManager {
  private readonly runtimes = new Map<string, RelayRuntime>();
  private readonly listeners = new Map<string, Map<string, number>>();
  private readonly listenerCleanupTimer: NodeJS.Timeout;
  private closed = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly store: AudioStreamStore,
    private readonly spawnEncoder: typeof spawn = spawn,
  ) {
    this.listenerCleanupTimer = setInterval(() => this.cleanupListeners(), 10_000);
    this.listenerCleanupTimer.unref();
  }

  public async init(): Promise<void> {
    const hlsRoot = path.join(this.config.dataRoot, "hls");
    await mkdir(hlsRoot, { recursive: true });
    const streams = this.store.list();
    logAudio("info", "initializing audio relays", { streamCount: streams.length, hlsRoot });
    const streamIds = new Set(streams.map((stream) => stream.streamId));
    const entries = await readdir(hlsRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !streamIds.has(entry.name))
      .map((entry) => rm(path.join(hlsRoot, entry.name), { recursive: true, force: true })));
    for (const stream of streams) {
      await this.reconcile(stream);
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.listenerCleanupTimer);
    logAudio("info", "closing audio relays", { runtimeCount: this.runtimes.size });
    for (const runtime of this.runtimes.values()) {
      const socket = runtime.publisherSocket;
      runtime.publisherSocket = undefined;
      this.stopRuntime(runtime);
      socket?.close(1001, "Service stopping");
    }
    this.runtimes.clear();
  }

  public async reconcile(stream: AudioStreamConfig): Promise<void> {
    if (this.closed) return;
    const runtime = this.runtime(stream.streamId);
    if (runtime.deleting) return;
    if (runtime.publisherSocket) return;
    if (stream.alwaysOn && (!runtime.process || runtime.bitrateKbps !== stream.bitrateKbps)) {
      await this.startRelay(stream, runtime, "silence");
    } else if (!stream.alwaysOn && runtime.mode === "silence") {
      this.stopRuntime(runtime);
    }
  }

  public async attachPublisher(streamId: string, socket: WebSocket): Promise<void> {
    if (this.closed) throw new StoreError(503, "Audio service is stopping.");
    const stream = this.store.get(streamId);
    if (!stream) throw new StoreError(404, "Audio source not found.");
    const runtime = this.runtime(streamId);
    if (runtime.deleting) throw new StoreError(409, "This audio source is being deleted.");
    if (runtime.publisherSocket) {
      logAudio("warn", "publisher rejected because one is already active", { streamId });
      throw new StoreError(409, "This audio source already has an active publisher.");
    }

    runtime.publisherSocket = socket;
    logAudio("info", "publisher connected", { streamId, previousMode: runtime.mode });
    // startRelay stops the previous encoder before these publisher handlers are installed.
    const starting = this.startRelay(stream, runtime, "publisher");
    let input: ChildProcessWithoutNullStreams["stdin"] | undefined;
    let chunks: Buffer[] = [];
    let pendingBytes = 0;
    let blocked = false;
    let detached = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const reject = (message: string, code = 1013) => {
      if (detached) return;
      runtime.lastError = message;
      logAudio("warn", "publisher disconnected", { streamId, reason: message });
      void this.publisherClosed(streamId, socket);
      socket.close(code, message);
    };
    const pause = () => {
      socket.pause();
      stallTimer ??= setTimeout(() => reject("Audio encoder stalled for 10 seconds"), PUBLISHER_STALL_MS);
      stallTimer.unref();
    };
    const flush = () => {
      if (detached || !input || blocked) return;
      while (chunks.length) {
        const chunk = chunks.shift()!;
        pendingBytes -= chunk.length;
        runtime.inputBytes += chunk.length;
        if (!input.write(chunk)) {
          blocked = true;
          pause();
          return;
        }
      }
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
      socket.resume();
    };
    const onDrain = () => {
      blocked = false;
      flush();
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (detached || !isBinary) return;
      const bytes = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.length, 0) : data.byteLength;
      if (!bytes) return;
      if (bytes > PUBLISHER_MAX_MESSAGE_BYTES) {
        reject("Capture message exceeds 2 MiB", 1009);
        return;
      }
      // ws can emit messages already decoded before pause(); account for those as well as stdin.
      if (pendingBytes + (input?.writableLength ?? 0) + bytes > PUBLISHER_MAX_BUFFER_BYTES || chunks.length >= PUBLISHER_MAX_PENDING_CHUNKS) {
        reject("Audio encoder capture buffer limit exceeded");
        return;
      }
      chunks.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data));
      pendingBytes += bytes;
      flush();
    };
    const onError = (error: Error) => {
      if (detached) return;
      logAudio("warn", "publisher websocket error", { streamId, ...errorContext(error) });
      reject("Publisher WebSocket failed", 1011);
    };
    const onClose = () => {
      socket.off("error", onError);
      void this.publisherClosed(streamId, socket);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
    runtime.publisherCleanup = () => {
      detached = true;
      if (stallTimer) clearTimeout(stallTimer);
      input?.off("drain", onDrain);
      socket.off("message", onMessage);
      // Keep the once-only transport handlers until close, including late errors during shutdown.
      chunks = [];
      pendingBytes = 0;
      socket.resume();
    };
    pause();

    try {
      const child = await starting;
      if (detached || !child || runtime.publisherSocket !== socket) return;
      input = child.stdin;
      input.on("drain", onDrain);
      flush();
    } catch (error) {
      if (detached) return;
      reject("Unable to start audio encoder", 1011);
      logAudio("error", "publisher relay start failed", { streamId, ...errorContext(error) });
      throw error;
    }
  }

  public async deleteStream(streamId: string): Promise<void> {
    const runtime = this.runtimes.get(streamId);
    if (runtime) {
      runtime.deleting = true;
      logAudio("info", "deleting audio source runtime", { streamId });
      runtime.publisherSocket?.close(1001, "Audio source deleted");
      await this.stopRuntimeAndWait(runtime);
      this.runtimes.delete(streamId);
    }
    this.listeners.delete(streamId);
    await rm(path.join(this.config.dataRoot, "hls", streamId), { recursive: true, force: true });
  }

  public heartbeat(streamId: string, listenerId: string): number {
    const stream = this.store.get(streamId);
    if (!stream) throw new StoreError(404, "Audio source not found.");
    const listeners = this.listeners.get(streamId) ?? new Map<string, number>();
    if (!listeners.has(listenerId) && listeners.size >= stream.listenerLimit) {
      throw new StoreError(429, "This audio source has reached its listener limit.");
    }
    listeners.set(listenerId, Date.now());
    this.listeners.set(streamId, listeners);
    this.cleanupListeners();
    return listeners.size;
  }

  public async status(stream: AudioStreamConfig): Promise<RelayStatus> {
    const runtime = this.runtime(stream.streamId);
    const playlistPath = path.join(this.generationPath(stream), "index.m3u8");
    const playlistReady = await access(playlistPath).then(() => true).catch(() => false);
    return {
      streamId: stream.streamId,
      instanceId: stream.instanceId,
      name: stream.name,
      bitrateKbps: stream.bitrateKbps,
      activeBitrateKbps: runtime.bitrateKbps ?? stream.bitrateKbps,
      listenerLimit: stream.listenerLimit,
      alwaysOn: stream.alwaysOn,
      generation: stream.generation,
      mode: runtime.mode,
      publisherActive: Boolean(runtime.publisherSocket),
      listenerCount: this.listeners.get(stream.streamId)?.size ?? 0,
      inputKbps: runtime.inputKbps,
      playlistReady,
      playlistUrl: `/audio/hls/${encodeURIComponent(stream.streamId)}/${stream.generation}/index.m3u8`,
      captureUrl: `${this.config.captureBaseUrl}/audio/capture/${encodeURIComponent(stream.streamId)}`,
      listenUrl: `${this.config.publicBaseUrl}/audio/listen/${encodeURIComponent(stream.streamId)}`,
      ...(runtime.startedAt ? { startedAt: runtime.startedAt } : {}),
      ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
    };
  }

  private async publisherClosed(streamId: string, socket: WebSocket): Promise<void> {
    const runtime = this.runtimes.get(streamId);
    if (!runtime || runtime.deleting || runtime.publisherSocket !== socket) return;
    runtime.publisherSocket = undefined;
    this.stopRuntime(runtime);
    logAudio("info", "publisher disconnected", { streamId });
    const stream = this.store.get(streamId);
    if (stream?.alwaysOn) await this.startRelay(stream, runtime, "silence").catch((error) => this.scheduleRestart(streamId, error));
  }

  private async startRelay(stream: AudioStreamConfig, runtime: RelayRuntime, mode: Exclude<RelayMode, "offline">): Promise<ChildProcessWithoutNullStreams | undefined> {
    if (this.closed) return;
    this.stopRuntime(runtime);
    const startToken = runtime.startToken = Symbol();
    const current = await this.store.nextGeneration(stream.streamId);
    const outputDirectory = this.generationPath(current);
    await mkdir(outputDirectory, { recursive: true });
    await this.cleanupGenerations(current);
    if (runtime.startToken !== startToken || runtime.deleting) return;
    runtime.startToken = undefined;
    logAudio("info", "starting audio relay", {
      streamId: stream.streamId,
      mode,
      bitrateKbps: current.bitrateKbps,
      generation: current.generation,
      outputDirectory,
    });

    const inputArgs = mode === "silence"
      ? ["-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
      : ["-i", "pipe:0"];
    const audioFilterArgs = mode === "publisher"
      ? ["-af", "aresample=async=1000:first_pts=0"]
      : [];
    const playlistPath = path.join(outputDirectory, "index.m3u8");
    const segmentPath = path.join(outputDirectory, "segment-%05d.ts");
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      ...inputArgs,
      "-vn",
      ...audioFilterArgs,
      "-c:a", "aac",
      "-b:a", `${current.bitrateKbps}k`,
      "-ar", "48000",
      "-ac", "2",
      "-f", "hls",
      "-hls_time", "1",
      "-hls_list_size", "30",
      "-hls_delete_threshold", "5",
      "-hls_flags", "delete_segments+omit_endlist+program_date_time",
      "-hls_segment_filename", segmentPath,
      playlistPath,
    ];
    const child = this.spawnEncoder(this.config.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdout.resume();
    runtime.process = child;
    runtime.mode = mode;
    runtime.startedAt = new Date().toISOString();
    runtime.lastError = undefined;
    runtime.inputBytes = 0;
    runtime.inputKbps = 0;
    runtime.bitrateKbps = current.bitrateKbps;
    runtime.bitrateTimer = setInterval(() => {
      runtime.inputKbps = Math.round((runtime.inputBytes * 8) / 1000);
      runtime.inputBytes = 0;
    }, 1000);
    runtime.bitrateTimer.unref();

    child.stderr.on("data", (data: Buffer) => {
      if (runtime.process !== child) return;
      const text = data.toString("utf8").trim();
      if (text) {
        runtime.lastError = text.slice(-500);
        logAudio("error", "ffmpeg stderr", { streamId: stream.streamId, mode, stderr: runtime.lastError });
      }
    });
    child.once("error", (error) => {
      exited(null, null, `ffmpeg: ${error.message}`);
    });
    // stdin may emit a late EPIPE after stopRuntime; the process identity guard makes it harmless.
    child.stdin.on("error", (error) => exited(null, null, `ffmpeg input: ${error.message}`));
    child.once("exit", (code, signal) => exited(code, signal));
    const exited = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (runtime.process !== child) return;
      runtime.lastError = error ?? runtime.lastError ?? `ffmpeg exited (${code ?? signal ?? "unknown"}).`;
      const socket = runtime.publisherSocket;
      runtime.publisherSocket = undefined;
      this.stopRuntime(runtime);
      socket?.close(1011, "Audio encoder stopped");
      logAudio(code === 0 ? "info" : "error", "audio relay exited", {
        streamId: stream.streamId,
        mode,
        code,
        signal,
        lastError: runtime.lastError,
      });
      const latest = this.store.get(stream.streamId);
      if (!runtime.deleting && latest?.alwaysOn) this.scheduleRestart(stream.streamId, runtime.lastError);
    };
    return child;
  }

  private stopRuntime(runtime: RelayRuntime): void {
    runtime.startToken = undefined;
    runtime.publisherCleanup?.();
    runtime.publisherCleanup = undefined;
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    if (runtime.bitrateTimer) clearInterval(runtime.bitrateTimer);
    runtime.restartTimer = undefined;
    runtime.bitrateTimer = undefined;
    const child = runtime.process;
    runtime.process = undefined;
    runtime.mode = "offline";
    runtime.startedAt = undefined;
    runtime.inputKbps = 0;
    runtime.bitrateKbps = undefined;
    if (child) {
      child.stdin.destroy();
      child.kill("SIGTERM");
    }
  }

  private async stopRuntimeAndWait(runtime: RelayRuntime): Promise<void> {
    const child = runtime.process;
    if (!child) {
      this.stopRuntime(runtime);
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.stopRuntime(runtime);
    if (child.exitCode !== null) return;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (!stopped && child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }

  private scheduleRestart(streamId: string, error: unknown): void {
    if (this.closed) return;
    const runtime = this.runtime(streamId);
    if (runtime.deleting) return;
    runtime.lastError = error instanceof Error ? error.message : String(error);
    if (runtime.restartTimer) return;
    logAudio("warn", "scheduling audio relay restart", { streamId, error: runtime.lastError, delayMs: 2_000 });
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = undefined;
      const stream = this.store.get(streamId);
      if (!runtime.deleting && stream?.alwaysOn && !runtime.publisherSocket && !runtime.process) {
        void this.startRelay(stream, runtime, "silence").catch((nextError) => this.scheduleRestart(streamId, nextError));
      }
    }, 2_000);
    runtime.restartTimer.unref();
  }

  private runtime(streamId: string): RelayRuntime {
    const runtime = this.runtimes.get(streamId) ?? {
      mode: "offline" as const,
      inputBytes: 0,
      inputKbps: 0,
    };
    this.runtimes.set(streamId, runtime);
    return runtime;
  }

  private generationPath(stream: Pick<AudioStreamConfig, "streamId" | "generation">): string {
    return path.join(this.config.dataRoot, "hls", stream.streamId, String(stream.generation));
  }

  private async cleanupGenerations(stream: AudioStreamConfig): Promise<void> {
    const root = path.join(this.config.dataRoot, "hls", stream.streamId);
    const entries = await readdir(root, { withFileTypes: true });
    const generations = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((left, right) => right - left);
    await Promise.all(generations.slice(3).map((generation) => rm(path.join(root, String(generation)), { recursive: true, force: true })));
  }

  private cleanupListeners(): void {
    const cutoff = Date.now() - 15_000;
    for (const [streamId, listeners] of this.listeners) {
      for (const [listenerId, lastSeen] of listeners) {
        if (lastSeen < cutoff) listeners.delete(listenerId);
      }
      if (listeners.size === 0) this.listeners.delete(streamId);
    }
  }
}
