// App-shell service worker: screens and scorers boot with no network.
// Pages: network-first (fresh deploys win), falling back to cache. Assets: stale-while-revalidate.
// Never caches /api or /ws — live data always comes from the server or the app's own local store.
const CACHE = 'sportsdiary-shell-v2';
const SHELL = ['/', '/tv', '/score/_', '/live/_', '/styles.css', '/js/console.js', '/js/tv.js', '/js/score.js', '/js/live.js', '/icon.svg', '/manifest.webmanifest', '/brand/sports-diary.svg', '/brand/sports-diary-on-dark.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const pageKey = (url) => {
  const p = url.pathname;
  if (p.startsWith('/score/')) return '/score/_';
  if (p.startsWith('/live/') || p.startsWith('/t/')) return '/live/_';
  if (p.startsWith('/tv') || p.startsWith('/overlay')) return '/tv';
  return '/';
};

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/share/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(pageKey(url), copy));
          return res;
        })
        .catch(() => caches.match(pageKey(url)).then((r) => r || caches.match('/'))),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
