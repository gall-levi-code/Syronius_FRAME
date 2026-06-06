import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BridgeProfile,
  defaultOverlaySettings,
  defaultUserControls,
  type GuildConfig,
} from "../sessions/guildConfig";
import type { BridgeProfileLookup, GuildConfigStore } from "./store";

interface PersistedState {
  guildConfigs: GuildConfig[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneConfig(config: GuildConfig): GuildConfig {
  return JSON.parse(JSON.stringify(config)) as GuildConfig;
}

function cloneProfile(profile: BridgeProfile): BridgeProfile {
  return JSON.parse(JSON.stringify(profile)) as BridgeProfile;
}

function normalizeOverlaySettings(value: GuildConfig["overlaySettings"]): ReturnType<typeof defaultOverlaySettings> {
  const defaults = defaultOverlaySettings();
  const overlaySettings = {
    ...defaults,
    ...(value ?? {}),
  };

  overlaySettings.fadeMs = overlaySettings.fadeMs === 250 ? 0 : (overlaySettings.fadeMs ?? 0);
  return overlaySettings;
}

function normalizeProfile(
  config: GuildConfig,
  profile: Partial<BridgeProfile> & Pick<BridgeProfile, "bridgeKey" | "controlToken">,
): BridgeProfile {
  const timestamp = profile.createdAt ?? config.createdAt ?? nowIso();
  const ownerUserId =
    profile.ownerUserId ??
    profile.ownerUserIds?.[0] ??
    config.adminUserIds?.[0] ??
    config.ownerUserIds?.[0] ??
    "unknown";

  const userControls: Record<string, ReturnType<typeof defaultUserControls>> = {};
  for (const [discordUserId, controls] of Object.entries(profile.userControls ?? {})) {
    userControls[discordUserId] = {
      ...defaultUserControls(),
      ...controls,
    };
  }

  return {
    guildId: config.guildId,
    bridgeKey: profile.bridgeKey,
    controlToken: profile.controlToken,
    ownerUserId,
    ownerUserIds: profile.ownerUserIds ?? [ownerUserId],
    label: profile.label ?? "Guild bridge",
    defaultDelayMs: profile.defaultDelayMs ?? config.defaultDelayMs ?? 0,
    delayEnabled: profile.delayEnabled ?? true,
    overlaySettings: normalizeOverlaySettings(profile.overlaySettings ?? config.overlaySettings),
    userControls,
    createdAt: timestamp,
    updatedAt: profile.updatedAt ?? config.updatedAt ?? timestamp,
  };
}

function normalizeConfig(config: GuildConfig): GuildConfig {
  const normalized = cloneConfig(config);
  const timestamp = normalized.createdAt ?? nowIso();
  const adminUserIds = normalized.adminUserIds ?? normalized.ownerUserIds ?? [];
  const legacyBridgeKey = normalized.guildKey;
  const legacyControlToken = normalized.controlToken;

  const profiles =
    normalized.profiles?.map((profile) => normalizeProfile(normalized, profile)) ?? [];

  if (profiles.length === 0 && legacyBridgeKey && legacyControlToken) {
    profiles.push(
      normalizeProfile(normalized, {
        bridgeKey: legacyBridgeKey,
        controlToken: legacyControlToken,
        ownerUserId: adminUserIds[0] ?? "unknown",
        ownerUserIds: adminUserIds.length > 0 ? adminUserIds : undefined,
        label: "Guild bridge",
        defaultDelayMs: normalized.defaultDelayMs,
        overlaySettings: normalized.overlaySettings,
        createdAt: timestamp,
        updatedAt: normalized.updatedAt ?? timestamp,
      }),
    );
  }

  return {
    guildId: normalized.guildId,
    adminUserIds,
    operatorRoleId: normalized.operatorRoleId,
    operatorRoleName: normalized.operatorRoleName,
    emptyChannelTimeoutMinutes: normalized.emptyChannelTimeoutMinutes ?? 5,
    profiles,
    createdAt: timestamp,
    updatedAt: normalized.updatedAt ?? timestamp,
  };
}

export class JsonGuildConfigStore implements GuildConfigStore {
  private readonly configsByGuildId = new Map<string, GuildConfig>();

  private readonly filePath: string;

  public constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "guild-configs.json");
  }

  public async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      let changed = false;
      for (const config of parsed.guildConfigs ?? []) {
        const normalized = normalizeConfig(config);
        changed ||= JSON.stringify(normalized) !== JSON.stringify(config);
        this.configsByGuildId.set(config.guildId, normalized);
      }

      if (changed) {
        await this.flush();
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }

      await this.flush();
    }
  }

  public async getByGuildId(guildId: string): Promise<GuildConfig | null> {
    const config = this.configsByGuildId.get(guildId);
    return config ? cloneConfig(config) : null;
  }

  public async getByBridgeKey(bridgeKey: string): Promise<BridgeProfileLookup | null> {
    for (const config of this.configsByGuildId.values()) {
      const profile = config.profiles.find((entry) => entry.bridgeKey === bridgeKey);
      if (profile) {
        return {
          config: cloneConfig(config),
          profile: cloneProfile(profile),
        };
      }
    }

    return null;
  }

  public async listGuildConfigs(): Promise<GuildConfig[]> {
    return [...this.configsByGuildId.values()].map(cloneConfig);
  }

  public async upsertGuildConfig(config: GuildConfig): Promise<GuildConfig> {
    const stored = normalizeConfig(config);
    this.configsByGuildId.set(stored.guildId, stored);
    await this.flush();
    return cloneConfig(stored);
  }

  private async flush(): Promise<void> {
    const state: PersistedState = {
      guildConfigs: [...this.configsByGuildId.values()].map(cloneConfig),
    };

    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}
