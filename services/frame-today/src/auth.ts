import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export interface BasicAuthConfig {
  username: string;
  password: string;
  realm: string;
}

export function requireBasicAuth(config: BasicAuthConfig): RequestHandler {
  return (request, response, next) => {
    if (hasValidCredentials(request.header("authorization"), config)) {
      next();
      return;
    }
    challenge(response, config);
  };
}

export function hasValidCredentials(authorization: string | undefined, config: BasicAuthConfig): boolean {
  if (!config.username || !config.password || !authorization?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return safeEqual(decoded.slice(0, separator), config.username)
      && safeEqual(decoded.slice(separator + 1), config.password);
  } catch {
    return false;
  }
}

export function unauthorizedUpgradeResponse(config: BasicAuthConfig): string {
  const status = config.username && config.password ? "401 Unauthorized" : "503 Service Unavailable";
  const body = config.username && config.password ? "Authentication required." : "Portal authentication is not configured.";
  return [
    `HTTP/1.1 ${status}`,
    `WWW-Authenticate: Basic realm="${config.realm}", charset="UTF-8"`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

function challenge(response: Parameters<RequestHandler>[1], config: BasicAuthConfig): void {
  response.setHeader("WWW-Authenticate", `Basic realm="${config.realm}", charset="UTF-8"`);
  response.status(config.username && config.password ? 401 : 503).send(
    config.username && config.password ? "Authentication required." : "Portal authentication is not configured.",
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
