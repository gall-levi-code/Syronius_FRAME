export function createLastGoodCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  onStale: (error: unknown) => void,
  now: () => number = Date.now,
) {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;

  return {
    read(): Promise<T> {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
      if (pending) return pending;

      pending = load()
        .then((value) => {
          cached = { value, expiresAt: now() + ttlMs };
          return value;
        })
        .catch((error) => {
          if (!cached) throw error;
          cached.expiresAt = now() + ttlMs;
          onStale(error);
          return cached.value;
        })
        .finally(() => { pending = undefined; });
      return pending;
    },
    invalidate(): void {
      if (cached) cached.expiresAt = 0;
    },
  };
}
