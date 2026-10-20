// Archivio locale dei libri: IndexedDB, il database integrato nel browser.
// Tutto resta sul telefono, nessun server.
//
// Due "cassetti" (object store):
//   books  le schede dei libri (piccole, si leggono tutte all'avvio)
//   files  le copie digitali allegate (PDF, EPUB: anche decine di MB), lette solo quando servono

const DB_NAME = 'scaffale';
const DB_VERSION = 2; // v1: solo i libri; v2: aggiunge i file

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Migrazione: crea solo ciò che manca, così i libri già salvati restano intatti
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'bookId' });
    };
    // Un'altra finestra aperta con la versione vecchia sta bloccando l'aggiornamento
    req.onblocked = () => window.dispatchEvent(new Event('db-blocked'));
    req.onsuccess = () => {
      const db = req.result;
      // Se in futuro un'altra finestra aggiorna il database, questa si fa da parte
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  all() {
    return tx('books', 'readonly', store => reqP(store.getAll()));
  },
  get(id) {
    return tx('books', 'readonly', store => reqP(store.get(id)));
  },
  put(book) {
    book.updatedAt = Date.now();
    return tx('books', 'readwrite', store => reqP(store.put(book))).then(() => book);
  },
  putMany(books) {
    return tx('books', 'readwrite', store => Promise.all(books.map(b => reqP(store.put(b)))));
  },
  // Elimina il libro e, se c'è, la sua copia digitale
  remove(id) {
    return tx('books', 'readwrite', store => reqP(store.delete(id)))
      .then(() => tx('files', 'readwrite', store => reqP(store.delete(id))));
  },
  files: {
    get(bookId) {
      return tx('files', 'readonly', store => reqP(store.get(bookId)));
    },
    put(record) {
      return tx('files', 'readwrite', store => reqP(store.put(record)));
    },
    remove(bookId) {
      return tx('files', 'readwrite', store => reqP(store.delete(bookId)));
    },
  },
};

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
