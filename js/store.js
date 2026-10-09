// Armazenamento local (fonte offline). O Google Drive é sincronizado por drive.js.
// Documentos: a biblioteca (etapas + composições) e uma obra por documento.
// Cada documento tem `updatedAt`, usado para decidir quem vence na sincronização.

const DATA_KEY = 'planobras:data:v1';
const META_KEY = 'planobras:meta:v1';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function emptyLib() {
  return { id: 'biblioteca', kind: 'biblioteca', etapas: [], composicoes: [], updatedAt: 0 };
}

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

const data = readJSON(DATA_KEY, { biblioteca: emptyLib(), obras: {} });
if (!data.biblioteca) data.biblioteca = emptyLib();
if (!data.obras) data.obras = {};
export const meta = readJSON(META_KEY, { tombstones: [], files: {}, folderId: null, lastSync: 0 });

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);

function persist() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch (e) {
    alert('Não foi possível salvar no aparelho: ' + e.message);
  }
}
export function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}

export const lib = () => data.biblioteca;
export const obras = () => Object.values(data.obras).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
export const obra = (id) => data.obras[id];
export const allDocs = () => [data.biblioteca, ...Object.values(data.obras)];

/** Marca o documento como alterado, salva e avisa os ouvintes (auto-sync). */
export function touch(doc, { silent = false } = {}) {
  doc.updatedAt = Date.now();
  persist();
  if (!silent) listeners.forEach((fn) => fn(doc));
}

export function newObra({ nome, inicio }) {
  const o = {
    id: uid(), kind: 'obra', nome, inicio,
    calendario: { jornada: 8, dias: [1, 2, 3, 4, 5], feriados: [] },
    etapas: [], linhaBase: null, medicoes: [], dataStatus: null, updatedAt: 0,
  };
  data.obras[o.id] = o;
  touch(o);
  return o;
}

export function duplicateObra(src) {
  const map = new Map();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.nome = src.nome + ' (cópia)';
  copy.linhaBase = null;
  copy.medicoes = [];
  for (const e of copy.etapas) {
    const ne = uid(); map.set(e.id, ne); e.id = ne;
    for (const s of e.servicos) {
      const ns = uid(); map.set(s.id, ns); s.id = ns;
      s.pct = 0; s.inicioReal = ''; s.fimReal = '';
    }
  }
  for (const e of copy.etapas) for (const s of e.servicos) {
    s.preds = (s.preds || []).map((p) => ({ ...p, ref: map.get(p.ref) || p.ref }));
  }
  data.obras[copy.id] = copy;
  touch(copy);
  return copy;
}

export function deleteObra(id) {
  delete data.obras[id];
  const f = meta.files[id];
  if (f?.fileId) meta.tombstones.push({ docId: id, fileId: f.fileId });
  delete meta.files[id];
  saveMeta();
  persist();
  listeners.forEach((fn) => fn(null));
}

/** Usado pela sincronização: substitui sem alterar updatedAt. */
export function putDoc(doc) {
  if (doc.kind === 'biblioteca') data.biblioteca = doc;
  else data.obras[doc.id] = doc;
  persist();
}
export function removeLocal(id) {
  delete data.obras[id];
  persist();
}

export function exportAll() {
  return JSON.stringify({ app: 'planejamento-de-obras', version: 1, exportedAt: new Date().toISOString(), ...data }, null, 2);
}
export function importAll(json) {
  const d = JSON.parse(json);
  if (!d.biblioteca || !d.obras) throw new Error('Arquivo inválido');
  data.biblioteca = d.biblioteca;
  data.obras = d.obras;
  const now = Date.now();
  allDocs().forEach((doc) => { doc.updatedAt = now; });
  persist();
  listeners.forEach((fn) => fn(null));
}

export function hasPending() {
  return allDocs().some((d) => d.updatedAt > (meta.files[d.id]?.syncedUpdatedAt || 0) && (d.kind === 'obra' || d.updatedAt > 0))
    || meta.tombstones.length > 0;
}
