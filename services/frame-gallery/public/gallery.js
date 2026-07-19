import { buildGalleryShareUrls, captureTimestamp, matchExplorePhotos, routeSegments, simulatedRouteSegments } from "./explore.js?v=gallery-share-7";

const elements = {
  home: document.querySelector("#gallery-home"),
  brandLogo: document.querySelector("#brand-logo"),
  brandName: document.querySelector("#brand-name"),
  galleryTitle: document.querySelector("#gallery-title"),
  manage: document.querySelector("#manage-gallery"),
  allGalleries: document.querySelector("#all-galleries"),
  headingEyebrow: document.querySelector("#heading-eyebrow"),
  heading: document.querySelector("#date-heading"),
  summary: document.querySelector("#date-summary"),
  count: document.querySelector("#photo-count"),
  refreshState: document.querySelector("#refresh-state"),
  themeToggle: document.querySelector("#theme-toggle"),
  dateGallery: document.querySelector("#date-gallery"),
  photoGallery: document.querySelector("#photo-gallery"),
  viewSwitch: document.querySelector("#view-switch"),
  photosView: document.querySelector("#photos-view"),
  exploreView: document.querySelector("#explore-view"),
  explorePanel: document.querySelector("#explore-panel"),
  exploreMap: document.querySelector("#explore-map"),
  exploreMapState: document.querySelector("#explore-map-state"),
  exploreSummary: document.querySelector("#explore-summary"),
  explorePrevious: document.querySelector("#explore-previous"),
  exploreNext: document.querySelector("#explore-next"),
  exploreFilmstrip: document.querySelector("#explore-filmstrip"),
  empty: document.querySelector("#empty"),
  dateTemplate: document.querySelector("#date-template"),
  photoTemplate: document.querySelector("#photo-template"),
  lightbox: document.querySelector("#lightbox"),
  lightboxViewport: document.querySelector("#lightbox-viewport"),
  lightboxImage: document.querySelector("#lightbox-image"),
  lightboxTitle: document.querySelector("#lightbox-title"),
  lightboxPosition: document.querySelector("#lightbox-position"),
  lightboxDetails: document.querySelector("#lightbox-details"),
  lightboxCameraText: document.querySelector("#lightbox-camera-text"),
  lightboxExplore: document.querySelector("#lightbox-explore"),
  lightboxShare: document.querySelector("#lightbox-share"),
  lightboxPrevious: document.querySelector("#lightbox-previous"),
  lightboxNext: document.querySelector("#lightbox-next"),
  lightboxClose: document.querySelector("#lightbox-close"),
  zoomSlider: document.querySelector("#zoom-slider"),
  zoomValue: document.querySelector("#zoom-value"),
  zoomFit: document.querySelector("#zoom-fit"),
  shareDialog: document.querySelector("#share-dialog"),
  shareGalleryUrl: document.querySelector("#share-gallery-url"),
  copyGalleryUrl: document.querySelector("#copy-gallery-url"),
  shareExploreRow: document.querySelector("#share-explore-row"),
  shareExploreUrl: document.querySelector("#share-explore-url"),
  copyExploreUrl: document.querySelector("#copy-explore-url"),
  shareQr: document.querySelector("#share-qr"),
  shareQrCode: document.querySelector("#share-qr-code"),
  shareQrLabel: document.querySelector("#share-qr-label"),
  shareStatus: document.querySelector("#share-status"),
};
const icons = {
  moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.1A8.4 8.4 0 0 1 8.9 3.6 8.5 8.5 0 1 0 20.4 15.1Z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/></svg>`,
  map: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Z"/><path d="M9 3v15"/><path d="M15 6v15"/><circle cx="12" cy="10" r="2"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 13v7h14v-7"/></svg>`,
};

const ZOOM_MIN = 25;
const ZOOM_MAX = 200;
const DEFAULT_ZOOM = 100;
const CLICK_ZOOM_STAGES = [50, 100];
const PAN_DRAG_THRESHOLD = 12;
const PAN_EASING_RATE = 0.2;
const PAN_SETTLE_THRESHOLD = 0.75;
const route = parseRoute();
const initialUrlState = readUrlState();
const state = {
  dates: [],
  photos: [],
  explore: null,
  exploreCheckedAt: 0,
  matches: new Map(),
  view: initialUrlState.view,
  selectedBase: initialUrlState.photo,
  map: null,
  mapLayers: null,
  mapDirty: true,
  markers: new Map(),
  currentIndex: -1,
  signature: "",
  branding: null,
  userThemeMode: readStoredTheme(),
  zoomMode: "fit",
  zoomValue: DEFAULT_ZOOM,
  panPointer: null,
  zoomSliderPointer: null,
  panAnimation: null,
  panTarget: null,
};
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const finePointer = matchMedia("(pointer: fine)");
let shareQrCode;
elements.home.href = route.root;
elements.allGalleries.href = route.root;
elements.lightboxImage.draggable = false;
elements.lightboxExplore.innerHTML = `${icons.map}<span>View on map</span>`;
elements.lightboxShare.innerHTML = `${icons.share}<span>Share</span>`;

elements.themeToggle.addEventListener("click", toggleTheme);
elements.photosView.addEventListener("click", () => setGalleryView("photos", { history: "push" }));
elements.exploreView.addEventListener("click", () => setGalleryView("explore", { history: "push" }));
elements.explorePrevious.addEventListener("click", () => moveExplore(-1));
elements.exploreNext.addEventListener("click", () => moveExplore(1));
elements.lightboxExplore.addEventListener("click", () => {
  const photo = state.photos[state.currentIndex];
  if (!photo || !state.matches.has(photo.base)) return;
  elements.lightbox.close();
  selectExplorePhoto(photo.base, { history: "push", focus: true });
});
elements.lightboxShare.addEventListener("click", () => {
  const photo = state.photos[state.currentIndex];
  if (photo) openShareDialog(location.href, state.matches.has(photo.base), photo.base);
});
elements.copyGalleryUrl.addEventListener("click", () => copyShareUrl(elements.shareGalleryUrl, elements.copyGalleryUrl, "Gallery view"));
elements.copyExploreUrl.addEventListener("click", () => copyShareUrl(elements.shareExploreUrl, elements.copyExploreUrl, "Explore view"));
for (const input of [elements.shareGalleryUrl, elements.shareExploreUrl]) {
  input.addEventListener("focus", () => input.select());
  input.addEventListener("click", () => input.select());
}
elements.shareDialog.addEventListener("close", resetShareDialog);
systemTheme.addEventListener("change", () => applyBranding());
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    applyBranding();
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    state.userThemeMode = event.newValue;
    applyBranding();
  }
});
elements.lightboxClose.addEventListener("click", () => elements.lightbox.close());
elements.lightboxPrevious.addEventListener("click", () => moveLightbox(-1));
elements.lightboxNext.addEventListener("click", () => moveLightbox(1));
elements.zoomSlider.addEventListener("input", () => {
  const center = currentImageCenter();
  state.zoomMode = "percent";
  state.zoomValue = clamp(Number(elements.zoomSlider.value), ZOOM_MIN, ZOOM_MAX);
  applyZoom({ imagePoint: center });
});
elements.zoomSlider.addEventListener("pointerdown", startZoomSliderPointer);
elements.zoomSlider.addEventListener("pointermove", moveZoomSliderPointer);
elements.zoomSlider.addEventListener("pointerup", finishZoomSliderPointer);
elements.zoomSlider.addEventListener("pointercancel", finishZoomSliderPointer);
elements.zoomFit.addEventListener("click", resetZoom);
elements.lightboxViewport.addEventListener("pointerdown", startViewportPointer);
elements.lightboxViewport.addEventListener("pointermove", moveViewportPointer);
elements.lightboxViewport.addEventListener("pointerup", finishViewportPointer);
elements.lightboxViewport.addEventListener("pointercancel", cancelViewportPointer);
elements.lightboxImage.addEventListener("load", () => {
  if (elements.lightbox.open) applyZoom({ resetScroll: state.zoomMode === "fit" });
});
elements.lightbox.addEventListener("click", (event) => {
  if (event.target === elements.lightbox) elements.lightbox.close();
});
elements.lightbox.addEventListener("close", () => {
  cancelViewportPointer();
  if (elements.shareDialog.open) elements.shareDialog.close();
  if (state.view === "photos" && state.selectedBase) {
    state.selectedBase = null;
    writeUrlState("replace");
  }
});
document.addEventListener("keydown", (event) => {
  if (!elements.lightbox.open) return;
  if (event.target instanceof Element && event.target.closest("input, button, select, textarea, a")) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveLightbox(-1);
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveLightbox(1);
  }
});
window.addEventListener("popstate", () => {
  if (elements.shareDialog.open) elements.shareDialog.close();
  const urlState = readUrlState();
  state.view = urlState.view;
  state.selectedBase = urlState.photo;
  if (route.date) applyGalleryView({ openPopup: true });
});

await loadBranding();
await refresh(true);
setInterval(() => {
  if (!document.hidden) refresh(false);
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh(false);
});

async function loadBranding() {
  try {
    const result = await requestJson("/gallery/api/branding");
    state.branding = result.branding;
    applyBranding();
  } catch {
    applyBranding();
  }
}

function applyBranding() {
  const branding = state.branding;
  const portalProfile = readPortalThemeProfile();
  const profile = portalProfile || branding?.active_profile;
  const mode = resolvedThemeMode();
  const palette = profile?.palettes?.[mode];
  if (branding) {
    elements.brandName.textContent = branding.brand_name;
    elements.galleryTitle.textContent = branding.gallery_title;
    elements.home.setAttribute("aria-label", `${branding.brand_name} ${branding.gallery_title}`);
    document.title = `${branding.brand_name} ${branding.gallery_title}`;
    const logoUrl = branding.logo?.url || "/gallery/assets/frame-logo-square.svg";
    if (elements.brandLogo.getAttribute("src") !== logoUrl) elements.brandLogo.src = logoUrl;
    elements.brandLogo.alt = branding.logo ? `${branding.brand_name} logo` : "";
  }
  if (palette) {
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.dataset.themeMode = mode;
    root.style.colorScheme = mode === "day" ? "light" : "dark";
    if (portalProfile && window.FrameTheme) {
      window.FrameTheme.apply(mode);
    } else {
      for (const [key, value] of Object.entries(palette)) {
        root.style.setProperty(`--${kebab(key)}`, value);
      }
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.background || palette.page);
  }
  const nextMode = mode === "day" ? "night" : "day";
  elements.themeToggle.innerHTML = mode === "day" ? icons.sun : icons.moon;
  elements.themeToggle.dataset.mode = mode;
  elements.themeToggle.setAttribute("aria-label", `Switch to ${nextMode} mode`);
  elements.themeToggle.title = `Switch to ${nextMode} mode`;
  elements.themeToggle.setAttribute("aria-pressed", String(mode === "day"));
}

function toggleTheme() {
  const nextMode = resolvedThemeMode() === "day" ? "night" : "day";
  state.userThemeMode = nextMode;
  writeStoredTheme(nextMode);
  applyBranding();
}

function resolvedThemeMode() {
  if (state.userThemeMode === "day" || state.userThemeMode === "night") return state.userThemeMode;
  const configured = state.branding?.mode || "system";
  if (configured === "day" || configured === "night") return configured;
  return systemTheme.matches ? "night" : "day";
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("frame-theme") || localStorage.getItem("frame-gallery-theme-mode");
    if (stored === "day" || stored === "night") {
      localStorage.setItem("frame-theme", stored);
      return stored;
    }
  } catch {}
  return null;
}

function readPortalThemeProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem("frame-theme-profile") || "null");
    return profile?.palettes ? profile : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(mode) {
  try {
    localStorage.setItem("frame-theme", mode);
  } catch {}
  window.FrameTheme?.saveMode?.(mode);
}

async function refresh(forceRender) {
  try {
    elements.refreshState.textContent = "Refreshing...";
    if (route.date) {
      const [datesResult, photosResult] = await Promise.all([
        requestJson("/gallery/api/dates"),
        requestJson(`/gallery/api/photos?date=${encodeURIComponent(route.date)}`),
      ]);
      state.dates = datesResult.dates;
      state.photos = photosResult.photos;
      const date = state.dates.find((item) => item.date_folder === route.date);
      if (date?.has_explore === false) {
        state.explore = null;
        state.exploreCheckedAt = Date.now();
      } else if (forceRender || (!state.explore && date?.has_explore) || Date.now() - state.exploreCheckedAt >= 30_000) {
        state.explore = unwrapExplore(await requestOptionalJson(
          `/gallery/api/explore?date=${encodeURIComponent(route.date)}`,
          { cache: "no-cache" },
        ));
        state.exploreCheckedAt = Date.now();
      }
      state.matches = matchExplorePhotos(state.photos, state.explore);
    } else {
      state.dates = (await requestJson("/gallery/api/dates")).dates;
    }
    const signature = JSON.stringify([
      state.dates.map((date) => [date.date_folder, date.count, date.latest_at, date.has_explore]),
      state.photos.map((photo) => [photo.base, photo.processed_at, photo.capture_clock]),
      state.explore && [
        state.explore.updated_at,
        state.explore.routes?.map((item) => [item.id, item.segments?.length, item.segments?.reduce((sum, segment) => sum + segment.length, 0)]),
        Object.keys(state.explore.placements || {}).sort(),
      ],
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
  elements.explorePanel.hidden = true;
  document.body.classList.remove("is-exploring");
  elements.viewSwitch.hidden = true;
  elements.dateGallery.hidden = false;
  elements.allGalleries.hidden = true;
  elements.dateGallery.replaceChildren(...state.dates.map((date) => {
    const card = elements.dateTemplate.content.firstElementChild.cloneNode(true);
    const link = card.querySelector(".date-open");
    const image = card.querySelector("img");
    const dayHref = `${route.root}/${date.date_folder}/`;
    link.href = dayHref;
    image.src = date.cover_thumbnail_url || "/gallery/assets/frame-logo-square.svg";
    image.alt = `First photo from ${formatLongDate(date.date_folder)}`;
    card.querySelector("strong").textContent = formatLongDate(date.date_folder);
    card.querySelector(".date-card-stats").textContent = `${photoLabel(date.count)} - ${durationLabel(date.duration_ms)}`;
    const mapLink = card.querySelector(".date-map-jump");
    if (date.has_explore) {
      card.classList.add("has-map-action");
      mapLink.hidden = false;
      mapLink.href = `${dayHref}?view=explore`;
      mapLink.innerHTML = icons.map;
      mapLink.setAttribute("aria-label", `Explore ${formatLongDate(date.date_folder)} on a map`);
      mapLink.title = "Explore map";
    }
    const shareButton = card.querySelector(".date-share");
    shareButton.innerHTML = icons.share;
    shareButton.setAttribute("aria-label", `Share ${formatLongDate(date.date_folder)}`);
    shareButton.title = "Share gallery";
    shareButton.addEventListener("click", () => openShareDialog(dayHref, date.has_explore));
    return card;
  }));
}

function renderDay() {
  const date = state.dates.find((item) => item.date_folder === route.date);
  const canExplore = hasExplore();
  elements.headingEyebrow.textContent = "Published photos";
  elements.heading.textContent = formatLongDate(route.date);
  elements.summary.textContent = date ? `${photoLabel(date.count)} - ${durationLabel(date.duration_ms)}` : photoLabel(state.photos.length);
  elements.count.textContent = photoLabel(state.photos.length);
  elements.dateGallery.hidden = true;
  elements.viewSwitch.hidden = !canExplore;
  elements.allGalleries.hidden = false;
  state.mapDirty = true;
  elements.photoGallery.replaceChildren(...state.photos.map((photo, index) => {
    const card = elements.photoTemplate.content.firstElementChild.cloneNode(true);
    const image = card.querySelector("img");
    image.src = photo.thumbnail_url;
    image.alt = friendlyBase(photo.base);
    card.querySelector("strong").textContent = friendlyBase(photo.base);
    card.querySelector("small").textContent = formatTime(photo.processed_at);
    card.querySelector(".photo-open").addEventListener("click", () => openLightbox(index));
    const mapButton = card.querySelector(".photo-map-jump");
    if (state.matches.has(photo.base)) {
      card.classList.add("has-map-action");
      mapButton.hidden = false;
      mapButton.innerHTML = icons.map;
      mapButton.setAttribute("aria-label", `Show ${friendlyBase(photo.base)} on the map`);
      mapButton.title = "Show on map";
      mapButton.addEventListener("click", () => selectExplorePhoto(photo.base, { history: "push", focus: true }));
    }
    const shareButton = card.querySelector(".photo-share");
    shareButton.innerHTML = icons.share;
    shareButton.setAttribute("aria-label", `Share ${friendlyBase(photo.base)}`);
    shareButton.title = "Share photo";
    shareButton.addEventListener("click", () => openShareDialog(location.href, state.matches.has(photo.base), photo.base));
    return card;
  }));
  renderExploreFilmstrip();
  applyGalleryView({ rebuildMap: true, openPopup: Boolean(state.selectedBase) });
}

function openLightbox(index) {
  const photo = state.photos[index];
  if (!photo) return;
  state.currentIndex = index;
  resetZoomState();
  if (!elements.lightbox.open) elements.lightbox.showModal();
  renderLightbox();
}

function moveLightbox(offset) {
  const target = state.currentIndex + offset;
  if (target < 0 || target >= state.photos.length) return;
  state.currentIndex = target;
  if (state.view === "photos" && state.selectedBase) {
    state.selectedBase = state.photos[target].base;
    writeUrlState("replace");
  }
  resetZoomState();
  renderLightbox();
}

function renderLightbox() {
  const photo = state.photos[state.currentIndex];
  if (!photo) return;
  elements.lightboxImage.src = photo.image_url;
  elements.lightboxImage.alt = friendlyBase(photo.base);
  elements.lightboxTitle.textContent = friendlyBase(photo.base);
  elements.lightboxPosition.textContent = `${state.currentIndex + 1} of ${state.photos.length}`;
  elements.lightboxCameraText.textContent = photo.camera_text || "";
  elements.lightboxCameraText.hidden = !photo.camera_text;
  elements.lightboxExplore.hidden = !state.matches.has(photo.base);
  elements.lightboxDetails.hidden = false;
  elements.lightboxPrevious.disabled = state.currentIndex <= 0;
  elements.lightboxNext.disabled = state.currentIndex >= state.photos.length - 1;
  applyZoom();
}

function openShareDialog(href, exploreAvailable, selectedBase = null) {
  const urls = buildGalleryShareUrls(new URL(href, location.href).toString(), exploreAvailable, selectedBase);
  elements.shareGalleryUrl.value = urls.gallery;
  elements.shareExploreRow.hidden = !urls.explore;
  elements.shareExploreUrl.value = urls.explore || "";
  resetShareDialog();
  renderShareQr(urls.current, urls.current === urls.explore ? "Explore" : "Gallery");
  elements.shareDialog.showModal();
}

function renderShareQr(url, label) {
  elements.shareQr.hidden = false;
  elements.shareQrLabel.textContent = `Scan ${label} view`;
  try {
    const QRCode = window.QRCode;
    if (typeof QRCode !== "function") throw new Error("QR encoder unavailable");
    if (!shareQrCode) {
      shareQrCode = new QRCode(elements.shareQrCode, {
        width: 220,
        height: 220,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M,
      });
    }
    shareQrCode.makeCode(url);
  } catch {
    elements.shareQr.hidden = true;
    elements.shareStatus.textContent = "QR code unavailable. Copy a direct link instead.";
    elements.shareStatus.dataset.error = "true";
  }
}

async function copyShareUrl(input, button, label) {
  const url = input.value;
  button.textContent = "Copying";
  elements.shareStatus.textContent = `Copying ${label.toLowerCase()} link...`;
  elements.shareStatus.removeAttribute("data-error");
  try {
    await copyText(input);
    if (!elements.shareDialog.open || input.value !== url) return;
    button.textContent = "Copied";
    elements.shareStatus.textContent = `${label} link copied.`;
    elements.shareStatus.removeAttribute("data-error");
    button.focus();
    setTimeout(() => {
      if (button.textContent === "Copied") button.textContent = "Copy";
    }, 1200);
  } catch {
    if (!elements.shareDialog.open || input.value !== url) return;
    input.focus();
    input.select();
    button.textContent = "Copy";
    elements.shareStatus.textContent = "The browser did not confirm the copy. The link is selected so you can copy it manually.";
    elements.shareStatus.dataset.error = "true";
  }
}

async function copyText(input) {
  input.focus();
  input.select();
  try {
    if (document.execCommand("copy")) return;
  } catch {}
  if (!navigator.clipboard?.writeText) throw new Error("Copy unavailable");
  await Promise.race([
    navigator.clipboard.writeText(input.value),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Copy timed out")), 2000)),
  ]);
}

function resetShareDialog() {
  elements.copyGalleryUrl.textContent = "Copy";
  elements.copyExploreUrl.textContent = "Copy";
  elements.shareStatus.textContent = "";
  elements.shareStatus.removeAttribute("data-error");
}

function hasExplore() {
  return routeSegments(state.explore).some((segment) => segment.length > 0) || state.matches.size > 0;
}

function setGalleryView(view, options = {}) {
  const nextView = view === "explore" && hasExplore() ? "explore" : "photos";
  const changed = state.view !== nextView || (nextView === "photos" && state.selectedBase);
  state.view = nextView;
  if (state.view === "photos") state.selectedBase = null;
  if (options.history && changed) writeUrlState(options.history);
  applyGalleryView();
}

function applyGalleryView(options = {}) {
  if (state.view === "explore" && !hasExplore()) {
    state.view = "photos";
    state.selectedBase = null;
    writeUrlState("replace");
  }
  const exploring = state.view === "explore";
  document.body.classList.toggle("is-exploring", exploring);
  elements.manage.href = route.date
    ? exploring
      ? `/gallery/admin/explore?date=${encodeURIComponent(route.date)}`
      : `/gallery/admin?date=${encodeURIComponent(route.date)}`
    : "/today/gallery/admin";
  elements.photosView.setAttribute("aria-pressed", String(!exploring));
  elements.exploreView.setAttribute("aria-pressed", String(exploring));
  elements.photoGallery.hidden = exploring;
  elements.explorePanel.hidden = !exploring;
  elements.empty.hidden = exploring || state.photos.length > 0;
  if (!exploring) {
    const photoIndex = state.selectedBase ? state.photos.findIndex((photo) => photo.base === state.selectedBase) : -1;
    if (photoIndex >= 0) {
      openLightbox(photoIndex);
    } else {
      if (state.selectedBase) {
        state.selectedBase = null;
        writeUrlState("replace");
      }
      if (elements.lightbox.open) elements.lightbox.close();
    }
    return;
  }

  if (elements.lightbox.open) elements.lightbox.close();

  requestAnimationFrame(() => {
    if (options.rebuildMap || state.mapDirty || !state.mapLayers) renderExploreMap();
    else state.map?.invalidateSize();
    if (state.selectedBase && state.matches.has(state.selectedBase)) {
      showExploreSelection(state.selectedBase, options);
    } else if (state.selectedBase) {
      state.selectedBase = null;
      writeUrlState("replace");
      clearExploreSelection();
    } else {
      clearExploreSelection();
    }
  });
}

function selectExplorePhoto(base, options = {}) {
  if (!state.matches.has(base)) return;
  const changed = state.view !== "explore" || state.selectedBase !== base;
  state.view = "explore";
  state.selectedBase = base;
  if (options.history && changed) writeUrlState(options.history);
  applyGalleryView({ openPopup: true, ...options });
}

function moveExplore(offset) {
  const bases = [...elements.exploreFilmstrip.querySelectorAll("button[data-base]")].map((button) => button.dataset.base);
  if (!bases.length) return;
  let index = bases.indexOf(state.selectedBase);
  if (index < 0) index = offset > 0 ? -1 : 0;
  selectExplorePhoto(bases[(index + offset + bases.length) % bases.length], { history: "push", openPopup: true, focus: true });
}

function renderExploreFilmstrip() {
  const mapped = state.photos.map((photo, index) => ({ photo, index, match: state.matches.get(photo.base) }))
    .filter((item) => item.match)
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.match.time) ? left.match.time : captureSortTime(left.photo);
      const rightTime = Number.isFinite(right.match.time) ? right.match.time : captureSortTime(right.photo);
      if (leftTime !== null && rightTime !== null) return leftTime - rightTime;
      if (leftTime !== null) return -1;
      if (rightTime !== null) return 1;
      return left.index - right.index;
    });
  elements.exploreSummary.textContent = `${mapped.length} of ${state.photos.length} mapped`;
  elements.explorePrevious.disabled = mapped.length < 2;
  elements.exploreNext.disabled = mapped.length < 2;
  elements.exploreFilmstrip.replaceChildren(...mapped.map(({ photo }) => {
    const item = document.createElement("div");
    const button = document.createElement("button");
    const image = document.createElement("img");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const time = document.createElement("small");
    item.setAttribute("role", "listitem");
    button.type = "button";
    button.dataset.base = photo.base;
    button.setAttribute("aria-label", `Show ${friendlyBase(photo.base)} on the map`);
    image.src = photo.thumbnail_url;
    image.alt = "";
    image.loading = "lazy";
    title.textContent = friendlyBase(photo.base);
    time.textContent = captureTimeLabel(photo);
    copy.append(title, time);
    button.append(image, copy);
    button.addEventListener("click", () => selectExplorePhoto(photo.base, { history: "push", openPopup: true }));
    item.append(button);
    return item;
  }));
}

function renderExploreMap() {
  if (!window.L) {
    elements.exploreMapState.textContent = "The map could not load. Check your connection and try again.";
    elements.exploreMapState.hidden = false;
    return;
  }
  elements.exploreMapState.hidden = true;
  if (!state.map) {
    state.map = window.L.map(elements.exploreMap, { preferCanvas: true });
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(state.map);
    state.mapLayers = window.L.layerGroup().addTo(state.map);
  }
  state.map.invalidateSize();
  state.mapLayers.clearLayers();
  state.markers.clear();
  const bounds = window.L.latLngBounds();
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2cb4fb";
  const markerBorder = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#0b222e";

  for (const segment of routeSegments(state.explore)) {
    const points = segment.filter((point) => validMapPoint(point)).map(([, lat, lon]) => [lat, lon]);
    if (!points.length) continue;
    window.L.polyline(points, { color: accent, weight: 4, opacity: 0.82 }).addTo(state.mapLayers);
    points.forEach((point) => bounds.extend(point));
  }
  for (const segment of simulatedRouteSegments(state.photos, state.explore)) {
    const points = segment.filter((point) => validMapPoint(point)).map(([, lat, lon]) => [lat, lon]);
    if (points.length < 2) continue;
    window.L.polyline(points, { color: accent, weight: 3, opacity: 0.75, dashArray: "7 8", interactive: false }).addTo(state.mapLayers);
    points.forEach((point) => bounds.extend(point));
  }
  for (const photo of state.photos) {
    const match = state.matches.get(photo.base);
    if (!match) continue;
    const marker = window.L.circleMarker([match.lat, match.lon], {
      radius: 6,
      color: markerBorder,
      weight: 2,
      fillColor: accent,
      fillOpacity: 0.95,
    }).bindPopup(photoPopup(photo), { minWidth: 180, maxWidth: 230, autoPan: false });
    marker.on("click", () => selectExplorePhoto(photo.base, { history: "push", openPopup: true }));
    marker.addTo(state.mapLayers);
    state.markers.set(photo.base, marker);
    bounds.extend(marker.getLatLng());
  }
  if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
  state.mapDirty = false;
}

function showExploreSelection(base, options = {}) {
  const marker = state.markers.get(base);
  if (!marker) return;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--secondary").trim() || "#2cfbb3";
  const defaultColor = styles.getPropertyValue("--accent").trim() || "#2cb4fb";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const [markerBase, item] of state.markers) {
    item.setStyle({ radius: markerBase === base ? 9 : 6, fillColor: markerBase === base ? accent : defaultColor });
  }
  let selectedButton = null;
  for (const button of elements.exploreFilmstrip.querySelectorAll("button[data-base]")) {
    const selected = button.dataset.base === base;
    button.classList.toggle("is-selected", selected);
    if (selected) {
      button.setAttribute("aria-current", "true");
      selectedButton = button;
    } else {
      button.removeAttribute("aria-current");
    }
  }
  if (options.center !== false) {
    const zoom = Math.max(state.map.getZoom(), 15);
    if (reducedMotion) state.map.setView(marker.getLatLng(), zoom);
    else state.map.flyTo(marker.getLatLng(), zoom, { duration: 0.65 });
  }
  if (options.openPopup) marker.openPopup();
  selectedButton?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "center" });
  if (options.focus) selectedButton?.focus({ preventScroll: true });
}

function clearExploreSelection() {
  state.map?.closePopup();
  const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2cb4fb";
  for (const marker of state.markers.values()) marker.setStyle({ radius: 6, fillColor: color });
  for (const button of elements.exploreFilmstrip.querySelectorAll("button[data-base]")) {
    button.classList.remove("is-selected");
    button.removeAttribute("aria-current");
  }
}

function photoPopup(photo) {
  const button = document.createElement("button");
  const image = document.createElement("img");
  const title = document.createElement("strong");
  const time = document.createElement("small");
  button.type = "button";
  button.className = "map-popup-photo";
  button.setAttribute("aria-label", `Open ${friendlyBase(photo.base)}`);
  image.src = photo.thumbnail_url;
  image.alt = "";
  title.textContent = friendlyBase(photo.base);
  time.textContent = captureTimeLabel(photo);
  button.append(image, title, time);
  button.addEventListener("click", () => openLightbox(state.photos.findIndex((item) => item.base === photo.base)));
  return button;
}

function validMapPoint(point) {
  return Array.isArray(point) && Number.isFinite(point[1]) && Number.isFinite(point[2]) && point[1] >= -90 && point[1] <= 90 && point[2] >= -180 && point[2] <= 180;
}

function captureSortTime(photo) {
  const value = captureTimestamp(photo.capture_clock);
  return Number.isFinite(value) ? value : null;
}

function captureTimeLabel(photo) {
  const match = String(photo.capture_clock || "").match(/[T ](\d{2}):(\d{2})/);
  if (!match) return photo.capture_clock ? "Captured" : "Manually placed";
  return `Captured ${new Date(2000, 0, 1, +match[1], +match[2]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function resetZoom() {
  resetZoomState();
  applyZoom({ resetScroll: true });
}

function resetZoomState() {
  state.zoomMode = "fit";
  state.zoomValue = DEFAULT_ZOOM;
  elements.zoomSlider.value = String(DEFAULT_ZOOM);
  elements.zoomValue.textContent = "Fit";
}

function applyZoom(options = {}) {
  const zoomed = state.zoomMode === "percent";
  const value = clamp(Number(state.zoomValue) || DEFAULT_ZOOM, ZOOM_MIN, ZOOM_MAX);
  state.zoomValue = value;
  elements.zoomSlider.value = String(value);
  elements.zoomValue.textContent = zoomed ? `${value}%` : "Fit";
  elements.lightboxViewport.classList.toggle("is-zoomed", zoomed);
  elements.lightboxImage.classList.toggle("fit", !zoomed);
  if (!zoomed) {
    cancelSmoothPan();
    elements.lightboxImage.style.width = "";
    elements.lightboxImage.style.height = "";
    if (options.resetScroll) elements.lightboxViewport.scrollTo({ top: 0, left: 0 });
    return;
  }
  const photo = state.photos[state.currentIndex];
  const imageWidth = photo?.width || elements.lightboxImage.naturalWidth;
  if (!imageWidth) return;
  elements.lightboxImage.style.width = `${Math.max(1, imageWidth * (value / 100))}px`;
  elements.lightboxImage.style.height = "auto";
  scrollToImagePoint(options.imagePoint || currentImageCenter(), { viewportPoint: options.viewportPoint });
}

function startZoomSliderPointer(event) {
  if (!elements.lightbox.open || (event.pointerType === "mouse" && event.button !== 0)) return;
  state.zoomSliderPointer = event.pointerId;
  elements.zoomSlider.focus();
  elements.zoomSlider.setPointerCapture?.(event.pointerId);
  updateZoomFromSliderPointer(event);
  event.preventDefault();
}

function moveZoomSliderPointer(event) {
  if (state.zoomSliderPointer !== event.pointerId) return;
  updateZoomFromSliderPointer(event);
  event.preventDefault();
}

function finishZoomSliderPointer(event) {
  if (state.zoomSliderPointer !== event.pointerId) return;
  elements.zoomSlider.releasePointerCapture?.(event.pointerId);
  state.zoomSliderPointer = null;
  event.preventDefault();
}

function updateZoomFromSliderPointer(event) {
  const rect = elements.zoomSlider.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const rawValue = ZOOM_MIN + ratio * (ZOOM_MAX - ZOOM_MIN);
  const steppedValue = ZOOM_MIN + Math.round((rawValue - ZOOM_MIN) / 5) * 5;
  const center = currentImageCenter();
  state.zoomMode = "percent";
  state.zoomValue = clamp(steppedValue, ZOOM_MIN, ZOOM_MAX);
  applyZoom({ imagePoint: center });
}

function startViewportPointer(event) {
  if (!elements.lightbox.open || (event.pointerType === "mouse" && event.button !== 0)) return;
  elements.lightboxViewport.setPointerCapture?.(event.pointerId);
  state.panPointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    scrollLeft: elements.lightboxViewport.scrollLeft,
    scrollTop: elements.lightboxViewport.scrollTop,
    moved: false,
    panning: false,
  };
}

function moveViewportPointer(event) {
  if (state.panPointer?.id === event.pointerId) {
    const dx = event.clientX - state.panPointer.x;
    const dy = event.clientY - state.panPointer.y;
    if (state.zoomMode === "percent") {
      const shouldPan = state.panPointer.panning || Math.hypot(dx, dy) >= PAN_DRAG_THRESHOLD;
      if (shouldPan) {
        cancelSmoothPan();
        state.panPointer.moved = true;
        state.panPointer.panning = true;
        elements.lightboxViewport.classList.add("is-panning");
        elements.lightboxViewport.scrollLeft = state.panPointer.scrollLeft - dx;
        elements.lightboxViewport.scrollTop = state.panPointer.scrollTop - dy;
        event.preventDefault();
      }
    }
    return;
  }
  hoverPan(event);
}

function finishViewportPointer(event) {
  if (state.panPointer?.id !== event.pointerId) return;
  const pointer = state.panPointer;
  cancelViewportPointer(event);
  if (pointer.moved) return;
  cycleImageZoom(event);
}

function cancelViewportPointer(event) {
  if (event?.pointerId !== undefined) {
    elements.lightboxViewport.releasePointerCapture?.(event.pointerId);
  }
  state.panPointer = null;
  elements.lightboxViewport.classList.remove("is-panning");
}

function hoverPan(event) {
  if (state.zoomMode !== "percent" || !finePointer.matches || event.pointerType !== "mouse" || !hasScrollableImage()) return;
  const rect = elements.lightboxViewport.getBoundingClientRect();
  const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  smoothPanTo(
    (elements.lightboxViewport.scrollWidth - elements.lightboxViewport.clientWidth) * x,
    (elements.lightboxViewport.scrollHeight - elements.lightboxViewport.clientHeight) * y,
  );
}

function cycleImageZoom(event) {
  const stages = usefulClickZoomStages();
  if (!stages.length) return;
  const currentValue = state.zoomMode === "percent" ? state.zoomValue : 0;
  const nextStage = state.zoomMode === "fit"
    ? stages[0]
    : stages.find((stage) => currentValue < stage - 0.5);
  if (!nextStage) {
    resetZoom();
    return;
  }
  state.zoomMode = "percent";
  state.zoomValue = nextStage;
  applyZoom({ imagePoint: imagePointFromEvent(event), viewportPoint: viewportPointFromEvent(event) });
}

function usefulClickZoomStages() {
  const fitPercent = currentFitZoomPercent();
  return CLICK_ZOOM_STAGES.filter((stage) => stage > fitPercent + 0.5);
}

function currentFitZoomPercent() {
  const photo = state.photos[state.currentIndex];
  const naturalWidth = photo?.width || elements.lightboxImage.naturalWidth;
  const naturalHeight = photo?.height || elements.lightboxImage.naturalHeight;
  if (!naturalWidth || !naturalHeight) return 0;
  const toolbarHeight = document.querySelector(".lightbox-toolbar")?.getBoundingClientRect().height || 54;
  const fitWidth = Math.max(1, elements.lightboxViewport.clientWidth);
  const fitHeight = Math.max(1, elements.lightboxViewport.clientHeight - toolbarHeight);
  return Math.min(fitWidth / naturalWidth, fitHeight / naturalHeight) * 100;
}

function currentImageCenter() {
  if (state.zoomMode === "fit") return { x: 0.5, y: 0.5 };
  const image = elements.lightboxImage;
  const viewport = elements.lightboxViewport;
  const width = Math.max(1, image.offsetWidth);
  const height = Math.max(1, image.offsetHeight);
  return {
    x: clamp((viewport.scrollLeft + viewport.clientWidth / 2 - image.offsetLeft) / width, 0, 1),
    y: clamp((viewport.scrollTop + viewport.clientHeight / 2 - image.offsetTop) / height, 0, 1),
  };
}

function imagePointFromEvent(event) {
  const image = elements.lightboxImage;
  const rect = image.getBoundingClientRect();
  const photo = state.photos[state.currentIndex];
  const naturalWidth = photo?.width || image.naturalWidth || rect.width || 1;
  const naturalHeight = photo?.height || image.naturalHeight || rect.height || 1;
  let visibleWidth = rect.width;
  let visibleHeight = rect.height;
  let left = rect.left;
  let top = rect.top;
  const naturalRatio = naturalWidth / Math.max(1, naturalHeight);
  const rectRatio = rect.width / Math.max(1, rect.height);
  if (image.classList.contains("fit")) {
    if (naturalRatio > rectRatio) {
      visibleHeight = rect.width / naturalRatio;
      top += (rect.height - visibleHeight) / 2;
    } else {
      visibleWidth = rect.height * naturalRatio;
      left += (rect.width - visibleWidth) / 2;
    }
  }
  return {
    x: clamp((event.clientX - left) / Math.max(1, visibleWidth), 0, 1),
    y: clamp((event.clientY - top) / Math.max(1, visibleHeight), 0, 1),
  };
}

function viewportPointFromEvent(event) {
  const rect = elements.lightboxViewport.getBoundingClientRect();
  return {
    x: clamp(event.clientX - rect.left, 0, rect.width),
    y: clamp(event.clientY - rect.top, 0, rect.height),
  };
}

function scrollToImagePoint(point, options = {}) {
  const image = elements.lightboxImage;
  const viewport = elements.lightboxViewport;
  const viewportPoint = options.viewportPoint || {
    x: viewport.clientWidth / 2,
    y: viewport.clientHeight / 2,
  };
  const left = image.offsetLeft + image.offsetWidth * point.x - viewportPoint.x;
  const top = image.offsetTop + image.offsetHeight * point.y - viewportPoint.y;
  const targetLeft = clamp(left, 0, Math.max(0, viewport.scrollWidth - viewport.clientWidth));
  const targetTop = clamp(top, 0, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
  cancelSmoothPan();
  viewport.scrollTo({ left: targetLeft, top: targetTop });
}

function smoothPanTo(left, top) {
  const viewport = elements.lightboxViewport;
  state.panTarget = {
    left: clamp(left, 0, Math.max(0, viewport.scrollWidth - viewport.clientWidth)),
    top: clamp(top, 0, Math.max(0, viewport.scrollHeight - viewport.clientHeight)),
  };
  if (!state.panAnimation) state.panAnimation = requestAnimationFrame(stepSmoothPan);
}

function stepSmoothPan() {
  if (!state.panTarget) {
    state.panAnimation = null;
    return;
  }
  const viewport = elements.lightboxViewport;
  const dx = state.panTarget.left - viewport.scrollLeft;
  const dy = state.panTarget.top - viewport.scrollTop;
  if (Math.abs(dx) <= PAN_SETTLE_THRESHOLD && Math.abs(dy) <= PAN_SETTLE_THRESHOLD) {
    viewport.scrollTo({ left: state.panTarget.left, top: state.panTarget.top });
    state.panTarget = null;
    state.panAnimation = null;
    return;
  }
  viewport.scrollTo({
    left: viewport.scrollLeft + dx * PAN_EASING_RATE,
    top: viewport.scrollTop + dy * PAN_EASING_RATE,
  });
  state.panAnimation = requestAnimationFrame(stepSmoothPan);
}

function cancelSmoothPan() {
  state.panTarget = null;
  if (!state.panAnimation) return;
  cancelAnimationFrame(state.panAnimation);
  state.panAnimation = null;
}

function hasScrollableImage() {
  return elements.lightboxViewport.scrollWidth > elements.lightboxViewport.clientWidth + 2 ||
    elements.lightboxViewport.scrollHeight > elements.lightboxViewport.clientHeight + 2;
}

function parseRoute() {
  const match = location.pathname.match(/^(\/today\/gallery|\/gallery)(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/);
  return { root: match?.[1] || "/today/gallery", date: match?.[2] || null };
}

function readUrlState() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") === "explore" ? "explore" : "photos";
  return { view, photo: params.get("photo") };
}

function writeUrlState(mode) {
  if (!route.date) return;
  const url = new URL(location.href);
  if (state.view === "explore") {
    url.searchParams.set("view", "explore");
    if (state.selectedBase) url.searchParams.set("photo", state.selectedBase);
    else url.searchParams.delete("photo");
  } else {
    url.searchParams.delete("view");
    if (state.selectedBase) url.searchParams.set("photo", state.selectedBase);
    else url.searchParams.delete("photo");
  }
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", url);
}

async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function requestOptionalJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function unwrapExplore(result) {
  if (!result) return null;
  return Object.prototype.hasOwnProperty.call(result, "explore") ? result.explore : result;
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

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
