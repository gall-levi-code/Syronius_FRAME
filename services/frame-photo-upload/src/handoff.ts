import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export function safeFilename(filename: string): string {
  const parsed = path.parse(path.basename(filename));
  const stem = parsed.name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || "photo";
  const extension = parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
  return `${stem}${extension}`;
}

export async function streamCompletedUpload(
  stream: Readable,
  filename: string,
  inbox: string,
  staging: string,
): Promise<string> {
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(staging, { recursive: true })]);
  const safe = safeFilename(filename);
  const finalInbox = await availablePath(inbox, safe);
  const uploading = `${finalInbox}.uploading`;
  try {
    await pipeline(stream, createWriteStream(uploading, { flags: "wx" }));
    await rename(uploading, finalInbox);
    const finalStaging = await availablePath(staging, path.basename(finalInbox));
    await rename(finalInbox, finalStaging);
    return path.basename(finalStaging);
  } catch (error) {
    await rm(uploading, { force: true });
    await rm(finalInbox, { force: true });
    throw error;
  }
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
  throw new Error("Unable to allocate a unique upload name.");
}
