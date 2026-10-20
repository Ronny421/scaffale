// Logica di catalogazione: generi, autori "simili", ISBN, ricerca dati online.

export const GENRES = [
  { name: 'Narrativa',        color: '#3A86FF' },
  { name: 'Classici',         color: '#7B2D26' },
  { name: 'Giallo e thriller', color: '#E63946' },
  { name: 'Fantascienza',     color: '#2A9D8F' },
  { name: 'Fantasy',          color: '#7B4FBF' },
  { name: 'Romanzo storico',  color: '#B5651D' },
  { name: 'Rosa',             color: '#FF5D8F' },
  { name: 'Horror',           color: '#3D3B4A' },
  { name: 'Poesia',           color: '#C9A227' },
  { name: 'Saggistica',       color: '#457B9D' },
  { name: 'Scienza e tecnica', color: '#0F8B8D' },
  { name: 'Storia',           color: '#8A5A3C' },
  { name: 'Filosofia',        color: '#5E548E' },
  { name: 'Biografia',        color: '#E07A5F' },
  { name: 'Arte',             color: '#D1495B' },
  { name: 'Ragazzi',          color: '#8AC926' },
  { name: 'Fumetti',          color: '#FB8500' },
  { name: 'Viaggi',           color: '#219EBC' },
  { name: 'Cucina',           color: '#E76F51' },
  { name: 'Altro',            color: '#6C757D' },
];

// Colore stabile anche per generi personalizzati inventati dall'utente
const EXTRA = ['#F15BB5', '#00BBF9', '#9B5DE5', '#00A878', '#F4A261', '#264653'];
export function genreColor(name) {
  const g = GENRES.find(g => g.name.toLowerCase() === (name || '').toLowerCase());
  if (g) return g.color;
  if (!name) return '#6C757D';
  return EXTRA[hash(name) % EXTRA.length];
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// --- Autori simili ---------------------------------------------------------
// "Calvino, Italo", "italo calvino", "Italo  Calvino." -> stessa chiave.
export function authorKey(name) {
  if (!name) return '';
  let s = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2);
    s = `${first} ${last}`;
  }
  const tokens = s.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.sort().join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Raggruppa gli autori: chiavi uguali o quasi uguali (refusi) finiscono insieme.
// Restituisce una funzione che, dato un autore, dà il nome "canonico" del gruppo.
// A parità di frequenza preferisco "Nome Cognome" scritto con le maiuscole
function pretty(name) {
  return (name.includes(',') ? 0 : 2) + (/^[A-ZÀ-Ý]/.test(name) ? 1 : 0);
}

function total(m) {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

export function buildAuthorResolver(books) {
  const counts = new Map(); // key -> Map(spelling -> count)
  for (const b of books) {
    if (!b.author) continue;
    const k = authorKey(b.author);
    if (!counts.has(k)) counts.set(k, new Map());
    const m = counts.get(k);
    m.set(b.author.trim(), (m.get(b.author.trim()) || 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => total(counts.get(b)) - total(counts.get(a)));
  const parent = new Map();
  for (const k of keys) {
    let target = k;
    for (const p of keys) {
      if (p === k) break; // solo chiavi più "popolari" già viste
      const tol = Math.max(1, Math.floor(Math.min(p.length, k.length) / 8));
      if (Math.abs(p.length - k.length) <= tol && levenshtein(p, k) <= tol) { target = parent.get(p) || p; break; }
    }
    parent.set(k, target);
  }
  const display = new Map();
  for (const [k, m] of counts) {
    const root = parent.get(k);
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || pretty(b[0]) - pretty(a[0]) || a[0].localeCompare(b[0]))[0][0];
    if (!display.has(root) || root === k) display.set(root, best);
  }
  return author => {
    if (!author) return null;
    const root = parent.get(authorKey(author)) || authorKey(author);
    return display.get(root) || author.trim();
  };
}

export function similarAuthor(input, books) {
  const k = authorKey(input);
  if (k.length < 3) return null;
  let best = null, bestD = Infinity;
  for (const b of books) {
    if (!b.author || b.author.trim() === input.trim()) continue;
    const bk = authorKey(b.author);
    const d = bk === k ? 0 : levenshtein(bk, k);
    const tol = Math.max(1, Math.floor(Math.min(bk.length, k.length) / 8));
    if (d <= tol && d < bestD) { best = b.author.trim(); bestD = d; }
  }
  return best;
}

// --- ISBN -----------------------------------------------------------------
export function cleanIsbn(s) {
  return (s || '').toUpperCase().replace(/[^0-9X]/g, '');
}

export function isValidIsbn(raw) {
  const s = cleanIsbn(raw);
  if (s.length === 13 && /^97[89]\d{10}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += +s[i] * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === +s[12];
  }
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : +s[i]) * (10 - i);
    return sum % 11 === 0;
  }
  return false;
}

// Cerca ISBN e anno dentro un testo letto dall'OCR (utile sulla pagina del copyright)
export function extractFromText(text) {
  const out = {};
  const isbnCandidates = text.match(/(?:ISBN[\s:\-]*)?(97[89][\d\-\s]{10,17}|\d[\d\-\s]{8,12}[\dXx])/g) || [];
  for (const c of isbnCandidates) {
    const s = cleanIsbn(c.replace(/^ISBN/i, ''));
    for (const cand of [s, s.slice(0, 13), s.slice(0, 10)]) {
      if (isValidIsbn(cand)) { out.isbn = cand; break; }
    }
    if (out.isbn) break;
  }
  const years = (text.match(/\b(1[5-9]\d\d|20[0-2]\d)\b/g) || []).map(Number)
    .filter(y => y <= new Date().getFullYear());
  if (years.length) out.year = Math.max(...years);
  return out;
}

// --- Generi da categorie in inglese/italiano -------------------------------
const GENRE_RULES = [
  [/science fiction|fantascienza|sci-fi|dystopi/i, 'Fantascienza'],
  [/fantasy/i, 'Fantasy'],
  [/mystery|detective|crime|thriller|suspense|giallo|noir|poliziesc/i, 'Giallo e thriller'],
  [/horror|ghost|orrore/i, 'Horror'],
  [/romance|love stor|rosa\b/i, 'Rosa'],
  [/historical fiction|romanzo storico/i, 'Romanzo storico'],
  [/comic|graphic novel|manga|fumett/i, 'Fumetti'],
  [/juvenile|children|young adult|ragazzi|bambini/i, 'Ragazzi'],
  [/poetry|poesi/i, 'Poesia'],
  [/biograph|autobiograph|memoir/i, 'Biografia'],
  [/cook|recipe|cucina|ricett/i, 'Cucina'],
  [/travel|viagg/i, 'Viaggi'],
  [/philosoph|filosof/i, 'Filosofia'],
  [/\bart\b|arts|architecture|photograph|music|arte\b/i, 'Arte'],
  [/science|technolog|engineering|mathemat|physics|computer|medical|aerospace|scienz|tecnic|ingegner/i, 'Scienza e tecnica'],
  [/history|storia/i, 'Storia'],
  [/classic|literary collections|classici/i, 'Classici'],
  [/fiction|novel|narrativa|romanz/i, 'Narrativa'],
  [/political|social|economic|business|psycholog|religion|education|law|saggi/i, 'Saggistica'],
];

export function mapGenre(categories) {
  const text = [].concat(categories || []).join(' | ');
  if (!text) return '';
  for (const [re, g] of GENRE_RULES) if (re.test(text)) return g;
  return '';
}

// --- Ricerca dati online (solo quando c'è connessione) ----------------------
// Tre archivi interrogati in parallelo. Per ciascuno si annota l'esito, così si
// distingue "libro non trovato" da "archivio che ha rifiutato la richiesta".

const KEY_STORAGE = 'googleBooksKey';
export function getGoogleKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}
export function setGoogleKey(k) {
  try { k && k.trim() ? localStorage.setItem(KEY_STORAGE, k.trim()) : localStorage.removeItem(KEY_STORAGE); } catch (e) { /* niente */ }
}

class HttpError extends Error {
  constructor(status, body) { super('HTTP ' + status); this.status = status; this.body = body; }
}

async function fetchJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch (e) { /* corpo non JSON */ }
      throw new HttpError(r.status, body);
    }
    return await r.json();
  } finally { clearTimeout(t); }
}

// Esiti possibili di ogni archivio:
// ok, empty (risponde ma non ha il libro), quota (limite di richieste esaurito),
// badkey (chiave Google non valida o non autorizzata), error (rete, timeout, server giù)
function classify(err, usedKey) {
  if (err instanceof HttpError) {
    const body = JSON.stringify(err.body || '');
    if (err.status === 429 || /RESOURCE_EXHAUSTED|rateLimitExceeded|quota/i.test(body)) return 'quota';
    if (usedKey && (err.status === 400 || err.status === 403)) return 'badkey';
  }
  return 'error';
}

const STATUS_TEXT = {
  ok: 'funziona',
  empty: 'funziona',
  quota: 'limite di richieste esaurito',
  badkey: 'chiave non valida o non autorizzata per questo sito',
  error: 'non raggiungibile',
};
export function describeStatus(status) {
  const names = { google: 'Google Books', openlibrary: 'Open Library', olsearch: 'Open Library (ricerca)' };
  return Object.entries(status).map(([k, v]) => `${names[k]}: ${STATUS_TEXT[v]}`);
}

function googleUrl(query, extra = '') {
  const key = getGoogleKey();
  return `https://www.googleapis.com/books/v1/volumes?q=${query}${extra}` + (key ? `&key=${encodeURIComponent(key)}` : '');
}

function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn = (ids.find(i => i.type === 'ISBN_13') || ids.find(i => i.type === 'ISBN_10') || {}).identifier || '';
  const thumb = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
  return {
    title: [v.title, v.subtitle].filter(Boolean).join(': '),
    author: (v.authors || []).join(', '),
    year: v.publishedDate ? String(parseInt(v.publishedDate, 10) || '') : '',
    publisher: v.publisher || '',
    pages: v.pageCount || '',
    genre: mapGenre(v.categories),
    isbn,
    coverUrl: thumb ? thumb.replace('http://', 'https://').replace('&edge=curl', '') : '',
  };
}

async function googleByIsbn(isbn) {
  const g = await fetchJson(googleUrl('isbn:' + isbn));
  return g.items && g.items.length ? fromGoogle(g.items[0]) : null;
}

async function openLibraryByIsbn(isbn) {
  const o = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const d = o[`ISBN:${isbn}`];
  if (!d) return null;
  return {
    title: [d.title, d.subtitle].filter(Boolean).join(': '),
    author: (d.authors || []).map(a => a.name).join(', '),
    year: d.publish_date ? (String(d.publish_date).match(/\d{4}/) || [''])[0] : '',
    publisher: (d.publishers || []).map(p => p.name).join(', '),
    pages: d.number_of_pages || '',
    genre: mapGenre((d.subjects || []).map(s => s.name)),
    coverUrl: d.cover ? (d.cover.large || d.cover.medium || '') : '',
  };
}

const OL_FIELDS = 'title,subtitle,author_name,first_publish_year,publisher,number_of_pages_median,subject,cover_i';
function fromOlDoc(d) {
  return {
    title: [d.title, d.subtitle].filter(Boolean).join(': '),
    author: (d.author_name || []).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    publisher: (d.publisher || [])[0] || '',
    pages: d.number_of_pages_median || '',
    genre: mapGenre(d.subject),
    isbn: '',
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
  };
}

async function openLibrarySearchByIsbn(isbn) {
  const s = await fetchJson(`https://openlibrary.org/search.json?isbn=${isbn}&fields=${OL_FIELDS}&limit=1`);
  return s.docs && s.docs.length ? fromOlDoc(s.docs[0]) : null;
}

// Unisce i risultati: il primo archivio ha la precedenza, gli altri riempiono i vuoti
function merge(base, extra) {
  if (!base) return { ...extra, coverUrls: extra.coverUrl ? [extra.coverUrl] : [] };
  for (const k of ['title', 'author', 'year', 'publisher', 'pages', 'genre']) {
    if (!base[k] && extra[k]) base[k] = extra[k];
  }
  if (extra.coverUrl) base.coverUrls.push(extra.coverUrl);
  return base;
}

// Restituisce { book, outcome, status }
// outcome: found | notfound | quota | badkey | unreachable
export async function lookupIsbn(raw) {
  const isbn = cleanIsbn(raw);
  const usedKey = !!getGoogleKey();
  const sources = [
    ['google', googleByIsbn(isbn)],
    ['openlibrary', openLibraryByIsbn(isbn)],
    ['olsearch', openLibrarySearchByIsbn(isbn)],
  ];
  const settled = await Promise.allSettled(sources.map(s => s[1]));
  const status = {};
  let book = null;
  settled.forEach((res, i) => {
    const name = sources[i][0];
    if (res.status === 'fulfilled') {
      status[name] = res.value ? 'ok' : 'empty';
      if (res.value) book = merge(book, res.value);
    } else {
      status[name] = classify(res.reason, name === 'google' && usedKey);
    }
  });
  if (book) {
    book.isbn = isbn;
    // La copertina di Open Library per ISBN è la più affidabile da scaricare
    book.coverUrls.unshift(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`);
    book.coverUrl = book.coverUrls.find(u => !u.includes('default=false')) || '';
    return { book, outcome: 'found', status };
  }
  let outcome = 'notfound';
  if (status.google === 'quota') outcome = 'quota';
  else if (status.google === 'badkey') outcome = 'badkey';
  else if (Object.values(status).every(s => s === 'error')) outcome = 'unreachable';
  else if (status.google === 'error') outcome = 'unreachable';
  return { book: null, outcome, status };
}

// Ricerca per titolo/autore: Google Books, e Open Library se Google non risponde
// Restituisce { results, outcome }
export async function searchByText(title, author) {
  const q = [title && `intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join('+');
  if (!q) return { results: [], outcome: 'notfound' };
  let googleOutcome = 'notfound';
  try {
    const g = await fetchJson(googleUrl(encodeURIComponent(q), '&maxResults=6'));
    const results = (g.items || []).map(fromGoogle);
    if (results.length) return { results, outcome: 'found' };
  } catch (e) {
    googleOutcome = classify(e, !!getGoogleKey());
  }
  try {
    const p = new URLSearchParams({ limit: '6', fields: OL_FIELDS });
    if (title) p.set('title', title);
    if (author) p.set('author', author);
    const s = await fetchJson('https://openlibrary.org/search.json?' + p);
    const results = (s.docs || []).map(fromOlDoc);
    if (results.length) return { results, outcome: 'found' };
  } catch (e) {
    if (googleOutcome !== 'notfound') return { results: [], outcome: googleOutcome === 'error' ? 'unreachable' : googleOutcome };
    return { results: [], outcome: 'unreachable' };
  }
  return { results: [], outcome: googleOutcome === 'notfound' ? 'notfound' : googleOutcome === 'error' ? 'unreachable' : googleOutcome };
}

// Scarica la copertina provando più indirizzi; se nessun server lo consente, pazienza
export async function fetchCover(urls) {
  for (const url of [].concat(urls || []).filter(Boolean)) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const blob = await r.blob();
      if (blob.type.startsWith('image/') && blob.size > 1500) return blob;
    } catch (e) { /* prova il prossimo */ }
  }
  return null;
}
