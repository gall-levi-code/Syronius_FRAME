import {
  ChannelType,
  type Client,
  type Guild,
  type GuildMember,
  PermissionFlagsBits,
  type VoiceBasedChannel,
} from "discord.js";
import type { BridgeProfile } from "./sessions/guildConfig";
import type { ActiveProfileSummary, SessionManager } from "./sessions/sessionManager";
import type { VoiceManager } from "./voice/voiceManager";

export interface BridgeActionResult {
  ok: boolean;
  state: "started" | "stopped" | "retry";
  message: string;
  activeProfileCount: number;
  channelName?: string;
  activeProfiles: ActiveProfileSummary[];
}

export async function startBridgeForMember(input: {
  sessionManager: SessionManager;
  voiceManager: VoiceManager;
  guild: Guild;
  member: GuildMember;
  profile: BridgeProfile;
}): Promise<BridgeActionResult> {
  const { sessionManager, voiceManager, guild, member, profile } = input;
  const channel = member.voice.channel;
  if (!channel) {
    return failure("Join a voice channel first, then try again.");
  }

  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    return failure("That voice target is not a supported Discord voice channel.");
  }

  const permissionFailure = await getVoicePermissionFailure(guild, channel);
  if (permissionFailure) {
    return failure(permissionFailure);
  }

  const existingSession = sessionManager.getSessionByGuildId(guild.id);
  if (existingSession?.active && existingSession.channelId !== channel.id) {
    return failure(
      `FRAME Audio Bridge is already active in ${existingSession.channelName}. Join that channel or stop the current session first.`,
      existingSession.activeBridgeKeys.length,
      existingSession.channelName,
      await sessionManager.getActiveProfileSummaries(guild.id),
    );
  }

  try {
    await voiceManager.connect(guild, channel);
  } catch (error) {
    return failure(
      `I could not join ${channel.name}. ${formatError(error)} Check the bot's channel permissions and try again.`,
      existingSession?.activeBridgeKeys.length ?? 0,
      existingSession?.channelName,
      existingSession ? await sessionManager.getActiveProfileSummaries(guild.id) : [],
    );
  }

  const session = await sessionManager.startSession({
    guildId: guild.id,
    bridgeKey: profile.bridgeKey,
    channelId: channel.id,
    channelName: channel.name,
    channelBitrate: "bitrate" in channel ? channel.bitrate : null,
  });

  return {
    ok: true,
    state: "started",
    message: `Bridge started in ${channel.name}.`,
    activeProfileCount: session.activeBridgeKeys.length,
    channelName: channel.name,
    activeProfiles: await sessionManager.getActiveProfileSummaries(guild.id),
  };
}

async function getVoicePermissionFailure(
  guild: Guild,
  channel: VoiceBasedChannel | null,
): Promise<string | null> {
  if (!channel) {
    return "Join a voice channel first, then try again.";
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return "I cannot inspect my Discord server permissions right now.";
  }

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) {
    return `I cannot inspect my permissions for ${channel.name}.`;
  }

  const missing: string[] = [];
  if (!permissions.has(PermissionFlagsBits.ViewChannel)) {
    missing.push("View Channel");
  }

  if (!permissions.has(PermissionFlagsBits.Connect)) {
    missing.push("Connect");
  }

  if (missing.length === 0) {
    return null;
  }

  return `I can't join ${channel.name}. Missing Discord permission(s): ${missing.join(", ")}.`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startBridgeForProfileOwner(input: {
  discordClient: Client;
  sessionManager: SessionManager;
  voiceManager: VoiceManager;
  profile: BridgeProfile;
}): Promise<BridgeActionResult> {
  const { discordClient, sessionManager, voiceManager, profile } = input;
  if (!discordClient.isReady()) {
    return failure("Discord bot is not connected yet.");
  }

  const guild = await discordClient.guilds.fetch(profile.guildId).catch(() => null);
  if (!guild) {
    return failure("Discord bot cannot access this server.");
  }

  const member = await guild.members.fetch(profile.ownerUserId).catch(() => null);
  if (!member) {
    return failure("Bridge owner is not currently available in this server.");
  }

  return startBridgeForMember({
    sessionManager,
    voiceManager,
    guild,
    member,
    profile,
  });
}

export async function stopBridgeForProfile(input: {
  sessionManager: SessionManager;
  profile: BridgeProfile;
  reason?: string;
}): Promise<BridgeActionResult> {
  const { sessionManager, profile, reason = "manual" } = input;
  const session = await sessionManager.stopProfile(profile.guildId, profile.bridgeKey, reason);
  const activeProfiles = await sessionManager.getActiveProfileSummaries(profile.guildId);
  const activeProfileCount = session?.activeBridgeKeys.length ?? 0;

  return {
    ok: true,
    state: "stopped",
    message: activeProfileCount > 0
      ? "Your bridge mix stopped. Other streamer mixes remain active."
      : "Your bridge mix stopped. No active mixes remain.",
    activeProfileCount,
    channelName: session?.channelName,
    activeProfiles,
  };
}

function failure(
  message: string,
  activeProfileCount = 0,
  channelName?: string,
  activeProfiles: ActiveProfileSummary[] = [],
): BridgeActionResult {
  return {
    ok: false,
    state: "retry",
    message,
    activeProfileCount,
    channelName,
    activeProfiles,
  };
}
