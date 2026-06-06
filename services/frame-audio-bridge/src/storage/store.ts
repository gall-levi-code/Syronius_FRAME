import type { BridgeProfile, GuildConfig } from "../sessions/guildConfig";

export interface BridgeProfileLookup {
  config: GuildConfig;
  profile: BridgeProfile;
}

export interface GuildConfigStore {
  init(): Promise<void>;
  getByGuildId(guildId: string): Promise<GuildConfig | null>;
  getByBridgeKey(bridgeKey: string): Promise<BridgeProfileLookup | null>;
  listGuildConfigs(): Promise<GuildConfig[]>;
  upsertGuildConfig(config: GuildConfig): Promise<GuildConfig>;
}
