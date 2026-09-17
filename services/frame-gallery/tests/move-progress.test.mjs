import assert from "node:assert/strict";
import test from "node:test";
import { readMoveResponse } from "../public/move-progress.js";

test("move feedback handles split records, errors, disconnections and legacy responses", async () => {
  const encoder = new TextEncoder();
  const result = { ok: true, affected: 2, target_date_folder: "2026-09-04" };
  const progress = { type: "progress", phase: "moving", completed: 1, total: 2 };
  let feed;
  const response = new Response(new ReadableStream({ start(controller) { feed = controller; } }), {
    headers: { "content-type": "application/x-ndjson" },
  });
  let observed;
  const firstProgress = new Promise((resolve) => { observed = resolve; });
  const pending = readMoveResponse(response, observed);
  const wire = JSON.stringify(progress);
  feed.enqueue(encoder.encode(wire.slice(0, 15)));
  feed.enqueue(encoder.encode(`${wire.slice(15)}\n`));
  assert.deepEqual(await firstProgress, progress);
  feed.enqueue(encoder.encode(JSON.stringify({ type: "result", result })));
  feed.close();
  assert.deepEqual(await pending, result);

  for (const [body, error] of [
    [JSON.stringify({ type: "error", error: "The destination already contains this photo." }), /destination already contains/],
    [JSON.stringify(progress), /may still be running/],
    ["{broken", /may still be running/],
    [JSON.stringify({ type: "result", result: {} }), /may still be running/],
  ]) {
    await assert.rejects(readMoveResponse(new Response(body, { headers: { "content-type": "application/x-ndjson" } }), () => {}), error);
  }
  const broken = new Response(new ReadableStream({ pull(controller) { controller.error(new Error("connection lost")); } }), {
    headers: { "content-type": "application/x-ndjson" },
  });
  await assert.rejects(readMoveResponse(broken, () => {}), /may still be running/);
  assert.deepEqual(await readMoveResponse(Response.json(result), () => {}), result);
  await assert.rejects(readMoveResponse(Response.json({ error: "Choose another date." }, { status: 400 }), () => {}), /Choose another date/);
});
