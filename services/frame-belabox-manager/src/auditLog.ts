import {
  appendFileSync, chmodSync, closeSync, existsSync, fchmodSync, fstatSync, openSync, readSync, renameSync, rmSync,
} from "node:fs";

export const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024;
export const AUDIT_ARCHIVES = 3;
export const AUDIT_RECENT_RECORDS = 200;
const READ_BLOCK_BYTES = 64 * 1024;
// Control messages are limited to 256 KiB; allow room for the manager's JSON fields.
const MAX_RECORD_BYTES = 512 * 1024;

export function appendAuditRecord(file: string, entry: object): void {
  const line = Buffer.from(`${JSON.stringify(entry)}\n`);
  if (line.length > MAX_RECORD_BYTES) throw new Error("Audit record exceeds the supported control-message size.");
  let descriptor = openSync(file, "a+", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    const size = fstatSync(descriptor).size;
    const lastByte = Buffer.alloc(1);
    const separate = size > 0 && readSync(descriptor, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 10;
    if (size > 0 && size + Number(separate) + line.length > AUDIT_ROTATE_BYTES) {
      closeSync(descriptor);
      descriptor = -1;
      rmSync(`${file}.${AUDIT_ARCHIVES}`, { force: true });
      for (let index = AUDIT_ARCHIVES - 1; index >= 0; index -= 1) {
        const source = index ? `${file}.${index}` : file;
        if (existsSync(source)) {
          chmodSync(source, 0o600);
          renameSync(source, `${file}.${index + 1}`);
        }
      }
      descriptor = openSync(file, "a+", 0o600);
      fchmodSync(descriptor, 0o600);
    } else if (separate) {
      // A crashed partial append must not swallow the next complete record.
      appendFileSync(descriptor, "\n");
    }
    appendFileSync(descriptor, line);
  } finally {
    if (descriptor !== -1) closeSync(descriptor);
  }
}

export function readRecentAuditRecords<T>(file: string): T[] {
  const newest: T[] = [];
  for (let archive = 0; archive <= AUDIT_ARCHIVES && newest.length < AUDIT_RECENT_RECORDS; archive += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(archive ? `${file}.${archive}` : file, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      fchmodSync(descriptor, 0o600);
      let position = fstatSync(descriptor).size;
      // Bound legacy oversized/corrupt files too, even before their first rotation.
      const floor = Math.max(0, position - AUDIT_ROTATE_BYTES);
      let fragments: Buffer[] = [];
      let bytes = 0;
      let oversized = false;
      const add = (part: Buffer) => {
        bytes += part.length;
        if (bytes > MAX_RECORD_BYTES) {
          oversized = true;
          fragments = [];
        } else if (!oversized && part.length) {
          fragments.unshift(part);
        }
      };
      const finishLine = () => {
        if (!oversized && bytes) {
          try {
            const entry = JSON.parse(Buffer.concat(fragments, bytes).toString("utf8"));
            if (entry && typeof entry === "object" && !Array.isArray(entry)) newest.push(entry as T);
          } catch {
            // Keep valid neighbors when a line is malformed or a final write was interrupted.
          }
        }
        fragments = [];
        bytes = 0;
        oversized = false;
      };
      while (position > floor && newest.length < AUDIT_RECENT_RECORDS) {
        const length = Math.min(READ_BLOCK_BYTES, position - floor);
        position -= length;
        const block = Buffer.allocUnsafe(length);
        const read = readSync(descriptor, block, 0, length, position);
        let end = read;
        for (let index = read - 1; index >= 0 && newest.length < AUDIT_RECENT_RECORDS; index -= 1) {
          if (block[index] !== 10) continue;
          add(block.subarray(index + 1, end));
          finishLine();
          end = index;
        }
        if (newest.length < AUDIT_RECENT_RECORDS) add(block.subarray(0, end));
      }
      if (floor === 0 && newest.length < AUDIT_RECENT_RECORDS) finishLine();
    } finally {
      closeSync(descriptor);
    }
  }
  return newest.reverse();
}
