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

// Ogni modifica avvisa il resto dell'app (per esempio la sincronizzazione), tranne
// quelle fatte con { quiet: true }: la sincronizzazione stessa scrive così, altrimenti
// ogni sincronizzazione ne provocherebbe un'altra all'infinito.
function changed(opts) {
  if (!(opts && opts.quiet)) window.dispatchEvent(new Event('library-changed'));
}

export const db = {
  all() {
    return tx('books', 'readonly', store => reqP(store.getAll()));
  },
  get(id) {
    return tx('books', 'readonly', store => reqP(store.get(id)));
  },
  put(book, opts) {
    book.updatedAt = Date.now();
    return tx('books', 'readwrite', store => reqP(store.put(book))).then(() => { changed(opts); return book; });
  },
  putMany(books, opts) {
    return tx('books', 'readwrite', store => Promise.all(books.map(b => reqP(store.put(b))))).then(r => { changed(opts); return r; });
  },
  // Salva il libro solo se esiste ancora. Controllo e scrittura avvengono nella stessa
  // transazione: un salvataggio rimandato non può far ricomparire un libro eliminato.
  putExisting(book, opts) {
    let done = false;
    return tx('books', 'readwrite', store => reqP(store.getKey(book.id)).then(key => {
      if (key === undefined) return;
      book.updatedAt = Date.now();
      done = true;
      return reqP(store.put(book));
    })).then(() => { if (done) changed(opts); return done; });
  },
  // Modifica la versione più recente del libro (non una copia rimasta in memoria), sempre
  // in un'unica transazione. Se il libro non c'è più, o fn restituisce false, non scrive nulla.
  update(id, fn, opts) {
    let saved = null;
    return tx('books', 'readwrite', store => reqP(store.get(id)).then(cur => {
      if (!cur || fn(cur) === false) return;
      cur.updatedAt = Date.now();
      saved = cur;
      return reqP(store.put(cur));
    })).then(() => { if (saved) changed(opts); return saved; });
  },
  // Elimina il libro e, se c'è, la sua copia digitale
  remove(id, opts) {
    return tx('books', 'readwrite', store => reqP(store.delete(id)))
      .then(() => tx('files', 'readwrite', store => reqP(store.delete(id))))
      .then(() => changed(opts));
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
