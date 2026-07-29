const CACHE_NAME = "camera-cue-shell-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./enhanced-alerts.css",
  "./chat.css",
  "./app.js",
  "./enhanced-alerts.js",
  "./chat.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (
    request.mode === "navigate" ||
    url.pathname.endsWith("/firebase-config.js") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/enhanced-alerts.js") ||
    url.pathname.endsWith("/chat.js") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/enhanced-alerts.css") ||
    url.pathname.endsWith("/chat.css")
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      if ("focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(targetUrl);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || caches.match("./index.html");
  }
}
