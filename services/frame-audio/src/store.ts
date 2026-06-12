import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const BITRATE_PRESETS = [64, 96, 128, 160, 192, 256, 320] as const;
export type BitratePreset = (typeof BITRATE_PRESETS)[number];

export interface AudioStreamConfig {
  streamId: string;
  instanceId: string;
  name: string;
  bitrateKbps: BitratePreset;
  listenerLimit: number;
  alwaysOn: boolean;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

interface StoreDocument {
  schemaVersion: 1;
  streams: AudioStreamConfig[];
}

export class AudioStreamStore {
  private readonly statePath: string;
  private document: StoreDocument = { schemaVersion: 1, streams: [] };
  private writeChain = Promise.resolve();
  private mutationChain = Promise.resolve();

  public constructor(dataRoot: string) {
    this.statePath = path.join(dataRoot, "state", "audio-streams.json");
  }

  public async init(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    try {
      this.document = JSON.parse(await readFile(this.statePath, "utf8")) as StoreDocument;
      const upgraded = this.addMissingInstanceIds(this.document);
      this.validateDocument(this.document);
      if (upgraded) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  public list(): AudioStreamConfig[] {
    return structuredClone(this.document.streams);
  }

  public get(streamId: string): AudioStreamConfig | undefined {
    const stream = this.document.streams.find((candidate) => candidate.streamId === streamId);
    return stream ? structuredClone(stream) : undefined;
  }

  public async create(input: Pick<AudioStreamConfig, "streamId" | "name" | "bitrateKbps" | "listenerLimit" | "alwaysOn">): Promise<AudioStreamConfig> {
    return this.mutate(async () => {
      this.assertUnique(input.streamId, input.name);
      const now = new Date().toISOString();
      const stream: AudioStreamConfig = { ...input, instanceId: this.newInstanceId(), generation: 0, createdAt: now, updatedAt: now };
      this.document.streams.push(stream);
      await this.persist();
      return structuredClone(stream);
    });
  }

  public async update(streamId: string, input: Pick<AudioStreamConfig, "name" | "bitrateKbps" | "listenerLimit" | "alwaysOn">): Promise<AudioStreamConfig> {
    return this.mutate(async () => {
      const stream = this.document.streams.find((candidate) => candidate.streamId === streamId);
      if (!stream) throw new StoreError(404, "Audio source not found.");
      this.assertUnique(streamId, input.name, streamId);
      Object.assign(stream, input, { updatedAt: new Date().toISOString() });
      await this.persist();
      return structuredClone(stream);
    });
  }

  public async nextGeneration(streamId: string): Promise<AudioStreamConfig> {
    return this.mutate(async () => {
      const stream = this.document.streams.find((candidate) => candidate.streamId === streamId);
      if (!stream) throw new StoreError(404, "Audio source not found.");
      stream.generation += 1;
      stream.updatedAt = new Date().toISOString();
      await this.persist();
      return structuredClone(stream);
    });
  }

  public async delete(streamId: string): Promise<void> {
    await this.mutate(async () => {
      const next = this.document.streams.filter((stream) => stream.streamId !== streamId);
      if (next.length === this.document.streams.length) throw new StoreError(404, "Audio source not found.");
      this.document.streams = next;
      await this.persist();
    });
  }

  private async persist(): Promise<void> {
    const contents = `${JSON.stringify(this.document, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.statePath}.tmp-${process.pid}`;
      await writeFile(temporary, contents, "utf8");
      await rename(temporary, this.statePath);
    });
    await this.writeChain;
  }

  private validateDocument(document: StoreDocument): void {
    if (document.schemaVersion !== 1 || !Array.isArray(document.streams)) {
      throw new Error("Audio stream registry is invalid.");
    }
    const ids = new Set<string>();
    const instanceIds = new Set<string>();
    const names = new Set<string>();
    for (const stream of document.streams) {
      validateStreamInput(stream);
      if (ids.has(stream.streamId)) throw new Error(`Duplicate audio stream ID: ${stream.streamId}.`);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stream.instanceId)) {
        throw new Error(`Invalid audio stream instance ID: ${stream.streamId}.`);
      }
      if (instanceIds.has(stream.instanceId)) throw new Error(`Duplicate audio stream instance ID: ${stream.streamId}.`);
      const normalizedName = normalizeName(stream.name);
      if (names.has(normalizedName)) throw new Error(`Duplicate audio stream name: ${stream.name}.`);
      ids.add(stream.streamId);
      instanceIds.add(stream.instanceId);
      names.add(normalizedName);
      if (!Number.isInteger(stream.generation) || stream.generation < 0) {
        throw new Error(`Invalid generation for ${stream.streamId}.`);
      }
    }
  }

  private assertUnique(streamId: string, name: string, exceptStreamId?: string): void {
    if (this.document.streams.some((stream) => stream.streamId !== exceptStreamId && stream.streamId === streamId)) {
      throw new StoreError(409, `An audio source with stream ID "${streamId}" already exists.`);
    }
    if (this.document.streams.some((stream) => stream.streamId !== exceptStreamId && normalizeName(stream.name) === normalizeName(name))) {
      throw new StoreError(409, `An audio source named "${name}" already exists.`);
    }
  }

  private addMissingInstanceIds(document: StoreDocument): boolean {
    if (!Array.isArray(document.streams)) return false;
    let upgraded = false;
    for (const stream of document.streams) {
      if (typeof stream.instanceId !== "string") {
        stream.instanceId = this.newInstanceId();
        upgraded = true;
      }
    }
    return upgraded;
  }

  private newInstanceId(): string {
    let instanceId: string;
    do {
      instanceId = randomUUID();
    } while (this.document.streams.some((stream) => stream.instanceId === instanceId));
    return instanceId;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function validateStreamInput(value: unknown): Pick<AudioStreamConfig, "streamId" | "name" | "bitrateKbps" | "listenerLimit" | "alwaysOn"> {
  if (!value || typeof value !== "object") throw new StoreError(400, "Audio source body must be an object.");
  const body = value as Record<string, unknown>;
  const streamId = typeof body.streamId === "string" ? body.streamId.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{6,63}$/.test(streamId)) {
    throw new StoreError(400, "Stream ID must use 7-64 lowercase letters, numbers, or hyphens.");
  }
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (!name) throw new StoreError(400, "Audio source name is required.");
  const bitrateKbps = Number(body.bitrateKbps);
  if (!BITRATE_PRESETS.includes(bitrateKbps as BitratePreset)) {
    throw new StoreError(400, `Bitrate must be one of: ${BITRATE_PRESETS.join(", ")} kbps.`);
  }
  const listenerLimit = Number(body.listenerLimit);
  if (!Number.isInteger(listenerLimit) || listenerLimit < 1 || listenerLimit > 100) {
    throw new StoreError(400, "Listener limit must be an integer from 1 to 100.");
  }
  return { streamId, name, bitrateKbps: bitrateKbps as BitratePreset, listenerLimit, alwaysOn: body.alwaysOn === true };
}

export class StoreError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
