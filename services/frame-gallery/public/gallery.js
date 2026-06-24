const elements = {
  home: document.querySelector("#gallery-home"),
  brandLogo: document.querySelector("#brand-logo"),
  brandName: document.querySelector("#brand-name"),
  galleryTitle: document.querySelector("#gallery-title"),
  allGalleries: document.querySelector("#all-galleries"),
  headingEyebrow: document.querySelector("#heading-eyebrow"),
  heading: document.querySelector("#date-heading"),
  summary: document.querySelector("#date-summary"),
  count: document.querySelector("#photo-count"),
  refreshState: document.querySelector("#refresh-state"),
  themeToggle: document.querySelector("#theme-toggle"),
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
  zoomSlider: document.querySelector("#zoom-slider"),
  zoomValue: document.querySelector("#zoom-value"),
  zoomFit: document.querySelector("#zoom-fit"),
};
const icons = {
  moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.1A8.4 8.4 0 0 1 8.9 3.6 8.5 8.5 0 1 0 20.4 15.1Z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/></svg>`,
};

const ZOOM_MIN = 25;
const ZOOM_MAX = 200;
const DEFAULT_ZOOM = 100;
const CLICK_ZOOM_STAGES = [50, 100];
const PAN_DRAG_THRESHOLD = 12;
const PAN_EASING_RATE = 0.2;
const PAN_SETTLE_THRESHOLD = 0.75;
const route = parseRoute();
const state = {
  dates: [],
  photos: [],
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
elements.home.href = route.root;
elements.allGalleries.href = route.root;
elements.lightboxImage.draggable = false;

elements.themeToggle.addEventListener("click", toggleTheme);
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
elements.lightbox.addEventListener("close", cancelViewportPointer);
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

await loadBranding();
await refresh(true);
setInterval(() => refresh(false), 5000);

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
}

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
    card.querySelector(".date-card-stats").textContent = `${photoLabel(date.count)} - ${durationLabel(date.duration_ms)}`;
    return card;
  }));
}

function renderDay() {
  const date = state.dates.find((item) => item.date_folder === route.date);
  elements.headingEyebrow.textContent = "Published photos";
  elements.heading.textContent = formatLongDate(route.date);
  elements.summary.textContent = date ? `${photoLabel(date.count)} - ${durationLabel(date.duration_ms)}` : photoLabel(state.photos.length);
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
  resetZoomState();
  elements.lightbox.showModal();
  renderLightbox();
}

function moveLightbox(offset) {
  const target = state.currentIndex + offset;
  if (target < 0 || target >= state.photos.length) return;
  state.currentIndex = target;
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
  elements.lightboxDetails.textContent = photo.camera_text || "Camera information unavailable";
  elements.lightboxDetails.hidden = !photo.camera_text;
  elements.lightboxPrevious.disabled = state.currentIndex <= 0;
  elements.lightboxNext.disabled = state.currentIndex >= state.photos.length - 1;
  applyZoom();
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

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
