const form = document.querySelector("#upload-form");
const input = document.querySelector("#photo");
const selection = document.querySelector("#selection");
const status = document.querySelector("#status");
const button = document.querySelector("#upload-button");
const queue = document.querySelector("#queue");
const template = document.querySelector("#queue-template");
const themeToggle = document.querySelector("#theme-toggle");

let entries = [];
let uploading = false;

initializeTheme();
themeToggle.addEventListener("click", toggleTheme);
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(readStoredTheme(), false);
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    setThemeMode(event.newValue, false);
  }
});

input.addEventListener("change", () => {
  entries = [...(input.files || [])].map((file) => ({ file, element: createQueueItem(file), state: "ready" }));
  queue.replaceChildren(...entries.map((entry) => entry.element));
  selection.textContent = entries.length ? `${entries.length} photo${entries.length === 1 ? "" : "s"} · ${formatBytes(entries.reduce((sum, entry) => sum + entry.file.size, 0))}` : "No photos selected";
  button.disabled = entries.length === 0;
  status.textContent = "";
  status.className = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!entries.length || uploading) return;
  uploading = true;
  button.disabled = true;
  input.disabled = true;
  status.className = "";
  status.textContent = `Uploading 1 of ${entries.length}...`;
  let completed = 0;
  let failed = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    status.textContent = `Uploading ${index + 1} of ${entries.length}: ${entry.file.name}`;
    try {
      await uploadEntry(entry);
      completed += 1;
    } catch (error) {
      failed += 1;
      setEntryState(entry, "error", error.message || "Upload failed");
    }
  }

  uploading = false;
  input.disabled = false;
  status.className = failed ? "error" : "success";
  status.textContent = failed
    ? `${completed} accepted, ${failed} failed. Failed files remain listed for review.`
    : `${completed} photo${completed === 1 ? "" : "s"} accepted and queued for processing.`;
  if (!failed) {
    form.reset();
    entries = [];
    queue.replaceChildren();
    selection.textContent = "No photos selected";
  }
  button.disabled = entries.length === 0;
});

function uploadEntry(entry) {
  return new Promise((resolve, reject) => {
    const data = new FormData();
    data.append("photo", entry.file, entry.file.name);
    const request = new XMLHttpRequest();
    request.open("POST", "/photos/api/upload");
    entry.transferId ||= createTransferId();
    request.setRequestHeader("X-Frame-Transfer-Id", entry.transferId);
    request.setRequestHeader("X-Frame-File-Size", String(entry.file.size));
    setEntryState(entry, "uploading", "Uploading");
    updateProgress(entry, 0, entry.file.size);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) updateProgress(entry, event.loaded, event.total);
    });
    request.addEventListener("load", () => {
      let result = {};
      try { result = JSON.parse(request.responseText); } catch {}
      if (request.status !== 202) {
        reject(new Error(result.error || `Upload failed (${request.status})`));
        return;
      }
      updateProgress(entry, entry.file.size, entry.file.size);
      setEntryState(entry, "done", "Accepted");
      resolve();
    });
    request.addEventListener("error", () => reject(new Error("Network error while uploading.")));
    request.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    request.send(data);
  });
}

function createTransferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function createQueueItem(file) {
  const item = template.content.firstElementChild.cloneNode(true);
  item.querySelector("strong").textContent = file.name;
  item.querySelector(".progress-label").textContent = `0% · 0 B of ${formatBytes(file.size)}`;
  return item;
}

function updateProgress(entry, loaded, total) {
  const percent = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  entry.element.querySelector("progress").value = percent;
  entry.element.querySelector(".progress-label").textContent = `${percent}% · ${formatBytes(loaded)} of ${formatBytes(total)}`;
}

function setEntryState(entry, className, text) {
  entry.state = className;
  entry.element.className = `queue-item ${className}`;
  entry.element.querySelector(".file-state").textContent = text;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

button.disabled = true;

function initializeTheme() {
  setThemeMode(readStoredTheme(), false);
}

function toggleTheme() {
  setThemeMode(document.documentElement.dataset.theme === "day" ? "night" : "day", true);
}

function setThemeMode(nextMode, persist) {
  const mode = nextMode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  window.FrameTheme?.apply(mode);
  const nextLabel = mode === "day" ? "Switch to night mode" : "Switch to day mode";
  themeToggle.setAttribute("aria-label", nextLabel);
  themeToggle.title = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(mode === "day"));
  if (persist) writeStoredTheme(mode);
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("frame-theme");
    if (stored === "day" || stored === "night") return stored;
  } catch {}
  return "night";
}

function writeStoredTheme(mode) {
  try {
    localStorage.setItem("frame-theme", mode);
  } catch {}
}
