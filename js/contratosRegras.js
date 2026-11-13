// Regras dos contratos de mão de obra sem banco e sem tela (testadas em tests/index.html, grupo 24). Quem decide o
// que vale é o banco (migração 0015: ativar, lançar parcela, encerrar); aqui ficam os cálculos para a tela.

export const FORMAS_PAGAMENTO = {
  medicao: 'Por medição (boletins)', mensal: 'Mensal', parcelas: 'Em parcelas', avulso: 'Avulso (lançado à mão no Financeiro)',
};
export const STATUS_CONTRATO = {
  rascunho: { rotulo: 'Rascunho', cls: '' }, vigente: { rotulo: 'Vigente', cls: 'good' },
  concluido: { rotulo: 'Concluído', cls: 'info' }, rescindido: { rotulo: 'Rescindido', cls: 'crit' },
};
export const numeroContrato = (n) => `CTR-${String(n).padStart(4, '0')}`;
const ATIVOS = ['rascunho', 'vigente'];

/** Soma meses a uma data "AAAA-MM-DD" mantendo o dia (31/01 + 1 mês = 28 ou 29/02). */
export function somarMeses(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

/** Parcelas iguais (centavos que sobram vão na última), uma por mês a partir do 1º vencimento. */
export function gerarParcelas(valor, n, primeiroVencimento) {
  const total = Math.round(Number(valor) * 100);
  const qtd = Math.max(1, Math.floor(Number(n) || 1));
  if (!(total > 0)) throw new Error('Informe o valor do contrato.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(primeiroVencimento || '')) throw new Error('Informe o 1º vencimento.');
  const base = Math.floor(total / qtd);
  return Array.from({ length: qtd }, (_, i) => ({
    number: i + 1, due_date: somarMeses(primeiroVencimento, i), amount: (i === qtd - 1 ? total - base * (qtd - 1) : base) / 100,
  }));
}

/** Lançado e saldo do contrato a partir das despesas da obra ligadas ao compromisso dele (parcelas e medições). */
export function resumoContrato(k, despesas = []) {
  const ligadas = k.contract_id ? despesas.filter((d) => d.compromissoId === k.contract_id) : [];
  const lancado = ligadas.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const pago = ligadas.reduce((s, d) => s + (d.pagamentos || []).reduce((a, p) => a + (Number(p.valor) || 0), 0), 0);
  const valor = k.amount == null ? null : Number(k.amount);
  return { lancado, pago, saldo: valor == null ? null : Math.round((valor - lancado) * 100) / 100,
    pct: valor ? Math.min(100, Math.round((lancado / valor) * 1000) / 10) : null };
}

/**
 * Quando contratar: fases (etapas raiz) que começam até `janela` dias depois de hoje (ou já começaram e não terminaram)
 * e não estão no escopo de nenhum contrato em rascunho ou vigente. `fases` = [{ id, codigo, descricao, inicio, termino }]
 * com dias no formato do cronograma; ordenadas pela data de início.
 */
export function fasesSemContrato(fases, contratos, hoje, janela = 60) {
  const cobertas = new Set(contratos.filter((k) => ATIVOS.includes(k.status) && !k.deleted_at).flatMap((k) => k.phase_ids || []));
  return fases.filter((f) => !cobertas.has(f.id) && f.inicio != null && f.inicio <= hoje + janela && (f.termino == null || f.termino >= hoje))
    .sort((a, b) => a.inicio - b.inicio)
    .map((f) => ({ ...f, diasAte: f.inicio - hoje }));
}
