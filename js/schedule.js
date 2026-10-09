// Cálculo do cronograma: durações a partir das composições, calendário de dias úteis,
// predecessoras (término→início com folga/adiantamento) e caminho crítico.
//
// As datas são tratadas como "número do dia" (dias desde 1970-01-01, UTC) para evitar
// problemas de fuso/horário de verão. Os índices de dia útil começam em 0 = 1º dia útil da obra.

const MS_DAY = 86400000;
export const toDay = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
};
export const toISO = (day) => new Date(day * MS_DAY).toISOString().slice(0, 10);
export const fmtBR = (day) => {
  if (day == null) return '';
  const d = new Date(day * MS_DAY);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
export const weekday = (day) => (((day + 4) % 7) + 7) % 7; // 0 = domingo
export const todayDay = () => {
  const n = new Date();
  return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / MS_DAY);
};
export const todayISO = () => toISO(todayDay());

export class WorkCal {
  constructor(cal, inicioISO) {
    const dias = cal?.dias?.length ? cal.dias : [1, 2, 3, 4, 5];
    this.dias = new Set(dias);
    this.hol = new Set((cal?.feriados || []).map((f) => toDay(f.data)));
    this.start = toDay(inicioISO) ?? todayDay();
    let d = this.start, guard = 0;
    while (!this.isWork(d) && guard++ < 3660) d++;
    this.first = d;
    this.days = [];
  }
  isWork(d) { return this.dias.has(weekday(d)) && !this.hol.has(d); }
  _extend() {
    let d = this.days.length ? this.days[this.days.length - 1] + 1 : this.first;
    let guard = 0;
    while (!this.isWork(d) && guard++ < 3660) d++;
    this.days.push(d);
  }
  /** Data (número do dia) do i-ésimo dia útil. */
  dateOf(i) {
    i = Math.max(0, i);
    while (this.days.length <= i) this._extend();
    return this.days[i];
  }
  /** Quantidade de dias úteis no intervalo [1º dia útil, d]. */
  countUpTo(d) {
    if (d < this.first) return 0;
    while (this.days[this.days.length - 1] === undefined || (this.days[this.days.length - 1] < d && this.days.length < 40000)) this._extend();
    let lo = 0, hi = this.days.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.days[mid] <= d) lo = mid + 1; else hi = mid; }
    return lo;
  }
}

/** Códigos tipo "2" (etapa) e "2.3" (serviço) a partir da ordem atual. */
export function buildCodes(obra) {
  const byCode = new Map(), byId = new Map();
  obra.etapas.forEach((e, ei) => {
    const ec = String(ei + 1);
    byCode.set(ec, e.id); byId.set(e.id, ec);
    e.servicos.forEach((s, si) => {
      const sc = `${ei + 1}.${si + 1}`;
      byCode.set(sc, s.id); byId.set(s.id, sc);
    });
  });
  return { byCode, byId };
}

export function formatPreds(preds, codes) {
  return (preds || [])
    .filter((p) => codes.byId.has(p.ref))
    .map((p) => codes.byId.get(p.ref) + (p.lag > 0 ? `+${p.lag}` : p.lag < 0 ? `${p.lag}` : ''))
    .join('; ');
}

/** "1.2; 3+2; 2.1-1" → [{ref, lag}]. Lança erro com mensagem amigável. */
export function parsePreds(text, codes, selfId) {
  const out = [];
  const tokens = String(text || '').replace(/\s*([+-])\s*/g, '$1').split(/[;,\s]+/).filter(Boolean);
  for (const t of tokens) {
    const m = t.match(/^(\d+(?:\.\d+)?)([+-]\d+)?$/);
    if (!m) throw new Error(`"${t}" não é válido. Use códigos como 1.2, 3 ou 2.1+2`);
    const ref = codes.byCode.get(m[1]);
    if (!ref) throw new Error(`Código ${m[1]} não existe`);
    if (ref === selfId) throw new Error('Um serviço não pode depender dele mesmo');
    out.push({ ref, lag: m[2] ? parseInt(m[2], 10) : 0 });
  }
  return out;
}

/**
 * Calcula o cronograma da obra.
 * Retorna linhas por serviço e resumo por etapa, com índices de dia útil (es/ef) e datas.
 */
export function compute(obra, lib) {
  const comps = new Map(lib.composicoes.map((c) => [c.id, c]));
  const jornada = Number(obra.calendario?.jornada) > 0 ? Number(obra.calendario.jornada) : 8;
  const cal = new WorkCal(obra.calendario, obra.inicio);
  const codes = buildCodes(obra);

  const rows = [];
  const byId = new Map();
  const etapaChildren = new Map();
  obra.etapas.forEach((e, ei) => {
    etapaChildren.set(e.id, e.servicos.map((s) => s.id));
    e.servicos.forEach((s, si) => {
      const c = comps.get(s.composicaoId);
      const qtd = Number(s.quantidade) || 0;
      const coef = c ? Number(c.coef) || 0 : 0;
      const horas = qtd * coef;
      const equipes = Math.max(1, Number(s.equipes) || 1);
      const durCalc = horas > 0 ? Math.max(1, Math.ceil(horas / (equipes * jornada) - 1e-9)) : 0;
      const fixa = s.duracaoFixa !== '' && s.duracaoFixa != null && !isNaN(Number(s.duracaoFixa));
      const dur = fixa ? Math.max(0, Math.round(Number(s.duracaoFixa))) : durCalc;
      const r = {
        id: s.id, s, etapa: e, etapaIndex: ei, code: `${ei + 1}.${si + 1}`,
        comp: c || null, nome: s.descricao?.trim() || c?.nome || '(sem composição)',
        unidade: c?.unidade || '', coef, qtd, horas, equipes, durCalc, dur, fixa,
        preds: [], succs: [], es: 0, ef: -1, ls: 0, lf: 0, folga: 0, critico: false, ciclo: false,
      };
      rows.push(r); byId.set(r.id, r);
    });
  });

  // Expande predecessoras (etapa → todos os seus serviços)
  for (const r of rows) {
    for (const p of r.s.preds || []) {
      const lag = Number(p.lag) || 0;
      const targets = etapaChildren.has(p.ref) ? etapaChildren.get(p.ref) : byId.has(p.ref) ? [p.ref] : [];
      for (const t of targets) {
        if (t === r.id) continue;
        r.preds.push({ row: byId.get(t), lag });
        byId.get(t).succs.push({ row: r, lag });
      }
    }
  }

  // Ordenação topológica (Kahn)
  const indeg = new Map(rows.map((r) => [r.id, r.preds.length]));
  const queue = rows.filter((r) => r.preds.length === 0);
  const order = [];
  while (queue.length) {
    const r = queue.shift(); order.push(r);
    for (const sc of r.succs) {
      indeg.set(sc.row.id, indeg.get(sc.row.id) - 1);
      if (indeg.get(sc.row.id) === 0) queue.push(sc.row);
    }
  }
  const cycleRows = rows.filter((r) => !order.includes(r));
  cycleRows.forEach((r) => { r.ciclo = true; });

  // Ida: início mais cedo
  for (const r of [...order, ...cycleRows]) {
    let es = 0;
    for (const p of r.preds) if (!p.row.ciclo || r.ciclo) es = Math.max(es, p.row.ef + 1 + p.lag);
    r.es = Math.max(0, es);
    r.ef = r.es + r.dur - 1;
  }
  const endIdx = rows.length ? Math.max(...rows.map((r) => Math.max(r.ef, r.es))) : -1;

  // Volta: término mais tarde → folga e caminho crítico
  for (const r of [...order].reverse()) {
    let lf = endIdx;
    for (const sc of r.succs) lf = Math.min(lf, sc.row.ls - 1 - sc.lag);
    r.lf = lf;
    r.ls = lf - r.dur + 1;
    r.folga = Math.max(0, r.ls - r.es);
    r.critico = r.ls - r.es <= 0 && !r.ciclo;
  }

  for (const r of rows) {
    r.inicio = cal.dateOf(r.es);
    r.termino = r.dur > 0 ? cal.dateOf(r.ef) : r.inicio;
    r.peso = r.horas > 0 ? r.horas : r.dur * jornada;
  }
  const pesoTotal = rows.reduce((a, r) => a + r.peso, 0);
  if (pesoTotal === 0) rows.forEach((r) => { r.peso = 1; });

  const etapas = obra.etapas.map((e, ei) => {
    const ch = rows.filter((r) => r.etapa === e);
    const nomeEtapa = lib.etapas.find((x) => x.id === e.etapaId)?.nome || '(etapa removida)';
    if (!ch.length) return { id: e.id, e, code: String(ei + 1), nome: nomeEtapa, rows: ch, vazia: true, horas: 0, dur: 0 };
    const es = Math.min(...ch.map((r) => r.es));
    const ef = Math.max(...ch.map((r) => Math.max(r.ef, r.es)));
    const peso = ch.reduce((a, r) => a + r.peso, 0);
    return {
      id: e.id, e, code: String(ei + 1), nome: nomeEtapa, rows: ch, es, ef,
      inicio: cal.dateOf(es), termino: cal.dateOf(ef), dur: ef - es + 1,
      horas: ch.reduce((a, r) => a + r.horas, 0), peso,
      pct: peso ? ch.reduce((a, r) => a + r.peso * (Number(r.s.pct) || 0), 0) / peso : 0,
      critico: ch.some((r) => r.critico),
    };
  });

  const hasRows = rows.length > 0;
  return {
    rows, etapas, cal, codes, jornada, byId,
    ciclo: cycleRows.length > 0, cycleRows,
    inicio: hasRows ? cal.dateOf(0) : cal.first,
    termino: hasRows ? cal.dateOf(Math.max(0, endIdx)) : cal.first,
    durTotal: hasRows ? endIdx + 1 : 0,
    horasTotal: rows.reduce((a, r) => a + r.horas, 0),
  };
}

/** Fração planejada (0..1) de um serviço concluída até o fim do dia `statusDay`. */
export function plannedFrac(r, cal, statusDay) {
  const done = cal.countUpTo(statusDay); // dias úteis completos até a data
  if (r.dur === 0) return done > r.es ? 1 : 0;
  return Math.min(1, Math.max(0, (done - r.es) / r.dur));
}

export function progress(sched, statusDay) {
  const tot = sched.rows.reduce((a, r) => a + r.peso, 0) || 1;
  const plan = sched.rows.reduce((a, r) => a + r.peso * plannedFrac(r, sched.cal, statusDay), 0) / tot * 100;
  const real = sched.rows.reduce((a, r) => a + r.peso * (Number(r.s.pct) || 0), 0) / tot;
  return { plan, real };
}

export function statusOf(r, cal, statusDay) {
  const pct = Number(r.s.pct) || 0;
  const plan = plannedFrac(r, cal, statusDay) * 100;
  if (pct >= 100) return { key: 'done', label: 'Concluído', cls: 'good', plan };
  if (pct + 0.5 < plan) return { key: 'late', label: 'Atrasado', cls: 'crit', plan };
  if (pct === 0 && plan === 0) return { key: 'todo', label: 'Não iniciado', cls: '', plan };
  if (pct > plan + 0.5) return { key: 'ahead', label: 'Adiantado', cls: 'info', plan };
  return { key: 'ok', label: 'Em dia', cls: 'info', plan };
}

/** Curva S planejada: % acumulado ao fim de cada dia útil. */
export function sCurve(sched) {
  const tot = sched.rows.reduce((a, r) => a + r.peso, 0) || 1;
  const pts = [{ day: sched.cal.first - 1, pct: 0 }];
  for (let i = 0; i < sched.durTotal; i++) {
    let acc = 0;
    for (const r of sched.rows) {
      const f = r.dur === 0 ? (i + 1 > r.es ? 1 : 0) : Math.min(1, Math.max(0, (i + 1 - r.es) / r.dur));
      acc += r.peso * f;
    }
    pts.push({ day: sched.cal.dateOf(i), pct: (acc / tot) * 100 });
  }
  return pts;
}

/** Feriados nacionais do Brasil (inclui Carnaval e Corpus Christi, que são ponto facultativo). */
export function feriadosNacionais(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  const pascoa = Math.floor(Date.UTC(ano, mes - 1, dia) / MS_DAY);
  const fixo = (mm, dd, desc) => ({ data: `${ano}-${mm}-${dd}`, desc });
  return [
    fixo('01', '01', 'Confraternização Universal'),
    { data: toISO(pascoa - 48), desc: 'Carnaval (segunda)' },
    { data: toISO(pascoa - 47), desc: 'Carnaval (terça)' },
    { data: toISO(pascoa - 2), desc: 'Sexta-feira Santa' },
    fixo('04', '21', 'Tiradentes'),
    fixo('05', '01', 'Dia do Trabalho'),
    { data: toISO(pascoa + 60), desc: 'Corpus Christi' },
    fixo('09', '07', 'Independência'),
    fixo('10', '12', 'Nossa Senhora Aparecida'),
    fixo('11', '02', 'Finados'),
    fixo('11', '15', 'Proclamação da República'),
    fixo('11', '20', 'Consciência Negra'),
    fixo('12', '25', 'Natal'),
  ];
}

export const fmtNum = (n, dec = 2) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: dec });
