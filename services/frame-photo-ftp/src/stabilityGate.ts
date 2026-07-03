import { createHash } from "node:crypto";
import { access, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

interface Observation {
  transferId: string;
  filename: string;
  size: number;
  mtimeMs: number;
  unchangedSince: number;
  startedAt: string;
  updatedAt: string;
  lastSampleAt: number;
  speedBps: number | null;
}

export interface StabilityStatus {
  observed: number;
  staged: number;
  last_staged_at: string | null;
  last_error: string | null;
}

export interface FtpProgressTransfer {
  transfer_id: string;
  adapter: "ftp";
  phase: "receiving" | "queued";
  filename: string;
  bytes_received: number;
  bytes_total: null;
  speed_bps: number | null;
  elapsed_ms: number;
  started_at: string;
  updated_at: string;
  status_text: string;
}

export interface FtpProgressSnapshot {
  schema_version: "1.0";
  sequence: number;
  observed_at: string;
  transfers: FtpProgressTransfer[];
}

interface CompletedTransfer extends FtpProgressTransfer {
  terminalAtMs: number;
}

export class StabilityGate {
  readonly status: StabilityStatus = { observed: 0, staged: 0, last_staged_at: null, last_error: null };
  private observations = new Map<string, Observation>();
  private completed = new Map<string, CompletedTransfer>();
  private sequence = 0;

  constructor(
    readonly inbox: string,
    readonly staging: string,
    readonly stableMs: number,
    readonly terminalRetentionMs = 15_000,
  ) {}

  async init(): Promise<void> {
    await Promise.all([mkdir(this.inbox, { recursive: true }), mkdir(this.staging, { recursive: true })]);
  }

  async runOnce(now = Date.now()): Promise<void> {
    try {
      const files = await listFiles(this.inbox);
      const current = new Set(files.filter((file) => !ignored(file)));
      for (const observed of this.observations.keys()) {
        if (!current.has(observed)) {
          this.observations.delete(observed);
          this.sequence += 1;
        }
      }
      for (const file of files) {
        if (ignored(file)) continue;
        const info = await stat(file);
        const previous = this.observations.get(file);
        if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
          const timestamp = new Date(now).toISOString();
          const speedBps = previous ? Math.round((Math.max(0, info.size - previous.size) * 1000) / Math.max(1, now - previous.lastSampleAt)) : null;
          this.observations.set(file, {
            transferId: previous?.transferId ?? transferIdFor(this.inbox, file, now),
            filename: path.basename(file),
            size: info.size,
            mtimeMs: info.mtimeMs,
            unchangedSince: now,
            startedAt: previous?.startedAt ?? timestamp,
            updatedAt: timestamp,
            lastSampleAt: now,
            speedBps,
          });
          this.sequence += 1;
          continue;
        }
        if (previous.speedBps !== 0 && now > previous.lastSampleAt) {
          previous.speedBps = 0;
          previous.updatedAt = new Date(now).toISOString();
          previous.lastSampleAt = now;
          this.sequence += 1;
        }
        if (now - previous.unchangedSince < this.stableMs) continue;
        const target = await availablePath(this.staging, safeFilename(path.basename(file)));
        try {
          await rename(file, target);
          this.observations.delete(file);
          this.completed.set(previous.transferId, {
            ...transferFromObservation(previous, now, "queued", `Staged as ${path.basename(target)}`),
            terminalAtMs: now,
          });
          this.status.staged += 1;
          this.status.last_staged_at = new Date(now).toISOString();
          this.sequence += 1;
          console.log(`[photo-ftp] staged ${path.relative(this.inbox, file)} as ${path.basename(target)}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      this.status.observed = this.observations.size;
      this.status.last_error = null;
    } catch (error) {
      this.status.last_error = errorMessage(error);
      console.error(`[photo-ftp] stability scan failed: ${this.status.last_error}`);
    }
  }

  progressSnapshot(now = Date.now()): FtpProgressSnapshot {
    for (const [id, transfer] of this.completed) {
      if (now - transfer.terminalAtMs > this.terminalRetentionMs) {
        this.completed.delete(id);
        this.sequence += 1;
      }
    }
    return {
      schema_version: "1.0",
      sequence: this.sequence,
      observed_at: new Date(now).toISOString(),
      transfers: [
        ...[...this.observations.values()].map((observation) => transferFromObservation(
          observation,
          now,
          "receiving",
          now - observation.unchangedSince >= this.stableMs ? "Waiting for staging" : "Receiving via FTP",
        )),
        ...[...this.completed.values()].map(({ terminalAtMs: _terminalAtMs, ...transfer }) => transfer),
      ].sort((left, right) => left.started_at.localeCompare(right.started_at) || left.transfer_id.localeCompare(right.transfer_id)),
    };
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function availablePath(directory: string, filename: string): Promise<string> {
  const parsed = path.parse(filename);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = index === 1 ? filename : `${parsed.name}_${index}${parsed.ext}`;
    const target = path.join(directory, candidate);
    try {
      await access(target);
    } catch {
      return target;
    }
  }
  throw new Error("Unable to allocate a unique staged filename.");
}

function ignored(file: string): boolean {
  return path.basename(file).startsWith(".") || file.endsWith(".uploading");
}

function transferIdFor(inbox: string, file: string, now: number): string {
  const relative = path.relative(inbox, file).replaceAll(path.sep, "/");
  const digest = createHash("sha256").update(relative).digest("base64url").slice(0, 12);
  return `${digest}-${now.toString(36)}`;
}

function transferFromObservation(observation: Observation, now: number, phase: "receiving" | "queued", statusText: string): FtpProgressTransfer {
  return {
    transfer_id: observation.transferId,
    adapter: "ftp",
    phase,
    filename: observation.filename,
    bytes_received: observation.size,
    bytes_total: null,
    speed_bps: phase === "receiving" ? observation.speedBps : null,
    elapsed_ms: Math.max(0, now - Date.parse(observation.startedAt)),
    started_at: observation.startedAt,
    updated_at: phase === "receiving" ? observation.updatedAt : new Date(now).toISOString(),
    status_text: statusText,
  };
}

function safeFilename(filename: string): string {
  const parsed = path.parse(filename);
  const stem = parsed.name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || "photo";
  return `${stem}${parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
