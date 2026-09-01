import { buildGalleryShareUrls, captureTimestamp, matchExplorePhotos, routeSegments, simulatedRouteSegments } from "./explore.js?v=gallery-share-7";
import { SOCIAL_PLATFORMS, socialIcon } from "./socials.js?v=gallery-socials-6";
import { SUPPORT_PLATFORMS, supportIcon } from "./support.js?v=gallery-support-1";
import { layoutJustifiedRows } from "./justified-rows.js?v=gallery-justified-1";

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
  socialsButton: document.querySelector("#socials-button"),
  socialsDialog: document.querySelector("#socials-dialog"),
  socialsList: document.querySelector("#socials-list"),
  socialsStatus: document.querySelector("#socials-status"),
  supportButton: document.querySelector("#support-button"),
  supportDialog: document.querySelector("#support-dialog"),
  supportList: document.querySelector("#support-list"),
  supportStatus: document.querySelector("#support-status"),
  socialQrDialog: document.querySelector("#social-qr-dialog"),
  socialQrCode: document.querySelector("#social-qr-code"),
  socialQrTitle: document.querySelector("#social-qr-title"),
  socialQrLabel: document.querySelector("#social-qr-label"),
  socialQrDestination: document.querySelector("#social-qr-destination"),
  dateGallery: document.querySelector("#date-gallery"),
  photoGallery: document.querySelector("#photo-gallery"),
  photoLoadMore: document.querySelector("#photo-load-more"),
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
  lightboxPreview: document.querySelector("#lightbox-preview"),
  lightboxFull: document.querySelector("#lightbox-full"),
  lightboxTiles: document.querySelector("#lightbox-tiles"),
  lightboxLoading: document.querySelector("#lightbox-loading"),
  lightboxTitle: document.querySelector("#lightbox-title"),
  lightboxPosition: document.querySelector("#lightbox-position"),
  lightboxDetails: document.querySelector("#lightbox-details"),
  lightboxCameraText: document.querySelector("#lightbox-camera-text"),
  lightboxExplore: document.querySelector("#lightbox-explore"),
  lightboxShare: document.querySelector("#lightbox-share"),
  lightboxDownload: document.querySelector("#lightbox-download"),
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
  download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>`,
  qr: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v4h-2zM14 18h4v2h-4z"/></svg>`,
};

const ZOOM_MIN = 25;
const ZOOM_MAX = 200;
const DEFAULT_ZOOM = 100;
const CLICK_ZOOM_STAGES = [50, 100];
const PAN_DRAG_THRESHOLD = 12;
const PAN_EASING_RATE = 0.2;
const PAN_SETTLE_THRESHOLD = 0.75;
const FULL_IMAGE_RETRY_INITIAL_MS = 15_000;
const FULL_IMAGE_RETRY_MAX_MS = 120_000;
const PHOTO_PAGE_SIZE = 60;
const PHOTO_SORTS = new Set(["newest", "oldest", "filename_asc", "filename_desc", "captured_asc", "captured_desc"]);
const route = parseRoute();
const initialUrlState = readUrlState();
const state = {
  dates: [],
  photos: [],
  photoTotal: 0,
  photoNextCursor: null,
  photoRevision: 0,
  photoSort: "newest",
  photosComplete: false,
  photosLoading: false,
  renderedPhotoCount: 0,
  refreshing: false,
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
  currentBase: null,
  lightboxView: null,
  lightboxMediaMode: null,
  lightboxFullRetryAt: 0,
  lightboxFullRetryDelay: FULL_IMAGE_RETRY_INITIAL_MS,
  signature: "",
  branding: null,
  socialSignature: "",
  supportSignature: "",
  userThemeMode: readStoredTheme(),
  zoomMode: "fit",
  zoomValue: DEFAULT_ZOOM,
  panPointer: null,
  zoomSliderPointer: null,
  panAnimation: null,
  panTarget: null,
  photoGalleryWidth: 0,
  photoGalleryLayoutFrame: 0,
  photoGalleryLayoutKey: "",
  photoGalleryScrollAnchor: null,
};
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const finePointer = matchMedia("(pointer: fine)");
let shareQrCode;
let socialQrCode;
let lightboxNavFadeTimer;
let lightboxCompletionTimer;
let lightboxImageLoadId = 0;
let lightboxSessionController;
let lightboxTileGeneration = 0;
let lightboxTileImages = [];
elements.home.href = route.root;
elements.allGalleries.href = route.root;
elements.lightboxPreview.draggable = false;
elements.lightboxExplore.innerHTML = `${icons.map}<span>View on map</span>`;
elements.lightboxShare.innerHTML = `${icons.share}<span>Share</span>`;
elements.lightboxDownload.innerHTML = icons.download;
setCopyButton(elements.copyGalleryUrl, "Gallery view");
setCopyButton(elements.copyExploreUrl, "Explore view");

elements.themeToggle.addEventListener("click", toggleTheme);
elements.socialsButton.addEventListener("click", openSocialsDialog);
elements.supportButton.addEventListener("click", openSupportDialog);
elements.photosView.addEventListener("click", () => setGalleryView("photos", { history: "push" }));
elements.exploreView.addEventListener("click", async () => {
  if (await ensureAllPhotos()) setGalleryView("explore", { history: "push" });
});
elements.photoLoadMore.addEventListener("click", () => void loadMorePhotos());
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
window.addEventListener("resize", () => {
  if (elements.lightbox.open && state.zoomMode === "fit") applyZoom();
  schedulePhotoGalleryLayout();
});
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (!route.date || state.view !== "photos" || elements.photoGallery.hidden || Math.abs(width - state.photoGalleryWidth) < 0.5) return;
  state.photoGalleryWidth = width;
  schedulePhotoGalleryLayout();
}).observe(elements.photoGallery);
elements.lightbox.addEventListener("click", (event) => {
  if (event.target === elements.lightbox) elements.lightbox.close();
});
elements.lightbox.addEventListener("close", () => {
  cancelLightboxImageLoad();
  clearTimeout(lightboxNavFadeTimer);
  for (const button of [elements.lightboxPrevious, elements.lightboxNext]) button.classList.remove("is-active");
  setLightboxImageStatus("ready");
  cancelViewportPointer();
  state.currentIndex = -1;
  state.currentBase = null;
  state.lightboxView = null;
  state.lightboxMediaMode = null;
  state.lightboxFullRetryAt = 0;
  state.lightboxFullRetryDelay = FULL_IMAGE_RETRY_INITIAL_MS;
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
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !elements.photoLoadMore.hidden) void loadMorePhotos();
  }, { rootMargin: "1000px 0px" }).observe(elements.photoLoadMore);
}
window.addEventListener("popstate", () => {
  if (elements.shareDialog.open) elements.shareDialog.close();
  const urlState = readUrlState();
  state.view = urlState.view;
  state.selectedBase = urlState.photo;
  if (route.date) applyGalleryView({ openPopup: true });
});

await Promise.all([loadBranding(), refresh(true)]);
setInterval(() => {
  if (!document.hidden) void Promise.allSettled([refresh(false), loadBranding()]);
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void Promise.allSettled([refresh(false), loadBranding()]);
});

async function loadBranding() {
  try {
    const previousMediaMode = preferredLightboxMediaMode();
    const result = await requestJson("/gallery/api/branding");
    state.branding = result.branding;
    applyBranding();
    const preferredMediaMode = preferredLightboxMediaMode();
    const modeChanged = previousMediaMode !== preferredMediaMode && state.lightboxMediaMode !== preferredMediaMode;
    const retryFullImage = preferredMediaMode === "image" && state.lightboxMediaMode === "tiles" && Date.now() >= state.lightboxFullRetryAt;
    if (elements.lightbox.open && (modeChanged || retryFullImage)) {
      const photo = state.photos[state.currentIndex];
      if (photo) loadLightboxImage(photo, { imagePoint: currentImageCenter(), retryFullImage });
    }
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
    renderSocials();
    renderSupports();
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
  if (elements.lightbox.open) syncLightboxDownload(state.photos[state.currentIndex]);
}

async function openSocialsDialog() {
  await loadBranding();
  if (!state.branding?.socials?.length) return;
  elements.socialsStatus.textContent = "";
  elements.socialsStatus.removeAttribute("data-error");
  elements.socialsDialog.showModal();
}

function renderSocials() {
  const socials = Array.isArray(state.branding?.socials) ? state.branding.socials : [];
  elements.socialsButton.hidden = socials.length === 0;
  const signature = JSON.stringify(socials);
  if (signature === state.socialSignature) return;
  state.socialSignature = signature;
  elements.socialsList.replaceChildren(...socials.map(socialRow));
  if (!socials.length && elements.socialsDialog.open) elements.socialsDialog.close();
  if (elements.socialQrDialog.open && elements.socialQrDialog.dataset.linkKind !== "support") {
    const active = socials.find((link) => link.id === elements.socialQrDialog.dataset.socialId);
    if (!active) {
      elements.socialQrDialog.close();
    } else {
      const platform = SOCIAL_PLATFORMS.find((entry) => entry.id === active.platform) || SOCIAL_PLATFORMS[0];
      if (!renderSocialQr(active, platform.label, "social")) elements.socialQrDialog.close();
    }
  }
}

async function openSupportDialog() {
  await loadBranding();
  if (!state.branding?.supports?.length) return;
  elements.supportStatus.textContent = "";
  elements.supportStatus.removeAttribute("data-error");
  elements.supportDialog.showModal();
}

function renderSupports() {
  const supports = Array.isArray(state.branding?.supports) ? state.branding.supports : [];
  elements.supportButton.hidden = supports.length === 0;
  const signature = JSON.stringify(supports);
  if (signature === state.supportSignature) return;
  state.supportSignature = signature;
  elements.supportList.replaceChildren(...supports.map(supportRow));
  if (!supports.length && elements.supportDialog.open) elements.supportDialog.close();
  if (elements.socialQrDialog.open && elements.socialQrDialog.dataset.linkKind === "support") {
    const active = supports.find((link) => link.id === elements.socialQrDialog.dataset.socialId);
    if (!active) {
      elements.socialQrDialog.close();
    } else {
      const platform = SUPPORT_PLATFORMS.find((entry) => entry.id === active.platform) || SUPPORT_PLATFORMS[0];
      if (!renderSocialQr(active, platform.label, "support")) elements.socialQrDialog.close();
    }
  }
}

function socialRow(link) {
  const platform = SOCIAL_PLATFORMS.find((entry) => entry.id === link.platform) || SOCIAL_PLATFORMS[0];
  const row = document.createElement("article");
  row.className = "social-link";

  const identity = document.createElement("a");
  identity.className = "social-link-identity";
  identity.href = link.url;
  identity.target = "_blank";
  identity.rel = "noopener noreferrer";
  const icon = document.createElement("span");
  icon.className = "social-platform-icon";
  icon.innerHTML = socialIcon(link.platform);
  if (link.graphic?.url) {
    const graphic = document.createElement("img");
    graphic.alt = "";
    graphic.decoding = "async";
    graphic.addEventListener("load", () => {
      icon.classList.add("has-custom-graphic");
      icon.replaceChildren(graphic);
    }, { once: true });
    graphic.src = link.graphic.url;
  }
  const copy = document.createElement("span");
  copy.className = "social-link-copy";
  const title = document.createElement("strong");
  title.textContent = link.label || platform.label;
  const destination = document.createElement("small");
  destination.textContent = link.url;
  copy.append(title, destination);
  identity.append(icon, copy);
  identity.setAttribute("aria-label", `Open ${title.textContent} in a new window`);
  identity.title = "Open in new window";

  const actions = document.createElement("span");
  actions.className = "social-link-actions";
  const copyButton = iconButton(icons.copy, `Copy ${title.textContent}`, "Copy");
  copyButton.addEventListener("click", () => copySocialUrl(link, copyButton, elements.socialsStatus, "Social"));
  const qrButton = iconButton(icons.qr, `Show QR code for ${title.textContent}`, "QR code");
  qrButton.addEventListener("click", () => openSocialQr(link, platform.label, "social"));
  actions.append(copyButton, qrButton);
  row.append(identity, actions);
  return row;
}

function supportRow(link) {
  const platform = SUPPORT_PLATFORMS.find((entry) => entry.id === link.platform) || SUPPORT_PLATFORMS[0];
  const row = document.createElement("article");
  row.className = "social-link support-link";
  const identity = document.createElement("a");
  identity.className = "social-link-identity";
  identity.href = link.url;
  identity.target = "_blank";
  identity.rel = "noopener noreferrer";
  const icon = document.createElement("span");
  icon.className = "social-platform-icon support-platform-icon";
  icon.innerHTML = supportIcon(link.platform);
  const copy = document.createElement("span");
  copy.className = "social-link-copy";
  const title = document.createElement("strong");
  title.textContent = link.label || platform.label;
  const destination = document.createElement("small");
  destination.textContent = link.url;
  copy.append(title, destination);
  identity.append(icon, copy);
  identity.setAttribute("aria-label", `Open ${title.textContent} in a new window`);
  const actions = document.createElement("span");
  actions.className = "social-link-actions";
  const copyButton = iconButton(icons.copy, `Copy ${title.textContent}`, "Copy");
  copyButton.addEventListener("click", () => copySocialUrl(link, copyButton, elements.supportStatus, "Support"));
  const qrButton = iconButton(icons.qr, `Show QR code for ${title.textContent}`, "QR code");
  qrButton.addEventListener("click", () => openSocialQr(link, platform.label, "support"));
  actions.append(copyButton, qrButton);
  row.append(identity, actions);
  return row;
}

function iconButton(icon, label, title) {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.innerHTML = icon;
  button.setAttribute("aria-label", label);
  button.title = title;
  return button;
}

async function copySocialUrl(link, button, status = elements.socialsStatus, fallbackLabel = "Social") {
  try {
    await copyText(link.url, button);
    button.innerHTML = icons.check;
    status.textContent = `${link.label || fallbackLabel} link copied.`;
    status.removeAttribute("data-error");
    setTimeout(() => {
      if (button.isConnected) button.innerHTML = icons.copy;
    }, 1200);
  } catch {
    status.textContent = "Automatic copy was blocked. Press and hold the link to copy it.";
    status.dataset.error = "true";
  }
}

function openSocialQr(link, platformLabel, kind = "social") {
  if (renderSocialQr(link, platformLabel, kind) && !elements.socialQrDialog.open) elements.socialQrDialog.showModal();
}

function renderSocialQr(link, platformLabel, kind = "social") {
  elements.socialQrDialog.dataset.socialId = link.id;
  elements.socialQrDialog.dataset.linkKind = kind;
  elements.socialQrTitle.textContent = link.label || platformLabel;
  elements.socialQrLabel.textContent = platformLabel;
  elements.socialQrDestination.textContent = link.url;
  try {
    const QRCode = window.QRCode;
    if (typeof QRCode !== "function") throw new Error("QR encoder unavailable");
    if (!socialQrCode) {
      socialQrCode = new QRCode(elements.socialQrCode, {
        width: 260,
        height: 260,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M,
      });
    }
    socialQrCode.makeCode(link.url);
    return true;
  } catch {
    elements.socialsStatus.textContent = "QR code unavailable. Copy the destination instead.";
    elements.socialsStatus.dataset.error = "true";
    return false;
  }
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
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const openPhotoBase = elements.lightbox.open ? state.currentBase : null;
    elements.refreshState.textContent = "Refreshing...";
    if (route.date) {
      const requestAllPhotos = forceRender && (state.view === "explore" || Boolean(state.selectedBase));
      const [datesResult, firstPhotoResult] = await Promise.all([
        requestJson("/gallery/api/dates"),
        requestJson(photoApiUrl(requestAllPhotos)),
      ]);
      state.dates = datesResult.dates;
      const previousRevision = state.photoRevision;
      const previousRenderedCount = state.renderedPhotoCount;
      const previousLoadedCount = state.photos.length;
      let photosResult = firstPhotoResult;
      const sortChanged = normalizePhotoSort(firstPhotoResult.photo_sort) !== state.photoSort;
      const incomingTotal = Number(firstPhotoResult.total);
      const known = new Set(state.photos.map((photo) => photo.base));
      const additions = firstPhotoResult.photos.filter((photo) => !known.has(photo.base));
      const appendOnly = !sortChanged && incomingTotal > state.photoTotal && additions.length === incomingTotal - state.photoTotal;
      const reconcileLoadedPhotos = !forceRender
        && !sortChanged
        && state.photos.length > 0
        && Number(firstPhotoResult.revision) !== state.photoRevision
        && !appendOnly;
      if (reconcileLoadedPhotos && firstPhotoResult.next_cursor) {
        photosResult = await loadPhotoPrefix(firstPhotoResult, Math.max(PHOTO_PAGE_SIZE, previousLoadedCount));
      }
      applyPhotoRefresh(photosResult, { reset: sortChanged || forceRender || requestAllPhotos || reconcileLoadedPhotos });
      if (reconcileLoadedPhotos) {
        state.renderedPhotoCount = Math.min(state.photos.length, Math.max(previousRenderedCount, PHOTO_PAGE_SIZE));
      }
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
      if (!forceRender && state.view === "explore" && state.photoRevision !== previousRevision) {
        await ensureAllPhotos({ force: true });
      }
      state.matches = matchExplorePhotos(state.photos, state.explore);
    } else {
      state.dates = (await requestJson("/gallery/api/dates")).dates;
    }
    const signature = gallerySignature();
    if (forceRender || signature !== state.signature) {
      state.signature = signature;
      route.date ? renderDay(openPhotoBase) : renderDates();
    }
    elements.refreshState.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    elements.refreshState.textContent = error.message || "Gallery unavailable";
  } finally {
    state.refreshing = false;
  }
}

function gallerySignature() {
  return JSON.stringify([
    state.dates.map((date) => [
      date.date_folder,
      date.count,
      date.latest_at,
      date.cover_thumbnail_url,
      date.has_explore,
    ]),
    state.photos.map((photo) => [photo.base, photo.processed_at, photo.capture_clock, photo.thumbnail_url, photo.width, photo.height]),
    state.photoTotal,
    state.photoRevision,
    state.photoSort,
    state.explore && [
      state.explore.updated_at,
      state.explore.routes?.map((item) => [item.id, item.segments?.length, item.segments?.reduce((sum, segment) => sum + segment.length, 0)]),
      Object.keys(state.explore.placements || {}).sort(),
    ],
  ]);
}

function photoApiUrl(all = false, cursor = null, limit = PHOTO_PAGE_SIZE) {
  const query = new URLSearchParams({ date: route.date });
  if (!all) query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  return `/gallery/api/photos?${query}`;
}

async function loadPhotoPrefix(firstPage, targetCount) {
  const photos = [...firstPage.photos];
  let page = firstPage;
  const revision = Number(firstPage.revision);
  const photoSort = normalizePhotoSort(firstPage.photo_sort);
  while (page.next_cursor && photos.length < targetCount) {
    page = await requestJson(photoApiUrl(false, page.next_cursor, Math.min(PHOTO_PAGE_SIZE, targetCount - photos.length)));
    if (Number(page.revision) !== revision || normalizePhotoSort(page.photo_sort) !== photoSort) return firstPage;
    photos.push(...page.photos);
    if (!page.photos.length) break;
  }
  return { ...firstPage, ...page, photos };
}

function applyPhotoRefresh(result, { reset = false } = {}) {
  const incoming = Array.isArray(result.photos) ? result.photos : [];
  const total = Number.isInteger(Number(result.total)) ? Number(result.total) : incoming.length;
  const revision = Number.isInteger(Number(result.revision)) ? Number(result.revision) : 0;
  const photoSort = normalizePhotoSort(result.photo_sort);
  const sortChanged = photoSort !== state.photoSort;
  const complete = !result.next_cursor;
  state.photoSort = photoSort;
  if (reset || sortChanged || !state.photos.length) {
    state.photos = [...incoming];
    state.photoTotal = total;
    state.photoNextCursor = result.next_cursor || null;
    state.photoRevision = revision;
    state.photosComplete = complete;
    state.renderedPhotoCount = Math.min(PHOTO_PAGE_SIZE, incoming.length);
    return;
  }
  if (revision === state.photoRevision) return;
  const known = new Set(state.photos.map((photo) => photo.base));
  const additions = incoming.filter((photo) => !known.has(photo.base));
  if (total > state.photoTotal && additions.length === total - state.photoTotal) {
    const incomingBases = new Set(incoming.map((photo) => photo.base));
    state.photos = [...incoming, ...state.photos.filter((photo) => !incomingBases.has(photo.base))];
    state.renderedPhotoCount = Math.min(state.photos.length, state.renderedPhotoCount + additions.length);
  } else {
    state.photos = [...incoming];
    state.photoNextCursor = result.next_cursor || null;
    state.photosComplete = complete;
    state.renderedPhotoCount = Math.min(PHOTO_PAGE_SIZE, incoming.length);
  }
  state.photoTotal = total;
  state.photoRevision = revision;
}

function normalizePhotoSort(value) {
  return PHOTO_SORTS.has(value) ? value : "newest";
}

function renderDates() {
  const total = state.dates.reduce((sum, date) => sum + date.count, 0);
  elements.headingEyebrow.textContent = "Published galleries";
  elements.heading.textContent = "Photo days";
  elements.summary.textContent = `${state.dates.length} day${state.dates.length === 1 ? "" : "s"} of published photos`;
  elements.count.textContent = `${total} photo${total === 1 ? "" : "s"}`;
  elements.empty.hidden = state.dates.length > 0;
  elements.photoGallery.hidden = true;
  elements.photoLoadMore.hidden = true;
  elements.explorePanel.hidden = true;
  document.body.classList.remove("is-exploring", "is-photo-grid");
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
    image.alt = `Gallery cover for ${formatLongDate(date.date_folder)}`;
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

function renderDay(openPhotoBase = null) {
  const scrollAnchor = capturePhotoGalleryScrollAnchor();
  const date = state.dates.find((item) => item.date_folder === route.date);
  const canExplore = hasExplore();
  elements.headingEyebrow.textContent = "Published photos";
  elements.heading.textContent = formatLongDate(route.date);
  elements.summary.textContent = date ? `${photoLabel(date.count)} - ${durationLabel(date.duration_ms)}` : photoLabel(state.photoTotal);
  elements.count.textContent = photoLabel(state.photoTotal);
  elements.dateGallery.hidden = true;
  elements.viewSwitch.hidden = !canExplore;
  elements.allGalleries.hidden = false;
  state.mapDirty = true;
  state.photoGalleryLayoutKey = "";
  const renderedPhotos = state.photos.slice(0, state.renderedPhotoCount);
  elements.photoGallery.replaceChildren(...renderedPhotos.map(createPhotoCard));
  if (state.view === "explore") renderExploreFilmstrip();
  updatePhotoLoadMore();
  applyGalleryView({ rebuildMap: true, openPopup: Boolean(state.selectedBase), lightboxBase: openPhotoBase, scrollAnchor });
}

function createPhotoCard(photo, index) {
  const card = elements.photoTemplate.content.firstElementChild.cloneNode(true);
  const image = card.querySelector("img");
  const photoName = friendlyBase(photo.base);
  const width = Number(photo.width);
  const height = Number(photo.height);
  card.dataset.base = photo.base;
  card.dataset.ratio = String(width > 0 && height > 0 ? width / height : 4 / 3);
  image.src = photo.thumbnail_url;
  image.alt = "";
  card.querySelector("strong").textContent = photoName;
  const time = card.querySelector("time");
  time.id = `photo-time-${index}`;
  time.dateTime = photo.processed_at;
  time.textContent = formatTime(photo.processed_at);
  const openButton = card.querySelector(".photo-open");
  openButton.setAttribute("aria-label", `Open ${photoName}`);
  openButton.setAttribute("aria-describedby", time.id);
  openButton.addEventListener("click", () => openLightbox(state.photos.findIndex((item) => item.base === photo.base)));
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
  shareButton.setAttribute("aria-label", `Share ${photoName}`);
  shareButton.title = "Share photo";
  shareButton.addEventListener("click", () => openShareDialog(location.href, state.matches.has(photo.base), photo.base));
  return card;
}

function appendPhotoCards(startIndex) {
  const photos = state.photos.slice(startIndex, state.renderedPhotoCount);
  if (photos.length) {
    elements.photoGallery.append(...photos.map((photo, index) => createPhotoCard(photo, startIndex + index)));
    state.photoGalleryLayoutKey = "";
    schedulePhotoGalleryLayout();
  }
  updatePhotoLoadMore();
}

async function loadMorePhotos() {
  if (!route.date || state.photosLoading || state.view === "explore") return;
  if (state.renderedPhotoCount < state.photos.length) {
    const startIndex = state.renderedPhotoCount;
    state.renderedPhotoCount = Math.min(state.photos.length, state.renderedPhotoCount + PHOTO_PAGE_SIZE);
    appendPhotoCards(startIndex);
    return;
  }
  const cursor = state.photoNextCursor;
  const revision = state.photoRevision;
  const photoSort = state.photoSort;
  if (!cursor) return;
  state.photosLoading = true;
  updatePhotoLoadMore();
  let failed = false;
  try {
    const result = await requestJson(photoApiUrl(false, cursor));
    if (normalizePhotoSort(result.photo_sort) !== photoSort) {
      await refresh(true);
      return;
    }
    if (state.photoNextCursor !== cursor || state.photoRevision !== revision || Number(result.revision) !== revision || state.photoSort !== photoSort) return;
    const startIndex = state.renderedPhotoCount;
    const known = new Set(state.photos.map((photo) => photo.base));
    state.photos = [...state.photos, ...result.photos.filter((photo) => !known.has(photo.base))];
    state.photoTotal = Number(result.total ?? state.photoTotal);
    state.photoNextCursor = result.next_cursor || null;
    state.photosComplete = !state.photoNextCursor;
    state.renderedPhotoCount = state.photos.length;
    state.matches = matchExplorePhotos(state.photos, state.explore);
    state.signature = gallerySignature();
    appendPhotoCards(startIndex);
  } catch (error) {
    if (error.status === 400 && error.message === "Photo cursor is invalid.") {
      if (cursor === state.photoNextCursor && revision === state.photoRevision && photoSort === state.photoSort) {
        await refresh(true);
      }
      return;
    }
    failed = true;
    elements.refreshState.textContent = error.message || "More photos could not be loaded";
  } finally {
    state.photosLoading = false;
    updatePhotoLoadMore();
    if (failed && state.photoNextCursor) {
      elements.photoLoadMore.hidden = false;
      elements.photoLoadMore.textContent = "Try loading more photos";
    }
  }
}

async function ensureAllPhotos({ force = false } = {}) {
  if (!route.date) return false;
  if (state.photosComplete && !force) {
    renderExploreFilmstrip();
    return true;
  }
  if (state.photosLoading) return false;
  state.photosLoading = true;
  updatePhotoLoadMore();
  try {
    const revision = state.photoRevision;
    const rendered = state.renderedPhotoCount;
    const result = await requestJson(photoApiUrl(true));
    if (state.photoRevision !== revision) return false;
    applyPhotoRefresh(result, { reset: true });
    state.renderedPhotoCount = Math.min(state.photos.length, Math.max(rendered, PHOTO_PAGE_SIZE));
    state.matches = matchExplorePhotos(state.photos, state.explore);
    state.mapDirty = true;
    renderExploreFilmstrip();
    return true;
  } catch (error) {
    elements.refreshState.textContent = error.message || "Explore photos could not be loaded";
    return false;
  } finally {
    state.photosLoading = false;
    updatePhotoLoadMore();
  }
}

function updatePhotoLoadMore() {
  const hasMore = state.renderedPhotoCount < state.photos.length || Boolean(state.photoNextCursor);
  elements.photoLoadMore.hidden = !route.date || state.view === "explore" || !hasMore;
  elements.photoLoadMore.disabled = state.photosLoading;
  elements.photoLoadMore.textContent = state.photosLoading ? "Loading more photos…" : "Load more photos";
}

function layoutPhotoGallery() {
  if (!route.date || state.view !== "photos" || elements.photoGallery.hidden) return;
  const items = [...elements.photoGallery.querySelectorAll(".photo-card")];
  const width = elements.photoGallery.clientWidth;
  if (!items.length || width < 1) return;
  const targetHeight = clamp(window.innerHeight * 0.46, 180, 405);
  const layoutKey = `${width.toFixed(1)}:${targetHeight.toFixed(1)}`;
  if (state.photoGalleryLayoutKey === layoutKey && elements.photoGallery.firstElementChild?.classList.contains("gallery-photo-row")) return;
  state.photoGalleryWidth = width;
  state.photoGalleryLayoutKey = layoutKey;
  layoutJustifiedRows(elements.photoGallery, items, {
    rowClass: "gallery-photo-row",
    targetHeight,
  });
}

function schedulePhotoGalleryLayout(scrollAnchor = null) {
  if (scrollAnchor && !state.photoGalleryScrollAnchor) state.photoGalleryScrollAnchor = scrollAnchor;
  if (state.photoGalleryLayoutFrame) return;
  state.photoGalleryLayoutFrame = requestAnimationFrame(() => {
    state.photoGalleryLayoutFrame = 0;
    layoutPhotoGallery();
    const anchor = state.photoGalleryScrollAnchor;
    state.photoGalleryScrollAnchor = null;
    restorePhotoGalleryScrollAnchor(anchor);
  });
}

function capturePhotoGalleryScrollAnchor() {
  if (!route.date || state.view !== "photos" || elements.photoGallery.hidden) return null;
  const cards = [...elements.photoGallery.querySelectorAll(".photo-card[data-base]")];
  const card = cards.find((item) => {
    const bounds = item.getBoundingClientRect();
    return bounds.bottom > 0 && bounds.top < window.innerHeight;
  });
  return {
    base: card?.dataset.base || null,
    top: card?.getBoundingClientRect().top ?? 0,
    scrollY: window.scrollY,
  };
}

function restorePhotoGalleryScrollAnchor(anchor) {
  if (!anchor || state.view !== "photos" || elements.photoGallery.hidden) return;
  const card = [...elements.photoGallery.querySelectorAll(".photo-card[data-base]")]
    .find((item) => item.dataset.base === anchor.base);
  if (card) window.scrollBy(0, card.getBoundingClientRect().top - anchor.top);
  else window.scrollTo(0, anchor.scrollY);
}

function openLightbox(index, options = {}) {
  const photo = state.photos[index];
  if (!photo) return;
  const preserveImage = Boolean(options.preserveImage && elements.lightbox.open && state.currentBase === photo.base);
  state.currentIndex = index;
  state.currentBase = photo.base;
  if (!preserveImage) resetZoomState();
  if (!elements.lightbox.open) elements.lightbox.showModal();
  renderLightbox({ preserveImage });
}

async function moveLightbox(offset) {
  let target = state.currentIndex + offset;
  if (offset > 0 && target >= state.photos.length && state.photoNextCursor) {
    await loadMorePhotos();
    target = state.currentIndex + offset;
  }
  if (target < 0 || target >= state.photos.length) return;
  if (state.view === "photos" && state.selectedBase) {
    state.selectedBase = state.photos[target].base;
    writeUrlState("replace");
  }
  openLightbox(target);
}

function renderLightbox(options = {}) {
  const photo = state.photos[state.currentIndex];
  if (!photo) return;
  state.currentBase = photo.base;
  elements.lightboxImage.setAttribute("aria-label", friendlyBase(photo.base));
  elements.lightboxTitle.textContent = friendlyBase(photo.base);
  elements.lightboxPosition.textContent = `${state.currentIndex + 1} of ${state.photoTotal}`;
  elements.lightboxCameraText.textContent = photo.camera_text || "";
  elements.lightboxCameraText.hidden = !photo.camera_text;
  syncLightboxDownload(photo);
  elements.lightboxExplore.hidden = !state.matches.has(photo.base);
  elements.lightboxDetails.hidden = false;
  elements.lightboxPrevious.disabled = state.currentIndex <= 0;
  elements.lightboxNext.disabled = state.currentIndex >= state.photos.length - 1 && !state.photoNextCursor;
  revealLightboxNavigation();
  if (!options.preserveImage || state.lightboxMediaMode !== preferredLightboxMediaMode()) loadLightboxImage(photo);
}

function preferredLightboxMediaMode() {
  return state.branding?.show_download_button === true ? "image" : "tiles";
}

function syncLightboxDownload(photo) {
  const enabled = state.branding?.show_download_button === true && Boolean(route.date && photo);
  elements.lightboxDownload.hidden = !enabled;
  elements.lightboxDownload.removeAttribute("href");
  elements.lightboxDownload.removeAttribute("download");
  elements.lightboxDownload.removeAttribute("aria-label");
  if (!enabled) return;
  elements.lightboxDownload.href = `/gallery/download/${encodeURIComponent(route.date)}/${encodeURIComponent(photo.base)}.jpg`;
  elements.lightboxDownload.download = `${photo.base}.jpg`;
  elements.lightboxDownload.setAttribute("aria-label", `Download ${friendlyBase(photo.base)}`);
}

function loadLightboxImage(photo, options = {}) {
  cancelLightboxImageLoad();
  if (!options.retryFullImage) {
    state.lightboxFullRetryAt = 0;
    state.lightboxFullRetryDelay = FULL_IMAGE_RETRY_INITIAL_MS;
  }
  state.lightboxMediaMode = preferredLightboxMediaMode();
  const loadId = lightboxImageLoadId;
  let previewReady = false;
  const isCurrent = () => loadId === lightboxImageLoadId && elements.lightbox.open && state.currentBase === photo.base;
  state.lightboxView = lightboxDimensions(photo.width, photo.height);
  clearLightboxTiles();
  elements.lightboxPreview.classList.remove("is-ready", "is-complete");
  elements.lightboxPreview.onload = () => {
    if (!isCurrent() || !elements.lightboxPreview.naturalWidth) return;
    previewReady = true;
    elements.lightboxPreview.classList.add("is-ready");
    if (["loading", "retrying"].includes(elements.lightboxImage.dataset.status)) setLightboxImageStatus("upgrading");
    applyZoom({ resetScroll: state.zoomMode === "fit" });
  };
  elements.lightboxPreview.onerror = () => {
    if (!isCurrent() || elements.lightboxFull.classList.contains("is-ready") || elements.lightboxTiles.childElementCount) return;
    setLightboxImageStatus("loading");
  };

  setLightboxImageStatus("loading");
  applyZoom({ resetScroll: true, imagePoint: options.imagePoint });
  elements.lightboxPreview.src = photo.thumbnail_url;
  if (state.lightboxMediaMode === "image") {
    loadLightboxFullImage(photo, loadId, () => previewReady);
  } else {
    void loadLightboxTiles(photo, loadId, () => previewReady);
  }
}

function cancelLightboxImageLoad() {
  lightboxImageLoadId += 1;
  lightboxTileGeneration += 1;
  clearTimeout(lightboxCompletionTimer);
  lightboxCompletionTimer = undefined;
  lightboxSessionController?.abort();
  lightboxSessionController = undefined;
  elements.lightboxPreview.onload = null;
  elements.lightboxPreview.onerror = null;
  elements.lightboxPreview.removeAttribute("src");
  elements.lightboxPreview.classList.remove("is-ready", "is-complete");
  clearLightboxFullImage();
  clearLightboxTiles();
  state.lightboxView = null;
}

function loadLightboxFullImage(photo, loadId, getPreviewReady, attempt = 0) {
  const image = elements.lightboxFull;
  const isCurrent = () => loadId === lightboxImageLoadId && elements.lightbox.open && state.currentBase === photo.base;
  clearLightboxFullImage();
  if (attempt) setLightboxImageStatus("retrying");
  image.onload = () => {
    if (!isCurrent() || !image.naturalWidth || !image.naturalHeight) return;
    const imagePoint = currentImageCenter();
    state.lightboxView = lightboxDimensions(image.naturalWidth, image.naturalHeight);
    state.lightboxFullRetryAt = 0;
    state.lightboxFullRetryDelay = FULL_IMAGE_RETRY_INITIAL_MS;
    image.classList.add("is-ready");
    elements.lightboxPreview.classList.add("is-complete");
    applyZoom({ imagePoint, resetScroll: state.zoomMode === "fit" });
    finishLightboxImageLoad({ preserveView: true, celebrate: true });
  };
  image.onerror = () => {
    if (!isCurrent()) return;
    if (attempt === 0) {
      loadLightboxFullImage(photo, loadId, getPreviewReady, 1);
      return;
    }
    state.lightboxMediaMode = "tiles";
    state.lightboxFullRetryAt = Date.now() + state.lightboxFullRetryDelay;
    state.lightboxFullRetryDelay = Math.min(state.lightboxFullRetryDelay * 2, FULL_IMAGE_RETRY_MAX_MS);
    void loadLightboxTiles(photo, loadId, getPreviewReady);
  };
  const source = `/gallery/image/${encodeURIComponent(route.date)}/${encodeURIComponent(photo.base)}.jpg`;
  image.src = attempt ? `${source}?retry=${loadId}` : source;
  setLightboxImageStatus(getPreviewReady() ? "upgrading" : attempt ? "retrying" : "loading");
}

function clearLightboxFullImage() {
  elements.lightboxFull.onload = null;
  elements.lightboxFull.onerror = null;
  elements.lightboxFull.removeAttribute("src");
  elements.lightboxFull.classList.remove("is-ready");
}

async function loadLightboxTiles(photo, loadId, getPreviewReady, attempt = 0) {
  const isCurrent = () => loadId === lightboxImageLoadId && elements.lightbox.open && state.currentBase === photo.base;
  const controller = new AbortController();
  lightboxSessionController?.abort();
  lightboxSessionController = controller;
  if (attempt) setLightboxImageStatus("retrying");
  try {
    const result = await requestJson("/gallery/api/view-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date_folder: route.date, base: photo.base }),
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!isCurrent()) return;
    const view = normalizeTileView(result.view);
    const imagePoint = currentImageCenter();
    state.lightboxView = view;
    applyZoom({ imagePoint });
    renderLightboxTiles(view, photo, loadId, getPreviewReady, attempt);
  } catch (error) {
    if (error.name === "AbortError" || !isCurrent()) return;
    if (attempt === 0) {
      await loadLightboxTiles(photo, loadId, getPreviewReady, 1);
      return;
    }
    setLightboxImageStatus(getPreviewReady() ? "partial" : "error");
  }
}

function normalizeTileView(view) {
  const width = positiveInteger(view?.width);
  const height = positiveInteger(view?.height);
  const tileSize = positiveInteger(view?.tile_size);
  const overlap = positiveInteger(view?.overlap);
  const columns = positiveInteger(view?.columns);
  const rows = positiveInteger(view?.rows);
  if (!width || !height || tileSize !== 512 || !overlap || overlap > tileSize / 2 || columns !== Math.ceil(width / tileSize) || rows !== Math.ceil(height / tileSize) || !Array.isArray(view.tiles) || view.tiles.length !== columns * rows) {
    throw new Error("Photo detail is unavailable");
  }
  const coordinates = new Set();
  const tiles = view.tiles.map((tile) => {
    const x = Number(tile.x);
    const y = Number(tile.y);
    const tileWidth = positiveInteger(tile.width);
    const tileHeight = positiveInteger(tile.height);
    const url = new URL(tile.url, location.origin);
    const key = `${x}:${y}`;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= columns || y >= rows || tileWidth !== Math.min(tileSize, width - x * tileSize) || tileHeight !== Math.min(tileSize, height - y * tileSize) || coordinates.has(key) || url.origin !== location.origin || !url.pathname.startsWith("/gallery/tile/")) {
      throw new Error("Photo detail is unavailable");
    }
    coordinates.add(key);
    return { x, y, width: tileWidth, height: tileHeight, url: `${url.pathname}${url.search}` };
  });
  return { width, height, tileSize, overlap, columns, rows, tiles };
}

function renderLightboxTiles(view, photo, loadId, getPreviewReady, attempt) {
  clearLightboxTiles();
  const generation = ++lightboxTileGeneration;
  elements.lightboxTiles.style.width = `${view.width}px`;
  elements.lightboxTiles.style.height = `${view.height}px`;
  elements.lightboxTiles.style.gridTemplateColumns = Array.from(
    { length: view.columns },
    (_, x) => `${Math.min(view.tileSize, view.width - x * view.tileSize)}px`,
  ).join(" ");
  elements.lightboxTiles.style.gridTemplateRows = Array.from(
    { length: view.rows },
    (_, y) => `${Math.min(view.tileSize, view.height - y * view.tileSize)}px`,
  ).join(" ");
  syncLightboxTileScale(view);
  let loaded = 0;
  let retryStarted = false;
  const isCurrent = () => generation === lightboxTileGeneration && loadId === lightboxImageLoadId && elements.lightbox.open && state.currentBase === photo.base;
  const retry = () => {
    if (retryStarted || !isCurrent()) return;
    retryStarted = true;
    if (attempt === 0) {
      void loadLightboxTiles(photo, loadId, getPreviewReady, 1);
    } else {
      setLightboxImageStatus(loaded || getPreviewReady() ? "partial" : "error");
    }
  };
  const entries = view.tiles.map((tile) => {
    const clip = document.createElement("div");
    clip.className = "lightbox-tile-clip";
    clip.style.gridColumn = String(tile.x + 1);
    clip.style.gridRow = String(tile.y + 1);
    clip.style.width = `${tile.width}px`;
    clip.style.height = `${tile.height}px`;
    const image = new Image();
    image.className = "lightbox-tile-image";
    image.draggable = false;
    image.decoding = "async";
    const sourceX = tile.x > 0 ? view.overlap : 0;
    const sourceY = tile.y > 0 ? view.overlap : 0;
    const expectedWidth = tile.width + sourceX + (tile.x < view.columns - 1 ? view.overlap : 0);
    const expectedHeight = tile.height + sourceY + (tile.y < view.rows - 1 ? view.overlap : 0);
    image.style.left = `${-sourceX}px`;
    image.style.top = `${-sourceY}px`;
    image.style.width = `${expectedWidth}px`;
    image.style.height = `${expectedHeight}px`;
    image.onload = () => {
      if (!isCurrent()) return;
      if (image.naturalWidth !== expectedWidth || image.naturalHeight !== expectedHeight) {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
        retry();
        return;
      }
      image.onload = null;
      image.onerror = null;
      loaded += 1;
      elements.lightboxTiles.classList.add("is-ready");
      if (loaded !== view.tiles.length) return;
      elements.lightboxTiles.classList.add("is-complete");
      elements.lightboxPreview.classList.add("is-complete");
      finishLightboxImageLoad({ preserveView: true, celebrate: true });
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      retry();
    };
    clip.append(image);
    return { clip, image, tile };
  });
  lightboxTileImages = entries.map(({ image }) => image);
  elements.lightboxTiles.replaceChildren(...entries.map(({ clip }) => clip));
  for (const { image, tile } of entries) {
    image.src = tile.url;
  }
  setLightboxImageStatus(getPreviewReady() ? "upgrading" : "loading");
}

function clearLightboxTiles() {
  lightboxTileGeneration += 1;
  for (const image of lightboxTileImages) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
  }
  lightboxTileImages = [];
  elements.lightboxTiles.classList.remove("is-ready", "is-complete");
  elements.lightboxTiles.replaceChildren();
  Object.assign(elements.lightboxTiles.style, {
    width: "",
    height: "",
    gridTemplateColumns: "",
    gridTemplateRows: "",
    transform: "",
  });
}

function lightboxDimensions(width, height) {
  return { width: positiveInteger(width) || 1, height: positiveInteger(height) || 1 };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function revealLightboxNavigation() {
  clearTimeout(lightboxNavFadeTimer);
  for (const button of [elements.lightboxPrevious, elements.lightboxNext]) button.classList.add("is-active");
  lightboxNavFadeTimer = setTimeout(() => {
    for (const button of [elements.lightboxPrevious, elements.lightboxNext]) button.classList.remove("is-active");
  }, 400);
}

function finishLightboxImageLoad({ preserveView = false, celebrate = false } = {}) {
  clearTimeout(lightboxCompletionTimer);
  setLightboxImageStatus(celebrate ? "complete" : "ready");
  if (celebrate) {
    const loadId = lightboxImageLoadId;
    lightboxCompletionTimer = setTimeout(() => {
      if (loadId === lightboxImageLoadId) setLightboxImageStatus("ready");
    }, 900);
  }
  if (elements.lightbox.open && !preserveView) applyZoom({ resetScroll: state.zoomMode === "fit" });
}

function setLightboxImageStatus(status) {
  const loading = status === "loading";
  const upgrading = status === "upgrading";
  const retrying = status === "retrying";
  elements.lightboxImage.dataset.status = status;
  elements.lightboxViewport.setAttribute("aria-busy", String(loading || upgrading || retrying));
  elements.lightboxImage.classList.toggle("is-loading", loading);
  elements.lightboxLoading.hidden = status === "ready";
  elements.lightboxLoading.classList.toggle("is-error", status === "error" || status === "partial");
  elements.lightboxLoading.classList.toggle("is-upgrading", upgrading || retrying);
  elements.lightboxLoading.classList.toggle("is-complete", status === "complete");
  elements.lightboxLoading.textContent = status === "error"
    ? "Photo could not be loaded."
    : status === "partial"
      ? "Some photo detail could not be loaded."
      : status === "complete"
        ? "Full detail ready"
        : retrying
          ? "Retrying photo detail…"
          : upgrading
            ? "Loading full detail…"
            : "Loading photo…";
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
  button.setAttribute("aria-label", `Copying ${label.toLowerCase()} link`);
  button.title = `Copying ${label.toLowerCase()} link`;
  elements.shareStatus.textContent = `Copying ${label.toLowerCase()} link...`;
  elements.shareStatus.removeAttribute("data-error");
  try {
    await copyText(input, button);
    if (!elements.shareDialog.open || input.value !== url) return;
    setCopyButton(button, label, true);
    elements.shareStatus.textContent = `${label} link copied.`;
    elements.shareStatus.removeAttribute("data-error");
    button.focus();
    setTimeout(() => setCopyButton(button, label), 1200);
  } catch {
    if (!elements.shareDialog.open || input.value !== url) return;
    input.focus();
    input.select();
    setCopyButton(button, label);
    elements.shareStatus.textContent = "The browser did not confirm the copy. The link is selected so you can copy it manually.";
    elements.shareStatus.dataset.error = "true";
  }
}

function setCopyButton(button, label, copied = false) {
  const action = copied ? `${label} link copied` : `Copy ${label.toLowerCase()} link`;
  button.innerHTML = copied ? icons.check : icons.copy;
  button.setAttribute("aria-label", action);
  button.title = action;
}

async function copyText(input, trigger = document.activeElement) {
  const value = typeof input === "string" ? input : input.value;
  const previousFocus = document.activeElement;
  const host = trigger?.closest?.("dialog[open]") || document.body;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
    }
  }
  const temporary = typeof input === "string" ? document.createElement("textarea") : null;
  const control = temporary || input;
  if (temporary) {
    temporary.value = value;
    temporary.readOnly = true;
    temporary.tabIndex = -1;
    temporary.style.position = "fixed";
    temporary.style.left = "-9999px";
    temporary.style.top = "0";
    temporary.style.opacity = "0";
    host.append(temporary);
  }
  let copied = false;
  const onCopy = (event) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
    copied = true;
  };
  document.addEventListener("copy", onCopy, { once: true });
  try {
    control.focus({ preventScroll: true });
    control.select();
    control.setSelectionRange?.(0, value.length);
    if (document.execCommand("copy") && copied) return;
  } catch {
  } finally {
    document.removeEventListener("copy", onCopy);
    temporary?.remove();
    if (temporary && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  throw new Error("Copy unavailable");
}

function resetShareDialog() {
  setCopyButton(elements.copyGalleryUrl, "Gallery view");
  setCopyButton(elements.copyExploreUrl, "Explore view");
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
  updatePhotoLoadMore();
  document.body.classList.toggle("is-exploring", exploring);
  document.body.classList.toggle("is-photo-grid", Boolean(route.date) && !exploring);
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
    schedulePhotoGalleryLayout(options.scrollAnchor);
    const lightboxBase = state.selectedBase || options.lightboxBase;
    const photoIndex = lightboxBase ? state.photos.findIndex((photo) => photo.base === lightboxBase) : -1;
    if (photoIndex >= 0) {
      openLightbox(photoIndex, { preserveImage: elements.lightbox.open && state.currentBase === lightboxBase });
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

async function selectExplorePhoto(base, options = {}) {
  if (!state.matches.has(base)) return;
  if (state.view !== "explore" && !(await ensureAllPhotos())) return;
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
    const script = document.querySelector("#leaflet-script");
    if (script && script.dataset.galleryRetry !== "true") {
      script.dataset.galleryRetry = "true";
      script.addEventListener("load", () => {
        state.mapDirty = true;
        if (state.view === "explore") renderExploreMap();
      }, { once: true });
    }
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
  const photo = state.photos[state.currentIndex];
  const dimensions = state.lightboxView || lightboxDimensions(photo?.width, photo?.height);
  state.zoomValue = value;
  elements.zoomSlider.value = String(value);
  elements.zoomValue.textContent = zoomed ? `${value}%` : "Fit";
  elements.lightboxViewport.classList.toggle("is-zoomed", zoomed);
  elements.lightboxImage.classList.toggle("fit", !zoomed);
  if (!zoomed) {
    cancelSmoothPan();
    const toolbarHeight = document.querySelector(".lightbox-toolbar")?.getBoundingClientRect().height || 54;
    const fitWidth = Math.max(1, elements.lightboxViewport.clientWidth);
    const fitHeight = Math.max(1, elements.lightboxViewport.clientHeight - toolbarHeight);
    const scale = Math.min(fitWidth / dimensions.width, fitHeight / dimensions.height);
    setLightboxImageSize(
      Math.max(1, Math.round(dimensions.width * scale)),
      Math.max(1, Math.round(dimensions.height * scale)),
      dimensions,
    );
    if (options.resetScroll) elements.lightboxViewport.scrollTo({ top: 0, left: 0 });
    return;
  }
  setLightboxImageSize(
    Math.max(1, dimensions.width * (value / 100)),
    Math.max(1, dimensions.height * (value / 100)),
    dimensions,
  );
  scrollToImagePoint(options.imagePoint || currentImageCenter(), { viewportPoint: options.viewportPoint });
}

function setLightboxImageSize(width, height, dimensions) {
  elements.lightboxImage.style.width = `${width}px`;
  elements.lightboxImage.style.height = `${height}px`;
  syncLightboxTileScale(dimensions, width, height);
}

function syncLightboxTileScale(dimensions, width = Number.parseFloat(elements.lightboxImage.style.width), height = Number.parseFloat(elements.lightboxImage.style.height)) {
  if (!dimensions?.width || !dimensions?.height || !Number.isFinite(width) || !Number.isFinite(height)) return;
  elements.lightboxTiles.style.transform = `scale(${width / dimensions.width}, ${height / dimensions.height})`;
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
  const dimensions = state.lightboxView || lightboxDimensions(photo?.width, photo?.height);
  const toolbarHeight = document.querySelector(".lightbox-toolbar")?.getBoundingClientRect().height || 54;
  const fitWidth = Math.max(1, elements.lightboxViewport.clientWidth);
  const fitHeight = Math.max(1, elements.lightboxViewport.clientHeight - toolbarHeight);
  return Math.min(fitWidth / dimensions.width, fitHeight / dimensions.height) * 100;
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
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
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

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache", ...options });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function requestOptionalJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache", ...options });
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
