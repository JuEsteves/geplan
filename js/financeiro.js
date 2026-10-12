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
// CUSTOS (sem duplicidade) — iguais às views do banco (migração 0010)
//   Comprometido = Σ contratos/pedidos (com aditivos; "Cancelado"/"Encerrado" = só o já incorrido neles)
//                  + Σ despesas SEM contrato/pedido vinculado + Σ medições aprovadas ainda não lançadas ("a lançar")
//   Incorrido    = Σ despesas lançadas (notas/medições de fornecedores)   — uma despesa vinculada a um contrato
//                  consome o saldo do contrato, não soma de novo no comprometido; medição lançada sai do "a lançar"
//   Pago         = Σ pagamentos das despesas ·  Saldo a pagar = incorrido − pago
//   A incorrer   = Σ max(0, comprometido do contrato − despesas dele) + a lançar
//   Empreitada (vínculo de remuneração) só entra quando medida. Material recebido sem nota não é custo.
//
// CUSTOS POR FASE (fase = etapa raiz da EAP), sem estimativa. Ordem para achar a fase de um valor:
//   fase informada → item do orçamento (repartido pelos vínculos com a EAP; o que faltar para 100% vai para
//   "Sem fase") → contrato/pedido da despesa → "Sem fase". Pagamento segue a despesa. Orçado = custo direto do item
//   repartido pelos vínculos. Data de corte: contrato pela data dele, aditivo pela data, despesa pela data,
//   pagamento pela data, medição a lançar pelo fim do período.
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

/** Contrato/pedido que não gera mais custo: conta no comprometido só o que já foi incorrido nele. */
export const COMPROMISSO_ENCERRADO = ['Cancelado', 'Encerrado'];
export const compromissoEfetivo = (c, incorridoNele) => (COMPROMISSO_ENCERRADO.includes(c.status) ? incorridoNele : totalCompromisso(c));

/** Totais financeiros da obra (até a data, se informada) e alertas de consistência.
 *  `aLancar`: valores de medições aprovadas ainda não lançados ([{ valor, data, faseId }], modo nuvem). */
export function resumoCustos(obra, { ateDia = null, aLancar = [] } = {}) {
  const dentro = (data) => ateDia == null || (toDay(data) ?? -Infinity) <= ateDia;
  const comps = (obra.compromissos || []);
  const desp = (obra.despesas || []).filter((d) => dentro(d.data));
  const porComp = new Map();
  for (const d of desp) if (d.compromissoId) porComp.set(d.compromissoId, (porComp.get(d.compromissoId) || 0) + (Number(d.valor) || 0));
  const comprometidoContratos = comps.reduce((s, c) => s + compromissoEfetivo(c, porComp.get(c.id) || 0), 0);
  const avulsas = desp.filter((d) => !d.compromissoId || !comps.some((c) => c.id === d.compromissoId));
  const totalALancar = aLancar.filter((m) => dentro(m.data)).reduce((s, m) => s + (Number(m.valor) || 0), 0);
  const comprometido = comprometidoContratos + avulsas.reduce((s, d) => s + (Number(d.valor) || 0), 0) + totalALancar;
  const incorrido = desp.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const pago = desp.reduce((s, d) => s + pagoDespesa(d), 0);
  const aIncorrer = comps.reduce((s, c) => s + Math.max(0, compromissoEfetivo(c, porComp.get(c.id) || 0) - (porComp.get(c.id) || 0)), 0) + totalALancar;
  const alertas = [];
  for (const c of comps) {
    const usado = porComp.get(c.id) || 0;
    if (usado > totalCompromisso(c) + 0.005) alertas.push(`${c.tipo} ${c.numero || c.fornecedor}: despesas (${fmtBRL(usado)}) acima do valor contratado com aditivos.`);
  }
  for (const d of desp) if (pagoDespesa(d) > (Number(d.valor) || 0) + 0.005) alertas.push(`Despesa ${d.documento || d.descricao}: pagamentos acima do valor.`);
  const porCategoria = new Map();
  for (const d of desp) porCategoria.set(d.categoria || 'Outro', (porCategoria.get(d.categoria || 'Outro') || 0) + (Number(d.valor) || 0));
  return { comprometido, incorrido, pago, saldoAPagar: incorrido - pago, aIncorrer, aLancar: totalALancar, alertas, porCategoria: [...porCategoria.entries()], porComp };
}

/** Custos por fase (etapa raiz da EAP) — mesmas regras de `custos_por_fase` no banco (cabeçalho deste arquivo).
 *  `totalItem(id)` = custo direto do item do orçamento; `categoria` filtra contratos, despesas e "a lançar"
 *  (o orçado não tem categoria e não muda). Retorna as fases na ordem da EAP e, por último, "Sem fase" (id null). */
export function custosPorFase(obra, { totalItem = () => 0, ateDia = null, aLancar = [], categoria = '' } = {}) {
  const dentroOpc = (data) => ateDia == null || !data || (toDay(data) ?? -Infinity) <= ateDia;   // sem data: entra
  const dentroObr = (data) => ateDia == null || (data && (toDay(data) ?? Infinity) <= ateDia);   // sem data: fica fora
  const daCategoria = (x) => !categoria || (x.categoria || 'Outro') === categoria;
  const porId = new Map((obra.eap || []).map((a) => [a.id, a]));
  const raiz = (id) => {
    let a = porId.get(id), n = 0;
    while (a && a.parentId && n++ < 20) a = porId.get(a.parentId);
    return a && !a.parentId ? a.id : null;
  };
  const itens = new Set((obra.orcamento || []).map((i) => i.id));
  const alocItem = new Map();
  for (const v of obra.vinculos || []) {
    if (!itens.has(v.itemId) || !porId.has(v.atividadeId)) continue;
    if (!alocItem.has(v.itemId)) alocItem.set(v.itemId, []);
    alocItem.get(v.itemId).push({ fase: raiz(v.atividadeId), share: Number(v.pct) || 0 });
  }
  const repartirItem = (id) => {
    const l = [...(alocItem.get(id) || [])];
    const resto = 1 - l.reduce((s, x) => s + x.share, 0);
    if (resto > 0.000001) l.push({ fase: null, share: resto });
    return l;
  };
  const todosComps = new Map((obra.compromissos || []).map((k) => [k.id, k]));
  const alocComp = (k) => (k.faseId ? [{ fase: raiz(k.faseId), share: 1 }] : k.itemId && itens.has(k.itemId) ? repartirItem(k.itemId) : [{ fase: null, share: 1 }]);
  const alocDesp = (d) => (d.faseId ? [{ fase: raiz(d.faseId), share: 1 }]
    : d.itemId && itens.has(d.itemId) ? repartirItem(d.itemId)
      : d.compromissoId && todosComps.has(d.compromissoId) ? alocComp(todosComps.get(d.compromissoId)) : [{ fase: null, share: 1 }]);

  const L = new Map();
  const linha = (fase) => {
    if (!L.has(fase)) L.set(fase, { orcado: 0, comprometido: 0, incorrido: 0, pago: 0, aLancar: 0 });
    return L.get(fase);
  };
  const somar = (aloc, campo, valor) => { for (const x of aloc) linha(x.fase)[campo] += valor * x.share; };
  let semFase = 0;
  const contaSemFase = (aloc) => { if (aloc.some((x) => x.fase == null)) semFase++; };

  for (const it of obra.orcamento || []) somar(repartirItem(it.id), 'orcado', Number(totalItem(it.id)) || 0);
  const desp = (obra.despesas || []).filter((d) => dentroObr(d.data));
  const comps = [...todosComps.values()].filter((k) => dentroOpc(k.data));
  const idsComps = new Set(comps.map((k) => k.id));
  const incNoComp = new Map();
  for (const d of desp) if (d.compromissoId) incNoComp.set(d.compromissoId, (incNoComp.get(d.compromissoId) || 0) + (Number(d.valor) || 0));
  for (const k of comps) {
    if (!daCategoria(k)) continue;
    const tot = (Number(k.valor) || 0) + (k.aditivos || []).filter((a) => dentroOpc(a.data)).reduce((s, a) => s + (Number(a.valor) || 0), 0);
    const efetivo = COMPROMISSO_ENCERRADO.includes(k.status) ? (incNoComp.get(k.id) || 0) : tot;
    const aloc = alocComp(k); contaSemFase(aloc);
    somar(aloc, 'comprometido', efetivo);
  }
  for (const d of desp) {
    if (!daCategoria(d)) continue;
    const aloc = alocDesp(d); contaSemFase(aloc);
    const v = Number(d.valor) || 0;
    if (!d.compromissoId || !idsComps.has(d.compromissoId)) somar(aloc, 'comprometido', v);
    somar(aloc, 'incorrido', v);
    somar(aloc, 'pago', (d.pagamentos || []).filter((p) => dentroObr(p.data)).reduce((s, p) => s + (Number(p.valor) || 0), 0));
  }
  if (!categoria || categoria === 'Mão de obra') {
    for (const m of aLancar) {
      if (!dentroObr(m.data)) continue;
      const aloc = [{ fase: m.faseId || null, share: 1 }];
      somar(aloc, 'comprometido', Number(m.valor) || 0); somar(aloc, 'aLancar', Number(m.valor) || 0);
    }
  }

  const raizes = (obra.eap || []).filter((a) => !a.parentId);
  const fases = raizes.map((a) => ({ id: a.id, codigo: a.codigo || '', descricao: a.descricao || '', ...linha(a.id) }));
  for (const [f, v] of L) if (f != null && !porId.has(f)) fases.push({ id: f, codigo: '', descricao: '(fase não encontrada)', ...v });
  const sf = L.get(null);
  if (sf && Object.values(sf).some((x) => Math.abs(x) > 0.004)) fases.push({ id: null, codigo: '', descricao: 'Sem fase', ...sf });
  const totais = fases.reduce((t, f) => { for (const k of Object.keys(t)) t[k] += f[k]; return t; }, { orcado: 0, comprometido: 0, incorrido: 0, pago: 0, aLancar: 0 });
  return { fases, totais, semFase };
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
