import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");

// Run the actual DOM-facing functions with only the controls they read and write.
function control() {
  return {
    attributes: {}, dataset: {}, listeners: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll(selector) { return this.children.map((child) => child.querySelector(selector)); },
    focus() { this.focused = true; },
    scrollIntoView() {},
  };
}

function functions(names, scope, extra = "") {
  const declarations = names.map((name) => {
    const match = script.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, `Missing admin function ${name}`);
    return match[0];
  }).join("\n");
  return Function(...Object.keys(scope), `${declarations}\n${extra}\nreturn { ${names.join(", ")} };`)(...Object.values(scope));
}

function albumControls() {
  const elements = Object.fromEntries([
    "albums", "album_detail", "album_title", "album_summary", "album_settings", "published_tab", "view_gallery", "manage_explore",
    "cover_action", "photo_sort", "photos", "previous_gallery", "next_gallery", "photo_selection_count", "select_all_photos",
    "move_selected", "trash_selected", "clear_selection", "empty",
  ].map((name) => [name, control()]));
  const card = () => {
    const parts = new Map();
    return { ...control(), querySelector(selector) { if (!parts.has(selector)) parts.set(selector, control()); return parts.get(selector); } };
  };
  const templates = Object.fromEntries(["album", "photo"].map((name) => [name, { content: { firstElementChild: { cloneNode: card } } }]));
  return { elements, templates };
}

test("admin tabs keep settings nested and preserve unsaved changes when navigation is cancelled", async () => {
  const elements = Object.fromEntries([
    "published_tab", "published_view", "trash_tab", "trash_view", "site_settings_tab", "site_settings_view",
    "gallery_styling_tab", "gallery_styling_view", "socials_tab", "socials_view", "support_tab", "support_view", "empty",
  ].map((name) => [name, control()]));
  const state = { section: "published", settingsSection: "style", dates: [{}], trash: [], albumLoadId: 0, busy: false, settingsDirty: false };
  let discardConfirmed = false;
  const api = functions([
    "setSection", "setSettingsSection", "requestSectionChange", "requestSettingsSectionChange", "canLeaveSettings", "handleSectionTabKeydown", "renderEmpty",
  ], {
    state, elements,
    confirmDiscardSettings: async () => discardConfirmed,
    discardBrandingChanges: () => { state.settingsDirty = false; },
  }, script.slice(script.indexOf("const sections = ["), script.indexOf("const systemTheme =")));

  api.setSection("published");
  assert.equal(elements.published_view.hidden, false);
  assert.equal(elements.trash_view.hidden, true);
  assert.equal(elements.site_settings_view.hidden, true);
  assert.equal(elements.published_tab.attributes["aria-selected"], "true");
  assert.equal(elements.published_tab.tabIndex, 0);
  await api.requestSectionChange("trash");
  assert.equal(elements.trash_view.hidden, false);
  assert.equal(elements.published_view.hidden, true);
  assert.equal(elements.empty.hidden, false);
  await api.requestSectionChange("settings");
  assert.equal(elements.site_settings_view.hidden, false);
  assert.equal(elements.trash_view.hidden, true);
  assert.equal(elements.empty.hidden, true);
  for (const [name, view] of [["style", "gallery_styling_view"], ["socials", "socials_view"], ["support", "support_view"]]) {
    await api.requestSettingsSectionChange(name);
    assert.equal(state.section, "settings");
    assert.equal(elements[view].hidden, false);
    assert.equal([elements.gallery_styling_view, elements.socials_view, elements.support_view].filter((item) => !item.hidden).length, 1);
  }
  state.settingsDirty = true;
  await api.requestSectionChange("published");
  assert.equal(state.section, "settings");
  assert.equal(state.settingsDirty, true);
  await api.requestSettingsSectionChange("style");
  assert.equal(state.settingsSection, "support");
  discardConfirmed = true;
  await api.requestSettingsSectionChange("style");
  assert.equal(state.settingsDirty, false);
  assert.equal(state.settingsSection, "style");
  state.busy = true;
  await api.requestSectionChange("published");
  assert.equal(state.section, "settings");
  for (const tabs of [
    [elements.published_tab, elements.trash_tab, elements.site_settings_tab],
    [elements.gallery_styling_tab, elements.socials_tab, elements.support_tab],
  ]) {
    let clicked;
    let prevented = 0;
    tabs.forEach((tab) => {
      tab.click = () => { clicked = tab; };
      tab.closest = () => ({ querySelectorAll: () => tabs });
    });
    api.handleSectionTabKeydown({ key: "ArrowRight", currentTarget: tabs.at(-1), preventDefault() { prevented += 1; } });
    assert.equal(clicked, tabs[0], "arrow navigation must wrap within its own tab group");
    api.handleSectionTabKeydown({ key: "ArrowLeft", currentTarget: tabs[0], preventDefault() { prevented += 1; } });
    assert.equal(clicked, tabs.at(-1));
    assert.equal(prevented, 2);
  }
});

test("album navigation uses existing dates, clears selection and URL on back, and labels photo timestamps", async () => {
  const { elements, templates } = albumControls();
  const state = {
    dates: ["2026-09-05", "2026-08-30", "2026-09-03"].map((date_folder) => ({ date_folder, count: 2 })),
    photos: [], selectedPhotos: new Set(), selectedDate: null, gallerySettings: null, albumLoadId: 0, section: "published", busy: false,
  };
  const photos = [
    { base: "with_capture", processed_at: "2026-09-05T05:01:00.000Z", capture_clock: "2026-09-04T23:58:12.000" },
    { base: "without_capture", processed_at: "2026-09-05T05:02:00.000Z" },
  ];
  let pendingAlbum;
  const statuses = [];
  const scrolls = [];
  const focusFrames = [];
  const location = new URL("http://preview.local/gallery/admin?keep=yes");
  const selectionHandlers = script.slice(script.indexOf("elements.select_all_photos.addEventListener"), script.indexOf("elements.move_gallery.addEventListener"));
  const api = functions([
    "openAlbum", "backToGalleries", "renderAlbums", "updateAlbumNavigation", "updatePhotoSelection", "renderEmpty",
    "formatDate", "formatTime", "friendlyBase", "photoLabel", "durationLabel",
  ], {
    state, elements, templates, location,
    requestAnimationFrame(callback) { focusFrames.push(callback); return focusFrames.length; },
    window: { scrollTo(options) { scrolls.push(options); } },
    history: { replaceState(_state, _unused, url) { location.href = String(url); } },
    loadSelectedAlbum: async () => pendingAlbum || { photos, settings: { photo_sort: "newest" } },
    setStatus(...status) { statuses.push(status); }, setPhotoSortStatus() {}, renderCoverManagementStatus() {}, openMoveDialog() {}, trashSelectedPhotos() {}, scheduleAlbumGalleryLayout() {},
  }, selectionHandlers);

  api.renderAlbums();
  const initialAlbumCard = elements.albums.children[0];
  assert.equal(elements.albums.hidden, false);
  assert.equal(elements.album_detail.hidden, true);
  await api.openAlbum("2026-09-03");
  assert.equal(elements.albums.children[0], initialAlbumCard, "opening an album must preserve loaded cover elements");
  assert.deepEqual(statuses.at(-1), ["Ready", "ready"]);
  assert.equal(scrolls.at(-1).top, 0);
  assert.equal(elements.albums.hidden, true);
  assert.equal(elements.album_detail.hidden, false);
  assert.equal(location.searchParams.get("date"), "2026-09-03");
  assert.equal(elements.view_gallery.href, "/today/gallery/2026-09-03");
  assert.equal(elements.previous_gallery.dataset.date, "2026-08-30");
  assert.equal(elements.next_gallery.dataset.date, "2026-09-05");
  const [captured, missing] = elements.photos.children;
  assert.match(captured.querySelector("small").textContent, /^Processed /);
  assert.equal(captured.querySelector(".photo-captured").textContent, "2026-09-04 23:58:12.000");
  assert.equal(missing.querySelector(".photo-captured").textContent, "Not available");
  assert.equal(captured.querySelector(".photo-filename").textContent, "with_capture.jpg");
  assert.ok(captured.querySelector(".photo-processed").textContent);
  elements.select_all_photos.checked = true;
  elements.select_all_photos.listeners.change();
  assert.equal(elements.photo_selection_count.textContent, "2 selected");
  assert.equal(elements.move_selected.textContent, "Move 2 photos…");
  assert.equal(elements.trash_selected.disabled, false);
  assert.equal(elements.clear_selection.disabled, false);
  elements.clear_selection.listeners.click();
  assert.equal(elements.photo_selection_count.textContent, "0 selected");
  assert.equal(elements.move_selected.disabled, true);
  assert.equal(elements.trash_selected.disabled, true);
  assert.equal(elements.clear_selection.disabled, true);
  assert.ok(elements.photos.querySelectorAll(".select-photo").every((item) => !item.checked));

  await api.openAlbum("2026-08-30");
  assert.deepEqual(statuses.at(-1), ["Ready", "ready"]);
  assert.equal(elements.previous_gallery.disabled, true);
  assert.equal(elements.next_gallery.dataset.date, "2026-09-03");
  await api.openAlbum("2026-09-05");
  assert.deepEqual(statuses.at(-1), ["Ready", "ready"]);
  assert.equal(elements.next_gallery.disabled, true);
  state.busy = true;
  api.updateAlbumNavigation();
  api.backToGalleries();
  assert.equal(elements.previous_gallery.disabled, true);
  assert.equal(state.selectedDate, "2026-09-05");
  state.busy = false;
  let finishLoad;
  pendingAlbum = new Promise((resolve) => { finishLoad = resolve; });
  const loading = api.openAlbum("2026-09-03");
  api.backToGalleries();
  assert.equal(state.selectedDate, null);
  assert.equal(state.photos.length, 0);
  assert.equal(state.selectedPhotos.size, 0);
  assert.equal(elements.albums.hidden, false);
  assert.equal(elements.album_detail.hidden, true);
  assert.equal(location.searchParams.has("date"), false);
  assert.equal(location.searchParams.get("keep"), "yes");
  assert.equal(elements.albums.children[0], initialAlbumCard, "returning to galleries must preserve loaded cover elements");
  const previousCard = elements.albums.querySelectorAll(".album-open").find((item) => item.dataset.date === "2026-09-05");
  assert.equal(previousCard.focused, undefined, "back focus must wait until scheduled cover layout can run");
  focusFrames.shift()();
  assert.equal(previousCard.focused, true);
  finishLoad({ photos, settings: {} });
  await loading;
  assert.equal(state.selectedDate, null, "back navigation must cancel a pending album load");
  assert.equal(elements.album_detail.hidden, true);
  assert.ok(statuses.every(([, kind]) => kind !== "error"));
  state.dates = [...state.dates];
  api.renderAlbums();
  assert.notEqual(elements.albums.children[0], initialAlbumCard, "a fresh dates response must rebuild gallery cards");
});

test("trash selected snapshots one confirmation and request, guards duplicate work, and reconciles selection after success or failure", async () => {
  const { elements, templates } = albumControls();
  const date = "2026-09-05";
  const photos = ["selected_one", "selected_two", "unselected"].map((base) => ({ base, processed_at: `${date}T05:01:00.000Z` }));
  const state = { dates: [{ date_folder: date, count: photos.length }], photos, selectedDate: date, selectedPhotos: new Set(), albumLoadId: 0, busy: false };
  const confirmations = [];
  const requests = [];
  const statuses = [];
  const disabled = [];
  const refreshes = [];
  let finishConfirmation;
  let finishRequest;
  let requestError;
  let refreshError;
  let freshPhotos = [photos[2]];
  const location = new URL(`http://preview.local/gallery/admin?date=${date}`);
  const api = functions([
    "trashSelectedPhotos", "manage", "refreshAfterManagement", "renderAlbums", "updateAlbumNavigation", "updatePhotoSelection",
    "confirmTitleForAction", "confirmActionLabel", "actionLabel", "formatDate", "formatTime", "friendlyBase", "photoLabel", "durationLabel",
  ], {
    state, elements, templates, location,
    history: { replaceState(_state, _unused, url) { location.href = String(url); } },
    showConfirm(options) { confirmations.push(options); return new Promise((resolve) => { finishConfirmation = resolve; }); },
    setStatus(...status) { statuses.push(status); },
    setControlsDisabled(value) { disabled.push(value); api.updatePhotoSelection(); },
    requestJson(url, options) {
      if (options?.method === "POST") {
        requests.push({ url, ...options, body: JSON.parse(options.body) });
        if (requestError) return Promise.reject(requestError);
        return new Promise((resolve) => { finishRequest = resolve; });
      }
      refreshes.push(url);
      if (refreshError) return Promise.reject(refreshError);
      if (url === "/gallery/api/dates") return { dates: freshPhotos.length ? [{ date_folder: date, count: freshPhotos.length }] : [] };
      if (url === "/gallery/admin/api/trash") return { trash: photos.filter((photo) => !freshPhotos.includes(photo)) };
      assert.fail(`Unexpected request ${url}`);
    },
    loadSelectedAlbum: async () => ({ photos: freshPhotos, settings: {} }),
    render() { api.renderAlbums(); },
    renderCoverManagementStatus() {}, scheduleAlbumGalleryLayout() {},
  });

  await api.trashSelectedPhotos();
  assert.equal(confirmations.length, 0, "empty selection must not open a confirmation");
  state.selectedPhotos = new Set([photos[0].base, photos[1].base]);
  state.busy = true;
  api.updatePhotoSelection();
  await api.trashSelectedPhotos();
  assert.equal(elements.trash_selected.disabled, true);
  state.busy = false;
  state.selectedDate = null;
  await api.trashSelectedPhotos();
  assert.equal(confirmations.length, 0, "busy state or no active date must prevent work");
  state.selectedDate = date;
  state.selectedPhotos = new Set(Array.from({ length: 1001 }, (_, index) => `photo_${index}`));
  await api.trashSelectedPhotos();
  assert.equal(confirmations.length, 0);
  assert.match(statuses.at(-1)[0], /1000/);
  state.selectedPhotos = new Set([photos[0].base, photos[1].base]);

  const cancelled = api.trashSelectedPhotos();
  assert.equal(confirmations.length, 1);
  assert.equal(state.albumLoadId, 1, "opening confirmation must invalidate an earlier album load");
  assert.match(confirmations[0].copy, /2 photos/);
  assert.match(confirmations[0].copy, /restore.*Trash tab/);
  finishConfirmation(false);
  await cancelled;
  assert.equal(requests.length, 0);
  assert.deepEqual([...state.selectedPhotos], [photos[0].base, photos[1].base]);
  assert.equal(disabled.length, 0);

  const interrupted = api.trashSelectedPhotos();
  state.busy = true;
  finishConfirmation(true);
  await interrupted;
  assert.equal(requests.length, 0, "a competing operation accepted during confirmation must prevent another request");
  state.busy = false;

  const accepted = api.trashSelectedPhotos();
  assert.equal(confirmations.length, 3);
  state.selectedPhotos = new Set([photos[0].base]);
  state.selectedDate = "2026-09-03";
  finishConfirmation(true);
  await Promise.resolve();
  assert.equal(state.busy, true);
  assert.equal(elements.trash_selected.disabled, true);
  assert.equal(elements.trash_selected.textContent, "Moving to Trash…");
  await api.trashSelectedPhotos();
  assert.equal(confirmations.length, 3, "a running batch must not open a second confirmation");
  assert.deepEqual(requests, [{
    url: "/gallery/admin/api/manage", method: "POST", headers: { "content-type": "application/json" },
    body: { action: "trash-photos", date_folder: date, base: null, bases: [photos[0].base, photos[1].base] },
  }]);
  state.selectedDate = date;
  finishRequest({ affected: 2 });
  await accepted;
  assert.deepEqual(refreshes, ["/gallery/api/dates", "/gallery/admin/api/trash"]);
  assert.deepEqual(state.photos, [photos[2]]);
  assert.equal(state.selectedPhotos.size, 0);
  assert.equal(elements.photo_selection_count.textContent, "0 selected");
  assert.equal(elements.trash_selected.disabled, true);
  assert.equal(elements.trash_selected.textContent, "Trash selected");
  assert.equal(state.busy, false);
  assert.deepEqual(disabled, [true, false]);
  assert.equal(statuses.at(-1)[1], "ready");
  assert.match(statuses.at(-1)[0], /2 photos/);
  assert.equal(elements.select_all_photos.focused, true);

  state.photos = photos;
  state.selectedPhotos = new Set([photos[0].base, photos[1].base]);
  freshPhotos = [photos[1], photos[2]];
  requestError = new Error("Batch could not finish");
  const partiallyFailed = api.trashSelectedPhotos();
  finishConfirmation(true);
  await partiallyFailed;
  assert.deepEqual([...state.selectedPhotos], [photos[1].base], "a fresh album must retain only selected photos that remain published");
  assert.equal(elements.photo_selection_count.textContent, "1 selected");
  assert.equal(elements.trash_selected.disabled, false);
  assert.deepEqual(statuses.at(-1), [requestError.message, "error"]);
  assert.equal(state.busy, false);
  assert.equal(elements.trash_selected.textContent, "Trash selected");

  refreshError = new Error("Refresh unavailable");
  const disconnected = api.trashSelectedPhotos();
  finishConfirmation(true);
  await disconnected;
  assert.deepEqual([...state.selectedPhotos], [photos[1].base], "failed recovery must keep the selection available for retry");
  assert.deepEqual(statuses.at(-1), [requestError.message, "error"], "recovery failure must not hide the management error");
  assert.equal(state.busy, false);
  assert.equal(requests.length, 3);
});
