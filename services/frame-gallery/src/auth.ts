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
    response.setHeader("WWW-Authenticate", `Basic realm="${config.realm}", charset="UTF-8"`);
    response.status(config.username && config.password ? 401 : 503).send(
      config.username && config.password ? "Authentication required." : "Portal authentication is not configured.",
    );
  };
}

function hasValidCredentials(authorization: string | undefined, config: BasicAuthConfig): boolean {
  if (!config.username || !config.password || !authorization?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0
      && safeEqual(decoded.slice(0, separator), config.username)
      && safeEqual(decoded.slice(separator + 1), config.password);
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
