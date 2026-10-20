// Archivio locale dei libri: IndexedDB, il database integrato nel browser.
// Tutto resta sul telefono, nessun server.

const DB_NAME = 'scaffale';
const DB_VERSION = 1;
const STORE = 'books';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
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
    return tx('readonly', store => reqP(store.getAll()));
  },
  get(id) {
    return tx('readonly', store => reqP(store.get(id)));
  },
  put(book) {
    book.updatedAt = Date.now();
    return tx('readwrite', store => reqP(store.put(book))).then(() => book);
  },
  putMany(books) {
    return tx('readwrite', store => Promise.all(books.map(b => reqP(store.put(b)))));
  },
  remove(id) {
    return tx('readwrite', store => reqP(store.delete(id)));
  },
};

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
