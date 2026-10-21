// Service worker: è il "motore" che fa funzionare l'app senza internet.
// Al primo avvio salva tutti i file dell'app in una cache; poi li serve da lì.

const VERSION = 'scaffale-v1.11.0';
const OCR_CACHE = 'scaffale-ocr-v1';
const FONT_CACHE = 'scaffale-fonts-v1';
const SHARE_CACHE = 'scaffale-condivisi'; // file ricevuti da "Condividi" su Android, in attesa dell'app

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/catalog.js',
  './js/scanner.js',
  './js/ocr.js',
  './js/pdf.js',
  './vendor/pdf-lib.min.js',
  './js/reader.js',
  './js/drive.js',
  './js/sync.js',
  './js/importer.js',
  './vendor/jszip.min.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/pdfjs/wasm/jbig2.wasm',
  './vendor/pdfjs/wasm/openjpeg.wasm',
  './vendor/pdfjs/wasm/qcms_bg.wasm',
  './vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [VERSION, OCR_CACHE, FONT_CACHE, SHARE_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Android: Condividi → Scaffale. Il telefono manda i file con un POST all'indirizzo
  // indicato nel manifest ("share_target"); li metto da parte e apro l'app, che li aggiunge.
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/condividi')) {
    event.respondWith(receiveShared(req));
    return;
  }
  if (req.method !== 'GET') return;

  // File del lettore di testo (scaricati dall'app dentro la cache OCR)
  if (url.origin === location.origin && url.pathname.includes('/ocr/')) {
    event.respondWith(caches.open(OCR_CACHE).then(c => c.match(req.url))
      .then(r => r || new Response('OCR non scaricato', { status: 404 })));
    return;
  }

  // Font di Google: prima la cache, poi la rete (e aggiorna la cache)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONT_CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // File dell'app: dalla cache, con aggiornamento in sottofondo quando c'è rete
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await cache.match('./index.html') : null);
      const net = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
      if (hit) { event.waitUntil(net); return hit; }
      return (await net) || new Response('Offline', { status: 503 });
    })());
  }
  // Tutto il resto (ricerche libri online) passa direttamente alla rete
});

async function receiveShared(req) {
  let n = 0;
  try {
    const data = await req.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k); // avanzi di una condivisione precedente
    for (const f of data.getAll('libri')) {
      if (!f || typeof f === 'string' || !f.size) continue;
      await cache.put(new Request(`./condivisi/${n++}`), new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Nome': encodeURIComponent(f.name || 'libro') },
      }));
    }
  } catch (e) { /* l'app dirà che non ha ricevuto file */ }
  return Response.redirect(new URL(`./?condivisi=${n}`, self.registration.scope).href, 303);
}
