const OFFLINE_STATUSES = new Set([
  502, 503, 504,
  520, 521, 522, 523, 524,
  530,
]);

export default {
  async fetch(request, env) {
    if (!env.ORIGIN_HOST) {
      return offlineResponse(request);
    }

    const originUrl = new URL(request.url);
    originUrl.hostname = env.ORIGIN_HOST;
    originUrl.protocol = "https:";

    try {
      const originRequest = new Request(originUrl.toString(), request);
      const response = await fetch(originRequest);

      if (OFFLINE_STATUSES.has(response.status)) {
        response.body?.cancel?.();
        return offlineResponse(request);
      }

      return response;
    } catch {
      return offlineResponse(request);
    }
  },
};

function offlineResponse(request) {
  const isWebSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";

  if (isWebSocket) {
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
