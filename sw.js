// sw.js — service worker de solo el app-shell (Fase 6, plan §5). Cachea los
// estáticos para que la PWA abra offline en el iPhone. NO intercepta llamadas
// al Apps Script (otro origen) — el offline de datos ya lo resuelve IndexedDB
// + outbox (app.js), esto es solo para que la página misma cargue sin red.
const CACHE_NAME = 'gymv2-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './manifest.webmanifest',
  './data/rutina-6dias.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // deja pasar Apps Script tal cual
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => cached);
      // cache-first para que abra instantáneo offline; refresca en segundo plano si hay red
      return cached || network;
    })
  );
});
