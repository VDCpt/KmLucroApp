/* ================================================================
   KmLucro — sw.js  v4
   Cache-first para assets locais.
   Nunca intercepta Firebase/Google/Stripe — precisam de rede.
================================================================ */
const CACHE = 'kmlucro-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', e =>
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  )
);

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* Nunca interceptar Firebase, Google, Stripe, recaptcha */
  if (
    e.request.method !== 'GET' ||
    url.includes('firebaseio.com') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('recaptcha') ||
    url.includes('stripe.com')
  ) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')); /* SPA fallback */
    })
  );
});
