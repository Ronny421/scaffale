import { db, newId } from './db.js';
import {
  GENRES, genreColor, hash, buildAuthorResolver, similarAuthor, cleanIsbn, isValidIsbn,
  extractFromText, lookupIsbn, searchByText, fetchCover, getGoogleKey, setGoogleKey, statusReport,
  getStoredGoogleKey, BUILTIN_GOOGLE_KEY, classifyCode, lookupEan, authorKey,
} from './catalog.js';
import { barcodeSupported, scanIsbn } from './scanner.js';
import { ocrReady, downloadOcr, removeOcr, recognize } from './ocr.js';
import { buildPdf } from './pdf.js';
import { Reader } from './reader.js';
import { bookKind, readBookFile, MIME_PDF, MIME_EPUB } from './importer.js';
import * as drive from './drive.js';
import * as sync from './sync.js';

const VERSION = '1.12.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  books: [],
  groupBy: localStorage.getItem('groupBy') || 'genre',
  view: localStorage.getItem('view') || 'shelf',
  q: '',
};

// ------------------------------------------------------------ installazione
// Chrome per Android avvisa con l'evento "beforeinstallprompt" quando l'app si può
// installare: lo trattengo e mostro un pulsante, così non serve cercare nel menu ⋮
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('#installBar').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  $('#installBar').hidden = true;
});

// Un'altra finestra con la versione vecchia blocca l'aggiornamento del database
window.addEventListener('db-blocked', () => toast('Aggiornamento in corso: chiudi le altre finestre di Scaffale aperte', 8000));

// Come chiamare il dispositivo nei messaggi: telefono, tablet o computer
const DEV = (() => {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobile|Android|iPhone/i.test(ua)) return 'telefono';
  return 'computer';
})();
const DEV_CAP = DEV.charAt(0).toUpperCase() + DEV.slice(1);

// ---------------------------------------------------------------- utilità
const LOOKUP_MSG = {
  quota: 'Google Books ha esaurito il limite di ricerche, e gli altri archivi non hanno questo libro. Salvalo pure anche senza titolo: completerai i dati con «Completa ora».',
  badkey: 'Google Books rifiuta la chiave{d}. Apri le Impostazioni e premi «Verifica gli archivi».',
  blocked: 'Google Books risponde, ma il ' + DEV + ' non riesce a leggere la risposta: di solito dipende dalla configurazione della chiave. Apri le Impostazioni e premi «Verifica gli archivi».',
  error: 'Google Books ha risposto con un errore{d}, e gli altri archivi non hanno questo libro.',
  temporary: 'Google Books ha un guasto temporaneo{d}: non dipende da te né dalla chiave. Ho già riprovato qualche volta; riprova tra poco, oppure salvalo pure anche senza titolo e completalo dopo con «Completa ora».',
  unreachable: 'Il ' + DEV + ' non riesce a contattare Google Books, e gli altri archivi non hanno questo libro. Salvalo pure anche senza titolo: completerai i dati più tardi con «Completa ora».',
  offline: 'Il ' + DEV + ' non raggiunge nessun archivio: controlla la connessione. Salvalo pure anche senza titolo: completerai i dati più tardi con «Completa ora».',
  notfound: 'Questo ISBN non compare ancora negli archivi online. Succede soprattutto con i libri appena usciti: gli archivi si aggiornano dopo qualche giorno o settimana. Salvalo pure anche solo con l\'ISBN, Scaffale riproverà da sola ogni giorno. Per avere subito titolo e autore, tocca «Copertina» e fotografala.',
};
function lookupMessage(outcome, detail) {
  return (LOOKUP_MSG[outcome] || LOOKUP_MSG.notfound).replace('{d}', detail ? ` («${detail}»)` : '');
}
function showLookupHint(outcome, detail) {
  const h = $('#formHint');
  h.textContent = lookupMessage(outcome, detail);
  if (outcome === 'notfound') return;
  const keyBtn = ['badkey', 'blocked', 'error'].includes(outcome) || (outcome === 'quota' && !getGoogleKey())
    ? '<button type="button" class="btn ghost small" data-act="key">Controlla la chiave</button>' : '';
  h.insertAdjacentHTML('beforeend',
    `<span class="hint-actions">${keyBtn}<button type="button" class="btn small" data-act="retry">Riprova la ricerca</button></span>`);
}
function titleOf(b) {
  return b.title || (b.isbn ? `ISBN ${b.isbn}` : 'Senza titolo');
}
function status(b) {
  if (b.finished || (b.pages && b.currentPage >= b.pages)) return 'done';
  if (b.currentPage > 0) return 'reading';
  return 'todo';
}
function progress(b) {
  if (status(b) === 'done') return 1;
  return b.pages ? Math.min(1, (b.currentPage || 0) / b.pages) : null;
}
function initials(t) {
  return (t || '?').replace(/^(il|lo|la|i|gli|le|l'|un|uno|una|the|a)\s+/i, '').trim().charAt(0).toUpperCase() || '?';
}
function surname(name) {
  if (!name) return '';
  const first = name.split(/,| e | and /)[0].trim();
  if (name.includes(',') && !/ e | and /.test(name)) return name.split(',')[0].trim();
  const parts = first.split(/\s+/);
  return parts[parts.length - 1];
}
function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? '#1D2340' : '#FFFFFF';
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v + amt)));
  return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function spineColor(b) {
  const base = genreColor(b.genre);
  const h = hash(b.id || b.title || '');
  return shade(base, (h % 5 - 2) * 9);
}

const coverUrls = new Map();
function coverUrl(b) {
  if (!b.cover) return null;
  const key = b.id + ':' + (b.coverStamp || 0);
  if (!coverUrls.has(key)) coverUrls.set(key, URL.createObjectURL(b.cover));
  return coverUrls.get(key);
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

async function resizeImage(file, maxH = 720) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxH / bmp.height, (maxH * 0.8) / bmp.width);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
}
async function normalizeCoverBlob(blob) {
  try { return await resizeImage(blob); } catch (e) { return null; }
}

// ------------------------------------------------- fogli dal basso e tasto indietro
// Su Android il tasto "indietro" deve chiudere il foglio aperto, non l'app.
const openStack = [];
function openSheet(dlg) {
  if (dlg.open) return;
  dlg.showModal();
  openStack.push(dlg);
  history.pushState({ sheet: dlg.id }, '');
}
function closeSheet(dlg) {
  if (dlg && dlg.open) dlg.close();
}
$$('dialog.sheet, dialog.reader').forEach(dlg => {
  dlg.addEventListener('close', () => {
    const i = openStack.lastIndexOf(dlg);
    if (i >= 0) {
      openStack.splice(i, 1);
      if (history.state && history.state.sheet === dlg.id) { ignorePop = true; history.back(); }
    }
    dlg.dispatchEvent(new Event('sheetclosed'));
  });
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { closeSheet(dlg); return; }
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) closeSheet(dlg);
    }
  });
});
let ignorePop = false;
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  const top = openStack[openStack.length - 1];
  if (top) { openStack.pop(); top.close(); }
});

// --------------------------------------------------------------- render
function groupBooks(books, by) {
  const resolver = buildAuthorResolver(state.books);
  const groups = new Map();
  const add = (name, b, color, order) => {
    if (!groups.has(name)) groups.set(name, { name, color, order, books: [] });
    groups.get(name).books.push(b);
  };
  for (const b of books) {
    if (by === 'genre') {
      const g = b.genre || 'Senza genere';
      const idx = GENRES.findIndex(x => x.name === g);
      add(g, b, b.genre ? genreColor(g) : '#9AA0B5', idx >= 0 ? idx : (b.genre ? 100 : 999));
    } else if (by === 'author') {
      const a = resolver(b.author) || 'Autore sconosciuto';
      add(a, b, genreColor(b.genre), a === 'Autore sconosciuto' ? '~' : surname(a).toLowerCase());
    } else if (by === 'year') {
      const y = parseInt(b.year, 10);
      if (!y) add('Anno sconosciuto', b, '#9AA0B5', -1);
      else if (y < 1900) add('Prima del 1900', b, '#8A5A3C', 1);
      else { const d = Math.floor(y / 10) * 10; add(`Anni ${d}`, b, '#3A3FD4', d); }
    } else {
      const s = status(b);
      const map = { reading: ['In lettura', '#E9B400', 0], todo: ['Da leggere', '#3A86FF', 1], done: ['Letti', '#1E8E5A', 2] };
      add(map[s][0], b, map[s][1], map[s][2]);
    }
  }
  const list = [...groups.values()];
  if (by === 'year') list.sort((a, b) => b.order - a.order);
  else list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.name.localeCompare(b.name, 'it')));
  for (const g of list) {
    g.books.sort((a, b) => {
      if (by === 'author' || by === 'year') return (parseInt(a.year) || 9999) - (parseInt(b.year) || 9999) || (a.title || '').localeCompare(b.title || '', 'it');
      if (by === 'status' && g.name === 'In lettura') return (b.bookmarkAt || 0) - (a.bookmarkAt || 0);
      return (a.title || '').localeCompare(b.title || '', 'it');
    });
  }
  return list;
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  if (!q) return state.books;
  const nq = q.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return state.books.filter(b => [b.title, b.author, b.isbn, b.publisher, b.genre, b.year, b.digitalOnly ? 'solo digitale ebook' : ''].join(' ')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(nq));
}

function renderStats() {
  const n = state.books.length;
  const reading = state.books.filter(b => status(b) === 'reading').length;
  const done = state.books.filter(b => status(b) === 'done').length;
  $('#stats').innerHTML = n
    ? `<b>${n}</b> ${n === 1 ? 'libro' : 'libri'}, <b>${reading}</b> in lettura, <b>${done}</b> ${done === 1 ? 'letto' : 'letti'}`
    : 'La tua libreria di casa';
}

function spineHtml(b) {
  const c = spineColor(b);
  const h = hash(b.id || b.title);
  const height = 182 + (h % 36);
  const width = b.pages ? Math.round(24 + Math.min(b.pages, 900) / 900 * 30) : 28 + (h % 10);
  const s = status(b);
  const p = progress(b);
  return `<div class="slot"><button class="spine ${s}" data-id="${b.id}" style="--c:${c};--t:${readableOn(c)};--h:${height}px;--w:${width}px${p !== null ? `;--p:${p}` : ';--p:.35'}" aria-label="${esc(titleOf(b))}${b.author ? ', ' + esc(b.author) : ''}">
    ${s === 'reading' ? '<span class="ribbon"></span>' : ''}${s === 'done' ? '<span class="check"></span>' : ''}
    <span class="st">${esc(titleOf(b))}</span>
    <span class="sa">${esc(surname(authorOf(b.author)))}</span>
  </button></div>`;
}

function rowHtml(b) {
  const c = spineColor(b);
  const url = coverUrl(b);
  const s = status(b), p = progress(b);
  const pct = s === 'done' ? '<span class="pct done">Letto</span>'
    : s === 'reading' ? `<span class="pct">${p !== null ? Math.round(p * 100) + '%' : 'p. ' + b.currentPage}${p !== null ? `<span class="bar"><i style="width:${p * 100}%"></i></span>` : ''}</span>`
    : '<span class="pct"></span>';
  return `<button class="row" data-id="${b.id}">
    ${url ? `<img class="thumb" src="${url}" alt="" style="--c:${c}">` : `<span class="thumb" style="--c:${c}">${esc(initials(b.title))}</span>`}
    <span><span class="t">${esc(titleOf(b))}</span><span class="a">${esc(b.author || 'Autore sconosciuto')}</span>
    <span class="meta">${esc([b.year, b.genre, fileLabel(b), b.digitalOnly && 'solo digitale'].filter(Boolean).join(', '))}</span></span>
    ${pct}
  </button>`;
}

let authorOf = a => a;
function render() {
  authorOf = buildAuthorResolver(state.books);
  renderStats();
  $$('#groupBy button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.g === state.groupBy)));
  $('#btnView').innerHTML = `<svg><use href="#i-${state.view === 'shelf' ? 'list' : 'shelf'}"/></svg>`;
  $('#btnView').setAttribute('aria-label', state.view === 'shelf' ? 'Vista elenco' : 'Vista scaffale');

  const main = $('#shelf');
  if (!state.books.length) {
    const cols = ['#3A86FF', '#E63946', '#2A9D8F', '#C9A227', '#7B4FBF'];
    main.innerHTML = `<div class="empty">
      <div class="art">${cols.map((c, i) => `<i style="background:${c};height:${70 + (i * 37) % 50}px"></i>`).join('')}</div>
      <h2>Lo scaffale è vuoto</h2>
      <p>Tocca <b>Aggiungi libro</b> e inquadra il codice a barre sul retro di un libro: titolo, autore e anno si compilano da soli.</p>
      ${DEV === 'computer' ? '<p>Hai degli ebook? Trascina qui i file PDF o EPUB, anche un\'intera cartella.</p>' : ''}
    </div>`;
    return;
  }
  const books = filtered();
  if (!books.length) {
    main.innerHTML = `<div class="empty"><h2>Nessun risultato</h2><p>Nessun libro corrisponde a «${esc(state.q)}».</p></div>`;
    return;
  }
  const groups = groupBooks(books, state.groupBy);
  main.innerHTML = groups.map(g => `<section class="group">
    <div class="group-head"><span class="dot" style="--c:${g.color}"></span><h2>${esc(g.name)}</h2><span class="n">${g.books.length}</span></div>
    ${state.view === 'shelf'
      ? `<div class="shelf">${g.books.map(spineHtml).join('')}</div>`
      : `<div class="list">${g.books.map(rowHtml).join('')}</div>`}
  </section>`).join('');
  renderPending();
}

function renderPending() {
  const n = state.books.filter(b => b.needsLookup).length;
  const show = n > 0 && navigator.onLine;
  $('#pending').hidden = !show;
  if (show) $('#pendingText').textContent = `${n} ${n === 1 ? 'libro aspetta' : 'libri aspettano'} i dati da internet.`;
}

async function reload() {
  state.books = await db.all();
  render();
  if ($('#dlgSettings').open && !$('#bulkBox').hidden) renderBulk();
}

// ------------------------------------------------------------- dettaglio
let currentId = null;
let saveTimer = null;

function openDetail(id) {
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  currentId = id;
  renderDetail(b);
  openSheet($('#dlgBook'));
}

function renderDetail(b) {
  const c = spineColor(b);
  const url = coverUrl(b);
  const p = progress(b);
  const s = status(b);
  const facts = [
    b.genre && `<span class="fact g" style="--c:${genreColor(b.genre)}">${esc(b.genre)}</span>`,
    b.year && `<span class="fact">${esc(b.year)}</span>`,
    b.pages && `<span class="fact">${esc(b.pages)} pagine</span>`,
    b.publisher && `<span class="fact">${esc(b.publisher)}</span>`,
    b.isbn && `<span class="fact">ISBN ${esc(b.isbn)}</span>`,
    b.digitalOnly && '<span class="fact">Solo digitale</span>',
  ].filter(Boolean).join('');
  $('#detail').innerHTML = `
    <div class="detail-top">
      ${url ? `<img class="detail-cover" src="${url}" alt="Copertina">` : `<div class="detail-cover" style="--c:${c}">${esc(initials(b.title))}</div>`}
      <div>
        <h2>${esc(titleOf(b))}</h2>
        ${b.author ? `<button class="by" data-author="${esc(b.author)}">${esc(b.author)}</button>` : '<span class="hint">Autore sconosciuto</span>'}
        <div class="facts">${facts}</div>
      </div>
    </div>
    <div class="bookmark">
      <div class="bookmark-head"><svg><use href="#i-ribbon"/></svg><strong>Segnalibro</strong>
        <span class="pc" id="bmPct">${s === 'done' ? 'Letto' : p !== null ? Math.round(p * 100) + '%' : ''}</span></div>
      <div class="pager">
        <button data-step="-10">−10</button><button data-step="-1">−1</button>
        <input class="page" id="bmPage" type="number" inputmode="numeric" min="0" ${b.pages ? `max="${b.pages}"` : ''} value="${b.currentPage || 0}" aria-label="Pagina a cui sei arrivato">
        <button data-step="1">+1</button><button data-step="10">+10</button>
      </div>
      <p class="of">${b.pages ? `pagina a cui sei arrivato, su ${b.pages}` : 'pagina a cui sei arrivato'}</p>
      ${b.pages ? `<input type="range" id="bmRange" min="0" max="${b.pages}" value="${Math.min(b.currentPage || 0, b.pages)}" aria-label="Avanzamento">` : ''}
      <div class="bm-actions">
        ${s !== 'done' ? '<button class="btn small" id="bmDone">Segna come letto</button>' : '<button class="btn ghost small" id="bmRestart">Rileggilo da capo</button>'}
        ${b.bookmarkAt ? `<span class="hint" style="align-self:center">Aggiornato il ${new Date(b.bookmarkAt).toLocaleDateString('it-IT')}</span>` : ''}
      </div>
    </div>
    ${digitalHtml(b)}
    <div class="detail-actions">
      <button class="btn ghost" id="dEdit"><svg><use href="#i-pen"/></svg>Modifica</button>
      <button class="btn danger" id="dDelete">Elimina</button>
    </div>`;
}

// ------------------------------------------------------------ copia digitale
// Il PDF o l'EPUB di un libro, salvato nel database dell'app: resta solo sul telefono
function fileKind(f) {
  const n = (f.name || '').toLowerCase();
  if (f.type === 'application/epub+zip' || n.endsWith('.epub')) return 'EPUB';
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'PDF';
  return 'File';
}
function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function fileLabel(b) {
  const f = b.file || b.cloud;
  if (!f) return '';
  if (b.file && b.cloud) return fileKind(f) + ', anche su Drive';
  return b.cloud ? fileKind(f) + ' su Drive' : fileKind(f);
}
const sameFile = (a, c) => a && c && a.size === c.size && a.name === c.name;

// Un solo trasferimento alla volta: { bookId, kind: 'up' | 'down', ctrl, progress }
let xfer = null;
// Trasferimento di tutti i file insieme (dalle Impostazioni): vedi «Tutti i PDF ed EPUB»
let bulk = null;

function digitalHtml(b) {
  const local = !!b.file, cloud = !!b.cloud, driveOn = !!drive.getClientId();
  if (!local && !cloud) {
    return `<div class="digital">
      <div class="bookmark-head"><svg><use href="#i-file"/></svg><strong>Copia digitale</strong></div>
      <p class="hint">Allega il PDF o l'EPUB di questo libro: resta salvato su questo ${DEV} e si apre anche senza internet.${driveOn ? ' Poi potrai caricarlo su Google Drive.' : ''}</p>
      <div class="bm-actions"><button class="btn ghost small" id="fAdd">Allega file</button></div>
    </div>`;
  }
  const f = b.file || b.cloud;
  const differs = local && cloud && !sameFile(b.file, b.cloud);
  let where;
  if (local && cloud) {
    where = differs
      ? '<p class="where"><svg><use href="#i-cloud"/></svg>Su Google Drive c\'è una versione diversa da quella di questo ' + DEV + '</p>'
      : '<p class="where cloud"><span class="both"><svg><use href="#i-phone"/></svg><svg><use href="#i-cloud"/></svg></span>Su questo ' + DEV + ' e su Google Drive</p>';
  } else if (local) {
    where = '<p class="where"><svg><use href="#i-phone"/></svg>Solo su questo ' + DEV + '</p>';
  } else {
    where = '<p class="where cloud"><svg><use href="#i-cloud"/></svg>Solo su Google Drive: scaricalo per leggerlo anche offline</p>';
  }
  // Un file protetto si cataloga, ma solo le app autorizzate dal negozio possono aprirlo
  const drm = (b.file && b.file.drm) || (b.cloud && b.cloud.drm) || '';
  if (drm) {
    where += `<p class="where warn"><svg><use href="#i-lock"/></svg>${drm === 'password' ? 'Protetto da password' : 'Protetto da DRM'}: Scaffale non può aprirlo${local ? '. Con «Apri con…» lo passi a un\'app autorizzata' : ''}</p>`;
  }
  const busy = xfer && xfer.bookId === b.id;
  const primary = [];
  if (!drm) primary.push(`<button class="btn small" id="fRead"${busy ? ' disabled' : ''}><svg><use href="#i-book"/></svg>${local ? 'Leggi' : 'Scarica e leggi'}</button>`);
  else if (local) primary.push('<button class="btn small" id="fOpen">Apri con…</button>');
  if (local && !cloud && driveOn) primary.push(`<button class="btn ghost small" id="fUpload"${busy ? ' disabled' : ''}><svg><use href="#i-up"/></svg>Carica su Drive</button>`);
  if (differs && driveOn) primary.push(`<button class="btn ghost small" id="fUpload"${busy ? ' disabled' : ''}><svg><use href="#i-up"/></svg>Sostituisci su Drive</button>`);
  if (!local && cloud) primary.push(`<button class="btn ghost small" id="fDownload"${busy ? ' disabled' : ''}><svg><use href="#i-down"/></svg>Scarica sul ${DEV}</button>`);
  const more = [];
  if (local && !drm) more.push('<button class="btn ghost small" id="fOpen">Apri con…</button>');
  if (local) more.push('<button class="btn ghost small" id="fSave">Salva nei Download</button>');
  if (local && cloud) more.push('<button class="btn ghost small" id="fFree">Libera spazio sul ' + DEV + '</button>');
  if (cloud) more.push('<button class="btn danger small" id="fCloudDelete">Elimina da Drive</button>');
  if (local) more.push(`<button class="btn danger small" id="fRemove">${cloud ? 'Rimuovi dal ' + DEV : 'Rimuovi'}</button>`);
  more.push('<button class="btn ghost small" id="fAdd">Allega un altro file</button>');
  return `<div class="digital">
      <div class="bookmark-head"><svg><use href="#i-file"/></svg><strong>Copia digitale</strong><span class="badge">${fileKind(f)}</span></div>
      <p class="file-name">${esc(f.name)}<small>${formatSize(f.size)}</small></p>
      ${where}
      ${busy ? `<div class="xfer"><div class="progress"><i style="width:${Math.round(xfer.progress * 100)}%"></i></div>
        <div class="xfer-row"><span id="xferText">${xfer.kind === 'up' ? 'Carico su Google Drive' : 'Scarico da Google Drive'}… ${Math.round(xfer.progress * 100)}%</span>
        <button class="btn ghost small" id="fCancel">Annulla</button></div></div>` : ''}
      <div class="bm-actions">${primary.join('')}</div>
      ${busy ? '' : `<details class="more"><summary>Altre azioni</summary><div class="bm-actions">${more.join('')}</div></details>`}
    </div>`;
}

function driveMessage(err) {
  if (!err) return 'Operazione non riuscita';
  if (err.reason === 'login') return 'Serve di nuovo l\'accesso a Google: tocca di nuovo il pulsante';
  if (err.reason === 'noclient') return 'Prima collega Google Drive nelle Impostazioni';
  return err.message || 'Operazione su Google Drive non riuscita';
}

// Come si descrive su Drive il file caricato (viaggia con la sincronizzazione)
function cloudInfo(id, rec) {
  const c = { id, name: rec.name, type: rec.type, size: rec.size };
  if (rec.drm) c.drm = rec.drm;
  return c;
}

// Da chiamare dentro un tocco: se serve, apre la finestra di Google.
// minValid: quanto deve durare ancora il permesso (per i trasferimenti lunghi)
async function ensureDrive(minValid) {
  if (!drive.getClientId()) {
    toast('Prima collega Google Drive nelle Impostazioni');
    openSettings('drive');
    return false;
  }
  try {
    const wasOn = drive.isEnabled();
    if (!wasOn) { await drive.signIn(); refreshDriveSection(); }
    else await drive.ensureToken(true, minValid);
    return true;
  } catch (err) {
    toast(driveMessage(err), 6000);
    return false;
  }
}

// Carica su Drive il file di un libro e lo annota nella scheda. Restituisce false se il
// libro è stato eliminato nel frattempo: in quel caso il file caricato va nel cestino.
async function sendToDrive(bookId, rec, { signal, onProgress } = {}) {
  const res = await drive.uploadBook({ blob: rec.blob, name: rec.name, mimeType: rec.type, onProgress, signal });
  let old = null;
  const saved = await db.update(bookId, cur => {
    old = cur.cloud && cur.cloud.id;
    cur.cloud = cloudInfo(res.id, rec);
    cur.editedAt = Date.now();
  });
  if (!saved) { sync.queueTrash(res.id); return false; }
  if (old && old !== res.id) sync.queueTrash(old); // la versione precedente va nel cestino di Drive
  return true;
}

// Scarica da Drive il file di un libro e lo salva su questo dispositivo.
// Restituisce 'ok', 'gone' (libro eliminato nel frattempo) o 'missing' (non è più su Drive)
async function fetchFromDrive(b, { signal, onProgress } = {}) {
  let blob;
  try {
    blob = await drive.downloadBook(b.cloud.id, { onProgress, signal });
  } catch (err) {
    if (err.reason !== 'notFound') throw err;
    // Il file è stato eliminato da Drive direttamente: tolgo il riferimento
    await db.update(b.id, cur => { delete cur.cloud; cur.editedAt = Date.now(); });
    return 'missing';
  }
  const type = b.cloud.type || blob.type;
  const drm = b.cloud.drm ? { drm: b.cloud.drm } : {};
  if (!(await db.get(b.id))) return 'gone';
  await db.files.put({ bookId: b.id, name: b.cloud.name, type, size: blob.size, blob: new Blob([blob], { type }), addedAt: Date.now(), ...drm });
  const saved = await db.update(b.id, cur => { cur.file = { name: b.cloud.name, type, size: blob.size, ...drm }; });
  if (!saved) { await db.files.remove(b.id); return 'gone'; }
  return 'ok';
}

// Il browser concede a ogni sito una parte del disco: c'è posto per altri "bytes"?
async function roomFor(bytes) {
  if (!(navigator.storage && navigator.storage.estimate)) return true;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return !quota || quota - usage >= bytes * 1.1;
}

function startXfer(b, kind) {
  xfer = { bookId: b.id, kind, ctrl: new AbortController(), progress: 0 };
  if ($('#dlgBook').open && currentId === b.id) renderDetail(b);
  return xfer;
}
function xferProgress(p) {
  if (!xfer) return;
  xfer.progress = p;
  const bar = $('.xfer .progress i'), txt = $('#xferText');
  if (bar) bar.style.width = Math.round(p * 100) + '%';
  if (txt) txt.textContent = `${xfer.kind === 'up' ? 'Carico su Google Drive' : 'Scarico da Google Drive'}… ${Math.round(p * 100)}%`;
}
function endXfer() {
  const id = xfer && xfer.bookId;
  xfer = null;
  const b = state.books.find(x => x.id === id);
  if (b && $('#dlgBook').open && currentId === id) renderDetail(b);
}

// Il file locale non c'è più: tolgo il riferimento dalla versione attuale del libro
async function forgetLocalFile(b) {
  await db.update(b.id, cur => { if (!cur.file) return false; delete cur.file; }, { quiet: true });
  await reload();
  const fresh = state.books.find(x => x.id === b.id);
  if (fresh && $('#dlgBook').open && currentId === b.id) renderDetail(fresh);
}

const transferBusy = () => {
  if (xfer || bulk) { toast('Aspetta che finisca il trasferimento in corso'); return true; }
  return false;
};

async function uploadToDrive(b) {
  if (transferBusy()) return;
  if (!(await ensureDrive())) return;
  const rec = await db.files.get(b.id);
  if (!rec) { await forgetLocalFile(b); toast('Il file non è su questo ' + DEV); return; }
  const x = startXfer(b, 'up');
  try {
    if (!(await sendToDrive(b.id, rec, { onProgress: xferProgress, signal: x.ctrl.signal }))) {
      toast('Il libro è stato eliminato durante il caricamento');
      return;
    }
    await reload();
    toast('Caricato su Google Drive');
    sync.schedule(1000);
  } catch (err) {
    if (err.reason !== 'aborted') toast(driveMessage(err), 6000);
  } finally {
    endXfer(); render();
  }
}

// Scarica la copia di Drive sul telefono; restituisce true se ci è riuscito
async function downloadFromDrive(b) {
  if (transferBusy()) return false;
  if (!b.cloud) return false;
  if (!(await ensureDrive())) return false;
  if (!(await roomFor(b.cloud.size || 0))) { toast('Spazio insufficiente sul ' + DEV + ' per questo file'); return false; }
  const x = startXfer(b, 'down');
  try {
    const r = await fetchFromDrive(b, { onProgress: xferProgress, signal: x.ctrl.signal });
    await reload();
    if (r === 'gone') { toast('Il libro è stato eliminato durante lo scaricamento'); return false; }
    if (r === 'missing') { toast('Il file non è più su Google Drive', 6000); return false; }
    requestPersistence();
    toast('Scaricato sul ' + DEV);
    return true;
  } catch (err) {
    if (err.reason !== 'aborted') toast(driveMessage(err), 6000);
    return false;
  } finally {
    endXfer(); render();
  }
}

// ------------------------------------------------------------ tutti i PDF ed EPUB insieme
// Dalle Impostazioni: carica su Drive tutti i file che sono solo su questo dispositivo, o
// scarica qui tutti quelli che sono solo su Drive. Un file alla volta, con l'avanzamento
// complessivo; si può interrompere, e premendo di nuovo si riparte da quelli mancanti.
function bulkLists() {
  const up = state.books.filter(b => b.file && !b.cloud);
  const down = state.books.filter(b => b.cloud && !b.file);
  const bytes = (list, key) => list.reduce((s, b) => s + ((b[key] && b[key].size) || 0), 0);
  return { up, down, upBytes: bytes(up, 'file'), downBytes: bytes(down, 'cloud'), any: state.books.some(b => b.file || b.cloud) };
}

function renderBulk() {
  const box = $('#bulkBox');
  box.hidden = !drive.isEnabled();
  if (box.hidden) return;
  $('#bulkXfer').hidden = !bulk;
  $('#bulkBtns').hidden = !!bulk;
  if (bulk) { bulkProgress(); return; }
  const { up, down, upBytes, downBytes, any } = bulkLists();
  const parts = [];
  if (up.length) parts.push(`${up.length} ${up.length === 1 ? 'libro ha' : 'libri hanno'} il file solo su questo ${DEV} (${formatSize(upBytes)}).`);
  if (down.length) parts.push(`${down.length} ${down.length === 1 ? 'libro ha' : 'libri hanno'} il file solo su Google Drive (${formatSize(downBytes)}).`);
  if (!parts.length) parts.push(any ? `Tutti i PDF e gli EPUB sono sia su questo ${DEV} sia su Google Drive.` : 'Nessun libro ha ancora un PDF o un EPUB.');
  $('#bulkInfo').textContent = parts.join(' ');
  $('#btnBulkUp').hidden = !up.length;
  $('#btnBulkDown').hidden = !down.length;
  $('#btnBulkDown').classList.toggle('ghost', !!up.length); // in evidenza quando è l'unica azione
}

function bulkProgress() {
  if (!bulk) return;
  const frac = bulk.bytesTotal ? Math.min(1, (bulk.bytesDone + bulk.curBytes) / bulk.bytesTotal) : bulk.done / bulk.total;
  const bar = $('#bulkXfer .progress i');
  if (bar) bar.style.width = (frac * 100).toFixed(1) + '%';
  const n = Math.min(bulk.done + 1, bulk.total);
  $('#bulkText').textContent = `${bulk.kind === 'up' ? 'Carico su Drive' : 'Scarico'} ${n} di ${bulk.total}${bulk.current ? ': «' + bulk.current + '»' : ''}`;
  renderSyncChip();
}

// Il telefono non deve spegnere lo schermo (e la rete) mentre trasferisce
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

async function bulkTransfer(kind) {
  if (transferBusy()) return;
  // Il permesso di Google dura un'ora: se scade entro 20 minuti ne chiedo subito uno nuovo,
  // ora che c'è il tocco (a metà del trasferimento non si potrebbe aprire la finestra)
  if (!(await ensureDrive(20 * 60000))) return;
  await reload();
  const lists = bulkLists();
  const list = kind === 'up' ? lists.up : lists.down;
  if (!list.length) { renderBulk(); return; }
  if (kind === 'down' && !(await roomFor(lists.downBytes))) {
    toast(`Spazio insufficiente sul ${DEV}: servono circa ${formatSize(lists.downBytes)}`, 6000);
    return;
  }
  const job = bulk = {
    kind, ctrl: new AbortController(), total: list.length, done: 0, ok: 0, failed: 0,
    bytesTotal: kind === 'up' ? lists.upBytes : lists.downBytes, bytesDone: 0, curBytes: 0, current: '',
  };
  keepAwake(true);
  renderBulk();
  let stop = '';
  try {
    for (const b of list) {
      if (job.ctrl.signal.aborted) { stop = 'Hai interrotto il trasferimento'; break; }
      const size = ((kind === 'up' ? b.file : b.cloud) || {}).size || 0;
      job.current = titleOf(b); job.curBytes = 0;
      bulkProgress();
      // Ogni file ha il suo «Annulla» nella scheda del libro; «Interrompi» li ferma tutti
      const ctrl = new AbortController();
      const stopAll = () => ctrl.abort();
      job.ctrl.signal.addEventListener('abort', stopAll);
      xfer = { bookId: b.id, kind, ctrl, progress: 0 };
      if ($('#dlgBook').open && currentId === b.id) renderDetail(b);
      const onProgress = p => { job.curBytes = p * size; xferProgress(p); bulkProgress(); };
      try {
        if (kind === 'up') {
          const rec = await db.files.get(b.id);
          if (!rec) await forgetLocalFile(b); // il file non c'è più: niente da caricare
          else if (await sendToDrive(b.id, rec, { signal: ctrl.signal, onProgress })) job.ok++;
        } else {
          const cur = await db.get(b.id);
          if (cur && cur.cloud && !cur.file && (await fetchFromDrive(cur, { signal: ctrl.signal, onProgress })) === 'ok') job.ok++;
        }
      } catch (err) {
        if (err.reason === 'aborted') {
          if (job.ctrl.signal.aborted) { stop = 'Hai interrotto il trasferimento'; break; }
        } else {
          job.failed++;
          // Inutile insistere con gli altri: permesso scaduto, Drive pieno, niente rete
          if (['login', 'noclient', 'storageQuotaExceeded', 'offline'].includes(err.reason)) {
            stop = err.reason === 'login' ? 'Il permesso di Google è scaduto' : driveMessage(err);
            break;
          }
        }
      } finally {
        job.ctrl.signal.removeEventListener('abort', stopAll);
        job.done++; job.bytesDone += size; job.curBytes = 0;
        endXfer();
      }
    }
  } finally {
    bulk = null;
    keepAwake(false);
    await reload();
    renderBulk(); renderSyncChip();
    if (kind === 'down') requestPersistence();
    sync.schedule(1000);
  }
  // Il riepilogo: quanti file sono passati e, se ne mancano, come continuare
  const verb = kind === 'up' ? (job.ok === 1 ? 'caricato su Google Drive' : 'caricati su Google Drive')
    : (job.ok === 1 ? 'scaricato su questo ' : 'scaricati su questo ') + DEV;
  const left = job.total - job.ok;
  let msg = capital(`${job.ok} file ${verb}`);
  if (stop) msg = `${stop}. ${msg}`;
  if (left > 0) {
    msg += `; ${left === 1 ? 'ne manca 1' : `ne mancano ${left}`}: per ${stop ? 'continuare' : 'riprovare'} premi di nuovo «${kind === 'up' ? 'Carica tutti su Drive' : 'Scarica tutti qui'}»`;
  }
  toast(msg + '.', 9000);
}

$('#btnBulkUp').addEventListener('click', () => bulkTransfer('up'));
$('#btnBulkDown').addEventListener('click', () => bulkTransfer('down'));
$('#btnBulkStop').addEventListener('click', () => { if (bulk) bulk.ctrl.abort(); });
// Chiudere la pagina interromperebbe il trasferimento: il browser chiede conferma
window.addEventListener('beforeunload', e => {
  if (bulk || (imp && imp.phase === 'saving')) { e.preventDefault(); e.returnValue = ''; }
});

async function openBookFile(b, how) {
  const rec = await db.files.get(b.id);
  if (!rec) {
    await forgetLocalFile(b);
    toast(b.cloud ? 'Il file è su Google Drive: scaricalo sul ' + DEV : 'Il file non è su questo ' + DEV + ': allegalo di nuovo');
    return;
  }
  const file = new File([rec.blob], rec.name, { type: rec.type });
  // "Apri con…": il menu di condivisione di Android propone le app di lettura installate
  if (how === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: titleOf(b) }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  // Se la condivisione non è possibile (per esempio con gli EPUB) salvo una copia nei Download
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = rec.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(how === 'share' ? 'Salvato nei Download: aprilo con la tua app di lettura' : 'Copia salvata nei Download');
}

$('#bookFileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  const b = state.books.find(x => x.id === currentId);
  if (!f || !b) return;
  const kind = bookKind(f);
  if (!kind) { toast('Scegli un file PDF o EPUB'); return; }
  const type = kind === 'PDF' ? MIME_PDF : MIME_EPUB;
  // Il browser concede a ogni sito una parte del disco del telefono: controllo che basti
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < f.size * 1.1) { toast('Spazio insufficiente sul ' + DEV + ' per questo file'); return; }
  }
  toast('Salvo il file…', 15000);
  // Dal file ricavo la copertina (se il libro non ne ha una) e se è protetto da DRM
  const meta = await readBookFile(f);
  const drm = meta.drm ? { drm: meta.drm } : {};
  try {
    // Copio i byte in un nuovo Blob: così il file resta nell'app anche se cancelli l'originale
    const blob = new Blob([await f.arrayBuffer()], { type });
    await db.files.put({ bookId: b.id, name: f.name, type, size: f.size, blob, addedAt: Date.now(), ...drm });
  } catch (err) {
    toast('Non sono riuscito a salvare il file: ' + (err.message || err.name));
    return;
  }
  b.file = { name: f.name, type, size: f.size, ...drm };
  if (!b.cover && meta.coverBlob) {
    const cover = await normalizeCoverBlob(meta.coverBlob);
    if (cover) { const now = Date.now(); b.cover = cover; b.coverStamp = now; b.coverRev = b.coverLocalRev = now; b.editedAt = now; }
  }
  if (!(await db.putExisting(b))) { await db.files.remove(b.id); return; }
  requestPersistence();
  renderDetail(b); render();
  toast(meta.drm ? 'File salvato, ma è protetto: Scaffale non può aprirlo'
    : b.cloud && !sameFile(b.file, b.cloud) ? 'File salvato: su Drive resta la versione precedente' : 'File salvato su questo ' + DEV);
});

// ------------------------------------------------------------ lettore integrato
// Mentre leggi, la posizione nel file diventa il segnalibro dello scaffale.
let reader = null, readingId = null, readTimer = null;
function getReader() {
  if (!reader) {
    reader = new Reader({
      root: $('#dlgReader'), view: $('#rView'), where: $('#rWhere'), range: $('#rRange'),
      prev: $('#rPrev'), next: $('#rNext'), smaller: $('#rSmaller'), bigger: $('#rBigger'),
      modeV: $('#rModeV'), modeH: $('#rModeH'),
    }, {
      onProgress: readerProgress,
      onClose: () => closeSheet($('#dlgReader')),
      onMode: mode => {
        try { localStorage.setItem('readerMode', mode); } catch (e) { /* niente */ }
        toast(mode === 'scroll' ? 'Scorrimento verticale' : 'Pagine affiancate');
      },
    });
  }
  return reader;
}
function readerColors() {
  const t = document.documentElement.dataset.theme;
  const dark = t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark
    ? { dark: true, bg: '#141829', ink: '#E3E5F2', accent: '#8287FF' }
    : { dark: false, bg: '#FFFFFF', ink: '#1D2340', accent: '#3A3FD4' };
}

async function openReaderFor(book) {
  let b = book;
  let rec = await db.files.get(b.id);
  if (!rec && b.cloud) {
    if (!(await downloadFromDrive(b))) return;
    rec = await db.files.get(b.id);
    b = state.books.find(x => x.id === b.id) || b;
  }
  if (!rec) {
    await forgetLocalFile(b);
    toast('Il file non è su questo ' + DEV + ': allegalo di nuovo');
    return;
  }
  const kind = fileKind(rec);
  readingId = b.id;
  $('#rTitle').textContent = titleOf(b);
  $('#rWhere').textContent = '';
  $('#rLoading').hidden = false;
  openSheet($('#dlgReader'));
  // Riprendo dal punto esatto in cui avevi chiuso; altrimenti dalla pagina del segnalibro
  const pos = b.readerPos && b.readerPos.kind === kind.toLowerCase() ? b.readerPos
    : (b.currentPage > 0 && b.pages ? { fraction: b.currentPage / b.pages } : null);
  try {
    await getReader().open({
      blob: rec.blob, kind, pos,
      fontScale: +(localStorage.getItem('readerFont') || 100),
      colors: readerColors(),
      mode: localStorage.getItem('readerMode') || 'pages',
    });
    $('#rView').focus();
  } catch (err) {
    readingId = null; // nessuna posizione da salvare
    closeSheet($('#dlgReader'));
    const locked = err.code === 'drm' || /encrypt/i.test(err.message || '') ? 'drm' : err.name === 'PasswordException' ? 'password' : '';
    if (locked) {
      toast(locked === 'password' ? 'Questo PDF è protetto da password: Scaffale non può aprirlo'
        : 'Questo libro è protetto da DRM: si legge solo sui dispositivi e nelle app autorizzati dal negozio, come il tuo e-reader', 8000);
      // Lo annoto nella scheda, così la prossima volta lo dice subito
      await db.update(b.id, cur => { if (!cur.file || cur.file.drm) return false; cur.file = { ...cur.file, drm: locked }; }, { quiet: true });
      await reload();
      const fresh = state.books.find(x => x.id === b.id);
      if (fresh && $('#dlgBook').open && currentId === b.id) renderDetail(fresh);
    } else {
      console.error(err);
      toast('Non riesco ad aprire questo file: ' + (err.message || 'formato non riconosciuto'), 6000);
    }
  } finally {
    $('#rLoading').hidden = true;
  }
}

function readerProgress(p) {
  const b = state.books.find(x => x.id === readingId);
  if (!b) return '';
  // Se lo scaffale non conosce le pagine: quelle del PDF, o una stima per l'EPUB
  if (!b.pages) { b.pages = p.units; b.pagesEstimated = p.kind === 'epub'; b.editedAt = Date.now(); }
  // Le pagine del file possono essere diverse da quelle dell'edizione: le converto in proporzione
  const page = p.kind === 'pdf' && b.pages === p.units ? p.page : Math.max(1, Math.round(p.fraction * b.pages));
  b.currentPage = Math.min(page, b.pages);
  b.finished = b.currentPage >= b.pages;
  b.bookmarkAt = Date.now();
  b.readerPos = p.kind === 'pdf' ? { kind: 'pdf', page: p.page } : { kind: 'epub', chapter: p.chapter, frac: p.frac };
  clearTimeout(readTimer);
  readTimer = setTimeout(() => db.putExisting(b), 600);
  return `pag. ${b.currentPage} di ${b.pages}${b.pagesEstimated ? ' (stimate)' : ''}`;
}

$('#rClose').addEventListener('click', () => closeSheet($('#dlgReader')));
$('#dlgReader').addEventListener('sheetclosed', async () => {
  clearTimeout(readTimer);
  // Prima di tutto salvo il segnalibro: qualunque cosa succeda dopo, la posizione è al sicuro
  const b = state.books.find(x => x.id === readingId);
  readingId = null;
  if (b) await db.putExisting(b);
  const fs = getReader().fontScale();
  if (fs) localStorage.setItem('readerFont', String(fs));
  getReader().close();
  if (b && $('#dlgBook').open && currentId === b.id) renderDetail(b);
  render();
  sync.schedule(1500); // il segnalibro arriva subito sugli altri dispositivi
});

function setPage(v) {
  const b = state.books.find(x => x.id === currentId);
  if (!b) return;
  v = Math.max(0, parseInt(v, 10) || 0);
  if (b.pages) v = Math.min(v, b.pages);
  b.currentPage = v;
  b.finished = b.pages ? v >= b.pages : b.finished && v > 0;
  b.bookmarkAt = Date.now();
  const inp = $('#bmPage'); if (inp && document.activeElement !== inp) inp.value = v;
  const rng = $('#bmRange'); if (rng) rng.value = v;
  const p = progress(b);
  $('#bmPct').textContent = status(b) === 'done' ? 'Letto' : p !== null ? Math.round(p * 100) + '%' : '';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; db.putExisting(b); }, 300);
}

$('#dlgBook').addEventListener('click', async e => {
  const b = state.books.find(x => x.id === currentId);
  if (!b) return;
  const step = e.target.closest('[data-step]');
  if (step) { setPage((b.currentPage || 0) + +step.dataset.step); return; }
  if (e.target.closest('#bmDone')) {
    if (b.pages) b.currentPage = b.pages;
    b.finished = true; b.bookmarkAt = Date.now();
    await db.putExisting(b); renderDetail(b); toast('Segnato come letto');
    return;
  }
  if (e.target.closest('#bmRestart')) {
    b.currentPage = 0; b.finished = false; b.bookmarkAt = Date.now();
    await db.putExisting(b); renderDetail(b); return;
  }
  const by = e.target.closest('.by');
  if (by) {
    state.q = by.dataset.author; $('#q').value = state.q;
    closeSheet($('#dlgBook')); render(); return;
  }
  if (e.target.closest('#fAdd')) { $('#bookFileInput').click(); return; }
  if (e.target.closest('#fUpload')) { uploadToDrive(b); return; }
  if (e.target.closest('#fDownload')) { downloadFromDrive(b); return; } // la scheda si aggiorna da sola alla fine
  if (e.target.closest('#fCancel')) { if (xfer) xfer.ctrl.abort(); return; }
  if (e.target.closest('#fFree')) {
    await db.files.remove(b.id);
    delete b.file;
    await db.putExisting(b);
    renderDetail(b); render();
    toast('Spazio liberato: il libro resta su Google Drive');
    return;
  }
  if (e.target.closest('#fCloudDelete')) {
    const only = !b.file;
    if (!confirm(`Spostare «${b.cloud.name}» nel cestino di Google Drive?${only ? ` Non è salvato su questo ${DEV}: il libro resterà senza copia digitale.` : ` Resta la copia su questo ${DEV}.`}`)) return;
    sync.queueTrash(b.cloud.id);
    delete b.cloud;
    b.editedAt = Date.now();
    await db.putExisting(b);
    renderDetail(b); render();
    toast('Spostato nel cestino di Google Drive');
    sync.schedule(1000);
    return;
  }
  if (e.target.closest('#fRead')) { openReaderFor(b); return; }
  if (e.target.closest('#fOpen')) { openBookFile(b, 'share'); return; }
  if (e.target.closest('#fSave')) { openBookFile(b, 'download'); return; }
  if (e.target.closest('#fRemove')) {
    if (!confirm(`Rimuovere il file «${b.file.name}» da Scaffale? Il libro resta nello scaffale.`)) return;
    await db.files.remove(b.id);
    delete b.file;
    await db.putExisting(b);
    renderDetail(b);
    toast('File rimosso');
    return;
  }
  if (e.target.closest('#dEdit')) {
    closeSheet($('#dlgBook'));
    openForm({ ...b }, { existing: b });
    return;
  }
  if (e.target.closest('#dDelete')) {
    const synced = drive.isEnabled();
    const parts = [`Eliminare «${titleOf(b)}» dallo scaffale${synced ? ' su tutti i dispositivi collegati' : ''}?`];
    if (b.file) parts.push('Verrà eliminata anche la copia digitale su questo ' + DEV + '.');
    if (b.cloud) parts.push('La copia su Google Drive andrà nel cestino di Drive.');
    if (!confirm(parts.join(' '))) return;
    // Prima lo tolgo dalla memoria e annullo i salvataggi in sospeso: la chiusura della
    // scheda non deve poterlo salvare di nuovo
    clearTimeout(saveTimer); saveTimer = null;
    state.books = state.books.filter(x => x.id !== b.id);
    currentId = null;
    if (b.cloud) sync.queueTrash(b.cloud.id);
    sync.recordDeletion(b.id);
    await db.remove(b.id);
    closeSheet($('#dlgBook'));
    await reload();
    toast('Libro eliminato');
  }
});
$('#dlgBook').addEventListener('input', e => {
  if (e.target.id === 'bmPage' || e.target.id === 'bmRange') setPage(e.target.value);
});
$('#dlgBook').addEventListener('sheetclosed', async () => {
  // Salvo solo un segnalibro rimasto in sospeso, e solo se il libro esiste ancora
  if (saveTimer) {
    clearTimeout(saveTimer); saveTimer = null;
    const b = state.books.find(x => x.id === currentId);
    if (b) await db.putExisting(b);
  }
  render();
});

// ----------------------------------------------------------------- form
const form = $('#bookForm');
let formCtx = { existing: null, cover: null, coverChanged: false, needsLookup: false };
let lastField = 'title';

function renderGenreChips(selected) {
  const custom = [...new Set(state.books.map(b => b.genre).filter(g => g && !GENRES.some(x => x.name === g)))];
  const all = [...GENRES.map(g => g.name), ...custom];
  $('#genreChips').innerHTML = all.map(g =>
    `<button type="button" class="chip" style="--c:${genreColor(g)}" data-genre="${esc(g)}" aria-pressed="${g === selected}"><i></i>${esc(g)}</button>`).join('');
  $('#genreInput').value = selected && !all.includes(selected) ? selected : '';
}

function setCoverPreview(blob) {
  const img = $('#coverPreview');
  if (blob) { img.src = URL.createObjectURL(blob); img.hidden = false; $('#coverEmpty').hidden = true; }
  else { img.hidden = true; img.removeAttribute('src'); $('#coverEmpty').hidden = false; }
}

function fillForm(data, { overwrite = true } = {}) {
  for (const k of ['title', 'author', 'year', 'pages', 'isbn', 'publisher']) {
    if (data[k] === undefined || data[k] === null || data[k] === '') continue;
    const el = form.elements[k];
    if (overwrite || !el.value.trim()) el.value = data[k];
  }
  if (data.genre && (overwrite || !currentGenre())) selectGenre(data.genre);
  checkAuthor();
}

function currentGenre() {
  const pressed = $('#genreChips [aria-pressed="true"]');
  return ($('#genreInput').value.trim()) || (pressed ? pressed.dataset.genre : '');
}
function selectGenre(g) {
  let found = false;
  $$('#genreChips .chip').forEach(c => { const on = c.dataset.genre === g; c.setAttribute('aria-pressed', on); if (on) found = true; });
  $('#genreInput').value = found ? '' : g;
}

function checkAuthor() {
  const v = form.elements.author.value.trim();
  const s = v ? similarAuthor(v, state.books.filter(b => !formCtx.existing || b.id !== formCtx.existing.id)) : null;
  const btn = $('#authorSuggest');
  if (s) { btn.hidden = false; btn.textContent = `Nello scaffale c'è già «${s}». Tocca per usare lo stesso nome.`; btn.dataset.name = s; }
  else btn.hidden = true;
}

function openForm(data = {}, opts = {}) {
  form.reset();
  formCtx = { existing: opts.existing || null, cover: opts.existing ? opts.existing.cover || null : (opts.cover || null), coverChanged: !!opts.cover, needsLookup: !!opts.needsLookup };
  $('#formTitle').textContent = opts.existing ? 'Modifica libro' : 'Nuovo libro';
  $('#formHint').textContent = opts.hint || '';
  $('#authorsList').innerHTML = [...new Set(state.books.map(b => b.author).filter(Boolean))].map(a => `<option value="${esc(a)}">`).join('');
  renderGenreChips(data.genre || '');
  fillForm(data);
  form.elements.digitalOnly.checked = !!data.digitalOnly;
  setCoverPreview(formCtx.cover);
  $('#ocrBox').hidden = true;
  $('#ocrLines').innerHTML = '';
  $('#candidates').innerHTML = '';
  $('#eanBox').hidden = true;
  $('#eanCandidates').innerHTML = '';
  lastField = 'title';
  openSheet($('#dlgForm'));
}

form.addEventListener('focusin', e => {
  if (['title', 'author', 'year', 'publisher', 'isbn', 'pages'].includes(e.target.name)) lastField = e.target.name;
});
form.elements.author.addEventListener('input', checkAuthor);
$('#authorSuggest').addEventListener('click', e => {
  form.elements.author.value = e.currentTarget.dataset.name; checkAuthor();
});
$('#genreChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const on = c.getAttribute('aria-pressed') !== 'true';
  $$('#genreChips .chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
  c.setAttribute('aria-pressed', String(on));
  $('#genreInput').value = '';
});
$('#genreInput').addEventListener('input', () => {
  if ($('#genreInput').value.trim()) $$('#genreChips .chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
});

$('#coverPick').addEventListener('click', () => $('#coverInput').click());
$('#coverInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  formCtx.cover = await resizeImage(f);
  formCtx.coverChanged = true;
  setCoverPreview(formCtx.cover);
  if (!form.elements.title.value.trim()) runOcr(f);
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const f = form.elements;
  const title = f.title.value.trim();
  const isbn = cleanIsbn(f.isbn.value);
  if (!title && !(formCtx.needsLookup && isbn)) { f.title.focus(); toast('Scrivi almeno il titolo'); return; }
  const dup = isbn && state.books.find(b => b.isbn === isbn && (!formCtx.existing || b.id !== formCtx.existing.id));
  if (dup && !confirm(`Hai già «${dup.title}» con lo stesso ISBN. Salvare comunque una seconda copia?`)) return;

  const base = formCtx.existing || { id: newId(), addedAt: Date.now(), currentPage: 0, finished: false };
  const book = {
    ...base,
    title,
    author: f.author.value.trim(),
    year: (f.year.value.match(/\d{3,4}/) || [''])[0],
    pages: parseInt(f.pages.value, 10) || '',
    genre: currentGenre(),
    isbn,
    publisher: f.publisher.value.trim(),
    needsLookup: formCtx.needsLookup && !!isbn,
  };
  if (f.digitalOnly.checked) book.digitalOnly = true;
  else delete book.digitalOnly;
  book.editedAt = Date.now();
  if (formCtx.coverChanged) {
    book.cover = formCtx.cover; book.coverStamp = Date.now();
    book.coverRev = book.coverLocalRev = book.cover ? Date.now() : undefined;
  }
  // Un libro che aspettava i dati da internet continua ad aspettarli, finché ne mancano
  if (formCtx.existing && formCtx.existing.needsLookup && !book.needsLookup) book.needsLookup = canLookup(book) && needsData(book);
  if (book.pages && book.currentPage > book.pages) book.currentPage = book.pages;
  if (book.pagesEstimated && formCtx.existing && book.pages !== formCtx.existing.pages) book.pagesEstimated = false;
  await db.put(book);
  requestPersistence();
  closeSheet($('#dlgForm'));
  await reload();
  toast(formCtx.existing ? 'Modifiche salvate' : 'Libro salvato nello scaffale');
});

// --- OCR nel form
function showOcrLines(lines) {
  const box = $('#ocrLines');
  box.insertAdjacentHTML('beforeend', lines.map(l => `<button type="button" class="chip" data-line="${esc(l)}">${esc(l)}</button>`).join(''));
}
function ocrMessage(html) {
  $('#ocrBox').hidden = false;
  $('#ocrLines').innerHTML = `<p class="hint">${html}</p>`;
}

$('#ocrLines').addEventListener('click', e => {
  const c = e.target.closest('[data-line]'); if (!c) return;
  const line = c.dataset.line;
  const el = form.elements[lastField] || form.elements.title;
  if (lastField === 'year') el.value = (line.match(/\b(1[5-9]\d\d|20\d\d)\b/) || [line])[0];
  else if (lastField === 'isbn') el.value = cleanIsbn(line);
  else el.value = el.value.trim() && lastField === 'title' && el.dataset.fromOcr === '1' ? `${el.value} ${line}` : titleCase(line);
  el.dataset.fromOcr = '1';
  c.classList.add('used');
  if (lastField === 'author') checkAuthor();
});
form.elements.title.addEventListener('focus', e => { e.target.dataset.fromOcr = ''; });

// Le copertine spesso sono in MAIUSCOLO: lo converto in un formato più leggibile
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  const small = ['di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'del', 'della', 'dei', 'delle', 'nel', 'nella', 'of', 'the', 'and'];
  return s.toLowerCase().split(' ').map((w, i) => (i > 0 && small.includes(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function runOcr(file) {
  $('#ocrBox').hidden = false;
  if (!(await ocrReady())) {
    if (navigator.onLine) {
      ocrMessage(`Per leggere il testo delle foto serve un download unico di circa 12 MB, poi funziona anche offline.
        <br><button type="button" class="btn small" id="ocrGet" style="margin-top:8px">Scarica e leggi la foto</button>`);
      $('#ocrGet').onclick = async () => {
        ocrMessage('<span class="spinner"></span> Scarico il lettore di testo…');
        try { await downloadOcr(p => ocrMessage(`<span class="spinner"></span> Scarico il lettore di testo… ${Math.round(p * 100)}%`)); }
        catch (err) { ocrMessage('Download non riuscito. Controlla la connessione e riprova.'); return; }
        runOcr(file);
      };
    } else {
      ocrMessage('Per leggere il testo delle foto serve un download unico da fare con internet (Impostazioni). Intanto puoi compilare a mano: la copertina è già salvata.');
    }
    return;
  }
  ocrMessage('<span class="spinner"></span> Leggo il testo nella foto…');
  try {
    const { text, lines } = await recognize(file);
    $('#ocrLines').innerHTML = '';
    if (!lines.length) { ocrMessage('Non ho trovato testo leggibile. Prova con più luce, inquadrando il libro dritto.'); return; }
    showOcrLines(lines.slice(0, 30));
    const found = extractFromText(text);
    if (found.year && !form.elements.year.value) form.elements.year.value = found.year;
    if (found.isbn && !form.elements.isbn.value) {
      form.elements.isbn.value = found.isbn;
      toast(`Trovato l'ISBN ${found.isbn}`);
      if (navigator.onLine) {
        const { book, outcome, detail } = await lookupIsbn(found.isbn);
        if (book) { fillForm(book, { overwrite: false }); await maybeCover(book.coverUrls); }
        else {
          formCtx.needsLookup = true; // si riproverà nei prossimi giorni
          if (outcome !== 'notfound') toast(lookupMessage(outcome, detail), 7000);
        }
      } else formCtx.needsLookup = true;
    }
  } catch (err) {
    ocrMessage(esc(err.message || 'Lettura non riuscita.'));
  }
}

async function maybeCover(urls) {
  const list = [].concat(urls || []).filter(Boolean);
  if (formCtx.cover || !list.length) return;
  const blob = await fetchCover(list);
  if (blob) {
    const small = await normalizeCoverBlob(blob);
    if (small) { formCtx.cover = small; formCtx.coverChanged = true; setCoverPreview(small); }
  }
}

$('#btnMorePhoto').addEventListener('click', () => $('#morePhotoInput').click());
$('#morePhotoInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const existing = $('#ocrLines').innerHTML;
  await runOcr(f);
  if (existing && !existing.includes('class="hint"')) $('#ocrLines').insertAdjacentHTML('afterbegin', existing);
});

$('#btnSearchOnline').addEventListener('click', async () => {
  if (!navigator.onLine) { toast('Serve internet per cercare online'); return; }
  const t = form.elements.title.value.trim(), a = form.elements.author.value.trim();
  if (!t && !a) { toast('Scegli prima almeno il titolo'); return; }
  const box = $('#candidates');
  box.innerHTML = '<p class="hint"><span class="spinner"></span> Cerco…</p>';
  const { results: res, outcome, detail } = await searchByText(t, a);
  if (!res.length) {
    box.innerHTML = `<p class="hint">${outcome === 'notfound' ? 'Nessun risultato. Prova a correggere il titolo.' : esc(lookupMessage(outcome, detail))}</p>`;
    return;
  }
  renderCandidates(box, res);
});

function renderCandidates(box, res) {
  box._res = res;
  box.innerHTML = res.map((r, i) => `<button type="button" class="cand" data-i="${i}">
    ${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
    <span><strong>${esc(r.title)}</strong><small>${esc([r.author, r.year, r.publisher].filter(Boolean).join(', '))}</small></span></button>`).join('');
}
for (const id of ['#candidates', '#eanCandidates']) {
  $(id).addEventListener('click', async e => {
    const c = e.target.closest('.cand'); if (!c) return;
    const r = $(id)._res[+c.dataset.i];
    const code = form.elements.isbn.value;
    fillForm({ ...r, isbn: id === '#eanCandidates' ? code : r.isbn });
    $(id).innerHTML = '';
    if (id === '#eanCandidates') $('#eanBox').hidden = true;
    toast('Dati inseriti: controlla e salva');
    await maybeCover([r.isbn && `https://covers.openlibrary.org/b/isbn/${r.isbn}-L.jpg?default=false`, r.coverUrl]);
  });
}

// ------------------------------------------------------------ aggiunta
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  const choice = await installEvent.userChoice.catch(() => null);
  installEvent = null;
  $('#installBar').hidden = true;
  if (choice && choice.outcome === 'accepted') toast('Scaffale è installata: la trovi nella schermata Home');
});

$('#btnAdd').addEventListener('click', () => openSheet($('#dlgAdd')));
$('#addManual').addEventListener('click', () => { closeSheet($('#dlgAdd')); openForm({}); });
$('#addPhoto').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  closeSheet($('#dlgAdd'));
  const cover = await resizeImage(f);
  openForm({}, { cover, hint: 'La foto è diventata la copertina. Se era una pagina interna, toccala per cambiarla.' });
  runOcr(f);
});

let scanAbort = null;
$('#addScan').addEventListener('click', async () => {
  closeSheet($('#dlgAdd'));
  openSheet($('#dlgScan'));
  $('#isbnManual').value = '';
  if (!barcodeSupported()) {
    $('.scan-hint').textContent = 'Questo browser non legge i codici a barre: scrivi l\'ISBN o l\'EAN qui sotto. Usa Chrome per Android.';
    return;
  }
  $('.scan-hint').textContent = 'Inquadra il codice a barre del libro: di solito è sul retro, in basso';
  scanAbort = new AbortController();
  try {
    const code = await scanIsbn($('#video'), { signal: scanAbort.signal });
    closeSheet($('#dlgScan'));
    handleCode(code);
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err.name === 'NotAllowedError') $('.scan-hint').textContent = 'Permesso fotocamera negato. Abilitalo nelle impostazioni del telefono, oppure scrivi l\'ISBN.';
    else $('.scan-hint').textContent = 'Fotocamera non disponibile. Scrivi l\'ISBN qui sotto.';
  }
});
$('#dlgScan').addEventListener('sheetclosed', () => {
  if (scanAbort) scanAbort.abort();
  const v = $('#video'); if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
});
$('#isbnForm').addEventListener('submit', e => {
  e.preventDefault();
  const info = classifyCode($('#isbnManual').value);
  if (!info) { toast('Codice non valido: controlla le cifre'); return; }
  closeSheet($('#dlgScan'));
  handleCode(info.code);
});

// Smista il codice letto: ISBN (978/979), periodico (977, contiene l'ISSN) o EAN generico
async function handleCode(raw) {
  const info = classifyCode(raw);
  if (!info) { toast('Codice non valido: controlla le cifre'); return; }
  if (info.type === 'isbn') return handleIsbn(info.code);

  const dup = state.books.find(b => b.isbn === info.code);
  if (dup) { toast('Questo codice è già nel tuo scaffale'); openDetail(dup.id); return; }
  const what = info.type === 'issn'
    ? `È il codice di una pubblicazione periodica (ISSN ${info.issn}), come i fumetti e i libri venduti in edicola: gli archivi dei libri di solito non lo contengono.`
    : 'Questo codice EAN non è un ISBN, quindi gli archivi dei libri di solito non lo contengono.';
  const tip = info.type === 'issn'
    ? ' Fotografa la copertina per leggere titolo e numero.'
    : ' Se sul libro c\'è un altro codice a barre che inizia con 978 o 979, scansiona quello: è l\'ISBN. Altrimenti fotografa la copertina.';
  if (!navigator.onLine) {
    openForm({ isbn: info.code }, { hint: what + tip });
    return;
  }
  toast('Cerco il codice…', 15000);
  const { results, outcome, detail } = await lookupEan(info.code);
  $('#toast').classList.remove('show');
  if (results.length) {
    openForm({ isbn: info.code }, { hint: what + ' Però Google Books ha qualcosa: guarda qui sotto.' });
    renderCandidates($('#eanCandidates'), results);
    $('#eanBox').hidden = false;
    return;
  }
  const short = {
    quota: 'ha il limite di ricerche esaurito',
    temporary: 'ha un guasto temporaneo',
    unreachable: 'non è raggiungibile',
    offline: 'non è raggiungibile',
  }[outcome] || 'ha rifiutato la richiesta';
  const problem = outcome !== 'notfound' ? ` Nota: in questo momento Google Books ${short}, quindi potresti riprovare più tardi.` : '';
  openForm({ isbn: info.code }, { hint: what + tip + problem });
}

async function handleIsbn(isbn) {
  const dup = state.books.find(b => b.isbn === isbn);
  if (dup) { toast('Questo libro è già nel tuo scaffale'); openDetail(dup.id); return; }
  if (!navigator.onLine) {
    openForm({ isbn }, { needsLookup: true, hint: 'Sei offline: salvalo pure anche senza titolo. I dati si completano quando torni online, con «Completa ora».' });
    return;
  }
  toast('Cerco il libro…', 15000);
  const { book, outcome, detail } = await lookupIsbn(isbn);
  if (!book) {
    $('#toast').classList.remove('show');
    openForm({ isbn }, { needsLookup: true });
    showLookupHint(outcome, detail);
    return;
  }
  let cover = null;
  const blob = await fetchCover(book.coverUrls);
  if (blob) cover = await normalizeCoverBlob(blob);
  $('#toast').classList.remove('show');
  openForm(book, { cover, hint: 'Controlla i dati e salva.' });
}

// Completa i libri aggiunti offline
// I libri salvati con il solo ISBN (appena usciti, aggiunti offline, o con Google in
// difficoltà) vengono completati appena gli archivi li conoscono. Si riempiono solo i
// campi vuoti, così quello che hai scritto tu non viene mai sovrascritto.
const RETRY_EVERY = 20 * 3600 * 1000; // ricerca automatica al massimo una volta al giorno per libro
const MAX_MISSES = 30;                // dopo circa un mese di tentativi a vuoto si smette
let completing = false;

// Per cercare i dati online serve l'ISBN, oppure almeno titolo e autore
const canLookup = b => !!(b.isbn || (b.title && b.author));
// Mancano dati che gli archivi online possono dare
const needsData = b => !b.title || !b.author || !b.genre || !b.year || !b.pages || !b.cover;

// Senza ISBN cerco per titolo e autore, e accetto solo un risultato con lo stesso titolo e
// lo stesso autore: meglio nessun dato che i dati di un altro libro
async function lookupByText(b) {
  const { results, outcome, detail } = await searchByText(b.title, b.author);
  const t = normTitle(b.title);
  const d = results.find(r => normTitle(r.title) === t && sameAuthors(r.author, b.author));
  if (!d) return { book: null, outcome: results.length ? 'notfound' : outcome, detail };
  d.coverUrls = [d.isbn && `https://covers.openlibrary.org/b/isbn/${d.isbn}-L.jpg?default=false`, d.coverUrl].filter(Boolean);
  return { book: d, outcome: 'found' };
}

async function completePending({ manual = false } = {}) {
  if (completing) return { busy: true };
  if (!navigator.onLine) return null;
  const now = Date.now();
  const pending = state.books.filter(b => b.needsLookup && canLookup(b) &&
    (manual || !b.lastLookupAt || now - b.lastLookupAt > RETRY_EVERY));
  if (!pending.length) return null;
  completing = true;
  let ok = 0, missing = 0, problem = null;
  try {
    for (const p of pending.slice(0, manual ? 100 : 10)) {
      let { book: d, outcome } = p.isbn ? await lookupIsbn(p.isbn) : await lookupByText(p);
      // L'ISBN di un ebook a volte non è negli archivi: provo con titolo e autore
      if (!d && p.isbn && outcome === 'notfound' && p.title && p.author) ({ book: d, outcome } = await lookupByText(p));
      let cover = null;
      if (d && !p.cover) {
        const blob = await fetchCover(d.coverUrls);
        cover = blob && await normalizeCoverBlob(blob);
      }
      // La ricerca può durare secondi: nel frattempo il libro può essere stato eliminato o
      // completato a mano. Applico il risultato alla sua versione attuale, se c'è ancora.
      const saved = await db.update(p.id, b => {
        if (!b.needsLookup) return false;
        b.lastLookupAt = Date.now();
        if (d) {
          for (const k of ['title', 'author', 'year', 'pages', 'publisher', 'genre']) if (!b[k] && d[k]) b[k] = d[k];
          b.editedAt = Date.now();
          if (!b.cover && cover) { b.cover = cover; b.coverStamp = Date.now(); b.coverRev = b.coverLocalRev = Date.now(); }
          b.needsLookup = false;
          b.lookupMisses = 0;
        } else if (outcome === 'notfound') {
          b.lookupMisses = (b.lookupMisses || 0) + 1;
          if (b.lookupMisses >= MAX_MISSES) b.needsLookup = false;
        }
      }, { quiet: !d });
      if (saved && d) ok++;
      else if (saved && outcome === 'notfound') missing++;
      if (!d && outcome !== 'notfound') problem = outcome; // archivio non disponibile: resta in attesa
      if (['quota', 'badkey', 'blocked', 'offline'].includes(problem)) break; // inutile insistere
    }
  } finally {
    completing = false;
  }
  await reload();
  return { ok, missing, problem, total: pending.length };
}

// All'avvio e quando torna la connessione, in sottofondo e senza disturbare
async function autoComplete(attempt = 0) {
  if (!navigator.onLine) return;
  if (openStack.length) { // stai usando l'app: riprovo tra poco
    if (attempt < 6) setTimeout(() => autoComplete(attempt + 1), 20000);
    return;
  }
  const r = await completePending();
  if (r && r.ok) toast(`Ho completato i dati di ${r.ok} ${r.ok === 1 ? 'libro che aspettava' : 'libri che aspettavano'}`, 5000);
}

$('#btnComplete').addEventListener('click', async () => {
  $('#btnComplete').disabled = true;
  toast('Cerco i dati mancanti…', 20000);
  const r = await completePending({ manual: true });
  $('#btnComplete').disabled = false;
  if (!r) { toast('Non ci sono libri da completare'); return; }
  if (r.busy) { toast('Sto già completando i dati, un attimo…'); return; }
  const parts = [`${r.ok} su ${r.total} libri completati`];
  if (r.missing) parts.push(`${r.missing} non ancora negli archivi: riproverò da sola nei prossimi giorni`);
  if (r.problem) parts.push({
    quota: 'Google Books ha il limite esaurito: riprova più tardi',
    badkey: 'Google rifiuta la chiave: premi «Verifica gli archivi» nelle Impostazioni',
    blocked: 'Google non risponde in modo leggibile: premi «Verifica gli archivi» nelle Impostazioni',
    error: 'Google Books ha risposto con un errore, riprova più tardi',
    temporary: 'Google Books ha un guasto temporaneo, riprova più tardi',
    unreachable: 'Google Books non raggiungibile, riprova più tardi',
    offline: 'archivi non raggiungibili: controlla la connessione',
  }[r.problem] || 'riprova più tardi');
  toast(parts.join('. '), 7000);
});

// ------------------------------------------------------------ aggiunta da file
// Trascini, incolli o scegli uno o più PDF ed EPUB: Scaffale legge da ogni file titolo,
// autore, anno, ISBN e copertina, e crea il libro con il file come copia digitale. Se il libro
// è già nello scaffale (stesso ISBN, oppure stesso titolo e stesso autore) il file diventa la
// sua copia digitale, invece di creare un doppione.
const IMPORT_LIMIT = 300;
let imp = null; // l'aggiunta in corso: { phase: reading | ready | saving | done, items, … }

function normTitle(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/\s*[:(\[]|\s+[-–—]\s+/)[0]
    .replace(/^(?:l['’]|un['’]|(?:il|lo|la|i|gli|le|un|uno|una|the|a|an)\s+)/, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function authorWords(a) {
  return new Set(authorKey(a).split(' ').filter(w => w.length > 1));
}
// Stessi autori anche se scritti in modo diverso: "Eco, Umberto" e "Umberto Eco",
// "Fruttero e Lucentini" e "Carlo Fruttero, Franco Lucentini"
function sameAuthors(a, b) {
  const A = authorWords(a), B = authorWords(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return [...small].every(w => big.has(w));
}
function sameBook(a, b) {
  if (a.isbns.some(x => b.isbns.includes(x))) return true;
  const t = normTitle(a.title);
  return !!t && t === normTitle(b.title) && ((!a.author && !b.author) || sameAuthors(a.author, b.author));
}
// Il libro dello scaffale a cui appartiene il file, se c'è già
function libraryMatch(m) {
  const byIsbn = state.books.find(b => b.isbn && m.isbns.includes(cleanIsbn(b.isbn)));
  if (byIsbn) return byIsbn;
  const t = normTitle(m.title);
  if (!t || !m.author) return null;
  return state.books.find(b => b.author && normTitle(b.title) === t && sameAuthors(b.author, m.author)) || null;
}
// Se l'autore è già nello scaffale scritto in un altro modo, uso la stessa grafia
function snapAuthor(a) {
  if (!a) return '';
  const k = authorKey(a);
  const same = state.books.find(b => b.author && authorKey(b.author) === k);
  return same ? same.author.trim() : a;
}

// Che cosa succederà a ogni file:
//   new      nuovo libro            attach  copia digitale di un libro che c'è già
//   dup      già presente, uguale   hasfile il libro ha già un altro file
//   twin     stesso libro di un altro file scelto insieme    error  file illeggibile
function classifyItem(job, it) {
  const m = it.meta;
  it.target = null; it.twin = null;
  if (m.error) { it.status = 'error'; it.checked = false; return; }
  const twin = job.items.find(o => o.n < it.n && o.meta && !o.meta.error && sameBook(o.meta, m));
  if (twin) { it.status = 'twin'; it.twin = twin; it.checked = false; return; }
  const b = libraryMatch(m);
  if (!b) { it.status = 'new'; it.checked = true; return; }
  it.target = b;
  if (b.file) { it.status = sameFile(b.file, m) ? 'dup' : 'hasfile'; it.checked = false; }
  else { it.status = 'attach'; it.checked = true; }
}

const DRM_NOTE = {
  password: 'Protetto da password: lo catalogo, ma Scaffale non può aprirlo',
  other: 'Protetto da DRM: lo catalogo, ma si legge solo con le app e i dispositivi autorizzati dal negozio',
};
function impStateText(it) {
  const t = it.target ? esc(titleOf(it.target)) : '';
  const drive = it.cloud === 'ok' ? ' e caricato su Google Drive' : '';
  if (it.result === 'added') return 'Aggiunto' + drive;
  if (it.result === 'attached') return `Collegato a «${t}»` + drive;
  if (it.result === 'failed') return 'Non salvato: ' + esc(it.err || 'errore');
  if (it.saving) return '<span class="spinner"></span> Salvo…';
  switch (it.status) {
    case 'reading': return '<span class="spinner"></span> Leggo il file…';
    case 'new': return 'Nuovo libro';
    case 'attach': return `Diventa la copia digitale di «${t}», già nello scaffale` + (it.target.cloud && sameFile(it.target.cloud, it.meta) ? ' (è già su Drive)' : '');
    case 'dup': return 'Già nello scaffale, con questo stesso file';
    case 'hasfile': return `«${t}» ha già un altro file: per sostituirlo apri la sua scheda`;
    case 'twin': return `Stesso libro di «${esc(it.twin.meta.name)}»: ogni libro ha un solo file`;
    case 'error': return 'Non riesco a leggerlo: ' + esc(it.meta.error);
  }
  return '';
}

function impRowHtml(it) {
  const job = imp;
  const m = it.meta || { name: it.file.name, size: it.file.size, kind: bookKind(it.file), title: '', author: '', year: '' };
  // Finito: la riga mostra il libro com'è ora nello scaffale (i dati da internet arrivano dopo)
  const b = it.bookId && it.result !== 'failed' ? state.books.find(x => x.id === it.bookId) : null;
  const title = (b && titleOf(b)) || m.title || m.name;
  const author = b ? b.author : m.author;
  const year = b ? b.year : m.year;
  const url = (b && coverUrl(b)) || it.coverUrl;
  const cover = url ? `<img class="imp-cover" src="${url}" alt="">`
    : `<span class="imp-cover" style="--c:${genreColor(b ? b.genre : m.genre)}">${esc(initials(title))}</span>`;
  const sub = [author, year, `${m.kind || 'File'}, ${formatSize(m.size || 0)}`].filter(Boolean).join(' · ');
  const notes = [
    m.drm && `<span class="imp-warn"><svg><use href="#i-lock"/></svg>${DRM_NOTE[m.drm] || DRM_NOTE.other}</span>`,
    it.cloud === 'failed' && `<span class="imp-warn">Non caricato su Google Drive: ${esc(it.cloudErr || 'errore')}</span>`,
    it.upload != null && `<span class="progress"><i style="width:${Math.round(it.upload * 100)}%"></i></span>`,
  ].filter(Boolean).join('');
  const cls = `imp-row s-${it.status}${it.result ? ' r-' + it.result : ''}`;
  const body = `${cover}<span class="imp-body"><strong>${esc(title)}</strong><small>${esc(sub)}</small>
    <span class="imp-state">${impStateText(it)}</span>${notes}</span>`;
  if (b) return `<button type="button" class="${cls}" data-n="${it.n}" data-id="${b.id}">${body}<svg class="imp-go"><use href="#i-right"/></svg></button>`;
  const locked = !job || job.phase !== 'ready' || !['new', 'attach'].includes(it.status);
  return `<label class="${cls}" data-n="${it.n}"><input type="checkbox"${it.checked ? ' checked' : ''}${locked ? ' disabled' : ''} aria-label="Aggiungi ${esc(title)}">${body}</label>`;
}

function renderImportRow(it) {
  const el = $(`#impList [data-n="${it.n}"]`);
  if (el) el.outerHTML = impRowHtml(it);
}
function renderImport() {
  if (!imp) return;
  $('#impList').innerHTML = imp.items.map(impRowHtml).join('');
  renderImportChrome();
}
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
const chosenItems = job => job.items.filter(it => it.checked && ['new', 'attach'].includes(it.status));

function importSummary(job) {
  const count = r => job.items.filter(it => it.result === r).length;
  const added = count('added'), attached = count('attached'), failed = count('failed');
  const parts = [];
  if (added) parts.push(`${added} ${added === 1 ? 'libro aggiunto' : 'libri aggiunti'}`);
  if (attached) parts.push(`${attached} ${attached === 1 ? 'file collegato a un libro' : 'file collegati a libri'} che avevi già`);
  if (failed) parts.push(`${failed} non ${failed === 1 ? 'salvato' : 'salvati'}`);
  return parts.length ? capital(parts.join(', ')) + '.' : 'Nessun libro aggiunto.';
}

function renderImportChrome() {
  const job = imp;
  if (!job) return;
  const n = job.items.length;
  const chosen = chosenItems(job);
  let title = 'Aggiungi da file', hint = '';
  if (job.phase === 'reading') {
    hint = `Leggo i file: ${job.items.filter(it => it.meta).length} di ${n}…`;
  } else if (job.phase === 'ready') {
    hint = chosen.length
      ? 'Titolo, autore e copertina vengono dai file: potrai correggerli dalla scheda di ogni libro. I file restano su questo ' + DEV + '.'
      : 'Non c\'è niente da aggiungere: questi libri sono già nello scaffale, oppure i file non si leggono.';
  } else if (job.phase === 'saving') {
    title = 'Aggiungo i libri…';
    hint = job.uploading
      ? `Carico su Google Drive: ${Math.min(job.uploading.done + 1, job.uploading.total)} di ${job.uploading.total}…`
      : `Salvo i libri: ${job.saved} di ${job.total}…`;
  } else {
    title = job.items.some(it => it.result === 'added' || it.result === 'attached') ? 'Libri aggiunti' : 'Nessun libro aggiunto';
    hint = importSummary(job);
    if (job.uploadStop) hint += ` ${job.uploadStop}: gli altri file li carichi dalla scheda di ogni libro.`;
    if (job.lookup === 'running') hint += ' <span class="spinner"></span> Cerco online genere, pagine e copertine mancanti…';
    else if (job.lookup) hint += ' ' + job.lookup;
    if (job.items.some(it => it.bookId && it.result !== 'failed')) hint += ' Tocca un libro per aprirlo.';
  }
  $('#impTitle').textContent = title;
  $('#impHint').innerHTML = hint;
  $('#impSkipped').hidden = !job.skipped;
  $('#impSkipped').textContent = `${job.skipped} ${job.skipped === 1 ? 'file ignorato: non è' : 'file ignorati: non sono'} PDF o EPUB.`;
  $('#impDriveRow').hidden = !drive.getClientId() || !['reading', 'ready'].includes(job.phase);
  const act = $('#impActions');
  act.classList.toggle('single', job.phase === 'done' || job.phase === 'saving');
  if (job.phase === 'done') {
    act.innerHTML = '<button type="button" class="btn" data-close>Fatto</button>';
  } else if (job.phase === 'saving') {
    act.innerHTML = job.uploading ? '<button type="button" class="btn ghost" id="impStop">Interrompi i caricamenti</button>' : '';
  } else {
    const label = chosen.length === 1 ? 'Aggiungi il libro' : chosen.length ? `Aggiungi ${chosen.length} libri` : 'Aggiungi';
    act.innerHTML = `<button type="button" class="btn ghost" data-close>Annulla</button>
      <button type="button" class="btn" id="impGo"${job.phase !== 'ready' || !chosen.length ? ' disabled' : ''}>${label}</button>`;
  }
}

// Chiude l'aggiunta (se non sta salvando) e libera le anteprime delle copertine
function discardImport() {
  if (!imp) return;
  imp.cancelled = true;
  for (const it of imp.items) if (it.coverUrl) URL.revokeObjectURL(it.coverUrl);
  imp = null;
}

function startImport(fileList) {
  // I file nascosti (per esempio "._libro.epub" dei Mac) non sono libri
  const all = [...fileList].filter(f => f && !/^\./.test(f.name || ''));
  const books = all.filter(f => bookKind(f));
  if (!books.length) {
    toast(all.length ? 'Scaffale aggiunge solo libri in formato PDF o EPUB' : 'Non ho ricevuto nessun file');
    return;
  }
  if (imp && imp.phase === 'saving') { toast('Aspetta che finisca l\'aggiunta in corso'); return; }
  if (imp && imp.phase === 'done') discardImport();
  if ($('#dlgAdd').open) closeSheet($('#dlgAdd'));
  let job = imp;
  if (!job) {
    job = imp = { phase: 'reading', items: [], skipped: 0, seq: 0 };
    try { $('#impDrive').checked = localStorage.getItem('importDrive') === '1'; } catch (e) { /* niente */ }
  }
  const path = f => f.webkitRelativePath || f.name;
  books.sort((a, b) => path(a).localeCompare(path(b), 'it', { numeric: true }));
  let taken = 0;
  for (const f of books) {
    if (job.items.length >= IMPORT_LIMIT) break;
    if (job.items.some(it => it.file.name === f.name && it.file.size === f.size)) { taken++; continue; }
    job.items.push({ n: job.seq++, file: f, status: 'reading', checked: false });
    taken++;
  }
  if (taken < books.length) toast(`Aggiungo al massimo ${IMPORT_LIMIT} file alla volta: gli altri aggiungili dopo`, 6000);
  job.skipped += all.length - books.length;
  job.phase = 'reading';
  if (!$('#dlgImport').open) openSheet($('#dlgImport'));
  renderImport();
  readImportQueue(job);
}

// I file si leggono uno alla volta: un PDF grande occupa parecchia memoria
async function readImportQueue(job) {
  if (job.reading) return;
  job.reading = true;
  try {
    let it;
    while (!job.cancelled && (it = job.items.find(x => !x.meta))) {
      let meta;
      try { meta = await readBookFile(it.file); } catch (err) { meta = { kind: bookKind(it.file), name: it.file.name, size: it.file.size, isbns: [], error: err.message || 'file illeggibile' }; }
      if (job.cancelled) return;
      if (meta.coverBlob) {
        const small = await normalizeCoverBlob(meta.coverBlob);
        if (small) { it.cover = small; it.coverUrl = URL.createObjectURL(small); }
        meta.coverBlob = null;
      }
      meta.author = snapAuthor(meta.author);
      it.meta = meta;
      classifyItem(job, it);
      if (imp === job) { renderImportRow(it); renderImportChrome(); }
    }
  } finally {
    job.reading = false;
  }
  if (!job.cancelled && imp === job) { job.phase = 'ready'; renderImport(); }
}

async function saveImported(it) {
  const m = it.meta;
  // Copio i byte in un nuovo Blob: il libro resta nell'app anche se poi cancelli il file
  const blob = new Blob([await it.file.arrayBuffer()], { type: m.type });
  const info = { name: m.name, type: m.type, size: blob.size };
  if (m.drm) info.drm = m.drm;
  const now = Date.now();
  if (it.status === 'attach') {
    const id = it.target.id;
    await db.files.put({ bookId: id, ...info, blob, addedAt: now });
    const saved = await db.update(id, cur => {
      cur.file = info;
      if (!cur.cover && it.cover) { cur.cover = it.cover; cur.coverStamp = now; cur.coverRev = cur.coverLocalRev = now; cur.editedAt = now; }
    });
    if (!saved) { await db.files.remove(id); throw new Error('il libro è stato eliminato nel frattempo'); }
    it.bookId = id;
    it.result = 'attached';
    return;
  }
  const book = {
    id: newId(), addedAt: now, currentPage: 0, finished: false,
    title: m.title, author: m.author, year: m.year, pages: m.pages || '', genre: m.genre,
    isbn: m.isbn, publisher: m.publisher, digitalOnly: true, editedAt: now, file: info,
  };
  if (it.cover) { book.cover = it.cover; book.coverStamp = now; book.coverRev = book.coverLocalRev = now; }
  book.needsLookup = canLookup(book) && needsData(book);
  await db.files.put({ bookId: book.id, ...info, blob, addedAt: now });
  try { await db.put(book); } catch (err) { await db.files.remove(book.id); throw err; }
  it.bookId = book.id;
  it.result = 'added';
}

// Caricamento su Drive dei file appena aggiunti, uno alla volta
async function uploadImported(job, items) {
  job.uploading = { ctrl: new AbortController(), done: 0, total: items.length };
  renderImportChrome();
  try {
    for (const it of items) {
      if (job.uploading.ctrl.signal.aborted) break;
      const b = await db.get(it.bookId);
      const rec = b && b.file ? await db.files.get(it.bookId) : null;
      if (!rec) { job.uploading.done++; continue; }
      if (b.cloud && sameFile(b.cloud, rec)) { it.cloud = 'ok'; job.uploading.done++; renderImportRow(it); continue; }
      it.upload = 0; renderImportRow(it); renderImportChrome();
      try {
        const kept = await sendToDrive(it.bookId, rec, {
          signal: job.uploading.ctrl.signal,
          onProgress: p => {
            it.upload = p;
            const bar = $(`#impList [data-n="${it.n}"] .progress i`);
            if (bar) bar.style.width = Math.round(p * 100) + '%';
          },
        });
        if (kept) it.cloud = 'ok';
      } catch (err) {
        if (err.reason === 'aborted') { job.uploadStop = 'Hai interrotto i caricamenti'; break; }
        it.cloud = 'failed'; it.cloudErr = driveMessage(err);
        // Inutile insistere con gli altri file: accesso scaduto, Drive pieno, niente rete
        if (['login', 'noclient', 'storageQuotaExceeded', 'offline'].includes(err.reason)) { job.uploadStop = driveMessage(err); break; }
      } finally {
        delete it.upload;
        await reload();
        renderImportRow(it);
      }
      job.uploading.done++;
      renderImportChrome();
    }
  } finally {
    job.uploading = null;
  }
}

async function runImport() {
  const job = imp;
  if (!job || job.phase !== 'ready') return;
  const chosen = chosenItems(job);
  if (!chosen.length) return;
  const wantDrive = !$('#impDriveRow').hidden && $('#impDrive').checked;
  try { localStorage.setItem('importDrive', wantDrive ? '1' : ''); } catch (e) { /* niente */ }
  // La finestra di Google si apre solo durante il tocco: la chiedo per prima cosa
  if (wantDrive && !(await ensureDrive())) return;
  if (navigator.storage && navigator.storage.estimate) {
    const need = chosen.reduce((s, it) => s + it.file.size, 0);
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < need * 1.1) { toast(`Spazio insufficiente sul ${DEV}: servono circa ${formatSize(need)}`, 6000); return; }
  }
  job.phase = 'saving'; job.total = chosen.length; job.saved = 0;
  renderImport();
  for (const it of chosen) {
    it.saving = true; renderImportRow(it);
    try { await saveImported(it); } catch (err) { it.result = 'failed'; it.err = err.message || err.name; }
    it.saving = false; job.saved++;
    renderImportRow(it); renderImportChrome();
  }
  requestPersistence();
  await reload();
  const ok = chosen.filter(it => it.result === 'added' || it.result === 'attached');
  if (wantDrive && ok.length) await uploadImported(job, ok);
  job.phase = 'done';
  // Se intanto hai chiuso la finestra, il risultato arriva come messaggio
  const visible = () => imp === job && $('#dlgImport').open;
  if (visible()) renderImport();
  else toast(importSummary(job), 6000);
  sync.schedule(1500);
  // I dati che i file non contengono (genere, pagine, copertina) arrivano da internet
  if (navigator.onLine && ok.some(it => (state.books.find(b => b.id === it.bookId) || {}).needsLookup)) {
    job.lookup = 'running';
    if (visible()) renderImportChrome();
    const r = await completePending({ manual: true });
    job.lookup = r && r.ok ? `Ho trovato online i dati mancanti di ${r.ok} ${r.ok === 1 ? 'libro' : 'libri'}.`
      : r && r.problem ? 'Gli archivi online non rispondono: completerò i dati più tardi, da sola.'
      : r && !r.busy ? 'Gli archivi online non hanno altri dati su questi libri: riproverò nei prossimi giorni.' : '';
    if (visible()) renderImport();
    else if (r && r.ok) toast(job.lookup, 5000);
  }
  if (imp === job && !$('#dlgImport').open) discardImport();
}

$('#addFile').addEventListener('click', () => $('#importInput').click());
$('#addFolder').addEventListener('click', () => $('#folderInput').click());
for (const id of ['#importInput', '#folderInput']) {
  $(id).addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) startImport(files);
  });
}
$('#impList').addEventListener('change', e => {
  const row = e.target.closest('[data-n]');
  if (!row || !imp || e.target.type !== 'checkbox') return;
  const it = imp.items.find(x => x.n === +row.dataset.n);
  if (it) { it.checked = e.target.checked; renderImportChrome(); }
});
$('#impList').addEventListener('click', e => {
  const row = e.target.closest('button[data-id]');
  if (!row) return;
  closeSheet($('#dlgImport'));
  openDetail(row.dataset.id);
});
$('#dlgImport').addEventListener('click', e => {
  if (e.target.closest('#impGo')) runImport();
  else if (e.target.closest('#impStop') && imp && imp.uploading) imp.uploading.ctrl.abort();
});
$('#dlgImport').addEventListener('sheetclosed', () => {
  $('#dlgImport').classList.remove('dragging');
  if (imp && imp.phase !== 'saving') discardImport(); // se sta salvando, finisce da sola
});

// --- Trascinare i file sopra l'app (dal computer)
// Il browser, se nessuno lo ferma, apre il file trascinato al posto dell'app: per questo
// "dragover" e "drop" vanno sempre intercettati quando si trascinano dei file.
const draggingFiles = e => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
const canImportNow = () => openStack.every(d => d.id === 'dlgAdd' || d.id === 'dlgImport');
let dragDepth = 0;
function showDropTarget(on) {
  if (on && $('#dlgAdd').open) closeSheet($('#dlgAdd')); // il foglio «Aggiungi» coprirebbe la zona
  const inSheet = $('#dlgImport').open;
  $('#dropZone').hidden = !on || inSheet;
  $('#dlgImport').classList.toggle('dragging', on && inSheet);
}
window.addEventListener('dragenter', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (canImportNow() && !(imp && imp.phase === 'saving')) showDropTarget(true);
});
window.addEventListener('dragover', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = canImportNow() ? 'copy' : 'none';
});
window.addEventListener('dragleave', e => {
  if (!draggingFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showDropTarget(false);
});
window.addEventListener('drop', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDropTarget(false);
  if (!canImportNow()) { toast('Chiudi la finestra aperta, poi trascina di nuovo i file'); return; }
  filesFromDrop(e.dataTransfer).then(startImport);
});

// Una cartella trascinata arriva come "voce" da esplorare: la leggo con le sottocartelle.
// Le voci vanno chieste subito, durante l'evento: dopo il browser non le dà più.
function filesFromDrop(dt) {
  const fileItems = [...(dt.items || [])].filter(i => i.kind === 'file');
  const entries = fileItems.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (!entries.some(en => en && en.isDirectory)) return Promise.resolve([...(dt.files || [])]);
  const plain = fileItems.map(i => i.getAsFile());
  const out = [];
  const walk = async (entry, depth) => {
    if (out.length >= IMPORT_LIMIT * 4) return;
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (f) out.push(f);
    } else if (entry.isDirectory && depth < 8) {
      const reader = entry.createReader();
      for (;;) { // readEntries restituisce i contenuti a blocchi
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        if (!batch.length) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  };
  return (async () => {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]) await walk(entries[i], 0);
      else if (plain[i]) out.push(plain[i]);
    }
    return out;
  })();
}

// --- Incollare i file copiati (Ctrl+C in Esplora file, Ctrl+V in Scaffale)
document.addEventListener('paste', e => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.some(f => bookKind(f))) return; // testo o immagini: non riguarda l'aggiunta
  e.preventDefault();
  if (!canImportNow()) { toast('Chiudi la finestra aperta, poi incolla di nuovo i file'); return; }
  startImport(files);
});

// --- File condivisi da un'altra app di Android (menu Condividi → Scaffale)
// Il service worker li riceve, li parcheggia nella cache e apre l'app con ?condivisi=N
async function acceptShared() {
  const params = new URLSearchParams(location.search);
  if (!params.has('condivisi')) return;
  history.replaceState(history.state, '', location.pathname + location.hash);
  if (!('caches' in window)) return;
  const cache = await caches.open('scaffale-condivisi');
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (res) {
      const blob = await res.blob();
      let name = 'libro';
      try { name = decodeURIComponent(res.headers.get('X-Nome') || 'libro'); } catch (e) { /* lascio il nome generico */ }
      files.push(new File([blob], name, { type: blob.type }));
    }
    await cache.delete(req);
  }
  if (files.length) startImport(files);
  else toast('Non ho ricevuto nessun file: riprova a condividerlo');
}

if (DEV === 'computer') {
  $('#addFolder').hidden = false;
  $('#addFileHint').textContent = 'Scegli uno o più ebook, oppure trascinali nella finestra o incollali con Ctrl+V: titolo, autore e copertina si leggono dal file, che diventa la copia digitale del libro.';
}

// ------------------------------------------------------------ esporta PDF
$('#btnExport').addEventListener('click', () => {
  if (!state.books.length) { toast('Aggiungi prima qualche libro'); return; }
  $$('#expGroup button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.g === state.groupBy)));
  $('#expFiltered').checked = !!state.q.trim();
  $('#expFiltered').closest('.switch').hidden = !state.q.trim();
  resetExportButtons();
  openSheet($('#dlgExport'));
});
$('#expGroup').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#expGroup button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  resetExportButtons();
});
function resetExportButtons() {
  $('#dlgExport .form-actions').innerHTML = `<button type="button" class="btn ghost" data-close>Annulla</button>
    <button type="button" class="btn" id="btnMakePdf">Crea PDF</button>`;
}
$('#dlgExport').addEventListener('change', resetExportButtons);
$('#dlgExport').addEventListener('click', async e => {
  if (!e.target.closest('#btnMakePdf')) return;
  if (!window.PDFLib) { toast('Il generatore PDF non è ancora caricato, riprova'); return; }
  const btn = e.target.closest('#btnMakePdf');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creo il PDF…';
  const by = $('#expGroup [aria-checked="true"]').dataset.g;
  const labels = { genre: 'genere', author: 'autore', year: 'anno', status: 'stato di lettura' };
  const books = ($('#expFiltered').checked ? filtered() : state.books)
    .map(b => ({ ...b, title: titleOf(b), currentPage: status(b) === 'done' ? (b.pages || 1) : (b.currentPage || 0), pages: status(b) === 'done' && !b.pages ? 1 : b.pages }));
  try {
    const groups = groupBooks(books, by);
    const blob = await buildPdf(groups, {
      title: 'La mia libreria', groupLabel: labels[by],
      includeCovers: $('#expCovers').checked, colorOf: spineColor,
    });
    const name = `Libreria-${new Date().toISOString().slice(0, 10)}.pdf`;
    const file = new File([blob], name, { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    $('#dlgExport .form-actions').innerHTML = `
      <a class="btn ghost" href="${url}" download="${name}">Scarica</a>
      ${canShare ? '<button type="button" class="btn" id="btnSharePdf">Condividi o salva</button>' : `<a class="btn" href="${url}" target="_blank" rel="noopener">Apri il PDF</a>`}`;
    const sh = $('#btnSharePdf');
    if (sh) sh.onclick = () => navigator.share({ files: [file], title: 'La mia libreria' }).catch(() => {});
    toast('PDF pronto');
  } catch (err) {
    console.error(err);
    btn.disabled = false; btn.textContent = 'Crea PDF';
    toast('Errore nella creazione del PDF');
  }
});

// ------------------------------------------------------------ impostazioni
$('#btnSettings').addEventListener('click', () => openSettings(false));

async function openSettings(focus) {
  const focusKey = focus === true || focus === 'key';
  openSheet($('#dlgSettings'));
  $('#version').textContent = `Scaffale ${VERSION}`;
  $('#gbKey').value = getStoredGoogleKey();
  $('#gbKey').placeholder = BUILTIN_GOOGLE_KEY ? "Usa la chiave integrata nell'app" : 'AIza…';
  $('#lookupStatus').innerHTML = '';
  $('#keyHow').open = focusKey && !getGoogleKey();
  refreshInviteHint();
  refreshDriveSection();
  if (focusKey) $('#keySection').scrollIntoView({ block: 'start' });
  if (focus === 'drive') {
    $('#driveHow').open = !drive.getClientId();
    $('#driveSection').scrollIntoView({ block: 'start' });
  }
  refreshOcrStatus();
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#storageInfo').textContent = `Spazio usato: ${(est.usage / 1048576).toFixed(1)} MB. ` +
      (persisted ? 'Archivio protetto dalla pulizia automatica.' : 'Archivio non ancora protetto dalla pulizia automatica del browser.');
  }
}

// Pulsanti nel messaggio del modulo
$('#formHint').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'key') { openSettings(true); return; }
  const isbn = cleanIsbn(form.elements.isbn.value);
  if (!isValidIsbn(isbn)) { toast('Serve un ISBN valido nel campo ISBN'); return; }
  b.disabled = true; b.innerHTML = '<span class="spinner"></span> Cerco…';
  const { book, outcome, detail } = await lookupIsbn(isbn);
  if (book) {
    fillForm(book, { overwrite: false });
    formCtx.needsLookup = false;
    $('#formHint').textContent = 'Dati trovati: controlla e salva.';
    await maybeCover(book.coverUrls);
  } else {
    showLookupHint(outcome, detail);
  }
});

// --- Ricerca dati online: chiave Google e verifica degli archivi
const TEST_ISBN = '9780262033848'; // un libro presente in tutti gli archivi

async function runLookupTest() {
  const box = $('#lookupStatus');
  if (!navigator.onLine) { box.innerHTML = '<p class="verdict">Sei offline: collegati a internet per verificare.</p>'; return; }
  box.innerHTML = '<p class="verdict"><span class="spinner"></span> Interrogo gli archivi…</p>';
  const key = getGoogleKey();
  const whose = getStoredGoogleKey() ? 'la tua chiave' : 'la chiave integrata';
  const keyLine = key
    ? `Chiave in uso: ${key.slice(0, 4)}…${key.slice(-4)}, ${getStoredGoogleKey() ? 'salvata su questo ' + DEV : "integrata nell'app"}.`
    : 'Nessuna chiave in uso: Google Books riceve richieste anonime.';
  const { status, details } = await lookupIsbn(TEST_ISBN);
  const rows = statusReport(status, details);
  const cls = k => (k === 'ok' || k === 'empty') ? '' : k === 'quota' ? 'warn' : 'bad';
  const olWorks = ['ok', 'empty'].includes(status.openlibrary) || ['ok', 'empty'].includes(status.olsearch);
  const verdicts = {
    ok: key ? `Tutto a posto: ${whose} funziona.` : 'Tutto a posto per ora.',
    empty: key ? `Tutto a posto: ${whose} funziona.` : 'Tutto a posto per ora.',
    quota: key
      ? `Hai esaurito le ricerche di oggi con ${whose}: si azzerano ogni giorno.`
      : 'Google Books rifiuta le richieste anonime: è il limite condiviso. Salva la tua chiave qui sopra.',
    badkey: 'Google rifiuta la chiave: il motivo è nel suo messaggio qui sopra. Controlla nella console che la Books API sia abilitata nello stesso progetto della chiave, e che la restrizione del sito sia https://ronny421.github.io/* . Dopo ogni modifica aspetta qualche minuto.',
    blocked: 'Google risponde, ma il browser non può leggere la risposta. Prova a togliere per qualche minuto le restrizioni della chiave: se così funziona, il problema è lì.',
    error: 'Google risponde con un errore: il motivo è nel messaggio qui sopra.',
    temporary: 'Google Books ha un guasto temporaneo dei suoi server: non dipende da te né dalla chiave. Riprova tra qualche minuto.',
    unreachable: olWorks
      ? 'Internet funziona, ma il ' + DEV + ' non riesce a contattare Google. Succede con alcuni blocchi pubblicitari, o con il «DNS privato» nelle impostazioni di rete di Android.'
      : 'Il ' + DEV + ' non raggiunge gli archivi: controlla la connessione.',
  };
  box.innerHTML = `<p class="verdict">${esc(keyLine)}</p>` +
    rows.map(r => `<div class="src ${cls(r.kind)}"><i></i><span>${esc(r.text)}${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</span></div>`).join('') +
    `<p class="verdict">${esc(verdicts[status.google] || '')}</p>`;
}

$('#btnLookupTest').addEventListener('click', runLookupTest);
$('#btnKeyPaste').addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    const m = text.match(/AIza[0-9A-Za-z_\-]{35}/);
    if (m) { $('#gbKey').value = m[0]; toast('Chiave incollata: ora premi «Salva e verifica»'); }
    else toast("Negli appunti non c'è una chiave Google: deve iniziare con AIza");
  } catch (err) {
    $('#gbKey').focus();
    toast('Tieni premuto nel campo e scegli «Incolla»');
  }
});
$('#btnKeySave').addEventListener('click', async () => {
  const raw = $('#gbKey').value.trim();
  const m = raw.match(/AIza[0-9A-Za-z_\-]{35}/);
  const k = m ? m[0] : raw;
  if (k && !/^AIza[0-9A-Za-z_\-]{30,56}$/.test(k)) {
    $('#lookupStatus').innerHTML = '<p class="verdict">Chiave non salvata: deve iniziare con AIza ed essere lunga 39 caratteri, senza spazi. Copiala di nuovo dalla console di Google.</p>';
    return;
  }
  $('#gbKey').value = k;
  setGoogleKey(k);
  refreshInviteHint();
  toast(k ? 'Chiave salvata su questo ' + DEV : 'Chiave rimossa');
  runLookupTest();
});

async function refreshOcrStatus() {
  const ready = await ocrReady();
  $('#ocrStatus').textContent = ready
    ? 'Pronta: puoi leggere il testo di copertine e pagine anche senza internet.'
    : navigator.onLine
      ? 'Serve un download unico (circa 12 MB, meglio col Wi-Fi). Dopo funziona offline.'
      : 'Non ancora scaricata. Collegati a internet per scaricarla.';
  $('#btnOcrDownload').hidden = ready || !navigator.onLine;
  $('#btnOcrRemove').hidden = !ready;
}
$('#btnOcrDownload').addEventListener('click', async () => {
  const bar = $('#ocrProgress'); bar.hidden = false;
  $('#btnOcrDownload').disabled = true;
  try {
    await downloadOcr(p => { bar.firstElementChild.style.width = (p * 100) + '%'; });
    toast('Lettura del testo pronta anche offline');
  } catch (e) { toast('Download non riuscito, riprova'); }
  bar.hidden = true; $('#btnOcrDownload').disabled = false;
  refreshOcrStatus();
});
$('#btnOcrRemove').addEventListener('click', async () => { await removeOcr(); refreshOcrStatus(); });

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  $$('#themeSeg button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.t === t)));
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').content = dark ? '#141829' : '#3A3FD4';
}
$('#themeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  localStorage.setItem('theme', b.dataset.t); applyTheme(b.dataset.t);
});

// Copia di sicurezza: un file JSON con tutti i libri e le copertine
function blobToDataUrl(blob) {
  return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
}
async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }

$('#btnBackup').addEventListener('click', async () => {
  const books = await Promise.all(state.books.map(async b => ({ ...b, file: undefined, cover: b.cover ? await blobToDataUrl(b.cover) : null })));
  const settings = getStoredGoogleKey() ? { googleBooksKey: getStoredGoogleKey() } : {};
  const json = JSON.stringify({ app: 'scaffale', version: 1, exportedAt: new Date().toISOString(), settings, books });
  const name = `scaffale-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Copia di Scaffale' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  toast('Copia salvata nei Download');
});
$('#btnRestore').addEventListener('click', () => $('#restoreInput').click());
$('#restoreInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'scaffale' || !Array.isArray(data.books)) throw new Error();
    const books = await Promise.all(data.books.map(async b => ({ ...b, cover: b.cover ? await dataUrlToBlob(b.cover) : null })));
    for (const b of books) {
      if (b.cover) b.coverLocalRev = b.coverRev || b.coverStamp || b.addedAt || 1;
      else { delete b.cover; delete b.coverLocalRev; }
    }
    // La copia non contiene i file: se sono ancora su questo telefono, li ricollego ai libri
    for (const b of books) {
      const rec = await db.files.get(b.id);
      if (rec) b.file = { name: rec.name, type: rec.type, size: rec.size };
    }
    if (!confirm(`Ripristinare ${books.length} libri? Quelli già presenti con lo stesso identificativo verranno sovrascritti.`)) return;
    await db.putMany(books);
    const restoredKey = data.settings && data.settings.googleBooksKey && !getStoredGoogleKey();
    if (restoredKey) setGoogleKey(data.settings.googleBooksKey);
    await reload();
    toast(`${books.length} libri ripristinati${restoredKey ? ', insieme alla chiave di ricerca' : ''}`);
  } catch (err) { toast('File non valido: scegli una copia creata da Scaffale'); }
});

// ------------------------------------------------------------ Google Drive
function timeLabel(at) {
  if (!at) return '';
  const d = new Date(at), today = new Date();
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `alle ${hm}` : `il ${d.toLocaleDateString('it-IT')} alle ${hm}`;
}

function refreshDriveSection() {
  const client = drive.getClientId();
  $('#bulkBox').hidden = true; // ricompare sotto, se sei collegato
  $('#driveSetup').hidden = !!client;
  $('#driveAccount').hidden = !client;
  $('#clientMsg').textContent = '';
  if (!client) { $('#driveClient').value = drive.getStoredClientId(); return; }
  const on = drive.isEnabled();
  if (!on && navigator.onLine) drive.prepare().catch(() => {}); // pronto per il tocco su «Accedi»
  const st = sync.status();
  $('#btnDriveSignIn').hidden = on;
  $('#btnDriveSync').hidden = !on;
  $('#btnDriveSignOut').hidden = !on;
  $('#btnClientChange').hidden = !!drive.BUILTIN_CLIENT_ID && !drive.getStoredClientId();
  if (!on) {
    $('#driveStatus').textContent = 'Non collegato';
    $('#driveNote').textContent = 'Al primo accesso Google potrebbe mostrare l\'avviso «Google non ha verificato questa app»: è normale per le app in prova. Premi «Continua».';
    return;
  }
  $('#driveStatus').textContent = `Collegato come ${drive.accountEmail() || 'account Google'}`;
  renderBulk();
  const parts = [];
  if (st.status === 'syncing') parts.push('Sincronizzazione in corso…');
  else if (st.status === 'error' || st.status === 'offline') parts.push(`Ultima sincronizzazione non riuscita: ${st.error}`);
  else if (st.at) parts.push(`Ultima sincronizzazione ${timeLabel(st.at)}.`);
  if (!drive.hasToken()) parts.push('Il permesso di Google dura circa un\'ora: quando scade, un tocco su «Sincronizza ora» lo rinnova.');
  $('#driveNote').textContent = parts.join(' ');
}

function renderSyncChip() {
  const chip = $('#syncChip');
  if (!drive.isEnabled()) { chip.hidden = true; return; }
  if (bulk) {
    chip.hidden = false;
    chip.dataset.state = 'syncing';
    $('#syncText').textContent = `${bulk.kind === 'up' ? 'Carico i file su Google Drive' : 'Scarico i file da Google Drive'}: ${Math.min(bulk.done + 1, bulk.total)} di ${bulk.total}`;
    return;
  }
  const st = sync.status();
  let mode = st.status, text;
  if (!drive.hasToken() && mode !== 'syncing') mode = 'login';
  if (mode === 'syncing') text = 'Sincronizzo con Google Drive…';
  else if (mode === 'login') text = 'Tocca per sincronizzare con Google Drive';
  else if (mode === 'error') text = 'Sincronizzazione non riuscita: tocca per riprovare';
  else if (mode === 'offline') text = 'Senza internet: sincronizzerò più tardi';
  else text = st.at ? `Sincronizzato ${timeLabel(st.at)}` : 'Collegato a Google Drive';
  chip.hidden = false;
  chip.dataset.state = mode;
  $('#syncText').textContent = text;
}

// Sincronizzazione chiesta con un tocco: se il permesso è scaduto, la finestra di Google si apre qui
async function syncByTap() {
  try {
    await drive.ensureToken(true);
  } catch (err) {
    toast(driveMessage(err), 6000);
    renderSyncChip();
    return;
  }
  try {
    await sync.syncNow();
  } catch (err) {
    toast(driveMessage(err), 6000);
  }
}

$('#syncChip').addEventListener('click', () => (bulk ? openSettings('drive') : syncByTap()));
$('#btnDriveSync').addEventListener('click', syncByTap);

$('#btnDriveSignIn').addEventListener('click', async () => {
  try {
    const email = await drive.signIn();
    refreshDriveSection(); renderSyncChip(); render();
    toast(`Collegato${email ? ' come ' + email : ''}: sincronizzo la libreria…`);
    await sync.syncNow();
    toast('Libreria sincronizzata con Google Drive');
  } catch (err) {
    toast(driveMessage(err), 7000);
  }
  refreshDriveSection();
});
$('#btnDriveSignOut').addEventListener('click', () => {
  if (!confirm('Scollegare Scaffale da Google Drive su questo dispositivo? I libri restano qui e su Drive, ma non si sincronizzeranno più finché non accedi di nuovo.')) return;
  drive.signOut();
  refreshDriveSection(); renderSyncChip(); render();
  toast('Scollegato da Google Drive');
});
$('#btnClientChange').addEventListener('click', () => {
  if (drive.isEnabled() && !confirm('Cambiare l\'ID client ti scollega da Google Drive su questo dispositivo. Continuare?')) return;
  drive.signOut();
  drive.setClientId('');
  refreshDriveSection(); renderSyncChip(); render();
});
$('#btnClientPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const m = text.match(/[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com/i);
    if (m) { $('#driveClient').value = m[0]; toast('ID client incollato: ora premi «Salva»'); }
    else toast("Negli appunti non c'è un ID client: finisce con .apps.googleusercontent.com");
  } catch (err) {
    $('#driveClient').focus();
    toast('Tieni premuto nel campo e scegli «Incolla»');
  }
});
$('#btnClientSave').addEventListener('click', () => {
  const raw = $('#driveClient').value;
  const m = raw.match(/[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com/i);
  if (!m || !drive.isValidClientId(m[0])) {
    $('#clientMsg').textContent = 'ID client non valido: è una sequenza di numeri e lettere che finisce con .apps.googleusercontent.com. Copialo di nuovo dalla pagina Credenziali.';
    return;
  }
  drive.setClientId(m[0]);
  drive.prepare().catch(() => {});
  refreshDriveSection(); refreshInviteHint();
  toast('ID client salvato: ora premi «Accedi con Google»');
});

window.addEventListener('sync-status', () => {
  renderSyncChip();
  if ($('#dlgSettings').open) refreshDriveSection();
});
// La sincronizzazione ha portato modifiche dagli altri dispositivi
window.addEventListener('sync-applied', async () => {
  await reload();
  const b = state.books.find(x => x.id === currentId);
  if ($('#dlgBook').open) {
    if (b) renderDetail(b);
    else { closeSheet($('#dlgBook')); toast('Questo libro è stato eliminato su un altro dispositivo'); }
  }
});
// Niente sincronizzazioni automatiche mentre leggi o compili una scheda: aspettano la chiusura
sync.setBusy(() => $('#dlgReader').open || $('#dlgForm').open || !!(imp && imp.phase === 'saving'));
$('#dlgForm').addEventListener('sheetclosed', () => sync.schedule(2000));

function startDriveSync() {
  if (!drive.isEnabled()) { renderSyncChip(); return; }
  drive.prepare().catch(() => {}); // carico in anticipo il client di Google
  renderSyncChip();
  sync.autoSync();
}
document.addEventListener('visibilitychange', () => {
  if (!drive.isEnabled()) return;
  if (document.visibilityState === 'visible') {
    renderSyncChip();
    if (Date.now() - sync.status().at > 60000) sync.autoSync();
  } else if (localStorage.getItem('syncDirty') === '1') {
    sync.autoSync(); // l'app va in secondo piano: provo a salvare subito le modifiche
  }
});
window.addEventListener('online', () => { if (drive.isEnabled()) setTimeout(() => sync.autoSync(), 1500); });
setInterval(() => { if (document.visibilityState === 'visible') renderSyncChip(); }, 60000);

// ------------------------------------------------------------ invito
// Il link contiene la chiave nel "frammento", la parte dopo #: il browser non lo invia
// mai al server, quindi la chiave non passa da GitHub. Chi apre il link la trova salvata.
function inviteLink() {
  const url = new URL('./', location.href);
  const key = getGoogleKey(), client = drive.getClientId();
  const parts = [];
  if (key || client) parts.push('invito=' + encodeURIComponent(key || ''));
  if (client) parts.push('client=' + encodeURIComponent(client));
  if (parts.length) url.hash = parts.join('&');
  return url.href;
}
function refreshInviteHint() {
  const parts = [getGoogleKey()
    ? "Manda a un'altra persona il link per installare Scaffale. Il link contiene la tua chiave di ricerca: chi lo apre trova la ricerca dei libri già pronta. Mandalo solo a persone di cui ti fidi."
    : "Manda a un'altra persona il link per installare Scaffale. Non hai una chiave salvata: chi lo apre dovrà configurare la ricerca da sé."];
  if (drive.getClientId()) parts.push("Contiene anche l'accesso a Google Drive: potrà sincronizzare la sua libreria con il suo Drive, dopo che avrai aggiunto il suo indirizzo Gmail tra gli «Utenti di test» nella console di Google.");
  $('#inviteHint').textContent = parts.join(' ');
}
$('#btnInvite').addEventListener('click', async () => {
  const url = inviteLink();
  const text = 'Ti consiglio Scaffale, l\'app per catalogare i libri di casa. Apri il link con Chrome e premi «Installa» (oppure menu ⋮ → «Aggiungi a schermata Home»).' +
    (getGoogleKey() ? ' La ricerca dei libri è già configurata.' : '');
  if (navigator.share) {
    try { await navigator.share({ title: 'Scaffale', text, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Invito copiato: incollalo in un messaggio');
  } catch (e) {
    window.prompt('Copia questo link e mandalo:', url);
  }
});

// All'apertura di un link di invito: salva la chiave e la toglie dall'indirizzo
function acceptInvite() {
  if (!/(^|[#&])invito=/.test(location.hash)) return;
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const key = params.get('invito') || '';
  const client = params.get('client') || '';
  const okKey = /^AIza[0-9A-Za-z_\-]{30,56}$/.test(key);
  const okClient = drive.isValidClientId(client);
  if (!okKey && !okClient) { toast('Il link di invito non è valido'); return; }
  const done = [];
  if (okKey && getStoredGoogleKey() !== key) {
    const current = getStoredGoogleKey();
    if (!current || confirm('Il link di invito contiene una chiave di ricerca diversa da quella che hai già salvato. Vuoi sostituirla?')) {
      setGoogleKey(key); done.push('la ricerca dei libri');
    }
  }
  if (okClient && drive.getStoredClientId() !== client && !drive.isEnabled()) {
    drive.setClientId(client); done.push('il collegamento a Google Drive');
  }
  if (done.length) toast(`Benvenuto! Ho già configurato ${done.join(' e ')}.`, 6000);
}

async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) { /* facoltativo */ }
  }
}

// ------------------------------------------------------------ testata
$('#groupBy').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.groupBy = b.dataset.g; localStorage.setItem('groupBy', state.groupBy); render();
});
$('#btnView').addEventListener('click', () => {
  state.view = state.view === 'shelf' ? 'list' : 'shelf'; localStorage.setItem('view', state.view); render();
});
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#shelf').addEventListener('click', e => {
  const el = e.target.closest('[data-id]'); if (el) openDetail(el.dataset.id);
});
window.addEventListener('online', () => { renderPending(); setTimeout(autoComplete, 2000); });
window.addEventListener('offline', renderPending);

// ------------------------------------------------------------ avvio
applyTheme(localStorage.getItem('theme') || 'auto');
acceptInvite();
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Una nuova versione dell'app ha preso il controllo: ricarico per usarla
    if (!hadController || reloading) return;
    reloading = true;
    if (!openStack.length) location.reload();
    else toast("Nuova versione installata: chiudi e riapri l'app", 6000);
  });
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
}
reload().then(() => {
  acceptShared().catch(err => console.warn('Condivisione', err));
  startDriveSync();
  setTimeout(autoComplete, 4000);
});
