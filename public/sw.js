const CACHE = 'memorphilia-v1';
const PRECACHE = ['/', '/favicon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// API 요청은 캐시 제외, 나머지는 캐시 우선
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return; // API는 항상 네트워크
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
