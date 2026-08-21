export const SOCIAL_PLATFORMS = Object.freeze([
  ["website", "Custom"],
  ["fivehundredpx", "500px"],
  ["applemusic", "Apple Music"],
  ["bandcamp", "Bandcamp"],
  ["behance", "Behance"],
  ["bluesky", "Bluesky"],
  ["cara", "Cara"],
  ["discord", "Discord invite"],
  ["facebook", "Facebook"],
  ["flickr", "Flickr"],
  ["github", "GitHub"],
  ["instagram", "Instagram"],
  ["kick", "Kick"],
  ["linkhub", "Link Hub"],
  ["linkedin", "LinkedIn"],
  ["mastodon", "Mastodon"],
  ["medium", "Medium"],
  ["pinterest", "Pinterest"],
  ["pixelfed", "Pixelfed"],
  ["reddit", "Reddit"],
  ["snapchat", "Snapchat"],
  ["soundcloud", "SoundCloud"],
  ["spotify", "Spotify"],
  ["substack", "Substack"],
  ["telegram", "Telegram"],
  ["threads", "Threads"],
  ["tiktok", "TikTok"],
  ["twitch", "Twitch"],
  ["vimeo", "Vimeo"],
  ["whatsapp", "WhatsApp Channel"],
  ["x", "X"],
  ["youtube", "YouTube"],
].map(([id, label]) => Object.freeze({ id, label })));

const PLATFORM_HOSTS = {
  fivehundredpx: ["500px.com"],
  applemusic: ["music.apple.com"],
  bandcamp: ["bandcamp.com"],
  behance: ["behance.net"],
  bluesky: ["bsky.app"],
  cara: ["cara.app"],
  discord: ["discord.gg", "discord.com", "discordapp.com"],
  facebook: ["facebook.com", "fb.com"],
  flickr: ["flickr.com", "flic.kr"],
  github: ["github.com"],
  instagram: ["instagram.com"],
  kick: ["kick.com"],
  linkhub: ["linktr.ee", "beacons.ai", "carrd.co", "bio.site", "lnk.bio", "campsite.bio", "taplink.cc", "solo.to"],
  linkedin: ["linkedin.com"],
  mastodon: ["mastodon.social"],
  medium: ["medium.com"],
  pinterest: ["pinterest.com", "pin.it"],
  pixelfed: ["pixelfed.social"],
  reddit: ["reddit.com"],
  snapchat: ["snapchat.com"],
  soundcloud: ["soundcloud.com"],
  spotify: ["spotify.com", "open.spotify.com"],
  substack: ["substack.com"],
  telegram: ["t.me", "telegram.me"],
  threads: ["threads.com", "threads.net"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  twitch: ["twitch.tv"],
  vimeo: ["vimeo.com"],
  x: ["x.com", "twitter.com"],
};

const ICONS = {
  website: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z"/></svg>`,
  fivehundredpx: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="m6 16 3-3 2 2 3-3 4 4"/></svg>`,
  applemusic: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`,
  bandcamp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 6-4 12h14l4-12Z"/></svg>`,
  behance: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h6a4 4 0 0 1 0 8H4Zm0 8h7a3 3 0 0 1 0 6H4ZM15 8h5M15 15h6a4 4 0 1 0-1 3"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4v11.5a4.5 4.5 0 1 1-3-4.24"/><path d="M14 4c1 3 3 4.5 6 4.5"/></svg>`,
  youtube: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="m10 9 5 3-5 3Z"/></svg>`,
  twitch: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h17v12l-5 5h-4l-3 2v-2H4Z"/><path d="M10 8v5M15 8v5"/></svg>`,
  kick: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v16M4 12h5l6-8h5l-7 9 7 7h-6l-5-6H4"/></svg>`,
  linkhub: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15 7 17a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M15 9l2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0M8 12h8"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h-2a4 4 0 0 0-4 4v14M6 11h9"/></svg>`,
  x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 3 16 18M20 3 4 21"/></svg>`,
  threads: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 10c1-3 7-3 8 1 .7 3-2 5-4.5 4.5-2-.4-2.6-2.8-1-4 1.5-1.1 5-.6 6.5 1.2"/></svg>`,
  bluesky: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c-2-4-7-7-8-5-1 2 1 6 4 8-3 0-5 1-4 3 2 3 6 1 8-2 2 3 6 5 8 2 1-2-1-3-4-3 3-2 5-6 4-8-1-2-6 1-8 5Z"/></svg>`,
  discord: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6c4-2 8-2 12 0 2 3 3 7 2 11-2 2-4 3-6 3l-1-2h-2l-1 2c-2 0-4-1-6-3-1-4 0-8 2-11Z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 10v7M8 7v.1M12 17v-4a3 3 0 0 1 6 0v4M12 10v7"/></svg>`,
  reddit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13a7 5 0 0 0 14 0 7 5 0 0 0-14 0Z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 16c2 1 4 1 6 0M13 8l1-4 4 1M5 11a2 2 0 1 0-1 4M19 11a2 2 0 1 1 1 4"/></svg>`,
  snapchat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c-3 0-5 2-5 6 0 2-1 3-3 4 1 1 2 1 3 1 0 2-1 3-2 4 2 0 3 0 4 2 2-1 4-1 6 0 1-2 2-2 4-2-1-1-2-2-2-4 1 0 2 0 3-1-2-1-3-2-3-4 0-4-2-6-5-6Z"/></svg>`,
  flickr: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/></svg>`,
  github: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20c-4 1-4-2-6-2M16 22v-3c0-1 .4-2 1-2.5 3-.4 6-1.5 6-6A5 5 0 0 0 21 6c.2-1 .1-2-.3-3 0 0-1 0-3 1a10 10 0 0 0-6 0C9.7 3 8.7 3 8.7 3A7 7 0 0 0 8.4 6 5 5 0 0 0 7 10.5c0 4.5 3 5.6 6 6 .6.5 1 1.5 1 2.5v3"/></svg>`,
  mastodon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18c-2-2-2-11 0-13 3-2 11-2 14 0 2 2 2 9 0 11-2 2-6 2-9 1v3c3 1 6 0 8-1M8 8v6M16 8v6M8 10c0-3 4-3 4 0v4M12 10c0-3 4-3 4 0"/></svg>`,
  medium: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h4l5 11 5-11h4M5 6v12M19 6v12"/></svg>`,
  pinterest: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 20c1-3 2-6 2-8 0-2 1-4 3-4 2 0 3 2 2 4-1 3-3 4-5 2"/></svg>`,
  pixelfed: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 17V7h4a4 4 0 1 1 0 8H8"/></svg>`,
  soundcloud: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15v2M6 13v4M9 10v7M12 8v9M15 11a4 4 0 1 1 0 6Z"/></svg>`,
  spotify: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M7 9c4-1 8 0 11 2M8 13c3-1 6 0 9 1M9 16c2-.5 4 0 6 1"/></svg>`,
  substack: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14M5 8h14M6 12h12v9l-6-4-6 4Z"/></svg>`,
  telegram: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-7-5 17-5-6-4 3 1-5Z"/><path d="m8 13 8-5"/></svg>`,
  vimeo: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8c2-3 5-3 6 1l2 7c2-3 4-6 3-7-1-1-2 0-3 0 1-4 7-5 8-1 1 3-6 12-9 12-3 0-4-10-5-10-1 0-2 1-2 1"/></svg>`,
  whatsapp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 1-11 7l-5 2 2-5a8 8 0 1 1 14-4Z"/><path d="M9 8c0 4 3 7 7 7"/></svg>`,
};

export function detectSocialPlatform(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (input.startsWith("@")) return null;
  if (!/[/:]/.test(input) && /\.bsky\.social$/i.test(input)) return "bluesky";
  const url = parseWebUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if ((host === "whatsapp.com" || host.endsWith(".whatsapp.com")) && url.pathname.startsWith("/channel/")) return "whatsapp";
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
    fivehundredpx: `https://500px.com/p/${encoded}`,
    bandcamp: `https://${encoded}.bandcamp.com/`,
    behance: `https://www.behance.net/${encoded}`,
    cara: `https://cara.app/${encoded}`,
    github: `https://github.com/${encoded}`,
    instagram: `https://www.instagram.com/${encoded}/`,
    tiktok: `https://www.tiktok.com/@${encoded}`,
    youtube: `https://www.youtube.com/@${encoded}`,
    twitch: `https://www.twitch.tv/${encoded}`,
    kick: `https://kick.com/${encoded}`,
    facebook: `https://www.facebook.com/${encoded}`,
    x: `https://x.com/${encoded}`,
    threads: `https://www.threads.com/@${encoded}`,
    bluesky: `https://bsky.app/profile/${encoded}`,
    discord: `https://discord.gg/${encoded}`,
    linkedin: `https://www.linkedin.com/in/${encoded}`,
    medium: `https://medium.com/@${encoded}`,
    pinterest: `https://www.pinterest.com/${encoded}/`,
    reddit: `https://www.reddit.com/user/${encoded}/`,
    snapchat: `https://www.snapchat.com/add/${encoded}`,
    flickr: `https://www.flickr.com/photos/${encoded}/`,
    soundcloud: `https://soundcloud.com/${encoded}`,
    substack: `https://${encoded}.substack.com/`,
    telegram: `https://t.me/${encoded}`,
    vimeo: `https://vimeo.com/${encoded}`,
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
