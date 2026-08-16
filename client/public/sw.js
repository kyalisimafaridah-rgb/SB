// Bug 30: Version the cache name so new deployments immediately bust the old cache.
// Strategy:
//   - HTML navigation requests: network-first (users always get the latest shell)
//   - Versioned static assets (JS/CSS with content hashes): cache-first (safe, immutable)
//   - Everything else: network-first with cache fallback
const CACHE_NAME = "scholarbase-v2";

self.addEventListener("install", (event) => {
  // Pre-cache the app shell immediately on install
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/manifest.json"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Delete all old cache versions on activation
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.url.includes("/trpc/")) return;
  if (event.request.url.includes("/api/")) return;

  const url = new URL(event.request.url);

  // HTML navigation (including /) — network-first so deployments are picked up immediately
  const isNavigation =
    event.request.mode === "navigate" ||
    event.request.headers.get("accept")?.includes("text/html");

  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)) // offline fallback only
    );
    return;
  }

  // Vite's hashed build output always lives under /assets/ (confirmed
  // against vite.config.ts — no custom assetsDir, so this is Vite's
  // documented default), and nothing manually placed in client/public/ is
  // ever served from there. Anchoring to the path, not a guessed hash shape,
  // means this can never accidentally catch a manually-named static file
  // (a PWA icon, a favicon) that happens to have a long hyphenated name —
  // apple-touch-icon.png and maskable-icon-512x512.png both would have
  // matched the previous pattern-based check, and once wrongly cached
  // cache-first, an updated icon would never be picked up without a
  // filename change or a manual CACHE_NAME bump.
  const isVersionedAsset = url.pathname.startsWith("/assets/");

  if (isVersionedAsset) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first, cache as fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
