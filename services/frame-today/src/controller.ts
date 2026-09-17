import { EventEmitter } from "node:events";
import type { LatestPublication, TodayPhoto, TodayStore } from "./store.js";

export type TodayCommand =
  | { type: "NEXT" | "PREV" | "PLAY_SLIDESHOW" | "PAUSE_SLIDESHOW" | "STOP_SLIDESHOW" | "FOLLOW_LATEST" | "AUTO_SCROLL_IMAGE" }
  | { type: "SET_INTERVAL_MS"; interval_ms: number }
  | { type: "GOTO_INDEX"; index: number }
  | { type: "SET_SHOW_EXIF"; show_exif: boolean }
  | { type: "SET_OVERLAY"; mode: OverlayMode; corner: OverlayCorner; auto_hide: boolean }
  | { type: "SET_CLEAN_OUTPUT"; clean_output: boolean }
  | { type: "SET_SHOW_BACKGROUND"; show_background: boolean };

export type PlaybackState = "playing" | "paused" | "stopped";
export type PresentationMode = "default" | "auto-scroll";
export type OverlayMode = "compact" | "full" | "hidden";
export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface TodayState {
  type: "STATE";
  revision: number;
  server_time: string;
  updated_at: string | null;
  date_folder: string | null;
  current_index: number;
  current_base: string | null;
  current_filename: string | null;
  slideshow_running: boolean;
  playback_state: PlaybackState;
  following_latest: boolean;
  new_photos_count: number;
  interval_ms: number;
  interval_started_at: string | null;
  next_change_at: string | null;
  presentation_mode: PresentationMode;
  presentation_started_at: string | null;
  presentation_duration_ms: number;
  count_today: number;
  show_exif: boolean;
  overlay_mode: OverlayMode;
  overlay_corner: OverlayCorner;
  overlay_auto_hide: boolean;
  clean_output: boolean;
  show_background: boolean;
  current_photo: TodayPhoto | null;
  photos: Array<Pick<TodayPhoto, "base" | "filename" | "thumbnail_url" | "processed_at">>;
}

export class TodayController {
  private latest: LatestPublication | null = null;
  private latestPhotos: TodayPhoto[] = [];
  private activeDate: string | null = null;
  private photos: TodayPhoto[] = [];
  private currentIndex = -1;
  private playbackState: PlaybackState = "stopped";
  private followingLatest = true;
  private readonly baselinePhotos = new Set<string>();
  private readonly newPhotos = new Set<string>();
  private intervalStartedAt: string | null = null;
  private nextChangeAt: string | null = null;
  private presentationMode: PresentationMode = "default";
  private presentationStartedAt: string | null = null;
  private overlayMode: OverlayMode = "full";
  private visibleOverlayMode: Exclude<OverlayMode, "hidden"> = "full";
  private overlayCorner: OverlayCorner = "bottom-left";
  private overlayAutoHide = false;
  private cleanOutput = false;
  private showBackground = true;
  private revision = 0;
  private slideshowTimer: NodeJS.Timeout | null = null;
  private presentationTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<TodayState> | null = null;
  private readonly events = new EventEmitter();

  constructor(
    private readonly store: TodayStore,
    private intervalMs: number,
    private readonly refreshMs: number,
  ) {}

  async init(): Promise<void> {
    await this.refresh(true);
    this.refreshTimer = setInterval(() => void this.refresh(false).catch((error) => {
      console.warn(`[today] refresh failed: ${errorMessage(error)}`);
    }), this.refreshMs);
  }

  close(): void {
    if (this.slideshowTimer) clearTimeout(this.slideshowTimer);
    if (this.presentationTimer) clearTimeout(this.presentationTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.slideshowTimer = null;
    this.presentationTimer = null;
    this.refreshTimer = null;
  }

  onState(listener: (state: TodayState) => void): () => void {
    this.events.on("state", listener);
    return () => this.events.off("state", listener);
  }

  state(): TodayState {
    const photo = this.photos[this.currentIndex] ?? null;
    return {
      type: "STATE",
      revision: this.revision,
      server_time: new Date().toISOString(),
      updated_at: this.latest?.updated_at ?? null,
      date_folder: this.activeDate,
      current_index: photo ? this.currentIndex : -1,
      current_base: photo?.base ?? null,
      current_filename: photo?.filename ?? null,
      slideshow_running: this.playbackState === "playing",
      playback_state: this.playbackState,
      following_latest: this.followingLatest,
      new_photos_count: this.newPhotos.size,
      interval_ms: this.intervalMs,
      interval_started_at: this.intervalStartedAt,
      next_change_at: this.nextChangeAt,
      presentation_mode: this.presentationMode,
      presentation_started_at: this.presentationStartedAt,
      presentation_duration_ms: 7_000,
      count_today: this.photos.length,
      show_exif: this.overlayMode !== "hidden",
      overlay_mode: this.overlayMode,
      overlay_corner: this.overlayCorner,
      overlay_auto_hide: this.overlayAutoHide,
      clean_output: this.cleanOutput,
      show_background: this.showBackground,
      current_photo: photo,
      photos: this.photos.map(({ base, filename, thumbnail_url, processed_at }) => ({
        base,
        filename,
        thumbnail_url,
        processed_at,
      })),
    };
  }

  command(command: TodayCommand): TodayState {
    switch (command.type) {
      case "NEXT":
        this.hold();
        this.move(1);
        break;
      case "PREV":
        this.hold();
        this.move(-1);
        break;
      case "PLAY_SLIDESHOW":
        this.hold();
        this.playbackState = "playing";
        this.clearPresentation();
        this.scheduleSlideshow();
        this.emit();
        break;
      case "PAUSE_SLIDESHOW":
        this.hold();
        this.scheduleSlideshow();
        this.emit();
        break;
      case "STOP_SLIDESHOW":
      case "FOLLOW_LATEST":
        this.followingLatest = true;
        this.playbackState = "stopped";
        this.newPhotos.clear();
        this.baselinePhotos.clear();
        this.activeDate = this.latest?.date_folder ?? null;
        this.photos = this.latestPhotos;
        this.currentIndex = this.latestIndex();
        this.clearPresentation();
        this.scheduleSlideshow();
        this.emit();
        break;
      case "AUTO_SCROLL_IMAGE":
        if (this.playbackState === "playing") {
          throw new TodayCommandError("Pause or stop playback before scrolling an image.");
        }
        if (!this.photos[this.currentIndex]) throw new TodayCommandError("No photo is selected.");
        this.startPresentation("auto-scroll");
        break;
      case "SET_INTERVAL_MS":
        if (!Number.isInteger(command.interval_ms) || command.interval_ms < 1_000 || command.interval_ms > 300_000) {
          throw new TodayCommandError("Slideshow interval must be between 1 and 300 seconds.");
        }
        this.intervalMs = command.interval_ms;
        this.scheduleSlideshow();
        this.emit();
        break;
      case "GOTO_INDEX":
        if (!Number.isInteger(command.index) || command.index < 0 || command.index >= this.photos.length) {
          throw new TodayCommandError("Photo index is out of range.");
        }
        this.hold();
        this.currentIndex = command.index;
        this.clearPresentation();
        this.scheduleSlideshow();
        this.emit();
        break;
      case "SET_SHOW_EXIF":
        if (typeof command.show_exif !== "boolean") throw new TodayCommandError("show_exif must be a boolean.");
        this.overlayMode = command.show_exif ? this.visibleOverlayMode : "hidden";
        this.emit();
        break;
      case "SET_OVERLAY":
        validateOverlay(command.mode, command.corner, command.auto_hide);
        this.overlayMode = command.mode;
        if (command.mode !== "hidden") this.visibleOverlayMode = command.mode;
        this.overlayCorner = command.corner;
        this.overlayAutoHide = command.auto_hide;
        this.emit();
        break;
      case "SET_CLEAN_OUTPUT":
        if (typeof command.clean_output !== "boolean") throw new TodayCommandError("clean_output must be a boolean.");
        this.cleanOutput = command.clean_output;
        this.emit();
        break;
      case "SET_SHOW_BACKGROUND":
        if (typeof command.show_background !== "boolean") throw new TodayCommandError("show_background must be a boolean.");
        this.showBackground = command.show_background;
        this.emit();
        break;
    }
    return this.state();
  }

  refresh(force: boolean): Promise<TodayState> {
    this.refreshing ??= this.refreshLatest(force).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshLatest(force: boolean): Promise<TodayState> {
    const latest = await this.store.readLatest();
    const changed = force || latest?.updated_at !== this.latest?.updated_at || latest?.date_folder !== this.latest?.date_folder;
    if (!changed) return this.state();
    const dates = new Set([latest?.date_folder, this.latest?.date_folder, this.activeDate, ...[...this.newPhotos].map((key) => key.split("/")[0])]);
    const galleries = new Map(await Promise.all([...dates].filter((date): date is string => Boolean(date))
      .map(async (date) => [date, await this.store.listPhotos(date)] as const)));
    const previousBase = this.photos[this.currentIndex]?.base ?? null;
    const previousDate = this.activeDate;
    this.latest = latest;
    this.latestPhotos = latest ? galleries.get(latest.date_folder) ?? [] : [];
    if (this.followingLatest) {
      this.activeDate = latest?.date_folder ?? null;
      this.photos = this.latestPhotos;
      this.currentIndex = this.latestIndex();
    } else {
      const unreadDates = new Set([...this.newPhotos].map((key) => key.split("/")[0]));
      for (const [date, photos] of galleries) {
        if (date !== latest?.date_folder && date !== this.activeDate && !unreadDates.has(date)) continue;
        const available = new Set(photos.map((photo) => `${date}/${photo.base}`));
        for (const key of this.newPhotos) {
          if (key.startsWith(`${date}/`) && !available.has(key)) this.newPhotos.delete(key);
        }
        for (const key of available) {
          if (!this.baselinePhotos.has(key)) this.newPhotos.add(key);
        }
      }
      this.photos = this.activeDate ? galleries.get(this.activeDate) ?? [] : [];
      const index = this.photos.findIndex((photo) => photo.base === previousBase);
      this.currentIndex = index >= 0 ? index : Math.min(Math.max(this.currentIndex, 0), this.photos.length - 1);
    }
    if (previousDate !== this.activeDate || previousBase !== (this.photos[this.currentIndex]?.base ?? null)) {
      this.clearPresentation();
      this.scheduleSlideshow();
    } else if (this.playbackState === "playing" && (this.photos.length < 2 || !this.slideshowTimer)) {
      this.scheduleSlideshow();
    }
    this.emit();
    return this.state();
  }

  private latestIndex(): number {
    const index = this.photos.findIndex((photo) => photo.base === this.latest?.latest_base);
    return index >= 0 ? index : this.photos.length - 1;
  }

  private hold(): void {
    if (this.followingLatest) {
      for (const photo of this.photos) this.baselinePhotos.add(`${photo.date_folder}/${photo.base}`);
    }
    this.followingLatest = false;
    this.playbackState = "paused";
  }

  private move(offset: number): void {
    if (this.photos.length) this.currentIndex = (this.currentIndex + offset + this.photos.length) % this.photos.length;
    this.clearPresentation();
    this.scheduleSlideshow();
    this.emit();
  }

  private scheduleSlideshow(): void {
    if (this.slideshowTimer) clearTimeout(this.slideshowTimer);
    this.slideshowTimer = null;
    this.intervalStartedAt = null;
    this.nextChangeAt = null;
    if (this.playbackState !== "playing" || this.photos.length < 2) return;
    const now = Date.now();
    this.intervalStartedAt = new Date(now).toISOString();
    this.nextChangeAt = new Date(now + this.intervalMs).toISOString();
    this.slideshowTimer = setTimeout(() => this.move(1), this.intervalMs);
  }

  private startPresentation(mode: PresentationMode): void {
    this.clearPresentation();
    this.presentationMode = mode;
    this.presentationStartedAt = new Date().toISOString();
    this.presentationTimer = setTimeout(() => {
      this.clearPresentation();
      this.emit();
    }, 7_000);
    this.emit();
  }

  private clearPresentation(): void {
    if (this.presentationTimer) clearTimeout(this.presentationTimer);
    this.presentationTimer = null;
    this.presentationMode = "default";
    this.presentationStartedAt = null;
  }

  private emit(): void {
    this.revision += 1;
    this.events.emit("state", this.state());
  }
}

export class TodayCommandError extends Error {}

export function parseCommand(value: unknown): TodayCommand {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
    throw new TodayCommandError("A command type is required.");
  }
  const command = value as Record<string, unknown>;
  if (command.type === "START_SLIDESHOW") return { type: "PLAY_SLIDESHOW" };
  if (["NEXT", "PREV", "PLAY_SLIDESHOW", "PAUSE_SLIDESHOW", "STOP_SLIDESHOW", "FOLLOW_LATEST", "AUTO_SCROLL_IMAGE"].includes(command.type as string)) {
    return {
      type: command.type as "NEXT" | "PREV" | "PLAY_SLIDESHOW" | "PAUSE_SLIDESHOW" | "STOP_SLIDESHOW" | "FOLLOW_LATEST" | "AUTO_SCROLL_IMAGE",
    };
  }
  if (command.type === "SET_INTERVAL_MS") return { type: command.type, interval_ms: Number(command.interval_ms) };
  if (command.type === "GOTO_INDEX") return { type: command.type, index: Number(command.index) };
  if (command.type === "SET_SHOW_EXIF") {
    if (typeof command.show_exif !== "boolean") throw new TodayCommandError("show_exif must be a boolean.");
    return { type: command.type, show_exif: command.show_exif };
  }
  if (command.type === "SET_OVERLAY") {
    validateOverlay(command.mode, command.corner, command.auto_hide);
    return { type: command.type, mode: command.mode as OverlayMode, corner: command.corner as OverlayCorner, auto_hide: command.auto_hide as boolean };
  }
  if (command.type === "SET_CLEAN_OUTPUT") {
    if (typeof command.clean_output !== "boolean") throw new TodayCommandError("clean_output must be a boolean.");
    return { type: command.type, clean_output: command.clean_output };
  }
  if (command.type === "SET_SHOW_BACKGROUND") {
    if (typeof command.show_background !== "boolean") throw new TodayCommandError("show_background must be a boolean.");
    return { type: command.type, show_background: command.show_background };
  }
  throw new TodayCommandError("Unknown command.");
}

function validateOverlay(mode: unknown, corner: unknown, autoHide: unknown): void {
  if (mode !== "compact" && mode !== "full" && mode !== "hidden") throw new TodayCommandError("Choose compact, full, or hidden camera details.");
  if (corner !== "top-left" && corner !== "top-right" && corner !== "bottom-left" && corner !== "bottom-right") {
    throw new TodayCommandError("Choose a valid corner for camera details.");
  }
  if (typeof autoHide !== "boolean") throw new TodayCommandError("auto_hide must be a boolean.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
