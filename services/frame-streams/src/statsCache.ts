export function createStatsCache<T>(now: () => number = Date.now) {
  const entries = new Map<string, { result: Promise<T>; expiresAt: number }>();

  return {
    read(id: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(id);
      if (cached && cached.expiresAt > now()) return cached.result;

      const entry = { result: Promise.resolve().then(load), expiresAt: Infinity };
      entry.result = entry.result.then(
        (value) => {
          entry.expiresAt = now() + 200;
          return value;
        },
        (error) => {
          if (entries.get(id) === entry) entries.delete(id);
          throw error;
        },
      );
      entries.delete(id);
      entries.set(id, entry);
      // Public stats URLs accept arbitrary IDs; bound pending and completed entries alike.
      if (entries.size > 256) entries.delete(entries.keys().next().value!);
      return entry.result;
    },
    invalidate(): void {
      entries.clear();
    },
  };
}
