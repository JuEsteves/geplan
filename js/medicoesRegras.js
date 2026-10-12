// Regras das medições por atividade e profissional, sem banco nem tela (testadas em tests/index.html). O banco
// (migração 0009, função medicao_acao) aplica as mesmas regras e é quem grava; aqui elas servem para a tela prever,
// validar e explicar.
//
//  • Físico × pagamento: o boletim mede, por atividade, o EXECUTADO NO PERÍODO (avanço físico). A produção de cada
//    profissional é o que entra no pagamento. A soma das produções em quantidade não passa do executado (decisão da
//    empresa: o sistema recusa). Produção em dias, horas ou % de serviço contratado não entra nessa soma.
//  • Acumulado: anterior (última medição de avanço antes do início do período) + executado no período. Saldo =
//    prevista − acumulado (nunca negativo).
//  • Valor: por unidade, diária e hora = quantidade aprovada × valor do vínculo; valor fixo por serviço = valor
//    contratado × % aprovado; "outro" e "sem vínculo" não têm cálculo automático. O valor é congelado na aprovação:
//    mudar o vínculo depois não altera boletins aprovados.
//  • Pagamento: "Pago" só quando a despesa lançada no Financeiro tem pagamentos que cobrem o valor. Aprovação da
//    medição e pagamento são coisas separadas.

export const FORMAS = {
  unidade: { rotulo: 'Por unidade produzida', medida: 'qtd' },
  empreitada: { rotulo: 'Valor fixo por serviço', medida: 'percentual' },
  diaria: { rotulo: 'Diária', medida: 'dias' },
  hora: { rotulo: 'Hora', medida: 'horas' },
  outro: { rotulo: 'Outro critério (sem cálculo automático)', medida: null },
};
export const MEDIDAS = { qtd: 'Quantidade', dias: 'Dias', horas: 'Horas', percentual: '% do serviço contratado' };
export const STATUS_BOLETIM = {
  rascunho: { rotulo: 'Rascunho', cls: '' }, conferencia: { rotulo: 'Enviado para conferência', cls: 'info' },
  devolvido: { rotulo: 'Devolvido para correção', cls: 'crit' }, aprovado: { rotulo: 'Aprovado', cls: 'good' },
};
export const numeroBoletim = (n) => `MED-${String(n).padStart(4, '0')}`;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** Vínculo vigente (mesma regra do banco): data dentro da vigência, atividade abrangida; o específico vence o geral. */
export function vinculoVigente(vinculos, workerId, projectId, activityId, data) {
  const ok = (vinculos || []).filter((a) => !a.deleted_at && a.worker_id === workerId && a.project_id === projectId
    && a.valid_from <= data && (!a.valid_to || a.valid_to >= data)
    && (!(a.activity_ids || []).length || a.activity_ids.includes(activityId)));
  ok.sort((a, b) => Number(!(a.activity_ids || []).length) - Number(!(b.activity_ids || []).length) || String(b.valid_from).localeCompare(String(a.valid_from)));
  return ok[0] || null;
}

/** Valor a pagar de uma linha de produção. Retorna { valor, erro } (erro = medida incompatível com o vínculo). */
export function valorLinha(vinculo, medida, quantidade) {
  if (!vinculo) return { valor: null, tipo: 'sem_vinculo' };
  const f = FORMAS[vinculo.pay_type];
  if (f?.medida && f.medida !== medida) return { valor: null, tipo: vinculo.pay_type, erro: `o vínculo é "${f.rotulo}", mas a produção está em "${MEDIDAS[medida]}"` };
  const q = Number(quantidade) || 0;
  if (vinculo.pay_type === 'empreitada') return { valor: r2((Number(vinculo.contract_amount) || 0) * q / 100), tipo: 'empreitada' };
  if (vinculo.pay_type === 'outro') return { valor: null, tipo: 'outro' };
  return { valor: r2((Number(vinculo.unit_price) || 0) * q), tipo: vinculo.pay_type };
}

/** Produção (em quantidade) × executado no período. */
export function conferirProducao(item, linhas, { aprovada = false } = {}) {
  const soma = r4((linhas || []).filter((l) => l.measure === 'qtd').reduce((a, l) => a + Number(aprovada && l.approved_qty != null ? l.approved_qty : l.produced_qty || 0), 0));
  const exec = Number(item.period_qty) || 0;
  return { soma, executado: exec, ok: soma <= exec + 0.00005, sobra: r4(Math.max(0, exec - soma)) };
}

/** Acumulado anterior e novo (prévia antes da aprovação), a partir das medições de avanço da obra. */
export function previaAcumulado(medicoesAtividade, item, inicioPeriodo) {
  const ant = [...(medicoesAtividade || [])].filter((m) => m.data < inicioPeriodo).sort((a, b) => a.data.localeCompare(b.data)).pop();
  const prev = Number(item.planned_qty) > 0;
  const anteriorPct = ant ? Number(ant.pct) || 0 : 0;
  if (prev) {
    const anterior = r4(ant?.qtdAcum != null ? Number(ant.qtdAcum) : anteriorPct / 100 * Number(item.planned_qty));
    const acumulado = r4(anterior + (Number(item.period_qty) || 0));
    return { anterior, acumulado, saldo: r4(Math.max(0, Number(item.planned_qty) - acumulado)), pct: Math.min(100, acumulado / Number(item.planned_qty) * 100) };
  }
  // sem quantidade prevista: avanço só com % informado (sem ele, a produção é registrada mas o avanço não é calculável)
  const pct = item.period_pct == null ? null : Math.min(100, anteriorPct + Number(item.period_pct));
  return { anterior: null, acumulado: null, saldo: null, anteriorPct, pct };
}

/** Situação do pagamento de uma linha aprovada (pela despesa no Financeiro). */
export function situacaoPagamento(valor, despesa) {
  if (valor == null) return { rotulo: 'Sem valor automático', cls: '' };
  if (!(valor > 0)) return { rotulo: '—', cls: '' };
  if (!despesa) return { rotulo: 'A lançar no Financeiro', cls: 'warn' };
  const pago = (despesa.pagamentos || []).reduce((a, p) => a + (Number(p.valor) || 0), 0);
  const total = Number(despesa.valor) || 0;
  if (pago <= 0) return { rotulo: 'A pagar', cls: 'warn', pago: 0 };
  if (pago + 0.005 < total) return { rotulo: 'Pago em parte', cls: 'info', pago };
  return { rotulo: 'Pago', cls: 'good', pago };
}

/** Linhas do resumo por profissional (uma por linha de produção), já com valores quando visíveis. */
export function linhasResumo({ boletins, itens, linhas, pagamentos, filtros = {} }) {
  const B = new Map(boletins.map((b) => [b.id, b]));
  const I = new Map(itens.map((i) => [i.id, i]));
  const P = new Map((pagamentos || []).map((p) => [p.worker_line_id, p]));
  return linhas.map((l) => ({ l, i: I.get(l.item_id), b: B.get(l.sheet_id), p: P.get(l.id) || null }))
    .filter(({ i, b, l }) => b && i && !b.deleted_at
      && (!filtros.obra || b.project_id === filtros.obra) && (!filtros.profissional || l.worker_id === filtros.profissional)
      && (!filtros.atividade || i.activity_id === filtros.atividade) && (!filtros.fases || filtros.fases.has(i.activity_id))
      && (!filtros.de || b.period_end >= filtros.de) && (!filtros.ate || b.period_start <= filtros.ate)
      && (!filtros.status || b.status === filtros.status));
}

/** Totais por chave (ex.: profissional ou atividade). */
export function somarPor(lista, chave) {
  const m = new Map();
  for (const x of lista) {
    const k = chave(x);
    const t = m.get(k) || { produzida: 0, aprovada: 0, valor: 0, temValor: false, n: 0 };
    t.produzida = r4(t.produzida + (Number(x.l.produced_qty) || 0));
    t.aprovada = r4(t.aprovada + (x.b.status === 'aprovado' ? Number(x.l.approved_qty ?? x.l.produced_qty) || 0 : 0));
    if (x.p?.amount != null) { t.valor = r2(t.valor + Number(x.p.amount)); t.temValor = true; }
    t.n++;
    m.set(k, t);
  }
  return m;
}
