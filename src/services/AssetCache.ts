type CacheEntry<T = unknown> = {
  data: T;
  timestamp: number;
};

const STALE_MS = 60_000;
const MAX_CACHE_SIZE = 100;

const cache = new Map<string, CacheEntry>();

export function getCached<T>(key: string): { data: T; stale: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  const stale = Date.now() - entry.timestamp > STALE_MS;
  return { data: entry.data as T, stale };
}

export function setCached<T>(key: string, data: T): void {
  cache.delete(key);
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function invalidate(keyOrPrefix: string): void {
  if (cache.has(keyOrPrefix)) {
    cache.delete(keyOrPrefix);
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(keyOrPrefix)) cache.delete(k);
  }
}

export function invalidateAll(): void {
  cache.clear();
}

async function fetchAndCache<T>(key: string, url: string, extract: (d: any) => T): Promise<T> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return (getCached<T>(key)?.data ?? ([] as unknown as T));
    const json = await res.json();
    const data = extract(json);
    setCached(key, data);
    return data;
  } catch {
    return (getCached<T>(key)?.data ?? ([] as unknown as T));
  }
}

export async function prefetchAll(): Promise<void> {
  const fetches = [
    fetchAndCache("assets:image", "/api/assets?type=image", (d) => d.assets || []),
    fetchAndCache("assets:video", "/api/assets?type=video", (d) => d.assets || []),
    fetchAndCache("axioms:personal", "/api/axioms", (d) => d.axioms || []),
    fetchAndCache("audio:music", "/api/audio?class=music", (d) => d.audio_assets || []),
    fetchAndCache("audio:voice", "/api/audio?class=voice", (d) => d.audio_assets || []),
    fetchAndCache("audio:sound_effect", "/api/audio?class=sound_effect", (d) => d.audio_assets || []),
    fetchAndCache("folders:image", "/api/folders?type=image", (d) => d.folders || []),
    fetchAndCache("folders:video", "/api/folders?type=video", (d) => d.folders || []),
    fetchAndCache("folders:music", "/api/folders?type=music", (d) => d.folders || []),
    fetchAndCache("folders:voice", "/api/folders?type=voice", (d) => d.folders || []),
    fetchAndCache("folders:sound_effect", "/api/folders?type=sound_effect", (d) => d.folders || []),
    fetchAndCache("buckets:axiom:personal", "/api/buckets?type=axiom", (d) => d.buckets || []),
    fetchAndCache("buckets:style:personal", "/api/buckets?type=style", (d) => d.buckets || []),
  ];
  await Promise.allSettled(fetches);
}

export { fetchAndCache };
