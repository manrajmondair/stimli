// One-shot sessionStorage handoffs (consume-on-read) must survive React
// StrictMode's deliberate double invocation in dev: useState initializers,
// useMemo callbacks, and mount effects all run twice, and a naive
// read-and-remove hands the first invocation the payload and the second one
// nothing — the second result wins, so the handoff is silently lost in dev
// while working in prod. The fix: the first read consumes the key and caches
// the parsed value; the synchronous re-invocation reads the cache; the cache
// clears itself on the next microtask, preserving one-shot semantics for any
// later, genuine read.
const onceCache = new Map<string, unknown>();

export function consumeOnce<T>(key: string, parse: (raw: string) => T | null): T | null {
  if (onceCache.has(key)) {
    return onceCache.get(key) as T | null;
  }
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(key);
    if (raw !== null) window.sessionStorage.removeItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: T | null = null;
  try {
    value = parse(raw);
  } catch {
    value = null;
  }
  onceCache.set(key, value);
  queueMicrotask(() => onceCache.delete(key));
  return value;
}
