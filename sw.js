// Service worker: deixa o site abrir sem internet (os dados ficam no aparelho e sobem ao Drive depois).
const CACHE = 'geplan-v1';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/schedule.js', './js/drive.js', './js/export.js', './js/config.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // APIs do Google nunca passam pelo cache
  if (url.hostname.endsWith('googleapis.com') || url.hostname === 'accounts.google.com') return;

  // Bibliotecas de exportação (CDN): cache após o primeiro uso
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }

  // Arquivos do site: rede primeiro (para pegar atualizações), cache se estiver offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))));
  }
});
