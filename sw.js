const CACHE = 'weather-tracker-v1';
const SHELL = ['./', './index.html', './browse.html', './trends.html', './style.css', './app.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const DATA = ['./data/history.csv', './data/status.json'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([...SHELL, ...DATA].map(url => new Request(url, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE && name.startsWith('weather-tracker-')) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
const urls = new Set([...SHELL, ...DATA].map(path => new URL(path, self.registration.scope).href));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate') url.search = '';
  if (!urls.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        await cache.put(url.href, response.clone());
        return response;
      }
      return await cache.match(url.href) || response;
    } catch (error) {
      const cached = await cache.match(url.href);
      if (cached) return cached;
      throw error;
    }
  })());
});
