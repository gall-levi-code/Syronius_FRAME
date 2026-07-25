import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface Observation {
  transferId: string;
  journeyId: string;
  sourceAdapter: "ftp" | "belabox_agent";
  filename: string;
  size: number;
  mtimeMs: number;
  unchangedSince: number;
  startedAt: string;
  updatedAt: string;
  lastSampleAt: number;
  speedBps: number | null;
}

interface JourneyMetadata {
  schema_version: 1;
  journey_id: string;
  original_name: string;
  content_sha256?: string;
  received_at: string;
  ingest: {
    adapter: "ftp" | "belabox_agent";
    transfer_id: string;
    bytes_received: number;
  };
}

export interface StabilityStatus {
  observed: number;
  staged: number;
  last_staged_at: string | null;
  last_error: string | null;
}

export interface FtpProgressTransfer {
  transfer_id: string;
  journey_id: string;
  adapter: "ftp";
  source_adapter: "ftp" | "belabox_agent";
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
    const recoveryErrors = await recoverUploadingEnvelopes(this.staging);
    if (recoveryErrors.length) this.status.last_error = recoveryErrors.join("; ").slice(0, 500);
  }

  async runOnce(now = Date.now()): Promise<void> {
    try {
      const scanErrors: string[] = [];
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
          const identity = photoIdentity(file);
          this.observations.set(file, {
            transferId: previous?.transferId ?? transferIdFor(this.inbox, file, now),
            journeyId: previous?.journeyId ?? identity.journeyId,
            sourceAdapter: previous?.sourceAdapter ?? identity.sourceAdapter,
            filename: previous?.filename ?? identity.originalName,
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
        try {
          await stageJourney(file, this.staging, previous, now);
          this.observations.delete(file);
          this.completed.set(previous.transferId, {
            ...transferFromObservation(previous, now, "queued", "Staged for FRAME processing"),
            terminalAtMs: now,
          });
          this.status.staged += 1;
          this.status.last_staged_at = new Date(now).toISOString();
          this.sequence += 1;
          console.log(`[photo-ftp] staged ${path.relative(this.inbox, file)} as ${previous.journeyId}.frame-photo`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          const detail = errorMessage(error);
          scanErrors.push(detail);
          console.error(`[photo-ftp] could not stage ${path.relative(this.inbox, file)}: ${detail}`);
        }
      }
      this.status.observed = this.observations.size;
      this.status.last_error = scanErrors.at(-1) ?? null;
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

async function stageJourney(file: string, staging: string, observation: Observation, now: number): Promise<void> {
  const target = path.join(staging, `${observation.journeyId}.frame-photo`);
  const contentSha256 = await sha256File(file);
  const metadata: JourneyMetadata = {
    schema_version: 1,
    journey_id: observation.journeyId,
    original_name: observation.filename,
    content_sha256: contentSha256,
    received_at: new Date(now).toISOString(),
    ingest: { adapter: observation.sourceAdapter, transfer_id: observation.transferId, bytes_received: observation.size },
  };
  try {
    if (!await sameJourneyEnvelope(target, metadata, contentSha256)) {
      throw new Error(`Journey ${observation.journeyId} conflicts with an existing staged photo.`);
    }
    await rm(file, { force: true });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(staging, `.${observation.journeyId}.${randomUUID()}.uploading`);
  await mkdir(temporary);
  try {
    await writeFile(path.join(temporary, "journey.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(file, path.join(temporary, "source"));
    await commitRecoveredEnvelope(temporary, target, metadata, contentSha256);
  } catch (error) {
    try {
      await rename(path.join(temporary, "source"), file);
    } catch {}
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function recoverUploadingEnvelopes(staging: string): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^\.([A-Za-z0-9_-]{8,96})\.[^.]+\.uploading$/.exec(entry.name);
    if (!match || !validJourneyId(match[1])) continue;
    try {
      const temporary = path.join(staging, entry.name);
      const source = path.join(temporary, "source");
      try {
        if (!(await stat(source)).isFile()) throw new Error(`Recoverable upload ${entry.name} has an invalid source.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rm(temporary, { recursive: true, force: true });
        continue;
      }

      const metadata = await readJourneyMetadata(temporary);
      if (metadata.journey_id !== match[1]) throw new Error(`Recoverable upload ${entry.name} has mismatched journey metadata.`);
      const contentSha256 = await verifiedEnvelopeDigest(temporary, metadata);
      if (!metadata.content_sha256) {
        metadata.content_sha256 = contentSha256;
        const replacement = path.join(temporary, "journey.json.recovering");
        await writeFile(replacement, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
        await rename(replacement, path.join(temporary, "journey.json"));
      }
      await commitRecoveredEnvelope(temporary, path.join(staging, `${metadata.journey_id}.frame-photo`), metadata, contentSha256);
    } catch (error) {
      const detail = errorMessage(error);
      errors.push(`${entry.name}: ${detail}`);
      console.error(`[photo-ftp] could not recover ${entry.name}: ${detail}`);
    }
  }
  return errors;
}

async function commitRecoveredEnvelope(temporary: string, target: string, metadata: JourneyMetadata, contentSha256: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      try {
        if (!await sameJourneyEnvelope(target, metadata, contentSha256)) {
          throw new Error(`Journey ${metadata.journey_id} conflicts with an existing staged photo.`);
        }
        await rm(temporary, { recursive: true, force: true });
        return;
      } catch (comparisonError) {
        if ((comparisonError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw comparisonError;
      }
    }
  }
  throw new Error(`Journey ${metadata.journey_id} could not be recovered into staging.`);
}

async function sameJourneyEnvelope(directory: string, metadata: JourneyMetadata, contentSha256: string): Promise<boolean> {
  const existing = await readJourneyMetadata(directory);
  const existingDigest = await verifiedEnvelopeDigest(directory, existing);
  return existing.journey_id === metadata.journey_id
    && existing.original_name === metadata.original_name
    && existing.ingest.bytes_received === metadata.ingest.bytes_received
    && existingDigest === contentSha256;
}

async function readJourneyMetadata(directory: string): Promise<JourneyMetadata> {
  const value: unknown = JSON.parse(await readFile(path.join(directory, "journey.json"), "utf8"));
  const metadata = value as Partial<JourneyMetadata>;
  const ingest = metadata?.ingest as Partial<JourneyMetadata["ingest"]> | undefined;
  if (metadata?.schema_version !== 1
    || !validJourneyId(metadata.journey_id)
    || typeof metadata.original_name !== "string" || metadata.original_name.length < 1 || metadata.original_name.length > 255
    || (metadata.content_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(metadata.content_sha256))
    || typeof metadata.received_at !== "string" || !Number.isFinite(Date.parse(metadata.received_at))
    || (ingest?.adapter !== "ftp" && ingest?.adapter !== "belabox_agent")
    || typeof ingest?.transfer_id !== "string" || ingest.transfer_id.length < 1 || ingest.transfer_id.length > 120
    || !Number.isSafeInteger(ingest?.bytes_received) || (ingest?.bytes_received ?? -1) < 0) {
    throw new Error(`Invalid journey metadata in ${directory}.`);
  }
  return metadata as JourneyMetadata;
}

async function verifiedEnvelopeDigest(directory: string, metadata: JourneyMetadata): Promise<string> {
  const source = path.join(directory, "source");
  const info = await stat(source);
  if (!info.isFile() || info.size !== metadata.ingest.bytes_received) {
    throw new Error(`Journey ${metadata.journey_id} source does not match its declared size.`);
  }
  const contentSha256 = await sha256File(source);
  if (metadata.content_sha256 && metadata.content_sha256 !== contentSha256) {
    throw new Error(`Journey ${metadata.journey_id} source does not match its declared digest.`);
  }
  return contentSha256;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function photoIdentity(file: string): { journeyId: string; originalName: string; sourceAdapter: "ftp" | "belabox_agent" } {
  const name = path.basename(file);
  const envelope = /^FRAMEJ1_([A-Za-z0-9_-]{8,96}?)__(.+)$/.exec(name);
  if (envelope && validJourneyId(envelope[1])) return { journeyId: envelope[1], originalName: originalFilename(envelope[2]), sourceAdapter: "belabox_agent" };
  return { journeyId: randomUUID(), originalName: originalFilename(name), sourceAdapter: "ftp" };
}

function validJourneyId(value: unknown): value is string {
  return typeof value === "string" && /^(?!.*__)[A-Za-z0-9_-]{8,96}$/.test(value);
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
    journey_id: observation.journeyId,
    adapter: "ftp",
    source_adapter: observation.sourceAdapter,
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

function originalFilename(filename: string): string {
  return path.basename(filename).replace(/[^\x20-\x7E]/g, "").slice(0, 180).trim() || "photo";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
