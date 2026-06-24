type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

export function logAudio(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    service: "frame-audio",
    message,
    ...sanitizeContext(context),
  };
  const line = `[audio] ${JSON.stringify(entry)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorContext(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}

function sanitizeContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeValue(value)]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 1_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, nested]) => [key, sanitizeValue(nested)]),
    );
  }
  return String(value);
}
