import { EventEmitter } from "node:events";
import type { AppConfig } from "../config";
import type { GuildConfigStore } from "../storage/store";
import {
  type AudioSession,
  type BridgeProfile,
  defaultOverlaySettings,
  defaultUserControls,
  type GuildConfig,
  type OverlayAvatarPosition,
  type OverlayBubbleShape,
  type OverlayFontFamily,
  type OverlayGrowthDirection,
  type OverlayLayout,
  type OverlayPosition,
  type OverlaySettings,
  type SessionUser,
  type UserControlSettings,
  type VoiceSessionUser,
} from "./guildConfig";
import { createControlToken, createGuildKey } from "./token";

export interface BridgeAudioChunk {
  guildId: string;
  guildKey: string;
  pcm: Buffer;
  sampleRate: 48_000;
  channels: 2;
  createdAt: number;
}

export interface BridgeUrls {
  audio: string;
  overlay: string;
  control?: string;
}

export interface ActiveProfileSummary {
  bridgeKey: string;
  label: string;
  ownerUserId: string;
}

export interface EngineHealth {
  state: "idle" | "ok" | "warn" | "bad";
  label: string;
  details: string;
  updatedAt: string;
}

export interface BridgeSnapshot {
  guildId: string;
  guildKey: string;
  bridgeKey: string;
  profileLabel: string;
  profileOwnerUserId: string;
  active: boolean;
  voiceActive: boolean;
  activeProfileCount: number;
  activeProfiles: ActiveProfileSummary[];
  channelId?: string;
  channelName?: string;
  channelBitrate?: number | null;
  startedAt?: string;
  delayMs: number;
  delayEnabled: boolean;
  defaultDelayMs: number;
  resetDelayMs: number;
  maxDelayMs: number;
  idleTimeoutMinutes: number;
  emptyChannelTimeoutMinutes: number;
  engineHealth: EngineHealth;
  overlaySettings: OverlaySettings;
  users: SessionUser[];
  urls: BridgeUrls;
}

export interface ProfileMixInput {
  bridgeKey: string;
  delayMs: number;
  users: SessionUser[];
}

interface StartSessionInput {
  guildId: string;
  bridgeKey: string;
  channelId: string;
  channelName: string;
  channelBitrate?: number | null;
}

interface CreateProfileInput {
  guildId: string;
  ownerUserId: string;
  label?: string;
}

interface GuildSettingsPatch {
  operatorRoleId?: string;
  operatorRoleName?: string;
  emptyChannelTimeoutMinutes?: number;
}

interface SpeakingUserInput {
  discordUserId: string;
  displayName: string;
  avatarUrl: string;
}

interface UserControlPatch {
  muted?: boolean;
  volume?: number;
  hidden?: boolean;
}

const VALID_LAYOUTS: OverlayLayout[] = ["horizontal", "vertical", "active-only", "persistent"];
const VALID_POSITIONS: OverlayPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
const VALID_GROWTH_DIRECTIONS: OverlayGrowthDirection[] = [
  "auto",
  "right",
  "left",
  "down",
  "up",
];
const VALID_FONT_FAMILIES: OverlayFontFamily[] = [
  "system",
  "rounded",
  "display",
  "condensed",
  "wide",
  "serif",
  "mono",
];
const VALID_BUBBLE_SHAPES: OverlayBubbleShape[] = ["pill", "rounded", "square"];
const VALID_AVATAR_POSITIONS: OverlayAvatarPosition[] = ["left", "right", "top", "bottom"];
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const DEFAULT_EMPTY_CHANNEL_TIMEOUT_MINUTES = 5;
const AUDIO_DELAY_STEP_MS = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function cloneSession(session: AudioSession): AudioSession {
  return JSON.parse(JSON.stringify(session)) as AudioSession;
}

function cloneProfile(profile: BridgeProfile): BridgeProfile {
  return JSON.parse(JSON.stringify(profile)) as BridgeProfile;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeHexColor(value: string, label: string): string {
  const color = value.trim();
  if (!HEX_COLOR_PATTERN.test(color)) {
    throw new Error(`${label} must be a #RRGGBB or #RRGGBBAA color`);
  }

  return color.toLowerCase();
}

function mergeUserControls(
  user: VoiceSessionUser,
  controls: UserControlSettings | undefined,
): SessionUser {
  return {
    ...user,
    ...defaultUserControls(),
    ...(controls ?? {}),
  };
}

function isGeneratedProfileLabel(label: string): boolean {
  return label === "Guild bridge" || label === "Streamer bridge";
}

export class SessionManager extends EventEmitter {
  private readonly sessionsByGuildId = new Map<string, AudioSession>();

  private readonly engineHealthByGuildId = new Map<string, EngineHealth>();

  private readonly lastActivityByGuildId = new Map<string, number>();

  private readonly idleTimer: NodeJS.Timeout;

  public constructor(
    private readonly store: GuildConfigStore,
    private readonly appConfig: AppConfig,
  ) {
    super();

    this.idleTimer = setInterval(() => {
      void this.expireIdleSessions();
    }, 60_000);
    this.idleTimer.unref();
  }

  public stopTimers(): void {
    clearInterval(this.idleTimer);
  }

  public buildUrls(profile: BridgeProfile, includeControlUrl: boolean): BridgeUrls {
    const obsTokenQuery = this.appConfig.readonlyObsToken
      ? `?obsToken=${encodeURIComponent(this.appConfig.readonlyObsToken)}`
      : "";

    const urls: BridgeUrls = {
      audio: `${this.appConfig.publicBaseUrl}/bridge/${profile.bridgeKey}/audio${obsTokenQuery}`,
      overlay: `${this.appConfig.publicBaseUrl}/bridge/${profile.bridgeKey}/overlay${obsTokenQuery}`,
    };

    if (includeControlUrl) {
      urls.control = `${this.appConfig.publicBaseUrl}/bridge/${profile.bridgeKey}/control?token=${encodeURIComponent(
        profile.controlToken,
      )}`;
    }

    return urls;
  }

  public async getOrCreateGuildConfig(
    guildId: string,
    adminUserId: string,
  ): Promise<GuildConfig> {
    const existing = await this.store.getByGuildId(guildId);
    if (existing) {
      if (!existing.adminUserIds.includes(adminUserId)) {
        existing.adminUserIds.push(adminUserId);
        existing.updatedAt = nowIso();
        return this.store.upsertGuildConfig(existing);
      }

      return existing;
    }

    const timestamp = nowIso();
    const config: GuildConfig = {
      guildId,
      adminUserIds: [adminUserId],
      emptyChannelTimeoutMinutes: DEFAULT_EMPTY_CHANNEL_TIMEOUT_MINUTES,
      profiles: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.store.upsertGuildConfig(config);
  }

  public async updateGuildSettings(
    guildId: string,
    adminUserId: string,
    patch: GuildSettingsPatch,
  ): Promise<GuildConfig> {
    const config = await this.getOrCreateGuildConfig(guildId, adminUserId);

    if (patch.operatorRoleId) {
      config.operatorRoleId = patch.operatorRoleId;
      config.operatorRoleName = patch.operatorRoleName;
    }

    if (typeof patch.emptyChannelTimeoutMinutes === "number") {
      config.emptyChannelTimeoutMinutes = clamp(
        Math.round(patch.emptyChannelTimeoutMinutes),
        1,
        240,
      );
    }

    config.updatedAt = nowIso();
    return this.store.upsertGuildConfig(config);
  }

  public async getGuildConfigByGuildId(guildId: string): Promise<GuildConfig | null> {
    return this.store.getByGuildId(guildId);
  }

  public async getGuildConfigByKey(bridgeKey: string): Promise<GuildConfig | null> {
    const lookup = await this.store.getByBridgeKey(bridgeKey);
    return lookup?.config ?? null;
  }

  public async getProfileByBridgeKey(bridgeKey: string): Promise<BridgeProfile | null> {
    const lookup = await this.store.getByBridgeKey(bridgeKey);
    return lookup?.profile ?? null;
  }

  public getProfileForUser(config: GuildConfig, userId: string): BridgeProfile | null {
    return (
      config.profiles.find(
        (profile) => profile.ownerUserId === userId || profile.ownerUserIds.includes(userId),
      ) ?? null
    );
  }

  public async getOrCreateBridgeProfile(input: CreateProfileInput): Promise<BridgeProfile> {
    const config = await this.store.getByGuildId(input.guildId);
    if (!config) {
      throw new Error("This guild has not been set up yet. Run `/frame-admin setup` first.");
    }

    const existing = this.getProfileForUser(config, input.ownerUserId);
    if (existing) {
      if (input.label && isGeneratedProfileLabel(existing.label)) {
        const updated = {
          ...existing,
          label: input.label,
          updatedAt: nowIso(),
        };
        this.updateProfile(config, existing.bridgeKey, updated);
        await this.store.upsertGuildConfig(config);
        return cloneProfile(updated);
      }

      return cloneProfile(existing);
    }

    const timestamp = nowIso();
    const profile: BridgeProfile = {
      guildId: input.guildId,
      bridgeKey: createGuildKey(),
      controlToken: createControlToken(),
      ownerUserId: input.ownerUserId,
      ownerUserIds: [input.ownerUserId],
      label: input.label ?? "Streamer bridge",
      defaultDelayMs: this.appConfig.defaultAudioDelayMs,
      delayEnabled: true,
      overlaySettings: defaultOverlaySettings(),
      userControls: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    config.profiles.push(profile);
    config.updatedAt = timestamp;
    await this.store.upsertGuildConfig(config);
    return cloneProfile(profile);
  }

  public async resetLinks(guildId: string, ownerUserId: string): Promise<BridgeProfile> {
    const config = await this.requireConfigByGuildId(guildId);
    const profileIndex = config.profiles.findIndex(
      (profile) => profile.ownerUserId === ownerUserId || profile.ownerUserIds.includes(ownerUserId),
    );
    if (profileIndex < 0) {
      throw new Error("You do not have a bridge profile yet.");
    }

    const existing = config.profiles[profileIndex];
    await this.stopProfile(guildId, existing.bridgeKey, "links-reset");

    const updated: BridgeProfile = {
      ...existing,
      bridgeKey: createGuildKey(),
      controlToken: createControlToken(),
      updatedAt: nowIso(),
    };

    config.profiles[profileIndex] = updated;
    config.updatedAt = updated.updatedAt;
    await this.store.upsertGuildConfig(config);
    await this.emitSnapshotsForGuildId(guildId);
    return cloneProfile(updated);
  }

  public async startSession(input: StartSessionInput): Promise<AudioSession> {
    const config = await this.requireConfigByGuildId(input.guildId);
    const profile = config.profiles.find((entry) => entry.bridgeKey === input.bridgeKey);
    if (!profile) {
      throw new Error("Unknown bridge profile.");
    }

    const existing = this.sessionsByGuildId.get(input.guildId);
    if (existing?.active && existing.channelId !== input.channelId) {
      throw new Error(
        `FRAME Audio Bridge is already active in ${existing.channelName}. Join that channel or stop the current session first.`,
      );
    }

    const activeBridgeKeys = new Set(existing?.activeBridgeKeys ?? []);
    activeBridgeKeys.add(profile.bridgeKey);

    const session: AudioSession = {
      guildId: input.guildId,
      channelId: input.channelId,
      channelName: input.channelName,
      channelBitrate: input.channelBitrate ?? null,
      active: true,
      startedAt: existing?.startedAt ?? nowIso(),
      activeBridgeKeys: [...activeBridgeKeys],
      users: (existing?.users ?? []).map((user) => ({
        ...user,
        audioLevel: user.audioLevel ?? 0,
        speaking: false,
      })),
    };

    this.sessionsByGuildId.set(input.guildId, session);
    this.touch(input.guildId);
    await this.emitSnapshotsForGuildId(input.guildId);
    return cloneSession(session);
  }

  public async stopProfile(
    guildId: string,
    bridgeKey: string,
    reason = "manual",
  ): Promise<AudioSession | null> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session) {
      return null;
    }

    session.activeBridgeKeys = session.activeBridgeKeys.filter((entry) => entry !== bridgeKey);
    if (session.activeBridgeKeys.length === 0) {
      session.active = false;
      session.users = [];
      this.lastActivityByGuildId.delete(guildId);
      await this.emitSnapshotsForGuildId(guildId);
      this.emit("sessionStopped", { guildId, reason });
      return cloneSession(session);
    }

    this.touch(guildId);
    await this.emitSnapshotsForGuildId(guildId);
    return cloneSession(session);
  }

  public async stopSession(guildId: string, reason = "manual"): Promise<AudioSession | null> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session) {
      return null;
    }

    session.active = false;
    session.activeBridgeKeys = [];
    session.users = [];
    this.lastActivityByGuildId.delete(guildId);
    await this.emitSnapshotsForGuildId(guildId);
    this.emit("sessionStopped", { guildId, reason });
    return cloneSession(session);
  }

  public getSessionByGuildId(guildId: string): AudioSession | null {
    const session = this.sessionsByGuildId.get(guildId);
    return session ? cloneSession(session) : null;
  }

  public getActiveBridgeKeys(guildId: string): string[] {
    const session = this.sessionsByGuildId.get(guildId);
    return session?.active ? [...session.activeBridgeKeys] : [];
  }

  public async getActiveProfileSummaries(guildId: string): Promise<ActiveProfileSummary[]> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session?.active || session.activeBridgeKeys.length === 0) {
      return [];
    }

    const config = await this.store.getByGuildId(guildId);
    if (!config) {
      return [];
    }

    return this.getActiveProfileSummariesFromConfig(config, session);
  }

  public async updateEngineHealth(
    guildId: string,
    health: Omit<EngineHealth, "updatedAt">,
  ): Promise<void> {
    this.engineHealthByGuildId.set(guildId, {
      ...health,
      updatedAt: nowIso(),
    });
    await this.emitSnapshotsForGuildId(guildId);
  }

  public async getActiveProfileMixInputs(guildId: string): Promise<ProfileMixInput[]> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session?.active || session.activeBridgeKeys.length === 0) {
      return [];
    }

    const config = await this.store.getByGuildId(guildId);
    if (!config) {
      return [];
    }

    const profilesByKey = new Map(config.profiles.map((profile) => [profile.bridgeKey, profile]));
    return session.activeBridgeKeys.flatMap((bridgeKey) => {
      const profile = profilesByKey.get(bridgeKey);
      if (!profile) {
        return [];
      }

      return [
        {
          bridgeKey,
          delayMs: profile.delayEnabled === false ? 0 : profile.defaultDelayMs,
          users: this.mergeProfileUsers(session.users, profile),
        },
      ];
    });
  }

  public publishAudioChunk(
    guildId: string,
    bridgeKey: string,
    chunk: Omit<BridgeAudioChunk, "guildId" | "guildKey">,
  ): void {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session?.active || !session.activeBridgeKeys.includes(bridgeKey)) {
      return;
    }

    this.emit("audioChunk", {
      ...chunk,
      guildId,
      guildKey: bridgeKey,
    } satisfies BridgeAudioChunk);
  }

  public async updateSpeaking(
    guildId: string,
    userInput: SpeakingUserInput,
    speaking: boolean,
  ): Promise<void> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session || !session.active) {
      return;
    }

    const existing = session.users.find(
      (user) => user.discordUserId === userInput.discordUserId,
    );

    if (existing) {
      existing.displayName = userInput.displayName;
      existing.avatarUrl = userInput.avatarUrl;
      existing.speaking = speaking;
    } else {
      session.users.push({
        discordUserId: userInput.discordUserId,
        displayName: userInput.displayName,
        avatarUrl: userInput.avatarUrl,
        speaking,
        audioLevel: 0,
      });
    }

    if (speaking) {
      this.touch(guildId);
    }

    await this.emitSnapshotsForGuildId(guildId);
  }

  public async setDelay(bridgeKey: string, delayMs: number): Promise<void> {
    const { config, profile } = await this.requireProfileByBridgeKey(bridgeKey);
    const nextDelay = clamp(
      Math.round(delayMs / AUDIO_DELAY_STEP_MS) * AUDIO_DELAY_STEP_MS,
      0,
      this.appConfig.maxAudioDelayMs,
    );
    this.updateProfile(config, profile.bridgeKey, {
      ...profile,
      defaultDelayMs: nextDelay,
      updatedAt: nowIso(),
    });

    await this.store.upsertGuildConfig(config);
    await this.emitSnapshotForBridgeKey(profile.bridgeKey);
  }

  public async setDelayEnabled(bridgeKey: string, delayEnabled: boolean): Promise<void> {
    const { config, profile } = await this.requireProfileByBridgeKey(bridgeKey);
    this.updateProfile(config, profile.bridgeKey, {
      ...profile,
      delayEnabled,
      updatedAt: nowIso(),
    });

    await this.store.upsertGuildConfig(config);
    await this.emitSnapshotForBridgeKey(profile.bridgeKey);
  }

  public async setOverlaySettings(
    bridgeKey: string,
    patch: Partial<OverlaySettings>,
  ): Promise<void> {
    const { config, profile } = await this.requireProfileByBridgeKey(bridgeKey);
    const current = {
      ...defaultOverlaySettings(),
      ...profile.overlaySettings,
    };

    if (patch.layout && !VALID_LAYOUTS.includes(patch.layout)) {
      throw new Error(`Invalid overlay layout: ${patch.layout}`);
    }

    if (patch.position && !VALID_POSITIONS.includes(patch.position)) {
      throw new Error(`Invalid overlay position: ${patch.position}`);
    }

    if (
      patch.growthDirection &&
      !VALID_GROWTH_DIRECTIONS.includes(patch.growthDirection)
    ) {
      throw new Error(`Invalid overlay growth direction: ${patch.growthDirection}`);
    }

    if (patch.fontFamily && !VALID_FONT_FAMILIES.includes(patch.fontFamily)) {
      throw new Error(`Invalid overlay font: ${patch.fontFamily}`);
    }

    if (patch.bubbleShape && !VALID_BUBBLE_SHAPES.includes(patch.bubbleShape)) {
      throw new Error(`Invalid overlay bubble shape: ${patch.bubbleShape}`);
    }

    if (patch.avatarPosition && !VALID_AVATAR_POSITIONS.includes(patch.avatarPosition)) {
      throw new Error(`Invalid overlay avatar position: ${patch.avatarPosition}`);
    }

    this.updateProfile(config, profile.bridgeKey, {
      ...profile,
      overlaySettings: {
        layout: patch.layout ?? current.layout,
        position: patch.position ?? current.position,
        growthDirection: patch.growthDirection ?? current.growthDirection,
        showAvatars: patch.showAvatars ?? current.showAvatars,
        showNames: patch.showNames ?? current.showNames,
        fadeMs:
          typeof patch.fadeMs === "number"
            ? clamp(Math.round(patch.fadeMs), 0, 5_000)
            : current.fadeMs,
        avatarSizePx:
          typeof patch.avatarSizePx === "number"
            ? clamp(Math.round(patch.avatarSizePx), 24, 128)
            : current.avatarSizePx,
        nameFontSizePx:
          typeof patch.nameFontSizePx === "number"
            ? clamp(Math.round(patch.nameFontSizePx), 10, 64)
            : current.nameFontSizePx,
        paddingPx:
          typeof patch.paddingPx === "number"
            ? clamp(Math.round(patch.paddingPx), 0, 120)
            : current.paddingPx,
        testMode: patch.testMode ?? current.testMode,
        glowEnabled: patch.glowEnabled ?? current.glowEnabled,
        glowIntensity:
          typeof patch.glowIntensity === "number"
            ? clamp(Math.round(patch.glowIntensity), 0, 100)
            : current.glowIntensity,
        inactiveOpacity:
          typeof patch.inactiveOpacity === "number"
            ? clamp(Math.round(patch.inactiveOpacity), 0, 100)
            : current.inactiveOpacity,
        accentColor:
          typeof patch.accentColor === "string"
            ? normalizeHexColor(patch.accentColor, "Accent color")
            : current.accentColor,
        backgroundColor:
          typeof patch.backgroundColor === "string"
            ? normalizeHexColor(patch.backgroundColor, "Background color")
            : current.backgroundColor,
        nameColor:
          typeof patch.nameColor === "string"
            ? normalizeHexColor(patch.nameColor, "Name color")
            : current.nameColor,
        fontFamily: patch.fontFamily ?? current.fontFamily,
        bubbleShape: patch.bubbleShape ?? current.bubbleShape,
        avatarPosition: patch.avatarPosition ?? current.avatarPosition,
        textShadow: patch.textShadow ?? current.textShadow,
        textStroke: patch.textStroke ?? current.textStroke,
        textStrokeWidthPx:
          typeof patch.textStrokeWidthPx === "number"
            ? clamp(Math.round(patch.textStrokeWidthPx), 0, 4)
            : current.textStrokeWidthPx,
        bubbleShadow: patch.bubbleShadow ?? current.bubbleShadow,
        bubbleStroke: patch.bubbleStroke ?? current.bubbleStroke,
        bubbleStrokeWidthPx:
          typeof patch.bubbleStrokeWidthPx === "number"
            ? clamp(Math.round(patch.bubbleStrokeWidthPx), 0, 8)
            : current.bubbleStrokeWidthPx,
      },
      updatedAt: nowIso(),
    });

    await this.store.upsertGuildConfig(config);
    await this.emitSnapshotForBridgeKey(profile.bridgeKey);
  }

  public async updateAudioLevels(
    guildId: string,
    levelsByUserId: Map<string, number>,
  ): Promise<void> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session?.active || levelsByUserId.size === 0) {
      return;
    }

    let changed = false;
    for (const user of session.users) {
      const level = levelsByUserId.get(user.discordUserId);
      const nextLevel = level === undefined ? Math.max(0, user.audioLevel * 0.65) : clamp(level, 0, 1);
      if (Math.abs(nextLevel - user.audioLevel) >= 0.01) {
        user.audioLevel = nextLevel;
        changed = true;
      }
    }

    if (changed) {
      await this.emitSnapshotsForGuildId(guildId);
    }
  }

  public async retainVoiceUsers(guildId: string, voiceUserIds: Set<string>): Promise<number> {
    const session = this.sessionsByGuildId.get(guildId);
    if (!session || session.users.length === 0) {
      return 0;
    }

    const initialCount = session.users.length;
    session.users = session.users.filter((user) => voiceUserIds.has(user.discordUserId));
    const removedCount = initialCount - session.users.length;
    if (removedCount > 0) {
      await this.emitSnapshotsForGuildId(guildId);
    }

    return removedCount;
  }

  public async setUserControls(
    bridgeKey: string,
    discordUserId: string,
    patch: UserControlPatch,
  ): Promise<void> {
    const { config, profile } = await this.requireProfileByBridgeKey(bridgeKey);
    const current = {
      ...defaultUserControls(),
      ...(profile.userControls[discordUserId] ?? {}),
    };

    profile.userControls[discordUserId] = {
      muted: patch.muted ?? current.muted,
      hidden: patch.hidden ?? current.hidden,
      volume: typeof patch.volume === "number" ? clamp(patch.volume, 0, 2) : current.volume,
    };
    profile.updatedAt = nowIso();
    this.updateProfile(config, profile.bridgeKey, profile);

    this.touch(config.guildId);
    await this.store.upsertGuildConfig(config);
    await this.emitSnapshotForBridgeKey(profile.bridgeKey);
  }

  public async setAllUserControls(bridgeKey: string, patch: UserControlPatch): Promise<void> {
    const { config, profile } = await this.requireProfileByBridgeKey(bridgeKey);
    const session = this.sessionsByGuildId.get(config.guildId);
    if (!session) {
      return;
    }

    for (const user of session.users) {
      const current = {
        ...defaultUserControls(),
        ...(profile.userControls[user.discordUserId] ?? {}),
      };
      profile.userControls[user.discordUserId] = {
        muted: patch.muted ?? current.muted,
        hidden: patch.hidden ?? current.hidden,
        volume: typeof patch.volume === "number" ? clamp(patch.volume, 0, 2) : current.volume,
      };
    }

    profile.updatedAt = nowIso();
    this.updateProfile(config, profile.bridgeKey, profile);
    this.touch(config.guildId);
    await this.store.upsertGuildConfig(config);
    await this.emitSnapshotForBridgeKey(profile.bridgeKey);
  }

  public async validateControlToken(bridgeKey: string, token: string | null): Promise<boolean> {
    const lookup = await this.store.getByBridgeKey(bridgeKey);
    return Boolean(lookup && token && lookup.profile.controlToken === token);
  }

  public async validateObsToken(bridgeKey: string, obsToken: string | null): Promise<boolean> {
    const lookup = await this.store.getByBridgeKey(bridgeKey);
    if (!lookup) {
      return false;
    }

    if (!this.appConfig.readonlyObsToken) {
      return true;
    }

    return obsToken === this.appConfig.readonlyObsToken;
  }

  public async getSnapshotByGuildKey(
    bridgeKey: string,
    includeControlUrl: boolean,
  ): Promise<BridgeSnapshot | null> {
    const lookup = await this.store.getByBridgeKey(bridgeKey);
    if (!lookup) {
      return null;
    }

    return this.buildSnapshot(lookup.config, lookup.profile, includeControlUrl);
  }

  public async getSnapshotByGuildId(
    guildId: string,
    includeControlUrl: boolean,
    ownerUserId?: string,
  ): Promise<BridgeSnapshot | null> {
    const config = await this.store.getByGuildId(guildId);
    if (!config) {
      return null;
    }

    const profile = ownerUserId
      ? this.getProfileForUser(config, ownerUserId)
      : config.profiles[0];
    if (!profile) {
      return null;
    }

    return this.buildSnapshot(config, profile, includeControlUrl);
  }

  public async getEmptyChannelTimeoutMinutes(guildId: string): Promise<number> {
    const config = await this.store.getByGuildId(guildId);
    return config?.emptyChannelTimeoutMinutes ?? DEFAULT_EMPTY_CHANNEL_TIMEOUT_MINUTES;
  }

  private buildSnapshot(
    config: GuildConfig,
    profile: BridgeProfile,
    includeControlUrl: boolean,
  ): BridgeSnapshot {
    const session = this.sessionsByGuildId.get(config.guildId);
    const voiceActive = session?.active ?? false;
    const active = Boolean(voiceActive && session?.activeBridgeKeys.includes(profile.bridgeKey));

    return {
      guildId: config.guildId,
      guildKey: profile.bridgeKey,
      bridgeKey: profile.bridgeKey,
      profileLabel: profile.label,
      profileOwnerUserId: profile.ownerUserId,
      active,
      voiceActive,
      activeProfileCount: session?.activeBridgeKeys.length ?? 0,
      activeProfiles: this.getActiveProfileSummariesFromConfig(config, session),
      channelId: session?.channelId,
      channelName: session?.channelName,
      channelBitrate: session?.channelBitrate,
      startedAt: session?.startedAt,
      delayMs: profile.delayEnabled === false ? 0 : profile.defaultDelayMs,
      delayEnabled: profile.delayEnabled !== false,
      defaultDelayMs: profile.defaultDelayMs,
      resetDelayMs: this.appConfig.defaultAudioDelayMs,
      maxDelayMs: this.appConfig.maxAudioDelayMs,
      idleTimeoutMinutes: this.appConfig.sessionIdleTimeoutMinutes,
      emptyChannelTimeoutMinutes: config.emptyChannelTimeoutMinutes,
      engineHealth: voiceActive
        ? this.engineHealthByGuildId.get(config.guildId) ?? {
            state: "idle",
            label: "Engine waiting",
            details: "No audio engine stats have been reported yet.",
            updatedAt: nowIso(),
          }
        : {
            state: "idle",
            label: "Engine idle",
            details: "Start your bridge mix to begin engine monitoring.",
            updatedAt: nowIso(),
          },
      overlaySettings: profile.overlaySettings,
      users: active && session ? this.mergeProfileUsers(session.users, profile) : [],
      urls: this.buildUrls(profile, includeControlUrl),
    };
  }

  private mergeProfileUsers(users: VoiceSessionUser[], profile: BridgeProfile): SessionUser[] {
    return users.map((user) => mergeUserControls(user, profile.userControls[user.discordUserId]));
  }

  private getActiveProfileSummariesFromConfig(
    config: GuildConfig,
    session: AudioSession | undefined,
  ): ActiveProfileSummary[] {
    if (!session?.active || session.activeBridgeKeys.length === 0) {
      return [];
    }

    const profilesByKey = new Map(config.profiles.map((profile) => [profile.bridgeKey, profile]));
    return session.activeBridgeKeys.flatMap((bridgeKey) => {
      const profile = profilesByKey.get(bridgeKey);
      if (!profile) {
        return [];
      }

      return [
        {
          bridgeKey,
          label: profile.label,
          ownerUserId: profile.ownerUserId,
        },
      ];
    });
  }

  private async requireConfigByGuildId(guildId: string): Promise<GuildConfig> {
    const config = await this.store.getByGuildId(guildId);
    if (!config) {
      throw new Error("Unknown guild bridge");
    }

    return config;
  }

  private async requireProfileByBridgeKey(
    bridgeKey: string,
  ): Promise<{ config: GuildConfig; profile: BridgeProfile }> {
    const lookup = await this.store.getByBridgeKey(bridgeKey);
    if (!lookup) {
      throw new Error("Unknown bridge profile");
    }

    return lookup;
  }

  private updateProfile(config: GuildConfig, bridgeKey: string, profile: BridgeProfile): void {
    const profileIndex = config.profiles.findIndex((entry) => entry.bridgeKey === bridgeKey);
    if (profileIndex < 0) {
      throw new Error("Unknown bridge profile");
    }

    config.profiles[profileIndex] = {
      ...profile,
      guildId: config.guildId,
    };
    config.updatedAt = profile.updatedAt;
  }

  private touch(guildId: string): void {
    this.lastActivityByGuildId.set(guildId, Date.now());
  }

  private async emitSnapshotForBridgeKey(bridgeKey: string): Promise<void> {
    const snapshot = await this.getSnapshotByGuildKey(bridgeKey, true);
    if (snapshot) {
      this.emit("snapshot", snapshot);
    }
  }

  private async emitSnapshotsForGuildId(guildId: string): Promise<void> {
    const config = await this.store.getByGuildId(guildId);
    if (!config) {
      return;
    }

    for (const profile of config.profiles) {
      const snapshot = this.buildSnapshot(config, profile, true);
      this.emit("snapshot", snapshot);
    }
  }

  private async expireIdleSessions(): Promise<void> {
    const maxIdleMs = this.appConfig.sessionIdleTimeoutMinutes * 60_000;
    const now = Date.now();

    for (const [guildId, session] of this.sessionsByGuildId) {
      if (!session.active) {
        continue;
      }

      const lastActivity = this.lastActivityByGuildId.get(guildId) ?? Date.parse(session.startedAt);
      if (now - lastActivity >= maxIdleMs) {
        await this.stopSession(guildId, "idle-timeout");
      }
    }
  }
}
