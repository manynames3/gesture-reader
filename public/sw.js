// Replaced by scripts/build-offline-manifest.mjs after the production build.
const OFFLINE_BUILD = "__OFFLINE_MANIFEST__";
const CACHE_PREFIX = "gesture-reader-";
const CACHE_NAME = `${CACHE_PREFIX}${OFFLINE_BUILD.revision}`;

async function offlineStatus() {
  const cache = await caches.open(CACHE_NAME);
  const available = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
  return { ready: OFFLINE_BUILD.assets.every((path) => available.has(path)), revision: OFFLINE_BUILD.revision, bytes: OFFLINE_BUILD.bytes };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      // The complete bundle includes lazy PDF/vision chunks and models.
      await cache.addAll(OFFLINE_BUILD.assets.map((url) => new Request(url, { cache: "reload" })));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const older = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    // Retain one older build for open tabs; never clear another app's caches.
    await Promise.all(older.slice(0, -1).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "OFFLINE_STATUS") {
    event.waitUntil(offlineStatus().then((status) => event.ports[0]?.postMessage(status)));
  } else if (event.data?.type === "OFFLINE_REPAIR") {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(OFFLINE_BUILD.assets.map((url) => new Request(url, { cache: "reload" })));
        event.ports[0]?.postMessage(await offlineStatus());
      } catch {
        event.ports[0]?.postMessage({ ready: false });
      }
    })());
  } else if (event.data?.type === "ACTIVATE_UPDATE") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Serve a consistent HTML/chunk generation. Updates wait for user approval.
    if (request.mode === "navigate") return (await cache.match("/")) || fetch(request);
    // The framework adds a per-request query to static homepage prefetches.
    // Serve this build's matching payload, not an HTML fallback or an old build.
    if (url.pathname === "/.rsc") {
      const rootPayload = await cache.match("/index.rsc");
      if (rootPayload) return rootPayload;
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    const older = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    for (const key of older.reverse()) {
      const previous = await (await caches.open(key)).match(request);
      if (previous) return previous;
    }
    return fetch(request);
  })());
});
