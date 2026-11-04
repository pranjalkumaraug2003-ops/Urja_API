// In-memory cache with TTL, stale-while-revalidate and single flight (D2).
// Generic: it knows nothing about meters or the portal; callers pass a key, a loader and a TTL.

export function createCache({
  now = () => Date.now(),
  maxEntries = 1000, // bounds memory: the oldest entry is evicted first
  retryDelayMs = 30_000, // after a failed background refresh, wait this long before trying again
  onRefreshError = () => {}, // called when a background refresh fails (the stale copy keeps being served)
} = {}) {
  const entries = new Map(); // key -> { value, fetchedAt, expiresAt, retryAt }
  const inFlight = new Map(); // key -> the promise of the load running for that key

  // Runs the loader once per key at a time; parallel callers share the same promise.
  function load(key, loader, ttlMs) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      const value = await loader();
      const fetchedAt = now();
      entries.delete(key); // re-insert so the Map's order is "least recently loaded first"
      entries.set(key, { value, fetchedAt, expiresAt: fetchedAt + ttlMs, retryAt: 0 });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return entries.get(key);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  function view(entry, stale) {
    return { value: entry.value, fetchedAt: new Date(entry.fetchedAt).toISOString(), stale };
  }

  // Returns { value, fetchedAt, stale }.
  // Fresh entry: served as is. Expired entry: served at once marked stale, refreshed in the background.
  // No entry: waits for the loader; if it fails, the error reaches the caller.
  async function get(key, loader, { ttlMs }) {
    const entry = entries.get(key);
    if (entry && now() < entry.expiresAt) return view(entry, false);

    if (entry) {
      if (!inFlight.has(key) && now() >= entry.retryAt) {
        load(key, loader, ttlMs).catch((err) => {
          entry.retryAt = now() + retryDelayMs; // do not retry on every request while the portal is failing
          onRefreshError(key, err);
        });
      }
      return view(entry, true);
    }

    return view(await load(key, loader, ttlMs), false);
  }

  // Read without loading (used by /health).
  function peek(key) {
    const entry = entries.get(key);
    return entry ? view(entry, now() >= entry.expiresAt) : null;
  }

  return { get, peek, size: () => entries.size };
}
