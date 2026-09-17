import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAuditRecord, AUDIT_ARCHIVES, AUDIT_RECENT_RECORDS, AUDIT_ROTATE_BYTES, readRecentAuditRecords } from "../dist/auditLog.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "command-audit.jsonl");
}

test("audit appends separate interrupted lines and restore valid UTF-8 records in chronological order", (t) => {
  const file = fixture(t);
  const large = { id: 2, result: "🎥".repeat(40_000) };
  fs.writeFileSync(file, `${JSON.stringify({ id: 1 })}\r\n${JSON.stringify(large)}\nmalformed\n{"interrupted":`);
  appendAuditRecord(file, { id: 3 });
  assert.deepEqual(readRecentAuditRecords(file), [{ id: 1 }, large, { id: 3 }]);
  // A complete final JSON record without a newline is preserved as well.
  fs.appendFileSync(file, '{"id":4}');
  appendAuditRecord(file, { id: 5 });
  assert.deepEqual(readRecentAuditRecords(file).map((entry) => entry.id), [1, 2, 3, 4, 5]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("rotation retains only three ordered archives and restart reads recent records across them", (t) => {
  const file = fixture(t);
  for (let generation = 0; generation < 5; generation += 1) {
    const tail = Buffer.from(`${JSON.stringify({ generation })}\n`);
    const full = Buffer.alloc(AUDIT_ROTATE_BYTES, 10);
    tail.copy(full, full.length - tail.length);
    fs.writeFileSync(file, full, { mode: 0o644 });
    appendAuditRecord(file, { generation: generation + 1 });
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), [path.basename(file), ...Array.from({ length: AUDIT_ARCHIVES }, (_, index) => `${path.basename(file)}.${index + 1}`)]);
  assert.deepEqual(readRecentAuditRecords(file), [{ generation: 2 }, { generation: 3 }, { generation: 4 }, { generation: 5 }]);
  for (let index = 0; index <= AUDIT_ARCHIVES; index += 1) {
    const entry = fs.statSync(index ? `${file}.${index}` : file);
    assert.ok(entry.size <= AUDIT_ROTATE_BYTES);
    if (process.platform !== "win32") assert.equal(entry.mode & 0o777, 0o600);
  }
  // Fill the recent-record window across a freshly rotated boundary.
  fs.writeFileSync(`${file}.1`, Array.from({ length: 250 }, (_, id) => `${JSON.stringify({ id })}\n`).join(""));
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, id) => `${JSON.stringify({ id: id + 250 })}\n`).join(""));
  assert.deepEqual(readRecentAuditRecords(file).map((entry) => entry.id), Array.from({ length: AUDIT_RECENT_RECORDS }, (_, index) => index + 60));
});

test("legacy oversized and malformed lines have bounded IO and do not hide valid neighboring records", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, '{"old":true}\n');
  fs.truncateSync(file, AUDIT_ROTATE_BYTES * 8);
  fs.appendFileSync(file, '\n{"id":1}\n' + "x".repeat(600 * 1024) + '\n{"id":2}\n{"truncated":');
  const originalRead = fs.readSync;
  let bytesRead = 0;
  let largestRead = 0;
  fs.readSync = (descriptor, buffer, offset, length, position) => {
    bytesRead += length;
    largestRead = Math.max(largestRead, length);
    return originalRead(descriptor, buffer, offset, length, position);
  };
  try {
    assert.deepEqual(readRecentAuditRecords(file), [{ id: 1 }, { id: 2 }]);
  } finally {
    fs.readSync = originalRead;
  }
  assert.ok(bytesRead <= AUDIT_ROTATE_BYTES);
  assert.ok(largestRead <= 64 * 1024);
});

test("oversized appends and filesystem failures preserve already written audit records", (t) => {
  const file = fixture(t);
  appendAuditRecord(file, { id: 1 });
  assert.throws(() => appendAuditRecord(file, { result: "x".repeat(512 * 1024) }), /record exceeds/);
  assert.deepEqual(readRecentAuditRecords(file), [{ id: 1 }]);
  const blocked = path.join(path.dirname(file), "directory");
  fs.mkdirSync(blocked);
  assert.throws(() => appendAuditRecord(blocked, { id: 2 }));
  assert.deepEqual(readRecentAuditRecords(file), [{ id: 1 }]);
});
