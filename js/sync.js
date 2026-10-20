// Sincronizzazione della libreria con Google Drive.
//
// Su Drive, nella cartella nascosta riservata a Scaffale:
//   library.json             tutte le schede dei libri, più l'elenco delle eliminazioni
//   cover-<id>-<versione>.jpg una copertina per libro
//
// Ogni sincronizzazione: scarica la versione di Drive, la unisce a quella del telefono,
// salva il risultato su entrambi. L'unione avviene libro per libro e in due parti:
//   - i dati del libro (titolo, autore, copertina…): vince la modifica più recente (editedAt)
//   - il segnalibro (pagina, posizione nel lettore): vince la lettura più recente (bookmarkAt)
// Così se correggi un titolo sul computer mentre leggi sul telefono, non si perde nulla.

import { db } from './db.js';
import * as drive from './drive.js';

const LIB_NAME = 'library.json';
// Campi che restano su ogni dispositivo e non viaggiano mai
const LOCAL_FIELDS = new Set(['file', 'cover', 'coverStamp', 'coverLocalRev', 'lastLookupAt', 'lookupMisses', 'updatedAt']);
// Campi del segnalibro, uniti a parte
const MARK_FIELDS = ['currentPage', 'finished', 'bookmarkAt', 'readerPos'];
const TOMB_TTL = 120 * 86400000; // le eliminazioni si ricordano per 120 giorni

const ls = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* niente */ } },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } },
};

// ---------------------------------------------------------------- unione (funzioni pure)
// JSON con le chiavi in ordine: due oggetti uguali danno sempre la stessa stringa
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

export const editedAt = b => b.editedAt || b.updatedAt || b.addedAt || 0;

export function contentOf(b) {
  const o = {};
  for (const k of Object.keys(b)) if (!LOCAL_FIELDS.has(k) && !MARK_FIELDS.includes(k) && b[k] !== undefined) o[k] = b[k];
  o.editedAt = editedAt(b);
  return o;
}
export function marksOf(b) {
  const o = {};
  for (const k of MARK_FIELDS) if (b[k] !== undefined && b[k] !== null) o[k] = b[k];
  o.bookmarkAt = b.bookmarkAt || 0;
  return o;
}
export const syncedOf = b => ({ ...contentOf(b), ...marksOf(b) });

// Sceglie la versione più recente; a parità di data decide il contenuto, in modo che
// tutti i dispositivi scelgano la stessa (altrimenti si rimbalzerebbero le versioni)
function newest(a, b, stamp) {
  if (stamp(a) !== stamp(b)) return stamp(a) > stamp(b) ? a : b;
  return canon(a) >= canon(b) ? a : b;
}

export function mergeRecord(L, R) {
  if (!L) return syncedOf(R);
  if (!R) return syncedOf(L);
  const content = newest(contentOf(L), contentOf(R), x => x.editedAt);
  const marks = newest(marksOf(L), marksOf(R), x => x.bookmarkAt);
  return { ...content, ...marks };
}

// local, remote: { id: libro }; localDel, remoteDel: { id: data dell'eliminazione }
export function mergeLibraries(local, localDel, remote, remoteDel, now = Date.now()) {
  const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(localDel), ...Object.keys(remoteDel)]);
  const books = {}, deleted = {};
  for (const id of ids) {
    const merged = (local[id] || remote[id]) ? mergeRecord(local[id], remote[id]) : null;
    const del = Math.max(localDel[id] || 0, remoteDel[id] || 0);
    const last = merged ? Math.max(merged.editedAt || 0, merged.bookmarkAt || 0) : 0;
    // Un'eliminazione vale se è successiva all'ultima modifica nota del libro
    if (del && del >= last) {
      if (now - del < TOMB_TTL) deleted[id] = del;
    } else if (merged) {
      books[id] = merged;
    }
  }
  return { books, deleted };
}

// ---------------------------------------------------------------- stato
let state = {
  status: 'idle', // idle | syncing | ok | login | error | offline
  at: +ls.get('syncLastAt') || 0,
  error: '',
};
let running = null, again = false, timer = null;
let busy = () => false; // l'app può chiedere di rimandare (per esempio mentre leggi)

function emit(patch) {
  state = { ...state, ...patch };
  window.dispatchEvent(new CustomEvent('sync-status', { detail: state }));
}
export const status = () => state;
export const setBusy = fn => { busy = fn; };

export const tombstones = () => ls.json('syncTombstones', {});
const setTombstones = t => ls.set('syncTombstones', Object.keys(t).length ? JSON.stringify(t) : '');
const isDirty = () => ls.get('syncDirty') === '1';
const setDirty = v => ls.set('syncDirty', v ? '1' : '');

// Chiamate dall'app
export function recordDeletion(id) {
  const t = tombstones(); t[id] = Date.now(); setTombstones(t);
  setDirty(true);
}
export function queueTrash(fileId) {
  if (!fileId) return;
  const list = ls.json('driveTrash', []);
  if (!list.includes(fileId)) list.push(fileId);
  ls.set('driveTrash', JSON.stringify(list));
}

window.addEventListener('library-changed', () => {
  setDirty(true);
  schedule();
});

// Sincronizzazione automatica, qualche secondo dopo l'ultima modifica
// Se una sincronizzazione è già prevista prima, resta quella: una richiesta più lontana
// non deve rimandare una più vicina (per esempio quella subito dopo un caricamento)
let dueAt = 0;
export function schedule(delay = 10000) {
  if (!drive.isEnabled()) return;
  const at = Date.now() + delay;
  if (timer && dueAt <= at) return;
  clearTimeout(timer);
  dueAt = at;
  timer = setTimeout(() => { timer = null; autoSync(); }, delay);
}

export function autoSync() {
  if (!drive.isEnabled() || !navigator.onLine) return Promise.resolve();
  if (!drive.hasToken()) { emit({ status: 'login' }); return Promise.resolve(); }
  if (busy()) { schedule(15000); return Promise.resolve(); }
  return syncNow().catch(() => {});
}

// ---------------------------------------------------------------- sincronizzazione
export function syncNow() {
  if (!drive.isEnabled()) return Promise.resolve({ skipped: true });
  if (running) { again = true; return running; }
  clearTimeout(timer); timer = null;
  emit({ status: 'syncing', error: '' });
  running = (async () => {
    try {
      let result = 'retry';
      for (let attempt = 0; attempt < 3 && result === 'retry'; attempt++) result = await syncOnce();
      await processTrash();
      const at = Date.now();
      ls.set('syncLastAt', String(at));
      emit({ status: 'ok', at, error: '' });
      return { ok: true };
    } catch (err) {
      const kind = err.reason === 'login' ? 'login' : err.reason === 'offline' ? 'offline' : 'error';
      emit({ status: kind, error: err.message });
      throw err;
    } finally {
      running = null;
      if (again) { again = false; setTimeout(() => autoSync(), 500); }
    }
  })();
  return running;
}

async function processTrash() {
  const list = ls.json('driveTrash', []);
  for (const id of [...list]) {
    await drive.trashFile(id);
    const now = ls.json('driveTrash', []).filter(x => x !== id);
    ls.set('driveTrash', now.length ? JSON.stringify(now) : '');
  }
}

const coverName = (id, rev) => `cover-${id}-${rev}.jpg`;
function parseCover(name) {
  const m = /^cover-(.+)-(\d+)\.jpg$/.exec(name);
  return m ? { id: m[1], rev: +m[2] } : null;
}

async function syncOnce() {
  const files = await drive.listAppFiles();
  const libFile = files.find(f => f.name === LIB_NAME);

  let localList = await db.all();
  // Copertine salvate prima della sincronizzazione: ricevono una versione calcolata
  // allo stesso modo su ogni dispositivo
  for (const b of localList) {
    let fix = false;
    if (!b.editedAt) { b.editedAt = b.updatedAt || b.addedAt || 1; fix = true; }
    if (b.cover && !b.coverLocalRev) {
      b.coverLocalRev = b.coverRev || b.coverStamp || b.addedAt || 1;
      if (!b.coverRev) b.coverRev = b.coverLocalRev;
      fix = true;
    }
    if (fix) await db.put(b, { quiet: true });
  }
  const coversPending = localList.some(b => b.coverRev && b.coverRev !== b.coverLocalRev);

  // Niente di nuovo né qui né su Drive: basta così
  if (!isDirty() && !coversPending && libFile && libFile.modifiedTime === ls.get('syncRemoteModified')) return 'done';

  let remote = { books: {}, deleted: {} };
  if (libFile) {
    let parsed;
    try { parsed = JSON.parse(await drive.readText(libFile.id)); } catch (e) {
      throw new drive.DriveError('Il file della libreria su Google Drive è illeggibile', 0, 'corrupt');
    }
    if (!parsed || typeof parsed.books !== 'object') throw new drive.DriveError('Il file della libreria su Google Drive non è valido', 0, 'corrupt');
    remote = { books: parsed.books || {}, deleted: parsed.deleted || {} };
  }

  const localMap = Object.fromEntries(localList.map(b => [b.id, b]));
  const merged = mergeLibraries(localMap, tombstones(), remote.books, remote.deleted);

  // 1) Applico il risultato sul telefono, senza toccare ciò che è stato modificato nel frattempo
  let changedHere = 0;
  for (const [id, M] of Object.entries(merged.books)) {
    const L = localMap[id];
    if (L && canon(syncedOf(L)) === canon(M)) continue;
    const fresh = await db.get(id);
    // Modificato o eliminato sul telefono mentre sincronizzavo: se ne occupa il giro successivo
    if (L && (!fresh || fresh.updatedAt !== L.updatedAt)) { again = true; continue; }
    const keep = {};
    if (fresh) for (const k of LOCAL_FIELDS) if (fresh[k] !== undefined) keep[k] = fresh[k];
    await db.put({ ...M, ...keep }, { quiet: true });
    changedHere++;
  }
  for (const id of Object.keys(merged.deleted)) {
    if (localMap[id]) { await db.remove(id, { quiet: true }); changedHere++; }
  }
  setTombstones(merged.deleted);

  // 2) Copertine: prima le carico, poi pubblico la libreria (chi la legge le troverà già)
  const remoteCovers = files.map(f => ({ f, c: parseCover(f.name) })).filter(x => x.c);
  const has = (id, rev) => remoteCovers.some(x => x.c.id === id && x.c.rev === rev);
  for (const [id, M] of Object.entries(merged.books)) {
    if (!M.coverRev) continue;
    const L = await db.get(id);
    if (!L) continue;
    if (L.cover && L.coverLocalRev === M.coverRev) {
      if (!has(id, M.coverRev)) {
        await drive.writeFile({ name: coverName(id, M.coverRev), parents: ['appDataFolder'], mimeType: L.cover.type || 'image/jpeg', data: L.cover });
      }
    } else {
      const remoteFile = remoteCovers.find(x => x.c.id === id && x.c.rev === M.coverRev);
      if (remoteFile) {
        L.cover = await drive.readBlob(remoteFile.f.id);
        L.coverLocalRev = M.coverRev;
        L.coverStamp = Date.now();
        await db.put(L, { quiet: true });
        changedHere++;
      }
      // altrimenti l'altro dispositivo non l'ha ancora caricata: ci riprovo la prossima volta
    }
  }
  // Copertine vecchie o di libri eliminati
  for (const { f, c } of remoteCovers) {
    const M = merged.books[c.id];
    if (merged.deleted[c.id] || (M && M.coverRev && c.rev < M.coverRev)) await drive.deleteFile(f.id);
  }

  // 3) Pubblico la libreria se è cambiata, controllando che nessuno l'abbia aggiornata nel frattempo
  const doc = { app: 'scaffale', v: 1, books: merged.books, deleted: merged.deleted };
  if (!libFile || canon(doc.books) !== canon(remote.books) || canon(doc.deleted) !== canon(remote.deleted)) {
    if (libFile) {
      const now = (await drive.listAppFiles()).find(f => f.name === LIB_NAME);
      if (now && now.modifiedTime !== libFile.modifiedTime) return 'retry';
    }
    const saved = await drive.writeFile({
      id: libFile && libFile.id, name: LIB_NAME, parents: ['appDataFolder'],
      mimeType: 'application/json', data: JSON.stringify(doc),
    });
    ls.set('syncRemoteModified', saved.modifiedTime || '');
  } else {
    ls.set('syncRemoteModified', libFile.modifiedTime || '');
  }
  setDirty(false);
  if (changedHere) window.dispatchEvent(new Event('sync-applied'));
  return 'done';
}
