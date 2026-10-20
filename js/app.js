import { db, newId } from './db.js';
import {
  GENRES, genreColor, hash, buildAuthorResolver, similarAuthor, cleanIsbn, isValidIsbn,
  extractFromText, lookupIsbn, searchByText, fetchCover,
} from './catalog.js';
import { barcodeSupported, scanIsbn } from './scanner.js';
import { ocrReady, downloadOcr, removeOcr, recognize } from './ocr.js';
import { buildPdf } from './pdf.js';

const VERSION = '1.0.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  books: [],
  groupBy: localStorage.getItem('groupBy') || 'genre',
  view: localStorage.getItem('view') || 'shelf',
  q: '',
};

// ---------------------------------------------------------------- utilità
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
$$('dialog.sheet').forEach(dlg => {
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
  return `<div class="slot"><button class="spine ${s}" data-id="${b.id}" style="--c:${c};--t:${readableOn(c)};--h:${height}px;--w:${width}px${p !== null ? `;--p:${p}` : ';--p:.35'}" aria-label="${esc(b.title)}${b.author ? ', ' + esc(b.author) : ''}">
    ${s === 'reading' ? '<span class="ribbon"></span>' : ''}${s === 'done' ? '<span class="check"></span>' : ''}
    <span class="st">${esc(b.title || 'Senza titolo')}</span>
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
    <span><span class="t">${esc(b.title || 'Senza titolo')}</span><span class="a">${esc(b.author || 'Autore sconosciuto')}</span>
    <span class="meta">${esc([b.year, b.genre].filter(Boolean).join(', '))}</span></span>
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
        <h2>${esc(b.title || 'Senza titolo')}</h2>
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
    <div class="detail-actions">
      <button class="btn ghost" id="dEdit"><svg><use href="#i-pen"/></svg>Modifica</button>
      <button class="btn danger" id="dDelete">Elimina</button>
    </div>`;
}

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
  saveTimer = setTimeout(() => db.put(b), 300);
}

$('#dlgBook').addEventListener('click', async e => {
  const b = state.books.find(x => x.id === currentId);
  if (!b) return;
  const step = e.target.closest('[data-step]');
  if (step) { setPage((b.currentPage || 0) + +step.dataset.step); return; }
  if (e.target.closest('#bmDone')) {
    if (b.pages) b.currentPage = b.pages;
    b.finished = true; b.bookmarkAt = Date.now();
    await db.put(b); renderDetail(b); toast('Segnato come letto');
    return;
  }
  if (e.target.closest('#bmRestart')) {
    b.currentPage = 0; b.finished = false; b.bookmarkAt = Date.now();
    await db.put(b); renderDetail(b); return;
  }
  const by = e.target.closest('.by');
  if (by) {
    state.q = by.dataset.author; $('#q').value = state.q;
    closeSheet($('#dlgBook')); render(); return;
  }
  if (e.target.closest('#dEdit')) {
    closeSheet($('#dlgBook'));
    openForm({ ...b }, { existing: b });
    return;
  }
  if (e.target.closest('#dDelete')) {
    if (!confirm(`Eliminare «${b.title}» dallo scaffale?`)) return;
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
  clearTimeout(saveTimer);
  const b = state.books.find(x => x.id === currentId);
  if (b) await db.put(b);
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
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const f = form.elements;
  const title = f.title.value.trim();
  if (!title) { f.title.focus(); toast('Scrivi almeno il titolo'); return; }
  const isbn = cleanIsbn(f.isbn.value);
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
  if (formCtx.coverChanged) { book.cover = formCtx.cover; book.coverStamp = Date.now(); }
  if (book.pages && book.currentPage > book.pages) book.currentPage = book.pages;
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
        const data = await lookupIsbn(found.isbn);
        if (data) { fillForm(data, { overwrite: false }); await maybeCover(data.coverUrl); }
      } else formCtx.needsLookup = true;
    }
  } catch (err) {
    ocrMessage(esc(err.message || 'Lettura non riuscita.'));
  }
}

async function maybeCover(url) {
  if (formCtx.cover || !url) return;
  const blob = await fetchCover(url);
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
  const res = await searchByText(t, a);
  if (!res.length) { box.innerHTML = '<p class="hint">Nessun risultato. Prova a correggere il titolo.</p>'; return; }
  box._res = res;
  box.innerHTML = res.map((r, i) => `<button type="button" class="cand" data-i="${i}">
    ${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
    <span><strong>${esc(r.title)}</strong><small>${esc([r.author, r.year, r.publisher].filter(Boolean).join(', '))}</small></span></button>`).join('');
});
$('#candidates').addEventListener('click', async e => {
  const c = e.target.closest('.cand'); if (!c) return;
  const r = $('#candidates')._res[+c.dataset.i];
  fillForm(r);
  $('#candidates').innerHTML = '';
  toast('Dati inseriti: controlla e salva');
  if (r.isbn) await maybeCover(`https://covers.openlibrary.org/b/isbn/${r.isbn}-L.jpg?default=false`);
  await maybeCover(r.coverUrl);
});

// ------------------------------------------------------------ aggiunta
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
    $('.scan-hint').textContent = 'Questo browser non legge i codici a barre: scrivi l\'ISBN qui sotto. Usa Chrome per Android.';
    return;
  }
  $('.scan-hint').textContent = 'Inquadra il codice a barre che inizia con 978 o 979';
  scanAbort = new AbortController();
  try {
    const isbn = await scanIsbn($('#video'), { signal: scanAbort.signal });
    closeSheet($('#dlgScan'));
    handleIsbn(isbn);
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
  const v = cleanIsbn($('#isbnManual').value);
  if (!isValidIsbn(v)) { toast('ISBN non valido: controlla le cifre'); return; }
  closeSheet($('#dlgScan'));
  handleIsbn(v);
});

async function handleIsbn(isbn) {
  const dup = state.books.find(b => b.isbn === isbn);
  if (dup) { toast('Questo libro è già nel tuo scaffale'); openDetail(dup.id); return; }
  if (!navigator.onLine) {
    openForm({ isbn }, { needsLookup: true, hint: 'Sei offline: salva pure con il solo titolo. Il resto si completa quando torni online.' });
    return;
  }
  toast('Cerco il libro…', 8000);
  const data = await lookupIsbn(isbn);
  if (!data) {
    toast('Non ho trovato dati: compila a mano');
    openForm({ isbn }, { hint: 'ISBN non presente negli archivi online. Puoi fotografare la copertina per leggere il titolo.' });
    return;
  }
  let cover = null;
  const blob = await fetchCover(data.coverUrl);
  if (blob) cover = await normalizeCoverBlob(blob);
  $('#toast').classList.remove('show');
  openForm(data, { cover, hint: 'Controlla i dati e salva.' });
}

// Completa i libri aggiunti offline
$('#btnComplete').addEventListener('click', async () => {
  const pending = state.books.filter(b => b.needsLookup);
  $('#btnComplete').disabled = true;
  let ok = 0;
  for (const b of pending) {
    const d = await lookupIsbn(b.isbn);
    if (d) {
      for (const k of ['title', 'author', 'year', 'pages', 'publisher', 'genre']) if (!b[k] && d[k]) b[k] = d[k];
      if (!b.cover) {
        const blob = await fetchCover(d.coverUrl);
        const small = blob && await normalizeCoverBlob(blob);
        if (small) { b.cover = small; b.coverStamp = Date.now(); }
      }
      ok++;
    }
    b.needsLookup = false;
    await db.put(b);
  }
  $('#btnComplete').disabled = false;
  await reload();
  toast(`${ok} su ${pending.length} libri completati`);
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
    .map(b => ({ ...b, currentPage: status(b) === 'done' ? (b.pages || 1) : (b.currentPage || 0), pages: status(b) === 'done' && !b.pages ? 1 : b.pages }));
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
$('#btnSettings').addEventListener('click', async () => {
  openSheet($('#dlgSettings'));
  $('#version').textContent = `Scaffale ${VERSION}`;
  refreshOcrStatus();
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#storageInfo').textContent = `Spazio usato: ${(est.usage / 1048576).toFixed(1)} MB. ` +
      (persisted ? 'Archivio protetto dalla pulizia automatica.' : 'Archivio non ancora protetto dalla pulizia automatica del browser.');
  }
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
  const books = await Promise.all(state.books.map(async b => ({ ...b, cover: b.cover ? await blobToDataUrl(b.cover) : null })));
  const json = JSON.stringify({ app: 'scaffale', version: 1, exportedAt: new Date().toISOString(), books });
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
    if (!confirm(`Ripristinare ${books.length} libri? Quelli già presenti con lo stesso identificativo verranno sovrascritti.`)) return;
    await db.putMany(books);
    await reload();
    toast(`${books.length} libri ripristinati`);
  } catch (err) { toast('File non valido: scegli una copia creata da Scaffale'); }
});

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
window.addEventListener('online', renderPending);
window.addEventListener('offline', renderPending);

// ------------------------------------------------------------ avvio
applyTheme(localStorage.getItem('theme') || 'auto');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
}
reload();
