export const SOCIAL_PLATFORMS = Object.freeze([
  ["website", "Website"],
  ["instagram", "Instagram"],
  ["tiktok", "TikTok"],
  ["youtube", "YouTube"],
  ["twitch", "Twitch"],
  ["facebook", "Facebook"],
  ["x", "X"],
  ["threads", "Threads"],
  ["bluesky", "Bluesky"],
  ["discord", "Discord invite"],
  ["linkedin", "LinkedIn"],
  ["reddit", "Reddit"],
  ["snapchat", "Snapchat"],
  ["flickr", "Flickr"],
].map(([id, label]) => Object.freeze({ id, label })));

const PLATFORM_HOSTS = {
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  twitch: ["twitch.tv"],
  facebook: ["facebook.com", "fb.com"],
  x: ["x.com", "twitter.com"],
  threads: ["threads.com", "threads.net"],
  bluesky: ["bsky.app"],
  discord: ["discord.gg", "discord.com", "discordapp.com"],
  linkedin: ["linkedin.com"],
  reddit: ["reddit.com"],
  snapchat: ["snapchat.com"],
  flickr: ["flickr.com", "flic.kr"],
};

const ICONS = {
  website: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4v11.5a4.5 4.5 0 1 1-3-4.24"/><path d="M14 4c1 3 3 4.5 6 4.5"/></svg>`,
  youtube: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="m10 9 5 3-5 3Z"/></svg>`,
  twitch: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h17v12l-5 5h-4l-3 2v-2H4Z"/><path d="M10 8v5M15 8v5"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h-2a4 4 0 0 0-4 4v14M6 11h9"/></svg>`,
  x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 3 16 18M20 3 4 21"/></svg>`,
  threads: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 10c1-3 7-3 8 1 .7 3-2 5-4.5 4.5-2-.4-2.6-2.8-1-4 1.5-1.1 5-.6 6.5 1.2"/></svg>`,
  bluesky: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c-2-4-7-7-8-5-1 2 1 6 4 8-3 0-5 1-4 3 2 3 6 1 8-2 2 3 6 5 8 2 1-2-1-3-4-3 3-2 5-6 4-8-1-2-6 1-8 5Z"/></svg>`,
  discord: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6c4-2 8-2 12 0 2 3 3 7 2 11-2 2-4 3-6 3l-1-2h-2l-1 2c-2 0-4-1-6-3-1-4 0-8 2-11Z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 10v7M8 7v.1M12 17v-4a3 3 0 0 1 6 0v4M12 10v7"/></svg>`,
  reddit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13a7 5 0 0 0 14 0 7 5 0 0 0-14 0Z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 16c2 1 4 1 6 0M13 8l1-4 4 1M5 11a2 2 0 1 0-1 4M19 11a2 2 0 1 1 1 4"/></svg>`,
  snapchat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c-3 0-5 2-5 6 0 2-1 3-3 4 1 1 2 1 3 1 0 2-1 3-2 4 2 0 3 0 4 2 2-1 4-1 6 0 1-2 2-2 4-2-1-1-2-2-2-4 1 0 2 0 3-1-2-1-3-2-3-4 0-4-2-6-5-6Z"/></svg>`,
  flickr: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/></svg>`,
};

export function detectSocialPlatform(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (input.startsWith("@")) return null;
  if (!/[/:]/.test(input) && /\.bsky\.social$/i.test(input)) return "bluesky";
  const url = parseWebUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
    if (hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return platform;
  }
  return "website";
}

export function buildSocialUrl(value, platform) {
  const input = String(value || "").trim();
  if (!input) throw new Error("Enter a URL or handle.");
  const forcedHandle = input.startsWith("@");
  const detected = forcedHandle ? null : detectSocialPlatform(input);
  const bareBlueskyHandle = platform === "bluesky" && !/^(?:https?:\/\/|www\.)/i.test(input) && !input.includes("/");
  const explicitUrl = !bareBlueskyHandle && (/^(?:https?:\/\/|www\.)/i.test(input) || input.includes("/") || (detected && detected !== "website"));
  if (platform === "website" || (!forcedHandle && explicitUrl)) {
    const url = parseWebUrl(input);
    if (!url) throw new Error("Enter a valid public website URL.");
    return url.toString();
  }

  const handle = input.replace(/^@/, "").trim();
  if (!handle || /\s/.test(handle)) throw new Error("Enter a valid handle.");
  const encoded = encodeURIComponent(handle);
  const urls = {
    instagram: `https://www.instagram.com/${encoded}/`,
    tiktok: `https://www.tiktok.com/@${encoded}`,
    youtube: `https://www.youtube.com/@${encoded}`,
    twitch: `https://www.twitch.tv/${encoded}`,
    facebook: `https://www.facebook.com/${encoded}`,
    x: `https://x.com/${encoded}`,
    threads: `https://www.threads.com/@${encoded}`,
    bluesky: `https://bsky.app/profile/${encoded}`,
    discord: `https://discord.gg/${encoded}`,
    linkedin: `https://www.linkedin.com/in/${encoded}`,
    reddit: `https://www.reddit.com/user/${encoded}/`,
    snapchat: `https://www.snapchat.com/add/${encoded}`,
    flickr: `https://www.flickr.com/photos/${encoded}/`,
  };
  if (!urls[platform]) throw new Error("Select a platform for this handle.");
  return urls[platform];
}

export function resolveSocialPlatform(value, selected) {
  const detected = detectSocialPlatform(value);
  if (!detected) return selected;
  if (detected !== "website" || looksLikeExplicitUrl(value) || !selected) return detected;
  return selected;
}

export function socialIcon(platform) {
  return ICONS[platform] || ICONS.website;
}

export function createSocialId() {
  return globalThis.crypto?.randomUUID?.() || `social-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseWebUrl(value) {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const publicHost = url.hostname.includes(".") || url.hostname.includes(":");
    return publicHost && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
  } catch {
    return null;
  }
}

function looksLikeExplicitUrl(value) {
  const input = String(value || "").trim();
  return /^(?:https?:\/\/|www\.)/i.test(input) || input.includes("/");
}
