/**
 * Voicescape push service worker — tip notifications ONLY.
 *
 * Deliberately cache-free. An earlier caching service worker caused
 * persistent stale-chunk incidents (see git log), so this worker handles
 * push events and nothing else: no fetch handler, no Cache Storage writes.
 * Push delivery does not need caching.
 */

self.addEventListener("install", (event) => {
  // Take over immediately so newly-enabled notifications work without a reload.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Clean up any caches left behind by the old caching worker.
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* Cache API unavailable — nothing to clean. */
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* Non-JSON payload — fall back to defaults below. */
  }
  const title =
    typeof payload.title === "string" && payload.title ? payload.title : "Voicescape";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = typeof payload.url === "string" && payload.url ? payload.url : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
      // No `tag`: every tip is its own notification.
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl =
    event.notification.data && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/";
  event.waitUntil(
    (async () => {
      const target = new URL(rawUrl, self.location.origin);
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        try {
          if (new URL(client.url).origin === target.origin) {
            if ("navigate" in client && typeof client.navigate === "function") {
              await client.navigate(target.toString());
            }
            await client.focus();
            return;
          }
        } catch {
          /* Malformed URL — fall through to openWindow. */
        }
      }
      await self.clients.openWindow(target.toString());
    })(),
  );
});
