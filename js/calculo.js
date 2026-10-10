// Regras de cálculo do orçamento × EAP — as mesmas fórmulas da planilha modelo.
//
// Para cada vínculo (item do orçamento × atividade, percentual 0–1):
//   qtd_alocada   = quantidade do item × percentual
//   hh            = qtd_alocada × coeficiente da função LÍDER da composição do item
//   custo_alocado = total do item × percentual            (total = quantidade × custo unitário)
// Para cada atividade:
//   hh_total        = Σ hh dos vínculos
//   duracao_calc    = ARREDONDAR.PARA.CIMA( hh_total ÷ (equipe × jornada × eficiência) )   (vazio se hh = 0 ou sem equipe)
//   duracao_adotada = duracao_manual, se preenchida; senão duracao_calc; senão a duração padrão do tipo (provisória)
//   custo           = Σ custo_alocado

import { filhosDe, DURACAO_PADRAO } from './model.js';

export const liderDe = (comp) => comp?.maoObra?.find((f) => f.lider) || null;
const vazio = (v) => v === '' || v === null || v === undefined || (typeof v === 'number' && isNaN(v));
const num = (v) => (vazio(v) ? 0 : Number(v) || 0);

/** Problemas de uma composição (regra: exatamente uma função líder). */
export function validarComposicao(c) {
  const erros = [];
  const lideres = (c.maoObra || []).filter((f) => f.lider).length;
  if (lideres === 0) erros.push('Sem função líder');
  if (lideres > 1) erros.push('Mais de uma função líder');
  if (!(c.maoObra || []).length) erros.push('Sem funções de mão de obra');
  return erros;
}

export function duracaoCalculada(hh, equipe, jornada, eficiencia) {
  const eq = num(equipe);
  if (!(hh > 0) || !(eq > 0)) return null;
  const cap = eq * num(jornada) * num(eficiencia);
  if (!(cap > 0)) return null;
  return Math.ceil(hh / cap - 1e-9);
}

export function calcular(obra, lib) {
  const comps = new Map(lib.composicoes.map((c) => [c.id, c]));
  const jornada = num(obra.jornada) || 8.8;
  const eficiencia = num(obra.eficiencia) || 0.85;
  const padrao = { ...DURACAO_PADRAO, ...(obra.duracaoPadrao || {}) };
  const filhos = filhosDe(obra);
  const ativIds = new Set(obra.eap.map((a) => a.id));

  // Itens do orçamento
  const itens = new Map();
  let totalOrcamento = 0;
  for (const it of obra.orcamento) {
    const comp = comps.get(it.composicaoId) || null;
    const total = num(it.quantidade) * num(it.custoUnit);
    totalOrcamento += total;
    itens.set(it.id, { item: it, comp, lider: liderDe(comp), total, pctSoma: 0, vinculos: [], status: 'Sem vínculo', alertas: [] });
  }

  // Atividades
  const ativ = new Map();
  for (const a of obra.eap) {
    ativ.set(a.id, { a, folha: !(filhos.get(a.id) || []).length, hh: 0, custo: 0, vinculos: [], funcaoLider: '', durCalc: null, dur: 0, provisoria: false, alertas: [] });
  }

  // Vínculos
  const vinculos = [];
  for (const v of obra.vinculos) {
    const I = itens.get(v.itemId);
    const A = ativ.get(v.atividadeId);
    if (!I || !A) continue;
    const pct = num(v.pct);
    const qtd = num(I.item.quantidade) * pct;
    const coef = num(I.lider?.coef);
    const hh = qtd * coef;
    const custo = I.total * pct;
    const r = { v, item: I.item, atividade: A.a, pct, qtd, unidade: I.comp?.unidade || '', coef, funcao: I.lider?.funcao || '', hh, custo };
    vinculos.push(r);
    I.vinculos.push(r); I.pctSoma += pct;
    A.vinculos.push(r); A.hh += hh; A.custo += custo;
    if (!A.funcaoLider && r.funcao) A.funcaoLider = r.funcao;
  }

  // Validação dos itens
  for (const I of itens.values()) {
    if (!I.vinculos.length) { I.status = 'Sem vínculo'; I.alertas.push('Item sem vínculo com a EAP'); }
    else if (Math.round(I.pctSoma * 10000) / 10000 === 1) I.status = 'OK';
    else { I.status = 'Verificar'; I.alertas.push(`Vinculado ${fmtPct(I.pctSoma)} (deve somar 100%)`); }
    if (!I.comp) I.alertas.push('Sem composição');
    else if (!I.lider) I.alertas.push('Composição sem função líder');
  }

  // Duração das folhas
  for (const A of ativ.values()) {
    if (!A.folha) continue;
    const a = A.a;
    A.durCalc = duracaoCalculada(A.hh, a.equipe, jornada, eficiencia);
    if (!vazio(a.duracaoManual)) A.dur = Math.max(0, Math.round(num(a.duracaoManual)));
    else if (A.durCalc !== null) A.dur = A.durCalc;
    else { A.dur = Math.max(0, Math.round(num(padrao[a.tipo] ?? 1))); A.provisoria = true; }

    if (A.hh > 0 && vazio(a.equipe) && vazio(a.duracaoManual)) A.alertas.push('Informe a equipe para calcular a duração');
    if (A.provisoria) A.alertas.push(a.tipo === 'Execução' && !A.vinculos.length
      ? 'Sem vínculo com o orçamento e sem duração manual (usando duração padrão)'
      : `Sem duração definida — usando a padrão de "${a.tipo}"`);
    if (a.predTexto && !a.inicioFixado && !a.inicioReal) A.alertas.push(`Predecessora "${a.predTexto}" não é uma atividade — defina o início fixado`);
  }

  // Agregação para os níveis superiores (HH e custo)
  const agrega = (id) => {
    const A = ativ.get(id);
    if (A.folha) return A;
    A.hh = 0; A.custo = 0;
    for (const f of filhos.get(id) || []) { const F = agrega(f.id); A.hh += F.hh; A.custo += F.custo; }
    return A;
  };
  for (const r of filhos.get(null) || []) agrega(r.id);

  const totalAlocado = vinculos.reduce((s, r) => s + r.custo, 0);
  const totalHH = vinculos.reduce((s, r) => s + r.hh, 0);
  const alertasItens = [...itens.values()].filter((I) => I.alertas.length).length;
  const alertasAtiv = [...ativ.values()].filter((A) => A.alertas.length).length;
  return { itens, ativ, vinculos, totalOrcamento, totalAlocado, totalHH, jornada, eficiencia, alertasItens, alertasAtiv, ativIds };
}

export const fmtPct = (p) => `${(Math.round(p * 10000) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
