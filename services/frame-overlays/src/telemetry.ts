export interface StreamPublisherStats {
  connected: boolean;
  bitrate: number;
  rtt: number | null;
  latency: number | null;
  buffer: number | null;
  dropped_pkts: number;
  uptime: number;
  recovery_rate: number | null;
}

export interface TelemetrySnapshot {
  sequence: number;
  observed_at: string;
  received_at: string | null;
  stale: boolean;
  connected: boolean;
  publisher: StreamPublisherStats | null;
  error?: string;
}

export type StatsFetcher = (streamProfileId: string) => Promise<unknown>;
export type TelemetryListener = (snapshot: TelemetrySnapshot) => void;

interface StreamState {
  streamProfileId: string;
  sequence: number;
  snapshot: TelemetrySnapshot | null;
  listeners: Set<TelemetryListener>;
  pollMs: number;
  timer?: NodeJS.Timeout;
  inflight?: Promise<TelemetrySnapshot>;
  stopped: boolean;
}

export class TelemetryHub {
  private readonly streams = new Map<string, StreamState>();

  constructor(
    private readonly fetchStats: StatsFetcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  subscribe(streamProfileId: string, pollMs: number, listener: TelemetryListener): () => void {
    const state = this.stateFor(streamProfileId);
    state.listeners.add(listener);
    state.pollMs = Math.min(state.pollMs, clampPollMs(pollMs));
    state.stopped = false;
    if (state.snapshot) listener(this.withCurrentStaleState(state));
    void this.refresh(streamProfileId);
    return () => {
      state.listeners.delete(listener);
      if (state.listeners.size === 0) {
        state.stopped = true;
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
      }
    };
  }

  async snapshot(streamProfileId: string, pollMs: number): Promise<TelemetrySnapshot> {
    const state = this.stateFor(streamProfileId);
    state.pollMs = Math.min(state.pollMs, clampPollMs(pollMs));
    const current = state.snapshot && this.withCurrentStaleState(state);
    if (current && this.now().getTime() - Date.parse(current.observed_at) < state.pollMs) return current;
    return this.refresh(streamProfileId);
  }

  async refresh(streamProfileId: string): Promise<TelemetrySnapshot> {
    const state = this.stateFor(streamProfileId);
    if (state.inflight) return state.inflight;
    state.inflight = this.performRefresh(state).finally(() => {
      state.inflight = undefined;
      this.schedule(state);
    });
    return state.inflight;
  }

  stop(): void {
    for (const state of this.streams.values()) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
    }
  }

  private async performRefresh(state: StreamState): Promise<TelemetrySnapshot> {
    state.sequence += 1;
    const observedAt = this.now().toISOString();
    try {
      const raw = await this.fetchStats(state.streamProfileId);
      const publisher = normalizePublisher(raw);
      state.snapshot = {
        sequence: state.sequence,
        observed_at: observedAt,
        received_at: publisher ? observedAt : state.snapshot?.received_at ?? null,
        stale: false,
        connected: Boolean(publisher?.connected),
        publisher,
      };
    } catch (error) {
      const previous = state.snapshot;
      state.snapshot = {
        sequence: state.sequence,
        observed_at: observedAt,
        received_at: previous?.received_at ?? null,
        stale: isStale(previous?.received_at ?? null, state.pollMs, this.now()),
        connected: previous?.connected ?? false,
        publisher: previous?.publisher ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const snapshot = this.withCurrentStaleState(state);
    for (const listener of state.listeners) listener(snapshot);
    return snapshot;
  }

  private schedule(state: StreamState): void {
    if (state.stopped || state.listeners.size === 0 || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.refresh(state.streamProfileId);
    }, state.pollMs);
  }

  private withCurrentStaleState(state: StreamState): TelemetrySnapshot {
    const snapshot = state.snapshot!;
    return {
      ...snapshot,
      stale: snapshot.stale || isStale(snapshot.received_at, state.pollMs, this.now()),
    };
  }

  private stateFor(streamProfileId: string): StreamState {
    let state = this.streams.get(streamProfileId);
    if (!state) {
      state = {
        streamProfileId,
        sequence: 0,
        snapshot: null,
        listeners: new Set(),
        pollMs: 2000,
        stopped: true,
      };
      this.streams.set(streamProfileId, state);
    }
    return state;
  }
}

export function normalizePublisher(raw: unknown): StreamPublisherStats | null {
  const publisher = objectValue(objectValue(raw).publisher);
  if (!Object.keys(publisher).length) return null;
  return {
    connected: publisher.connected !== false,
    bitrate: finiteNumber(publisher.bitrate, 0)!,
    rtt: finiteNumber(publisher.rtt, null),
    latency: finiteNumber(publisher.latency, null),
    buffer: finiteNumber(publisher.buffer, null),
    dropped_pkts: finiteNumber(publisher.dropped_pkts, 0)!,
    uptime: finiteNumber(publisher.uptime, 0)!,
    recovery_rate: finiteNumber(publisher.recovery_rate, null),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPollMs(value: number): number {
  return Number.isFinite(value) ? Math.min(2_000, Math.max(20, value)) : 1000;
}

function isStale(receivedAt: string | null, pollMs: number, now: Date): boolean {
  if (!receivedAt) return true;
  return now.getTime() - Date.parse(receivedAt) > Math.max(5_000, pollMs * 3);
}
