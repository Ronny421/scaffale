// Aggiunta dei libri a partire dai file: legge da un EPUB o da un PDF titolo, autore, anno,
// editore, ISBN, genere e copertina, tutto sul dispositivo e senza internet.
//
// Un EPUB è un archivio ZIP di pagine web. Il file META-INF/container.xml dice dove si trova
// l'indice del libro (il file OPF), che contiene la sua "carta d'identità" nel formato
// Dublin Core: <dc:title>, <dc:creator>, <dc:date>, <dc:identifier>, <dc:subject>…
// Un PDF invece ha solo un piccolo dizionario di informazioni (Title, Author), spesso vuoto
// o sbagliato ("Microsoft Word - documento1"): per questo l'ISBN si cerca nel testo delle
// prime e delle ultime pagine, dove di solito c'è il colophon, e la copertina è la prima pagina.

import { cleanIsbn, isValidIsbn, mapGenre } from './catalog.js';
import { loadJsZip, loadPdfJs, pdfOptions, join, dirOf, mimeOf, epubProtection, looksEncrypted } from './reader.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const OPF = 'http://www.idpf.org/2007/opf';
const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const textOf = el => clean(el && el.textContent);

export const MIME_EPUB = 'application/epub+zip';
export const MIME_PDF = 'application/pdf';

// "EPUB", "PDF" oppure null se il file non è un libro che Scaffale sa leggere.
// I libri per Kobo hanno spesso l'estensione .kepub.epub o .kepub: sono EPUB anche loro.
export function bookKind(file) {
  const n = (file.name || '').toLowerCase();
  const t = (file.type || '').toLowerCase();
  if (/\.(epub|kepub)$/.test(n) || t === MIME_EPUB) return 'EPUB';
  if (n.endsWith('.pdf') || t === MIME_PDF) return 'PDF';
  return null;
}

// ------------------------------------------------------------------ testo
// Valori che i programmi scrivono quando non sanno cosa mettere
const JUNK = /^(unknown|sconosciuto|autore sconosciuto|anonymous author|n\/?a|none|null|undefined|untitled|senza titolo|titolo|title|author|autore|administrator|admin|user|utente|owner|proprietario|calibre.*|microsoft word.*|libreoffice.*|document\d*|documento\d*|.*\.(docx?|odt|rtf|indd|qxd|tex|pdf|epub|html?))$/i;
// Nomi di programmi che finiscono nei campi Titolo e Autore dei PDF
const SOFTWARE = /\b(acrobat|distiller|pdfmaker|ghostscript|indesign|quarkxpress|microsoft|libreoffice|openoffice)\b/i;
const useful = s => { s = clean(s); return s && !JUNK.test(s) && !SOFTWARE.test(s) ? s : ''; };
const usefulName = s => (/\p{L}/u.test(s || '') ? useful(s) : '');

// Titoli e nomi scritti TUTTI IN MAIUSCOLO diventano leggibili:
// "IL NOME DELLA ROSA" -> "Il nome della rosa", "UMBERTO ECO" -> "Umberto Eco"
export function fixCase(s, { name = false } = {}) {
  if (!s || s !== s.toUpperCase() || !/\p{L}{2}/u.test(s)) return s;
  const low = s.toLowerCase();
  if (!name) return low.charAt(0).toUpperCase() + low.slice(1); // nei titoli italiani solo l'iniziale
  return low.replace(/(^|[\s'’\-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}

// "Eco, Umberto" -> "Umberto Eco". I cataloghi spesso scrivono prima il cognome, a volte
// seguito dagli anni di nascita e di morte ("Calvino, Italo, 1923-1985").
export function normalizeAuthor(raw) {
  // il punto finale si toglie solo dopo una parola intera ("Umberto." sì, "J. R. R." no)
  let s = clean(raw).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?$/, '').replace(/(\p{Ll}{2,})\.$/u, '$1');
  const m = /^([^,]+),\s*([^,]+)$/.exec(s);
  if (m && !/^(jr|sr|ii|iii|iv)\.?$/i.test(m[2].trim())) s = `${m[2].trim()} ${m[1].trim()}`;
  return fixCase(s, { name: true });
}

// Il titolo dal nome del file, quando dentro non c'è: "Il_nome_della_rosa (1).kepub.epub"
export function titleFromName(name) {
  const t = clean(String(name || '')
    .replace(/\.(kepub\.epub|epub|kepub|pdf)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\s*\[[^\]]*\]$/, ''));
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function yearFrom(s) {
  const m = String(s || '').match(/\b(1[4-9]\d\d|2\d\d\d)\b/);
  if (!m) return '';
  const y = +m[1];
  return y >= 1450 && y <= new Date().getFullYear() + 1 ? String(y) : '';
}

// Tutti gli ISBN validi in un testo, nell'ordine in cui compaiono. Prima quelli preceduti
// dalla parola ISBN, poi i codici a 13 cifre che iniziano con 978 o 979. Un numero qualunque
// di 10 cifre non basta: una cifra di controllo su undici tornerebbe per caso.
const D = '[\\s\\-\\u2010-\\u2015]?';
const LABELED = new RegExp(`ISBN(?:[\\s\\-]*1[03])?[^0-9]{0,30}((?:97[89]${D})?(?:\\d${D}){9}[\\dXx])`, 'gi');
const BARE = new RegExp(`(?<![\\d\\-])97[89](?:${D}\\d){10}(?![\\d\\-])`, 'g');
export function findIsbns(text) {
  const out = [];
  const add = s => { const c = cleanIsbn(s); if (isValidIsbn(c) && !out.includes(c)) out.push(c); };
  for (const m of String(text || '').matchAll(LABELED)) add(m[1]);
  for (const m of String(text || '').matchAll(BARE)) add(m[0]);
  return out;
}

// ------------------------------------------------------------------ EPUB
const attr = (el, name) => el.getAttributeNS(OPF, name) || el.getAttribute('opf:' + name) || el.getAttribute(name) || '';

// Legge l'indice OPF: restituisce i dati del libro e dove trovare copertina e capitoli
export function parseOpf(xml, opfDir = '') {
  const opf = typeof xml === 'string' ? parseXml(xml) : xml;
  const md = opf.getElementsByTagNameNS('*', 'metadata')[0] || opf.documentElement;
  const dc = name => [...md.getElementsByTagNameNS(DC, name)];
  // EPUB 3 descrive alcuni elementi con <meta refines="#id" property="role">aut</meta>
  const refines = new Map();
  for (const m of md.getElementsByTagNameNS('*', 'meta')) {
    const ref = m.getAttribute('refines'), prop = m.getAttribute('property');
    if (!ref || !prop) continue;
    const id = ref.replace(/^#/, '');
    if (!refines.has(id)) refines.set(id, {});
    refines.get(id)[prop] = textOf(m);
  }
  const extra = el => refines.get(el.getAttribute('id')) || {};

  // Titolo, con l'eventuale sottotitolo
  const titles = dc('title').map(el => ({ text: textOf(el), type: extra(el)['title-type'] || '' })).filter(t => t.text);
  const main = titles.find(t => t.type === 'main') || titles[0];
  const sub = titles.find(t => t.type === 'subtitle');
  let title = main ? main.text : '';
  if (sub && !title.toLowerCase().includes(sub.text.toLowerCase())) title += ': ' + sub.text;

  // Autori: solo chi ha scritto il libro, non traduttori, curatori o illustratori
  const creators = dc('creator').map(el => ({ name: textOf(el), role: (attr(el, 'role') || extra(el).role || '').toLowerCase() }))
    .filter(c => usefulName(c.name));
  let authors = creators.filter(c => c.role === 'aut');
  if (!authors.length) authors = creators.filter(c => !c.role);
  if (!authors.length) authors = creators;

  // Anno: la data di pubblicazione, non quella di modifica del file
  const dates = dc('date').map(el => ({ text: textOf(el), event: attr(el, 'event').toLowerCase() }));
  const date = dates.find(d => /publication/.test(d.event)) || dates.find(d => !d.event) ||
    dates.find(d => !/modification|creation/.test(d.event));

  // ISBN fra gli identificativi (gli altri sono di solito codici interni o UUID)
  const isbns = [];
  for (const el of dc('identifier')) {
    const t = textOf(el), scheme = attr(el, 'scheme');
    const typed = /isbn/i.test(scheme) || /isbn/i.test(t) || ['15', '02'].includes(extra(el)['identifier-type']);
    const c = cleanIsbn(t.replace(/^urn:isbn:/i, '').replace(/^isbn[:\s]*/i, ''));
    if (isValidIsbn(c) && (typed || /^97[89]/.test(c)) && !isbns.includes(c)) isbns.push(c);
  }

  // Manifesto: l'elenco di tutti i file del libro
  const items = new Map();
  const manifest = opf.getElementsByTagNameNS('*', 'manifest')[0];
  if (manifest) {
    for (const it of manifest.getElementsByTagNameNS('*', 'item')) {
      items.set(it.getAttribute('id'), {
        href: join(opfDir, it.getAttribute('href') || ''),
        type: (it.getAttribute('media-type') || '').toLowerCase(),
        props: it.getAttribute('properties') || '',
        id: it.getAttribute('id') || '',
      });
    }
  }
  const all = [...items.values()];
  const isImage = it => it && (/^image\//.test(it.type) || /\.(jpe?g|png|gif|webp)$/i.test(it.href));
  // Copertina: EPUB 3 la segna con properties="cover-image", EPUB 2 con <meta name="cover">
  let cover = all.find(it => /(^|\s)cover-image(\s|$)/.test(it.props));
  if (!isImage(cover)) {
    const meta = [...md.getElementsByTagNameNS('*', 'meta')].find(m => (m.getAttribute('name') || '').toLowerCase() === 'cover');
    const c = meta && meta.getAttribute('content');
    cover = c ? (items.get(c) || all.find(it => it.href.endsWith('/' + c) || it.href === join(opfDir, c))) : null;
  }
  if (!isImage(cover)) cover = all.find(it => isImage(it) && /cover|copertina/i.test(it.id + ' ' + it.href.split('/').pop()));
  // In mancanza, la pagina di copertina indicata nella "guida" del libro
  const ref = [...opf.getElementsByTagNameNS('*', 'reference')].find(r => (r.getAttribute('type') || '').toLowerCase() === 'cover');
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')]
    .map(r => items.get(r.getAttribute('idref')))
    .filter(it => it && /html/.test(it.type))
    .map(it => it.href);

  return {
    title: useful(title) ? fixCase(title) : '',
    authors: authors.map(c => normalizeAuthor(c.name)),
    year: yearFrom(date && date.text),
    publisher: useful(dc('publisher').map(textOf)[0]) || '',
    isbns,
    subjects: dc('subject').map(textOf).filter(Boolean),
    coverHref: isImage(cover) ? cover.href : '',
    coverPage: ref ? join(opfDir, ref.getAttribute('href') || '') : '',
    spine,
  };
}

// Testo semplice di una pagina XHTML (per cercare l'ISBN nel colophon)
function plainText(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&#8209;|&#8211;/g, '-').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

// Prima immagine di una pagina (la pagina di copertina di molti EPUB è solo un'immagine)
function firstImage(html, base) {
  const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html) || /<image[^>]+(?:xlink:)?href\s*=\s*["']([^"']+)["']/i.exec(html);
  return m ? join(dirOf(base), m[1]) : '';
}

async function readEpub(file, out) {
  const JSZip = await loadJsZip();
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch (e) { throw new Error('il file EPUB è danneggiato'); }
  const get = p => {
    if (!p) return null;
    try { return zip.file(p) || zip.file(decodeURIComponent(p)); } catch (e) { return zip.file(p); }
  };
  const container = get('META-INF/container.xml');
  if (!container) throw new Error('non è un EPUB valido');
  const root = parseXml(await container.async('string')).getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = root && root.getAttribute('full-path');
  const opfFile = opfPath && get(opfPath);
  if (!opfFile) throw new Error('nell\'EPUB manca l\'indice del libro');
  const info = parseOpf(await opfFile.async('string'), dirOf(opfPath));

  const prot = await epubProtection(zip);
  // I byte di un file, se non è fra quelli cifrati. Per le pagine di testo controllo anche
  // che sembrino davvero testo (alcuni negozi cifrano senza dichiararlo).
  const readable = async (path, { text = false } = {}) => {
    const f = path && !prot.encrypted.has(path) ? get(path) : null;
    if (!f) return null;
    const bytes = await f.async('uint8array');
    return text && looksEncrypted(bytes) ? null : bytes;
  };
  const html = async path => {
    const bytes = await readable(path, { text: true });
    return bytes ? new TextDecoder('utf-8').decode(bytes) : '';
  };
  out.drm = prot.kind || '';
  if (!out.drm && info.spine.length && get(info.spine[0]) && !(await readable(info.spine[0], { text: true }))) out.drm = 'protected';

  out.title = info.title;
  out.author = info.authors.join(', ');
  out.year = info.year;
  out.publisher = info.publisher;
  out.genre = mapGenre(info.subjects);
  out.isbns = [...info.isbns];

  // Se l'indice non dice l'ISBN, lo cerco nel colophon: le prime e le ultime pagine
  if (!out.isbns.length && !out.drm) {
    const s = info.spine;
    const pages = [...new Set([...s.slice(0, 4), ...s.slice(-3)])];
    for (const p of pages) {
      for (const c of findIsbns(plainText(await html(p)))) if (!out.isbns.includes(c)) out.isbns.push(c);
    }
  }

  // Copertina
  let coverPath = info.coverHref;
  for (const page of [info.coverPage, info.spine[0]]) {
    if (coverPath) break;
    const h = page && await html(page);
    if (h) coverPath = firstImage(h, page);
  }
  const bytes = await readable(coverPath);
  if (bytes) out.coverBlob = new Blob([bytes], { type: mimeOf(coverPath) });
}

// ------------------------------------------------------------------ PDF
async function readPdf(file, out) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...pdfOptions() });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    task.destroy().catch(() => {});
    // Con password o con un sistema di cifratura dei negozi: si cataloga comunque, dal nome del file
    if (err && (err.name === 'PasswordException' || /encrypt|password/i.test(err.message || ''))) {
      out.drm = err.name === 'PasswordException' ? 'password' : 'protected';
      return;
    }
    throw new Error('il file PDF è danneggiato');
  }
  try {
    out.pages = doc.numPages;
    const meta = await doc.getMetadata().catch(() => null);
    const inf = (meta && meta.info) || {};
    const xmp = name => {
      try { const v = meta && meta.metadata && meta.metadata.get(name); return Array.isArray(v) ? v.join(', ') : v || ''; } catch (e) { return ''; }
    };
    const title = useful(inf.Title) || useful(xmp('dc:title'));
    const author = usefulName(inf.Author) || usefulName(xmp('dc:creator'));
    if (title) out.title = fixCase(clean(title.replace(/_+/g, ' ')));
    if (author) out.author = author.split(/\s*[;&]\s*/).map(normalizeAuthor).filter(Boolean).join(', ');

    // Testo delle prime sei pagine e delle ultime tre
    const n = doc.numPages;
    const wanted = [...new Set([1, 2, 3, 4, 5, 6, n - 2, n - 1, n])].filter(i => i >= 1 && i <= n);
    let text = '';
    for (const i of wanted) {
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        text += tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
        page.cleanup();
      } catch (e) { /* pagina illeggibile: vado avanti */ }
    }
    out.isbns = findIsbns(text);

    // La prima pagina è la copertina
    try {
      const page = await doc.getPage(1);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2, 480 / v1.width) });
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(vp.width));
      cv.height = Math.max(1, Math.round(vp.height));
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      out.coverBlob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    } catch (e) { /* senza copertina */ }
  } finally {
    task.destroy().catch(() => {});
  }
}

// ------------------------------------------------------------------ ingresso
// Restituisce sempre un oggetto: se il file non si legge, error spiega perché.
// { kind, name, size, type, title, author, year, publisher, genre, isbn, isbns, pages,
//   coverBlob, drm, error }
export async function readBookFile(file) {
  const kind = bookKind(file);
  const out = {
    kind, name: file.name || (kind === 'PDF' ? 'libro.pdf' : 'libro.epub'), size: file.size,
    type: kind === 'PDF' ? MIME_PDF : MIME_EPUB,
    title: '', author: '', year: '', publisher: '', genre: '', isbn: '', isbns: [], pages: '',
    coverBlob: null, drm: '', error: '',
  };
  if (!kind) { out.error = 'non è un PDF o un EPUB'; return out; }
  try {
    if (kind === 'EPUB') await readEpub(file, out);
    else await readPdf(file, out);
  } catch (err) {
    out.error = (err && err.message) || 'file illeggibile';
  }
  out.isbn = out.isbns[0] || '';
  if (!out.title) out.title = fixCase(titleFromName(out.name));
  return out;
}
