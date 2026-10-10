// Cronograma pelo método do caminho crítico (CPM), em dias úteis.
//
// Índices: 0 = 1º dia útil a partir da data de início da obra. Uma atividade ocupa os dias [es, ef] (ef = es + dur − 1;
// atividade de duração 0 é marco: ef = es − 1).
//   FS (término→início): es ≥ ef(pred) + 1 + lag      ("3.2 TI-10" = lag −10 → 10 dias úteis de sobreposição)
//   SS (início→início):  es ≥ es(pred) + lag          ("3.1 II+5")
// Prioridade do início: início real > início fixado > predecessoras. Fim real substitui o fim calculado.
// Atividades de nível superior agregam as filhas (menor início, maior término). Ciclos são detectados e bloqueados.

import { filhosDe } from './model.js';
import { toDay, weekday } from './schedule.js';

export class Calendario {
  constructor({ inicio, dias = [1, 2, 3, 4, 5], feriados = [] }) {
    this.dias = new Set(dias.length ? dias : [1, 2, 3, 4, 5]);
    this.hol = new Set(feriados.map((f) => (typeof f === 'number' ? f : toDay(f.data || f))).filter((d) => d != null));
    let d = toDay(inicio), g = 0;
    while (!this.isWork(d) && g++ < 3660) d++;
    this.base = d;
    this.fwd = [d];
  }
  isWork(d) { return this.dias.has(weekday(d)) && !this.hol.has(d); }
  _ext() {
    let d = this.fwd[this.fwd.length - 1] + 1, g = 0;
    while (!this.isWork(d) && g++ < 3660) d++;
    this.fwd.push(d);
  }
  /** Data (número do dia) do i-ésimo dia útil (i pode ser negativo). */
  date(i) {
    if (i >= 0) { while (this.fwd.length <= i) this._ext(); return this.fwd[i]; }
    let d = this.base, k = 0, g = 0;
    while (k > i && g++ < 40000) { d--; if (this.isWork(d)) k--; }
    return d;
  }
  /** Índice do primeiro dia útil ≥ dia. */
  idxNext(day) {
    if (day >= this.base) {
      while (this.fwd[this.fwd.length - 1] < day && this.fwd.length < 60000) this._ext();
      let lo = 0, hi = this.fwd.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.fwd[m] >= day) hi = m; else lo = m + 1; }
      return lo;
    }
    let d = day, g = 0;
    while (!this.isWork(d) && g++ < 3660) d++;
    if (d >= this.base) return 0;
    let k = 0;
    for (let x = d; x < this.base; x++) if (this.isWork(x)) k++;
    return -k;
  }
  /** Índice do último dia útil ≤ dia. */
  idxPrev(day) {
    let d = day, g = 0;
    while (!this.isWork(d) && g++ < 3660) d--;
    return this.idxNext(d);
  }
  /** Quantidade de dias úteis já concluídos ao fim do dia `day` (para avanço planejado). */
  concluidosAte(day) { return this.idxPrev(day) + 1; }
}

export function calendarioDaObra(obra, lib) {
  return new Calendario({
    inicio: obra.inicio,
    dias: obra.calendario?.dias,
    feriados: [...(obra.calendario?.feriados || []), ...(lib?.feriadosGlobais || [])],
  });
}

/**
 * @param obra  obra v2
 * @param calc  resultado de calcular() (durações das folhas)
 * @returns { nos: Map id→nó, ordem, inicio, termino, durTotal, ciclo, cicloIds, cal }
 */
export function cronograma(obra, lib, calc, cal = calendarioDaObra(obra, lib)) {
  const filhos = filhosDe(obra);
  const nos = new Map();
  for (const a of obra.eap) {
    const A = calc.ativ.get(a.id);
    nos.set(a.id, {
      id: a.id, a, folha: A ? A.folha : true, dur: A ? A.dur : 0,
      preds: [], succs: [], es: 0, ef: -1, ls: 0, lf: 0, folga: 0, critico: false, ciclo: false, concluida: false,
      lfLim: Infinity, lsLim: Infinity,
    });
  }
  for (const d of obra.dependencias) {
    const s = nos.get(d.atividadeId), p = nos.get(d.predecessoraId);
    if (!s || !p || s === p) continue;
    const lag = Number(d.lag) || 0;
    s.preds.push({ no: p, tipo: d.tipo === 'SS' ? 'SS' : 'FS', lag });
    p.succs.push({ no: s, tipo: d.tipo === 'SS' ? 'SS' : 'FS', lag });
  }

  // Grafo para ordenação: predecessora → sucessora e filha → pai
  const indeg = new Map([...nos.keys()].map((k) => [k, 0]));
  const saidas = new Map([...nos.keys()].map((k) => [k, []]));
  const liga = (de, para) => { saidas.get(de).push(para); indeg.set(para, indeg.get(para) + 1); };
  for (const n of nos.values()) {
    for (const p of n.preds) liga(p.no.id, n.id);
    for (const f of filhos.get(n.id) || []) liga(f.id, n.id);
  }
  const fila = [...nos.keys()].filter((k) => indeg.get(k) === 0);
  const topo = [];
  while (fila.length) {
    const k = fila.shift(); topo.push(k);
    for (const t of saidas.get(k)) { indeg.set(t, indeg.get(t) - 1); if (indeg.get(t) === 0) fila.push(t); }
  }
  const cicloIds = [...nos.keys()].filter((k) => !topo.includes(k));
  for (const k of cicloIds) nos.get(k).ciclo = true;

  // Ida (início/término mais cedo)
  for (const k of [...topo, ...cicloIds]) {
    const n = nos.get(k), a = n.a;
    if (!n.folha) {
      const fs = (filhos.get(k) || []).map((f) => nos.get(f.id));
      n.es = Math.min(...fs.map((f) => f.es));
      n.ef = Math.max(...fs.map((f) => f.ef));
      n.dur = n.ef - n.es + 1;
      continue;
    }
    let es;
    if (a.inicioReal) es = cal.idxNext(toDay(a.inicioReal));
    else if (a.inicioFixado) es = cal.idxNext(toDay(a.inicioFixado));
    else {
      es = 0;
      for (const p of n.preds) {
        if (p.no.ciclo && !n.ciclo) continue;
        es = Math.max(es, p.tipo === 'SS' ? p.no.es + p.lag : p.no.ef + 1 + p.lag);
      }
      es = Math.max(0, es);
    }
    n.es = es;
    n.ef = es + n.dur - 1;
    if (a.fimReal) {
      n.ef = cal.idxPrev(toDay(a.fimReal));
      if (n.ef < n.es) n.es = n.ef;
      n.dur = n.ef - n.es + 1;
      n.concluida = true;
    }
  }

  const folhas = [...nos.values()].filter((n) => n.folha);
  const fim = folhas.length ? Math.max(...folhas.map((n) => Math.max(n.ef, n.es - 1))) : -1;

  // Volta (início/término mais tarde) — pais antes das filhas (ordem topológica reversa)
  for (const k of [...topo].reverse()) {
    const n = nos.get(k);
    const pai = n.a.parentId ? nos.get(n.a.parentId) : null;
    let lf = fim, lsCap = Infinity;
    if (pai) {
      lf = Math.min(lf, pai.lfLim);
      if (n.es === pai.es) lsCap = Math.min(lsCap, pai.lsLim);
    }
    for (const s of n.succs) {
      if (s.tipo === 'SS') lsCap = Math.min(lsCap, s.no.ls - s.lag);
      else lf = Math.min(lf, s.no.ls - 1 - s.lag);
    }
    if (!n.folha) { n.lfLim = lf; n.lsLim = lsCap; continue; }
    let ls = Math.min(lf - n.dur + 1, lsCap);
    n.ls = ls; n.lf = ls + n.dur - 1;
    n.folga = n.ls - n.es;
    n.critico = !n.ciclo && !n.concluida && n.folga <= 0;
  }
  // Níveis superiores: folga = menor folga das filhas; LS/LF agregados
  for (const k of topo) {
    const n = nos.get(k);
    if (n.folha) continue;
    const fs = (filhos.get(k) || []).map((f) => nos.get(f.id));
    n.ls = Math.min(...fs.map((f) => f.ls)); n.lf = Math.max(...fs.map((f) => f.lf));
    n.folga = Math.min(...fs.map((f) => f.folga));
    n.critico = fs.some((f) => f.critico);
    n.concluida = fs.every((f) => f.concluida);
  }

  for (const n of nos.values()) {
    n.inicio = cal.date(n.es);
    n.termino = n.dur > 0 ? cal.date(n.ef) : n.inicio;
  }
  const inicio = folhas.length ? cal.date(Math.min(...folhas.map((n) => n.es))) : cal.base;
  return {
    nos, cal, ciclo: cicloIds.length > 0, cicloIds,
    inicio, termino: folhas.length ? cal.date(Math.max(0, fim)) : cal.base,
    durTotal: folhas.length ? fim - Math.min(...folhas.map((n) => n.es)) + 1 : 0,
  };
}

/** Testa se ligar `predId` como predecessora de `ativId` cria ciclo (inclui relações pai/filha). */
export function criaCiclo(obra, ativId, predIds) {
  const filhos = filhosDe(obra);
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const d of obra.dependencias) if (d.atividadeId !== ativId) add(d.predecessoraId, d.atividadeId);
  for (const p of predIds) add(p, ativId);
  for (const a of obra.eap) for (const f of filhos.get(a.id) || []) add(f.id, a.id);
  // a partir de ativId, alcança alguma das predecessoras?
  const alvo = new Set(predIds), vis = new Set(), pilha = [ativId];
  while (pilha.length) {
    const x = pilha.pop();
    if (vis.has(x)) continue; vis.add(x);
    for (const y of adj.get(x) || []) { if (alvo.has(y)) return true; pilha.push(y); }
  }
  return false;
}
