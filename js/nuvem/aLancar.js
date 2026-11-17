// Medições aprovadas ainda não lançadas no Financeiro (view v_medicao_a_lancar, migração 0010).
// Entram no "comprometido" e na coluna "a lançar" dos custos. Só administrador, engenheiro e financeiro leem
// (o RLS do banco devolve vazio para os demais). Cache curto, recarregado em segundo plano.
import { configurado, sb, erroBanco } from './supabase.js';
import * as nuvem from './nuvem.js';
import { queueRender } from '../ui.js';

const PAPEIS = ['admin', 'engenheiro', 'financeiro'];
const porObra = new Map();
let em = 0, carregando = false;

async function carregar() {
  carregando = true;
  try {
    const c = await sb();
    const { data, error } = await c.from('v_medicao_a_lancar').select('project_id, phase_id, period_end, amount, contract_id');
    if (error) throw erroBanco(error, 'medições a lançar');
    porObra.clear();
    for (const r of data || []) {
      if (!porObra.has(r.project_id)) porObra.set(r.project_id, []);
      // doContrato: medição de um contrato de mão de obra (o valor já está no comprometido pelo contrato — migração 0015)
      porObra.get(r.project_id).push({ faseId: r.phase_id || null, data: r.period_end, valor: Number(r.amount) || 0, doContrato: !!r.contract_id });
    }
    queueRender();
  } catch (e) { console.warn(e.message); }
  em = Date.now(); carregando = false;
}

/** Valores a lançar da obra ([{ faseId, data, valor }]); vazio fora do modo nuvem ou sem acesso a valores. */
export function medicoesALancar(projectId) {
  if (!configurado() || !nuvem.ativo() || !PAPEIS.includes(nuvem.contexto()?.papel)) return [];
  if (!carregando && Date.now() - em > 60000) setTimeout(carregar);
  return porObra.get(projectId) || [];
}

/** Força recarregar (após aprovar boletim ou lançar despesas). */
export function invalidarALancar() { em = 0; }

/* ---------- Indiretos rateados (migração 0021) ----------
 * Parte dos lançamentos da EMPRESA rateada para a obra (ex.: salário do engenheiro supervisor entre Matriz e obras),
 * só o total por tipo de conta — sem nome nem valor individual. Cache por obra, recarregado a cada minuto. */
const rateio = new Map();   // projectId → { em, carregando, linhas }
async function carregarRateio(projectId) {
  const r = rateio.get(projectId) || { em: 0, linhas: [] };
  r.carregando = true; rateio.set(projectId, r);
  try {
    const c = await sb();
    const { data, error } = await c.rpc('indiretos_rateados', { p_project: projectId });
    if (error) throw erroBanco(error, 'indiretos rateados');
    r.linhas = (data || []).map((x) => ({ tipo: x.kind, total: Number(x.total) || 0, pago: Number(x.pago) || 0, lancamentos: Number(x.lancamentos) || 0 }));
    queueRender();
  } catch (e) { r.linhas = []; console.warn(e.message); }
  r.em = Date.now(); r.carregando = false;
}
/** { empresa, clienteDireto, pago, lancamentos } da obra, ou null fora do modo nuvem / sem acesso a valores. */
export function indiretosRateados(projectId) {
  if (!configurado() || !nuvem.ativo() || !PAPEIS.includes(nuvem.contexto()?.papel)) return null;
  const r = rateio.get(projectId);
  if (!r || (!r.carregando && Date.now() - r.em > 60000)) setTimeout(() => carregarRateio(projectId));
  const linhas = r?.linhas || [];
  const soma = (f, campo) => Math.round(linhas.filter(f).reduce((s, x) => s + x[campo], 0) * 100) / 100;
  const daEmpresa = (x) => !['recursos_cliente', 'nao_operacional'].includes(x.tipo);
  return { empresa: soma(daEmpresa, 'total'), pago: soma(daEmpresa, 'pago'), clienteDireto: soma((x) => x.tipo === 'recursos_cliente', 'total'),
    lancamentos: linhas.reduce((s, x) => s + x.lancamentos, 0) };
}
