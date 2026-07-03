export type IngestAdapterId = "web_upload" | "ftp" | "belabox_agent";
export type IngestPhase = "receiving" | "queued" | "processing" | "published" | "failed";

export interface IngestCapabilities {
  filename: boolean;
  total_bytes: boolean;
  speed: boolean;
  elapsed: boolean;
}

export interface IngestTransfer {
  transfer_id: string;
  adapter: IngestAdapterId;
  phase: IngestPhase;
  filename: string | null;
  bytes_received: number;
  bytes_total: number | null;
  speed_bps: number | null;
  elapsed_ms: number | null;
  started_at: string;
  updated_at: string;
  status_text?: string;
  error?: string;
  capabilities: IngestCapabilities;
}

export interface IngestAggregate {
  receiving: number;
  queued: number;
  processing: number;
  published: number;
  failed: number;
  bytes_received: number;
  bytes_total: number | null;
  percent: number | null;
  speed_bps: number | null;
  focus_transfer_id: string | null;
}

export interface IngestProgressSnapshot {
  sequence: number;
  observed_at: string;
  received_at: string | null;
  stale: boolean;
  transfers: IngestTransfer[];
  aggregate: IngestAggregate;
  error?: string;
}

export type IngestFetcher = (adapter: IngestAdapterId) => Promise<unknown>;
export type IngestListener = (snapshot: IngestProgressSnapshot) => void;

interface AdapterState {
  adapter: IngestAdapterId;
  transfers: IngestTransfer[];
  receivedAt: string | null;
  error?: string;
  inflight?: Promise<void>;
  timer?: NodeJS.Timeout;
  listeners: Set<() => void>;
  activePollMs: number;
  idlePollMs: number;
}

export class UploadProgressHub {
  private readonly states = new Map<IngestAdapterId, AdapterState>();
  private sequence = 0;
  private stopped = false;

  constructor(
    private readonly fetchAdapter: IngestFetcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  subscribe(adapters: IngestAdapterId[], activePollMs: number, idlePollMs: number, listener: IngestListener): () => void {
    const normalizedAdapters = normalizeAdapters(adapters);
    const notify = () => listener(this.combined(normalizedAdapters));
    const unsubs = normalizedAdapters.map((adapter) => {
      const state = this.stateFor(adapter);
      state.activePollMs = Math.min(state.activePollMs, clampPoll(activePollMs, 200));
      state.idlePollMs = Math.min(state.idlePollMs, clampPoll(idlePollMs, 1000));
      state.listeners.add(notify);
      void this.refresh(adapter);
      return () => state.listeners.delete(notify);
    });
    notify();
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }

  async snapshot(adapters: IngestAdapterId[], activePollMs: number, idlePollMs: number): Promise<IngestProgressSnapshot> {
    const normalizedAdapters = normalizeAdapters(adapters);
    for (const adapter of normalizedAdapters) {
      const state = this.stateFor(adapter);
      state.activePollMs = Math.min(state.activePollMs, clampPoll(activePollMs, 200));
      state.idlePollMs = Math.min(state.idlePollMs, clampPoll(idlePollMs, 1000));
    }
    await Promise.all(normalizedAdapters.map((adapter) => {
      const state = this.stateFor(adapter);
      const active = state.transfers.some((transfer) => transfer.phase === "receiving");
      const interval = active ? state.activePollMs : state.idlePollMs;
      return state.receivedAt && this.now().getTime() - Date.parse(state.receivedAt) < interval ? Promise.resolve() : this.refresh(adapter);
    }));
    return this.combined(normalizedAdapters);
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) if (state.timer) clearTimeout(state.timer);
  }

  private async refresh(adapter: IngestAdapterId): Promise<void> {
    const state = this.stateFor(adapter);
    if (state.inflight) return state.inflight;
    state.inflight = (async () => {
      try {
        state.transfers = normalizeTransfers(await this.fetchAdapter(adapter), adapter);
        state.receivedAt = this.now().toISOString();
        state.error = undefined;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.sequence += 1;
        for (const notify of state.listeners) notify();
      }
    })().finally(() => {
      state.inflight = undefined;
      this.schedule(state);
    });
    return state.inflight;
  }

  private schedule(state: AdapterState): void {
    if (this.stopped || state.timer || state.listeners.size === 0) return;
    const active = state.transfers.some((transfer) => transfer.phase === "receiving");
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.refresh(state.adapter);
    }, active ? state.activePollMs : state.idlePollMs);
  }

  private combined(adapters: IngestAdapterId[]): IngestProgressSnapshot {
    const states = adapters.map((adapter) => this.stateFor(adapter));
    const transfers = states.flatMap((state) => state.transfers)
      .sort((left, right) => left.started_at.localeCompare(right.started_at) || left.transfer_id.localeCompare(right.transfer_id));
    const receivedTimes = states.map((state) => state.receivedAt).filter((value): value is string => Boolean(value));
    const receivedAt = receivedTimes.sort().at(-1) ?? null;
    const stale = !receivedAt || this.now().getTime() - Date.parse(receivedAt) > 5_000;
    const errors = states.map((state) => state.error).filter(Boolean);
    return {
      sequence: this.sequence,
      observed_at: this.now().toISOString(),
      received_at: receivedAt,
      stale,
      transfers,
      aggregate: aggregateTransfers(transfers),
      ...(errors.length === states.length ? { error: errors.join("; ") } : {}),
    };
  }

  private stateFor(adapter: IngestAdapterId): AdapterState {
    let state = this.states.get(adapter);
    if (!state) {
      state = { adapter, transfers: [], receivedAt: null, listeners: new Set(), activePollMs: 2_000, idlePollMs: 10_000 };
      this.states.set(adapter, state);
    }
    return state;
  }
}

export function aggregateTransfers(transfers: IngestTransfer[]): IngestAggregate {
  const byPhase = (phase: IngestPhase) => transfers.filter((transfer) => transfer.phase === phase);
  const receiving = byPhase("receiving");
  const focus = receiving[0] ?? byPhase("processing")[0] ?? byPhase("queued")[0] ?? byPhase("failed")[0] ?? null;
  const allTotalsKnown = receiving.length > 0 && receiving.every((transfer) => transfer.bytes_total !== null);
  const bytesReceived = receiving.reduce((total, transfer) => total + transfer.bytes_received, 0);
  const bytesTotal = allTotalsKnown ? receiving.reduce((total, transfer) => total + (transfer.bytes_total ?? 0), 0) : null;
  const speedValues = receiving.map((transfer) => transfer.speed_bps).filter((value): value is number => value !== null);
  return {
    receiving: receiving.length,
    queued: byPhase("queued").length,
    processing: byPhase("processing").length,
    published: byPhase("published").length,
    failed: byPhase("failed").length,
    bytes_received: bytesReceived,
    bytes_total: bytesTotal,
    percent: bytesTotal && bytesTotal > 0 ? Math.min(100, (bytesReceived / bytesTotal) * 100) : null,
    speed_bps: speedValues.length ? speedValues.reduce((total, value) => total + value, 0) : null,
    focus_transfer_id: focus?.transfer_id ?? null,
  };
}

function normalizeTransfers(raw: unknown, adapter: IngestAdapterId): IngestTransfer[] {
  const transfers = objectValue(raw).transfers;
  if (!Array.isArray(transfers)) return [];
  return transfers.flatMap((value) => {
    const transfer = objectValue(value);
    const transferId = textValue(transfer.transfer_id, 96);
    const phase = phaseValue(transfer.phase);
    const startedAt = dateValue(transfer.started_at);
    const updatedAt = dateValue(transfer.updated_at);
    if (!transferId || !phase || !startedAt || !updatedAt) return [];
    const filename = textValue(transfer.filename, 180) || null;
    const bytesTotal = nullableNumber(transfer.bytes_total);
    const speed = nullableNumber(transfer.speed_bps);
    const elapsed = nullableNumber(transfer.elapsed_ms);
    return [{
      transfer_id: `${adapter}:${transferId}`,
      adapter,
      phase,
      filename,
      bytes_received: nullableNumber(transfer.bytes_received) ?? 0,
      bytes_total: bytesTotal,
      speed_bps: speed,
      elapsed_ms: elapsed,
      started_at: startedAt,
      updated_at: updatedAt,
      ...(transfer.status_text ? { status_text: textValue(transfer.status_text, 120) } : {}),
      ...(transfer.error ? { error: textValue(transfer.error, 160) } : {}),
      capabilities: { filename: Boolean(filename), total_bytes: bytesTotal !== null, speed: speed !== null, elapsed: elapsed !== null },
    }];
  });
}

function normalizeAdapters(adapters: IngestAdapterId[]): IngestAdapterId[] {
  const supported = adapters.filter((adapter) => adapter === "web_upload" || adapter === "ftp" || adapter === "belabox_agent");
  return [...new Set(supported.length ? supported : ["web_upload"])] as IngestAdapterId[];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function textValue(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function dateValue(value: unknown): string | null {
  const text = textValue(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function phaseValue(value: unknown): IngestPhase | null {
  return value === "receiving" || value === "queued" || value === "processing" || value === "published" || value === "failed" ? value : null;
}

function clampPoll(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(10_000, Math.max(200, value)) : fallback;
}
