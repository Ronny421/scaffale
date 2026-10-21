import { db, newId } from './db.js';
import {
  GENRES, genreColor, hash, buildAuthorResolver, similarAuthor, cleanIsbn, isValidIsbn,
  extractFromText, lookupIsbn, searchByText, fetchCover, getGoogleKey, setGoogleKey, statusReport,
  getStoredGoogleKey, BUILTIN_GOOGLE_KEY, classifyCode, lookupEan,
} from './catalog.js';
import { barcodeSupported, scanIsbn } from './scanner.js';
import { ocrReady, downloadOcr, removeOcr, recognize } from './ocr.js';
import { buildPdf } from './pdf.js';
import { Reader } from './reader.js';
import * as drive from './drive.js';
import * as sync from './sync.js';

const VERSION = '1.10.0';
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
  return state.books.filter(b => [b.title, b.author, b.isbn, b.publisher, b.genre, b.year].join(' ')
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
    <span class="meta">${esc([b.year, b.genre, fileLabel(b)].filter(Boolean).join(', '))}</span></span>
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
  const busy = xfer && xfer.bookId === b.id;
  const primary = [];
  primary.push(`<button class="btn small" id="fRead"${busy ? ' disabled' : ''}><svg><use href="#i-book"/></svg>${local ? 'Leggi' : 'Scarica e leggi'}</button>`);
  if (local && !cloud && driveOn) primary.push(`<button class="btn ghost small" id="fUpload"${busy ? ' disabled' : ''}><svg><use href="#i-up"/></svg>Carica su Drive</button>`);
  if (differs && driveOn) primary.push(`<button class="btn ghost small" id="fUpload"${busy ? ' disabled' : ''}><svg><use href="#i-up"/></svg>Sostituisci su Drive</button>`);
  if (!local && cloud) primary.push(`<button class="btn ghost small" id="fDownload"${busy ? ' disabled' : ''}><svg><use href="#i-down"/></svg>Scarica sul ${DEV}</button>`);
  const more = [];
  if (local) more.push('<button class="btn ghost small" id="fOpen">Apri con…</button>', '<button class="btn ghost small" id="fSave">Salva nei Download</button>');
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

// Da chiamare dentro un tocco: se serve, apre la finestra di Google
async function ensureDrive() {
  if (!drive.getClientId()) {
    toast('Prima collega Google Drive nelle Impostazioni');
    openSettings('drive');
    return false;
  }
  try {
    const wasOn = drive.isEnabled();
    if (!wasOn) { await drive.signIn(); refreshDriveSection(); }
    else await drive.ensureToken(true);
    return true;
  } catch (err) {
    toast(driveMessage(err), 6000);
    return false;
  }
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

async function uploadToDrive(b) {
  if (xfer) { toast('Aspetta che finisca il trasferimento in corso'); return; }
  if (!(await ensureDrive())) return;
  const rec = await db.files.get(b.id);
  if (!rec) { await forgetLocalFile(b); toast('Il file non è su questo ' + DEV); return; }
  const x = startXfer(b, 'up');
  try {
    const res = await drive.uploadBook({ blob: rec.blob, name: rec.name, mimeType: rec.type, onProgress: xferProgress, signal: x.ctrl.signal });
    let old = null;
    const saved = await db.update(b.id, cur => {
      old = cur.cloud && cur.cloud.id;
      cur.cloud = { id: res.id, name: rec.name, type: rec.type, size: rec.size };
      cur.editedAt = Date.now();
    });
    if (!saved) {
      sync.queueTrash(res.id); // il libro è stato eliminato durante il caricamento
      toast('Il libro è stato eliminato durante il caricamento');
      return;
    }
    if (old && old !== res.id) sync.queueTrash(old); // la versione precedente va nel cestino di Drive
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
  if (xfer) { toast('Aspetta che finisca il trasferimento in corso'); return false; }
  if (!b.cloud) return false;
  if (!(await ensureDrive())) return false;
  if (navigator.storage && navigator.storage.estimate && b.cloud.size) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < b.cloud.size * 1.1) { toast('Spazio insufficiente sul ' + DEV + ' per questo file'); return false; }
  }
  const x = startXfer(b, 'down');
  try {
    const blob = await drive.downloadBook(b.cloud.id, { onProgress: xferProgress, signal: x.ctrl.signal });
    const type = b.cloud.type || blob.type;
    if (!(await db.get(b.id))) { toast('Il libro è stato eliminato durante lo scaricamento'); return false; }
    await db.files.put({ bookId: b.id, name: b.cloud.name, type, size: blob.size, blob: new Blob([blob], { type }), addedAt: Date.now() });
    const saved = await db.update(b.id, cur => { cur.file = { name: b.cloud.name, type, size: blob.size }; });
    if (!saved) { await db.files.remove(b.id); return false; }
    await reload();
    requestPersistence();
    toast('Scaricato sul ' + DEV);
    return true;
  } catch (err) {
    if (err.reason === 'notFound') {
      // Il file è stato eliminato da Drive direttamente: tolgo il riferimento
      await db.update(b.id, cur => { delete cur.cloud; cur.editedAt = Date.now(); });
      await reload();
      toast('Il file non è più su Google Drive', 6000);
    } else if (err.reason !== 'aborted') {
      toast(driveMessage(err), 6000);
    }
    return false;
  } finally {
    endXfer(); render();
  }
}

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
  const n = f.name.toLowerCase();
  const type = /epub/.test(f.type) || n.endsWith('.epub') ? 'application/epub+zip'
    : /pdf/.test(f.type) || n.endsWith('.pdf') ? 'application/pdf' : '';
  if (!type) { toast('Scegli un file PDF o EPUB'); return; }
  // Il browser concede a ogni sito una parte del disco del telefono: controllo che basti
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < f.size * 1.1) { toast('Spazio insufficiente sul ' + DEV + ' per questo file'); return; }
  }
  toast('Salvo il file…', 15000);
  try {
    // Copio i byte in un nuovo Blob: così il file resta nell'app anche se cancelli l'originale
    const blob = new Blob([await f.arrayBuffer()], { type });
    await db.files.put({ bookId: b.id, name: f.name, type, size: f.size, blob, addedAt: Date.now() });
  } catch (err) {
    toast('Non sono riuscito a salvare il file: ' + (err.message || err.name));
    return;
  }
  b.file = { name: f.name, type, size: f.size };
  if (!(await db.putExisting(b))) { await db.files.remove(b.id); return; }
  requestPersistence();
  renderDetail(b);
  toast(b.cloud && !sameFile(b.file, b.cloud) ? 'File salvato: su Drive resta la versione precedente' : 'File salvato su questo ' + DEV);
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
    console.error(err);
    closeSheet($('#dlgReader'));
    toast('Non riesco ad aprire questo file: ' + (err.message || 'formato non riconosciuto'), 6000);
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
  book.editedAt = Date.now();
  if (formCtx.coverChanged) {
    book.cover = formCtx.cover; book.coverStamp = Date.now();
    book.coverRev = book.coverLocalRev = book.cover ? Date.now() : undefined;
  }
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

async function completePending({ manual = false } = {}) {
  if (completing) return { busy: true };
  if (!navigator.onLine) return null;
  const now = Date.now();
  const pending = state.books.filter(b => b.needsLookup && b.isbn &&
    (manual || !b.lastLookupAt || now - b.lastLookupAt > RETRY_EVERY));
  if (!pending.length) return null;
  completing = true;
  let ok = 0, missing = 0, problem = null;
  try {
    for (const p of pending.slice(0, manual ? 100 : 10)) {
      const { book: d, outcome } = await lookupIsbn(p.isbn);
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

$('#syncChip').addEventListener('click', syncByTap);
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
sync.setBusy(() => $('#dlgReader').open || $('#dlgForm').open);
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
  startDriveSync();
  setTimeout(autoComplete, 4000);
});
