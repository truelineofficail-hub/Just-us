/* =========================================================
   service-worker.js — caches the app shell so Just Us opens
   instantly and works offline once it has been visited.

   What this does NOT do: it never talks to a server for your
   notes/messages/photos — those live only in this device's
   IndexedDB (see js/db.js). This worker only caches the static
   files that make up the app itself (HTML/CSS/JS/icons).
   ========================================================= */

const CACHE_NAME = "just-us-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/utils.js",
  "./js/db.js",
  "./js/webrtc.js",
  "./js/sync.js",
  "./js/chat.js",
  "./js/notes.js",
  "./js/tasks.js",
  "./js/memories.js",
  "./js/missyou.js",
  "./js/location.js",
  "./js/call.js",
  "./js/settings.js",
  "./js/app.js",
  "./assets/icon-32.png",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Never cache calls that leave the origin (e.g. a user-added song URL,
  // or the Google Fonts stylesheet) — only the app shell itself.
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
