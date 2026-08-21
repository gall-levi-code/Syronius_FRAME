import { SOCIAL_PLATFORMS, buildSocialUrl, createSocialId, resolveSocialPlatform, socialIcon } from "./socials.js?v=gallery-socials-6";
import { SUPPORT_PLATFORMS, buildSupportUrl, createSupportId, resolveSupportPlatform, supportIcon } from "./support.js?v=gallery-support-1";
import { layoutJustifiedRows } from "./justified-rows.js?v=gallery-justified-1";

const elements = Object.fromEntries([
  "summary", "status", "content-management-tab", "gallery-styling-tab", "socials-tab", "support-tab", "published-tab",
  "trash-tab", "published-count", "trash-count", "content-management-view", "gallery-styling-view", "socials-view", "support-view",
  "published-view", "trash-view", "albums", "album-detail", "album-title", "album-summary", "manage-explore", "trash-album",
  "cover-management-panel", "cover-management-status", "cover-action", "photos", "trash-albums", "empty-trash", "empty",
  "branding-summary", "save-branding", "discard-branding", "settings-action-bar", "settings-action-message", "branding-form",
  "brand-name-input", "gallery-title-input", "downloads-disabled", "downloads-enabled", "logo-trigger", "logo-preview", "logo-input",
  "remove-logo", "admin-brand-logo", "admin-brand-name", "confirm-dialog", "confirm-eyebrow", "confirm-title",
  "confirm-media", "confirm-image",
  "confirm-copy", "confirm-cancel", "confirm-accept", "admin-theme-toggle", "logo-crop-dialog",
  "logo-crop-stage", "logo-crop-image", "logo-crop-frame", "logo-crop-eyebrow", "logo-crop-title",
  "logo-shape-controls", "logo-ratio-x", "logo-ratio-y",
  "logo-crop-zoom", "logo-crop-preview",
  "cancel-logo-crop", "save-logo-crop",
  "socials-summary", "save-socials", "socials-form", "social-value-input", "social-platform-select",
  "social-label-input", "add-social", "social-form-error", "social-admin-list", "social-empty",
  "support-summary", "save-support", "support-form", "support-value-input", "support-platform-select",
  "support-label-input", "add-support", "support-form-error", "support-admin-list", "support-empty",
  "cover-picker", "cover-picker-grid", "cover-picker-status", "cancel-cover-picker",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const templates = {
  album: document.getElementById("album-template"),
  photo: document.getElementById("photo-template"),
  trashAlbum: document.getElementById("trash-album-template"),
  trashPhoto: document.getElementById("trash-photo-template"),
};
const state = {
  dates: [],
  photos: [],
  trash: [],
  selectedDate: new URLSearchParams(location.search).get("date"),
  section: "content",
  contentView: "published",
  busy: false,
  branding: null,
  socials: [],
  supports: [],
  selectedProfileId: null,
  confirmResolve: null,
  userThemeMode: readStoredTheme(),
  appliedThemeMode: null,
  logoCrop: null,
  draggedSocialId: null,
  downloadsDraft: false,
  settingsDirty: false,
  coverPickerScrollY: 0,
  coverPickerReturnFocus: null,
  coverPickerWidth: 0,
};
const sections = [
  { name: "content", tab: elements.content_management_tab, view: elements.content_management_view },
  { name: "style", tab: elements.gallery_styling_tab, view: elements.gallery_styling_view },
  { name: "socials", tab: elements.socials_tab, view: elements.socials_view },
  { name: "support", tab: elements.support_tab, view: elements.support_view },
];
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const icons = {
  moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.1A8.4 8.4 0 0 1 8.9 3.6 8.5 8.5 0 1 0 20.4 15.1Z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/></svg>`,
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`,
  grip: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>`,
  reset: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7v5h5"/><path d="M5.6 16a8 8 0 1 0 .3-8.4L4 9"/></svg>`,
  trash: `<svg class="trash-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/></svg>`,
};
const LOGO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const LOGO_EXPORT_BOX = { width: 720, height: 240 };
const SOCIAL_GRAPHIC_SIZE = 320;
const LOGO_EXPORT_QUALITY = 0.9;
const LOGO_ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const LOGO_ASPECTS = { wide: 2, square: 1 };
const LOGO_FRAME_MIN_SIZE = 64;
const LOGO_EDGE_SNAP_PX = 12;

for (const section of sections) {
  section.tab.addEventListener("click", () => void requestSectionChange(section.name));
  section.tab.addEventListener("keydown", handleSectionTabKeydown);
}
elements.admin_theme_toggle.addEventListener("click", toggleAdminTheme);
elements.published_tab.addEventListener("click", () => setContentView("published"));
elements.trash_tab.addEventListener("click", () => setContentView("trash"));
elements.trash_album.addEventListener("click", () => manage("trash-album", state.selectedDate, null, `Move every photo from ${state.selectedDate} to trash?`));
elements.empty_trash.addEventListener("click", () => manage("empty-trash", null, null, "Permanently delete every trashed published gallery copy and its .ready receipt? Queued StreamerBot actions will no longer be able to read those published paths. Archived sources follow the separate retention policy."));
elements.cover_action.addEventListener("click", handleCoverAction);
elements.save_branding.addEventListener("click", () => saveBranding());
elements.discard_branding.addEventListener("click", discardBrandingChanges);
elements.branding_form.addEventListener("submit", (event) => { event.preventDefault(); void saveBranding(); });
elements.brand_name_input.addEventListener("input", updateSettingsDirty);
elements.gallery_title_input.addEventListener("input", updateSettingsDirty);
elements.downloads_disabled.addEventListener("click", () => setDownloadsDraft(false));
elements.downloads_enabled.addEventListener("click", () => setDownloadsDraft(true));
elements.save_socials.addEventListener("click", saveSocials);
elements.socials_form.addEventListener("submit", addSocial);
elements.social_value_input.addEventListener("input", () => {
  const platform = resolveSocialPlatform(elements.social_value_input.value, elements.social_platform_select.value);
  if (platform) elements.social_platform_select.value = platform;
});
elements.save_support.addEventListener("click", saveSupports);
elements.support_form.addEventListener("submit", addSupport);
elements.support_value_input.addEventListener("input", () => {
  const platform = resolveSupportPlatform(elements.support_value_input.value, elements.support_platform_select.value);
  if (platform) elements.support_platform_select.value = platform;
});
elements.logo_trigger.addEventListener("click", () => elements.logo_input.click());
elements.logo_input.addEventListener("change", uploadLogo);
elements.remove_logo.addEventListener("click", confirmRemoveLogo);
elements.cancel_logo_crop.addEventListener("click", closeLogoCropDialog);
elements.logo_crop_dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLogoCropDialog();
});
elements.save_logo_crop.addEventListener("click", saveLogoCrop);
elements.logo_crop_zoom.addEventListener("input", () => {
  if (!state.logoCrop) return;
  state.logoCrop.zoom = Number(elements.logo_crop_zoom.value) || 1;
  renderLogoCrop();
});
elements.logo_crop_stage.addEventListener("pointerdown", startLogoCropDrag);
elements.logo_crop_stage.addEventListener("pointermove", moveLogoCropDrag);
elements.logo_crop_stage.addEventListener("pointerup", finishLogoCropDrag);
elements.logo_crop_stage.addEventListener("pointercancel", finishLogoCropDrag);
document.querySelectorAll(".logo-aspect-option").forEach((button) => {
  button.addEventListener("click", () => setLogoCropAspect(button.dataset.logoAspect || "full"));
});
document.querySelectorAll(".logo-crop-handle").forEach((handle) => {
  handle.addEventListener("pointerdown", startLogoCropResize);
});
elements.logo_ratio_x.addEventListener("input", updateCustomLogoRatio);
elements.logo_ratio_y.addEventListener("input", updateCustomLogoRatio);
elements.confirm_cancel.addEventListener("click", () => resolveConfirm(false));
elements.confirm_accept.addEventListener("click", () => resolveConfirm(true));
elements.confirm_dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveConfirm(false);
});
elements.cancel_cover_picker.addEventListener("click", closeCoverPicker);
elements.cover_picker.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (state.busy) return;
  closeCoverPicker();
});
window.addEventListener("resize", layoutCoverPicker);
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (!elements.cover_picker.open || Math.abs(width - state.coverPickerWidth) < 0.5) return;
  state.coverPickerWidth = width;
  requestAnimationFrame(layoutCoverPicker);
}).observe(elements.cover_picker_grid);
window.addEventListener("beforeunload", (event) => {
  if (!state.settingsDirty) return;
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("click", handleDirtyLinkNavigation);
systemTheme.addEventListener("change", () => state.branding && applyAdminBranding());
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    applyAdminBranding();
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    state.userThemeMode = event.newValue;
    applyAdminBranding();
  }
});
elements.social_platform_select.append(...SOCIAL_PLATFORMS.map(socialPlatformOption));
elements.support_platform_select.append(...SUPPORT_PLATFORMS.map(socialPlatformOption));
await refresh();

async function refresh() {
  if (state.busy) return;
  setStatus("Refreshing", "working");
  try {
    const [dates, trash, branding] = await Promise.all([
      requestJson("/gallery/api/dates"),
      requestJson("/gallery/admin/api/trash"),
      requestJson("/gallery/admin/api/branding"),
    ]);
    state.dates = dates.dates;
    state.trash = trash.trash;
    state.branding = branding.branding;
    state.socials = [...(state.branding.socials || [])];
    state.supports = [...(state.branding.supports || [])];
    state.selectedProfileId = state.branding.profile_id;
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

function setSection(section) {
  state.section = section;
  for (const entry of sections) {
    const selected = section === entry.name;
    const { tab, view } = entry;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    view.hidden = !selected;
  }
  renderEmpty();
}

async function requestSectionChange(section) {
  if (section === state.section) return;
  const currentTab = sections.find((entry) => entry.name === state.section)?.tab;
  if (state.settingsDirty) {
    const confirmed = await confirmDiscardSettings("Switch sections?", "Your unsaved Gallery Settings changes will be discarded.");
    if (!confirmed) {
      currentTab?.focus();
      return;
    }
    discardBrandingChanges({ focus: false });
  }
  setSection(section);
  sections.find((entry) => entry.name === section)?.tab.focus();
}

function handleSectionTabKeydown(event) {
  const index = sections.findIndex((entry) => entry.tab === event.currentTarget);
  if (index < 0) return;
  let target = null;
  if (event.key === "ArrowRight") target = (index + 1) % sections.length;
  else if (event.key === "ArrowLeft") target = (index - 1 + sections.length) % sections.length;
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = sections.length - 1;
  if (target === null) return;
  event.preventDefault();
  void requestSectionChange(sections[target].name);
}

async function handleDirtyLinkNavigation(event) {
  if (!state.settingsDirty || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.("a[href]");
  if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  const destination = new URL(link.href, location.href);
  if (destination.origin !== location.origin) return;
  if (destination.pathname === location.pathname && destination.search === location.search && destination.hash && destination.hash !== location.hash) return;
  event.preventDefault();
  if (state.busy) {
    setStatus("Wait for the current change to finish", "working");
    return;
  }
  const confirmed = await confirmDiscardSettings("Leave this page?", "Your unsaved Gallery Settings changes will be discarded.");
  if (!confirmed) return;
  discardBrandingChanges({ announce: false, focus: false });
  location.assign(destination.href);
}

function confirmDiscardSettings(title, copy) {
  return showConfirm({
    eyebrow: "Unsaved gallery settings",
    title,
    copy,
    actionLabel: "Discard and continue",
    danger: true,
  });
}

function setContentView(view) {
  state.contentView = view;
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
  elements.summary.textContent = `${publishedCount} published photo${publishedCount === 1 ? "" : "s"} - ${state.trash.length} recoverable`;
  renderAlbums();
  renderTrash();
  renderBranding();
  setSection(state.section);
  setContentView(state.contentView);
}

function renderAlbums() {
  elements.albums.replaceChildren(...state.dates.map((date) => {
    const card = templates.album.content.firstElementChild.cloneNode(true);
    card.querySelector("img").src = date.cover_thumbnail_url || "/gallery/assets/frame-logo-square.svg";
    card.querySelector("img").alt = `Album cover for ${date.date_folder}`;
    card.querySelector("strong").textContent = formatDate(date.date_folder);
    card.querySelector("small").textContent = `${photoLabel(date.count)} - ${durationLabel(date.duration_ms)}`;
    card.querySelector(".album-open").addEventListener("click", () => openAlbum(date.date_folder));
    const exploreLabel = date.has_explore ? "Manage Explore" : "Add GPS route";
    const exploreLink = card.querySelector(".album-explore");
    exploreLink.href = `/gallery/admin/explore?date=${encodeURIComponent(date.date_folder)}`;
    exploreLink.textContent = exploreLabel;
    exploreLink.setAttribute("aria-label", `${exploreLabel} for ${formatDate(date.date_folder)}`);
    card.querySelector(".album-trash").addEventListener("click", () => manage("trash-album", date.date_folder, null, `Move every photo from ${formatDate(date.date_folder)} to trash?`));
    card.classList.toggle("selected", date.date_folder === state.selectedDate);
    return card;
  }));
  const selected = state.dates.find((date) => date.date_folder === state.selectedDate);
  elements.album_detail.hidden = !selected;
  if (!selected) return;
  elements.album_title.textContent = formatDate(selected.date_folder);
  elements.album_summary.textContent = `${photoLabel(selected.count)} - ${durationLabel(selected.duration_ms)}`;
  elements.manage_explore.href = `/gallery/admin/explore?date=${encodeURIComponent(selected.date_folder)}`;
  elements.manage_explore.textContent = selected.has_explore ? "Manage Explore" : "Add GPS route";
  elements.cover_action.textContent = selected.cover_is_custom ? "Clear cover image" : "Select cover image";
  elements.cover_action.className = selected.cover_is_custom ? "danger-button" : "secondary-button";
  renderCoverManagementStatus(selected);
  elements.photos.replaceChildren(...state.photos.map((photo) => {
    const card = templates.photo.content.firstElementChild.cloneNode(true);
    const photoName = friendlyBase(photo.base);
    card.dataset.photoBase = photo.base;
    card.tabIndex = -1;
    card.querySelector("img").src = photo.thumbnail_url;
    card.querySelector("img").alt = "";
    card.querySelector("strong").textContent = photoName;
    card.querySelector("small").textContent = formatTime(photo.processed_at);
    const isCover = photo.base === selected.cover_base;
    card.querySelector(".cover-star").hidden = !(selected.cover_is_custom && !selected.cover_fallback_active && isCover);
    const trashButton = card.querySelector(".trash-photo-button");
    trashButton.setAttribute("aria-label", `Move ${photoName} to trash`);
    trashButton.title = `Move ${photoName} to trash`;
    trashButton.addEventListener("click", () => manage(
      "trash-photo",
      photo.date_folder,
      photo.base,
      `Move ${photoName} to trash? You can restore it later.`,
    ));
    return card;
  }));
}

async function handleCoverAction() {
  const selected = state.dates.find((date) => date.date_folder === state.selectedDate);
  if (!selected) return;
  if (!selected.cover_is_custom) {
    openCoverPicker();
    return;
  }
  const confirmed = await showConfirm({
    eyebrow: "Clear cover image",
    title: "Return to the automatic cover?",
    copy: "The earliest published photo will become this gallery's cover.",
    actionLabel: "Clear cover image",
    danger: true,
  });
  if (!confirmed) return;
  await saveGallerySettings(
    { cover_base: null },
    { saving: "Clearing gallery cover", saved: "Automatic gallery cover restored" },
  );
}

function openCoverPicker() {
  if (!state.photos.length || elements.cover_picker.open) return;
  state.coverPickerScrollY = window.scrollY;
  state.coverPickerReturnFocus = document.activeElement;
  elements.cover_picker_grid.replaceChildren(...state.photos.map((photo) => {
    const photoName = photo.original_name || friendlyBase(photo.base);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cover-picker-photo";
    button.dataset.photoBase = photo.base;
    button.dataset.ratio = String(clamp((photo.width || 4) / (photo.height || 3), 0.35, 3.5));
    button.setAttribute("aria-label", `Select ${photoName} as gallery cover`);
    const image = document.createElement("img");
    image.src = photo.thumbnail_url;
    image.alt = "";
    image.loading = "lazy";
    button.append(image);
    button.addEventListener("click", () => confirmCoverSelection(photo, button));
    return button;
  }));
  setCoverPickerStatus();
  document.body.classList.add("cover-picker-open");
  elements.cover_picker.showModal();
  requestAnimationFrame(() => {
    layoutCoverPicker();
    elements.cancel_cover_picker.focus();
  });
}

function closeCoverPicker() {
  if (!elements.cover_picker.open) return;
  const returnFocus = state.coverPickerReturnFocus?.isConnected ? state.coverPickerReturnFocus : elements.cover_action;
  document.body.classList.remove("cover-picker-open");
  elements.cover_picker.close();
  elements.cover_picker_grid.replaceChildren();
  setCoverPickerStatus();
  window.scrollTo(0, state.coverPickerScrollY);
  state.coverPickerReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.focus());
}

async function confirmCoverSelection(photo, button) {
  const photoName = photo.original_name || friendlyBase(photo.base);
  const confirmed = await showConfirm({
    eyebrow: "Gallery cover",
    title: "Use this cover image?",
    copy: "This photo will become the main image shown for the gallery.",
    actionLabel: "Set cover",
    danger: false,
    imageUrl: photo.thumbnail_url,
    imageAlt: photoName,
  });
  if (!confirmed) return;
  if (!elements.cover_picker.open) return;
  elements.cancel_cover_picker.focus();
  const saved = await saveGallerySettings(
    { cover_base: photo.base },
    { saving: "Saving gallery cover", saved: "Gallery cover updated" },
  );
  if (saved) {
    closeCoverPicker();
    return;
  }
  if (elements.cover_picker.open) requestAnimationFrame(() => (button.isConnected ? button : elements.cancel_cover_picker).focus());
}

function setCoverPickerStatus(message = "", kind = "working") {
  elements.cover_picker_status.textContent = message;
  elements.cover_picker_status.hidden = !message;
  if (message) elements.cover_picker_status.dataset.kind = kind;
  else delete elements.cover_picker_status.dataset.kind;
  const busy = Boolean(message) && kind === "working";
  elements.cover_picker.setAttribute("aria-busy", String(busy));
  elements.cover_picker_grid.setAttribute("aria-busy", String(busy));
  if (busy && elements.cover_picker.open) elements.cover_picker_status.focus({ preventScroll: true });
}

function layoutCoverPicker() {
  if (!elements.cover_picker.open) return;
  const items = [...elements.cover_picker_grid.querySelectorAll(".cover-picker-photo")];
  const width = elements.cover_picker_grid.clientWidth;
  if (!items.length || width < 1) return;
  state.coverPickerWidth = width;
  layoutJustifiedRows(elements.cover_picker_grid, items, {
    rowClass: "cover-picker-row",
    targetHeight: clamp(window.innerHeight * 0.46, 180, 405),
  });
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
    album.querySelector(".purge-album").addEventListener("click", () => manage("purge-album", dateFolder, null, `Permanently delete all trashed published copies and .ready receipts from ${formatDate(dateFolder)}? Queued StreamerBot actions will no longer be able to read those published paths.`));
    album.querySelector(".trash-photo-grid").replaceChildren(...photos.map((photo) => {
      const card = templates.trashPhoto.content.firstElementChild.cloneNode(true);
      card.querySelector("img").src = `/gallery/admin/thumb/${photo.date_folder}/${photo.base}.webp`;
      card.querySelector("img").alt = friendlyBase(photo.base);
      card.querySelector("strong").textContent = photo.original_name || friendlyBase(photo.base);
      card.querySelector("small").textContent = `Trashed ${formatTime(photo.trashed_at)}`;
      card.querySelector(".restore-photo").addEventListener("click", () => manage("restore-photo", photo.date_folder, photo.base));
      card.querySelector(".purge-photo").addEventListener("click", () => manage("purge-photo", photo.date_folder, photo.base, `Permanently delete the published copy and .ready receipt for ${photo.original_name || friendlyBase(photo.base)}? Queued StreamerBot actions will no longer be able to read that published path.`));
      return card;
    }));
    return album;
  }));
}

function renderBranding(options = {}) {
  const branding = state.branding;
  if (!branding) return;
  const draft = options.preserveDraft !== false && state.settingsDirty ? readSettingsDraft() : null;
  elements.branding_summary.textContent = `${branding.brand_name} · ${branding.gallery_title}`;
  elements.brand_name_input.value = draft?.brandName ?? branding.brand_name;
  elements.gallery_title_input.value = draft?.galleryTitle ?? branding.gallery_title;
  state.downloadsDraft = draft?.downloadsEnabled ?? (branding.show_download_button === true);
  renderDownloadsDraft();
  elements.logo_preview.src = branding.logo?.url || "/gallery/assets/frame-logo-square.svg";
  elements.logo_preview.alt = branding.logo ? `${branding.brand_name} logo` : "Default FRAME logo";
  elements.logo_trigger.setAttribute("aria-label", branding.logo ? "Replace gallery logo" : "Upload gallery logo");
  elements.remove_logo.hidden = !branding.logo;
  updateSettingsDirty();
  renderSocials();
  renderSupports();
  applyAdminBranding();
}

function readSettingsDraft() {
  return {
    brandName: elements.brand_name_input.value,
    galleryTitle: elements.gallery_title_input.value,
    downloadsEnabled: state.downloadsDraft,
  };
}

function setDownloadsDraft(enabled) {
  state.downloadsDraft = enabled;
  renderDownloadsDraft();
  updateSettingsDirty();
}

function renderDownloadsDraft() {
  elements.downloads_disabled.setAttribute("aria-pressed", String(!state.downloadsDraft));
  elements.downloads_enabled.setAttribute("aria-pressed", String(state.downloadsDraft));
}

function updateSettingsDirty() {
  if (!state.branding) return;
  state.settingsDirty = elements.brand_name_input.value !== state.branding.brand_name
    || elements.gallery_title_input.value !== state.branding.gallery_title
    || state.downloadsDraft !== (state.branding.show_download_button === true);
  elements.settings_action_bar.hidden = !state.settingsDirty;
  document.body.classList.toggle("settings-dirty", state.settingsDirty);
  elements.gallery_styling_tab.dataset.dirty = String(state.settingsDirty);
  if (state.settingsDirty) elements.gallery_styling_tab.setAttribute("aria-label", "Gallery Settings, unsaved changes");
  else elements.gallery_styling_tab.removeAttribute("aria-label");
  setSettingsActionMessage("You have unsaved changes.");
}

function setSettingsActionMessage(message, kind = "working") {
  elements.settings_action_message.textContent = message;
  elements.settings_action_message.dataset.kind = kind;
}

function discardBrandingChanges(options = {}) {
  const { announce = true, focus = true } = options;
  state.settingsDirty = false;
  renderBranding({ preserveDraft: false });
  if (announce) setStatus("Gallery setting changes discarded", "ready");
  if (focus) (state.section === "style" ? elements.brand_name_input : elements.gallery_styling_tab).focus();
}

function renderSocials() {
  const count = state.socials.length;
  elements.socials_summary.textContent = count ? `${count} social link${count === 1 ? "" : "s"} ready to publish.` : "No social links published.";
  elements.social_empty.hidden = count > 0;
  elements.social_admin_list.replaceChildren(...state.socials.map((social, index) => socialAdminRow(social, index)));
}

function socialAdminRow(social, index) {
  const row = document.createElement("article");
  row.className = "social-admin-item";
  row.dataset.socialId = social.id;
  row.innerHTML = `
    <div class="social-order-controls" role="group" aria-label="Reorder social link">
      <button class="social-order-button social-move-up" type="button" title="Move up">${icons.up}</button>
      <button class="social-order-button social-drag-handle" type="button" draggable="true" title="Drag to reorder">${icons.grip}</button>
      <button class="social-order-button social-move-down" type="button" title="Move down">${icons.down}</button>
    </div>
    <div class="social-admin-graphic">
      <button class="social-admin-icon social-graphic-trigger" type="button"></button>
      <button class="social-graphic-reset" type="button" title="Use platform icon" hidden>${icons.reset}</button>
      <input class="social-graphic-input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" hidden>
    </div>
    <div class="field-grid social-row-fields">
      <label>URL<input class="social-row-url" maxlength="2048" autocomplete="off"></label>
      <label>Platform<span class="select-shell"><select class="social-row-platform"></select></span></label>
      <label>Display label (optional)<input class="social-row-label" maxlength="60" autocomplete="off"></label>
    </div>
    <div class="social-row-actions">
      <button class="icon-danger-button social-remove" type="button" aria-label="Remove social link" title="Remove social link">${icons.trash}</button>
    </div>`;
  const graphic = row.querySelector(".social-graphic-trigger");
  const graphicInput = row.querySelector(".social-graphic-input");
  const graphicReset = row.querySelector(".social-graphic-reset");
  const urlInput = row.querySelector(".social-row-url");
  const platformSelect = row.querySelector(".social-row-platform");
  const labelInput = row.querySelector(".social-row-label");
  renderSocialAdminGraphic(graphic, graphicReset, social);
  urlInput.value = social.url;
  platformSelect.append(...SOCIAL_PLATFORMS.map(socialPlatformOption));
  platformSelect.value = social.platform;
  labelInput.value = social.label || "";
  urlInput.addEventListener("input", () => {
    social.url = urlInput.value;
    const platform = resolveSocialPlatform(urlInput.value, platformSelect.value);
    if (!platform) return;
    social.platform = platform;
    platformSelect.value = platform;
    renderSocialAdminGraphic(graphic, graphicReset, social);
  });
  platformSelect.addEventListener("change", () => {
    social.platform = platformSelect.value;
    renderSocialAdminGraphic(graphic, graphicReset, social);
  });
  labelInput.addEventListener("input", () => { social.label = labelInput.value; });
  const up = row.querySelector(".social-move-up");
  const down = row.querySelector(".social-move-down");
  const drag = row.querySelector(".social-drag-handle");
  up.disabled = index === 0;
  down.disabled = index === state.socials.length - 1;
  up.setAttribute("aria-label", `Move ${socialName(social)} up`);
  down.setAttribute("aria-label", `Move ${socialName(social)} down`);
  drag.setAttribute("aria-label", `Drag ${socialName(social)} to reorder`);
  up.addEventListener("click", () => moveSocial(index, -1));
  down.addEventListener("click", () => moveSocial(index, 1));
  drag.addEventListener("dragstart", (event) => startSocialDrag(event, row, social.id));
  drag.addEventListener("dragend", finishSocialDrag);
  row.addEventListener("dragover", (event) => dragOverSocial(event, row, social.id));
  row.addEventListener("dragleave", (event) => {
    if (!row.contains(event.relatedTarget)) row.classList.remove("is-drag-target");
  });
  row.addEventListener("drop", (event) => dropSocial(event, social.id));
  graphic.addEventListener("click", () => graphicInput.click());
  graphicInput.addEventListener("change", () => selectSocialGraphic(graphicInput, social));
  graphicReset.addEventListener("click", () => resetSocialGraphic(social));
  const remove = row.querySelector(".social-remove");
  remove.setAttribute("aria-label", `Remove ${socialName(social)}`);
  remove.addEventListener("click", () => confirmRemoveSocial(social));
  return row;
}

function socialName(social) {
  return String(social.label || SOCIAL_PLATFORMS.find((platform) => platform.id === social.platform)?.label || "social link");
}

function renderSocialAdminGraphic(button, reset, social) {
  button.replaceChildren();
  if (social.graphic?.url) {
    const image = document.createElement("img");
    image.src = social.graphic.url;
    image.alt = "";
    image.addEventListener("error", () => {
      image.replaceWith(socialIconElement(social.platform));
    }, { once: true });
    button.append(image);
  } else {
    button.append(socialIconElement(social.platform));
  }
  const badge = document.createElement("span");
  badge.className = "social-graphic-badge";
  badge.innerHTML = icons.image;
  button.append(badge);
  button.setAttribute("aria-label", `${social.graphic ? "Replace" : "Add"} custom graphic for ${socialName(social)}`);
  button.title = social.graphic ? "Replace custom graphic" : "Add custom graphic";
  reset.hidden = !social.graphic;
  reset.setAttribute("aria-label", `Use the ${socialName(social)} platform icon`);
}

function socialIconElement(platform) {
  const icon = document.createElement("span");
  icon.className = "social-admin-platform-icon";
  icon.innerHTML = socialIcon(platform);
  return icon;
}

function startSocialDrag(event, row, socialId) {
  state.draggedSocialId = socialId;
  row.classList.add("is-dragging");
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", socialId);
}

function dragOverSocial(event, row, socialId) {
  if (!state.draggedSocialId || state.draggedSocialId === socialId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".social-admin-item.is-drag-target").forEach((item) => item.classList.remove("is-drag-target"));
  row.classList.add("is-drag-target");
}

function dropSocial(event, targetId) {
  event.preventDefault();
  const sourceId = state.draggedSocialId || event.dataTransfer?.getData("text/plain");
  finishSocialDrag();
  if (!sourceId || sourceId === targetId) return;
  const source = state.socials.findIndex((social) => social.id === sourceId);
  const target = state.socials.findIndex((social) => social.id === targetId);
  if (source < 0 || target < 0) return;
  const [social] = state.socials.splice(source, 1);
  state.socials.splice(target, 0, social);
  renderSocials();
  setStatus("Social order changed - save to publish", "working");
}

function finishSocialDrag() {
  state.draggedSocialId = null;
  document.querySelectorAll(".social-admin-item.is-dragging, .social-admin-item.is-drag-target").forEach((item) => {
    item.classList.remove("is-dragging", "is-drag-target");
  });
}

async function confirmRemoveSocial(social) {
  const confirmed = await showConfirm({
    eyebrow: "Confirm social change",
    title: `Remove ${socialName(social)}?`,
    copy: "This link and its custom graphic will disappear from every gallery after you save socials.",
    actionLabel: "Remove link",
    danger: true,
  });
  if (!confirmed) return;
  const index = state.socials.findIndex((item) => item.id === social.id);
  if (index < 0) return;
  state.socials.splice(index, 1);
  renderSocials();
  setStatus("Social removed - save to publish", "working");
}

async function selectSocialGraphic(input, social) {
  const file = input.files?.[0];
  input.value = "";
  if (!file || state.busy) return;
  clearSocialError();
  if (!isPersistedSocial(social.id)) {
    showSocialError("Save socials first before adding a custom graphic.");
    return;
  }
  if (!isAllowedLogoFile(file)) {
    showSocialError("Graphic must be a PNG, JPEG, WebP, or SVG image.");
    return;
  }
  try {
    await openLogoCropDialog(file, social.id);
  } catch (error) {
    showSocialError(error.message || "Graphic file could not be prepared.");
  }
}

async function saveGallerySettings(changes, messages) {
  if (state.busy || !state.selectedDate) return false;
  state.busy = true;
  if (elements.cover_picker.open) setCoverPickerStatus(messages.saving, "working");
  setControlsDisabled(true);
  setStatus(messages.saving, "working");
  try {
    await requestJson(`/gallery/admin/api/galleries/${encodeURIComponent(state.selectedDate)}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    await refreshAfterManagement();
    setCoverManagementStatus(messages.saved, "ready");
    if (elements.cover_picker.open) setCoverPickerStatus(messages.saved, "ready");
    else restoreCoverManagementFocus(changes);
    setStatus(messages.saved, "ready");
    return true;
  } catch (error) {
    renderAlbums();
    const message = error.message || "Gallery settings could not be saved";
    setCoverManagementStatus(message, "error");
    if (elements.cover_picker.open) setCoverPickerStatus(message, "error");
    else restoreCoverManagementFocus(changes);
    setStatus(message, "error");
    return false;
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

function renderCoverManagementStatus(date) {
  if (date.cover_fallback_active) {
    setCoverManagementStatus("The selected cover is unavailable. The earliest published photo is shown until it is restored or you choose another.", "fallback");
  } else if (date.cover_is_custom) {
    setCoverManagementStatus("A custom gallery cover is selected.", "ready");
  } else {
    setCoverManagementStatus("Automatic cover uses the earliest published photo.", "ready");
  }
}

function setCoverManagementStatus(message, kind) {
  elements.cover_management_status.textContent = message;
  elements.cover_management_status.dataset.kind = kind;
}

function restoreCoverManagementFocus(changes) {
  if (Object.hasOwn(changes, "cover_base")) {
    if (typeof changes.cover_base === "string") {
      [...elements.photos.children].find((card) => card.dataset.photoBase === changes.cover_base)?.focus();
    } else {
      elements.cover_management_panel.focus();
    }
  }
}

async function resetSocialGraphic(social) {
  if (state.busy) return;
  clearSocialError();
  if (!isPersistedSocial(social.id)) {
    showSocialError("Save socials first before changing its graphic.");
    return;
  }
  state.busy = true;
  setControlsDisabled(true);
  setStatus("Resetting social graphic", "working");
  try {
    const result = await requestJson(`/gallery/admin/api/branding/socials/${encodeURIComponent(social.id)}/graphic`, { method: "DELETE" });
    applySocialGraphicBranding(result.branding, social.id);
    setStatus("Platform icon restored", "ready");
  } catch (error) {
    showSocialError(error.message || "Graphic reset failed.");
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

function isPersistedSocial(id) {
  return Boolean(state.branding?.socials?.some((social) => social.id === id));
}

function applySocialGraphicBranding(branding, socialId) {
  state.branding = branding;
  const draft = state.socials.find((social) => social.id === socialId);
  const saved = branding.socials?.find((social) => social.id === socialId);
  if (draft) {
    if (saved?.graphic) draft.graphic = saved.graphic;
    else delete draft.graphic;
  }
  renderSocials();
  applyAdminBranding();
}

function addSocial(event) {
  event.preventDefault();
  clearSocialError();
  try {
    if (state.socials.length >= 32) throw new Error("Social links are limited to 32.");
    const value = elements.social_value_input.value;
    const platform = resolveSocialPlatform(value, elements.social_platform_select.value);
    if (!platform) throw new Error("Select a platform for this handle.");
    const label = elements.social_label_input.value.trim();
    state.socials.push({ id: createSocialId(), platform, url: buildSocialUrl(value, platform), ...(label ? { label } : {}) });
    elements.social_value_input.value = "";
    elements.social_platform_select.value = "";
    elements.social_label_input.value = "";
    renderSocials();
    setStatus("Social added - save to publish", "working");
  } catch (error) {
    showSocialError(error.message || "Could not add that social link.");
  }
}

function moveSocial(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.socials.length) return;
  [state.socials[index], state.socials[target]] = [state.socials[target], state.socials[index]];
  renderSocials();
  setStatus("Social order changed - save to publish", "working");
}

async function saveSocials() {
  clearSocialError();
  try {
    state.socials = state.socials.map((social) => {
      const platform = resolveSocialPlatform(social.url, social.platform);
      const label = String(social.label || "").trim();
      return { id: social.id, platform, url: buildSocialUrl(social.url, platform), ...(label ? { label } : {}) };
    });
    await persistBranding(
      { socials: state.socials },
      { saving: "Saving socials", saved: "Socials saved", failed: "Socials save failed" },
      { preserveBrandingDrafts: true, preserveSupportDrafts: true },
    );
  } catch (error) {
    showSocialError(error.message || "Could not save social links.");
  }
}

function renderSupports() {
  const count = state.supports.length;
  elements.support_summary.textContent = count ? `${count} support link${count === 1 ? "" : "s"} ready to publish.` : "No support links published.";
  elements.support_empty.hidden = count > 0;
  elements.support_admin_list.replaceChildren(...state.supports.map((support, index) => supportAdminRow(support, index)));
}

function supportAdminRow(support, index) {
  const row = document.createElement("article");
  row.className = "social-admin-item support-admin-item";
  row.innerHTML = `
    <div class="social-order-controls" role="group" aria-label="Reorder support link">
      <button class="social-order-button support-move-up" type="button" title="Move up">${icons.up}</button>
      <button class="social-order-button support-move-down" type="button" title="Move down">${icons.down}</button>
    </div>
    <span class="social-admin-icon support-admin-icon" aria-hidden="true">${supportIcon(support.platform)}</span>
    <div class="field-grid social-row-fields">
      <label>URL<input class="support-row-url" maxlength="2048" autocomplete="off"></label>
      <label>Platform<span class="select-shell"><select class="support-row-platform"></select></span></label>
      <label>Display label (optional)<input class="support-row-label" maxlength="60" autocomplete="off"></label>
    </div>
    <div class="social-row-actions">
      <button class="icon-danger-button support-remove" type="button" aria-label="Remove support link" title="Remove support link">${icons.trash}</button>
    </div>`;
  const urlInput = row.querySelector(".support-row-url");
  const platformSelect = row.querySelector(".support-row-platform");
  const labelInput = row.querySelector(".support-row-label");
  urlInput.value = support.url;
  platformSelect.append(...SUPPORT_PLATFORMS.map(socialPlatformOption));
  platformSelect.value = support.platform;
  labelInput.value = support.label || "";
  urlInput.addEventListener("input", () => {
    support.url = urlInput.value;
    const platform = resolveSupportPlatform(urlInput.value, platformSelect.value);
    if (platform) support.platform = platformSelect.value = platform;
  });
  platformSelect.addEventListener("change", () => { support.platform = platformSelect.value; });
  labelInput.addEventListener("input", () => { support.label = labelInput.value; });
  const up = row.querySelector(".support-move-up");
  const down = row.querySelector(".support-move-down");
  up.disabled = index === 0;
  down.disabled = index === state.supports.length - 1;
  up.setAttribute("aria-label", `Move ${supportName(support)} up`);
  down.setAttribute("aria-label", `Move ${supportName(support)} down`);
  up.addEventListener("click", () => moveSupport(index, -1));
  down.addEventListener("click", () => moveSupport(index, 1));
  row.querySelector(".support-remove").addEventListener("click", () => confirmRemoveSupport(support));
  return row;
}

function supportName(support) {
  return String(support.label || SUPPORT_PLATFORMS.find((platform) => platform.id === support.platform)?.label || "support link");
}

function addSupport(event) {
  event.preventDefault();
  clearSupportError();
  try {
    if (state.supports.length >= 32) throw new Error("Support links are limited to 32.");
    const value = elements.support_value_input.value;
    const platform = resolveSupportPlatform(value, elements.support_platform_select.value);
    if (!platform) throw new Error("Paste a payment link or select its platform.");
    const label = elements.support_label_input.value.trim();
    state.supports.push({ id: createSupportId(), platform, url: buildSupportUrl(value), ...(label ? { label } : {}) });
    elements.support_value_input.value = "";
    elements.support_platform_select.value = "";
    elements.support_label_input.value = "";
    renderSupports();
    setStatus("Support link added - save to publish", "working");
  } catch (error) {
    showSupportError(error.message || "Could not add that support link.");
  }
}

function moveSupport(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.supports.length) return;
  [state.supports[index], state.supports[target]] = [state.supports[target], state.supports[index]];
  renderSupports();
  setStatus("Support order changed - save to publish", "working");
}

async function confirmRemoveSupport(support) {
  if (!await showConfirm({
    eyebrow: "Confirm support change",
    title: `Remove ${supportName(support)}?`,
    copy: "This link will disappear from every gallery after you save support links.",
    actionLabel: "Remove link",
    danger: true,
  })) return;
  state.supports = state.supports.filter((item) => item.id !== support.id);
  renderSupports();
  setStatus("Support link removed - save to publish", "working");
}

async function saveSupports() {
  clearSupportError();
  try {
    state.supports = state.supports.map((support) => {
      const platform = resolveSupportPlatform(support.url, support.platform);
      const label = String(support.label || "").trim();
      return { id: support.id, platform, url: buildSupportUrl(support.url), ...(label ? { label } : {}) };
    });
    await persistBranding(
      { supports: state.supports },
      { saving: "Saving support links", saved: "Support links saved", failed: "Support links save failed" },
      { preserveBrandingDrafts: true, preserveSocialDrafts: true },
    );
  } catch (error) {
    showSupportError(error.message || "Could not save support links.");
  }
}

function showSupportError(message) {
  elements.support_form_error.textContent = message;
  elements.support_form_error.hidden = false;
  setStatus(message, "error");
}

function clearSupportError() {
  elements.support_form_error.hidden = true;
  elements.support_form_error.textContent = "";
}

function socialPlatformOption(platform) {
  const option = document.createElement("option");
  option.value = platform.id;
  option.textContent = platform.label;
  return option;
}

function showSocialError(message) {
  elements.social_form_error.textContent = message;
  elements.social_form_error.hidden = false;
  setStatus(message, "error");
}

function clearSocialError() {
  elements.social_form_error.hidden = true;
  elements.social_form_error.textContent = "";
}

async function saveBranding(overrides = {}, messages = {}) {
  return persistBranding(
    brandingPayload(overrides),
    { saving: "Saving gallery settings", saved: "Gallery settings saved", failed: "Gallery settings save failed", ...messages },
    { preserveSocialDrafts: true, preserveSupportDrafts: true },
  );
}

async function persistBranding(payload, messages = {}, options = {}) {
  if (state.busy || !state.branding) return;
  const socialDrafts = state.socials;
  const supportDrafts = state.supports;
  const savingSettingsDraft = state.settingsDirty && !options.preserveBrandingDrafts;
  state.busy = true;
  if (savingSettingsDraft) setSettingsActionMessage(messages.saving || "Saving gallery settings", "working");
  setControlsDisabled(true);
  setStatus(messages.saving || "Saving gallery settings", "working");
  try {
    const result = await requestJson("/gallery/admin/api/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.branding = result.branding;
    state.socials = options.preserveSocialDrafts ? socialDrafts : [...(state.branding.socials || [])];
    state.supports = options.preserveSupportDrafts ? supportDrafts : [...(state.branding.supports || [])];
    if (options.preserveBrandingDrafts) {
      renderSocials();
      renderSupports();
      applyAdminBranding();
    } else {
      state.settingsDirty = false;
      state.selectedProfileId = state.branding.profile_id;
      renderBranding({ preserveDraft: false });
    }
    setStatus(messages.saved || "Gallery settings saved", "ready");
  } catch (error) {
    const message = error.message || messages.failed || "Gallery settings save failed";
    if (savingSettingsDraft) setSettingsActionMessage(message, "error");
    setStatus(message, "error");
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

function brandingPayload(overrides = {}) {
  const shown = state.downloadsDraft;
  return {
    brand_name: elements.brand_name_input.value,
    gallery_title: elements.gallery_title_input.value,
    show_download_button: shown,
    mode: state.branding?.mode || "system",
    profile_id: state.branding?.profile_id || "frame-blue",
    custom_profiles: state.branding?.custom_profiles || [],
    ...overrides,
  };
}

async function uploadLogo() {
  const file = elements.logo_input.files?.[0];
  if (!file || state.busy) return;
  if (!isAllowedLogoFile(file)) {
    setStatus("Logo must be a PNG, JPEG, WebP, or SVG image", "error");
    elements.logo_input.value = "";
    return;
  }
  try {
    await openLogoCropDialog(file);
  } catch (error) {
    setStatus(error.message || "Logo file could not be prepared", "error");
  } finally {
    elements.logo_input.value = "";
  }
}

async function openLogoCropDialog(file, socialId = null) {
  if (file.size > LOGO_SOURCE_MAX_BYTES) {
    throw new Error(`${socialId ? "Graphic" : "Logo"} source must be 20 MB or smaller`);
  }
  const imageUrl = URL.createObjectURL(file);
  await loadCropImage(imageUrl);
  const sourceWidth = elements.logo_crop_image.naturalWidth;
  const sourceHeight = elements.logo_crop_image.naturalHeight;
  state.logoCrop = {
    fileName: file.name,
    imageUrl,
    socialId,
    sourceWidth,
    sourceHeight,
    aspect: socialId ? "square" : "full",
    customX: 2,
    customY: 1,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    drag: null,
    resize: null,
    frameBox: null,
  };
  elements.logo_ratio_x.value = "2";
  elements.logo_ratio_y.value = "1";
  elements.logo_crop_zoom.value = "1";
  elements.logo_crop_dialog.dataset.cropTarget = socialId ? "social" : "logo";
  elements.logo_crop_eyebrow.textContent = socialId ? "Link graphic source" : "Logo source";
  elements.logo_crop_title.textContent = socialId ? "Prepare link graphic" : "Prepare logo";
  elements.save_logo_crop.textContent = socialId ? "Use graphic" : "Use logo";
  syncLogoCropAspectControls();
  setStatus(socialId ? "Prepare link graphic" : "Prepare logo", "working");
  elements.logo_crop_dialog.showModal();
  requestAnimationFrame(() => {
    setLogoCropAspect(socialId ? "square" : "full", { resetView: false });
    renderLogoCrop();
  });
}

function loadCropImage(url) {
  return new Promise((resolve, reject) => {
    elements.logo_crop_image.onload = () => resolve();
    elements.logo_crop_image.onerror = () => reject(new Error("Logo source could not be previewed"));
    elements.logo_crop_image.src = url;
  });
}

function closeLogoCropDialog() {
  const socialGraphic = Boolean(state.logoCrop?.socialId);
  cleanupLogoCrop();
  if (elements.logo_crop_dialog.open) elements.logo_crop_dialog.close();
  setStatus(`${socialGraphic ? "Graphic" : "Logo"} upload cancelled`, "ready");
}

async function saveLogoCrop() {
  if (!state.logoCrop || state.busy) return;
  const socialId = state.logoCrop.socialId;
  state.busy = true;
  setControlsDisabled(true);
  setStatus(`Processing ${socialId ? "graphic" : "logo"}`, "working");
  try {
    const dataUrl = await renderCroppedLogoDataUrl();
    setStatus(`Uploading optimized ${socialId ? "graphic" : "logo"}`, "working");
    const endpoint = socialId
      ? `/gallery/admin/api/branding/socials/${encodeURIComponent(socialId)}/graphic`
      : "/gallery/admin/api/branding/logo";
    const result = await requestJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_url: dataUrl }),
    });
    if (socialId) {
      applySocialGraphicBranding(result.branding, socialId);
    } else {
      state.branding = result.branding;
      state.selectedProfileId = state.branding.profile_id;
      renderBranding();
    }
    cleanupLogoCrop();
    if (elements.logo_crop_dialog.open) elements.logo_crop_dialog.close();
    setStatus(`${socialId ? "Link graphic" : "Logo"} saved`, "ready");
  } catch (error) {
    setStatus(error.message || `${socialId ? "Graphic" : "Logo"} upload failed`, "error");
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

function isAllowedLogoFile(file) {
  return LOGO_ALLOWED_TYPES.has(file.type) || /\.svg$/i.test(file.name);
}

function setLogoCropAspect(aspect, options = {}) {
  const cropState = state.logoCrop;
  if (!cropState) return;
  const nextAspect = cropState.socialId
    ? "square"
    : (["full", "wide", "square", "custom", "freeform"].includes(aspect) ? aspect : "full");
  const previousMetrics = nextAspect === "freeform" ? logoCropMetrics() : null;
  cropState.aspect = nextAspect;
  if (nextAspect === "wide") {
    cropState.customX = 2;
    cropState.customY = 1;
    writeLogoRatioInputs(2, 1);
  } else if (nextAspect === "square") {
    cropState.customX = 1;
    cropState.customY = 1;
    writeLogoRatioInputs(1, 1);
  } else if (nextAspect === "custom") {
    const ratio = readLogoRatioInputs();
    cropState.customX = ratio.x;
    cropState.customY = ratio.y;
    writeLogoRatioInputs(ratio.x, ratio.y);
  }
  if (nextAspect === "freeform") {
    cropState.frameBox = previousMetrics?.frame || defaultLogoFrameBox(elements.logo_crop_stage.getBoundingClientRect(), 1);
  } else {
    cropState.frameBox = null;
  }
  if (options.resetView !== false) {
    cropState.zoom = 1;
    cropState.offsetX = 0;
    cropState.offsetY = 0;
    elements.logo_crop_zoom.value = "1";
  }
  syncLogoCropAspectControls();
  requestAnimationFrame(renderLogoCrop);
}

function updateCustomLogoRatio() {
  if (!state.logoCrop) return;
  setLogoCropAspect("custom", { resetView: false });
}

function readLogoRatioInputs() {
  const fallbackX = state.logoCrop?.customX || 2;
  const fallbackY = state.logoCrop?.customY || 1;
  const x = Math.round(Number(elements.logo_ratio_x.value));
  const y = Math.round(Number(elements.logo_ratio_y.value));
  return {
    x: clamp(Number.isFinite(x) && x > 0 ? x : fallbackX, 1, 99),
    y: clamp(Number.isFinite(y) && y > 0 ? y : fallbackY, 1, 99),
  };
}

function writeLogoRatioInputs(x, y) {
  elements.logo_ratio_x.value = String(Math.round(clamp(x, 1, 99)));
  elements.logo_ratio_y.value = String(Math.round(clamp(y, 1, 99)));
}

function syncLogoCropAspectControls() {
  const aspect = state.logoCrop?.aspect || "full";
  elements.logo_crop_dialog.dataset.cropMode = aspect;
  elements.logo_crop_stage.dataset.freeform = String(aspect === "freeform");
  elements.logo_crop_stage.dataset.full = String(aspect === "full");
  document.querySelectorAll(".logo-aspect-option").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.logoAspect === aspect));
  });
}

function startLogoCropDrag(event) {
  if (!state.logoCrop || (event.pointerType === "mouse" && event.button !== 0)) return;
  if (state.logoCrop.aspect === "full") return;
  if (event.target.closest?.(".logo-crop-handle") || state.logoCrop.resize) return;
  elements.logo_crop_stage.setPointerCapture?.(event.pointerId);
  elements.logo_crop_stage.classList.add("is-dragging");
  state.logoCrop.drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    offsetX: state.logoCrop.offsetX,
    offsetY: state.logoCrop.offsetY,
  };
  event.preventDefault();
}

function moveLogoCropDrag(event) {
  if (state.logoCrop?.resize?.id === event.pointerId) {
    resizeLogoCropFrame(event);
    return;
  }
  if (state.logoCrop?.drag?.id !== event.pointerId) return;
  state.logoCrop.offsetX = state.logoCrop.drag.offsetX + event.clientX - state.logoCrop.drag.x;
  state.logoCrop.offsetY = state.logoCrop.drag.offsetY + event.clientY - state.logoCrop.drag.y;
  renderLogoCrop();
  event.preventDefault();
}

function finishLogoCropDrag(event) {
  if (state.logoCrop?.resize?.id === event.pointerId) {
    elements.logo_crop_stage.releasePointerCapture?.(event.pointerId);
    elements.logo_crop_stage.classList.remove("is-resizing");
    state.logoCrop.resize = null;
    event.preventDefault();
    return;
  }
  if (state.logoCrop?.drag?.id !== event.pointerId) return;
  elements.logo_crop_stage.releasePointerCapture?.(event.pointerId);
  elements.logo_crop_stage.classList.remove("is-dragging");
  state.logoCrop.drag = null;
  event.preventDefault();
}

function startLogoCropResize(event) {
  if (!state.logoCrop || state.logoCrop.aspect !== "freeform" || (event.pointerType === "mouse" && event.button !== 0)) return;
  const metrics = logoCropMetrics();
  if (!metrics) return;
  elements.logo_crop_stage.setPointerCapture?.(event.pointerId);
  elements.logo_crop_stage.classList.add("is-resizing");
  state.logoCrop.resize = {
    id: event.pointerId,
    handle: event.currentTarget.dataset.cropHandle || "se",
    x: event.clientX,
    y: event.clientY,
    frame: { ...metrics.frame },
  };
  event.preventDefault();
  event.stopPropagation();
}

function resizeLogoCropFrame(event) {
  const cropState = state.logoCrop;
  const resize = cropState?.resize;
  if (!resize) return;
  const metrics = logoCropMetrics();
  const stageRect = elements.logo_crop_stage.getBoundingClientRect();
  const margin = 8;
  const minWidth = Math.min(LOGO_FRAME_MIN_SIZE, Math.max(1, stageRect.width - margin * 2));
  const minHeight = Math.min(LOGO_FRAME_MIN_SIZE, Math.max(1, stageRect.height - margin * 2));
  let left = resize.frame.left;
  let top = resize.frame.top;
  let right = resize.frame.left + resize.frame.width;
  let bottom = resize.frame.top + resize.frame.height;
  const deltaX = event.clientX - resize.x;
  const deltaY = event.clientY - resize.y;
  if (resize.handle.includes("w")) left += deltaX;
  if (resize.handle.includes("e")) right += deltaX;
  if (resize.handle.includes("n")) top += deltaY;
  if (resize.handle.includes("s")) bottom += deltaY;
  if (resize.handle.includes("w")) left = clamp(left, margin, right - minWidth);
  else right = clamp(right, left + minWidth, stageRect.width - margin);
  if (resize.handle.includes("n")) top = clamp(top, margin, bottom - minHeight);
  else bottom = clamp(bottom, top + minHeight, stageRect.height - margin);
  if (metrics?.image) {
    const snapX = [metrics.image.left, metrics.image.left + metrics.image.width];
    const snapY = [metrics.image.top, metrics.image.top + metrics.image.height];
    if (resize.handle.includes("w")) left = clamp(snapToTargets(left, snapX), margin, right - minWidth);
    else right = clamp(snapToTargets(right, snapX), left + minWidth, stageRect.width - margin);
    if (resize.handle.includes("n")) top = clamp(snapToTargets(top, snapY), margin, bottom - minHeight);
    else bottom = clamp(snapToTargets(bottom, snapY), top + minHeight, stageRect.height - margin);
  }
  cropState.frameBox = {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
  renderLogoCrop();
  event.preventDefault();
}

function renderLogoCrop() {
  const metrics = logoCropMetrics();
  if (!metrics) return;
  const { image, frame } = metrics;
  elements.logo_crop_stage.style.setProperty("--crop-width", `${frame.width}px`);
  elements.logo_crop_stage.style.setProperty("--crop-height", `${frame.height}px`);
  elements.logo_crop_frame.style.left = `${frame.left + frame.width / 2}px`;
  elements.logo_crop_frame.style.top = `${frame.top + frame.height / 2}px`;
  elements.logo_crop_frame.style.width = `${frame.width}px`;
  elements.logo_crop_frame.style.height = `${frame.height}px`;
  elements.logo_crop_image.style.width = `${image.width}px`;
  elements.logo_crop_image.style.height = `${image.height}px`;
  elements.logo_crop_image.style.transform = `translate(${image.left}px, ${image.top}px)`;
  drawLogoPreview(metrics);
}

function logoCropMetrics() {
  const cropState = state.logoCrop;
  if (!cropState) return null;
  const stageRect = elements.logo_crop_stage.getBoundingClientRect();
  const sourceWidth = elements.logo_crop_image.naturalWidth;
  const sourceHeight = elements.logo_crop_image.naturalHeight;
  if (!stageRect.width || !stageRect.height || !sourceWidth || !sourceHeight) return null;
  const frame = logoCropFrame(stageRect, cropState);
  if (cropState.aspect === "full") {
    cropState.zoom = 1;
    cropState.offsetX = 0;
    cropState.offsetY = 0;
    elements.logo_crop_zoom.value = "1";
    return {
      image: { ...frame },
      frame,
      sourceWidth,
      sourceHeight,
    };
  }
  const baseScale = Math.min(stageRect.width / sourceWidth, stageRect.height / sourceHeight) * 0.94;
  const zoom = clamp(Number(cropState.zoom) || 1, Number(elements.logo_crop_zoom.min) || 0.1, Number(elements.logo_crop_zoom.max) || 4);
  const width = sourceWidth * baseScale * zoom;
  const height = sourceHeight * baseScale * zoom;
  const baseLeft = (stageRect.width - width) / 2;
  const baseTop = (stageRect.height - height) / 2;
  const visibleX = Math.min(Math.max(12, width * 0.35), 48);
  const visibleY = Math.min(Math.max(12, height * 0.35), 48);
  const minLeft = frame.left - width + visibleX;
  const maxLeft = frame.left + frame.width - visibleX;
  const minTop = frame.top - height + visibleY;
  const maxTop = frame.top + frame.height - visibleY;
  let imageLeft = clamp(baseLeft + cropState.offsetX, minLeft, maxLeft);
  let imageTop = clamp(baseTop + cropState.offsetY, minTop, maxTop);
  imageLeft = clamp(snapToTargets(imageLeft, [frame.left, frame.left + frame.width - width]), minLeft, maxLeft);
  imageTop = clamp(snapToTargets(imageTop, [frame.top, frame.top + frame.height - height]), minTop, maxTop);
  cropState.offsetX = imageLeft - baseLeft;
  cropState.offsetY = imageTop - baseTop;
  const image = {
    left: imageLeft,
    top: imageTop,
    width,
    height,
  };
  return { image, frame, sourceWidth, sourceHeight };
}

function logoCropFrame(stageRect, cropState) {
  if (cropState.aspect === "full") {
    return defaultLogoFrameBox(stageRect, (cropState.sourceWidth || 1) / Math.max(1, cropState.sourceHeight || 1));
  }
  if (cropState.aspect === "freeform") {
    cropState.frameBox = clampLogoFrameBox(cropState.frameBox || defaultLogoFrameBox(stageRect, 1), stageRect);
    return { ...cropState.frameBox };
  }
  return defaultLogoFrameBox(stageRect, logoCropAspectValue(cropState));
}

function defaultLogoFrameBox(stageRect, aspect) {
  const frameAspect = clamp(aspect || 1, 0.1, 10);
  let width = Math.min(stageRect.width * 0.84, stageRect.height * 0.74 * frameAspect);
  let height = width / frameAspect;
  if (height > stageRect.height * 0.74) {
    height = stageRect.height * 0.74;
    width = height * frameAspect;
  }
  return {
    left: (stageRect.width - width) / 2,
    top: (stageRect.height - height) / 2,
    width,
    height,
  };
}

function clampLogoFrameBox(frame, stageRect) {
  const margin = 8;
  const maxWidth = Math.max(1, stageRect.width - margin * 2);
  const maxHeight = Math.max(1, stageRect.height - margin * 2);
  const width = clamp(frame?.width || maxWidth * 0.6, Math.min(LOGO_FRAME_MIN_SIZE, maxWidth), maxWidth);
  const height = clamp(frame?.height || maxHeight * 0.6, Math.min(LOGO_FRAME_MIN_SIZE, maxHeight), maxHeight);
  return {
    left: clamp(frame?.left || (stageRect.width - width) / 2, margin, stageRect.width - width - margin),
    top: clamp(frame?.top || (stageRect.height - height) / 2, margin, stageRect.height - height - margin),
    width,
    height,
  };
}

function logoCropAspectValue(cropState) {
  if (cropState.aspect === "custom") return clamp((cropState.customX || 2) / Math.max(1, cropState.customY || 1), 0.1, 10);
  return LOGO_ASPECTS[cropState.aspect] || LOGO_ASPECTS.wide;
}

function drawLogoPreview(metrics) {
  const cropState = state.logoCrop;
  const previewAspect = cropState?.aspect === "freeform" ? 1 : metrics.frame.width / Math.max(1, metrics.frame.height);
  const size = previewCanvasSize(previewAspect);
  elements.logo_crop_preview.width = size.width;
  elements.logo_crop_preview.height = size.height;
  const context = elements.logo_crop_preview.getContext("2d");
  context.clearRect(0, 0, elements.logo_crop_preview.width, elements.logo_crop_preview.height);
  try {
    drawLogoComposition(context, metrics, {
      left: 0,
      top: 0,
      width: size.width,
      height: size.height,
      contain: cropState?.aspect === "freeform",
    });
  } catch {
    context.clearRect(0, 0, size.width, size.height);
  }
}

async function renderCroppedLogoDataUrl() {
  const metrics = logoCropMetrics();
  if (!metrics) throw new Error("Logo crop could not be measured");
  const aspect = metrics.frame.width / Math.max(1, metrics.frame.height);
  const output = state.logoCrop?.socialId
    ? { width: SOCIAL_GRAPHIC_SIZE, height: SOCIAL_GRAPHIC_SIZE }
    : outputSizeForAspect(aspect);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, output.width, output.height);
  try {
    drawLogoComposition(context, metrics, {
      left: 0,
      top: 0,
      width: output.width,
      height: output.height,
      contain: false,
    });
  } catch {
    throw new Error("Logo source could not be rendered. Try exporting the vector as PNG first.");
  }
  let blob = await canvasToBlob(canvas, "image/webp", LOGO_EXPORT_QUALITY);
  if (!blob || blob.size === 0) blob = await canvasToBlob(canvas, "image/png");
  if (!blob || blob.size === 0) throw new Error("Logo crop could not be exported");
  return await blobToDataUrl(blob);
}

function previewCanvasSize(aspect) {
  const normalized = clamp(aspect || 1, 0.15, 8);
  if (normalized >= 1) return { width: 360, height: Math.max(60, Math.round(360 / normalized)) };
  return { width: Math.max(60, Math.round(360 * normalized)), height: 360 };
}

function drawLogoComposition(context, metrics, target) {
  let left = target.left;
  let top = target.top;
  let width = target.width;
  let height = target.height;
  const frameAspect = metrics.frame.width / Math.max(1, metrics.frame.height);
  if (target.contain) {
    const targetAspect = width / Math.max(1, height);
    if (frameAspect > targetAspect) {
      const containedHeight = width / frameAspect;
      top += (height - containedHeight) / 2;
      height = containedHeight;
    } else {
      const containedWidth = height * frameAspect;
      left += (width - containedWidth) / 2;
      width = containedWidth;
    }
  }
  const scaleX = width / metrics.frame.width;
  const scaleY = height / metrics.frame.height;
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.beginPath();
  context.rect(left, top, width, height);
  context.clip();
  context.drawImage(
    elements.logo_crop_image,
    0,
    0,
    metrics.sourceWidth,
    metrics.sourceHeight,
    left + (metrics.image.left - metrics.frame.left) * scaleX,
    top + (metrics.image.top - metrics.frame.top) * scaleY,
    metrics.image.width * scaleX,
    metrics.image.height * scaleY,
  );
  context.restore();
}

function outputSizeForAspect(aspect) {
  if (aspect >= LOGO_EXPORT_BOX.width / LOGO_EXPORT_BOX.height) {
    return { width: LOGO_EXPORT_BOX.width, height: Math.max(1, Math.round(LOGO_EXPORT_BOX.width / aspect)) };
  }
  return { width: Math.max(1, Math.round(LOGO_EXPORT_BOX.height * aspect)), height: LOGO_EXPORT_BOX.height };
}

function snapToTargets(value, targets, threshold = LOGO_EDGE_SNAP_PX) {
  for (const target of targets) {
    if (Number.isFinite(target) && Math.abs(value - target) <= threshold) return target;
  }
  return value;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, type, quality);
    } catch (error) {
      reject(error);
    }
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error("Logo crop could not be read")));
    reader.readAsDataURL(blob);
  });
}

function cleanupLogoCrop() {
  if (state.logoCrop?.imageUrl) URL.revokeObjectURL(state.logoCrop.imageUrl);
  state.logoCrop = null;
  elements.logo_crop_image.removeAttribute("src");
  elements.logo_crop_stage.classList.remove("is-dragging");
  elements.logo_crop_stage.classList.remove("is-resizing");
  elements.logo_crop_stage.dataset.freeform = "false";
  elements.logo_crop_stage.dataset.full = "false";
  elements.logo_crop_dialog.dataset.cropMode = "full";
  elements.logo_crop_dialog.dataset.cropTarget = "logo";
  elements.logo_crop_eyebrow.textContent = "Logo source";
  elements.logo_crop_title.textContent = "Prepare logo";
  elements.save_logo_crop.textContent = "Use logo";
  elements.logo_crop_frame.removeAttribute("style");
}

async function removeLogo() {
  if (state.busy) return;
  state.busy = true;
  setControlsDisabled(true);
  setStatus("Removing logo", "working");
  try {
    const result = await requestJson("/gallery/admin/api/branding/logo", { method: "DELETE" });
    state.branding = result.branding;
    state.selectedProfileId = state.branding.profile_id;
    renderBranding();
    setStatus("Logo removed", "ready");
  } catch (error) {
    setStatus(error.message || "Logo remove failed", "error");
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

async function manage(action, dateFolder, base, confirmation) {
  if (state.busy) return;
  if (confirmation) {
    const confirmed = await showConfirm({
      eyebrow: "Confirm gallery change",
      title: confirmTitleForAction(action),
      copy: confirmation,
      actionLabel: confirmActionLabel(action),
      danger: true,
    });
    if (!confirmed) return;
  }
  state.busy = true;
  setControlsDisabled(true);
  setStatus("Applying change", "working");
  try {
    const result = await requestJson("/gallery/admin/api/manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, date_folder: dateFolder, base }),
    });
    setStatus(`${actionLabel(action)} - ${result.affected} photo${result.affected === 1 ? "" : "s"}`, "ready");
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

function applyAdminBranding() {
  const branding = state.branding;
  if (!branding) return;
  const portalProfile = readPortalThemeProfile();
  const profile = portalProfile || selectedProfile();
  const mode = resolvedAdminThemeMode();
  const palette = profile.palettes[mode];
  state.appliedThemeMode = mode;
  elements.admin_brand_name.textContent = branding.brand_name;
  const logoUrl = branding.logo?.url || "/gallery/assets/frame-logo-square.svg";
  if (elements.admin_brand_logo.getAttribute("src") !== logoUrl) elements.admin_brand_logo.src = logoUrl;
  elements.admin_brand_logo.alt = branding.logo ? `${branding.brand_name} logo` : "";
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = mode === "day" ? "light" : "dark";
  if (portalProfile && window.FrameTheme) {
    window.FrameTheme.apply(mode);
  } else {
    for (const [key, value] of Object.entries(palette)) {
      document.documentElement.style.setProperty(`--${kebab(key)}`, value);
    }
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.background || palette.page);
  updateAdminThemeToggle(mode);
}

function toggleAdminTheme() {
  const current = state.appliedThemeMode || resolvedAdminThemeMode();
  const nextMode = current === "day" ? "night" : "day";
  state.userThemeMode = nextMode;
  writeStoredTheme(nextMode);
  applyAdminBranding();
}

function resolvedAdminThemeMode() {
  if (state.userThemeMode === "day" || state.userThemeMode === "night") return state.userThemeMode;
  if (state.branding?.mode === "day" || state.branding?.mode === "night") return state.branding.mode;
  return systemTheme.matches ? "night" : "day";
}

function updateAdminThemeToggle(mode) {
  const nextMode = mode === "day" ? "night" : "day";
  elements.admin_theme_toggle.innerHTML = mode === "day" ? icons.sun : icons.moon;
  elements.admin_theme_toggle.setAttribute("aria-label", `Switch to ${nextMode} mode`);
  elements.admin_theme_toggle.title = `Switch to ${nextMode} mode`;
  elements.admin_theme_toggle.setAttribute("aria-pressed", String(mode === "day"));
}

function profiles() {
  return state.branding?.presets || [];
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

function selectedProfile() {
  return profiles().find((profile) => profile.id === state.selectedProfileId)
    || state.branding?.active_profile
    || profiles()[0]
    || buildThemeProfileClient("frame-blue", "Frame Blue", "#2cb4fb");
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button, input, select").forEach((control) => {
    if (disabled) {
      if (control.dataset.busyDisabledState === undefined) {
        control.dataset.busyDisabledState = control.disabled ? "disabled" : "enabled";
      }
      control.disabled = true;
      return;
    }
    if (control.dataset.busyDisabledState === undefined) return;
    control.disabled = control.dataset.busyDisabledState === "disabled";
    delete control.dataset.busyDisabledState;
  });
}

async function confirmRemoveLogo() {
  if (!state.branding?.logo || state.busy) return;
  const confirmed = await showConfirm({
    eyebrow: "Remove logo",
    title: "Use the default FRAME logo?",
    copy: "Your custom gallery logo will be removed.",
    actionLabel: "Remove logo",
    danger: true,
  });
  if (confirmed) await removeLogo();
}

function showConfirm({ eyebrow, title, copy, actionLabel, danger = true, imageUrl = "", imageAlt = "" }) {
  return new Promise((resolve) => {
    if (state.confirmResolve) resolveConfirm(false);
    state.confirmResolve = resolve;
    elements.confirm_eyebrow.textContent = eyebrow || "Confirm change";
    elements.confirm_title.textContent = title || "Continue?";
    elements.confirm_copy.textContent = copy || "";
    elements.confirm_media.hidden = !imageUrl;
    elements.confirm_dialog.classList.toggle("has-media", Boolean(imageUrl));
    elements.confirm_image.src = imageUrl || "";
    elements.confirm_image.alt = imageAlt || "";
    elements.confirm_accept.textContent = actionLabel || "Continue";
    elements.confirm_accept.className = danger ? "danger-button" : "restore-button";
    elements.confirm_dialog.showModal();
  });
}

function resolveConfirm(confirmed) {
  if (!state.confirmResolve) return;
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  if (elements.confirm_dialog.open) elements.confirm_dialog.close();
  elements.confirm_dialog.classList.remove("has-media");
  elements.confirm_media.hidden = true;
  elements.confirm_image.removeAttribute("src");
  resolve(confirmed);
}

function confirmTitleForAction(action) {
  return ({
    "trash-photo": "Move photo to trash?",
    "restore-photo": "Restore photo?",
    "purge-photo": "Delete published copy?",
    "trash-album": "Move album to trash?",
    "restore-album": "Restore album?",
    "purge-album": "Delete published copies?",
    "empty-trash": "Empty trash?",
  })[action] || "Apply this change?";
}

function confirmActionLabel(action) {
  return ({
    "trash-photo": "Move to trash",
    "restore-photo": "Restore",
    "purge-photo": "Delete copy",
    "trash-album": "Move album",
    "restore-album": "Restore album",
    "purge-album": "Delete copies",
    "empty-trash": "Empty trash",
  })[action] || "Continue";
}

function renderEmpty() {
  elements.empty.hidden = state.section !== "content"
    || (state.contentView === "published" ? state.dates.length > 0 : state.trash.length > 0);
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

function buildThemeProfileClient(id, name, themeColor) {
  const color = normalizeHex(themeColor, "#2cb4fb");
  return {
    id,
    name: cleanText(name, "Custom Preset"),
    theme_color: color,
    palettes: {
      day: buildPalette(color, "day"),
      night: buildPalette(color, "night"),
    },
  };
}

function buildPalette(themeColor, mode) {
  const base = hexToHsl(themeColor);
  const vivid = clamp(base.s + 14, 58, 86);
  if (mode === "day") {
    return {
      background: hslToHex(base.h, 30, 97),
      topbar: hslToHex(base.h, 30, 99),
      text: hslToHex(base.h, 32, 13),
      controlText: hslToHex(base.h, 32, 13),
      accent: hslToHex(base.h, vivid, 38),
      secondary: hslToHex(base.h + 180, Math.min(vivid, 78), 41),
      surface: "#ffffff",
      surfaceStrong: hslToHex(base.h, 34, 92),
      border: hslToHex(base.h, 24, 76),
      muted: hslToHex(base.h, 16, 38),
      danger: hslToHex(350, 70, 40),
      good: hslToHex(145, 46, 34),
      lightboxBackground: "#05070a",
      lightboxText: "#f5fbff",
    };
  }
  return {
    background: hslToHex(base.h, 36, 8),
    topbar: hslToHex(base.h, 36, 10),
    text: hslToHex(base.h, 28, 94),
    controlText: hslToHex(base.h, 28, 94),
    accent: hslToHex(base.h, vivid, 62),
    secondary: hslToHex(base.h + 180, Math.min(vivid, 78), 64),
    surface: hslToHex(base.h, 34, 13),
    surfaceStrong: hslToHex(base.h, 32, 18),
    border: hslToHex(base.h, 30, 28),
    muted: hslToHex(base.h, 19, 72),
    danger: hslToHex(350, 78, 70),
    good: hslToHex(145, 60, 70),
    lightboxBackground: "#02080c",
    lightboxText: "#e9f8ff",
  };
}

function cleanText(value, fallback) {
  const cleaned = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 40);
}

function normalizeHex(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "").trim()) ? String(value).trim().toLowerCase() : fallback;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function hexToHsl(hex) {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness * 100 };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: hue * 60, s: saturation * 100, l: lightness * 100 };
}

function hslToHex(hue, saturation, lightness) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  if (s === 0) return rgbToHex(l, l, l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex(hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3));
}

function hueToRgb(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((channel) => Math.round(clamp(channel, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
