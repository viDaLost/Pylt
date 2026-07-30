const CACHE_NAME = "kadr-app-shell-v11";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./enhanced-alerts.css",
  "./chat.css",
  "./voice.css",
  "./app.js",
  "./enhanced-alerts.js",
  "./chat.js",
  "./turn-config.js",
  "./voice-v2.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/app-icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./screenshots/phone.png",
  "./screenshots/desktop.png"
];

const NETWORK_FIRST_PATHS = new Set([
  "/index.html",
  "/firebase-config.js",
  "/app.js",
  "/enhanced-alerts.js",
  "/chat.js",
  "/turn-config.js",
  "/voice-v2.js",
  "/styles.css",
  "/enhanced-alerts.css",
  "/chat.css",
  "/voice.css",
  "/manifest.webmanifest"
]);

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

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const relativePath = `/${url.pathname.split("/").pop() || ""}`;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  if (NETWORK_FIRST_PATHS.has(relativePath)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      if (!("focus" in client)) continue;
      await client.focus();
      if ("navigate" in client) await client.navigate(targetUrl);
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

async function networkFirst(request, fallbackPath = null) {
  try {
    const response = await fetch(request);
    if (response?.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackPath) return caches.match(fallbackPath);
    return new Response("Нет подключения к интернету", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const update = fetch(request)
    .then(async (response) => {
      if (response?.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || await update || new Response("", { status: 504 });
}
