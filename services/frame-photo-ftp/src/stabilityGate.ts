import { access, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

interface Observation {
  size: number;
  mtimeMs: number;
  unchangedSince: number;
}

export interface StabilityStatus {
  observed: number;
  staged: number;
  last_staged_at: string | null;
  last_error: string | null;
}

export class StabilityGate {
  readonly status: StabilityStatus = { observed: 0, staged: 0, last_staged_at: null, last_error: null };
  private observations = new Map<string, Observation>();

  constructor(
    readonly inbox: string,
    readonly staging: string,
    readonly stableMs: number,
  ) {}

  async init(): Promise<void> {
    await Promise.all([mkdir(this.inbox, { recursive: true }), mkdir(this.staging, { recursive: true })]);
  }

  async runOnce(now = Date.now()): Promise<void> {
    try {
      const files = await listFiles(this.inbox);
      const current = new Set(files);
      for (const observed of this.observations.keys()) {
        if (!current.has(observed)) this.observations.delete(observed);
      }
      for (const file of files) {
        if (path.basename(file).startsWith(".") || file.endsWith(".uploading")) continue;
        const info = await stat(file);
        const previous = this.observations.get(file);
        if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
          this.observations.set(file, { size: info.size, mtimeMs: info.mtimeMs, unchangedSince: now });
          continue;
        }
        if (now - previous.unchangedSince < this.stableMs) continue;
        const target = await availablePath(this.staging, safeFilename(path.basename(file)));
        try {
          await rename(file, target);
          this.observations.delete(file);
          this.status.staged += 1;
          this.status.last_staged_at = new Date(now).toISOString();
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
