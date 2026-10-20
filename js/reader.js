// Lettore integrato: PDF con PDF.js, EPUB aperti con JSZip e impaginati a colonne.
// Il lettore non conosce lo scaffale: comunica la posizione con onProgress, e l'app
// la trasforma nel segnalibro.

const VENDOR = new URL('../vendor/', import.meta.url).href;

// ---------------------------------------------------------------- librerie
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(VENDOR + 'pdfjs/pdf.min.js').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdfjs/pdf.worker.min.js';
      return lib;
    });
  }
  return pdfjsPromise;
}

let jszipPromise = null;
function loadJsZip() {
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
class PdfEngine {
  constructor(view, report) {
    this.view = view;
    this.report = report;
    this.zoom = 1;
    this.page = 1;
    this.task = null;
  }

  async load(blob) {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await blob.arrayBuffer());
    // In PDF.js si chiude il "compito di caricamento", non il documento: lo tengo da parte
    this.loadingTask = pdfjs.getDocument({
      data,
      wasmUrl: VENDOR + 'pdfjs/wasm/',   // decodificatori per i PDF scansionati (JBIG2, JPEG 2000)
      iccUrl: VENDOR + 'pdfjs/iccs/',
      isEvalSupported: false,            // un PDF non può eseguire codice
      enableXfa: false,
    });
    this.doc = await this.loadingTask.promise;
    this.count = this.doc.numPages;
    this.view.innerHTML = '<div class="pdf-scroll"><canvas class="pdf-page"></canvas></div>';
    this.scroller = this.view.firstElementChild;
    this.canvas = this.scroller.firstElementChild;
  }

  async goTo(pos) {
    let p = 1;
    if (pos && pos.page) p = pos.page;
    else if (pos && typeof pos.fraction === 'number') p = Math.round(pos.fraction * this.count);
    this.page = Math.min(this.count, Math.max(1, p));
    await this.render();
  }

  async render() {
    const n = this.page;
    const page = await this.doc.getPage(n);
    if (n !== this.page) return; // nel frattempo hai già girato pagina
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(this.view.clientWidth / base.width, this.view.clientHeight / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: fit * this.zoom * dpr });
    if (this.task) this.task.cancel();
    // Disegno su un canvas nuovo e lo sostituisco solo alla fine: niente pagina bianca intermedia
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = Math.floor(vp.width / dpr) + 'px';
    canvas.style.height = Math.floor(vp.height / dpr) + 'px';
    this.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    try {
      await this.task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      throw err;
    }
    if (n !== this.page) return;
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
    this.scroller.scrollTop = 0;
    this.report();
  }

  position() {
    return { kind: 'pdf', page: this.page, fraction: this.page / this.count, label: `${this.page} / ${this.count}` };
  }
  units() { return this.count; }
  canSwipe() { return this.zoom === 1; }
  async next() { if (this.page < this.count) { this.page++; await this.render(); } }
  async prev() { if (this.page > 1) { this.page--; await this.render(); } }
  async goToFraction(f) { await this.goTo({ page: Math.max(1, Math.round(f * this.count)) }); }
  async bigger() { this.zoom = Math.min(3, this.zoom + 0.5); await this.render(); }
  async smaller() { this.zoom = Math.max(1, this.zoom - 0.5); await this.render(); }
  async relayout() { await this.render(); }
  destroy() {
    if (this.task) this.task.cancel();
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
const mimeOf = path => MIME[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');

// Risolve un percorso relativo dentro l'archivio ("../Images/a.jpg" da "OEBPS/Text/")
function join(base, rel) {
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

class EpubEngine {
  constructor(view, report, opts) {
    this.view = view;
    this.report = report;
    this.fontScale = opts.fontScale || 100;
    this.colors = opts.colors;
    this.onTap = opts.onTap;
    this.urls = new Map(); // percorso nell'archivio -> indirizzo blob
    this.chapter = 0;
    this.page = 0;
    this.pages = 1;
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

  // Foglio di stile del lettore: colonne larghe quanto lo schermo, colori e dimensione del testo
  readerCss() {
    const W = this.frame.clientWidth, H = this.frame.clientHeight;
    const M = Math.round(Math.min(28, Math.max(16, W * 0.06))); // margine laterale
    const MV = 24;                                              // margine verticale
    this.W = W;
    const c = this.colors;
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
      img, svg, video, table { max-width: 100% !important; max-height: ${H - 2 * MV}px !important; height: auto; break-inside: avoid; }
      svg { height: auto !important; }
      a { color: ${c.accent} !important; }
      ${c.dark ? '* { color: inherit !important; background-color: transparent !important; border-color: currentColor; }' : ''}
    `;
  }

  async showChapter(index, where) {
    this.chapter = index;
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
    const url = URL.createObjectURL(new Blob([html], { type: isXml ? 'application/xhtml+xml' : 'text/html' }));
    await new Promise(resolve => { this.frame.onload = resolve; this.frame.src = url; });
    if (this.chapterUrl) URL.revokeObjectURL(this.chapterUrl);
    this.chapterUrl = url;
    this.fdoc = this.frame.contentDocument;
    await this.waitForMedia();
    this.attach();
    this.measure();
    this.placeAt(where);
  }

  async waitForMedia() {
    const imgs = [...this.fdoc.images].filter(i => !i.complete);
    const timeout = new Promise(r => setTimeout(r, 3000));
    await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))), timeout]);
    if (this.fdoc.fonts) await Promise.race([this.fdoc.fonts.ready, timeout]);
  }

  measure() {
    const se = this.fdoc.scrollingElement || this.fdoc.documentElement;
    this.pages = Math.max(1, Math.round(se.scrollWidth / this.W));
  }

  placeAt(where) {
    let p = 0;
    if (where === 'end') p = this.pages - 1;
    else if (typeof where === 'number') p = Math.floor(where * this.pages + 1e-6);
    else if (where && where.anchor) {
      const el = this.fdoc.getElementById(where.anchor);
      if (el) {
        const se = this.fdoc.scrollingElement || this.fdoc.documentElement;
        p = Math.floor((el.getBoundingClientRect().left + se.scrollLeft) / this.W);
      }
    }
    this.setPage(p);
  }

  setPage(p) {
    this.page = Math.min(this.pages - 1, Math.max(0, p));
    const se = this.fdoc.scrollingElement || this.fdoc.documentElement;
    se.scrollLeft = this.page * this.W;
    this.report();
  }

  // Tocchi, scorrimenti e link dentro la pagina del libro
  attach() {
    const d = this.fdoc;
    d.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a) { e.preventDefault(); this.follow(a.getAttribute('href')); return; }
      this.onTap(e.clientX / this.W);
    });
    let sx = 0, sy = 0;
    d.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    d.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dy) < 60) { dx < 0 ? this.next() : this.prev(); }
    }, { passive: true });
    d.addEventListener('keydown', e => this.view.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true })));
  }

  follow(href) {
    if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    const [path, anchor] = href.split('#');
    if (!path) { this.placeAt({ anchor }); return; }
    const target = join(dirOf(this.spine[this.chapter].href), path);
    const i = this.spine.findIndex(it => it.href === target);
    if (i >= 0) this.showChapter(i, anchor ? { anchor } : 0);
  }

  position() {
    const within = (this.page + 1) / this.pages;
    const fraction = (this.prefix[this.chapter] + within * this.lengths[this.chapter]) / this.total;
    return { kind: 'epub', chapter: this.chapter, frac: this.page / this.pages, fraction: Math.min(1, fraction), label: `${Math.round(fraction * 100)}%` };
  }
  // Pagine stimate dell'edizione, se lo scaffale non le conosce (circa 1500 caratteri a pagina)
  units() { return Math.max(1, Math.round(this.total / 1500)); }
  canSwipe() { return true; }

  async goTo(pos) {
    if (pos && pos.kind === 'epub' && this.spine[pos.chapter]) return this.showChapter(pos.chapter, pos.frac || 0);
    if (pos && typeof pos.fraction === 'number') return this.goToFraction(pos.fraction);
    return this.showChapter(0, 0);
  }
  async goToFraction(f) {
    const target = Math.min(0.9999, Math.max(0, f)) * this.total;
    let i = this.prefix.findIndex((p, k) => target < p + this.lengths[k]);
    if (i < 0) i = this.spine.length - 1;
    const within = (target - this.prefix[i]) / this.lengths[i];
    if (i === this.chapter && this.fdoc) this.placeAt(within);
    else await this.showChapter(i, within);
  }
  async next() {
    if (this.page < this.pages - 1) this.setPage(this.page + 1);
    else if (this.chapter < this.spine.length - 1) await this.showChapter(this.chapter + 1, 0);
  }
  async prev() {
    if (this.page > 0) this.setPage(this.page - 1);
    else if (this.chapter > 0) await this.showChapter(this.chapter - 1, 'end');
  }
  // Nuova impaginazione (testo più grande, schermo ruotato) mantenendo il punto di lettura
  async relayout() {
    if (!this.fdoc) return;
    const keep = this.page / this.pages;
    const style = this.fdoc.getElementById('scaffale-reader');
    if (style) style.textContent = this.readerCss();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.measure();
    this.placeAt(keep);
  }
  async bigger() { this.fontScale = Math.min(200, this.fontScale + 10); await this.relayout(); }
  async smaller() { this.fontScale = Math.max(70, this.fontScale - 10); await this.relayout(); }
  destroy() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    if (this.chapterUrl) URL.revokeObjectURL(this.chapterUrl);
    this.urls.clear();
  }
}

// ---------------------------------------------------------------- lettore
export class Reader {
  // els: { view, where, range, prev, next, smaller, bigger, root }
  constructor(els, { onProgress }) {
    this.els = els;
    this.onProgress = onProgress;
    this.engine = null;
    let sx = 0, sy = 0;
    els.view.addEventListener('click', e => {
      if (!this.engine || this.engine instanceof EpubEngine) return; // per gli EPUB ci pensa la pagina
      const r = els.view.getBoundingClientRect();
      this.tap((e.clientX - r.left) / r.width);
    });
    els.view.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    els.view.addEventListener('touchend', e => {
      if (!this.engine || this.engine instanceof EpubEngine || !this.engine.canSwipe()) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dy) < 60) { dx < 0 ? this.next() : this.prev(); }
    }, { passive: true });
    els.root.addEventListener('keydown', e => {
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.next(); }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.prev(); }
    });
    els.prev.addEventListener('click', () => this.prev());
    els.next.addEventListener('click', () => this.next());
    els.smaller.addEventListener('click', () => this.engine && this.engine.smaller());
    els.bigger.addEventListener('click', () => this.engine && this.engine.bigger());
    els.range.addEventListener('change', () => this.engine && this.engine.goToFraction(els.range.value / 1000));
    let t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.engine && this.engine.relayout(), 200); });
  }

  // Tocco a sinistra: indietro; a destra: avanti; al centro: mostra o nasconde i comandi
  tap(x) {
    if (x < 0.3) this.prev();
    else if (x > 0.7) this.next();
    else this.els.root.classList.toggle('immersive');
  }

  async open({ blob, kind, pos, fontScale, colors }) {
    this.close();
    const report = () => this.reported();
    this.engine = kind === 'EPUB'
      ? new EpubEngine(this.els.view, report, { fontScale, colors, onTap: x => this.tap(x) })
      : new PdfEngine(this.els.view, report);
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
