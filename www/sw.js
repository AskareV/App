// Service worker de la versión web (la de Netlify). No se usa dentro de la app Android.
//
// Primero intenta traer cada archivo de internet, así siempre se carga la última versión
// publicada; si no hay conexión, usa la copia guardada. Al activarse borra las cachés de
// versiones anteriores, para que una versión vieja no se quede "pegada".
const CACHE = 'mis-finanzas-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      // Sin conexión y abriendo otra dirección del sitio: se muestra la app
      if (req.mode === 'navigate') {
        const page = (await caches.match('index.html')) || (await caches.match('./'));
        if (page) return page;
      }
      throw err;
    }
  })());
});
