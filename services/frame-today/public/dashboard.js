const elements = {
  status: document.querySelector("#dashboard-status"),
  albums: document.querySelector("#total-albums"),
  images: document.querySelector("#total-images"),
  currentImages: document.querySelector("#current-images"),
  duration: document.querySelector("#current-duration"),
  name: document.querySelector("#latest-name"),
  time: document.querySelector("#latest-time"),
  image: document.querySelector("#latest-image"),
  empty: document.querySelector("#latest-empty"),
  galleryLink: document.querySelector("#today-gallery-link"),
  galleryCopy: document.querySelector("#today-gallery-copy"),
  latestDate: document.querySelector("#latest-date"),
  latestBase: document.querySelector("#latest-base"),
  latestCount: document.querySelector("#latest-count"),
  latestUpdated: document.querySelector("#latest-updated"),
  copyViewer: document.querySelector("#copy-viewer"),
  message: document.querySelector("#dashboard-message"),
};

elements.copyViewer.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(new URL("/today/viewer", location.origin).href);
    elements.copyViewer.textContent = "Viewer URL copied";
    setTimeout(() => { elements.copyViewer.textContent = "Copy OBS viewer URL"; }, 1800);
  } catch {
    elements.message.textContent = "The viewer URL could not be copied from this browser.";
  }
});

refresh();
setInterval(refresh, 5000);

async function refresh() {
  try {
    const response = await fetch("/today/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status}).`);
    render(await response.json());
    elements.status.textContent = "Library connected";
    elements.status.className = "status-pill good";
    elements.message.textContent = "";
  } catch (error) {
    elements.status.textContent = "Library unavailable";
    elements.status.className = "status-pill bad";
    elements.message.textContent = error instanceof Error ? error.message : String(error);
  }
}

function render(summary) {
  const gallery = summary.current_gallery;
  const latest = summary.latest;
  const photo = summary.latest_photo;
  elements.albums.textContent = String(summary.total_albums);
  elements.images.textContent = String(summary.total_images);
  elements.currentImages.textContent = String(gallery?.count ?? 0);
  elements.duration.textContent = durationLabel(gallery?.duration_ms ?? 0);
  elements.name.textContent = photo ? friendlyBase(photo.base) : "Waiting for a photo";
  elements.time.textContent = photo ? formatDate(photo.processed_at) : "No publication yet";
  elements.image.hidden = !photo;
  elements.empty.hidden = Boolean(photo);
  if (photo) elements.image.src = photo.thumbnail_url;
  else elements.image.removeAttribute("src");
  if (gallery) {
    elements.galleryLink.href = `/today/gallery/${gallery.date_folder}/`;
    elements.galleryLink.removeAttribute("aria-disabled");
    elements.galleryCopy.textContent = `${gallery.date_folder} · ${gallery.count} photo${gallery.count === 1 ? "" : "s"}`;
  } else {
    elements.galleryLink.href = "/today/gallery";
    elements.galleryLink.setAttribute("aria-disabled", "true");
    elements.galleryCopy.textContent = "No current album";
  }
  elements.latestDate.textContent = latest?.date_folder ?? "None";
  elements.latestBase.textContent = latest?.latest_base ?? "None";
  elements.latestCount.textContent = String(latest?.count_today ?? 0);
  elements.latestUpdated.textContent = latest?.updated_at ? formatDate(latest.updated_at) : "Never";
}

function durationLabel(ms) {
  if (ms < 60_000) return ms > 0 ? "< 1 min" : "0 min";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}
