const DISCONNECTED = "Move progress disconnected. The move may still be running; refresh the gallery before retrying.";

export async function readMoveResponse(response, onProgress) {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || "Photo move request failed.");
    if (!result?.ok || !Number.isInteger(result.affected)) throw new Error(DISCONNECTED);
    return result;
  }
  if (!response.ok || !response.body) throw new Error(DISCONNECTED);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const chunk = await reader.read().catch(() => { throw new Error(DISCONNECTED); });
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      if (chunk.done && pending.trim()) lines.push(pending);
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error(DISCONNECTED); }
        if (event.type === "error") throw new Error(event.error || "Photo move failed.");
        if (event.type === "progress") onProgress(event);
        if (event.type === "result") {
          if (!event.result?.ok || !Number.isInteger(event.result.affected)) throw new Error(DISCONNECTED);
          return event.result;
        }
      }
      if (chunk.done) throw new Error(DISCONNECTED);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
