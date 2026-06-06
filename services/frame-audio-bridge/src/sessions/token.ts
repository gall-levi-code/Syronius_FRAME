import crypto from "node:crypto";

export function createRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function createGuildKey(): string {
  return createRandomToken(24);
}

export function createControlToken(): string {
  return createRandomToken(32);
}
