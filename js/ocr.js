// Lettura del testo dalle foto (OCR) con Tesseract, eseguito interamente sul telefono.
// I file del motore vengono scaricati una sola volta e salvati nella cache dell'app,
// sotto indirizzi locali (./ocr/...). Il service worker li serve poi anche offline.

const CACHE = 'scaffale-ocr-v1';
const BASE = new URL('./ocr/', location.href).href;

const FILES = [
  {
    local: 'tesseract.min.js',
    urls: ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
           'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'],
  },
  {
    local: 'worker.min.js',
    urls: ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
           'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js'],
  },
  {
    local: 'core/tesseract-core-simd-lstm.wasm.js',
    urls: ['https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js',
           'https://unpkg.com/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js'],
  },
  {
    local: 'lang/ita.traineddata.gz',
    urls: ['https://cdn.jsdelivr.net/npm/@tesseract.js-data/ita/4.0.0_best_int/ita.traineddata.gz',
           'https://tessdata.projectnaptha.com/4.0.0_best/ita.traineddata.gz'],
  },
];

export async function ocrReady() {
  if (!('caches' in window)) return false;
  const c = await caches.open(CACHE);
  for (const f of FILES) if (!(await c.match(BASE + f.local))) return false;
  return true;
}

export async function downloadOcr(onProgress) {
  const c = await caches.open(CACHE);
  let done = 0;
  for (const f of FILES) {
    if (await c.match(BASE + f.local)) { done++; onProgress && onProgress(done / FILES.length); continue; }
    let ok = false, lastErr;
    for (const url of f.urls) {
      try {
        const r = await fetch(url, { mode: 'cors' });
        if (!r.ok) throw new Error(`${r.status} su ${url}`);
        const blob = await r.blob();
        const type = f.local.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
        await c.put(BASE + f.local, new Response(blob, { headers: { 'Content-Type': type } }));
        ok = true; break;
      } catch (e) { lastErr = e; }
    }
    if (!ok) throw new Error('Download non riuscito: ' + (lastErr && lastErr.message));
    done++; onProgress && onProgress(done / FILES.length);
  }
}

export async function removeOcr() {
  worker && (await worker.terminate().catch(() => {}));
  worker = null;
  await caches.delete(CACHE);
}

let worker = null;
let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Impossibile caricare il motore OCR'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (worker) return worker;
  if (loading) return loading;
  loading = (async () => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      throw new Error("Chiudi e riapri l'app una volta, poi riprova.");
    }
    await loadScript(BASE + 'tesseract.min.js');
    worker = await window.Tesseract.createWorker('ita', 1, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE + 'core/tesseract-core-simd-lstm.wasm.js',
      langPath: BASE + 'lang',
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none', // i file sono già nella cache dell'app
    });
    return worker;
  })();
  try { return await loading; } finally { loading = null; }
}

// Prepara l'immagine: ridimensiona e converte in scala di grigi con più contrasto.
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const max = 1800;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    y = Math.max(0, Math.min(255, (y - 128) * 1.35 + 128));
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// Restituisce le righe di testo riconosciute, ripulite dal "rumore".
export async function recognize(file) {
  const w = await getWorker();
  const canvas = await prepare(file);
  const { data } = await w.recognize(canvas);
  const text = data.text || '';
  const lines = text.split('\n')
    .map(l => l.replace(/[|_~^`*<>{}\[\]\\]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l.length >= 2 && /[A-Za-zÀ-ÿ0-9]{2}/.test(l))
    .filter((l, i, a) => a.indexOf(l) === i);
  return { text, lines };
}
