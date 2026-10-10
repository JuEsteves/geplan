// Armazenamento local (fonte offline). O Google Drive é sincronizado por drive.js.
// Documentos: a biblioteca (composições, feriados gerais, modelos de EAP) e uma obra por documento.
// Cada documento tem `updatedAt`, usado para decidir quem vence na sincronização.

import { uid, emptyLib, migrateLib, migrateObra, novaObra as criarObraVazia, renumerar } from './model.js';

export { uid };

const DATA_KEY = 'planobras:data:v1';
const META_KEY = 'planobras:meta:v1';

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

const data = readJSON(DATA_KEY, { biblioteca: emptyLib(), obras: {} });
data.biblioteca = migrateLib(data.biblioteca);
data.obras ||= {};
for (const id of Object.keys(data.obras)) data.obras[id] = migrateObra(data.obras[id], data.biblioteca);
export const meta = readJSON(META_KEY, { tombstones: [], files: {}, folderId: null, lastSync: 0, owner: null });

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);

function persist() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch (e) {
    alert('Não foi possível salvar no aparelho: ' + e.message);
  }
}
persist();
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

export function addObra(o) {
  data.obras[o.id] = o;
  touch(o);
  return o;
}

export function newObra({ nome, inicio }) {
  return addObra(criarObraVazia({ nome, inicio }));
}

/** Cópia da obra com novos ids (mantém orçamento, EAP, vínculos e dependências; zera o realizado). */
export function duplicateObra(src, nome = src.nome + ' (cópia)') {
  const copy = JSON.parse(JSON.stringify(src));
  const map = new Map();
  const novo = (old) => { const n = uid(); map.set(old, n); return n; };
  copy.id = uid(); copy.nome = nome; copy.linhaBase = null; copy.medicoes = []; copy.rdo = [];
  copy.eap.forEach((a) => { a.id = novo(a.id); a.pct = 0; a.inicioReal = ''; a.fimReal = ''; a.status = ''; });
  copy.eap.forEach((a) => { a.parentId = a.parentId ? map.get(a.parentId) : null; });
  copy.orcamento.forEach((it) => { it.id = novo(it.id); });
  copy.vinculos = copy.vinculos.map((v) => ({ ...v, id: uid(), itemId: map.get(v.itemId), atividadeId: map.get(v.atividadeId) })).filter((v) => v.itemId && v.atividadeId);
  copy.dependencias = copy.dependencias.map((d) => ({ ...d, id: uid(), atividadeId: map.get(d.atividadeId), predecessoraId: map.get(d.predecessoraId) })).filter((d) => d.atividadeId && d.predecessoraId);
  renumerar(copy);
  return addObra(copy);
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

/** Usado pela sincronização: substitui sem alterar updatedAt (migrando formatos antigos). */
export function putDoc(doc) {
  if (doc.kind === 'biblioteca') {
    data.biblioteca = migrateLib(doc);
    for (const id of Object.keys(data.obras)) data.obras[id] = migrateObra(data.obras[id], data.biblioteca);
  } else data.obras[doc.id] = migrateObra(doc, data.biblioteca);
  persist();
}
export function removeLocal(id) {
  delete data.obras[id];
  persist();
}

export function exportAll() {
  return JSON.stringify({ app: 'planejamento-de-obras', version: 2, exportedAt: new Date().toISOString(), ...data }, null, 2);
}
export function importAll(json) {
  const d = JSON.parse(json);
  if (!d.biblioteca || !d.obras) throw new Error('Arquivo inválido');
  data.biblioteca = migrateLib(d.biblioteca);
  data.obras = {};
  for (const [id, o] of Object.entries(d.obras)) data.obras[id] = migrateObra(o, data.biblioteca);
  const now = Date.now();
  allDocs().forEach((doc) => { doc.updatedAt = now; });
  persist();
  listeners.forEach((fn) => fn(null));
}

/** Apaga os dados deste aparelho (usado ao sair ou ao trocar de conta). Os dados no Drive não são tocados. */
export function clearLocal() {
  data.biblioteca = emptyLib();
  data.obras = {};
  Object.assign(meta, { tombstones: [], files: {}, folderId: null, lastSync: 0, owner: null });
  persist();
  saveMeta();
}

export function hasPending() {
  return allDocs().some((d) => d.updatedAt > (meta.files[d.id]?.syncedUpdatedAt || 0) && (d.kind === 'obra' || d.updatedAt > 0))
    || meta.tombstones.length > 0;
}
