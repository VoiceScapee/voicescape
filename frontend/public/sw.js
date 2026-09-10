/* Voicescape service worker — safe, minimal PWA caching.
 *
 * Rules:
 * - API routes (/api/*) and non-GET requests: network only, never cached.
 * - Static assets (/_next/static/, /icons/, fonts, images): cache-first.
 * - Page navigations: network-first, fall back to cache when offline.
 *
 * The worker never intercepts wallet, HCS, or contract traffic (those go to
 * external hosts), and it never caches authenticated API responses.
 */

const STATIC_CACHE = "voicescape-static-v1";
const PAGES_CACHE = "voicescape-pages-v1";

self.addEventListener("install", (event) => {
  // Activate immediately so the new worker takes over without a reload.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== PAGES_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/manifest.json" ||
    /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never cache API responses (sessions, HCS, quotas, etc.).
  if (url.pathname.startsWith("/api/")) return;

  if (isStaticAsset(url)) {
    // Cache-first for versioned/hashed static assets.
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })()
    );
    return;
  }

  // Page navigations: network-first, offline fallback to cache.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES_CACHE);
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          const hit = await cache.match(request);
          if (hit) return hit;
          const home = await cache.match("/");
          if (home) return home;
          throw new Error("offline");
        }
      })()
    );
  }
});
