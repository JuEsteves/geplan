// Curva S física (ponderada por HH) e financeira (custo alocado), com distribuição linear
// nos dias úteis de cada atividade, acumulada por semana ou por mês.

import { dateParts, MESES, fmtBR, weekday } from './schedule.js';

/** Avanço planejado (0..1) de uma folha ao fim do dia `day`. */
export function fracPlanejada(no, cal, day) {
  const feitos = cal.concluidosAte(day);
  if (no.dur <= 0) return feitos > no.es ? 1 : 0;
  return Math.min(1, Math.max(0, (feitos - no.es) / no.dur));
}

/** Avanço físico e financeiro (planejado e real) numa data. */
export function avanco(obra, calc, cron, day) {
  let hhT = 0, hhP = 0, hhR = 0, cT = 0, cP = 0, cR = 0, durT = 0, durP = 0, durR = 0;
  for (const n of cron.nos.values()) {
    if (!n.folha) continue;
    const A = calc.ativ.get(n.id);
    const fp = fracPlanejada(n, cron.cal, day);
    const fr = Math.min(100, Math.max(0, Number(n.a.pct) || 0)) / 100;
    hhT += A.hh; hhP += A.hh * fp; hhR += A.hh * fr;
    cT += A.custo; cP += A.custo * fp; cR += A.custo * fr;
    durT += n.dur; durP += n.dur * fp; durR += n.dur * fr;
  }
  // sem HH no orçamento, o avanço físico usa a duração como peso
  const [t, p, r] = hhT > 0 ? [hhT, hhP, hhR] : [durT, durP, durR];
  return {
    fisicoPlan: t ? (p / t) * 100 : 0, fisicoReal: t ? (r / t) * 100 : 0,
    finPlan: cP, finReal: cR, finTotal: cT, pesoHH: hhT > 0,
  };
}

/**
 * Pontos da curva planejada por período.
 * @returns {periodos:[{ini, fim, label, fisPer, fisAc, finPer, finAc}], totalHH, totalCusto}
 */
export function curvaS(calc, cron, periodo = 'mes') {
  const folhas = [...cron.nos.values()].filter((n) => n.folha);
  if (!folhas.length) return { periodos: [], totalHH: 0, totalCusto: 0 };
  const totalHH = folhas.reduce((s, n) => s + calc.ativ.get(n.id).hh, 0);
  const pesoHH = totalHH > 0;
  const totalPeso = pesoHH ? totalHH : folhas.reduce((s, n) => s + n.dur, 0);
  const totalCusto = folhas.reduce((s, n) => s + calc.ativ.get(n.id).custo, 0);

  // distribuição diária (índice de dia útil → valores)
  const dia = new Map();
  const soma = (i, f, c) => { const v = dia.get(i) || [0, 0]; v[0] += f; v[1] += c; dia.set(i, v); };
  for (const n of folhas) {
    const A = calc.ativ.get(n.id);
    const peso = pesoHH ? A.hh : n.dur;
    if (n.dur <= 0) { soma(n.es, peso, A.custo); continue; }
    for (let i = n.es; i <= n.ef; i++) soma(i, peso / n.dur, A.custo / n.dur);
  }
  const idx = [...dia.keys()].sort((a, b) => a - b);
  const chave = (d) => {
    const p = dateParts(d);
    if (periodo === 'mes') return { k: `${p.y}-${p.m}`, ini: d - p.d + 1 };
    const seg = d - ((weekday(d) + 6) % 7); // segunda-feira da semana
    return { k: String(seg), ini: seg };
  };
  const per = new Map();
  for (const i of idx) {
    const d = cron.cal.date(i);
    const { k, ini } = chave(d);
    if (!per.has(k)) per.set(k, { ini, fim: d, fis: 0, fin: 0 });
    const P = per.get(k);
    P.fim = d; P.fis += dia.get(i)[0]; P.fin += dia.get(i)[1];
  }
  let fa = 0, ca = 0;
  const periodos = [...per.values()].sort((a, b) => a.ini - b.ini).map((P) => {
    fa += P.fis; ca += P.fin;
    const p = dateParts(P.ini);
    const label = periodo === 'mes' ? `${MESES[p.m]}/${String(p.y).slice(2)}` : `sem. ${fmtBR(P.ini).slice(0, 5)}`;
    const fimPeriodo = periodo === 'mes' ? (() => { const x = new Date(Date.UTC(p.y, p.m + 1, 0)); return Math.floor(x.getTime() / 86400000); })() : P.ini + 6;
    return {
      ini: P.ini, fim: fimPeriodo, label,
      fisPer: totalPeso ? (P.fis / totalPeso) * 100 : 0, fisAc: totalPeso ? (fa / totalPeso) * 100 : 0,
      finPer: P.fin, finAc: ca,
    };
  });
  return { periodos, totalHH, totalCusto, pesoHH };
}
