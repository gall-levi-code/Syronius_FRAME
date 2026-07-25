export type IngestAdapterId = "web_upload" | "ftp" | "belabox_agent" | "pipeline";
export type IngestPhase = "uploading" | "staged" | "processing" | "published" | "failed";

export interface IngestCapabilities {
  filename: boolean;
  total_bytes: boolean;
  speed: boolean;
  elapsed: boolean;
}

export interface IngestTransfer {
  transfer_id: string;
  journey_id: string;
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
  transport?: string;
  source_adapter?: string;
  transfer_completed_at?: string | null;
  capabilities: IngestCapabilities;
}

export interface IngestJourney extends IngestTransfer {
  adapters: IngestAdapterId[];
  stages: IngestTransfer[];
  transfer_completed_at: string | null;
}

export interface IngestAggregate {
  uploading: number;
  staged: number;
  processing: number;
  published: number;
  failed: number;
  bytes_received: number;
  bytes_total: number | null;
  percent: number | null;
  speed_bps: number | null;
  focus_transfer_id: string | null;
  focus_journey_id: string | null;
}

export interface IngestProgressSnapshot {
  schema_version: "2.0";
  sequence: number;
  observed_at: string;
  received_at: string | null;
  stale: boolean;
  transfers: IngestTransfer[];
  journeys: IngestJourney[];
  aggregate: IngestAggregate;
  adapter_errors?: Partial<Record<IngestAdapterId, string>>;
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
  timerActive?: boolean;
  listeners: Set<() => void>;
  activePollMs: number;
  idlePollMs: number;
}

export class UploadProgressHub {
  private readonly states = new Map<IngestAdapterId, AdapterState>();
  private readonly selections = new Map<() => void, IngestAdapterId[]>();
  private sequence = 0;
  private stopped = false;

  constructor(
    private readonly fetchAdapter: IngestFetcher,
    private readonly now: () => Date = () => new Date(),
    private readonly supplementalAdapters: IngestAdapterId[] = [],
  ) {}

  subscribe(adapters: IngestAdapterId[], activePollMs: number, idlePollMs: number, listener: IngestListener): () => void {
    const selectedAdapters = normalizeAdapters(adapters);
    const normalizedAdapters = normalizeAdapters([...selectedAdapters, ...this.supplementalAdapters]);
    const notify = () => listener(this.combined(normalizedAdapters, selectedAdapters));
    this.selections.set(notify, selectedAdapters);
    const unsubs = normalizedAdapters.map((adapter) => {
      const state = this.stateFor(adapter);
      state.activePollMs = Math.min(state.activePollMs, clampPoll(activePollMs, 200));
      state.idlePollMs = Math.min(state.idlePollMs, clampPoll(idlePollMs, 1000));
      state.listeners.add(notify);
      void this.refresh(adapter);
      return () => state.listeners.delete(notify);
    });
    notify();
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      this.selections.delete(notify);
    };
  }

  async snapshot(adapters: IngestAdapterId[], activePollMs: number, idlePollMs: number): Promise<IngestProgressSnapshot> {
    const selectedAdapters = normalizeAdapters(adapters);
    const normalizedAdapters = normalizeAdapters([...selectedAdapters, ...this.supplementalAdapters]);
    for (const adapter of normalizedAdapters) {
      const state = this.stateFor(adapter);
      state.activePollMs = Math.min(state.activePollMs, clampPoll(activePollMs, 200));
      state.idlePollMs = Math.min(state.idlePollMs, clampPoll(idlePollMs, 1000));
    }
    await Promise.all(normalizedAdapters.map((adapter) => {
      const state = this.stateFor(adapter);
      const active = this.pollingIsActive(state, selectedAdapters);
      const interval = active ? state.activePollMs : state.idlePollMs;
      return state.receivedAt && this.now().getTime() - Date.parse(state.receivedAt) < interval ? Promise.resolve() : this.refresh(adapter);
    }));
    return this.combined(normalizedAdapters, selectedAdapters);
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
      for (const adapter of this.supplementalAdapters) {
        const supplemental = this.states.get(adapter);
        if (supplemental && supplemental !== state) this.schedule(supplemental);
      }
    });
    return state.inflight;
  }

  private schedule(state: AdapterState): void {
    if (this.stopped || state.listeners.size === 0) return;
    const active = this.pollingIsActive(state);
    if (state.timer) {
      if (state.timerActive === active) return;
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.timerActive = active;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.timerActive = undefined;
      void this.refresh(state.adapter);
    }, active ? state.activePollMs : state.idlePollMs);
  }

  private pollingIsActive(state: AdapterState, selectedAdapters?: IngestAdapterId[]): boolean {
    if (!this.supplementalAdapters.includes(state.adapter)) {
      return state.transfers.some((transfer) => isActivePhase(transfer.phase));
    }
    const selections = selectedAdapters ? [selectedAdapters] : [...state.listeners]
      .map((notify) => this.selections.get(notify))
      .filter((selection): selection is IngestAdapterId[] => Boolean(selection));
    return selections.some((selection) => {
      const adapters = normalizeAdapters([...selection, ...this.supplementalAdapters]);
      return this.combined(adapters, selection).journeys.some((journey) => isActivePhase(journey.phase));
    });
  }

  private combined(adapters: IngestAdapterId[], selectedAdapters: IngestAdapterId[]): IngestProgressSnapshot {
    const states = adapters.map((adapter) => this.stateFor(adapter));
    const selectedStates = selectedAdapters.map((adapter) => this.stateFor(adapter));
    const transfers = states.flatMap((state) => state.transfers
      .filter((transfer) => isVisibleTransfer(transfer)
        && observationMatchesSelection(state.adapter, transfer.source_adapter, selectedAdapters)))
      .sort((left, right) => left.started_at.localeCompare(right.started_at) || left.transfer_id.localeCompare(right.transfer_id));
    const receivedTimes = selectedStates.map((state) => state.receivedAt).filter((value): value is string => Boolean(value));
    const receivedAt = receivedTimes.sort().at(-1) ?? null;
    const stale = !receivedAt || this.now().getTime() - Date.parse(receivedAt) > 5_000;
    const errors = selectedStates.map((state) => state.error).filter(Boolean);
    const adapterErrors = Object.fromEntries(states.flatMap((state) => state.error ? [[state.adapter, state.error]] : []));
    const journeys = reduceJourneys(transfers);
    return {
      schema_version: "2.0",
      sequence: this.sequence,
      observed_at: this.now().toISOString(),
      received_at: receivedAt,
      stale,
      transfers,
      journeys,
      aggregate: aggregateJourneys(journeys),
      ...(Object.keys(adapterErrors).length ? { adapter_errors: adapterErrors } : {}),
      ...(errors.length === selectedStates.length ? { error: errors.join("; ") } : {}),
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
  return aggregateJourneys(reduceJourneys(transfers));
}

export function aggregateJourneys(journeys: IngestJourney[]): IngestAggregate {
  const byPhase = (phase: IngestPhase) => journeys.filter((journey) => journey.phase === phase);
  const uploading = byPhase("uploading");
  const focus = byPhase("processing")[0] ?? byPhase("staged")[0] ?? uploading[0] ?? byPhase("failed")[0] ?? null;
  const allTotalsKnown = uploading.length > 0 && uploading.every((transfer) => transfer.bytes_total !== null);
  const bytesReceived = uploading.reduce((total, transfer) => total + transfer.bytes_received, 0);
  const bytesTotal = allTotalsKnown ? uploading.reduce((total, transfer) => total + (transfer.bytes_total ?? 0), 0) : null;
  const speedValues = uploading.map((transfer) => transfer.speed_bps).filter((value): value is number => value !== null);
  return {
    uploading: uploading.length,
    staged: byPhase("staged").length,
    processing: byPhase("processing").length,
    published: byPhase("published").length,
    failed: byPhase("failed").length,
    bytes_received: bytesReceived,
    bytes_total: bytesTotal,
    percent: bytesTotal && bytesTotal > 0 ? Math.min(100, (bytesReceived / bytesTotal) * 100) : null,
    speed_bps: speedValues.length ? speedValues.reduce((total, value) => total + value, 0) : null,
    focus_transfer_id: focus?.transfer_id ?? null,
    focus_journey_id: focus?.journey_id ?? null,
  };
}

export function reduceJourneys(transfers: IngestTransfer[]): IngestJourney[] {
  const grouped = new Map<string, IngestTransfer[]>();
  for (const transfer of transfers) {
    const journeyId = transfer.journey_id || `legacy:${transfer.adapter}:${transfer.transfer_id}`;
    const stages = grouped.get(journeyId) ?? [];
    stages.push({ ...transfer, journey_id: journeyId });
    grouped.set(journeyId, stages);
  }
  return [...grouped.entries()].map(([journeyId, unsortedStages]) => {
    const stages = [...unsortedStages].sort(compareTransfers);
    const lifecycle = selectLifecycle(stages);
    const telemetry = selectAuthoritative(stages);
    const published = stages
      .filter((stage) => stage.adapter === "pipeline" && stage.phase === "published")
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0];
    const completedAt = published?.transfer_completed_at ?? published?.updated_at ?? null;
    const filename = telemetry.filename ?? stages.find((stage) => stage.filename)?.filename ?? null;
    return {
      ...telemetry,
      journey_id: journeyId,
      phase: lifecyclePhase(lifecycle),
      filename,
      status_text: lifecycle.status_text,
      error: lifecycle.phase === "failed" ? lifecycle.error : undefined,
      started_at: stages.map((stage) => stage.started_at).sort()[0],
      updated_at: stages.map((stage) => stage.updated_at).sort().at(-1)!,
      adapters: [...new Set(stages.map((stage) => stage.adapter))],
      stages,
      transfer_completed_at: completedAt,
    };
  }).sort((left, right) => left.started_at.localeCompare(right.started_at) || left.journey_id.localeCompare(right.journey_id));
}

function normalizeTransfers(raw: unknown, adapter: IngestAdapterId): IngestTransfer[] {
  const transfers = objectValue(raw).transfers;
  if (!Array.isArray(transfers)) return [];
  return transfers.flatMap((value) => {
    const transfer = objectValue(value);
    const transferId = textValue(transfer.transfer_id, 96);
    const sourcePhase = phaseValue(transfer.phase);
    const startedAt = dateValue(transfer.started_at);
    const updatedAt = dateValue(transfer.updated_at);
    if (!transferId || !sourcePhase || !startedAt || !updatedAt) return [];
    const phase = normalizePhase(sourcePhase, adapter);
    const filename = textValue(transfer.filename, 180) || null;
    const bytesReceived = nullableNumber(transfer.bytes_received) ?? 0;
    const bytesTotal = nullableNumber(transfer.bytes_total);
    const speed = nullableNumber(transfer.speed_bps);
    const elapsed = nullableNumber(transfer.elapsed_ms);
    const journeyId = textValue(transfer.journey_id, 128) || `legacy:${adapter}:${transferId}`;
    return [{
      transfer_id: `${adapter}:${transferId}`,
      journey_id: journeyId,
      adapter,
      phase,
      filename,
      bytes_received: bytesReceived,
      bytes_total: bytesTotal,
      speed_bps: speed,
      elapsed_ms: elapsed,
      started_at: startedAt,
      updated_at: updatedAt,
      ...(transfer.status_text ? { status_text: textValue(transfer.status_text, 120) } : {}),
      ...(transfer.error ? { error: textValue(transfer.error, 160) } : {}),
      ...(transfer.transport ? { transport: textValue(transfer.transport, 48) } : {}),
      ...(transfer.source_adapter ? { source_adapter: textValue(transfer.source_adapter, 48) } : {}),
      transfer_completed_at: dateValue(transfer.transfer_completed_at),
      capabilities: { filename: Boolean(filename), total_bytes: bytesTotal !== null, speed: speed !== null, elapsed: elapsed !== null },
    }];
  });
}

function selectAuthoritative(stages: IngestTransfer[]): IngestTransfer {
  return [...stages].sort((left, right) => authorityScore(right) - authorityScore(left)
    || Date.parse(right.updated_at) - Date.parse(left.updated_at)
    || left.transfer_id.localeCompare(right.transfer_id))[0];
}

function authorityScore(stage: IngestTransfer): number {
  return (stage.bytes_total !== null ? 16 : 0)
    + (stage.speed_bps !== null ? 8 : 0)
    + (stage.elapsed_ms !== null ? 4 : 0)
    + (stage.filename ? 2 : 0)
    + (stage.adapter === "belabox_agent" ? 1 : 0);
}

function compareTransfers(left: IngestTransfer, right: IngestTransfer): number {
  return left.started_at.localeCompare(right.started_at) || left.transfer_id.localeCompare(right.transfer_id);
}

function normalizeAdapters(adapters: IngestAdapterId[]): IngestAdapterId[] {
  const supported = adapters.filter((adapter) => adapter === "web_upload" || adapter === "ftp" || adapter === "belabox_agent" || adapter === "pipeline");
  return [...new Set(supported.length ? supported : ["web_upload"])] as IngestAdapterId[];
}

function observationMatchesSelection(
  observer: IngestAdapterId,
  sourceAdapter: string | undefined,
  adapters: IngestAdapterId[],
): boolean {
  if (observer === "pipeline") {
    if (sourceAdapter === "belabox_chunked" || sourceAdapter === "belabox_agent") return adapters.includes("belabox_agent");
    return sourceAdapter === "web_upload" ? adapters.includes("web_upload") : sourceAdapter === "ftp" ? adapters.includes("ftp") : false;
  }
  if (observer === "web_upload") return !sourceAdapter || sourceAdapter === "web_upload";
  if (observer === "ftp") return !sourceAdapter || sourceAdapter === "ftp";
  return true;
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

function phaseValue(value: unknown): string | null {
  return value === "receiving" || value === "queued" || value === "uploading" || value === "staged"
    || value === "processing" || value === "published" || value === "failed" ? value : null;
}

function normalizePhase(phase: string, adapter: IngestAdapterId): IngestPhase {
  if (phase === "receiving") return "uploading";
  if (phase === "queued" || phase === "published" && adapter !== "pipeline") return "staged";
  return phase as IngestPhase;
}

function lifecyclePhase(stage: IngestTransfer): IngestPhase {
  return stage.phase === "published" && stage.adapter !== "pipeline" ? "staged" : stage.phase;
}

function selectLifecycle(stages: IngestTransfer[]): IngestTransfer {
  const pipeline = stages.filter((stage) => stage.adapter === "pipeline");
  if (pipeline.length) return [...pipeline].sort((left, right) =>
    Date.parse(right.updated_at) - Date.parse(left.updated_at)
    || left.transfer_id.localeCompare(right.transfer_id))[0];
  return [...stages].sort((left, right) =>
    phaseRank(lifecyclePhase(right)) - phaseRank(lifecyclePhase(left))
    || Date.parse(right.updated_at) - Date.parse(left.updated_at)
    || left.transfer_id.localeCompare(right.transfer_id))[0];
}

function phaseRank(phase: IngestPhase): number {
  return phase === "uploading" ? 0 : phase === "staged" ? 1 : phase === "processing" ? 2 : 3;
}

function isActivePhase(phase: IngestPhase): boolean {
  return phase !== "published" && phase !== "failed";
}

function isVisibleTransfer(transfer: IngestTransfer): boolean {
  return transfer.adapter !== "belabox_agent" || transfer.phase !== "processing" || transfer.bytes_received > 0;
}

function clampPoll(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(10_000, Math.max(200, value)) : fallback;
}
