// Motor de sincronização app ↔ banco. Compara o estado atual (obra/biblioteca mapeadas em linhas) com a última
// versão confirmada pelo banco (`snap`) e envia só as diferenças, na ordem que respeita as chaves estrangeiras.
//
// O acesso ao banco é feito por um "adaptador" com a interface abaixo (Supabase em produção — js/nuvem/supabase.js;
// PGlite nos testes — tests/db.js), para que o mesmo motor seja testado de verdade:
//   selecionar(tabela, { eq: {col: v}, in: {col: [..]}, ativos: bool }) → linhas
//   upsert(tabela, linhas) · inserir(tabela, linhas) · atualizar(tabela, patch, linhas) · remover(tabela, linhas)
//
// Permissões: o servidor (RLS) é quem decide. Aqui o papel só evita enviar o que certamente seria recusado
// (ex.: supervisor não envia o planejamento), para não travar a fila de envio.
import { obraParaLinhas, linhasParaObra, bibliotecaParaLinhas, linhasParaBiblioteca, TABELAS_OBRA, chaveLinha } from './mapa.js';

export const TABELAS_BIBLIOTECA = ['cost_compositions', 'composition_items', 'org_holidays', 'wbs_templates'];

/** Como tratar uma linha que sumiu do app. */
export const REMOCAO = {
  clients: 'manter', projects: 'logica', project_holidays: 'apagar', budget_items: 'logica', wbs_nodes: 'logica',
  activity_dependencies: 'apagar', budget_allocations: 'apagar', schedule_baselines: 'manter', schedule_baseline_items: 'manter',
  budget_versions: 'manter', activity_measurements: 'logica', daily_reports: 'logica', daily_report_crew: 'apagar',
  daily_report_activities: 'apagar', site_occurrences: 'apagar', contracts: 'logica', contract_amendments: 'logica',
  expenses: 'logica', payments: 'logica', project_history: 'manter',
  cost_compositions: 'apagar', composition_items: 'apagar', org_holidays: 'apagar', wbs_templates: 'apagar',
};
/** Tabelas que só recebem inclusões (histórico imutável). */
const SO_INCLUSAO = new Set(['budget_versions', 'project_history', 'schedule_baseline_items']);
/** Tabelas com exclusão lógica (deleted_at). */
export const COM_EXCLUSAO_LOGICA = new Set(Object.entries(REMOCAO).filter(([, m]) => m === 'logica').map(([t]) => t));

const AREA = {
  clients: 'cadastro', projects: 'cadastro', project_holidays: 'planejamento', budget_items: 'planejamento', wbs_nodes: 'planejamento',
  activity_dependencies: 'planejamento', budget_allocations: 'planejamento', schedule_baselines: 'planejamento',
  schedule_baseline_items: 'planejamento', budget_versions: 'planejamento', activity_measurements: 'execucao', daily_reports: 'execucao',
  daily_report_crew: 'execucao', daily_report_activities: 'execucao', site_occurrences: 'execucao', contracts: 'compras',
  contract_amendments: 'compras', expenses: 'financeiro', payments: 'financeiro', project_history: 'historico',
  cost_compositions: 'biblioteca', composition_items: 'biblioteca', org_holidays: 'biblioteca', wbs_templates: 'biblioteca',
};
const AREAS_DO_PAPEL = {
  admin: ['cadastro', 'planejamento', 'execucao', 'compras', 'financeiro', 'historico', 'biblioteca'],
  engenheiro: ['cadastro', 'planejamento', 'execucao', 'compras', 'financeiro', 'historico', 'biblioteca'],
  supervisor: ['execucao', 'historico'],
  financeiro: ['financeiro', 'compras', 'historico'],
  compras: ['compras', 'historico'],
  cliente: [],
};
export const podeGravar = (papel, tabela) => (AREAS_DO_PAPEL[papel] || []).includes(AREA[tabela]);
/** Papel pode ler custos internos (orçamento, contratos)? */
export const veCustos = (papel) => papel && papel !== 'cliente';

/* ---------- comparação ---------- */
const json = (r) => JSON.stringify(r, Object.keys(r).sort());

/** Fotografia (tabela → chave → JSON) das linhas, para comparar depois. */
export function fotografar(L, tabelas) {
  const snap = {};
  for (const t of tabelas) snap[t] = Object.fromEntries((L[t] || []).map((r) => [chaveLinha(t, r), json(r)]));
  return snap;
}

/** Diferenças por tabela: linhas novas, alteradas e removidas. */
export function diferencas(L, snap, tabelas) {
  const d = {};
  for (const t of tabelas) {
    const antes = snap?.[t] || {};
    const atual = new Map((L[t] || []).map((r) => [chaveLinha(t, r), r]));
    const novas = [], alteradas = [], removidas = [];
    for (const [k, r] of atual) {
      if (!(k in antes)) novas.push(r);
      else if (antes[k] !== json(r)) alteradas.push(r);
    }
    for (const k of Object.keys(antes)) if (!atual.has(k)) removidas.push(JSON.parse(antes[k]));
    if (novas.length || alteradas.length || removidas.length) d[t] = { novas, alteradas, removidas };
  }
  return d;
}

// Campos da atividade que o próprio banco recalcula a partir das medições (não contam como alteração recusada).
const DERIVADOS_DA_MEDICAO = ['pct', 'actual_start', 'actual_finish'];
/** Linhas ignoradas (sem permissão) que trazem mudança de verdade — não só o que o servidor já recalcula. */
function mudancasReais(t, x, snap) {
  const linhas = [...x.novas, ...x.alteradas];
  if (t !== 'wbs_nodes') return linhas.length + x.removidas.length;
  const sem = (r) => { const c = { ...r }; for (const k of DERIVADOS_DA_MEDICAO) delete c[k]; return json(c); };
  return x.removidas.length + linhas.filter((r) => {
    const antes = snap?.[t]?.[chaveLinha(t, r)];
    return !antes || sem(JSON.parse(antes)) !== sem(r);
  }).length;
}

/**
 * Envia as diferenças. Retorna { snap, enviados, ignorados, recusadas }. Se uma tabela falhar, para ali (as anteriores
 * ficam confirmadas no `snap` retornado em erro.snap) — a próxima tentativa recomeça do ponto certo.
 */
async function aplicar(banco, L, snap, tabelas, papel) {
  const novoSnap = structuredClone(snap || {});
  const dif = diferencas(L, snap, tabelas);
  const ignorados = [];
  let enviados = 0, recusadas = 0;
  for (const [t, x] of Object.entries(dif)) if (!podeGravar(papel, t)) recusadas += mudancasReais(t, x, snap);
  const confirmar = (t, linhas, remover = false) => {
    novoSnap[t] ||= {};
    for (const r of linhas) {
      const k = chaveLinha(t, r);
      if (remover) delete novoSnap[t][k]; else novoSnap[t][k] = json(r);
    }
  };
  try {
    // 1) Remoções, dos filhos para os pais (libera índices únicos antes de incluir de novo).
    for (const t of [...tabelas].reverse()) {
      const x = dif[t];
      if (!x?.removidas.length) continue;
      if (!podeGravar(papel, t)) { ignorados.push(t); continue; }
      const modo = REMOCAO[t];
      if (modo === 'apagar') await banco.remover(t, x.removidas);
      else if (modo === 'logica') await banco.atualizar(t, { deleted_at: new Date().toISOString() }, x.removidas);
      confirmar(t, x.removidas, true);
      enviados += x.removidas.length;
    }
    // 2) Inclusões e alterações, dos pais para os filhos.
    for (const t of tabelas) {
      const x = dif[t];
      if (!x || !(x.novas.length || x.alteradas.length)) continue;
      if (!podeGravar(papel, t)) { ignorados.push(t); continue; }
      if (SO_INCLUSAO.has(t)) {
        if (x.novas.length) await banco.inserir(t, x.novas);
        confirmar(t, x.novas);
        // alterações em histórico não são enviadas (registro imutável): a fotografia passa a refletir o app
        confirmar(t, x.alteradas);
      } else if (t === 'schedule_baselines') {
        // linha de base aprovada é imutável: só a marca "atual" muda. Desmarca antes de marcar (índice único).
        const ordem = (a, b) => Number(a.is_current) - Number(b.is_current);
        for (const r of [...x.alteradas].sort(ordem)) await banco.atualizar(t, { is_current: r.is_current }, [r]);
        if (x.novas.length) await banco.inserir(t, [...x.novas].sort(ordem));
        confirmar(t, [...x.alteradas, ...x.novas]);
      } else {
        let linhas = [...x.novas, ...x.alteradas];
        if (t === 'composition_items') linhas = linhas.sort((a, b) => Number(a.is_leader) - Number(b.is_leader));
        await banco.upsert(t, linhas);
        confirmar(t, linhas);
      }
      enviados += x.novas.length + x.alteradas.length;
    }
  } catch (e) {
    e.snap = novoSnap;
    throw e;
  }
  return { snap: novoSnap, enviados, ignorados: [...new Set(ignorados)], recusadas };
}

/* ---------- API ---------- */

/** Envia uma obra (inclui a primeira gravação). `snap` = fotografia da última sincronização da obra (ou null). */
export async function enviarObra(banco, obra, orgId, papel, snap) {
  return aplicar(banco, obraParaLinhas(obra, orgId), snap, TABELAS_OBRA, papel);
}

/** Envia a biblioteca da empresa (composições, feriados gerais, modelos de EAP). */
export async function enviarBiblioteca(banco, lib, orgId, papel, snap) {
  return aplicar(banco, bibliotecaParaLinhas(lib, orgId), snap, TABELAS_BIBLIOTECA, papel);
}

/** Arquiva (exclusão lógica) uma obra removida no app. Só o admin consegue (RLS). */
export async function arquivarObra(banco, obraId) {
  await banco.atualizar('projects', { deleted_at: new Date().toISOString() }, [{ id: obraId }]);
}

/**
 * Baixa todos os dados da empresa visíveis para o usuário. Retorna { lib, obras, snaps: {biblioteca, [obraId]} }.
 * As fotografias são geradas a partir dos documentos reconstruídos (mesmo formato do envio).
 */
export async function baixarEmpresa(banco, orgId, papel) {
  const sel = (t, filtro) => banco.selecionar(t, { ...filtro, ativos: COM_EXCLUSAO_LOGICA.has(t) });
  const Lb = {};
  if (veCustos(papel)) for (const t of TABELAS_BIBLIOTECA) Lb[t] = await sel(t, { eq: { org_id: orgId } });
  else for (const t of TABELAS_BIBLIOTECA) Lb[t] = [];
  const lib = linhasParaBiblioteca(Lb);

  const projetos = await sel('projects', { eq: { org_id: orgId } });
  const ids = projetos.map((p) => p.id);
  const porObra = Object.fromEntries(ids.map((id) => [id, { projects: [projetos.find((p) => p.id === id)] }]));
  if (ids.length) {
    const clientes = await sel('clients', { eq: { org_id: orgId } });
    for (const id of ids) porObra[id].clients = clientes;
    for (const t of TABELAS_OBRA) {
      if (t === 'projects' || t === 'clients') continue;
      const linhas = await sel(t, { in: { project_id: ids } });
      for (const id of ids) porObra[id][t] ||= [];
      for (const r of linhas) porObra[r.project_id]?.[t].push(r);
    }
  }
  const obras = ids.map((id) => linhasParaObra(porObra[id]));
  const snaps = { biblioteca: fotografar(bibliotecaParaLinhas(lib, orgId), TABELAS_BIBLIOTECA) };
  for (const o of obras) snaps[o.id] = fotografar(obraParaLinhas(o, orgId), TABELAS_OBRA);
  return { lib, obras, snaps };
}
