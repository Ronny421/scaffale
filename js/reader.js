// Lettore integrato: PDF con PDF.js, EPUB aperti con JSZip e impaginati a colonne.
// Il lettore non conosce lo scaffale: comunica la posizione con onProgress, e l'app
// la trasforma nel segnalibro.

const VENDOR = new URL('../vendor/', import.meta.url).href;

// ---------------------------------------------------------------- librerie
let pdfjsPromise = null;
export function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(VENDOR + 'pdfjs/pdf.min.js').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdfjs/pdf.worker.min.js';
      return lib;
    });
  }
  return pdfjsPromise;
}

// Opzioni comuni a ogni PDF aperto da Scaffale (lettore e importazione)
export function pdfOptions() {
  return {
    wasmUrl: VENDOR + 'pdfjs/wasm/',   // decodificatori per i PDF scansionati (JBIG2, JPEG 2000)
    iccUrl: VENDOR + 'pdfjs/iccs/',
    isEvalSupported: false,            // un PDF non può eseguire codice
    enableXfa: false,
  };
}

let jszipPromise = null;
export function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = VENDOR + 'jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { jszipPromise = null; reject(new Error('Impossibile caricare il lettore EPUB')); };
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

// ---------------------------------------------------------------- PDF
// Due modalità:
//   'pages'  pagine affiancate in orizzontale: si sfogliano trascinando, la pagina segue
//            il dito e si ferma sulla successiva (scroll-snap del browser)
//   'scroll' pagine una sotto l'altra, scorrimento continuo in verticale
// Si disegnano solo le pagine vicine allo schermo: un IntersectionObserver segnala
// quali stanno per entrare nell'inquadratura e quali si sono allontanate.

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Scorrimento verticale di quasi uno schermo. Se uno scorrimento animato è ancora in corso,
// il nuovo passo parte dalla sua destinazione: così tocchi rapidi su «avanti» si sommano.
function stepScroll(owner, el, dir, viewH) {
  const now = performance.now();
  const base = owner.vTarget != null && now < owner.vUntil ? owner.vTarget : el.scrollTop;
  const max = el.scrollHeight - el.clientHeight;
  owner.vTarget = Math.max(0, Math.min(max, base + dir * viewH * 0.9));
  owner.vUntil = now + 700;
  el.scrollTo({ top: owner.vTarget, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

class PdfEngine {
  constructor(view, report, opts) {
    this.view = view;
    this.report = report;
    this.mode = opts.mode === 'scroll' ? 'scroll' : 'pages';
    this.zoom = 1;
    this.page = 1;
    this.canvases = new Map(); // indice -> canvas disegnato
    this.tasks = new Map();    // indice -> disegno in corso
    this.layoutKey = 0;        // cambia a ogni nuova impaginazione: i disegni vecchi si scartano
  }

  async load(blob) {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await blob.arrayBuffer());
    // In PDF.js si chiude il "compito di caricamento", non il documento: lo tengo da parte
    this.loadingTask = pdfjs.getDocument({ data, ...pdfOptions() });
    this.doc = await this.loadingTask.promise;
    this.count = this.doc.numPages;
    // Finché una pagina non è stata aperta, uso le dimensioni della prima
    const vp = (await this.doc.getPage(1)).getViewport({ scale: 1 });
    this.base = { w: vp.width, h: vp.height };
    this.sizes = new Array(this.count).fill(null);
    this.sizes[0] = { ...this.base };

    this.view.innerHTML = '<div class="pdf-scroll"><div class="pdf-strip"></div></div>';
    this.scroller = this.view.firstElementChild;
    this.strip = this.scroller.firstElementChild;
    const frag = document.createDocumentFragment();
    this.cells = [];
    for (let i = 0; i < this.count; i++) {
      const cell = document.createElement('div');
      cell.className = 'pdf-cell';
      cell.dataset.i = i;
      const slot = document.createElement('div');
      slot.className = 'pdf-slot';
      cell.appendChild(slot);
      frag.appendChild(cell);
      this.cells.push(cell);
    }
    this.strip.appendChild(frag);
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    // Se tocchi lo schermo, comanda il dito: dimentico le destinazioni delle animazioni
    const reset = () => { this.pending = 0; this.vTarget = null; };
    this.scroller.addEventListener('touchstart', reset, { passive: true });
    this.scroller.addEventListener('wheel', reset, { passive: true });
    this.layout();
  }

  size(i) { return this.sizes[i] || this.base; }

  scaleFor(i) {
    const s = this.size(i);
    const W = this.scroller.clientWidth, H = this.scroller.clientHeight, pad = 12;
    if (this.mode === 'scroll') return Math.max(0.1, (W - 2 * pad) / s.w) * this.zoom;           // larghezza dello schermo
    return Math.max(0.1, Math.min((W - 2 * pad) / s.w, (H - 2 * pad) / s.h)) * this.zoom;         // pagina intera
  }

  sizeCell(i) {
    const s = this.size(i), k = this.scaleFor(i);
    const slot = this.cells[i].firstElementChild;
    slot.style.width = Math.floor(s.w * k) + 'px';
    slot.style.height = Math.floor(s.h * k) + 'px';
  }

  // Nuova impaginazione: modalità, ingrandimento o dimensioni dello schermo cambiati
  layout(keep) {
    this.scroller.className = 'pdf-scroll ' + (this.mode === 'scroll' ? 'mode-v' : 'mode-h');
    this.strip.style.setProperty('--cell-w', this.scroller.clientWidth + 'px');
    this.clearCanvases();
    for (let i = 0; i < this.count; i++) this.sizeCell(i);
    if (keep) this.restore(keep);
    this.observe();
  }

  observe() {
    if (this.io) this.io.disconnect();
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const i = +e.target.dataset.i;
        if (e.isIntersecting) this.renderPage(i); else this.dropPage(i);
      }
    }, { root: this.scroller, rootMargin: this.mode === 'scroll' ? '120% 0px' : '0px 110%' });
    for (const c of this.cells) this.io.observe(c);
  }

  async renderPage(i) {
    const key = this.layoutKey;
    if (this.canvases.has(i) || this.tasks.has(i)) return;
    this.tasks.set(i, null);
    try {
      const page = await this.doc.getPage(i + 1);
      if (key !== this.layoutKey || !this.tasks.has(i)) return; // nel frattempo si è allontanata
      // Dimensioni vere della pagina: se diverse dalla stima, correggo il riquadro
      const v1 = page.getViewport({ scale: 1 });
      const s = this.sizes[i];
      if (!s || Math.abs(s.w - v1.width) > 0.5 || Math.abs(s.h - v1.height) > 0.5) {
        this.sizes[i] = { w: v1.width, h: v1.height };
        this.resizeCell(i);
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = page.getViewport({ scale: this.scaleFor(i) * dpr });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      this.tasks.set(i, task);
      await task.promise;
      if (key !== this.layoutKey || !this.tasks.has(i)) { canvas.width = canvas.height = 0; return; }
      this.cells[i].firstElementChild.replaceChildren(canvas);
      this.canvases.set(i, canvas);
    } catch (err) {
      if (!(err && err.name === 'RenderingCancelledException')) console.warn('Pagina', i + 1, err);
    } finally {
      if (key === this.layoutKey) this.tasks.delete(i);
    }
  }

  // Pagina lontana dallo schermo: libero la memoria del suo disegno
  dropPage(i) {
    const t = this.tasks.get(i);
    if (t) t.cancel();
    this.tasks.delete(i);
    const c = this.canvases.get(i);
    if (c) { c.width = c.height = 0; c.remove(); this.canvases.delete(i); }
  }

  clearCanvases() {
    for (const i of new Set([...this.tasks.keys(), ...this.canvases.keys()])) this.dropPage(i);
    this.layoutKey++;
  }

  // Una pagina sopra quella che stai leggendo ha cambiato altezza: compenso lo scorrimento
  resizeCell(i) {
    if (this.mode !== 'scroll') { this.sizeCell(i); return; }
    const cell = this.cells[i], before = cell.offsetHeight;
    this.sizeCell(i);
    const delta = cell.offsetHeight - before;
    if (delta && cell.offsetTop < this.scroller.scrollTop) this.scroller.scrollTop += delta;
  }

  onScroll() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const n = this.currentIndex() + 1;
      // Durante uno scorrimento animato la pagina "vera" è la destinazione
      if (this.pending) {
        if (n === this.pending || performance.now() > this.pendingUntil) this.pending = 0;
        else return;
      }
      if (n !== this.page) { this.page = n; this.report(); }
    });
  }

  currentIndex() {
    const sc = this.scroller;
    if (this.mode === 'pages') return Math.min(this.count - 1, Math.max(0, Math.round(sc.scrollLeft / sc.clientWidth)));
    const y = sc.scrollTop + sc.clientHeight * 0.4; // la pagina che occupa il punto di lettura
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cells[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Posizione dentro la pagina corrente (0 = inizio), per non perderla quando si reimpagina
  snapshot() {
    const i = this.page - 1, c = this.cells[i], sc = this.scroller;
    const frac = this.mode === 'scroll' ? (sc.scrollTop - c.offsetTop) / Math.max(1, c.offsetHeight) : 0;
    return { i, frac: Math.max(0, Math.min(1, frac)) };
  }
  restore({ i, frac }) {
    const c = this.cells[i], sc = this.scroller;
    if (this.mode === 'scroll') sc.scrollTop = c.offsetTop + frac * c.offsetHeight;
    else sc.scrollLeft = i * sc.clientWidth;
  }

  scrollToPage(p, smooth) {
    const i = Math.min(this.count, Math.max(1, p)) - 1;
    const sc = this.scroller, behavior = smooth && !reducedMotion() ? 'smooth' : 'auto';
    if (this.mode === 'pages') sc.scrollTo({ left: i * sc.clientWidth, behavior });
    else sc.scrollTo({ top: Math.max(0, this.cells[i].offsetTop - 8), behavior });
    this.page = i + 1;
    if (behavior === 'smooth') { this.pending = this.page; this.pendingUntil = performance.now() + 900; }
    else this.pending = 0;
    this.vTarget = null;
    this.report();
  }

  async goTo(pos) {
    let p = 1;
    if (pos && pos.page) p = pos.page;
    else if (pos && typeof pos.fraction === 'number') p = Math.round(pos.fraction * this.count);
    this.scrollToPage(p, false);
  }

  position() {
    return { kind: 'pdf', page: this.page, fraction: this.page / this.count, label: `${this.page} / ${this.count}` };
  }
  units() { return this.count; }

  async next() {
    if (this.mode === 'pages') return this.scrollToPage((this.pending || this.page) + 1, true);
    stepScroll(this, this.scroller, 1, this.scroller.clientHeight); // quasi uno schermo, con una riga di riferimento
  }
  async prev() {
    if (this.mode === 'pages') return this.scrollToPage((this.pending || this.page) - 1, true);
    stepScroll(this, this.scroller, -1, this.scroller.clientHeight);
  }
  async goToFraction(f) { this.scrollToPage(Math.max(1, Math.round(f * this.count)), false); }
  // Passi di ingrandimento: 1 = pagina adattata allo schermo; sotto 1 la pagina si rimpicciolisce
  zoomBy(dir) {
    const steps = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];
    let i = steps.findIndex(z => Math.abs(z - this.zoom) < 0.01);
    if (i < 0) i = steps.indexOf(1);
    const next = steps[Math.min(steps.length - 1, Math.max(0, i + dir))];
    if (next === this.zoom) return;
    const k = this.snapshot();
    this.zoom = next;
    this.layout(k);
  }
  async bigger() { this.zoomBy(1); }
  async smaller() { this.zoomBy(-1); }
  async relayout() { const k = this.snapshot(); this.layout(k); }
  async setMode(mode) {
    if (mode === this.mode) return;
    const { i } = this.snapshot();
    this.mode = mode;
    this.layout({ i, frac: 0 });
    this.report();
  }
  destroy() {
    if (this.io) this.io.disconnect();
    this.clearCanvases();
    if (this.loadingTask) this.loadingTask.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------- EPUB
// Un EPUB è un archivio ZIP di pagine web (XHTML) più un indice (il file OPF) che
// dice in che ordine leggerle: lo "spine", la spina dorsale del libro.

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MIME = {
  css: 'text/css', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
  woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4',
};
export const mimeOf = path => MIME[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
export const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');

// Risolve un percorso relativo dentro l'archivio ("../Images/a.jpg" da "OEBPS/Text/")
export function join(base, rel) {
  if (!rel) return '';
  rel = rel.split('#')[0];
  try { rel = decodeURIComponent(rel); } catch (e) { /* lascio com'è */ }
  if (/^[a-z]+:/i.test(rel)) return rel; // indirizzo esterno
  const parts = (rel.startsWith('/') ? rel.slice(1) : base + rel).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

// Protezione DRM: il negozio cifra i capitoli e solo i dispositivi e le app autorizzati hanno
// la chiave per leggerli. Va distinta dall'"offuscamento" dei font, che nasconde solo i
// caratteri incorporati e lascia leggibile il testo: in quel caso il libro si apre.
const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

export async function epubProtection(zip) {
  const encrypted = new Set();
  const enc = zip.file('META-INF/encryption.xml');
  if (enc) {
    const doc = parseXml(await enc.async('string'));
    for (const ed of doc.getElementsByTagNameNS('*', 'EncryptedData')) {
      const method = ed.getElementsByTagNameNS('*', 'EncryptionMethod')[0];
      const ref = ed.getElementsByTagNameNS('*', 'CipherReference')[0];
      const alg = (method && method.getAttribute('Algorithm')) || '';
      const uri = (ref && ref.getAttribute('URI')) || '';
      if (uri && !FONT_OBFUSCATION.includes(alg)) encrypted.add(join('', uri));
    }
  }
  const kind = zip.file('META-INF/rights.xml') ? 'adobe'        // Adobe (ADEPT)
    : zip.file('META-INF/license.lcpl') ? 'lcp'                  // Readium LCP
    : zip.file('META-INF/sinf.xml') ? 'apple'                    // Apple FairPlay
    : encrypted.size ? 'protected' : '';
  return { kind, encrypted };
}

// Un capitolo cifrato è una sequenza di byte casuali: niente a che vedere con un testo
export function looksEncrypted(bytes) {
  const n = Math.min(bytes.length, 1024);
  if (!n) return false;
  if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)) return false; // UTF-16
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b < 9 || (b > 13 && b < 32) || b === 127) odd++;
  }
  return odd / n > 0.05;
}

export function drmError() {
  const err = new Error('il file è protetto da DRM');
  err.code = 'drm';
  return err;
}

// Due modalità anche per gli EPUB:
//   'pages'  ogni capitolo impaginato in colonne larghe quanto lo schermo; trascinando,
//            la pagina segue il dito e poi si ferma sulla successiva
//   'scroll' l'intero libro in un unico documento, che scorre in verticale senza interruzioni
class EpubEngine {
  constructor(view, report, opts) {
    this.view = view;
    this.report = report;
    this.mode = opts.mode === 'scroll' ? 'scroll' : 'pages';
    this.fontScale = opts.fontScale || 100;
    this.colors = opts.colors;
    this.onTap = opts.onTap;
    this.onKey = opts.onKey;
    this.urls = new Map(); // percorso nell'archivio -> indirizzo blob
    this.chapter = 0;
    this.page = 0;
    this.pages = 1;
    this.frac = 0;
  }

  async load(blob) {
    const JSZip = await loadJsZip();
    this.zip = await JSZip.loadAsync(blob);
    const container = parseXml(await this.text('META-INF/container.xml'));
    const rootfile = container.querySelector('rootfile');
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('Questo EPUB non ha un indice valido');
    const opfDir = dirOf(opfPath);
    const opf = parseXml(await this.text(opfPath));
    const items = new Map();
    for (const it of opf.querySelectorAll('manifest > item')) {
      items.set(it.getAttribute('id'), { href: join(opfDir, it.getAttribute('href')), type: it.getAttribute('media-type') || '' });
    }
    this.spine = [...opf.querySelectorAll('spine > itemref')]
      .filter(r => r.getAttribute('linear') !== 'no')
      .map(r => items.get(r.getAttribute('idref')))
      .filter(it => it && /html/.test(it.type) && this.zip.file(it.href));
    if (!this.spine.length) throw new Error('Questo EPUB non contiene capitoli leggibili');
    if ((await epubProtection(this.zip)).kind || looksEncrypted(await this.file(this.spine[0].href).async('uint8array'))) throw drmError();

    // Lunghezza di ogni capitolo in caratteri: serve per l'avanzamento complessivo
    this.lengths = [];
    for (const it of this.spine) {
      const raw = await this.text(it.href);
      const body = raw.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      this.lengths.push(Math.max(1, body.length));
    }
    this.total = this.lengths.reduce((a, b) => a + b, 0);
    this.prefix = this.lengths.map((_, i) => this.lengths.slice(0, i).reduce((a, b) => a + b, 0));

    this.view.innerHTML = '<iframe class="epub-frame" sandbox="allow-same-origin" title="Pagina del libro"></iframe>';
    this.frame = this.view.firstElementChild;
  }

  file(path) {
    return this.zip.file(path) || this.zip.file(decodeURIComponent(path));
  }
  async text(path) {
    const f = this.file(path);
    if (!f) throw new Error('Nel file manca ' + path);
    return f.async('string');
  }
  se() { return this.fdoc.scrollingElement || this.fdoc.documentElement; }

  // Trasforma una risorsa dell'archivio (immagine, foglio di stile, font) in un indirizzo blob
  async resource(path) {
    if (!path || /^[a-z]+:/i.test(path)) return null;
    if (this.urls.has(path)) return this.urls.get(path);
    const f = this.file(path);
    if (!f) return null;
    let blob;
    if (/\.css$/i.test(path)) {
      // Anche dentro i CSS gli indirizzi (font, sfondi) vanno riscritti
      let css = await f.async('string');
      const dir = dirOf(path);
      const refs = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
      for (const m of refs) {
        const u = await this.resource(join(dir, m[2]));
        if (u) css = css.split(m[0]).join(`url("${u}")`);
      }
      blob = new Blob([css], { type: 'text/css' });
    } else {
      blob = new Blob([await f.async('uint8array')], { type: mimeOf(path) });
    }
    const url = URL.createObjectURL(blob);
    this.urls.set(path, url);
    return url;
  }

  // Legge un capitolo: toglie gli script e collega immagini e fogli di stile dell'archivio
  async chapterDoc(index) {
    const item = this.spine[index];
    const raw = await this.text(item.href);
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    let isXml = true;
    if (doc.querySelector('parsererror')) { // XHTML scritto male: lo leggo come HTML
      doc = new DOMParser().parseFromString(raw, 'text/html');
      isXml = false;
    }
    doc.querySelectorAll('script').forEach(s => s.remove());
    const dir = dirOf(item.href);
    for (const el of doc.querySelectorAll('img[src], source[src], video[src], audio[src]')) {
      const u = await this.resource(join(dir, el.getAttribute('src')));
      if (u) el.setAttribute('src', u);
    }
    for (const el of doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')) {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href');
      const u = href && await this.resource(join(dir, href));
      if (u) { el.setAttributeNS(XLINK_NS, 'xlink:href', u); el.setAttribute('href', u); }
    }
    for (const el of [...doc.querySelectorAll('link[href]')]) {
      if (!/stylesheet/i.test(el.getAttribute('rel') || '')) continue;
      const u = await this.resource(join(dir, el.getAttribute('href')));
      if (u) el.setAttribute('href', u); else el.remove();
    }
    return { doc, isXml };
  }

  margins() {
    const W = this.frame.clientWidth;
    // Righe non troppo lunghe anche sugli schermi larghi: al massimo circa 760 px di testo
    return { W, H: this.frame.clientHeight, M: Math.max(Math.round(Math.min(28, Math.max(16, W * 0.06))), Math.round((W - 760) / 2)) };
  }

  readerCss() {
    const { W, H, M } = this.margins();
    const MV = 24;
    this.W = W;
    const c = this.colors;
    const common = `
      img, svg, video, table { max-width: 100% !important; height: auto; }
      svg { height: auto !important; }
      a { color: ${c.accent} !important; }
      ${c.dark ? '* { color: inherit !important; background-color: transparent !important; border-color: currentColor; }' : ''}`;
    if (this.mode === 'scroll') {
      return `
        html { overflow-x: hidden !important; overflow-y: auto !important; background: ${c.bg} !important; }
        body {
          margin: 0 !important; padding: ${MV}px ${M}px 35vh !important; box-sizing: border-box !important;
          max-width: none !important; width: auto !important; height: auto !important; columns: auto !important;
          background: ${c.bg} !important; color: ${c.ink} !important;
          font-size: ${this.fontScale}% !important; line-height: 1.6 !important;
          overflow-wrap: break-word; -webkit-text-size-adjust: none; text-size-adjust: none;
        }
        .sc-chapter + .sc-chapter { margin-top: 2.5em; padding-top: 2.5em; border-top: 1px solid rgba(128, 128, 128, .35); }
        ${common}`;
    }
    return `
      html { height: ${H}px !important; overflow: hidden !important; background: ${c.bg} !important; }
      body {
        margin: ${MV}px ${M}px !important; padding: 0 !important; box-sizing: border-box !important;
        height: ${H - 2 * MV}px !important; max-width: none !important; width: auto !important;
        column-width: ${W - 2 * M}px !important; column-gap: ${2 * M}px !important; column-fill: auto !important;
        background: ${c.bg} !important; color: ${c.ink} !important;
        font-size: ${this.fontScale}% !important; line-height: 1.6 !important;
        overflow-wrap: break-word; -webkit-text-size-adjust: none; text-size-adjust: none;
      }
      img, svg, video, table { max-height: ${H - 2 * MV}px !important; break-inside: avoid; }
      ${common}`;
  }

  async loadFrame(html, type) {
    const url = URL.createObjectURL(new Blob([html], { type }));
    await new Promise(resolve => { this.frame.onload = resolve; this.frame.src = url; });
    if (this.frameUrl) URL.revokeObjectURL(this.frameUrl);
    this.frameUrl = url;
    this.fdoc = this.frame.contentDocument;
    await this.waitForMedia();
    this.attach();
  }

  // ---------------- pagine affiancate: un capitolo alla volta
  async showChapter(index, where) {
    this.chapter = index;
    const { doc, isXml } = await this.chapterDoc(index);
    let head = doc.querySelector('head');
    if (!head) {
      head = doc.createElementNS(XHTML_NS, 'head');
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }
    const style = doc.createElementNS(XHTML_NS, 'style');
    style.setAttribute('id', 'scaffale-reader');
    style.textContent = this.readerCss();
    head.appendChild(style);
    const html = isXml ? new XMLSerializer().serializeToString(doc) : '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    await this.loadFrame(html, isXml ? 'application/xhtml+xml' : 'text/html');
    this.measure();
    this.placeAt(where);
  }

  // ---------------- scorrimento verticale: tutto il libro in un unico documento
  async buildBook() {
    if (this.bookHtml) return this.bookHtml;
    const book = document.implementation.createHTMLDocument('Libro');
    const styles = new Set(), inline = [];
    for (let i = 0; i < this.spine.length; i++) {
      const { doc } = await this.chapterDoc(i);
      for (const l of doc.querySelectorAll('link[href]')) if (/stylesheet/i.test(l.getAttribute('rel') || '')) styles.add(l.getAttribute('href'));
      for (const st of doc.querySelectorAll('head style')) inline.push(st.textContent);
      const body = doc.querySelector('body') || doc.documentElement;
      // Ogni capitolo ha i suoi id: li rendo unici, e trasformo i link fra capitoli in link interni
      for (const el of body.querySelectorAll('[id]')) el.setAttribute('id', `c${i}-${el.getAttribute('id')}`);
      for (const a of body.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (/^[a-z]+:/i.test(href)) continue;
        const [path, anchor] = href.split('#');
        let j = i;
        if (path) {
          const target = join(dirOf(this.spine[i].href), path);
          j = this.spine.findIndex(it => it.href === target);
          if (j < 0) continue;
        }
        a.setAttribute('href', '#' + (anchor ? `c${j}-${anchor}` : `chap-${j}`));
      }
      const section = book.createElement('section');
      section.className = 'sc-chapter';
      section.id = `chap-${i}`;
      section.dataset.chapter = i;
      // importNode copia i nodi nel nuovo documento senza passare dal testo: niente
      // errori di conversione fra XHTML e HTML (per esempio <a id="x"/>)
      for (const n of [...body.childNodes]) section.appendChild(book.importNode(n, true));
      book.body.appendChild(section);
    }
    for (const href of styles) {
      const l = book.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      book.head.appendChild(l);
    }
    if (inline.length) {
      const st = book.createElement('style');
      st.textContent = inline.join('\n');
      book.head.appendChild(st);
    }
    const mine = book.createElement('style');
    mine.id = 'scaffale-reader';
    book.head.appendChild(mine);
    const meta = book.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    book.head.prepend(meta);
    this.bookHtml = '<!DOCTYPE html>' + book.documentElement.outerHTML;
    return this.bookHtml;
  }

  async showBook(pos) {
    const html = await this.buildBook();
    await this.loadFrame(html, 'text/html');
    this.fdoc.getElementById('scaffale-reader').textContent = this.readerCss();
    this.sections = [...this.fdoc.querySelectorAll('.sc-chapter')];
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.scrollToChapter(pos.chapter || 0, pos.frac || 0);
  }

  scrollToChapter(i, frac) {
    const sec = this.sections[Math.min(this.sections.length - 1, Math.max(0, i))];
    if (!sec) return;
    this.se().scrollTop = sec.offsetTop + frac * sec.offsetHeight;
    this.trackScroll();
  }

  // Capitolo e punto di lettura in base allo scorrimento
  sectionAt(y) {
    let lo = 0, hi = this.sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.sections[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    const sec = this.sections[lo];
    return { i: lo, frac: Math.max(0, Math.min(0.9999, (y - sec.offsetTop) / Math.max(1, sec.offsetHeight))) };
  }
  trackScroll() {
    const se = this.se();
    // Il punto da cui riprendere è in alto; l'avanzamento conta fino al fondo dello schermo,
    // come nelle pagine affiancate, dove una pagina visibile conta come letta
    const top = this.sectionAt(se.scrollTop + 2);
    this.chapter = top.i;
    this.frac = top.frac;
    const bottom = this.sectionAt(Math.min(se.scrollHeight - 1, se.scrollTop + this.frame.clientHeight));
    this.readTo = (this.prefix[bottom.i] + bottom.frac * this.lengths[bottom.i]) / this.total;
    this.report();
  }

  async waitForMedia() {
    const imgs = [...this.fdoc.images].filter(i => !i.complete);
    const timeout = new Promise(r => setTimeout(r, 3000));
    await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))), timeout]);
    if (this.fdoc.fonts) await Promise.race([this.fdoc.fonts.ready, timeout]);
  }

  measure() {
    this.pages = Math.max(1, Math.round(this.se().scrollWidth / this.W));
  }

  placeAt(where) {
    let p = 0;
    if (where === 'end') p = this.pages - 1;
    else if (typeof where === 'number') p = Math.floor(where * this.pages + 1e-6);
    else if (where && where.anchor) {
      const el = this.fdoc.getElementById(where.anchor);
      if (el) p = Math.floor((el.getBoundingClientRect().left + this.se().scrollLeft) / this.W);
    }
    this.setPage(p);
  }

  setPage(p) {
    this.cancelAnim();
    this.page = Math.min(this.pages - 1, Math.max(0, p));
    this.se().scrollLeft = this.page * this.W;
    this.report();
  }

  // Scorrimento animato fino a una pagina del capitolo (dopo un trascinamento o un tocco)
  animateTo(p) {
    this.cancelAnim();
    this.page = Math.min(this.pages - 1, Math.max(0, p));
    const se = this.se(), from = se.scrollLeft, to = this.page * this.W;
    const dur = reducedMotion() ? 0 : 240, start = performance.now();
    const step = now => {
      const k = dur ? Math.min(1, (now - start) / dur) : 1;
      se.scrollLeft = from + (to - from) * (1 - Math.pow(1 - k, 3));
      this.anim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    // Le animazioni girano nella finestra dell'app: nel riquadro del libro gli script sono
    // disattivati per sicurezza, e il browser lì non esegue requestAnimationFrame
    this.anim = requestAnimationFrame(step);
    this.report();
  }
  cancelAnim() {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
  }

  // Tocchi, trascinamenti, scorrimento e link dentro la pagina del libro
  attach() {
    const d = this.fdoc;
    let sx = null, sy = 0, sl = 0, t0 = 0, decided = false, dragging = false;
    let suppressClick = 0;
    d.addEventListener('click', e => {
      if (performance.now() - suppressClick < 400) return;
      const a = e.target.closest && e.target.closest('a[href]');
      if (a) { e.preventDefault(); this.follow(a.getAttribute('href')); return; }
      this.onTap(e.clientX / this.frame.clientWidth);
    });
    if (this.mode === 'scroll') {
      let raf = 0;
      d.defaultView.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; this.trackScroll(); });
      }, { passive: true });
    }
    // Trascinamento in orizzontale: la pagina segue il dito
    d.addEventListener('touchstart', e => {
      this.vTarget = null; // comanda il dito
      if (this.mode !== 'pages' || e.touches.length > 1) { sx = null; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      sl = this.se().scrollLeft; t0 = performance.now(); decided = false; dragging = false;
      this.cancelAnim();
    }, { passive: true });
    d.addEventListener('touchmove', e => {
      if (this.mode !== 'pages' || sx === null) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        dragging = Math.abs(dx) > Math.abs(dy);
      }
      if (!dragging) return;
      e.preventDefault();
      const max = (this.pages - 1) * this.W;
      let x = sl - dx;
      if (x < 0) x *= 0.3; else if (x > max) x = max + (x - max) * 0.3; // resistenza ai bordi del capitolo
      this.se().scrollLeft = x;
    }, { passive: false });
    d.addEventListener('touchend', e => {
      if (this.mode !== 'pages' || sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      const v = dx / Math.max(1, performance.now() - t0);
      sx = null;
      if (!dragging) return;
      suppressClick = performance.now();
      const turn = Math.abs(v) > 0.35 || Math.abs(dx) > this.W * 0.2;
      if (turn && dx < 0) this.next();
      else if (turn && dx > 0) this.prev();
      else this.animateTo(this.page); // spostamento troppo piccolo: torna dov'era
    }, { passive: true });
    d.addEventListener('keydown', e => {
      // In verticale lo scorrimento con la tastiera lo fa il browser
      if (this.mode === 'scroll' && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End'].includes(e.key)) return;
      this.onKey(e.key);
    });
  }

  follow(href) {
    if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    if (this.mode === 'scroll') {
      const el = href.startsWith('#') && this.fdoc.getElementById(decodeURIComponent(href.slice(1)));
      if (el) { el.scrollIntoView({ block: 'start' }); this.trackScroll(); }
      return;
    }
    const [path, anchor] = href.split('#');
    if (!path) { this.placeAt({ anchor }); return; }
    const target = join(dirOf(this.spine[this.chapter].href), path);
    const i = this.spine.findIndex(it => it.href === target);
    if (i >= 0) this.showChapter(i, anchor ? { anchor } : 0);
  }

  position() {
    let frac, fraction;
    if (this.mode === 'scroll') {
      frac = this.frac;
      fraction = this.readTo != null ? this.readTo : (this.prefix[this.chapter] + frac * this.lengths[this.chapter]) / this.total;
    } else {
      frac = this.page / this.pages;
      fraction = (this.prefix[this.chapter] + ((this.page + 1) / this.pages) * this.lengths[this.chapter]) / this.total;
    }
    return { kind: 'epub', chapter: this.chapter, frac, fraction: Math.min(1, fraction), label: `${Math.round(fraction * 100)}%` };
  }
  // Pagine stimate dell'edizione, se lo scaffale non le conosce (circa 1500 caratteri a pagina)
  units() { return Math.max(1, Math.round(this.total / 1500)); }

  toChapterPos(f) {
    const target = Math.min(0.9999, Math.max(0, f)) * this.total;
    let i = this.prefix.findIndex((p, k) => target < p + this.lengths[k]);
    if (i < 0) i = this.spine.length - 1;
    return { chapter: i, frac: (target - this.prefix[i]) / this.lengths[i] };
  }

  async goTo(pos) {
    let target = { chapter: 0, frac: 0 };
    if (pos && pos.kind === 'epub' && this.spine[pos.chapter]) target = { chapter: pos.chapter, frac: pos.frac || 0 };
    else if (pos && typeof pos.fraction === 'number') target = this.toChapterPos(pos.fraction);
    if (this.mode === 'scroll') return this.showBook(target);
    return this.showChapter(target.chapter, target.frac);
  }
  async goToFraction(f) {
    const t = this.toChapterPos(f);
    if (this.mode === 'scroll') return this.scrollToChapter(t.chapter, t.frac);
    if (t.chapter === this.chapter && this.fdoc) this.placeAt(t.frac);
    else await this.showChapter(t.chapter, t.frac);
  }
  async next() {
    if (this.mode === 'scroll') { stepScroll(this, this.se(), 1, this.frame.clientHeight); return; }
    if (this.page < this.pages - 1) this.animateTo(this.page + 1);
    else if (this.chapter < this.spine.length - 1) await this.showChapter(this.chapter + 1, 0);
    else this.animateTo(this.page);
  }
  async prev() {
    if (this.mode === 'scroll') { stepScroll(this, this.se(), -1, this.frame.clientHeight); return; }
    if (this.page > 0) this.animateTo(this.page - 1);
    else if (this.chapter > 0) await this.showChapter(this.chapter - 1, 'end');
    else this.animateTo(0);
  }
  // Nuova impaginazione (testo più grande, schermo ruotato) mantenendo il punto di lettura
  async relayout() {
    if (!this.fdoc) return;
    const keep = this.mode === 'scroll' ? { chapter: this.chapter, frac: this.frac } : this.page / this.pages;
    const style = this.fdoc.getElementById('scaffale-reader');
    if (style) style.textContent = this.readerCss();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (this.mode === 'scroll') { this.scrollToChapter(keep.chapter, keep.frac); return; }
    this.measure();
    this.placeAt(keep);
  }
  async setMode(mode) {
    if (mode === this.mode) return;
    const pos = { kind: 'epub', chapter: this.chapter, frac: this.position().frac };
    this.cancelAnim();
    this.mode = mode;
    await this.goTo(pos);
  }
  async bigger() { this.fontScale = Math.min(200, this.fontScale + 10); await this.relayout(); }
  async smaller() { this.fontScale = Math.max(70, this.fontScale - 10); await this.relayout(); }
  destroy() {
    this.cancelAnim();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    if (this.frameUrl) URL.revokeObjectURL(this.frameUrl);
    this.urls.clear();
  }
}

// ---------------------------------------------------------------- lettore
export class Reader {
  // els: { root, view, where, range, prev, next, smaller, bigger, modeV, modeH }
  constructor(els, { onProgress, onMode, onClose }) {
    this.els = els;
    this.onProgress = onProgress;
    this.onMode = onMode;
    this.onClose = onClose;
    this.engine = null;
    this.mode = 'pages';
    els.view.addEventListener('click', e => {
      if (!this.engine || this.engine instanceof EpubEngine) return; // per gli EPUB ci pensa la pagina
      const r = els.view.getBoundingClientRect();
      this.tap((e.clientX - r.left) / r.width);
    });
    els.root.addEventListener('keydown', e => {
      if (this.key(e.key)) e.preventDefault();
    });
    els.prev.addEventListener('click', () => this.prev());
    els.next.addEventListener('click', () => this.next());
    els.smaller.addEventListener('click', () => this.engine && this.engine.smaller());
    els.bigger.addEventListener('click', () => this.engine && this.engine.bigger());
    els.range.addEventListener('change', () => this.engine && this.engine.goToFraction(els.range.value / 1000));
    els.modeV.addEventListener('click', () => this.setMode('scroll'));
    els.modeH.addEventListener('click', () => this.setMode('pages'));
    let t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.engine && this.engine.relayout(), 200); });
  }

  // Tasti: frecce e pagina giù/su; in verticale le frecce su/giù scorrono di poco
  key(k) {
    if (!this.engine) return false;
    if (k === 'Escape') { this.onClose && this.onClose(); return true; }
    if (['ArrowRight', 'PageDown', ' '].includes(k)) { this.next(); return true; }
    if (['ArrowLeft', 'PageUp'].includes(k)) { this.prev(); return true; }
    if (this.mode === 'scroll' && this.engine instanceof PdfEngine && (k === 'ArrowDown' || k === 'ArrowUp')) {
      this.engine.scroller.scrollBy({ top: k === 'ArrowDown' ? 60 : -60 });
      return true;
    }
    return false;
  }

  // Tocco a sinistra: indietro; a destra: avanti; al centro: mostra o nasconde i comandi
  tap(x) {
    if (x < 0.3) this.prev();
    else if (x > 0.7) this.next();
    else this.els.root.classList.toggle('immersive');
  }

  showMode() {
    this.els.modeV.setAttribute('aria-pressed', String(this.mode === 'scroll'));
    this.els.modeH.setAttribute('aria-pressed', String(this.mode === 'pages'));
  }

  async setMode(mode) {
    if (!this.engine || mode === this.mode) return;
    this.mode = mode;
    this.showMode();
    await this.engine.setMode(mode);
    if (this.onMode) this.onMode(mode);
  }

  async open({ blob, kind, pos, fontScale, colors, mode }) {
    this.close();
    this.mode = mode === 'scroll' ? 'scroll' : 'pages';
    this.showMode();
    const report = () => this.reported();
    this.engine = kind === 'EPUB'
      ? new EpubEngine(this.els.view, report, { mode: this.mode, fontScale, colors, onTap: x => this.tap(x), onKey: k => this.key(k) })
      : new PdfEngine(this.els.view, report, { mode: this.mode });
    this.els.smaller.textContent = kind === 'EPUB' ? 'A−' : '−';
    this.els.bigger.textContent = kind === 'EPUB' ? 'A+' : '+';
    this.els.smaller.setAttribute('aria-label', kind === 'EPUB' ? 'Testo più piccolo' : 'Riduci');
    this.els.bigger.setAttribute('aria-label', kind === 'EPUB' ? 'Testo più grande' : 'Ingrandisci');
    await this.engine.load(blob);
    await this.engine.goTo(pos);
  }

  reported() {
    const p = this.engine.position();
    const label = this.onProgress({ ...p, units: this.engine.units() }) || p.label;
    this.els.where.textContent = label;
    this.els.range.value = Math.round(p.fraction * 1000);
  }

  next() { return this.engine && this.engine.next(); }
  prev() { return this.engine && this.engine.prev(); }
  fontScale() { return this.engine instanceof EpubEngine ? this.engine.fontScale : null; }

  close() {
    try { if (this.engine) this.engine.destroy(); } catch (e) { console.warn('Chiusura del lettore', e); }
    this.engine = null;
    this.els.view.innerHTML = '';
    this.els.root.classList.remove('immersive');
  }
}
