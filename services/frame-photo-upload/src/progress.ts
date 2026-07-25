export type WebUploadPhase = "receiving" | "queued" | "failed";
export type PhotoSourceAdapter = "web_upload" | "ftp" | "belabox_chunked" | "belabox_agent";

export interface WebUploadTransfer {
  transfer_id: string;
  journey_id: string;
  adapter: "web_upload";
  source_adapter: PhotoSourceAdapter;
  phase: WebUploadPhase;
  filename: string;
  bytes_received: number;
  bytes_total: number | null;
  speed_bps: number | null;
  elapsed_ms: number;
  started_at: string;
  updated_at: string;
  error?: string;
}

export interface WebUploadProgressSnapshot {
  schema_version: "1.0";
  sequence: number;
  observed_at: string;
  transfers: WebUploadTransfer[];
}

interface TrackedTransfer extends Omit<WebUploadTransfer, "speed_bps" | "elapsed_ms"> {
  terminal_at_ms: number | null;
}

export class UploadProgressTracker {
  private readonly transfers = new Map<string, TrackedTransfer>();
  private sequence = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly terminalRetentionMs = 15_000,
  ) {}

  begin(
    transferId: string,
    journeyId: string,
    filename: string,
    bytesTotal: number | null,
    sourceAdapter: PhotoSourceAdapter = "web_upload",
  ): void {
    const timestamp = this.now().toISOString();
    this.transfers.set(transferId, {
      transfer_id: transferId,
      journey_id: journeyId,
      adapter: "web_upload",
      source_adapter: sourceAdapter,
      phase: "receiving",
      filename,
      bytes_received: 0,
      bytes_total: validTotal(bytesTotal),
      started_at: timestamp,
      updated_at: timestamp,
      terminal_at_ms: null,
    });
    this.sequence += 1;
  }

  addBytes(transferId: string, bytes: number): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.phase !== "receiving" || !Number.isFinite(bytes) || bytes <= 0) return;
    transfer.bytes_received += bytes;
    transfer.updated_at = this.now().toISOString();
    this.sequence += 1;
  }

  queued(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.phase = "queued";
    if (transfer.bytes_total !== null) transfer.bytes_received = transfer.bytes_total;
    const now = this.now();
    transfer.updated_at = now.toISOString();
    transfer.terminal_at_ms = now.getTime();
    this.sequence += 1;
  }

  failed(transferId: string, error: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.phase = "failed";
    transfer.error = error.slice(0, 160);
    const now = this.now();
    transfer.updated_at = now.toISOString();
    transfer.terminal_at_ms = now.getTime();
    this.sequence += 1;
  }

  snapshot(): WebUploadProgressSnapshot {
    const now = this.now();
    for (const [id, transfer] of this.transfers) {
      if (transfer.terminal_at_ms !== null && now.getTime() - transfer.terminal_at_ms > this.terminalRetentionMs) {
        this.transfers.delete(id);
        this.sequence += 1;
      }
    }
    return {
      schema_version: "1.0",
      sequence: this.sequence,
      observed_at: now.toISOString(),
      transfers: [...this.transfers.values()]
        .sort((left, right) => left.started_at.localeCompare(right.started_at) || left.transfer_id.localeCompare(right.transfer_id))
        .map((transfer) => {
          const { terminal_at_ms: _terminal, ...publicTransfer } = transfer;
          const elapsedMs = Math.max(0, now.getTime() - Date.parse(transfer.started_at));
          return {
            ...publicTransfer,
            elapsed_ms: elapsedMs,
            speed_bps: elapsedMs > 0 ? Math.round((transfer.bytes_received * 1000) / elapsedMs) : null,
          };
        }),
    };
  }
}

function validTotal(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
