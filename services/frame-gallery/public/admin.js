const elements = Object.fromEntries([
  "refresh", "summary", "status", "published-tab", "trash-tab", "published-count", "trash-count",
  "published-view", "trash-view", "albums", "album-detail", "album-title", "album-summary",
  "trash-album", "photos", "trash-albums", "empty-trash", "empty",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const templates = {
  album: document.getElementById("album-template"),
  photo: document.getElementById("photo-template"),
  trashAlbum: document.getElementById("trash-album-template"),
  trashPhoto: document.getElementById("trash-photo-template"),
};
const state = { dates: [], photos: [], trash: [], selectedDate: null, view: "published", busy: false };

elements.refresh.addEventListener("click", refresh);
elements.published_tab.addEventListener("click", () => setView("published"));
elements.trash_tab.addEventListener("click", () => setView("trash"));
elements.trash_album.addEventListener("click", () => manage("trash-album", state.selectedDate, null, `Move every photo from ${state.selectedDate} to trash?`));
elements.empty_trash.addEventListener("click", () => manage("empty-trash", null, null, "Permanently delete every trashed published gallery copy? Archived sources follow the separate retention policy."));

await refresh();

async function refresh() {
  if (state.busy) return;
  setStatus("Refreshing", "working");
  try {
    const [dates, trash] = await Promise.all([requestJson("/gallery/api/dates"), requestJson("/gallery/admin/api/trash")]);
    state.dates = dates.dates;
    state.trash = trash.trash;
    if (state.selectedDate && state.dates.some((date) => date.date_folder === state.selectedDate)) {
      state.photos = (await requestJson(`/gallery/api/photos?date=${encodeURIComponent(state.selectedDate)}`)).photos;
    } else {
      state.selectedDate = null;
      state.photos = [];
    }
    render();
    setStatus("Ready", "ready");
  } catch (error) {
    setStatus(error.message || "Refresh failed", "error");
  }
}

function setView(view) {
  state.view = view;
  elements.published_tab.setAttribute("aria-pressed", String(view === "published"));
  elements.trash_tab.setAttribute("aria-pressed", String(view === "trash"));
  elements.published_view.hidden = view !== "published";
  elements.trash_view.hidden = view !== "trash";
  renderEmpty();
}

function render() {
  const publishedCount = state.dates.reduce((sum, date) => sum + date.count, 0);
  elements.published_count.textContent = publishedCount;
  elements.trash_count.textContent = state.trash.length;
  elements.summary.textContent = `${publishedCount} published photo${publishedCount === 1 ? "" : "s"} · ${state.trash.length} recoverable`;
  renderAlbums();
  renderTrash();
  renderEmpty();
}

function renderAlbums() {
  elements.albums.replaceChildren(...state.dates.map((date) => {
    const card = templates.album.content.firstElementChild.cloneNode(true);
    card.querySelector("img").src = date.cover_thumbnail_url || "/gallery/assets/frame-logo-square.svg";
    card.querySelector("img").alt = `Album cover for ${date.date_folder}`;
    card.querySelector("strong").textContent = formatDate(date.date_folder);
    card.querySelector("small").textContent = `${photoLabel(date.count)} · ${durationLabel(date.duration_ms)}`;
    card.querySelector(".album-open").addEventListener("click", () => openAlbum(date.date_folder));
    card.querySelector(".album-trash").addEventListener("click", () => manage("trash-album", date.date_folder, null, `Move every photo from ${formatDate(date.date_folder)} to trash?`));
    card.classList.toggle("selected", date.date_folder === state.selectedDate);
    return card;
  }));
  const selected = state.dates.find((date) => date.date_folder === state.selectedDate);
  elements.album_detail.hidden = !selected;
  if (!selected) return;
  elements.album_title.textContent = formatDate(selected.date_folder);
  elements.album_summary.textContent = `${photoLabel(selected.count)} · ${durationLabel(selected.duration_ms)}`;
  elements.photos.replaceChildren(...state.photos.map((photo) => {
    const card = templates.photo.content.firstElementChild.cloneNode(true);
    card.querySelector("img").src = photo.thumbnail_url;
    card.querySelector("img").alt = friendlyBase(photo.base);
    card.querySelector("strong").textContent = friendlyBase(photo.base);
    card.querySelector("small").textContent = formatTime(photo.processed_at);
    card.querySelector("button").addEventListener("click", () => manage("trash-photo", photo.date_folder, photo.base));
    return card;
  }));
}

async function openAlbum(dateFolder) {
  if (state.busy) return;
  state.selectedDate = dateFolder;
  setStatus("Loading album", "working");
  try {
    state.photos = (await requestJson(`/gallery/api/photos?date=${encodeURIComponent(dateFolder)}`)).photos;
    renderAlbums();
    elements.album_detail.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("Ready", "ready");
  } catch (error) {
    setStatus(error.message || "Album failed to load", "error");
  }
}

function renderTrash() {
  const groups = new Map();
  for (const photo of state.trash) {
    const group = groups.get(photo.date_folder) || [];
    group.push(photo);
    groups.set(photo.date_folder, group);
  }
  elements.trash_albums.replaceChildren(...[...groups.entries()].map(([dateFolder, photos]) => {
    const album = templates.trashAlbum.content.firstElementChild.cloneNode(true);
    album.querySelector("strong").textContent = formatDate(dateFolder);
    album.querySelector("small").textContent = photoLabel(photos.length);
    album.querySelector(".restore-album").addEventListener("click", () => manage("restore-album", dateFolder));
    album.querySelector(".purge-album").addEventListener("click", () => manage("purge-album", dateFolder, null, `Permanently delete all trashed published copies from ${formatDate(dateFolder)}?`));
    album.querySelector(".trash-photo-grid").replaceChildren(...photos.map((photo) => {
      const card = templates.trashPhoto.content.firstElementChild.cloneNode(true);
      card.querySelector("img").src = `/gallery/admin/thumb/${photo.date_folder}/${photo.base}.webp`;
      card.querySelector("img").alt = friendlyBase(photo.base);
      card.querySelector("strong").textContent = photo.original_name || friendlyBase(photo.base);
      card.querySelector("small").textContent = `Trashed ${formatTime(photo.trashed_at)}`;
      card.querySelector(".restore-photo").addEventListener("click", () => manage("restore-photo", photo.date_folder, photo.base));
      card.querySelector(".purge-photo").addEventListener("click", () => manage("purge-photo", photo.date_folder, photo.base, `Permanently delete the published copy of ${photo.original_name || friendlyBase(photo.base)}?`));
      return card;
    }));
    return album;
  }));
}

async function manage(action, dateFolder, base, confirmation) {
  if (state.busy || (confirmation && !window.confirm(confirmation))) return;
  state.busy = true;
  setControlsDisabled(true);
  setStatus("Applying change", "working");
  try {
    const result = await requestJson("/gallery/admin/api/manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, date_folder: dateFolder, base }),
    });
    setStatus(`${actionLabel(action)} · ${result.affected} photo${result.affected === 1 ? "" : "s"}`, "ready");
    await refreshAfterManagement();
  } catch (error) {
    setStatus(error.message || "Change failed", "error");
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

async function refreshAfterManagement() {
  const [dates, trash] = await Promise.all([requestJson("/gallery/api/dates"), requestJson("/gallery/admin/api/trash")]);
  state.dates = dates.dates;
  state.trash = trash.trash;
  if (state.selectedDate && state.dates.some((date) => date.date_folder === state.selectedDate)) {
    state.photos = (await requestJson(`/gallery/api/photos?date=${encodeURIComponent(state.selectedDate)}`)).photos;
  } else {
    state.selectedDate = null;
    state.photos = [];
  }
  render();
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button").forEach((button) => { button.disabled = disabled; });
}

function renderEmpty() {
  elements.empty.hidden = state.view === "published" ? state.dates.length > 0 : state.trash.length > 0;
}

function setStatus(message, kind) {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

async function requestJson(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function actionLabel(action) {
  return ({ "trash-photo": "Moved to trash", "restore-photo": "Restored", "purge-photo": "Published copy deleted", "trash-album": "Album moved to trash", "restore-album": "Album restored", "purge-album": "Published album copies deleted", "empty-trash": "Trash emptied" })[action] || "Updated";
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function formatTime(date) {
  return new Date(date).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function photoLabel(count) {
  return `${count} photo${count === 1 ? "" : "s"}`;
}

function durationLabel(ms) {
  if (!ms) return "one moment";
  const minutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours ? `${hours}h ` : ""}${remaining}m`;
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}
