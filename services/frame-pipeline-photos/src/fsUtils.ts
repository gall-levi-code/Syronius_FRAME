import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWrite(file: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sanitizeBase(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || "photo";
}

export function hostJoin(root: string, ...parts: string[]): string {
  return /^[A-Za-z]:[\\/]/.test(root)
    ? path.win32.join(root, ...parts)
    : path.posix.join(root.replaceAll("\\", "/"), ...parts);
}
