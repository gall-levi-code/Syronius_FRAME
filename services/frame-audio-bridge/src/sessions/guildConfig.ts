export type OverlayLayout = "horizontal" | "vertical" | "active-only" | "persistent";
export type OverlayPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";
export type OverlayGrowthDirection = "auto" | "right" | "left" | "down" | "up";
export type OverlayFontFamily =
  | "system"
  | "rounded"
  | "display"
  | "condensed"
  | "wide"
  | "serif"
  | "mono";
export type OverlayBubbleShape = "pill" | "rounded" | "square";
export type OverlayAvatarPosition = "left" | "right" | "top" | "bottom";

export interface OverlaySettings {
  layout: OverlayLayout;
  position: OverlayPosition;
  growthDirection: OverlayGrowthDirection;
  showAvatars: boolean;
  showNames: boolean;
  fadeMs: number;
  avatarSizePx: number;
  nameFontSizePx: number;
  paddingPx: number;
  testMode: boolean;
  glowEnabled: boolean;
  glowIntensity: number;
  inactiveOpacity: number;
  accentColor: string;
  backgroundColor: string;
  nameColor: string;
  fontFamily: OverlayFontFamily;
  bubbleShape: OverlayBubbleShape;
  avatarPosition: OverlayAvatarPosition;
  textShadow: boolean;
  textStroke: boolean;
  textStrokeWidthPx: number;
  bubbleShadow: boolean;
  bubbleStroke: boolean;
  bubbleStrokeWidthPx: number;
}

export interface UserControlSettings {
  muted: boolean;
  volume: number;
  hidden: boolean;
}

export interface VoiceSessionUser {
  discordUserId: string;
  displayName: string;
  avatarUrl: string;
  speaking: boolean;
  audioLevel: number;
}

export interface SessionUser extends VoiceSessionUser, UserControlSettings {}

export interface BridgeProfile {
  guildId: string;
  bridgeKey: string;
  controlToken: string;
  ownerUserId: string;
  ownerUserIds: string[];
  label: string;
  defaultDelayMs: number;
  delayEnabled: boolean;
  overlaySettings: OverlaySettings;
  userControls: Record<string, UserControlSettings>;
  createdAt: string;
  updatedAt: string;
}

export interface GuildConfig {
  guildId: string;
  adminUserIds: string[];
  operatorRoleId?: string;
  operatorRoleName?: string;
  emptyChannelTimeoutMinutes: number;
  profiles: BridgeProfile[];
  createdAt: string;
  updatedAt: string;

  // Legacy fields are normalized into profiles by the JSON store.
  guildKey?: string;
  controlToken?: string;
  ownerUserIds?: string[];
  defaultDelayMs?: number;
  overlaySettings?: OverlaySettings;
}

export interface AudioSession {
  guildId: string;
  channelId: string;
  channelName: string;
  channelBitrate: number | null;
  active: boolean;
  startedAt: string;
  activeBridgeKeys: string[];
  users: VoiceSessionUser[];
}

export function defaultOverlaySettings(): OverlaySettings {
  return {
    layout: "horizontal",
    position: "bottom-center",
    growthDirection: "auto",
    showAvatars: true,
    showNames: true,
    fadeMs: 0,
    avatarSizePx: 42,
    nameFontSizePx: 18,
    paddingPx: 24,
    testMode: false,
    glowEnabled: true,
    glowIntensity: 42,
    inactiveOpacity: 56,
    accentColor: "#2cb4fb",
    backgroundColor: "#07111b",
    nameColor: "#ffffff",
    fontFamily: "system",
    bubbleShape: "pill",
    avatarPosition: "left",
    textShadow: false,
    textStroke: false,
    textStrokeWidthPx: 1,
    bubbleShadow: true,
    bubbleStroke: false,
    bubbleStrokeWidthPx: 1,
  };
}

export function defaultUserControls(): UserControlSettings {
  return {
    muted: false,
    volume: 1,
    hidden: false,
  };
}
