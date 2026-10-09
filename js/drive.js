// Integração com o Google Drive (escopo drive.file: o site só enxerga os arquivos que ele criou).
// Estrutura no Drive:  Meu Drive / Planejamento de Obras / Biblioteca.json, Obra - <nome>.json ...
import { GOOGLE_CLIENT_ID } from './config.js';
import * as store from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'GEPLAN - Planejamento de Obras';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'planobras:token';
const CONNECTED_KEY = 'planobras:driveConnected';
const CLIENT_KEY = 'planobras:clientId';

let tokenClient = null;
let syncing = false, again = false;
const statusListeners = new Set();
export const status = { state: 'local', message: '', user: null };

export const onStatus = (fn) => statusListeners.add(fn);
function setStatus(state, message = '') {
  status.state = state; status.message = message;
  statusListeners.forEach((fn) => fn(status));
}

export const clientId = () => localStorage.getItem(CLIENT_KEY) || GOOGLE_CLIENT_ID || '';
export const setClientId = (id) => { localStorage.setItem(CLIENT_KEY, id.trim()); tokenClient = null; };
export const isConnected = () => localStorage.getItem(CONNECTED_KEY) === '1';

function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.exp > Date.now() + 60000) return t.value;
  } catch {}
  return null;
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = () => rej(new Error('Sem conexão com o Google'));
    document.head.appendChild(s);
  });
}

async function requestToken(prompt) {
  if (!clientId()) throw new Error('Configure o Client ID do Google primeiro.');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ value: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 }));
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.message || 'Login cancelado')),
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

/**
 * Login com Google. Precisa ser chamado a partir de um clique (abre a janela do Google).
 * Retorna a conta ({displayName, emailAddress}); NÃO sincroniza — quem chama decide se a conta é autorizada.
 */
export async function signIn() {
  await requestToken('select_account');
  const about = await api(`${API}/about?fields=user(displayName,emailAddress)`);
  return about.user;
}

/** Marca a conta como conectada (depois de autorizada) e inicia a sincronização. */
export async function activate(user) {
  localStorage.setItem(CONNECTED_KEY, '1');
  status.user = user;
  localStorage.setItem('planobras:driveUser', JSON.stringify(user));
  await sync();
}

/** Sai da conta neste aparelho (esquece o acesso). `revoke` também cancela a permissão dada ao app no Google. */
export function disconnect({ revoke = false } = {}) {
  const t = getToken();
  if (revoke && t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(CONNECTED_KEY);
  localStorage.removeItem('planobras:driveUser');
  store.meta.folderId = null; store.meta.files = {}; store.meta.tombstones = []; store.meta.lastSync = 0;
  store.saveMeta();
  status.user = null;
  setStatus('local');
}

export function savedUser() {
  try { return JSON.parse(localStorage.getItem('planobras:driveUser') || 'null'); } catch { return null; }
}

class AuthError extends Error {}

async function api(url, opts = {}, raw = false) {
  const token = getToken();
  if (!token) throw new AuthError('Sessão do Google expirada');
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); throw new AuthError('Sessão do Google expirada'); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

async function ensureFolder() {
  const m = store.meta;
  if (m.folderId) {
    try {
      const f = await api(`${API}/files/${m.folderId}?fields=id,trashed`);
      if (!f.trashed) return m.folderId;
    } catch (e) { if (e instanceof AuthError) throw e; }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await api(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
  if (found.files?.length) m.folderId = found.files[0].id;
  else {
    const created = await api(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    m.folderId = created.id;
    m.files = {}; // pasta nova: tudo precisa subir de novo
  }
  store.saveMeta();
  return m.folderId;
}

const fileName = (doc) => doc.kind === 'biblioteca'
  ? 'Biblioteca (etapas e composições).json'
  : `Obra - ${doc.nome.replace(/[\\/:*?"<>|]/g, '-')}.json`;

async function upload(doc, fileId, folderId) {
  const metadata = {
    name: fileName(doc), mimeType: 'application/json',
    appProperties: { app: 'planobras', docId: doc.id, kind: doc.kind, updatedAt: String(doc.updatedAt) },
  };
  if (!fileId) metadata.parents = [folderId];
  const boundary = 'planobras' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
  const url = fileId ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`;
  const r = await api(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return r.id;
}

async function download(fileId) {
  const res = await api(`${API}/files/${fileId}?alt=media`, {}, true);
  return res.json();
}

/** Sincronização bidirecional: o documento com updatedAt mais recente vence. */
export async function sync({ interactive = false } = {}) {
  if (!isConnected()) { setStatus('local'); return; }
  if (!navigator.onLine) { setStatus('offline', 'Sem internet: alterações salvas no aparelho'); return; }
  if (!getToken()) {
    if (interactive) { await requestToken(''); }
    else { setStatus('auth', 'Clique para reconectar ao Google Drive'); return; }
  }
  if (syncing) { again = true; return; }
  syncing = true;
  setStatus('busy', 'Sincronizando…');
  let changedLocal = false;
  try {
    const m = store.meta;
    const folderId = await ensureFolder();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const list = await api(`${API}/files?q=${q}&fields=files(id,name,appProperties)&pageSize=1000&spaces=drive`);
    const remote = new Map();
    for (const f of list.files || []) {
      const p = f.appProperties || {};
      if (p.app === 'planobras' && p.docId) remote.set(p.docId, { fileId: f.id, updatedAt: Number(p.updatedAt) || 0, kind: p.kind });
    }

    // Exclusões feitas neste aparelho
    for (const t of [...m.tombstones]) {
      const r = remote.get(t.docId);
      const fid = r?.fileId || t.fileId;
      try { await api(`${API}/files/${fid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); }
      catch (e) { if (e instanceof AuthError) throw e; }
      remote.delete(t.docId);
      m.tombstones = m.tombstones.filter((x) => x !== t);
    }

    // Remoto → local
    for (const [docId, r] of remote) {
      const local = store.allDocs().find((d) => d.id === docId);
      if (!local || r.updatedAt > local.updatedAt) {
        const doc = await download(r.fileId);
        doc.updatedAt = r.updatedAt;
        store.putDoc(doc);
        changedLocal = true;
      } else if (local.updatedAt > r.updatedAt) {
        await upload(local, r.fileId, folderId);
      }
      m.files[docId] = { fileId: r.fileId, syncedUpdatedAt: Math.max(r.updatedAt, local?.updatedAt || 0) };
    }

    // Local sem arquivo remoto
    for (const doc of store.allDocs()) {
      if (remote.has(doc.id)) continue;
      if (doc.kind === 'biblioteca' && doc.updatedAt === 0) continue;
      const known = m.files[doc.id];
      if (known?.fileId && doc.kind === 'obra' && doc.updatedAt <= known.syncedUpdatedAt) {
        // Foi excluída em outro aparelho
        store.removeLocal(doc.id);
        delete m.files[doc.id];
        changedLocal = true;
        continue;
      }
      const fileId = await upload(doc, null, folderId);
      m.files[doc.id] = { fileId, syncedUpdatedAt: doc.updatedAt };
    }

    m.lastSync = Date.now();
    store.saveMeta();
    setStatus('ok', 'Sincronizado com o Google Drive');
  } catch (e) {
    if (e instanceof AuthError) setStatus('auth', 'Clique para reconectar ao Google Drive');
    else setStatus('error', 'Erro ao sincronizar: ' + e.message);
  } finally {
    syncing = false;
  }
  if (changedLocal) window.dispatchEvent(new CustomEvent('planobras:remote-change'));
  if (again) { again = false; return sync(); }
}

let timer = null;
export function scheduleSync() {
  if (!isConnected()) return;
  setStatus(navigator.onLine ? 'pending' : 'offline', navigator.onLine ? 'Alterações a enviar' : 'Sem internet: alterações salvas no aparelho');
  clearTimeout(timer);
  timer = setTimeout(() => sync(), 2500);
}

let started = false;
export function init() {
  if (started) return;
  started = true;
  status.user = savedUser();
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => isConnected() && setStatus('offline', 'Sem internet: alterações salvas no aparelho'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  store.onChange(() => scheduleSync());
  if (isConnected()) sync(); else setStatus('local');
}
