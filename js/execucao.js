// Regras de execução: medições de avanço por atividade e diário de obra.
//
// MEDIÇÃO (avanço físico)
// - Cada lançamento informa o ACUMULADO executado até a data (não o incremento). Assim, repetir o mesmo lançamento
//   não aumenta o avanço artificialmente; e só existe UM lançamento por atividade por data (o novo substitui).
// - Método "quantidade": % = quantidade acumulada ÷ quantidade planejada (limitado a 100%).
//   Quantidade planejada = soma das quantidades alocadas pelos vínculos com o orçamento (mesma unidade).
// - Método "percentual": informa-se o % acumulado diretamente (atividades sem quantidade: cura, fornecedor…).
// - O avanço numa data é o da última medição até ela. O histórico é preservado.
//
// DIÁRIO DE OBRA: um registro por dia, com clima, equipe, serviços, materiais, equipamentos, visitas, reuniões,
// ocorrências/interferências/impedimentos e observações. Não é medição contratual: serviços citados no diário não
// alteram o avanço físico (isso é feito pelas medições).

import { uid, registrar } from './model.js';
import { fmtNumFix } from './schedule.js';

/** Quantidade planejada da atividade (soma das quantidades alocadas, se todas na mesma unidade). */
export function quantidadePlanejada(calc, atividadeId) {
  const A = calc.ativ.get(atividadeId);
  if (!A || !A.vinculos.length) return null;
  const unidades = new Set(A.vinculos.map((v) => (v.unidade || '').toLowerCase()));
  if (unidades.size !== 1) return null;
  const qtd = A.vinculos.reduce((s, v) => s + v.qtd, 0);
  return qtd > 0 ? { qtd, unidade: A.vinculos[0].unidade } : null;
}

export function metodoMedicao(a, plan) {
  if (a.medicao === 'percentual') return 'percentual';
  if (a.medicao === 'quantidade') return plan ? 'quantidade' : 'percentual';
  return plan ? 'quantidade' : 'percentual';
}

export const medicoesDe = (obra, atividadeId) => (obra.medicoesAtiv || []).filter((m) => m.atividadeId === atividadeId).sort((a, b) => a.data.localeCompare(b.data));

/**
 * Registra (ou substitui, se já houver na mesma data) a medição acumulada de uma atividade.
 * @returns {{ medicao, substituida: boolean, avisos: string[] }}
 */
export function registrarMedicao(obra, calc, { atividadeId, data, qtdAcum = null, pct = null, obs = '', responsavel = '' }) {
  const a = obra.eap.find((x) => x.id === atividadeId);
  if (!a) throw new Error('Atividade não encontrada.');
  if (obra.eap.some((x) => x.parentId === atividadeId)) throw new Error('Meça as atividades do último nível (não etapas/subetapas).');
  if (!data) throw new Error('Informe a data da medição.');
  const plan = quantidadePlanejada(calc, atividadeId);
  const metodo = metodoMedicao(a, plan);
  const avisos = [];
  let p;
  if (metodo === 'quantidade') {
    const q = Number(qtdAcum);
    if (!(q >= 0)) throw new Error('Informe a quantidade acumulada executada.');
    p = (q / plan.qtd) * 100;
    if (q > plan.qtd + 1e-9) avisos.push(`Quantidade acima da planejada (${plan.qtd} ${plan.unidade}) — avanço limitado a 100%. Revise o orçamento se houver acréscimo.`);
  } else {
    p = Number(pct);
    if (!(p >= 0)) throw new Error('Informe o % acumulado executado.');
    if (p > 100) avisos.push('Percentual acima de 100% — limitado a 100%.');
  }
  p = Math.min(100, Math.max(0, p));
  const anteriores = medicoesDe(obra, atividadeId).filter((m) => m.data < data);
  const ultimaAntes = anteriores[anteriores.length - 1];
  if (ultimaAntes && p + 1e-9 < Number(ultimaAntes.pct)) avisos.push(`O acumulado ficou menor que o da medição de ${ultimaAntes.data.split('-').reverse().join('/')} (${fmtNumFix(ultimaAntes.pct, 1)}%). Confira se não é um lançamento só do período.`);
  obra.medicoesAtiv ||= [];
  const existente = obra.medicoesAtiv.find((m) => m.atividadeId === atividadeId && m.data === data);
  const reg = { atividadeId, data, metodo, qtdAcum: metodo === 'quantidade' ? Number(qtdAcum) : null, unidade: plan?.unidade || '', qtdPlanejada: plan?.qtd ?? null, pct: p, obs, responsavel, criadoEm: new Date().toISOString() };
  let medicao;
  if (existente) { Object.assign(existente, reg); medicao = existente; }
  else { medicao = { id: uid(), ...reg }; obra.medicoesAtiv.push(medicao); }
  sincronizarAtividade(obra, a);
  registrar(obra, existente ? 'Medição alterada' : 'Medição registrada', `${a.codigo} ${a.descricao}: ${fmtNumFix(p, 1)}% em ${data.split('-').reverse().join('/')}`, responsavel);
  return { medicao, substituida: !!existente, avisos };
}

export function removerMedicao(obra, id, usuario = '') {
  const m = (obra.medicoesAtiv || []).find((x) => x.id === id);
  if (!m) return;
  obra.medicoesAtiv = obra.medicoesAtiv.filter((x) => x.id !== id);
  const a = obra.eap.find((x) => x.id === m.atividadeId);
  if (a) { a.inicioReal = ''; sincronizarAtividade(obra, a); }
  registrar(obra, 'Medição excluída', `${a?.codigo || ''}: ${fmtNumFix(m.pct, 1)}% em ${m.data.split('-').reverse().join('/')}`, usuario);
}

/** Mantém pct/início real/fim real da atividade coerentes com as medições. */
// Regra: % = última medição; início real = 1ª medição com avanço (ou a data informada à mão, se for anterior);
// fim real = 1ª medição com 100%. Sem medições, os campos ficam como estavam (lançamento manual).
function sincronizarAtividade(obra, a) {
  const ms = medicoesDe(obra, a.id);
  if (!ms.length) { a.pct = 0; return; }
  a.pct = ms[ms.length - 1].pct;
  const ini = ms.find((m) => m.pct > 0)?.data || '';
  a.inicioReal = a.inicioReal && ini && a.inicioReal < ini ? a.inicioReal : ini;
  a.fimReal = ms.find((m) => m.pct >= 100)?.data || '';
}

/* ---------- diário de obra (RDO) ----------
 * Relatório por PERÍODO (data inicial e final; um dia só quando forem iguais). Períodos da mesma obra não se
 * sobrepõem. Número sequencial por obra. Situação: preenchendo → em revisão → aprovado (ou devolvido para correção);
 * aprovado não é editado (precisa ser reaberto por quem aprova). No modo nuvem, número, situação e aprovação são
 * gravados pelo banco (migração 0008); aqui o número é provisório até a sincronização.
 */
export const STATUS_RDO = {
  preenchendo: { rotulo: 'Preenchendo', cls: 'warn' }, revisao: { rotulo: 'Em revisão', cls: 'info' },
  devolvido: { rotulo: 'Devolvido para correção', cls: 'crit' }, aprovado: { rotulo: 'Aprovado', cls: 'good' },
};
export const SITUACOES_ATIVIDADE = { em_andamento: 'Em andamento', concluida: 'Concluída', iniciada: 'Iniciada', paralisada: 'Paralisada', nao_iniciada: 'Não iniciada' };
const br = (s) => (s ? s.split('-').reverse().join('/') : '');
const DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
export const fimRdo = (d) => d.dataFim || d.data;
export const periodoRdo = (d) => (fimRdo(d) !== d.data ? `${br(d.data)} até ${br(fimRdo(d))}` : br(d.data));
export const diasDaSemanaRdo = (d) => {
  const dia = (s) => DIAS[new Date(`${s}T12:00:00`).getDay()];
  return fimRdo(d) !== d.data ? `${dia(d.data)} até ${dia(fimRdo(d))}` : dia(d.data);
};
export const badgeRdo = (st) => `<span class="badge ${STATUS_RDO[st || 'preenchendo']?.cls || ''}">${STATUS_RDO[st || 'preenchendo']?.rotulo || st}</span>`;

export function novoDiario(data, responsavel = '', obra = null) {
  return {
    id: uid(), numero: proximoNumeroRdo(obra), data, dataFim: data, status: 'preenchendo', responsavel,
    clima: { manha: 'Bom', tarde: 'Bom' }, praticavel: true, condicoes: '', justificativa: '',
    equipe: [], equipamentosLista: [], servicos: [], ocorrencias: [], materiaisLista: [],
    materiais: '', equipamentos: '', visitas: '', reunioes: '', observacoes: '',
    criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
  };
}
export const proximoNumeroRdo = (obra) => Math.max(0, ...((obra?.diario || []).map((x) => Number(x.numero) || 0))) + 1;

/** Relatório da obra que cobre parte do período (ou null). */
export function sobreposicaoRdo(obra, d) {
  const ini = d.data, fim = fimRdo(d);
  return (obra.diario || []).find((x) => x.id !== d.id && x.data <= fim && fimRdo(x) >= ini) || null;
}

/** Salva o relatório (valida o período). */
export function salvarDiario(obra, d, usuario = '') {
  obra.diario ||= [];
  if (!d.data) throw new Error('Informe a data do relatório.');
  if (!d.dataFim) d.dataFim = d.data;
  if (d.dataFim < d.data) throw new Error('O fim do período é antes do início.');
  const atual = obra.diario.find((x) => x.id === d.id);
  if (atual?.status === 'aprovado') throw new Error(`O relatório nº ${atual.numero} está aprovado: para alterar, ele precisa ser reaberto por quem aprova.`);
  const outro = sobreposicaoRdo(obra, d);
  if (outro) throw new Error(`O relatório nº ${outro.numero || '—'} (${periodoRdo(outro)}) já cobre parte desse período.`);
  d.numero ||= proximoNumeroRdo(obra);
  d.status ||= 'preenchendo';
  d.atualizadoEm = new Date().toISOString();
  const i = obra.diario.findIndex((x) => x.id === d.id);
  if (i >= 0) obra.diario[i] = d; else obra.diario.push(d);
  obra.diario.sort((a, b) => b.data.localeCompare(a.data));
  registrar(obra, i >= 0 ? 'Diário alterado' : 'Diário registrado', `RDO nº ${d.numero} — ${periodoRdo(d)}`, usuario);
  return d;
}

/** Atividades da EAP dentro de uma fase (a própria e todas abaixo dela). */
export function idsDaFase(obra, faseId) {
  const ids = new Set([faseId]);
  let mudou = true;
  while (mudou) { mudou = false; for (const a of obra.eap || []) if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) { ids.add(a.id); mudou = true; } }
  return ids;
}

/** Filtra relatórios (período que se cruza, responsável, situação, atividade, fase, ocorrência, texto). */
export function filtrarDiario(obra, { de = '', ate = '', responsavel = '', atividadeId = '', faseId = '', tipo = '', status = '', texto = '' } = {}) {
  const t = texto.trim().toLowerCase();
  const daFase = faseId ? idsDaFase(obra, faseId) : null;
  return (obra.diario || []).filter((d) => (!de || fimRdo(d) >= de) && (!ate || d.data <= ate)
    && (!responsavel || (d.responsavel || '').toLowerCase().includes(responsavel.toLowerCase()))
    && (!status || (d.status || 'preenchendo') === status)
    && (!atividadeId || (d.servicos || []).some((s) => s.atividadeId === atividadeId))
    && (!daFase || (d.servicos || []).some((s) => s.atividadeId && daFase.has(s.atividadeId)))
    && (!tipo || (d.ocorrencias || []).some((o) => o.tipo === tipo))
    && (!t || JSON.stringify(d).toLowerCase().includes(t)));
}

/** Prazos da obra (dias corridos): contratual = início → previsão de término; decorrido até hoje; a vencer. */
export function prazosObra(obra, hoje) {
  const ini = obra.inicioReal || obra.inicio, fim = obra.terminoPlanejado;
  if (!ini || !fim) return null;
  const dias = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
  const contratual = dias(ini, fim);
  if (contratual <= 0) return null;
  const decorrido = Math.max(0, Math.min(contratual, dias(ini, hoje)));
  return { inicio: ini, termino: fim, contratual, decorrido, aVencer: Math.max(0, dias(hoje, fim)), pct: Math.round((decorrido / contratual) * 100), vencido: hoje > fim };
}

/** Avanço medido de uma atividade até a data (última medição até ela; sem medição, o % da atividade se não houver data). */
export function avancoAte(obra, atividadeId, data) {
  const ms = medicoesDe(obra, atividadeId).filter((m) => m.data <= data);
  if (ms.length) return Number(ms[ms.length - 1].pct);
  return null;
}

/** Impedimentos/interferências ainda não resolvidos. */
export const pendenciasAbertas = (obra) => (obra.diario || []).flatMap((d) => d.ocorrencias.filter((o) => !o.resolvida && o.tipo !== 'Visita técnica').map((o) => ({ ...o, data: d.data, diarioId: d.id })));
