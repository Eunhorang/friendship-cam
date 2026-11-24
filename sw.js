// 우정 사진관 카메라: 한 번 열어 두면 인터넷이 없어도 열리게 화면 파일을 담아 둔다.
// 파일을 고치면 CACHE 숫자와 index.html의 ?v= 숫자를 함께 올린다.
const CACHE = 'friendship-cam-4';
const FILES = [
  './',
  './index.html',
  './style.css?v=4',
  './app.js?v=4',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-512.png',
  './fonts/Jua-Regular.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// 페이지는 새 판이 있으면 받아 오고(2.5초 안에 안 오면 담아 둔 것), 나머지 파일은 담아 둔 것을 먼저 쓴다.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      try {
        const fresh = await Promise.race([
          fetch(request),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
        ]);
        if (fresh.ok) (await caches.open(CACHE)).put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
