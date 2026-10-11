// Cronograma físico-financeiro e Curva S.
//
// Definições (documentadas também na tela):
// - Valor planejado de uma atividade = custo alocado a ela pelos vínculos com o orçamento (custo direto).
// - Distribuição no tempo: pelos dias úteis da atividade, segundo o PERFIL escolhido (linear, início, fim, sino).
//   Valores financeiros são distribuídos em centavos; o resíduo de arredondamento vai para o último dia, então a soma
//   distribuída é exatamente igual ao valor planejado.
// - Avanço FÍSICO = média ponderada do % executado das atividades, com o PESO FÍSICO escolhido na obra
//   (HH, custo, duração ou peso manual). Não é o mesmo que avanço financeiro.
// - Avanço FINANCEIRO realizado = custo incorrido (despesas lançadas) ÷ custo planejado total.
// - % executado de uma atividade numa data = última medição registrada até essa data.

import { dateParts, MESES, fmtBR, weekday, toDay } from './schedule.js';

/** Pesos diários (somam 1) de uma atividade de n dias úteis, conforme o perfil. */
export function pesosPerfil(n, perfil = 'linear') {
  if (n <= 0) return [];
  let w;
  if (perfil === 'inicio') w = Array.from({ length: n }, (_, i) => n - i);
  else if (perfil === 'fim') w = Array.from({ length: n }, (_, i) => i + 1);
  else if (perfil === 'sino') w = Array.from({ length: n }, (_, i) => Math.sin(Math.PI * (i + 0.5) / n));
  else w = Array(n).fill(1);
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

const perfilDe = (obra, a) => a.perfil || obra?.distribuicaoPadrao || 'linear';

/** Peso físico de uma folha conforme o critério da obra. */
export function pesoFisico(obra, A, n) {
  const m = obra?.pesoFisico || 'hh';
  if (m === 'manual') return Number(A.a.pesoManual) || 0;
  if (m === 'custo') return A.custo;
  if (m === 'duracao') return n.dur;
  return A.hh;
}

/** Avanço planejado (0..1) de uma folha ao fim do dia `day`. */
export function fracPlanejada(no, cal, day, obra = null) {
  const feitos = cal.concluidosAte(day);
  if (no.dur <= 0) return feitos > no.es ? 1 : 0;
  const k = feitos - no.es;
  if (k <= 0) return 0;
  if (k >= no.dur) return 1;
  const w = pesosPerfil(no.dur, perfilDe(obra, no.a));
  let acc = 0; for (let i = 0; i < k; i++) acc += w[i];
  return Math.min(1, acc);
}

/** % executado (0..100) de uma atividade até a data, pelas medições registradas; sem medição usa o campo pct. */
export function pctRealAte(obra, a, day) {
  const ms = (obra?.medicoesAtiv || []).filter((m) => m.atividadeId === a.id && toDay(m.data) <= day);
  if (!ms.length) return (obra?.medicoesAtiv || []).some((m) => m.atividadeId === a.id) ? 0 : Math.min(100, Math.max(0, Number(a.pct) || 0));
  ms.sort((x, y) => x.data.localeCompare(y.data) || x.criadoEm?.localeCompare?.(y.criadoEm || '') || 0);
  return Math.min(100, Math.max(0, Number(ms[ms.length - 1].pct) || 0));
}

/** Custo incorrido (despesas lançadas) até a data. */
export function incorridoAte(obra, day) {
  return (obra?.despesas || []).filter((d) => toDay(d.data) <= day).reduce((s, d) => s + (Number(d.valor) || 0), 0);
}

/** Avanço físico e financeiro (planejado e real) numa data. */
export function avanco(obra, calc, cron, day) {
  let pT = 0, pP = 0, pR = 0, cT = 0, cP = 0, ev = 0;
  for (const n of cron.nos.values()) {
    if (!n.folha) continue;
    const A = calc.ativ.get(n.id);
    const peso = pesoFisico(obra, A, n);
    const fp = fracPlanejada(n, cron.cal, day, obra);
    const fr = pctRealAte(obra, n.a, day) / 100;
    pT += peso; pP += peso * fp; pR += peso * fr;
    cT += A.custo; cP += A.custo * fp; ev += A.custo * fr;
  }
  const inc = incorridoAte(obra, day);
  return {
    fisicoPlan: pT ? (pP / pT) * 100 : 0, fisicoReal: pT ? (pR / pT) * 100 : 0, semPeso: pT === 0,
    finPlan: cP, finReal: inc, finTotal: cT, valorAgregado: ev,
    financeiroPct: cT ? (inc / cT) * 100 : 0,
  };
}

/** Distribuição diária planejada (índice de dia útil → [peso físico, valor R$ em centavos inteiros]). */
export function distribuicao(obra, calc, cron) {
  const folhas = [...cron.nos.values()].filter((n) => n.folha);
  const dia = new Map();
  const soma = (i, f, c) => { const v = dia.get(i) || [0, 0]; v[0] += f; v[1] += c; dia.set(i, v); };
  let pesoTotal = 0, centavosTotal = 0;
  for (const n of folhas) {
    const A = calc.ativ.get(n.id);
    const peso = pesoFisico(obra, A, n);
    const cent = Math.round(A.custo * 100);
    pesoTotal += peso; centavosTotal += cent;
    if (n.dur <= 0) { soma(n.es, peso, cent); continue; }
    const w = pesosPerfil(n.dur, perfilDe(obra, n.a));
    let usado = 0;
    w.forEach((x, k) => {
      const c = k === w.length - 1 ? cent - usado : Math.round(cent * x);
      usado += c;
      soma(n.es + k, peso * x, c);
    });
  }
  return { dia, pesoTotal, centavosTotal };
}

/**
 * Curva S planejada (e real) por período.
 * @returns {periodos:[{ini, fim, label, fisPer, fisAc, finPer, finAc, fisReal?, finReal?}], totalCusto, pesoTotal}
 */
export function curvaS(calc, cron, periodo = 'mes', obra = null) {
  const { dia, pesoTotal, centavosTotal } = distribuicao(obra, calc, cron);
  if (!dia.size) return { periodos: [], totalHH: 0, totalCusto: 0, pesoTotal: 0 };
  const idx = [...dia.keys()].sort((a, b) => a - b);
  const chave = (d) => {
    const p = dateParts(d);
    if (periodo === 'mes') return { k: `${p.y}-${p.m}`, ini: d - p.d + 1 };
    if (periodo === 'dia') return { k: String(d), ini: d };
    const seg = d - ((weekday(d) + 6) % 7);
    return { k: String(seg), ini: seg };
  };
  const per = new Map();
  for (const i of idx) {
    const d = cron.cal.date(i);
    const { k, ini } = chave(d);
    if (!per.has(k)) per.set(k, { ini, fis: 0, fin: 0 });
    const P = per.get(k);
    P.fis += dia.get(i)[0]; P.fin += dia.get(i)[1];
  }
  let fa = 0, ca = 0;
  const periodos = [...per.values()].sort((a, b) => a.ini - b.ini).map((P) => {
    fa += P.fis; ca += P.fin;
    const p = dateParts(P.ini);
    const fim = periodo === 'mes' ? Math.floor(Date.UTC(p.y, p.m + 1, 0) / 86400000) : periodo === 'dia' ? P.ini : P.ini + 6;
    const label = periodo === 'mes' ? `${MESES[p.m]}/${String(p.y).slice(2)}` : periodo === 'dia' ? fmtBR(P.ini).slice(0, 5) : `sem. ${fmtBR(P.ini).slice(0, 5)}`;
    return {
      ini: P.ini, fim, label,
      fisPer: pesoTotal ? (P.fis / pesoTotal) * 100 : 0, fisAc: pesoTotal ? (fa / pesoTotal) * 100 : 0,
      finPer: P.fin / 100, finAc: ca / 100,
    };
  });
  return { periodos, totalHH: calc.totalHH, totalCusto: centavosTotal / 100, pesoTotal };
}

/** Pontos reais (físico % e financeiro R$ acumulados) ao fim de cada período, até a data de referência. */
export function curvaReal(obra, calc, cron, periodos, ateDia) {
  return periodos.filter((p) => p.ini <= ateDia).map((p) => {
    const d = Math.min(p.fim, ateDia);
    const av = avanco(obra, calc, cron, d);
    return { day: d, fis: av.fisicoReal, fin: av.finReal };
  });
}
