import { createHmac, timingSafeEqual } from "node:crypto";

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

export class SessionSigner {
  constructor(
    private readonly secret: string,
    readonly durationSeconds: number,
  ) {
    if (Buffer.byteLength(secret) < 32) throw new Error("FRAME_AUTH_SESSION_SECRET must contain at least 32 characters.");
  }

  create(subject: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const payload: SessionPayload = {
      sub: subject,
      iat: nowSeconds,
      exp: nowSeconds + this.durationSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  verify(value: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): SessionPayload | null {
    if (!value) return null;
    const separator = value.lastIndexOf(".");
    if (separator < 1) return null;
    const encoded = value.slice(0, separator);
    if (!safeEqual(value.slice(separator + 1), this.sign(encoded))) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
      return typeof payload.sub === "string"
        && Number.isInteger(payload.iat)
        && Number.isInteger(payload.exp)
        && Number(payload.exp) > nowSeconds
        ? payload as SessionPayload
        : null;
    } catch {
      return null;
    }
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
