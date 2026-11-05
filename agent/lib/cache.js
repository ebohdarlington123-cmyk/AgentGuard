// Tiny in-process TTL cache for hot view/RPC/price lookups.
const store = new Map();

export function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.exp > now) return hit.val;

  // Store the in-flight promise immediately so concurrent callers share one fetch
  // and so TTL starts from request time (not resolution time).
  let settled;
  try {
    settled = fn();
  } catch (e) {
    store.delete(key);
    throw e;
  }
  if (settled && typeof settled.then === 'function') {
    const p = settled.then(
      (v) => v,
      (e) => {
        // don't cache failures — next caller retries
        const cur = store.get(key);
        if (cur && cur.val === p) store.delete(key);
        throw e;
      },
    );
    store.set(key, { exp: now + ttlMs, val: p });
    return p;
  }
  store.set(key, { exp: now + ttlMs, val: Promise.resolve(settled) });
  return settled;
}

export function cacheClear(prefix) {
  if (!prefix) { store.clear(); return; }
  for (const k of store.keys()) if (String(k).startsWith(prefix)) store.delete(k);
}

export function cacheStats() { return { size: store.size, keys: [...store.keys()] }; }
