// Collegamento a Google Drive, direttamente dal telefono: nessun server intermedio.
//
// Accesso: Google Identity Services, "token model". Google rilascia un permesso
// temporaneo (access token, circa un'ora), poi lo rinnova in silenzio finché resti
// collegato al tuo account Google nel browser.
//
// Autorizzazioni richieste, le più ristrette possibili:
//   drive.appdata  una cartella nascosta riservata a Scaffale (elenco e copertine)
//   drive.file     solo i file che Scaffale stessa crea (i PDF/EPUB che carichi)
// Scaffale non può vedere nient'altro del tuo Drive.

const GSI_URL = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.file',
  'openid', 'email',
].join(' ');

const LS_CLIENT = 'driveClientId';
const LS_EMAIL = 'driveEmail';
const LS_ON = 'driveEnabled';
const LS_TOKEN = 'driveToken';

// Client ID integrato nell'app (facoltativo): con questo valorizzato, chi installa
// Scaffale vede subito «Accedi con Google» senza configurare nulla.
export const BUILTIN_CLIENT_ID = '';

const ls = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* niente */ } },
};

export class DriveError extends Error {
  constructor(message, status, reason) { super(message); this.status = status; this.reason = reason; }
}

let token = null;   // { value, exp }
let tokenClient = null;
let gsiPromise = null;
let pending = null;
let waiting = null; // { resolve, reject, timer } della richiesta in corso

// Il permesso viene conservato fino alla scadenza: riaprendo l'app entro l'ora
// la sincronizzazione riparte da sola, senza chiedere nulla
try {
  const saved = JSON.parse(localStorage.getItem(LS_TOKEN) || 'null');
  if (saved && saved.value && saved.exp > Date.now() + 60000) token = saved;
} catch (e) { /* niente */ }
function saveToken(t) {
  token = t;
  ls.set(LS_TOKEN, t ? JSON.stringify(t) : '');
}

export function getClientId() { return ls.get(LS_CLIENT) || BUILTIN_CLIENT_ID; }
export function getStoredClientId() { return ls.get(LS_CLIENT); }
export function setClientId(id) { ls.set(LS_CLIENT, (id || '').trim()); tokenClient = null; saveToken(null); }
export function isValidClientId(id) { return /^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test((id || '').trim()); }
export function isEnabled() { return ls.get(LS_ON) === '1' && !!getClientId(); }
export function accountEmail() { return ls.get(LS_EMAIL); }
export function hasToken() { return !!(token && Date.now() < token.exp - 60000); }
export function tokenExpiry() { return token ? token.exp : 0; }

function loadGsi() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI_URL; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gsiPromise = null; reject(new DriveError('Non riesco a contattare Google: controlla la connessione', 0, 'offline')); };
      document.head.appendChild(s);
    });
  }
  return gsiPromise;
}

// Prepara in anticipo il client di Google (script e configurazione): così, al tocco,
// la finestra di accesso si apre subito. I browser bloccano le finestre che si aprono
// troppo tempo dopo il tocco.
export async function prepare() {
  if (tokenClient) return tokenClient;
  const clientId = getClientId();
  if (!clientId) throw new DriveError('Manca l\'ID client di Google', 0, 'noclient');
  await loadGsi();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    prompt: '',
    include_granted_scopes: true,
    callback: resp => {
      const w = waiting; waiting = null;
      if (!w) return;
      clearTimeout(w.timer);
      if (resp.error) {
        w.reject(new DriveError(resp.error_description || resp.error, 401, resp.error === 'access_denied' ? 'denied' : 'auth'));
        return;
      }
      const scopes = resp.scope || '';
      if (!scopes.includes('drive.appdata') || !scopes.includes('drive.file')) {
        w.reject(new DriveError('Per sincronizzare servono entrambe le autorizzazioni su Drive: riprova e lascia le caselle selezionate.', 403, 'scopes'));
        return;
      }
      saveToken({ value: resp.access_token, exp: Date.now() + (resp.expires_in || 3600) * 1000 });
      w.resolve(token.value);
    },
    error_callback: err => {
      const w = waiting; waiting = null;
      if (!w) return;
      clearTimeout(w.timer);
      const reason = err && err.type === 'popup_closed' ? 'closed' : err && err.type === 'popup_failed_to_open' ? 'popup' : 'auth';
      w.reject(new DriveError(
        reason === 'closed' ? 'Hai chiuso la finestra di Google prima di finire'
          : reason === 'popup' ? 'Il browser ha bloccato la finestra di Google: tocca di nuovo, oppure consenti le finestre popup per questo sito'
            : 'Accesso a Google non riuscito', 401, reason));
    },
  });
  return tokenClient;
}

// Apre la finestra di Google: va chiamata dentro un tocco dell'utente
function requestToken() {
  if (pending) return pending;
  pending = (async () => {
    if (!tokenClient) await prepare(); // se lo script non era pronto la finestra potrebbe essere bloccata
    return new Promise((resolve, reject) => {
      waiting = {
        resolve, reject,
        timer: setTimeout(() => { waiting = null; reject(new DriveError('Google non ha risposto: riprova', 0, 'timeout')); }, 180000),
      };
      try {
        tokenClient.requestAccessToken({ prompt: '', login_hint: accountEmail() || undefined });
      } catch (err) {
        clearTimeout(waiting.timer); waiting = null;
        reject(new DriveError(err.message, 401, 'auth'));
      }
    });
  })().finally(() => { pending = null; });
  return pending;
}

// Restituisce il permesso valido; interactive = true solo dentro un tocco.
// minValid: per i trasferimenti lunghi chiedo subito un permesso nuovo se quello attuale
// scade prima di quel tempo, altrimenti il trasferimento si fermerebbe a metà.
export async function ensureToken(interactive, minValid = 60000) {
  if (token && Date.now() < token.exp - minValid) return token.value;
  if (!interactive) {
    if (hasToken()) return token.value;
    throw new DriveError('Serve di nuovo l\'accesso a Google', 401, 'login');
  }
  return requestToken();
}

async function getToken() {
  return ensureToken(false);
}

// Accesso con la finestra di Google: da chiamare SOLO dentro un tocco dell'utente
export async function signIn() {
  await requestToken();
  ls.set(LS_ON, '1');
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token.value } });
    if (r.ok) ls.set(LS_EMAIL, (await r.json()).email || '');
  } catch (e) { /* l'indirizzo email è solo un'etichetta */ }
  return accountEmail();
}

export function signOut() {
  if (token && window.google && google.accounts) {
    try { google.accounts.oauth2.revoke(token.value, () => {}); } catch (e) { /* niente */ }
  }
  saveToken(null);
  ls.set(LS_ON, '');
  ls.set(LS_EMAIL, '');
}

// ---------------------------------------------------------------- richieste
async function call(url, opts = {}, retry = true) {
  const t = await getToken();
  const headers = { ...(opts.headers || {}), Authorization: 'Bearer ' + t };
  let r;
  try {
    r = await fetch(url, { ...opts, headers });
  } catch (err) {
    throw new DriveError('Connessione a Google Drive non riuscita', 0, 'offline');
  }
  if (r.status === 401) { saveToken(null); throw new DriveError('Serve di nuovo l\'accesso a Google', 401, 'login'); }
  if ((r.status === 429 || r.status >= 500) && retry) {
    await new Promise(res => setTimeout(res, 800 + Math.random() * 600));
    return call(url, opts, false);
  }
  if (!r.ok) {
    let reason = '', message = `Errore ${r.status} da Google Drive`;
    try {
      const j = await r.json();
      const e = j.error || {};
      message = e.message || message;
      reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    } catch (e) { /* corpo non JSON */ }
    if (/storageQuotaExceeded/i.test(reason)) message = 'Il tuo Google Drive è pieno';
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason + message)) message = 'L\'API di Google Drive non è abilitata nel progetto Google: abilitala dalla console';
    throw new DriveError(message, r.status, reason);
  }
  return r;
}
const json = async (url, opts) => (await call(url, opts)).json();
const q = s => encodeURIComponent(s);

// ---------------------------------------------------------------- cartella nascosta
export async function listAppFiles() {
  let files = [], pageToken = '';
  do {
    const j = await json(`${API}/files?spaces=appDataFolder&pageSize=1000&fields=${q('nextPageToken,files(id,name,modifiedTime,size)')}${pageToken ? '&pageToken=' + q(pageToken) : ''}`);
    files = files.concat(j.files || []);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function readText(id) { return (await call(`${API}/files/${id}?alt=media`)).text(); }
export async function readBlob(id) { return (await call(`${API}/files/${id}?alt=media`)).blob(); }

// Crea o aggiorna un file piccolo (caricamento "multipart": dati e contenuto in una sola richiesta)
export async function writeFile({ id, name, parents, mimeType, data }) {
  const meta = id ? {} : { name, mimeType, ...(parents ? { parents } : {}) };
  const boundary = 'scaffale' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, data, `\r\n--${boundary}--`,
  ]);
  const url = id
    ? `${UPLOAD}/files/${id}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`;
  return json(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
}

export async function deleteFile(id) {
  try { await call(`${API}/files/${id}`, { method: 'DELETE' }); }
  catch (err) { if (err.status !== 404) throw err; } // già eliminato: va bene così
}

// I PDF/EPUB vanno nel cestino di Drive, non eliminati per sempre: restano recuperabili
export async function trashFile(id) {
  try {
    await call(`${API}/files/${id}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
  } catch (err) { if (err.status !== 404) throw err; }
}

// ---------------------------------------------------------------- cartella «Scaffale»
// Con drive.file l'app vede solo le cartelle che ha creato lei: se la cartella non
// c'è (o l'hai cancellata) ne crea una nuova.
let folderPromise = null;
export function bookFolder() {
  if (!folderPromise) {
    folderPromise = (async () => {
      const j = await json(`${API}/files?q=${q("name = 'Scaffale' and mimeType = 'application/vnd.google-apps.folder' and trashed = false")}&fields=files(id)&spaces=drive`);
      if (j.files && j.files.length) return j.files[0].id;
      const created = await json(`${API}/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Scaffale', mimeType: 'application/vnd.google-apps.folder' }),
      });
      return created.id;
    })().catch(err => { folderPromise = null; throw err; });
  }
  return folderPromise;
}

export async function fileInfo(id) {
  try { return await json(`${API}/files/${id}?fields=${q('id,name,size,trashed,md5Checksum')}`); }
  catch (err) { if (err.status === 404) return null; throw err; }
}

// Caricamento "riprendibile": Google restituisce un indirizzo di sessione su cui si
// inviano i byte. XMLHttpRequest serve a seguire l'avanzamento (fetch non lo permette).
export async function uploadBook({ blob, name, mimeType, onProgress, signal }) {
  const parent = await bookFolder();
  const start = await call(`${UPLOAD}/files?uploadType=resumable&fields=id,size`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify({ name, mimeType, parents: [parent] }),
  });
  const session = start.headers.get('Location');
  if (!session) throw new DriveError('Google Drive non ha avviato il caricamento', 0, 'upload');
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', session);
    x.setRequestHeader('Content-Type', mimeType);
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) {
        try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new DriveError('Risposta di Drive non valida', x.status, 'upload')); }
      } else if (x.status === 403 && /storageQuotaExceeded/.test(x.responseText)) {
        reject(new DriveError('Il tuo Google Drive è pieno', 403, 'storageQuotaExceeded'));
      } else {
        reject(new DriveError(`Caricamento interrotto (errore ${x.status})`, x.status, 'upload'));
      }
    };
    x.onerror = () => reject(new DriveError('Connessione persa durante il caricamento', 0, 'offline'));
    x.onabort = () => reject(new DriveError('Caricamento annullato', 0, 'aborted'));
    if (signal) signal.addEventListener('abort', () => x.abort());
    x.send(blob);
  });
}

export async function downloadBook(id, { onProgress, signal } = {}) {
  const t = await getToken();
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', `${API}/files/${id}?alt=media`);
    x.setRequestHeader('Authorization', 'Bearer ' + t);
    x.responseType = 'blob';
    x.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      if (x.status === 200) resolve(x.response);
      else if (x.status === 404) reject(new DriveError('Il file non è più su Google Drive', 404, 'notFound'));
      else if (x.status === 401) { saveToken(null); reject(new DriveError('Serve di nuovo l\'accesso a Google', 401, 'login')); }
      else reject(new DriveError(`Scaricamento interrotto (errore ${x.status})`, x.status, 'download'));
    };
    x.onerror = () => reject(new DriveError('Connessione persa durante lo scaricamento', 0, 'offline'));
    x.onabort = () => reject(new DriveError('Scaricamento annullato', 0, 'aborted'));
    if (signal) signal.addEventListener('abort', () => x.abort());
    x.send();
  });
}
