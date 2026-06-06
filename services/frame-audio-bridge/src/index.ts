import { loadConfig } from "./config";
import { createDiscordClient } from "./bot/client";
import { registerCommands } from "./bot/commands";
import { handleAudioInteraction } from "./bot/interactions";
import { Events } from "discord.js";
import { JsonGuildConfigStore } from "./storage/jsonStore";
import { SessionManager } from "./sessions/sessionManager";
import { VoiceManager } from "./voice/voiceManager";
import { createWebServer } from "./web/server";

const STARTUP_RETRY_ATTEMPTS = 8;
const STARTUP_RETRY_BASE_DELAY_MS = 1_000;
const STARTUP_RETRY_MAX_DELAY_MS = 30_000;
const RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string") {
    return code;
  }

  const cause = "cause" in error ? error.cause : undefined;
  return getErrorCode(cause);
}

function isRetryableStartupError(error: unknown): boolean {
  const code = getErrorCode(error);
  return Boolean(code && RETRYABLE_ERROR_CODES.has(code));
}

async function withStartupRetry<T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableStartupError(error) || attempt === STARTUP_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = Math.min(
        STARTUP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        STARTUP_RETRY_MAX_DELAY_MS,
      );
      const code = getErrorCode(error) ?? "unknown";
      console.warn(
        `[app] ${label} failed with ${code}; retrying in ${delayMs}ms (${attempt}/${STARTUP_RETRY_ATTEMPTS})`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JsonGuildConfigStore(config.dataDir);
  await store.init();

  const sessionManager = new SessionManager(store, config);
  const voiceManager = new VoiceManager(sessionManager);
  const client = createDiscordClient();
  const webServer = createWebServer(config, sessionManager, voiceManager, client);

  sessionManager.on("sessionStopped", ({ guildId, reason }: { guildId: string; reason: string }) => {
    console.log(`[session] ${guildId} stopped (${reason})`);
    voiceManager.disconnect(guildId);
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[bot] Logged in as ${readyClient.user.tag}`);
  });

  client.on("interactionCreate", (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    void handleAudioInteraction(interaction, sessionManager, voiceManager);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = newState.guild.id || oldState.guild.id;
    const timer = setTimeout(() => {
      void voiceManager.syncVoiceChannelMembers(guildId);
    }, 250);
    timer.unref();
  });

  await withStartupRetry("Discord command registration", () => registerCommands(config));
  await webServer.start();
  await withStartupRetry("Discord login", () => client.login(config.discordToken));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[app] Received ${signal}, shutting down`);
    sessionManager.stopTimers();
    voiceManager.disconnectAll();
    client.destroy();
    await webServer.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error("[app] Startup failed", error);
  process.exit(1);
});
