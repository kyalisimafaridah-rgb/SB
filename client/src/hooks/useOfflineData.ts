import { useEffect, useState } from "react";
import { cacheGet, cacheSet } from "../lib/offlineDb";

// Wraps a live query's {data, isLoading, isError} with a persistent IndexedDB
// fallback: whenever the live query succeeds, the result is saved; whenever
// it's unavailable (offline, or a network error), the last saved copy is
// served instead so the page has real data to render rather than going
// blank. The cache key can carry extra scoping beyond schoolId (e.g. a
// specific student's fee records) by passing a composite string.
export function useOfflineData<T>(
  store: string,
  cacheKey: number | string | undefined,
  live: { data: T | undefined; isLoading: boolean; isError: boolean }
): { data: T | undefined; isOffline: boolean; cachedAt: string | null; isLoading: boolean } {
  const [cached, setCached] = useState<{ data: T; cachedAt: string } | undefined>(undefined);
  const [cacheChecked, setCacheChecked] = useState(false);

  useEffect(() => {
    setCacheChecked(false);
    setCached(undefined); // don't serve the previous key's data under the new key
    if (cacheKey == null) return;
    let cancelled = false;
    cacheGet<T>(store, cacheKey).then((c) => {
      if (!cancelled) { setCached(c); setCacheChecked(true); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, cacheKey]);

  useEffect(() => {
    if (live.data !== undefined && cacheKey != null) {
      void cacheSet(store, cacheKey, live.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.data, store, cacheKey]);

  if (live.data !== undefined) {
    return { data: live.data, isOffline: false, cachedAt: null, isLoading: false };
  }
  if (cached) {
    return { data: cached.data, isOffline: true, cachedAt: cached.cachedAt, isLoading: false };
  }
  return { data: undefined, isOffline: live.isError, cachedAt: null, isLoading: live.isLoading && !cacheChecked };
}
