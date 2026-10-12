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
    const { data, error } = await c.from('v_medicao_a_lancar').select('project_id, phase_id, period_end, amount');
    if (error) throw erroBanco(error, 'medições a lançar');
    porObra.clear();
    for (const r of data || []) {
      if (!porObra.has(r.project_id)) porObra.set(r.project_id, []);
      porObra.get(r.project_id).push({ faseId: r.phase_id || null, data: r.period_end, valor: Number(r.amount) || 0 });
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
