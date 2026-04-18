const CACHE = 'memorphilia-v5';
const PRECACHE = ['/favicon.svg', '/manifest.json', '/icon-32.png', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

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

self.addEventListener('fetch', e => {
  // API 요청: 항상 네트워크
  if (e.request.url.includes('/api/')) return;

  // 외부 CDN (폰트, Flatpickr 등): 캐시 우선, 없으면 네트워크 후 캐시 저장
  if (!e.request.url.startsWith(self.location.origin)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // index.html / 페이지 탐색: 네트워크 우선 (항상 최신 버전)
  if (e.request.mode === 'navigate' ||
      e.request.url.endsWith('/') ||
      e.request.url.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // 아이콘, manifest 등 정적 파일: 캐시 우선
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
