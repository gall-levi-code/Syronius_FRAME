import { EventEmitter } from "node:events";
import type { LatestPublication, TodayPhoto, TodayStore } from "./store.js";

export type TodayCommand =
  | { type: "NEXT" | "PREV" | "PLAY_SLIDESHOW" | "PAUSE_SLIDESHOW" | "STOP_SLIDESHOW" | "AUTO_SCROLL_IMAGE" }
  | { type: "SET_INTERVAL_MS"; interval_ms: number }
  | { type: "GOTO_INDEX"; index: number }
  | { type: "SET_SHOW_EXIF"; show_exif: boolean };

export type PlaybackState = "playing" | "paused" | "stopped";
export type PresentationMode = "default" | "auto-scroll";

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
  interval_ms: number;
  interval_started_at: string | null;
  next_change_at: string | null;
  presentation_mode: PresentationMode;
  presentation_started_at: string | null;
  presentation_duration_ms: number;
  count_today: number;
  show_exif: boolean;
  current_photo: TodayPhoto | null;
  photos: Array<Pick<TodayPhoto, "base" | "filename" | "thumbnail_url" | "processed_at">>;
}

export class TodayController {
  private latest: LatestPublication | null = null;
  private photos: TodayPhoto[] = [];
  private currentIndex = -1;
  private playbackState: PlaybackState = "stopped";
  private intervalStartedAt: string | null = null;
  private nextChangeAt: string | null = null;
  private presentationMode: PresentationMode = "default";
  private presentationStartedAt: string | null = null;
  private showExif = true;
  private revision = 0;
  private slideshowTimer: NodeJS.Timeout | null = null;
  private presentationTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
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
      date_folder: this.latest?.date_folder ?? null,
      current_index: photo ? this.currentIndex : -1,
      current_base: photo?.base ?? null,
      current_filename: photo?.filename ?? null,
      slideshow_running: this.playbackState === "playing",
      playback_state: this.playbackState,
      interval_ms: this.intervalMs,
      interval_started_at: this.intervalStartedAt,
      next_change_at: this.nextChangeAt,
      presentation_mode: this.presentationMode,
      presentation_started_at: this.presentationStartedAt,
      presentation_duration_ms: 7_000,
      count_today: this.photos.length,
      show_exif: this.showExif,
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
        this.move(1);
        break;
      case "PREV":
        this.move(-1);
        break;
      case "PLAY_SLIDESHOW":
        this.playbackState = "playing";
        this.clearPresentation();
        this.scheduleSlideshow();
        this.emit();
        break;
      case "PAUSE_SLIDESHOW":
        this.playbackState = "paused";
        this.scheduleSlideshow();
        this.emit();
        break;
      case "STOP_SLIDESHOW":
        this.playbackState = "stopped";
        this.currentIndex = this.photos.length ? this.photos.length - 1 : -1;
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
        this.currentIndex = command.index;
        this.clearPresentation();
        this.scheduleSlideshow();
        this.emit();
        break;
      case "SET_SHOW_EXIF":
        if (typeof command.show_exif !== "boolean") throw new TodayCommandError("show_exif must be a boolean.");
        this.showExif = command.show_exif;
        this.emit();
        break;
    }
    return this.state();
  }

  async refresh(force: boolean): Promise<TodayState> {
    const latest = await this.store.readLatest();
    const changed = force || latest?.updated_at !== this.latest?.updated_at || latest?.date_folder !== this.latest?.date_folder;
    if (!changed) return this.state();
    const previousBase = this.photos[this.currentIndex]?.base ?? null;
    this.latest = latest;
    this.photos = latest ? await this.store.listPhotos(latest.date_folder) : [];
    this.clearPresentation();
    const preferredBase = latest?.latest_base ?? previousBase;
    const preferredIndex = preferredBase ? this.photos.findIndex((photo) => photo.base === preferredBase) : -1;
    this.currentIndex = preferredIndex >= 0 ? preferredIndex : this.photos.length ? this.photos.length - 1 : -1;
    this.scheduleSlideshow();
    this.emit();
    return this.state();
  }

  private move(offset: number): void {
    if (!this.photos.length) return;
    this.currentIndex = (this.currentIndex + offset + this.photos.length) % this.photos.length;
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
  if (["NEXT", "PREV", "PLAY_SLIDESHOW", "PAUSE_SLIDESHOW", "STOP_SLIDESHOW", "AUTO_SCROLL_IMAGE"].includes(command.type as string)) {
    return {
      type: command.type as "NEXT" | "PREV" | "PLAY_SLIDESHOW" | "PAUSE_SLIDESHOW" | "STOP_SLIDESHOW" | "AUTO_SCROLL_IMAGE",
    };
  }
  if (command.type === "SET_INTERVAL_MS") return { type: command.type, interval_ms: Number(command.interval_ms) };
  if (command.type === "GOTO_INDEX") return { type: command.type, index: Number(command.index) };
  if (command.type === "SET_SHOW_EXIF") {
    if (typeof command.show_exif !== "boolean") throw new TodayCommandError("show_exif must be a boolean.");
    return { type: command.type, show_exif: command.show_exif };
  }
  throw new TodayCommandError("Unknown command.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
