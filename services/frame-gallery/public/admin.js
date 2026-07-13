const elements = Object.fromEntries([
  "summary", "status", "content-management-tab", "gallery-styling-tab", "published-tab",
  "trash-tab", "published-count", "trash-count", "content-management-view", "gallery-styling-view",
  "published-view", "trash-view", "albums", "album-detail", "album-title", "album-summary", "manage-explore", "trash-album",
  "photos", "trash-albums", "empty-trash", "empty", "branding-summary", "save-branding", "branding-form",
  "brand-name-input", "gallery-title-input", "default-mode", "preset-trigger", "preset-trigger-swatches",
  "preset-trigger-name", "preset-trigger-meta", "preset-menu", "new-preset", "logo-preview", "logo-input",
  "remove-logo", "admin-brand-logo", "admin-brand-name", "preset-dialog", "preset-kind-step",
  "preset-editor-step", "color-theme-choice", "full-custom-choice", "cancel-preset-kind",
  "preset-editor-eyebrow", "preset-editor-title", "preset-name-input", "preset-default-mode",
  "preset-theme-color-label", "preset-theme-color", "palette-fields", "back-preset-kind",
  "cancel-preset-editor", "save-preset", "confirm-dialog", "confirm-eyebrow", "confirm-title",
  "confirm-copy", "confirm-cancel", "confirm-accept", "admin-theme-toggle", "logo-crop-dialog",
  "logo-crop-stage", "logo-crop-image", "logo-crop-frame", "logo-ratio-x", "logo-ratio-y",
  "logo-crop-zoom", "logo-crop-preview",
  "cancel-logo-crop", "save-logo-crop",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

const templates = {
  album: document.getElementById("album-template"),
  photo: document.getElementById("photo-template"),
  trashAlbum: document.getElementById("trash-album-template"),
  trashPhoto: document.getElementById("trash-photo-template"),
};
const paletteFields = [
  ["background", "Background"],
  ["topbar", "Header"],
  ["text", "Text"],
  ["controlText", "Control text"],
  ["accent", "Primary"],
  ["secondary", "Secondary"],
  ["surface", "Surface"],
  ["surfaceStrong", "Raised surface"],
  ["border", "Border"],
  ["muted", "Muted text"],
  ["danger", "Danger"],
  ["good", "Success"],
  ["lightboxBackground", "Lightbox background"],
  ["lightboxText", "Lightbox text"],
];
const state = {
  dates: [],
  photos: [],
  trash: [],
  selectedDate: new URLSearchParams(location.search).get("date"),
  section: "content",
  contentView: "published",
  busy: false,
  branding: null,
  selectedProfileId: null,
  presetDraftKind: "color",
  confirmResolve: null,
  userThemeMode: readStoredTheme(),
  appliedThemeMode: null,
  logoCrop: null,
};
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const icons = {
  moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.1A8.4 8.4 0 0 1 8.9 3.6 8.5 8.5 0 1 0 20.4 15.1Z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/></svg>`,
};
const LOGO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const LOGO_EXPORT_BOX = { width: 720, height: 240 };
const LOGO_EXPORT_QUALITY = 0.9;
const LOGO_ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const LOGO_ASPECTS = { wide: 2, square: 1 };
const LOGO_FRAME_MIN_SIZE = 64;
const LOGO_EDGE_SNAP_PX = 12;

elements.content_management_tab.addEventListener("click", () => setSection("content"));
elements.gallery_styling_tab.addEventListener("click", () => setSection("style"));
elements.admin_theme_toggle.addEventListener("click", toggleAdminTheme);
elements.published_tab.addEventListener("click", () => setContentView("published"));
elements.trash_tab.addEventListener("click", () => setContentView("trash"));
elements.trash_album.addEventListener("click", () => manage("trash-album", state.selectedDate, null, `Move every photo from ${state.selectedDate} to trash?`));
elements.empty_trash.addEventListener("click", () => manage("empty-trash", null, null, "Permanently delete every trashed published gallery copy and its .ready receipt? Queued StreamerBot actions will no longer be able to read those published paths. Archived sources follow the separate retention policy."));
elements.save_branding.addEventListener("click", () => saveBranding());
elements.preset_trigger.addEventListener("click", togglePresetMenu);
elements.new_preset.addEventListener("click", openPresetDialog);
elements.logo_input.addEventListener("change", uploadLogo);
elements.remove_logo.addEventListener("click", removeLogo);
elements.cancel_logo_crop.addEventListener("click", closeLogoCropDialog);
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
elements.color_theme_choice.addEventListener("click", () => showPresetEditor("color"));
elements.full_custom_choice.addEventListener("click", () => showPresetEditor("full"));
elements.cancel_preset_kind.addEventListener("click", closePresetDialog);
elements.back_preset_kind.addEventListener("click", showPresetKindStep);
elements.cancel_preset_editor.addEventListener("click", closePresetDialog);
elements.save_preset.addEventListener("click", createCustomPreset);
elements.confirm_cancel.addEventListener("click", () => resolveConfirm(false));
elements.confirm_accept.addEventListener("click", () => resolveConfirm(true));
elements.confirm_dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveConfirm(false);
});
elements.preset_theme_color.addEventListener("input", () => {
  if (state.presetDraftKind === "full") renderPaletteFields(buildThemeProfileClient("draft", "Draft", elements.preset_theme_color.value).palettes);
});
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
document.addEventListener("click", (event) => {
  if (!elements.preset_trigger.contains(event.target) && !elements.preset_menu.contains(event.target)) closePresetMenu();
});

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
  const contentSelected = section === "content";
  elements.content_management_tab.setAttribute("aria-selected", String(contentSelected));
  elements.gallery_styling_tab.setAttribute("aria-selected", String(!contentSelected));
  elements.content_management_tab.tabIndex = contentSelected ? 0 : -1;
  elements.gallery_styling_tab.tabIndex = contentSelected ? -1 : 0;
  elements.content_management_view.hidden = !contentSelected;
  elements.gallery_styling_view.hidden = contentSelected;
  renderEmpty();
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

function renderBranding() {
  const branding = state.branding;
  if (!branding) return;
  elements.branding_summary.textContent = `${branding.brand_name} ${branding.gallery_title} - ${selectedProfile().name}`;
  elements.brand_name_input.value = branding.brand_name;
  elements.gallery_title_input.value = branding.gallery_title;
  elements.default_mode.value = branding.mode === "day" || branding.mode === "night" ? branding.mode : "night";
  elements.logo_preview.src = branding.logo?.url || "/gallery/assets/frame-logo-square.svg";
  elements.logo_preview.alt = branding.logo ? `${branding.brand_name} logo` : "";
  elements.remove_logo.hidden = !branding.logo;
  renderPresetDropdown();
  applyAdminBranding();
}

function renderPresetDropdown() {
  const profile = selectedProfile();
  elements.preset_trigger_name.textContent = profile.name;
  elements.preset_trigger_meta.textContent = profile.theme_color;
  elements.preset_trigger.dataset.defaultProfile = String(profile.id === "frame-blue");
  elements.preset_trigger_swatches.replaceChildren(...swatchElementsFor(profile));
  elements.preset_menu.replaceChildren(...orderedProfiles().map((item) => {
    const row = document.createElement("div");
    row.className = "preset-option-row";
    row.dataset.customProfile = String(isCustomProfile(item));

    const option = document.createElement("button");
    option.type = "button";
    option.className = "preset-option preset-option-main";
    option.role = "option";
    option.dataset.defaultProfile = String(item.id === "frame-blue");
    option.setAttribute("aria-selected", String(item.id === state.selectedProfileId));
    option.append(swatchGroupFor(item), optionCopy(item));
    option.addEventListener("click", () => selectProfile(item.id));

    row.append(option);
    if (isCustomProfile(item)) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "preset-delete";
      deleteButton.title = `Delete ${item.name}`;
      deleteButton.setAttribute("aria-label", `Delete ${item.name}`);
      deleteButton.append(trashIcon());
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteCustomPreset(item.id);
      });
      row.append(deleteButton);
    }
    return row;
  }));
}

function selectProfile(id) {
  state.selectedProfileId = id;
  renderPresetDropdown();
  closePresetMenu();
  applyAdminBranding();
}

function togglePresetMenu() {
  const open = elements.preset_menu.hidden;
  elements.preset_menu.hidden = !open;
  elements.preset_trigger.setAttribute("aria-expanded", String(open));
}

function closePresetMenu() {
  elements.preset_menu.hidden = true;
  elements.preset_trigger.setAttribute("aria-expanded", "false");
}

async function deleteCustomPreset(profileId) {
  if (state.busy || !state.branding) return;
  const profile = profiles().find((item) => item.id === profileId);
  if (!isCustomProfile(profile)) return;
  const confirmed = await showConfirm({
    eyebrow: "Delete preset",
    title: `Delete ${profile.name}?`,
    copy: "This custom preset will be removed from the list. The gallery will switch back to Frame Blue after deletion.",
    actionLabel: "Delete preset",
    danger: true,
  });
  if (!confirmed) return;
  closePresetMenu();
  state.selectedProfileId = "frame-blue";
  await saveBranding({
    profile_id: "frame-blue",
    custom_profiles: customProfiles().filter((item) => item.id !== profile.id),
  });
}

async function saveBranding(overrides = {}) {
  if (state.busy || !state.branding) return;
  const payload = brandingPayload(overrides);
  state.busy = true;
  setControlsDisabled(true);
  setStatus("Saving style", "working");
  try {
    const result = await requestJson("/gallery/admin/api/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.branding = result.branding;
    state.selectedProfileId = state.branding.profile_id;
    renderBranding();
    setStatus("Style saved", "ready");
  } catch (error) {
    setStatus(error.message || "Style save failed", "error");
  } finally {
    state.busy = false;
    setControlsDisabled(false);
  }
}

function brandingPayload(overrides = {}) {
  return {
    brand_name: elements.brand_name_input.value,
    gallery_title: elements.gallery_title_input.value,
    mode: elements.default_mode.value,
    profile_id: state.selectedProfileId || state.branding?.profile_id || "frame-blue",
    custom_profiles: customProfiles(),
    ...overrides,
  };
}

function openPresetDialog() {
  showPresetKindStep();
  elements.preset_dialog.showModal();
}

function closePresetDialog() {
  elements.preset_dialog.close();
}

function showPresetKindStep() {
  elements.preset_kind_step.hidden = false;
  elements.preset_editor_step.hidden = true;
}

function showPresetEditor(kind) {
  state.presetDraftKind = kind;
  elements.preset_kind_step.hidden = true;
  elements.preset_editor_step.hidden = false;
  elements.preset_editor_title.textContent = kind === "full" ? "Fully custom" : "Color based theme";
  elements.preset_editor_eyebrow.textContent = "New custom preset";
  elements.preset_name_input.value = "";
  elements.preset_default_mode.value = elements.default_mode.value === "day" ? "day" : "night";
  elements.preset_theme_color.value = selectedProfile().theme_color || "#2cb4fb";
  elements.preset_theme_color_label.hidden = false;
  elements.palette_fields.hidden = kind !== "full";
  if (kind === "full") renderPaletteFields(buildThemeProfileClient("draft", "Draft", elements.preset_theme_color.value).palettes);
}

function renderPaletteFields(palettes) {
  elements.palette_fields.replaceChildren(...["day", "night"].map((mode) => {
    const group = document.createElement("section");
    group.className = "palette-group";
    const heading = document.createElement("h3");
    heading.textContent = mode === "day" ? "Day colors" : "Night colors";
    const grid = document.createElement("div");
    grid.className = "color-grid";
    for (const [key, labelText] of paletteFields) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = "color";
      input.dataset.mode = mode;
      input.dataset.key = key;
      input.value = palettes[mode][key];
      label.append(input);
      grid.append(label);
    }
    group.append(heading, grid);
    return group;
  }));
}

async function createCustomPreset() {
  if (!state.branding) return;
  const name = cleanText(elements.preset_name_input.value, "Custom Preset");
  const id = uniqueClientProfileId(name);
  const profile = state.presetDraftKind === "full"
    ? {
        id,
        name,
        theme_color: colorInput("day", "accent") || elements.preset_theme_color.value,
        palettes: collectPaletteFields(),
      }
    : buildThemeProfileClient(id, name, elements.preset_theme_color.value);
  state.selectedProfileId = profile.id;
  elements.default_mode.value = elements.preset_default_mode.value;
  closePresetDialog();
  await saveBranding({
    mode: elements.preset_default_mode.value,
    profile_id: profile.id,
    custom_profiles: [...customProfiles().filter((item) => item.id !== profile.id), profile],
  });
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

async function openLogoCropDialog(file) {
  if (file.size > LOGO_SOURCE_MAX_BYTES) {
    throw new Error("Logo source must be 20 MB or smaller");
  }
  const imageUrl = URL.createObjectURL(file);
  await loadCropImage(imageUrl);
  const sourceWidth = elements.logo_crop_image.naturalWidth;
  const sourceHeight = elements.logo_crop_image.naturalHeight;
  state.logoCrop = {
    fileName: file.name,
    imageUrl,
    sourceWidth,
    sourceHeight,
    aspect: "full",
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
  syncLogoCropAspectControls();
  setStatus("Prepare logo", "working");
  elements.logo_crop_dialog.showModal();
  requestAnimationFrame(() => {
    setLogoCropAspect("full", { resetView: false });
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
  cleanupLogoCrop();
  if (elements.logo_crop_dialog.open) elements.logo_crop_dialog.close();
  setStatus("Logo upload cancelled", "ready");
}

async function saveLogoCrop() {
  if (!state.logoCrop || state.busy) return;
  state.busy = true;
  setControlsDisabled(true);
  setStatus("Processing logo", "working");
  try {
    const dataUrl = await renderCroppedLogoDataUrl();
    setStatus("Uploading optimized logo", "working");
    const result = await requestJson("/gallery/admin/api/branding/logo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_url: dataUrl }),
    });
    state.branding = result.branding;
    state.selectedProfileId = state.branding.profile_id;
    renderBranding();
    cleanupLogoCrop();
    if (elements.logo_crop_dialog.open) elements.logo_crop_dialog.close();
    setStatus("Logo saved", "ready");
  } catch (error) {
    setStatus(error.message || "Logo upload failed", "error");
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
  const nextAspect = ["full", "wide", "square", "custom", "freeform"].includes(aspect) ? aspect : "full";
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
  const output = outputSizeForAspect(aspect);
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
  if (elements.default_mode.value === "day" || elements.default_mode.value === "night") return elements.default_mode.value;
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

function customProfiles() {
  return state.branding?.custom_profiles || profiles().filter((profile) => profile.id.startsWith("custom-"));
}

function orderedProfiles() {
  const customIds = new Set(customProfiles().map((profile) => profile.id));
  const isCustom = (profile) => customIds.has(profile.id) || profile.id.startsWith("custom-");
  return [
    ...profiles().filter(isCustom),
    ...profiles().filter((profile) => !isCustom(profile)),
  ];
}

function isCustomProfile(profile) {
  if (!profile) return false;
  return profile.id.startsWith("custom-") || customProfiles().some((item) => item.id === profile.id);
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

function swatchGroupFor(profile) {
  const swatches = document.createElement("span");
  swatches.className = "swatches";
  swatches.append(...swatchElementsFor(profile));
  return swatches;
}

function swatchElementsFor(profile) {
  return [profile.theme_color, profile.palettes.day.secondary, profile.palettes.night.background].map((color) => {
    const swatch = document.createElement("i");
    swatch.style.background = color;
    return swatch;
  });
}

function optionCopy(profile) {
  const copy = document.createElement("span");
  copy.className = "preset-copy";
  const title = document.createElement("strong");
  const meta = document.createElement("small");
  title.textContent = profile.name;
  meta.textContent = profile.theme_color;
  copy.append(title, meta);
  return copy;
}

function trashIcon() {
  const icon = document.createElement("span");
  icon.className = "trash-icon";
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function collectPaletteFields() {
  const generated = buildThemeProfileClient("draft", "Draft", elements.preset_theme_color.value).palettes;
  for (const input of elements.palette_fields.querySelectorAll("input[type='color']")) {
    generated[input.dataset.mode][input.dataset.key] = input.value;
  }
  return generated;
}

function colorInput(mode, key) {
  return elements.palette_fields.querySelector(`input[data-mode="${mode}"][data-key="${key}"]`)?.value || "";
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button, input, select").forEach((control) => { control.disabled = disabled; });
}

function showConfirm({ eyebrow, title, copy, actionLabel, danger = true }) {
  return new Promise((resolve) => {
    if (state.confirmResolve) resolveConfirm(false);
    state.confirmResolve = resolve;
    elements.confirm_eyebrow.textContent = eyebrow || "Confirm change";
    elements.confirm_title.textContent = title || "Continue?";
    elements.confirm_copy.textContent = copy || "";
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

function uniqueClientProfileId(name) {
  const base = `custom-${slug(name) || "preset"}`;
  const suffix = Date.now().toString(36).slice(-5);
  let candidate = `${base}-${suffix}`;
  let counter = 2;
  while (profiles().some((profile) => profile.id === candidate)) {
    candidate = `${base}-${suffix}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function cleanText(value, fallback) {
  const cleaned = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 40);
}

function normalizeHex(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "").trim()) ? String(value).trim().toLowerCase() : fallback;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34);
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
