import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { AppConfig } from "../config";

export const audioCommand = new SlashCommandBuilder()
  .setName("frame")
  .setDescription("Control your FRAME Audio Bridge mix")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("info")
      .setDescription("Explain FRAME Audio Bridge and show available commands"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("start")
      .setDescription("Start bridging the voice channel you are currently in"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("stop").setDescription("Stop your active audio bridge mix"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("Show the current bridge status"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("control").setDescription("Get your private mobile control URL"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("links").setDescription("Get your permanent OBS and control URLs"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reset-links")
      .setDescription("Regenerate your bridge key and private control token"),
  );

export const audioAdminCommand = new SlashCommandBuilder()
  .setName("frame-admin")
  .setDescription("Configure FRAME Audio Bridge for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("setup")
      .setDescription("Configure this guild and retrieve your OBS bridge URLs")
      .addRoleOption((option) =>
        option
          .setName("operator-role")
          .setDescription("Existing role allowed to use FRAME Audio Bridge"),
      )
      .addStringOption((option) =>
        option
          .setName("operator-role-name")
          .setDescription("Create and use a new operator role with this name")
          .setMinLength(1)
          .setMaxLength(100),
      )
      .addIntegerOption((option) =>
        option
          .setName("empty-channel-timeout-minutes")
          .setDescription("Disconnect after the voice channel is empty for this many minutes")
          .setMinValue(1)
          .setMaxValue(240),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("invite")
      .setDescription("Invite a streamer and DM them their permanent OBS URLs")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Discord user to invite as a bridge operator")
          .setRequired(true),
      ),
  );

export async function registerCommands(config: AppConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body: [audioCommand.toJSON(), audioAdminCommand.toJSON()],
  });
  console.log("[bot] Registered /frame and /frame-admin slash commands");
}
