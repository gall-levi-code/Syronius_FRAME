const elements = {
  home: document.querySelector("#gallery-home"),
  allGalleries: document.querySelector("#all-galleries"),
  headingEyebrow: document.querySelector("#heading-eyebrow"),
  heading: document.querySelector("#date-heading"),
  summary: document.querySelector("#date-summary"),
  count: document.querySelector("#photo-count"),
  refreshState: document.querySelector("#refresh-state"),
  refresh: document.querySelector("#refresh"),
  dateGallery: document.querySelector("#date-gallery"),
  photoGallery: document.querySelector("#photo-gallery"),
  empty: document.querySelector("#empty"),
  dateTemplate: document.querySelector("#date-template"),
  photoTemplate: document.querySelector("#photo-template"),
  lightbox: document.querySelector("#lightbox"),
  lightboxViewport: document.querySelector("#lightbox-viewport"),
  lightboxImage: document.querySelector("#lightbox-image"),
  lightboxTitle: document.querySelector("#lightbox-title"),
  lightboxPosition: document.querySelector("#lightbox-position"),
  lightboxDetails: document.querySelector("#lightbox-details"),
  lightboxPrevious: document.querySelector("#lightbox-previous"),
  lightboxNext: document.querySelector("#lightbox-next"),
  lightboxClose: document.querySelector("#lightbox-close"),
  zoomSelect: document.querySelector("#zoom-select"),
  zoomFit: document.querySelector("#zoom-fit"),
};

const route = parseRoute();
const state = { dates: [], photos: [], currentIndex: -1, signature: "" };
elements.home.href = route.root;
elements.allGalleries.href = route.root;

elements.refresh.addEventListener("click", () => refresh(true));
elements.lightboxClose.addEventListener("click", () => elements.lightbox.close());
elements.lightboxPrevious.addEventListener("click", () => moveLightbox(-1));
elements.lightboxNext.addEventListener("click", () => moveLightbox(1));
elements.zoomSelect.addEventListener("change", applyZoom);
elements.zoomFit.addEventListener("click", () => {
  elements.zoomSelect.value = "fit";
  applyZoom();
});
elements.lightbox.addEventListener("click", (event) => {
  if (event.target === elements.lightbox) elements.lightbox.close();
});
document.addEventListener("keydown", (event) => {
  if (!elements.lightbox.open) return;
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
});

await refresh(true);
setInterval(() => refresh(false), 5000);

async function refresh(forceRender) {
  try {
    elements.refreshState.textContent = "Refreshing...";
    const datesResult = await requestJson("/gallery/api/dates");
    state.dates = datesResult.dates;
    if (route.date) {
      const photosResult = await requestJson(`/gallery/api/photos?date=${encodeURIComponent(route.date)}`);
      state.photos = photosResult.photos;
    }
    const signature = JSON.stringify([
      state.dates.map((date) => [date.date_folder, date.count, date.latest_at]),
      state.photos.map((photo) => [photo.base, photo.processed_at]),
    ]);
    if (forceRender || signature !== state.signature) {
      state.signature = signature;
      route.date ? renderDay() : renderDates();
    }
    elements.refreshState.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    elements.refreshState.textContent = error.message || "Gallery unavailable";
  }
}

function renderDates() {
  const total = state.dates.reduce((sum, date) => sum + date.count, 0);
  elements.headingEyebrow.textContent = "Published galleries";
  elements.heading.textContent = "Photo days";
  elements.summary.textContent = `${state.dates.length} day${state.dates.length === 1 ? "" : "s"} of published photos`;
  elements.count.textContent = `${total} photo${total === 1 ? "" : "s"}`;
  elements.empty.hidden = state.dates.length > 0;
  elements.photoGallery.hidden = true;
  elements.dateGallery.hidden = false;
  elements.allGalleries.hidden = true;
  elements.dateGallery.replaceChildren(...state.dates.map((date) => {
    const card = elements.dateTemplate.content.firstElementChild.cloneNode(true);
    const link = card.querySelector("a");
    const image = card.querySelector("img");
    link.href = `${route.root}/${date.date_folder}/`;
    image.src = date.cover_thumbnail_url || "/gallery/assets/frame-logo-square.svg";
    image.alt = `First photo from ${formatLongDate(date.date_folder)}`;
    card.querySelector("strong").textContent = formatLongDate(date.date_folder);
    card.querySelector(".date-card-stats").textContent = `${photoLabel(date.count)} · ${durationLabel(date.duration_ms)}`;
    return card;
  }));
}

function renderDay() {
  const date = state.dates.find((item) => item.date_folder === route.date);
  elements.headingEyebrow.textContent = "Published photos";
  elements.heading.textContent = formatLongDate(route.date);
  elements.summary.textContent = date ? `${photoLabel(date.count)} · ${durationLabel(date.duration_ms)}` : photoLabel(state.photos.length);
  elements.count.textContent = photoLabel(state.photos.length);
  elements.empty.hidden = state.photos.length > 0;
  elements.dateGallery.hidden = true;
  elements.photoGallery.hidden = false;
  elements.allGalleries.hidden = false;
  elements.photoGallery.replaceChildren(...state.photos.map((photo, index) => {
    const card = elements.photoTemplate.content.firstElementChild.cloneNode(true);
    const image = card.querySelector("img");
    image.src = photo.thumbnail_url;
    image.alt = friendlyBase(photo.base);
    card.querySelector("strong").textContent = friendlyBase(photo.base);
    card.querySelector("small").textContent = formatTime(photo.processed_at);
    card.querySelector("button").addEventListener("click", () => openLightbox(index));
    return card;
  }));
}

function openLightbox(index) {
  state.currentIndex = index;
  elements.zoomSelect.value = "fit";
  renderLightbox();
  elements.lightbox.showModal();
}

function moveLightbox(offset) {
  const target = state.currentIndex + offset;
  if (target < 0 || target >= state.photos.length) return;
  state.currentIndex = target;
  elements.zoomSelect.value = "fit";
  renderLightbox();
}

function renderLightbox() {
  const photo = state.photos[state.currentIndex];
  if (!photo) return;
  elements.lightboxImage.src = photo.image_url;
  elements.lightboxImage.alt = friendlyBase(photo.base);
  elements.lightboxTitle.textContent = friendlyBase(photo.base);
  elements.lightboxPosition.textContent = `${state.currentIndex + 1} of ${state.photos.length}`;
  elements.lightboxDetails.textContent = photo.camera_text || "Camera information unavailable";
  elements.lightboxDetails.hidden = !photo.camera_text;
  elements.lightboxPrevious.disabled = state.currentIndex <= 0;
  elements.lightboxNext.disabled = state.currentIndex >= state.photos.length - 1;
  applyZoom();
}

function applyZoom() {
  const value = elements.zoomSelect.value;
  elements.lightboxViewport.scrollTo({ top: 0, left: 0 });
  elements.lightboxImage.classList.toggle("fit", value === "fit");
  if (value === "fit") {
    elements.lightboxImage.style.width = "";
    elements.lightboxImage.style.height = "";
    return;
  }
  const photo = state.photos[state.currentIndex];
  const scale = Number(value) / 100;
  elements.lightboxImage.style.width = `${Math.max(1, (photo?.width || elements.lightboxImage.naturalWidth) * scale)}px`;
  elements.lightboxImage.style.height = "auto";
}

function parseRoute() {
  const match = location.pathname.match(/^(\/today\/gallery|\/gallery)(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/);
  return { root: match?.[1] || "/today/gallery", date: match?.[2] || null };
}

async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function formatLongDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function durationLabel(ms) {
  if (!ms) return "one moment";
  const minutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (!hours) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"}${remaining ? ` ${remaining} minute${remaining === 1 ? "" : "s"}` : ""}`;
}

function photoLabel(count) {
  return `${count} photo${count === 1 ? "" : "s"}`;
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}
