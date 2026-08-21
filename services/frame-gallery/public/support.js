export const SUPPORT_PLATFORMS = Object.freeze([
  ["custom", "Custom"],
  ["buymeacoffee", "Buy Me a Coffee"],
  ["gofundme", "GoFundMe"],
  ["justgiving", "JustGiving"],
  ["kofi", "Ko-fi"],
  ["monzo", "Monzo.me"],
  ["patreon", "Patreon"],
  ["paypal", "PayPal.Me"],
  ["revolut", "Revolut.me"],
  ["square", "Square"],
  ["starling", "Starling Settle Up"],
  ["stripe", "Stripe"],
  ["sumup", "SumUp"],
  ["tide", "Tide"],
  ["venmo", "Venmo"],
  ["wise", "Wise"],
].map(([id, label]) => Object.freeze({ id, label })));

const PLATFORM_HOSTS = {
  buymeacoffee: ["buymeacoffee.com"],
  gofundme: ["gofundme.com"],
  justgiving: ["justgiving.com"],
  kofi: ["ko-fi.com"],
  monzo: ["monzo.me"],
  patreon: ["patreon.com"],
  paypal: ["paypal.me"],
  revolut: ["revolut.me"],
  square: ["square.link", "squareup.com"],
  starling: ["settleup.starlingbank.com"],
  stripe: ["buy.stripe.com", "checkout.stripe.com"],
  sumup: ["pay.sumup.com", "sumup.com"],
  tide: ["tide.co"],
  venmo: ["venmo.com"],
  wise: ["wise.com"],
};

const DEFAULT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 5.6-7 10-7 10Z"/><path d="M9 13h6M12 10v6"/></svg>`;

export function detectSupportPlatform(value) {
  const url = parseWebUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
    if (hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return platform;
  }
  return "custom";
}

export function resolveSupportPlatform(value, selected) {
  const detected = detectSupportPlatform(value);
  return detected && (detected !== "custom" || !selected) ? detected : selected;
}

export function buildSupportUrl(value) {
  const url = parseWebUrl(value);
  if (!url) throw new Error("Paste a valid public payment or support link.");
  return url.toString();
}

export function supportIcon() {
  return DEFAULT_ICON;
}

export function createSupportId() {
  return globalThis.crypto?.randomUUID?.() || `support-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseWebUrl(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    const publicHost = url.hostname.includes(".") || url.hostname.includes(":");
    return publicHost && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
  } catch {
    return null;
  }
}
