// Mapeamento entre os documentos do app (biblioteca e obras, formato v2) e as linhas das tabelas do banco
// (supabase/migrations). Funções puras: não acessam rede nem armazenamento — testadas em tests/db.js.
//
// Regras:
// - Cada coleção do app vira uma tabela; ids são UUID (os antigos são convertidos por converterIds).
// - Campos do app que não têm coluna própria vão para `extra` (jsonb) — nada é descartado.
// - Itens sem id (aditivos, pagamentos, equipe e serviços do diário, linhas de base) recebem um id na hora de
//   mapear (o objeto do app é alterado), para que as próximas sincronizações reconheçam a mesma linha.
import { toDay, toISO } from '../schedule.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ehUuid = (s) => typeof s === 'string' && UUID.test(s);
export const novoId = () => crypto.randomUUID();

const data = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const num = (x) => (x === '' || x == null || !isFinite(Number(x)) ? null : Number(x));
const num0 = (x) => num(x) ?? 0;
/** Arredonda para a escala da coluna (o banco é a referência de precisão: NUMERIC(p, casas)). */
const arr = (x, casas) => (x == null ? null : Math.round(x * 10 ** casas) / 10 ** casas);
const txt = (x) => (x == null ? '' : String(x));
/** Data/hora em ISO (o banco devolve em outro formato; o instante é o mesmo). */
// (sem valor → undefined: a coluna fica de fora e o banco usa o padrão, now())
const ts = (s) => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? d.toISOString() : undefined; };
const idDe = (obj) => (obj.id ||= novoId());
/** Separa as chaves conhecidas; o resto vai para `extra`. */
const resto = (obj, conhecidas) => {
  const r = {};
  for (const [k, v] of Object.entries(obj || {})) if (!conhecidas.has(k) && v !== undefined) r[k] = v;
  return r;
};

/* ======================================================================================
 * Conversão de ids antigos (não-UUID) para UUID, em toda a base local de uma vez
 * (biblioteca + obras), mantendo todas as referências entre registros.
 * ==================================================================================== */
export function converterIds(lib, obras) {
  const mapa = new Map();
  const novo = (id) => {
    if (id == null || id === '' || ehUuid(id)) return id;
    if (!mapa.has(id)) mapa.set(id, novoId());
    return mapa.get(id);
  };
  if (lib) {
    for (const c of lib.composicoes || []) { c.id = novo(c.id); for (const m of c.maoObra || []) m.id = novo(m.id); }
    for (const m of lib.modelosEAP || []) m.id = novo(m.id);
    if (lib.modeloPadraoId) lib.modeloPadraoId = novo(lib.modeloPadraoId);
  }
  for (const o of obras) {
    o.id = novo(o.id);
    for (const it of o.orcamento || []) { it.id = novo(it.id); if (it.composicaoId) it.composicaoId = novo(it.composicaoId); }
    for (const a of o.eap || []) {
      a.id = novo(a.id); a.parentId = a.parentId ? novo(a.parentId) : null;
      if (a.modeloId) a.modeloId = novo(a.modeloId);
    }
    for (const d of o.dependencias || []) { d.id = novo(d.id); d.atividadeId = novo(d.atividadeId); d.predecessoraId = novo(d.predecessoraId); }
    for (const v of o.vinculos || []) { v.id = novo(v.id); v.itemId = novo(v.itemId); v.atividadeId = novo(v.atividadeId); }
    for (const lb of [o.linhaBase, ...(o.linhasBase || [])].filter(Boolean)) {
      if (lb.id) lb.id = novo(lb.id);
      lb.itens = Object.fromEntries(Object.entries(lb.itens || {}).map(([k, v]) => [novo(k), v]));
    }
    for (const r of o.revisoesOrcamento || []) { r.id = novo(r.id); for (const i of r.itens || []) if (i.itemId) i.itemId = novo(i.itemId); }
    for (const m of o.medicoesAtiv || []) { m.id = novo(m.id); m.atividadeId = novo(m.atividadeId); }
    for (const d of o.diario || []) {
      d.id = novo(d.id);
      for (const s of d.servicos || []) if (s.atividadeId) s.atividadeId = novo(s.atividadeId);
      for (const x of d.ocorrencias || []) x.id = novo(x.id);
    }
    for (const k of o.compromissos || []) { k.id = novo(k.id); if (k.itemId) k.itemId = novo(k.itemId); }
    for (const d of o.despesas || []) {
      d.id = novo(d.id);
      if (d.compromissoId) d.compromissoId = novo(d.compromissoId);
      if (d.itemId) d.itemId = novo(d.itemId);
    }
    for (const h of o.historico || []) h.id = novo(h.id);
  }
  return mapa;
}

/* ======================================================================================
 * Biblioteca da empresa
 * ==================================================================================== */
const COMP_CONHECIDAS = new Set(['id', 'codigo', 'descricao', 'unidade', 'fonte', 'refSinapi', 'etapaEap', 'versao', 'ativa', 'obs', 'maoObra']);

export function bibliotecaParaLinhas(lib, orgId) {
  const L = { cost_compositions: [], composition_items: [], org_holidays: [], wbs_templates: [] };
  for (const c of lib.composicoes || []) {
    L.cost_compositions.push({
      id: c.id, org_id: orgId, code: txt(c.codigo), description: txt(c.descricao), unit: txt(c.unidade), source: txt(c.fonte),
      sinapi_ref: txt(c.refSinapi), wbs_stage: txt(c.etapaEap), version: Math.max(1, Math.round(num(c.versao) ?? 1)),
      active: c.ativa !== false, notes: txt(c.obs), extra: resto(c, COMP_CONHECIDAS),
    });
    (c.maoObra || []).forEach((m, i) => L.composition_items.push({
      id: idDe(m), composition_id: c.id, org_id: orgId, kind: 'mao_obra', description: txt(m.funcao), unit: 'h',
      coefficient: arr(num0(m.coef), 6), is_leader: !!m.lider, unit_price: null, position: i,
    }));
  }
  const vistos = new Set();
  for (const f of lib.feriadosGlobais || []) {
    const d = data(f.data);
    if (!d || vistos.has(d)) continue;
    vistos.add(d);
    L.org_holidays.push({ org_id: orgId, holiday_date: d, description: txt(f.desc) });
  }
  for (const m of lib.modelosEAP || []) {
    const { id, nome, ...content } = m;
    L.wbs_templates.push({ id, org_id: orgId, name: txt(nome), is_default: lib.modeloPadraoId === id, content });
  }
  return L;
}

export function linhasParaBiblioteca(L) {
  const itens = new Map();
  for (const m of [...(L.composition_items || [])].sort((a, b) => a.position - b.position)) {
    if (!itens.has(m.composition_id)) itens.set(m.composition_id, []);
    itens.get(m.composition_id).push({ id: m.id, funcao: m.description, coef: Number(m.coefficient), lider: !!m.is_leader });
  }
  const modelos = [...(L.wbs_templates || [])].sort((a, b) => txt(a.name).localeCompare(txt(b.name), 'pt-BR'));
  return {
    id: 'biblioteca', kind: 'biblioteca', schemaVersion: 2, updatedAt: 0,
    composicoes: [...(L.cost_compositions || [])].sort((a, b) => txt(a.code).localeCompare(txt(b.code), 'pt-BR', { numeric: true })).map((c) => ({
      ...(c.extra || {}),
      id: c.id, codigo: c.code, descricao: c.description, unidade: c.unit, fonte: c.source, refSinapi: c.sinapi_ref,
      etapaEap: c.wbs_stage, versao: c.version, ativa: c.active, obs: c.notes, maoObra: itens.get(c.id) || [],
    })),
    feriadosGlobais: [...(L.org_holidays || [])].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date)).map((f) => ({ data: f.holiday_date, desc: f.description })),
    modelosEAP: modelos.map((m) => ({ ...(m.content || {}), id: m.id, nome: m.name })),
    modeloPadraoId: modelos.find((m) => m.is_default)?.id || null,
  };
}

/* ======================================================================================
 * Obra
 * ==================================================================================== */
const OBRA_CONHECIDAS = new Set(['id', 'kind', 'schemaVersion', 'updatedAt', 'nome', 'inicio', 'jornada', 'eficiencia', 'calendario',
  'duracaoPadrao', 'orcamento', 'eap', 'dependencias', 'vinculos', 'linhaBase', 'linhasBase', 'codigo', 'cliente', 'endereco',
  'cidade', 'tipoEmpreendimento', 'engenheiro', 'crea', 'terminoPlanejado', 'inicioReal', 'valorContratado', 'status', 'bdi',
  'distribuicaoPadrao', 'pesoFisico', 'historico', 'revisoesOrcamento', 'medicoesAtiv', 'diario', 'compromissos', 'despesas']);
const ATIV_CONHECIDAS = new Set(['id', 'parentId', 'codigo', 'nivel', 'etapa', 'subetapa', 'descricao', 'tipo', 'equipe', 'duracaoManual',
  'inicioFixado', 'inicioReal', 'fimReal', 'pct', 'status', 'obs', 'predTexto', 'predManual', 'responsavel', 'equipeExecutora',
  'perfil', 'medicao', 'pesoManual', 'modeloId', 'modeloAtivId', 'modeloOrdem']);
const ITEM_CONHECIDAS = new Set(['id', 'codigo', 'etapa', 'subetapa', 'composicaoId', 'descricao', 'unidade', 'quantidade', 'custoUnit', 'obs']);
const BDI = ['ac', 's', 'r', 'g', 'df', 'l', 'i'];

/** Tabelas de uma obra, na ordem em que podem ser gravadas (pais antes dos filhos). */
export const TABELAS_OBRA = ['clients', 'projects', 'project_holidays', 'budget_items', 'wbs_nodes', 'activity_dependencies',
  'budget_allocations', 'schedule_baselines', 'schedule_baseline_items', 'budget_versions', 'activity_measurements',
  'daily_reports', 'daily_report_crew', 'daily_report_activities', 'site_occurrences', 'contracts', 'contract_amendments',
  'expenses', 'payments', 'project_history'];

export function obraParaLinhas(o, orgId) {
  const P = o.id;
  const L = Object.fromEntries(TABELAS_OBRA.map((t) => [t, []]));
  const itensIds = new Set((o.orcamento || []).map((i) => i.id));
  const ativIds = new Set((o.eap || []).map((a) => a.id));
  const ref = (id, ids) => (id && ids.has(id) ? id : null);

  // cliente (cadastro reaproveitável da empresa)
  const cli = o.cliente || {};
  let clientId = null;
  if (cli.id || [cli.nome, cli.contato, cli.telefone, cli.email].some((x) => txt(x).trim())) {
    clientId = idDe(cli);
    L.clients.push({ id: clientId, org_id: orgId, name: txt(cli.nome), contact: txt(cli.contato), phone: txt(cli.telefone), email: txt(cli.email) });
  }

  const cal = o.calendario || {};
  const bdi = o.bdi || {};
  const extra = resto(o, OBRA_CONHECIDAS);
  const calExtra = resto(cal, new Set(['dias', 'feriados', 'tipo']));
  if (Object.keys(calExtra).length) extra.calendarioExtra = calExtra;
  L.projects.push({
    id: P, org_id: orgId, client_id: clientId, code: txt(o.codigo), name: txt(o.nome) || 'Obra', status: o.status || 'Planejamento',
    project_type: txt(o.tipoEmpreendimento), address: txt(o.endereco), city: txt(o.cidade), technical_lead: txt(o.engenheiro),
    technical_registration: txt(o.crea), planned_start: data(o.inicio), planned_finish: data(o.terminoPlanejado),
    actual_start: data(o.inicioReal), contract_value: arr(num(o.valorContratado), 2), work_hours: arr(num(o.jornada) ?? 8.8, 2),
    efficiency: arr(num(o.eficiencia) ?? 0.85, 4), calendar_type: cal.tipo === 'corridos' ? 'corridos' : 'uteis',
    work_days: (cal.dias || [1, 2, 3, 4, 5]).map(Number), default_durations: o.duracaoPadrao || {},
    ...Object.fromEntries(BDI.map((k) => [`bdi_${k}`, arr(num0(bdi[k]), 4)])),
    distribution_profile: o.distribuicaoPadrao || 'linear', physical_weight: o.pesoFisico || 'hh', extra,
  });

  const ferVistos = new Set();
  for (const f of cal.feriados || []) {
    const d = data(f.data);
    if (!d || ferVistos.has(d)) continue;
    ferVistos.add(d);
    L.project_holidays.push({ project_id: P, holiday_date: d, description: txt(f.desc) });
  }

  (o.orcamento || []).forEach((it, i) => L.budget_items.push({
    id: it.id, project_id: P, code: txt(it.codigo), group_name: txt(it.etapa), subgroup_name: txt(it.subetapa),
    composition_id: it.composicaoId || null, description: txt(it.descricao), unit: txt(it.unidade),
    quantity: arr(num0(it.quantidade), 4), unit_cost: arr(num0(it.custoUnit), 4), notes: txt(it.obs), position: i,
    extra: resto(it, ITEM_CONHECIDAS),
  }));

  (o.eap || []).forEach((a, i) => L.wbs_nodes.push({
    id: a.id, project_id: P, parent_id: ref(a.parentId, ativIds), position: i, code: txt(a.codigo),
    level: Math.min(9, Math.max(1, Math.round(num(a.nivel) ?? 1))), stage: txt(a.etapa), substage: txt(a.subetapa),
    description: txt(a.descricao), node_type: a.tipo || 'Execução', crew: arr(num(a.equipe), 2), manual_duration: arr(num(a.duracaoManual), 2),
    fixed_start: data(a.inicioFixado), actual_start: data(a.inicioReal), actual_finish: data(a.fimReal),
    pct: arr(Math.min(100, Math.max(0, num0(a.pct))), 6), status: txt(a.status), notes: txt(a.obs), responsible: txt(a.responsavel),
    crew_name: txt(a.equipeExecutora), distribution_profile: a.perfil || null, measurement_method: a.medicao || null,
    manual_weight: arr(num(a.pesoManual), 4), pred_text: txt(a.predTexto), pred_manual: !!a.predManual,
    template_id: a.modeloId || null, template_node_id: a.modeloAtivId || null, template_order: arr(num(a.modeloOrdem), 4),
    extra: resto(a, ATIV_CONHECIDAS),
  }));

  for (const d of o.dependencias || []) {
    if (!ativIds.has(d.atividadeId) || !ativIds.has(d.predecessoraId)) continue;
    L.activity_dependencies.push({ id: d.id, project_id: P, activity_id: d.atividadeId, predecessor_id: d.predecessoraId,
      dep_type: ['FS', 'SS', 'FF', 'SF'].includes(d.tipo) ? d.tipo : 'FS', lag_days: Math.round(num0(d.lag)) });
  }
  for (const v of o.vinculos || []) {
    if (!itensIds.has(v.itemId) || !ativIds.has(v.atividadeId)) continue;
    L.budget_allocations.push({ id: v.id, project_id: P, budget_item_id: v.itemId, activity_id: v.atividadeId,
      share: arr(Math.min(1, Math.max(0, num0(v.pct))), 6) });
  }

  // linhas de base: a atual + as anteriores (histórico preservado)
  // (revisão sem número ou repetida — dados antigos — recebe o próximo número livre; a mais antiga fica com o menor)
  const bases = [o.linhaBase, ...(o.linhasBase || [])].filter(Boolean);
  const usadas = new Set();
  const semNumero = [];
  for (const b of [...bases].reverse()) {
    if (Number.isInteger(b.revisao) && !usadas.has(b.revisao)) usadas.add(b.revisao); else semNumero.push(b);
  }
  let prox = 0;
  for (const b of semNumero) { while (usadas.has(prox)) prox++; b.revisao = prox; usadas.add(prox); }
  for (const b of bases) {
    const id = idDe(b);
    L.schedule_baselines.push({ id, project_id: P, revision: b.revisao, approved_on: data(b.data) || data(o.inicio),
      finish_date: Number.isFinite(b.termino) ? toISO(b.termino) : data(b.termino), planned_cost: arr(num(b.custo), 2), is_current: b === o.linhaBase });
    for (const [aid, x] of Object.entries(b.itens || {})) {
      L.schedule_baseline_items.push({ baseline_id: id, project_id: P, activity_id: aid,
        start_date: Number.isFinite(x.inicio) ? toISO(x.inicio) : data(x.inicio), finish_date: Number.isFinite(x.termino) ? toISO(x.termino) : data(x.termino) });
    }
  }

  for (const r of o.revisoesOrcamento || []) {
    L.budget_versions.push({ id: idDe(r), project_id: P, name: txt(r.nome) || 'Revisão', created_at: ts(r.data),
      bdi: r.bdi || {}, items: r.itens || [], total_cost: Math.round(num0(r.custoTotal) * 100) / 100 });
  }

  for (const m of o.medicoesAtiv || []) {
    if (!ativIds.has(m.atividadeId)) continue;
    L.activity_measurements.push({ id: idDe(m), project_id: P, activity_id: m.atividadeId, ref_date: data(m.data),
      method: m.metodo === 'quantidade' ? 'quantidade' : 'percentual', qty_accum: arr(num(m.qtdAcum), 4), unit: txt(m.unidade),
      planned_qty: arr(num(m.qtdPlanejada), 4), pct: arr(Math.min(100, Math.max(0, num0(m.pct))), 6), notes: txt(m.obs),
      responsible_label: txt(m.responsavel), status: 'aprovada', created_at: ts(m.criadoEm) });
  }

  for (const d of o.diario || []) {
    const R = idDe(d);
    L.daily_reports.push({ id: R, project_id: P, report_date: data(d.data), weather_morning: txt(d.clima?.manha || 'Bom'),
      weather_afternoon: txt(d.clima?.tarde || 'Bom'), workable: d.praticavel !== false, materials: txt(d.materiais),
      equipment: txt(d.equipamentos), visits: txt(d.visitas), meetings: txt(d.reunioes), notes: txt(d.observacoes),
      responsible_label: txt(d.responsavel), created_at: ts(d.criadoEm) });
    (d.equipe || []).forEach((e, i) => L.daily_report_crew.push({ id: idDe(e), daily_report_id: R, project_id: P,
      role_name: txt(e.funcao), qty: Math.max(0, Math.round(num0(e.qtd))), position: i }));
    (d.servicos || []).forEach((s, i) => L.daily_report_activities.push({ id: idDe(s), daily_report_id: R, project_id: P,
      activity_id: ref(s.atividadeId, ativIds), description: txt(s.descricao), position: i }));
    (d.ocorrencias || []).forEach((x, i) => L.site_occurrences.push({ id: idDe(x), daily_report_id: R, project_id: P,
      occurrence_type: x.tipo || 'Ocorrência', description: txt(x.descricao), resolved: !!x.resolvida, position: i }));
  }

  const compIds = new Set((o.compromissos || []).map((k) => k.id));
  for (const k of o.compromissos || []) {
    L.contracts.push({ id: k.id, project_id: P, kind: String(k.tipo || '').startsWith('Pedido') ? 'Pedido' : 'Contrato',   // no app: "Pedido de compra" number: txt(k.numero),
      supplier_name: txt(k.fornecedor), category: k.categoria || 'Outro', amount: arr(num0(k.valor), 2), status: txt(k.status),
      contract_date: data(k.data), scope: txt(k.objeto), budget_item_id: ref(k.itemId, itensIds), needed_date: data(k.dataNecessaria),
      quantity: arr(num(k.quantidade), 4), unit: txt(k.unidade), quantity_received: arr(num(k.quantidadeRecebida), 4) });
    for (const a of k.aditivos || []) {
      L.contract_amendments.push({ id: idDe(a), contract_id: k.id, project_id: P, amend_date: data(a.data), amount: arr(num0(a.valor), 2), description: txt(a.descricao) });
    }
  }
  for (const d of o.despesas || []) {
    L.expenses.push({ id: d.id, project_id: P, expense_date: data(d.data), document: txt(d.documento), supplier_name: txt(d.fornecedor),
      description: txt(d.descricao), category: d.categoria || 'Outro', contract_id: ref(d.compromissoId, compIds),
      budget_item_id: ref(d.itemId, itensIds), amount: arr(num0(d.valor), 2), due_date: data(d.vencimento) });
    for (const p of d.pagamentos || []) {
      L.payments.push({ id: idDe(p), expense_id: d.id, project_id: P, pay_date: data(p.data), amount: arr(num0(p.valor), 2) });
    }
  }

  for (const h of o.historico || []) {
    L.project_history.push({ id: idDe(h), project_id: P, at: ts(h.em), user_label: txt(h.usuario), action: txt(h.acao), detail: txt(h.detalhe) });
  }
  return L;
}

/** Reconstrói a obra do app a partir das linhas (já filtradas pela obra e sem registros excluídos). */
export function linhasParaObra(L) {
  const p = L.projects[0];
  const por = (t, campo) => {
    const m = new Map();
    for (const r of L[t] || []) { if (!m.has(r[campo])) m.set(r[campo], []); m.get(r[campo]).push(r); }
    return m;
  };
  const ordem = (a, b) => (a.position ?? 0) - (b.position ?? 0);
  const cli = (L.clients || []).find((c) => c.id === p.client_id);
  const { calendarioExtra, ...extra } = p.extra || {};

  const bases = [...(L.schedule_baselines || [])].sort((a, b) => b.revision - a.revision);
  const itensBase = por('schedule_baseline_items', 'baseline_id');
  const base = (b) => ({
    id: b.id, data: b.approved_on, revisao: b.revision, custo: b.planned_cost == null ? null : Number(b.planned_cost),
    termino: b.finish_date ? toDay(b.finish_date) : null,
    itens: Object.fromEntries((itensBase.get(b.id) || []).map((x) => [x.activity_id, {
      inicio: x.start_date ? toDay(x.start_date) : null, termino: x.finish_date ? toDay(x.finish_date) : null }])),
  });
  const atual = bases.find((b) => b.is_current);

  const aditivos = por('contract_amendments', 'contract_id');
  const pagamentos = por('payments', 'expense_id');
  const crew = por('daily_report_crew', 'daily_report_id');
  const servs = por('daily_report_activities', 'daily_report_id');
  const ocs = por('site_occurrences', 'daily_report_id');
  const dataBR = (s) => s || '';

  return {
    ...extra,
    id: p.id, kind: 'obra', schemaVersion: 2, updatedAt: 0,
    nome: p.name, inicio: p.planned_start, jornada: Number(p.work_hours), eficiencia: Number(p.efficiency),
    calendario: { ...(calendarioExtra || {}), dias: (p.work_days || []).map(Number), tipo: p.calendar_type,
      feriados: [...(L.project_holidays || [])].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date)).map((f) => ({ data: f.holiday_date, desc: f.description })) },
    duracaoPadrao: p.default_durations || {},
    codigo: p.code, cliente: cli ? { id: cli.id, nome: cli.name, contato: cli.contact, telefone: cli.phone, email: cli.email } : { nome: '', contato: '', telefone: '', email: '' },
    endereco: p.address, cidade: p.city, tipoEmpreendimento: p.project_type, engenheiro: p.technical_lead, crea: p.technical_registration,
    terminoPlanejado: dataBR(p.planned_finish), inicioReal: dataBR(p.actual_start),
    valorContratado: p.contract_value == null ? null : Number(p.contract_value), status: p.status,
    bdi: Object.fromEntries(BDI.map((k) => [k, Number(p[`bdi_${k}`]) || 0])),
    distribuicaoPadrao: p.distribution_profile, pesoFisico: p.physical_weight,

    orcamento: [...(L.budget_items || [])].sort(ordem).map((r) => ({
      id: r.id, codigo: r.code, etapa: r.group_name, subetapa: r.subgroup_name, composicaoId: r.composition_id || '',
      descricao: r.description, unidade: r.unit, quantidade: Number(r.quantity), custoUnit: Number(r.unit_cost),
      ...(r.notes ? { obs: r.notes } : {}), ...(r.extra || {}),
    })),
    eap: [...(L.wbs_nodes || [])].sort(ordem).map((r) => {
      const a = {
        ...(r.extra || {}),
        id: r.id, parentId: r.parent_id || null, codigo: r.code, nivel: r.level, etapa: r.stage, subetapa: r.substage,
        descricao: r.description, tipo: r.node_type, equipe: r.crew == null ? null : Number(r.crew),
        duracaoManual: r.manual_duration == null ? null : Number(r.manual_duration), inicioFixado: dataBR(r.fixed_start),
        inicioReal: dataBR(r.actual_start), fimReal: dataBR(r.actual_finish), pct: Number(r.pct), status: r.status, obs: r.notes,
        predTexto: r.pred_text,
      };
      if (r.pred_manual) a.predManual = true;
      if (r.responsible) a.responsavel = r.responsible;
      if (r.crew_name) a.equipeExecutora = r.crew_name;
      if (r.distribution_profile) a.perfil = r.distribution_profile;
      if (r.measurement_method) a.medicao = r.measurement_method;
      if (r.manual_weight != null) a.pesoManual = Number(r.manual_weight);
      if (r.template_id) a.modeloId = r.template_id;
      if (r.template_node_id) a.modeloAtivId = r.template_node_id;
      if (r.template_order != null) a.modeloOrdem = Number(r.template_order);
      return a;
    }),
    dependencias: (L.activity_dependencies || []).map((d) => ({ id: d.id, atividadeId: d.activity_id, predecessoraId: d.predecessor_id, tipo: d.dep_type, lag: d.lag_days })),
    vinculos: (L.budget_allocations || []).map((v) => ({ id: v.id, itemId: v.budget_item_id, atividadeId: v.activity_id, pct: Number(v.share) })),
    linhaBase: atual ? base(atual) : null,
    linhasBase: bases.filter((b) => !b.is_current).map(base),
    revisoesOrcamento: [...(L.budget_versions || [])].sort((a, b) => txt(b.created_at).localeCompare(txt(a.created_at))).map((r) => ({
      id: r.id, nome: r.name, data: ts(r.created_at), bdi: r.bdi || {}, itens: r.items || [], custoTotal: Number(r.total_cost) })),
    medicoesAtiv: [...(L.activity_measurements || [])].sort((a, b) => a.ref_date.localeCompare(b.ref_date)).map((m) => ({
      id: m.id, atividadeId: m.activity_id, data: m.ref_date, metodo: m.method, qtdAcum: m.qty_accum == null ? null : Number(m.qty_accum),
      unidade: m.unit, qtdPlanejada: m.planned_qty == null ? null : Number(m.planned_qty), pct: Number(m.pct), obs: m.notes,
      responsavel: m.responsible_label, criadoEm: ts(m.created_at) })),
    diario: [...(L.daily_reports || [])].sort((a, b) => b.report_date.localeCompare(a.report_date)).map((d) => ({
      id: d.id, data: d.report_date, responsavel: d.responsible_label, clima: { manha: d.weather_morning, tarde: d.weather_afternoon },
      praticavel: d.workable, equipe: (crew.get(d.id) || []).sort(ordem).map((e) => ({ id: e.id, funcao: e.role_name, qtd: e.qty })),
      servicos: (servs.get(d.id) || []).sort(ordem).map((s) => ({ id: s.id, atividadeId: s.activity_id || null, descricao: s.description })),
      materiais: d.materials, equipamentos: d.equipment, visitas: d.visits, reunioes: d.meetings,
      ocorrencias: (ocs.get(d.id) || []).sort(ordem).map((x) => ({ id: x.id, tipo: x.occurrence_type, descricao: x.description, resolvida: x.resolved })),
      observacoes: d.notes, criadoEm: ts(d.created_at), atualizadoEm: ts(d.updated_at || d.created_at) })),
    compromissos: (L.contracts || []).map((k) => {
      const c = {
        id: k.id, tipo: k.kind === 'Pedido' ? 'Pedido de compra' : 'Contrato', numero: k.number, fornecedor: k.supplier_name, categoria: k.category, valor: Number(k.amount),
        status: k.status, data: dataBR(k.contract_date), objeto: k.scope, itemId: k.budget_item_id || null,
        aditivos: (aditivos.get(k.id) || []).map((a) => ({ id: a.id, data: dataBR(a.amend_date), valor: Number(a.amount), descricao: a.description })),
      };
      if (k.kind === 'Pedido') Object.assign(c, { dataNecessaria: dataBR(k.needed_date), quantidade: k.quantity == null ? null : Number(k.quantity), unidade: k.unit, quantidadeRecebida: k.quantity_received == null ? null : Number(k.quantity_received) });
      return c;
    }),
    despesas: (L.expenses || []).map((d) => ({
      id: d.id, data: d.expense_date, documento: d.document, fornecedor: d.supplier_name, descricao: d.description, categoria: d.category,
      compromissoId: d.contract_id || null, itemId: d.budget_item_id || null, valor: Number(d.amount), vencimento: dataBR(d.due_date),
      pagamentos: (pagamentos.get(d.id) || []).map((x) => ({ id: x.id, data: x.pay_date, valor: Number(x.amount) })),
    })),
    historico: [...(L.project_history || [])].sort((a, b) => txt(b.at).localeCompare(txt(a.at))).map((h) => ({
      id: h.id, em: ts(h.at), usuario: h.user_label, acao: h.action, detalhe: h.detail })),
  };
}

/** Chave de cada linha (para comparar com a última versão enviada). */
export function chaveLinha(tabela, r) {
  if (tabela === 'project_holidays') return `${r.project_id}|${r.holiday_date}`;
  if (tabela === 'org_holidays') return `${r.org_id}|${r.holiday_date}`;
  if (tabela === 'schedule_baseline_items') return `${r.baseline_id}|${r.activity_id}`;
  return r.id;
}
