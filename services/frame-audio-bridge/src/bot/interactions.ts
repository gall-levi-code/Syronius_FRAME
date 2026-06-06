import {
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type Role,
} from "discord.js";
import { startBridgeForMember, stopBridgeForProfile } from "../bridgeActions";
import type { BridgeProfile, GuildConfig } from "../sessions/guildConfig";
import type { ActiveProfileSummary } from "../sessions/sessionManager";
import type { SessionManager } from "../sessions/sessionManager";
import type { VoiceManager } from "../voice/voiceManager";

function formatMarkdownLink(label: string, url: string | undefined): string {
  if (!url) {
    return `**${label}:** unavailable`;
  }

  const safeLabel = label.replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${safeLabel}](${url})`;
}

function formatUrlBlock(label: string, url: string | undefined): string {
  return `- ${formatMarkdownLink(label, url)}`;
}

function isGeneratedBridgeLabel(label: string): boolean {
  return label === "Guild bridge" || label === "Streamer bridge";
}

async function formatActiveStreamers(
  guild: Guild,
  activeProfiles: ActiveProfileSummary[],
): Promise<string> {
  if (activeProfiles.length === 0) {
    return "none";
  }

  const labels = await Promise.all(
    activeProfiles.map(async (profile) => {
      if (!isGeneratedBridgeLabel(profile.label)) {
        return profile.label;
      }

      const member = await guild.members.fetch(profile.ownerUserId).catch(() => null);
      return member ? `${member.displayName}'s bridge` : profile.label;
    }),
  );

  return labels.map((label) => `**${label}**`).join(", ");
}

function isFrameCommand(commandName: string): boolean {
  return commandName === "frame" || commandName === "audio";
}

function isFrameAdminCommand(commandName: string): boolean {
  return commandName === "frame-admin" || commandName === "audio-admin";
}

function formatOperatorRole(config: GuildConfig | null): string {
  if (!config?.operatorRoleId) {
    return "not configured";
  }

  return config.operatorRoleName
    ? `**${config.operatorRoleName}** (<@&${config.operatorRoleId}>)`
    : `<@&${config.operatorRoleId}>`;
}

interface RoleAssignmentCheck {
  configured: boolean;
  canAssign: boolean;
  summary: string;
  details: string[];
  role?: Role;
}

async function checkOperatorRoleAssignment(
  guild: Guild,
  config: GuildConfig,
): Promise<RoleAssignmentCheck> {
  if (!config.operatorRoleId) {
    return {
      configured: false,
      canAssign: false,
      summary: "No operator role is configured yet.",
      details: ["Run `/frame-admin setup operator-role-name:...` to create one."],
    };
  }

  const role = await guild.roles.fetch(config.operatorRoleId).catch(() => null);
  if (!role) {
    return {
      configured: true,
      canAssign: false,
      summary: "Operator role is configured, but I could not find it in this server.",
      details: ["Run `/frame-admin setup` again with an existing role or a new role name."],
    };
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return {
      configured: true,
      canAssign: false,
      summary: `Operator role **${role.name}** found, but I could not inspect my server roles.`,
      details: ["Make sure the bot is still installed in this server."],
      role,
    };
  }

  const hasManageRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles);
  const botHighestRole = botMember.roles.highest;
  const roleIsBelowBot = botHighestRole.position > role.position;
  const roleIsManageable = !role.managed && role.id !== guild.id;
  const canAssign = hasManageRoles && roleIsBelowBot && roleIsManageable;
  const details: string[] = [
    `Bot highest role: **${botHighestRole.name}**`,
    `Operator role: **${role.name}**`,
  ];

  if (!hasManageRoles) {
    details.push("Missing permission: **Manage Roles**.");
  }

  if (!roleIsBelowBot) {
    details.push("Move the bot role above the operator role in Discord role settings.");
  }

  if (!roleIsManageable) {
    details.push("The operator role is managed or otherwise cannot be assigned manually.");
  }

  return {
    configured: true,
    canAssign,
    summary: canAssign
      ? `Bot can assign **${role.name}**.`
      : `Bot cannot assign **${role.name}** yet.`,
    details,
    role,
  };
}

function formatRoleAssignmentCheck(
  check: RoleAssignmentCheck,
  options: { includeDetails?: boolean } = {},
): string[] {
  const includeDetails = options.includeDetails ?? true;
  return [
    `- Role assignment: ${check.summary}`,
    ...(includeDetails ? check.details.map((detail) => `- ${detail}`) : []),
  ];
}

function formatObsSetupSteps(linkReference: "links-command" | "links-above" = "links-above"): string[] {
  const audioSource = linkReference === "links-command"
    ? "the **OBS audio source** URL from `/frame links`"
    : "the **OBS audio source** link above";
  const overlaySource = linkReference === "links-command"
    ? "the **OBS overlay source** URL from `/frame links`"
    : "the **OBS overlay source** link above";
  const controlSource = linkReference === "links-command"
    ? "the private control page from `/frame links`"
    : "the **Private control page** link above";

  return [
    `- Audio source: add a Browser Source using ${audioSource}. The page is visually blank. In OBS, enable **Control audio via OBS** so it appears in the OBS audio mixer.`,
    `- Overlay source: add a Browser Source using ${overlaySource}. Keep it transparent and size it to your stream canvas.`,
    `- Control page: open ${controlSource} on your phone or browser to start/stop the bridge, adjust delay, mute/volume, hide/show, and tune overlay styling. Keep this link private.`,
  ];
}

function formatInfoMessage(config: GuildConfig | null): string {
  return [
    "**FRAME Audio Bridge**",
    "",
    "FRAME Audio Bridge gives each streamer permanent OBS browser-source URLs, then lets them start and stop temporary Discord voice audio mixes with slash commands. OBS sources stay stable; the live session attaches to them only while active.",
    "",
    `- Operator role: ${formatOperatorRole(config)}`,
    `- Empty channel timeout: **${config?.emptyChannelTimeoutMinutes ?? "not configured"}${config ? " minute(s)" : ""}**`,
    "",
    "**OBS setup**",
    "- Run `/frame links` to get your permanent OBS audio source, overlay source, and private control page.",
    ...formatObsSetupSteps("links-command"),
    "",
    "**Operator commands**",
    "- `/frame links` - get all permanent OBS/control links.",
    "- `/frame start` and `/frame stop` - Discord fallback for starting or stopping your personal mix.",
    "- `/frame status` - show session state, active streamers, channel, bitrate, and speakers.",
    "- `/frame reset-links` - rotate your URLs/tokens if a link leaks.",
    "",
    "**Admin commands**",
    "- `/frame-admin setup` - configure the server, operator role, empty-channel timeout, and admin bridge links.",
    "- `/frame-admin invite` - assign the operator role, create a streamer profile, and DM their links.",
  ].join("\n");
}

function isGuildMember(member: unknown): member is GuildMember {
  return Boolean(member && typeof member === "object" && "voice" in member);
}

function hasAdminPermission(interaction: ChatInputCommandInteraction): boolean {
  const permissions = interaction.memberPermissions;
  return Boolean(
    permissions?.has(PermissionFlagsBits.ManageGuild) ||
      permissions?.has(PermissionFlagsBits.Administrator),
  );
}

function memberHasRole(member: unknown, roleId: string | undefined): boolean {
  if (!roleId || !member || typeof member !== "object") {
    return false;
  }

  const roles = (member as { roles?: unknown }).roles;
  if (Array.isArray(roles)) {
    return roles.includes(roleId);
  }

  if (roles && typeof roles === "object" && "cache" in roles) {
    const cache = (roles as { cache?: { has(roleId: string): boolean } }).cache;
    return cache?.has(roleId) ?? false;
  }

  return false;
}

function hasBridgePermission(
  interaction: ChatInputCommandInteraction,
  config: GuildConfig,
  profile?: BridgeProfile | null,
): boolean {
  if (hasAdminPermission(interaction)) {
    return true;
  }

  if (profile?.ownerUserIds.includes(interaction.user.id)) {
    return true;
  }

  return memberHasRole(interaction.member, config.operatorRoleId);
}

async function getOrCreateAllowedProfile(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
  config: GuildConfig,
): Promise<BridgeProfile | null> {
  const existing = sessionManager.getProfileForUser(config, interaction.user.id);
  if (existing) {
    return existing;
  }

  if (!hasBridgePermission(interaction, config)) {
    return null;
  }

  return sessionManager.getOrCreateBridgeProfile({
    guildId: config.guildId,
    ownerUserId: interaction.user.id,
    label: interaction.member && isGuildMember(interaction.member)
      ? `${interaction.member.displayName}'s bridge`
      : `${interaction.user.displayName}'s bridge`,
  });
}

function formatProfileLinks(sessionManager: SessionManager, profile: BridgeProfile): string {
  const urls = sessionManager.buildUrls(profile, true);
  return [
    formatUrlBlock("OBS audio source", urls.audio),
    formatUrlBlock("OBS overlay source", urls.overlay),
    formatUrlBlock("Private control page", urls.control),
  ].join("\n");
}

function formatInviteAccessLine(
  config: GuildConfig,
  guildName: string,
  roleAssigned: boolean,
): string {
  const roleName = config.operatorRoleName ?? "configured operator role";

  if (config.operatorRoleId && roleAssigned) {
    return `- Access: **${roleName}** operator role in **${guildName}**.`;
  }

  if (config.operatorRoleId) {
    return `- Access: bridge profile in **${guildName}**. Operator role **${roleName}** is configured, but I could not assign it automatically.`;
  }

  return `- Access: bridge profile in **${guildName}**. No operator role is configured yet.`;
}

function formatInviteGuide(
  sessionManager: SessionManager,
  profile: BridgeProfile,
  config: GuildConfig,
  guildName: string,
  roleAssigned: boolean,
): string {
  return [
    "**FRAME Audio Bridge Invitation**",
    "",
    `You now have FRAME Audio Bridge access for **${guildName}**.`,
    formatInviteAccessLine(config, guildName, roleAssigned),
    "",
    "**Permanent links**",
    formatProfileLinks(sessionManager, profile),
    "",
    "**OBS setup**",
    ...formatObsSetupSteps("links-above"),
    "",
    "**Commands**",
    "- `/frame start` - start your personal mix from your current voice channel.",
    "- `/frame stop` - stop your personal mix.",
    "- `/frame links` - get these links again.",
    "- `/frame control` - open the control page quickly.",
    "- `/frame status` - show session health, speakers, and active streamers.",
    "- `/frame reset-links` - rotate URLs/tokens if a link leaks.",
    "- `/frame info` - show the full guide and server settings.",
  ].join("\n");
}

export async function handleAudioInteraction(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
  voiceManager: VoiceManager,
): Promise<void> {
  if (!isFrameCommand(interaction.commandName) && !isFrameAdminCommand(interaction.commandName)) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: "FRAME Audio Bridge commands only work inside a Discord server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  try {
    if (isFrameCommand(interaction.commandName) && (subcommand === "setup" || subcommand === "invite")) {
      await interaction.reply({
        content: "Server setup commands have moved to `/frame-admin`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (isFrameAdminCommand(interaction.commandName) && subcommand !== "setup" && subcommand !== "invite") {
      await interaction.reply({
        content: "Unknown `/frame-admin` subcommand.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === "info") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      await interaction.editReply(formatInfoMessage(config));
      return;
    }

    if (subcommand === "setup") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!hasAdminPermission(interaction)) {
        await interaction.editReply("Only server admins can run `/frame-admin setup`.");
        return;
      }

      let config = await sessionManager.getOrCreateGuildConfig(guildId, interaction.user.id);
      const roleOption = interaction.options.getRole("operator-role");
      const roleName = interaction.options.getString("operator-role-name")?.trim();
      const emptyTimeout = interaction.options.getInteger("empty-channel-timeout-minutes");
      const setupNotes: string[] = [];

      if (roleName) {
        const role = await interaction.guild.roles.create({
          name: roleName,
          mentionable: true,
          reason: "FRAME Audio Bridge operator role setup",
        });
        config = await sessionManager.updateGuildSettings(guildId, interaction.user.id, {
          operatorRoleId: role.id,
          operatorRoleName: role.name,
          emptyChannelTimeoutMinutes: emptyTimeout ?? undefined,
        });
        setupNotes.push(`Created operator role **${role.name}**.`);
      } else if (roleOption) {
        config = await sessionManager.updateGuildSettings(guildId, interaction.user.id, {
          operatorRoleId: roleOption.id,
          operatorRoleName: roleOption.name,
          emptyChannelTimeoutMinutes: emptyTimeout ?? undefined,
        });
        setupNotes.push(`Using operator role **${roleOption.name}**.`);
      } else if (emptyTimeout !== null) {
        config = await sessionManager.updateGuildSettings(guildId, interaction.user.id, {
          emptyChannelTimeoutMinutes: emptyTimeout,
        });
      }

      const profile = await sessionManager.getOrCreateBridgeProfile({
        guildId,
        ownerUserId: interaction.user.id,
        label: `${interaction.user.displayName}'s bridge`,
      });
      const roleCheck = await checkOperatorRoleAssignment(interaction.guild, config);

      await interaction.editReply(
        [
          "**FRAME Audio Bridge Setup**",
          "",
          "Add these OBS browser sources once and keep them forever:",
          "",
          formatProfileLinks(sessionManager, profile),
          "",
          "**Server settings**",
          `- Operator role: ${config.operatorRoleName ? `**${config.operatorRoleName}**` : "not configured"}`,
          `- Empty channel timeout: **${config.emptyChannelTimeoutMinutes} minute(s)**`,
          ...formatRoleAssignmentCheck(roleCheck),
          ...setupNotes.map((note) => `- ${note}`),
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "invite") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!hasAdminPermission(interaction)) {
        await interaction.editReply("Only server admins can invite bridge operators.");
        return;
      }

      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      if (!config) {
        await interaction.editReply("Run `/frame-admin setup` before inviting streamers.");
        return;
      }

      const targetUser = interaction.options.getUser("user", true);
      if (targetUser.bot) {
        await interaction.editReply("Bot accounts cannot be invited as bridge operators.");
        return;
      }

      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      if (!targetMember) {
        await interaction.editReply("That user is not currently a member of this server.");
        return;
      }

      const notes: string[] = [];
      let roleAssigned = false;
      const roleCheck = await checkOperatorRoleAssignment(interaction.guild, config);
      if (config.operatorRoleId && roleCheck.canAssign) {
        try {
          await targetMember.roles.add(config.operatorRoleId);
          roleAssigned = true;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown role assignment error";
          notes.push(`Could not assign the operator role: ${message}`);
        }
      }

      const profile = await sessionManager.getOrCreateBridgeProfile({
        guildId,
        ownerUserId: targetUser.id,
        label: `${targetMember.displayName}'s bridge`,
      });
      const inviteGuide = formatInviteGuide(
        sessionManager,
        profile,
        config,
        interaction.guild.name,
        roleAssigned,
      );

      let dmOk = true;
      await targetUser.send(inviteGuide).catch(() => {
        dmOk = false;
      });

      await interaction.editReply(
        [
          "**Bridge Operator Invited**",
          "",
          `- Streamer: **${targetMember.displayName}**`,
          `- DM status: ${dmOk ? "sent setup guide and permanent links" : "could not send DM"}`,
          `- Operator role: ${roleAssigned ? "assigned" : config.operatorRoleId ? "not assigned" : "not configured"}`,
          ...formatRoleAssignmentCheck(roleCheck),
          ...(dmOk ? [] : ["- Manual share: setup guide posted below."]),
          ...notes.map((note) => `- ${note}`),
        ].join("\n"),
      );

      if (!dmOk) {
        await interaction.followUp({
          content: inviteGuide,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (subcommand === "start") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      if (!config) {
        await interaction.editReply("This guild has not been set up yet. Run `/frame-admin setup` first.");
        return;
      }

      const profile = await getOrCreateAllowedProfile(interaction, sessionManager, config);
      if (!profile || !hasBridgePermission(interaction, config, profile)) {
        await interaction.editReply("You do not have permission to start a bridge mix.");
        return;
      }

      const member = interaction.member;
      if (!isGuildMember(member) || !member.voice.channel) {
        await interaction.editReply("Join a voice channel first, then run `/frame start` again.");
        return;
      }

      const result = await startBridgeForMember({
        sessionManager,
        voiceManager,
        guild: interaction.guild,
        member,
        profile,
      });
      if (!result.ok) {
        await interaction.editReply(result.message);
        return;
      }

      const activeStreamerList = await formatActiveStreamers(interaction.guild, result.activeProfiles);
      const urls = sessionManager.buildUrls(profile, true);

      await interaction.editReply(
        [
          "**Bridge Mix Started**",
          "",
          `- Voice channel: **${result.channelName ?? "unknown"}**`,
          `- Your controls: ${formatMarkdownLink("Open control panel", urls.control)}`,
          `- Active streamer mixes (${result.activeProfileCount}): ${activeStreamerList}`,
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "stop") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      if (!config) {
        await interaction.editReply("This guild has not been set up yet. Run `/frame-admin setup` first.");
        return;
      }

      const profile = sessionManager.getProfileForUser(config, interaction.user.id);
      if (!profile || !hasBridgePermission(interaction, config, profile)) {
        await interaction.editReply("You do not have an active bridge profile to stop.");
        return;
      }

      const result = await stopBridgeForProfile({
        sessionManager,
        profile,
        reason: "manual",
      });
      const activeStreamerList = await formatActiveStreamers(interaction.guild, result.activeProfiles);
      await interaction.editReply(
        [
          "**Bridge Mix Stopped**",
          "",
          "- Your bridge mix stopped.",
          result.activeProfileCount > 0
            ? `- Active streamer mixes (${result.activeProfileCount}): ${activeStreamerList}`
            : "- No active mixes remain, so the bot disconnected.",
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "status") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const snapshot = await sessionManager.getSnapshotByGuildId(guildId, false, interaction.user.id);
      if (!snapshot) {
        await interaction.editReply("This guild has not been set up yet. Run `/frame-admin setup` first.");
        return;
      }

      const activeUsers = snapshot.users.filter((user) => user.speaking && !user.muted);
      const activeStreamers = await sessionManager.getActiveProfileSummaries(guildId);
      const activeStreamerList = await formatActiveStreamers(interaction.guild, activeStreamers);
      await interaction.editReply(
        [
          "**FRAME Audio Bridge Status**",
          "",
          `- Your mix: **${snapshot.active ? "active" : "inactive"}**`,
          `- Shared voice session: **${snapshot.voiceActive ? "active" : "inactive"}**`,
          `- Active streamer mixes (${snapshot.activeProfileCount}): ${activeStreamerList}`,
          `- Delay: **${
            snapshot.delayEnabled ? `${snapshot.delayMs}ms` : `off (saved ${snapshot.defaultDelayMs}ms)`
          }**`,
          `- Voice channel: **${snapshot.channelName ?? snapshot.channelId ?? "none"}**`,
          `- Bitrate: **${
            snapshot.channelBitrate ? `${Math.round(snapshot.channelBitrate / 1000)} kbps` : "unknown"
          }**`,
          `- Tracked users: **${snapshot.users.length}**`,
          `- Speaking in your mix: ${
            activeUsers.length > 0
              ? activeUsers.map((user) => user.displayName).join(", ")
              : "none"
          }`,
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "control") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      if (!config) {
        await interaction.editReply("This guild has not been set up yet. Run `/frame-admin setup` first.");
        return;
      }

      const profile = await getOrCreateAllowedProfile(interaction, sessionManager, config);
      if (!profile || !hasBridgePermission(interaction, config, profile)) {
        await interaction.editReply("You do not have access to a bridge control page.");
        return;
      }

      const urls = sessionManager.buildUrls(profile, true);
      await interaction.editReply(
        [
          "**Bridge Control**",
          "",
          formatUrlBlock("Open private control page", urls.control),
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "links") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      if (!config) {
        await interaction.editReply("This guild has not been set up yet. Run `/frame-admin setup` first.");
        return;
      }

      const profile = await getOrCreateAllowedProfile(interaction, sessionManager, config);
      if (!profile || !hasBridgePermission(interaction, config, profile)) {
        await interaction.editReply("You do not have access to bridge links.");
        return;
      }

      await interaction.editReply(
        [
          "**Your FRAME Audio Bridge Links**",
          "",
          "These URLs are permanent until you run `/frame reset-links`.",
          "",
          formatProfileLinks(sessionManager, profile),
          "",
          "**OBS setup**",
          ...formatObsSetupSteps("links-above"),
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "reset-links") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const config = await sessionManager.getGuildConfigByGuildId(guildId);
      if (!config) {
        await interaction.editReply("This guild has not been set up yet. Run `/frame-admin setup` first.");
        return;
      }

      const profile = sessionManager.getProfileForUser(config, interaction.user.id);
      if (!profile || !hasBridgePermission(interaction, config, profile)) {
        await interaction.editReply("You do not have a bridge profile to reset.");
        return;
      }

      const updated = await sessionManager.resetLinks(guildId, interaction.user.id);
      await interaction.editReply(
        [
          "**Bridge Links Regenerated**",
          "",
          "Your active mix, if any, was stopped.",
          "",
          "**New permanent links**",
          formatProfileLinks(sessionManager, updated),
        ].join("\n"),
      );
      return;
    }

    await interaction.reply({
      content: "Unknown `/frame` subcommand.",
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error("[bot] Interaction failed", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const content = `Audio bridge command failed: ${message}`;

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  }
}
