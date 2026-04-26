import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Required: upstream JSON endpoint to proxy (your stats URL)
const UPSTREAM_URL = process.env.UPSTREAM_URL || "";
if (!UPSTREAM_URL) {
  console.warn("[WARN] UPSTREAM_URL is not set. /api/status will return 500.");
}

// Optional headers to reach upstream
const AUTH_HEADER = process.env.AUTH_HEADER || "";
let CUSTOM_HEADERS = {};
try {
  CUSTOM_HEADERS = process.env.CUSTOM_HEADERS ? JSON.parse(process.env.CUSTOM_HEADERS) : {};
} catch {
  console.warn("[WARN] CUSTOM_HEADERS is not valid JSON. Ignoring.");
}

// Basic CORS for OBS Browser Source
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// <<< parse JSON bodies (needed for POST /api/uploads/progress)
app.use(express.json());

// Static (serves /public as web root)
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  })
);

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Proxy: same-origin JSON for the overlay
app.get("/api/status", async (_req, res) => {
  if (!UPSTREAM_URL) {
    return res.status(500).json({ error: "UPSTREAM_URL not configured" });
  }
  try {
    const headers = { ...CUSTOM_HEADERS };
    if (AUTH_HEADER) headers["Authorization"] = AUTH_HEADER;

    const upstream = await fetch(UPSTREAM_URL, { headers, timeout: 5000 });
    const text = await upstream.text();

    try {
      const json = JSON.parse(text);
      res.setHeader("Cache-Control", "no-store");
      return res.json(json);
    } catch {
      return res
        .status(502)
        .json({ error: "Upstream returned non-JSON", raw: text.slice(0, 500) });
    }
  } catch (err) {
    return res
      .status(502)
      .json({ error: "Failed to reach upstream", detail: String(err) });
  }
});

// <<< keep a simple summary for the non-progress overlay if you want it
let uploadsState = {
  last_file: null,
  size: null,
  elapsed: null,
  rate: null,
  pending: 0,
};

// Live progress state (polled by uploads_progress.html)
let uploadProgress = {
  file: null,
  size_bytes: 0,
  sent_bytes: 0,
  percent: 0,
  elapsed: 0,
  rate_bps: 0,
  done: false,
};

app.get("/api/uploads/progress", (_req, res) => res.json(uploadProgress));

app.post("/api/uploads/progress", (req, res) => {
  const { file, size_bytes, sent_bytes, percent, elapsed, rate_bps, done } = req.body || {};
  if (!file) return res.status(400).json({ error: "missing file" });

  uploadProgress = {
    file,
    size_bytes: Number(size_bytes) || 0,
    sent_bytes: Number(sent_bytes) || 0,
    percent: Number(percent) || 0,
    elapsed: Number(elapsed) || 0,
    rate_bps: Number(rate_bps) || 0,
    done: !!done,
  };

  // Optionally mirror “last completed” into uploadsState
  if (uploadProgress.done) {
    uploadsState.last_file = file;
    uploadsState.size = `${(uploadProgress.size_bytes / 1048576).toFixed(2)} MB`;
    uploadsState.elapsed = `${uploadProgress.elapsed.toFixed(2)}s`;
    const rateMBs = uploadProgress.rate_bps / 1048576;
    uploadsState.rate =
      rateMBs >= 0.1 ? `${rateMBs.toFixed(2)} MB/s` : `${(uploadProgress.rate_bps / 1024).toFixed(2)} KB/s`;
  }

  res.json({ ok: true });
});

// <<< serve the progress page from /public
app.get("/uploads-progress", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "uploads_progress.html"))
);

// Default route to index.html
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`[overlay] listening on :${PORT}`);
});
