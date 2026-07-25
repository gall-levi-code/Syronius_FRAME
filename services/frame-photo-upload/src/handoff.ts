import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface UploadJourney {
  journeyId: string;
  transferId: string;
  adapter: string;
}

export interface StagedUpload {
  stagedName: string;
  created: boolean;
}

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
  staging: string,
  journey: UploadJourney,
  onChunk?: (bytes: number) => void,
): Promise<StagedUpload> {
  await mkdir(staging, { recursive: true });
  const safe = safeFilename(filename);
  const temporary = path.join(staging, `.frame-upload-${randomUUID()}.uploading`);
  const finalEnvelope = path.join(staging, `${journey.journeyId}.frame-photo`);
  let bytesReceived = 0;
  const hash = createHash("sha256");
  try {
    await mkdir(temporary);
    const output = createWriteStream(path.join(temporary, "source"), { flags: "wx" });
    await pipeline(stream, inspectChunks((chunk) => {
      bytesReceived += chunk.length;
      hash.update(chunk);
      onChunk?.(chunk.length);
    }), output);
    const contentSha256 = hash.digest("hex");
    await writeFile(path.join(temporary, "journey.json"), `${JSON.stringify({
      schema_version: 1,
      journey_id: journey.journeyId,
      original_name: safe,
      content_sha256: contentSha256,
      received_at: new Date().toISOString(),
      ingest: {
        adapter: journey.adapter,
        transfer_id: journey.transferId,
        bytes_received: bytesReceived,
      },
    }, null, 2)}\n`);
    const created = await commitEnvelope(temporary, finalEnvelope, journey.journeyId, safe, bytesReceived, contentSha256);
    return { stagedName: safe, created };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function inspectChunks(onChunk: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onChunk(chunk);
      callback(null, chunk);
    },
  });
}

async function commitEnvelope(temporary: string, target: string, journeyId: string, originalName: string, bytesReceived: number, contentSha256: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(temporary, target);
      return true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      try {
        const existing = JSON.parse(await readFile(path.join(target, "journey.json"), "utf8")) as Record<string, unknown>;
        const ingest = typeof existing.ingest === "object" && existing.ingest !== null
          ? existing.ingest as Record<string, unknown>
          : {};
        const existingDigest = typeof existing.content_sha256 === "string"
          ? existing.content_sha256
          : await sha256File(path.join(target, "source"));
        if (existing.journey_id !== journeyId || existing.original_name !== originalName || ingest.bytes_received !== bytesReceived || existingDigest !== contentSha256) {
          throw new Error(`Journey ${journeyId} is already staged with different upload content or metadata.`);
        }
        await rm(temporary, { recursive: true, force: true });
        return false;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
    }
  }
  throw new Error(`Journey ${journeyId} could not be staged.`);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
