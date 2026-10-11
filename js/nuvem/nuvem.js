// Modo nuvem: o banco (Supabase) é a fonte oficial dos dados. O aparelho guarda uma cópia de trabalho
// (para abrir rápido e continuar funcionando sem internet) e envia as alterações automaticamente.
import * as store from '../store.js';
import { enviarObra, enviarBiblioteca, baixarEmpresa, arquivarObra, diferencas, podeGravar, TABELAS_BIBLIOTECA } from './sincronizar.js';
import { obraParaLinhas, bibliotecaParaLinhas, TABELAS_OBRA, converterIds } from './mapa.js';
import { banco } from './conta.js';

const CHAVE = 'planobras:nuvem:v1';
const CHAVE_ANTES = 'planobras:antes-da-nuvem';   // cópia dos dados do aparelho/Drive antes de entrar na nuvem

export const status = { state: 'local', message: '' };
const ouvintes = new Set();
export const onStatus = (fn) => ouvintes.add(fn);
const setStatus = (state, message = '') => { Object.assign(status, { state, message }); ouvintes.forEach((f) => f(status)); };

let ctx = null;          // { userId, email, orgId, orgNome, papel }
let snaps = {};          // fotografias da última versão confirmada pelo banco (por obra + biblioteca)
let timer = null, enviando = null, deNovo = false, intervalo = null, ligado = false;

const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || null; } catch { return null; } };
const gravar = () => { try { localStorage.setItem(CHAVE, JSON.stringify({ ctx, snaps })); } catch {} };

export const contexto = () => ctx;
/** Última empresa usada neste aparelho (para abrir sem internet). */
export const contextoSalvo = () => ler()?.ctx || null;
export const ativo = () => !!ctx;

/** Há alterações locais (que este papel pode gravar) ainda não confirmadas pelo banco? */
export function pendente() {
  if (!ctx) return false;
  const filtra = (d) => Object.keys(d).some((t) => podeGravar(ctx.papel, t));
  if (filtra(diferencas(bibliotecaParaLinhas(store.lib(), ctx.orgId), snaps.biblioteca, TABELAS_BIBLIOTECA))) return true;
  const ids = new Set(store.obras().map((o) => o.id));
  if (Object.keys(snaps).some((k) => k !== 'biblioteca' && !ids.has(k)) && ctx.papel === 'admin') return true;
  return store.obras().some((o) => filtra(diferencas(obraParaLinhas(o, ctx.orgId), snaps[o.id], TABELAS_OBRA)));
}

/** Entra numa empresa: guarda os dados que já estavam no aparelho, baixa os da empresa e liga o envio automático. */
export async function iniciar(novoCtx) {
  const anterior = ler();
  const mesmaEmpresa = anterior?.ctx?.orgId === novoCtx.orgId && anterior?.ctx?.userId === novoCtx.userId;
  if (!mesmaEmpresa && !anterior && store.obras().length && !localStorage.getItem(CHAVE_ANTES)) {
    try { localStorage.setItem(CHAVE_ANTES, store.exportAll()); } catch {}
  }
  ctx = novoCtx;
  snaps = mesmaEmpresa ? anterior.snaps || {} : {};
  gravar();
  if (mesmaEmpresa && pendente()) await enviar().catch(() => {});   // alterações feitas sem internet
  await baixar();
  if (!ligado) {
    ligado = true;
    store.onChange(() => { if (ctx) agendar(); });
    window.addEventListener('online', () => ctx && agendar(200));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualizar(); });
  }
  clearInterval(intervalo);
  intervalo = setInterval(atualizar, 120000);
}

/** Sai do modo nuvem neste aparelho (não apaga nada no banco). */
export function encerrar() {
  clearTimeout(timer); clearInterval(intervalo);
  ctx = null; snaps = {};
  try { localStorage.removeItem(CHAVE); } catch {}
  setStatus('local');
}

/** Baixa tudo da empresa e substitui a cópia de trabalho do aparelho. */
export async function baixar() {
  if (!ctx) return;
  setStatus('busy', 'Carregando dados da empresa…');
  try {
    const r = await baixarEmpresa(await banco(), ctx.orgId, ctx.papel);
    store.carregarDaNuvem(r.lib, r.obras);
    snaps = r.snaps;
    gravar();
    setStatus('ok', 'Salvo na nuvem');
    window.dispatchEvent(new Event('planobras:remote-change'));
  } catch (e) {
    setStatus(navigator.onLine ? 'error' : 'offline', e.message);
    throw e;
  }
}

function agendar(ms = 1200) {
  clearTimeout(timer);
  setStatus(navigator.onLine ? 'pending' : 'offline', navigator.onLine ? 'Enviando…' : 'Sem internet: as alterações serão enviadas depois');
  timer = setTimeout(() => enviar().catch(() => {}), ms);
}

/** Envia as alterações (biblioteca, obras, obras arquivadas). Seguro para chamar várias vezes. */
export async function enviar() {
  if (!ctx) return;
  if (enviando) { deNovo = true; return enviando; }
  if (!navigator.onLine) { setStatus('offline', 'Sem internet: as alterações serão enviadas depois'); return; }
  enviando = (async () => {
    setStatus('busy', 'Enviando…');
    const b = await banco();
    const avisos = new Set();
    let recusadas = 0;
    try {
      const rb = await enviarBiblioteca(b, store.lib(), ctx.orgId, ctx.papel, snaps.biblioteca);
      snaps.biblioteca = rb.snap; gravar();
      for (const o of store.obras()) {
        try {
          const r = await enviarObra(b, o, ctx.orgId, ctx.papel, snaps[o.id]);
          snaps[o.id] = r.snap; gravar();
          r.ignorados.forEach((t) => avisos.add(t));
          recusadas += r.recusadas;
        } catch (e) {
          if (e.snap) { snaps[o.id] = e.snap; gravar(); }
          throw new Error(`Obra "${o.nome}": ${e.message}`);
        }
      }
      const ids = new Set(store.obras().map((o) => o.id));
      for (const id of Object.keys(snaps)) {
        if (id === 'biblioteca' || ids.has(id)) continue;
        if (ctx.papel === 'admin') await arquivarObra(b, id);
        delete snaps[id]; gravar();
      }
      setStatus('ok', 'Salvo na nuvem');
      // O que o perfil não pode gravar não fica divergente no aparelho: volta ao que está no banco.
      if (avisos.size) {
        if (recusadas) window.dispatchEvent(new CustomEvent('geplan:aviso', { detail: `${recusadas} alteração(ões) não permitidas ao seu perfil foram desfeitas (${[...avisos].join(', ')}).` }));
        if (!document.getElementById('dlg')?.open) await baixar().catch(() => {});
      }
    } catch (e) {
      setStatus(navigator.onLine ? 'error' : 'offline', e.message);
      throw e;
    } finally {
      enviando = null;
      if (deNovo) { deNovo = false; agendar(300); }
    }
  })();
  return enviando;
}

/** Atualiza com o que outras pessoas gravaram (só quando não há alterações locais nem diálogo aberto). */
export async function atualizar() {
  if (!ctx || enviando || !navigator.onLine) return;
  if (document.getElementById('dlg')?.open) return;
  if (pendente()) return agendar(100);
  await baixar().catch(() => {});
}

/* ---------- dados que estavam no aparelho antes da nuvem ---------- */
export function dadosAnteriores() {
  try {
    const d = JSON.parse(localStorage.getItem(CHAVE_ANTES) || 'null');
    return d ? { obras: Object.values(d.obras || {}), biblioteca: d.biblioteca } : null;
  } catch { return null; }
}

/**
 * Envia para a empresa as obras e a biblioteca que estavam no aparelho (modo Google Drive). Os ids antigos
 * viram UUID; composições e modelos entram na biblioteca da empresa (sem apagar os que já existem).
 */
export async function enviarDadosAnteriores() {
  const d = dadosAnteriores();
  if (!d || !ctx) return 0;
  const lib = d.biblioteca || { composicoes: [], modelosEAP: [], feriadosGlobais: [] };
  converterIds(lib, d.obras);
  const atual = store.lib();
  const tem = (arr, x) => arr.some((y) => y.id === x.id);
  for (const c of lib.composicoes || []) if (!tem(atual.composicoes, c)) atual.composicoes.push(c);
  for (const m of lib.modelosEAP || []) if (!tem(atual.modelosEAP, m)) atual.modelosEAP.push(m);
  for (const f of lib.feriadosGlobais || []) if (!atual.feriadosGlobais.some((x) => x.data === f.data)) atual.feriadosGlobais.push(f);
  if (!atual.modeloPadraoId && lib.modeloPadraoId) atual.modeloPadraoId = lib.modeloPadraoId;
  store.touch(atual, { silent: true });
  for (const o of d.obras) store.addObraSilenciosa(o);
  await enviar();
  localStorage.setItem(CHAVE_ANTES + ':enviado', new Date().toISOString());
  return d.obras.length;
}
export const dadosAnterioresEnviados = () => !!localStorage.getItem(CHAVE_ANTES + ':enviado');
