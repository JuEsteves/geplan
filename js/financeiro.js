// Regras financeiras centralizadas do GEPLAN (orçamento com BDI, revisões, custos e indicadores).
//
// ORÇAMENTO
//   Custo total do item     = quantidade × custo unitário        (custo direto de execução, sem BDI)
//   Custo direto da obra    = Σ custo total dos itens
//   BDI (fórmula do TCU, Acórdão 2622/2013):
//       BDI = [ (1 + AC + S + R + G) × (1 + DF) × (1 + L) ] ÷ (1 − I) − 1
//       AC administração central · S seguros · R riscos · G garantias · DF despesas financeiras · L lucro · I tributos
//   Preço de venda          = custo direto × (1 + BDI)           (o BDI é aplicado UMA vez, sobre o custo direto)
//   Encargos sociais já fazem parte do custo unitário das composições — não são somados de novo aqui.
//
// CUSTOS (sem duplicidade)
//   Comprometido = Σ (contratos/pedidos + aditivos) + Σ despesas SEM contrato/pedido vinculado
//   Incorrido    = Σ despesas lançadas (notas/medições de fornecedores)   — uma despesa vinculada a um contrato
//                  consome o saldo do contrato, não soma de novo no comprometido
//   Pago         = Σ pagamentos das despesas ·  Saldo a pagar = incorrido − pago
//
// VALOR AGREGADO (EVM), na data de referência
//   BAC = custo direto planejado (alocado às atividades) · PV = valor planejado até a data
//   EV  = Σ custo da atividade × % executado          · AC = custo incorrido até a data
//   CPI = EV ÷ AC (custo) · SPI = EV ÷ PV (prazo)      · EAC = AC + (BAC − EV) (o restante custa o orçado)
//   VAC = BAC − EAC (positivo = economia)

import { uid } from './model.js';
import { toDay, fmtBRL } from './schedule.js';

const pc = (x) => (Number(x) || 0) / 100;

export function bdiTCU(b = {}) {
  const I = pc(b.i);
  if (I >= 1) return NaN;
  return ((1 + pc(b.ac) + pc(b.s) + pc(b.r) + pc(b.g)) * (1 + pc(b.df)) * (1 + pc(b.l))) / (1 - I) - 1;
}

/** Resumo do orçamento: custo direto, BDI, preço de venda e subtotais por etapa/subetapa. */
export function resumoOrcamento(obra, calc) {
  const bdi = bdiTCU(obra.bdi);
  const etapas = new Map();
  for (const it of obra.orcamento) {
    const I = calc.itens.get(it.id);
    const e = it.etapa || '(sem etapa)', s = it.subetapa || '';
    if (!etapas.has(e)) etapas.set(e, { etapa: e, custo: 0, subs: new Map() });
    const E = etapas.get(e); E.custo += I.total;
    E.subs.set(s, (E.subs.get(s) || 0) + I.total);
  }
  const custoDireto = calc.totalOrcamento;
  return {
    custoDireto, bdi, precoVenda: custoDireto * (1 + (isFinite(bdi) ? bdi : 0)),
    etapas: [...etapas.values()].map((E) => ({ ...E, preco: E.custo * (1 + (isFinite(bdi) ? bdi : 0)), subs: [...E.subs.entries()] })),
  };
}

/* ---------- revisões do orçamento ---------- */

export function snapshotOrcamento(obra, lib, nome) {
  const comps = new Map(lib.composicoes.map((c) => [c.id, c]));
  const itens = obra.orcamento.map((it) => {
    const c = comps.get(it.composicaoId);
    return { itemId: it.id, codigo: it.codigo, etapa: it.etapa, subetapa: it.subetapa, descricao: c?.descricao || it.descricao || '', unidade: c?.unidade || it.unidade || '', comp: c?.codigo || '', quantidade: Number(it.quantidade) || 0, custoUnit: Number(it.custoUnit) || 0 };
  });
  return { id: uid(), nome, data: new Date().toISOString(), bdi: { ...(obra.bdi || {}) }, itens, custoTotal: itens.reduce((s, i) => s + i.quantidade * i.custoUnit, 0) };
}

/** Compara uma revisão com o orçamento atual (ou duas revisões). Retorna incluídos, removidos e alterados. */
export function compararOrcamento(antes, depois) {
  const A = new Map(antes.itens.map((i) => [i.itemId || i.codigo, i]));
  const D = new Map(depois.itens.map((i) => [i.itemId || i.codigo, i]));
  const incluidos = [], removidos = [], alterados = [];
  for (const [k, d] of D) {
    const a = A.get(k);
    if (!a) { incluidos.push(d); continue; }
    const tA = a.quantidade * a.custoUnit, tD = d.quantidade * d.custoUnit;
    if (a.quantidade !== d.quantidade || a.custoUnit !== d.custoUnit || a.comp !== d.comp || a.codigo !== d.codigo) alterados.push({ antes: a, depois: d, delta: tD - tA });
  }
  for (const [k, a] of A) if (!D.has(k)) removidos.push(a);
  const delta = depois.itens.reduce((s, i) => s + i.quantidade * i.custoUnit, 0) - antes.itens.reduce((s, i) => s + i.quantidade * i.custoUnit, 0);
  return { incluidos, removidos, alterados, delta };
}

/* ---------- custos ---------- */

export const totalCompromisso = (c) => (Number(c.valor) || 0) + (c.aditivos || []).reduce((s, a) => s + (Number(a.valor) || 0), 0);
export const pagoDespesa = (d) => (d.pagamentos || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);

/** Totais financeiros da obra (até a data, se informada) e alertas de consistência. */
export function resumoCustos(obra, { ateDia = null } = {}) {
  const dentro = (data) => ateDia == null || (toDay(data) ?? -Infinity) <= ateDia;
  const comps = (obra.compromissos || []);
  const desp = (obra.despesas || []).filter((d) => dentro(d.data));
  const porComp = new Map();
  for (const d of desp) if (d.compromissoId) porComp.set(d.compromissoId, (porComp.get(d.compromissoId) || 0) + (Number(d.valor) || 0));
  const comprometidoContratos = comps.reduce((s, c) => s + totalCompromisso(c), 0);
  const avulsas = desp.filter((d) => !d.compromissoId || !comps.some((c) => c.id === d.compromissoId));
  const comprometido = comprometidoContratos + avulsas.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const incorrido = desp.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const pago = desp.reduce((s, d) => s + pagoDespesa(d), 0);
  const aIncorrer = comps.reduce((s, c) => s + Math.max(0, totalCompromisso(c) - (porComp.get(c.id) || 0)), 0);
  const alertas = [];
  for (const c of comps) {
    const usado = porComp.get(c.id) || 0;
    if (usado > totalCompromisso(c) + 0.005) alertas.push(`${c.tipo} ${c.numero || c.fornecedor}: despesas (${fmtBRL(usado)}) acima do valor contratado com aditivos.`);
  }
  for (const d of desp) if (pagoDespesa(d) > (Number(d.valor) || 0) + 0.005) alertas.push(`Despesa ${d.documento || d.descricao}: pagamentos acima do valor.`);
  const porCategoria = new Map();
  for (const d of desp) porCategoria.set(d.categoria || 'Outro', (porCategoria.get(d.categoria || 'Outro') || 0) + (Number(d.valor) || 0));
  return { comprometido, incorrido, pago, saldoAPagar: incorrido - pago, aIncorrer, alertas, porCategoria: [...porCategoria.entries()], porComp };
}

/** Despesa possivelmente duplicada (mesmo documento e fornecedor, ou mesmo valor/data/fornecedor). */
export function despesaDuplicada(obra, d) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  return (obra.despesas || []).find((x) => x.id !== d.id && (
    (norm(x.documento) && norm(x.documento) === norm(d.documento) && norm(x.fornecedor) === norm(d.fornecedor))
    || (x.data === d.data && Math.abs((Number(x.valor) || 0) - (Number(d.valor) || 0)) < 0.005 && norm(x.fornecedor) === norm(d.fornecedor) && norm(x.descricao) === norm(d.descricao))
  ));
}

/** Indicadores de valor agregado na data. `av` = avanco(...) e `pv` = valor planejado até a data. */
export function valorAgregado({ bac, pv, ev, ac }) {
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;
  const eac = ac + (bac - ev);
  return { bac, pv, ev, ac, cpi, spi, eac, etc: eac - ac, vac: bac - eac };
}
