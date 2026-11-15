// Regras da medição por contrato sem banco e sem tela (testadas em tests/index.html, grupo 25). Quem decide o que vale
// é o banco (migração 0016: fechar medição, aditivo/glosa, pagar, estornar); aqui ficam os cálculos para a tela, com os
// mesmos arredondamentos do banco (valor do item e de cada linha arredondados a centavos).

export const FORMAS_MEDICAO = {
  percentual: { rotulo: 'Por porcentagem', texto: 'Etapas com peso (%) do contrato; em cada medição, o % executado de cada etapa.' },
  ambiente: { rotulo: 'Por ambiente', texto: 'Itens por ambiente com unidade, quantidade e preço; em cada medição, a quantidade executada.' },
};
export const numeroMedicao = (n) => `Medição nº ${n}`;
export const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const n0 = (x) => Number(x) || 0;
const vivos = (xs) => (xs || []).filter((x) => !x.deleted_at);

/** Valor de um item: percentual = peso × valor do contrato; ambiente = qtd × preço; aditivo/glosa = valor do item. */
export function valorItem(i, k) {
  if (i.kind === 'servico' && k.measure_mode === 'percentual') return r2((n0(i.weight_pct) / 100) * n0(k.amount));
  if (i.quantity != null && i.unit_price != null) return r2(n0(i.quantity) * n0(i.unit_price));
  return n0(i.amount);
}

/** Fração executada de um item a partir do acumulado informado (quantidade, se o item tem quantidade; senão %). */
export function fracao(l, i) {
  if (!l) return 0;
  if (l.qty_acum != null && n0(i.quantity) > 0) return Math.min(n0(l.qty_acum) / n0(i.quantity), 1);
  return n0(l.pct_acum) / 100;
}

/**
 * Último acumulado de cada item até a medição `m` (ela inclusive; das anteriores, só as fechadas).
 * Devolve Map(item_id → linha).
 */
export function acumuladoAte(m, medicoes, linhas) {
  const validas = vivos(medicoes).filter((x) => x.contract_id === m.contract_id && (x.id === m.id || (x.status === 'fechada' && x.number < m.number)))
    .sort((a, b) => a.number - b.number);
  const ult = new Map();
  for (const x of validas) for (const l of linhas.filter((y) => y.measurement_id === x.id)) ult.set(l.item_id, l);
  return ult;
}

/** Valor executado acumulado até a medição `m` (mesma conta do banco: public.mo_acumulado). */
export function valorAcumulado(k, itens, medicoes, linhas, m) {
  const ult = acumuladoAte(m, medicoes, linhas);
  return r2(vivos(itens).filter((i) => i.contract_id === k.id && i.kind !== 'glosa')
    .reduce((s, i) => s + r2(fracao(ult.get(i.id), i) * valorItem(i, k)), 0));
}

/** Prévia de uma medição em rascunho: valor do período, retenção e líquido. Fechada: os valores gravados pelo banco. */
export function valoresMedicao(k, itens, medicoes, linhas, m) {
  if (m.status === 'fechada') return { bruto: n0(m.gross), retencao: n0(m.retention), liquido: n0(m.net), pctRetencao: n0(m.retention_pct) };
  const anterior = vivos(medicoes).filter((x) => x.contract_id === k.id && x.status === 'fechada').reduce((s, x) => s + n0(x.gross), 0);
  const bruto = r2(valorAcumulado(k, itens, medicoes, linhas, m) - anterior);
  const retencao = r2((bruto * n0(k.retention_pct)) / 100);
  return { bruto, retencao, liquido: r2(bruto - retencao), pctRetencao: n0(k.retention_pct) };
}

/** Confere a planilha antes da 1ª medição (mesma regra do banco ao fechar). */
export function conferirPlanilha(k, itens) {
  const sv = vivos(itens).filter((i) => i.contract_id === k.id && i.kind === 'servico');
  if (!sv.length) return { ok: false, msg: 'Monte a planilha do contrato (itens a medir).', soma: 0 };
  if (k.measure_mode === 'percentual') {
    const falta = sv.filter((i) => i.weight_pct == null).length;
    const soma = r2(sv.reduce((s, i) => s + n0(i.weight_pct), 0));
    if (falta) return { ok: false, msg: `${falta} item(ns) sem peso (%).`, soma };
    if (Math.abs(soma - 100) > 0.01) return { ok: false, msg: `Os pesos somam ${soma.toLocaleString('pt-BR')}% (devem somar 100%).`, soma };
    return { ok: true, msg: '', soma };
  }
  const falta = sv.filter((i) => i.quantity == null || i.unit_price == null).length;
  const soma = r2(sv.reduce((s, i) => s + valorItem(i, k), 0));
  if (falta) return { ok: false, msg: `${falta} item(ns) sem quantidade ou preço.`, soma };
  if (Math.abs(soma - n0(k.amount)) > 0.01) return { ok: false, msg: 'O total da planilha é diferente do valor do contrato.', soma };
  return { ok: true, msg: '', soma };
}

/**
 * Resumo financeiro do contrato (mesmos critérios da planilha da empresa):
 *  total = valor + aditivos − glosas; executado = soma do valor das medições fechadas; retido = retenções das fechadas;
 *  a pagar = executado − retido − glosas − pago (negativo = pago além do executado); retenção a devolver = retido − devolvido.
 */
export function resumoMedicao(k, itens = [], medicoes = [], pagamentos = []) {
  const its = vivos(itens).filter((i) => i.contract_id === k.id);
  const aditivos = r2(its.filter((i) => i.kind === 'aditivo').reduce((s, i) => s + n0(i.amount), 0));
  const glosas = r2(its.filter((i) => i.kind === 'glosa').reduce((s, i) => s + n0(i.amount), 0));
  const valor = n0(k.amount);
  const fech = vivos(medicoes).filter((m) => m.contract_id === k.id && m.status === 'fechada');
  const executado = r2(fech.reduce((s, m) => s + n0(m.gross), 0));
  const retido = r2(fech.reduce((s, m) => s + n0(m.retention), 0));
  const pgs = vivos(pagamentos).filter((p) => p.contract_id === k.id);
  const pago = r2(pgs.filter((p) => p.kind === 'pagamento').reduce((s, p) => s + n0(p.amount), 0));
  const devolvido = r2(pgs.filter((p) => p.kind === 'retencao').reduce((s, p) => s + n0(p.amount), 0));
  const base = r2(valor + aditivos);
  const aPagar = r2(executado - retido - glosas - pago);
  const ultima = fech.sort((a, b) => b.number - a.number)[0] || null;
  return {
    valor, aditivos, glosas, total: r2(base - glosas), base, executado, pctExec: base > 0 ? Math.min(100, (executado / base) * 100) : 0,
    retido, devolvido, retencaoADevolver: r2(retido - devolvido), pago, aPagar, alemDoExecutado: aPagar < -0.005 ? r2(-aPagar) : 0,
    saldo: r2(base - glosas - pago - devolvido), medicoes: fech.length, ultimaData: ultima?.measure_date || null,
    completo: base > 0 && executado >= base - 0.01,
  };
}

/** Sexta-feira da semana de pagamento: a própria data, se for sexta; senão, a próxima sexta. */
export function proximaSexta(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Lista de pagamento da semana: contratos por medição com valor a pagar (executado líquido ainda não pago) ou
 * retenção a devolver (contrato 100% medido ou concluído). `linhas` = [{ k, r }] com r = resumoMedicao.
 */
export function listaDaSemana(linhas) {
  return linhas.map(({ k, r, ...resto }) => ({ k, r, ...resto, aPagar: Math.max(0, r.aPagar),
    retencao: (r.completo || k.status === 'concluido') ? Math.max(0, r.retencaoADevolver) : 0 }))
    .filter((x) => x.aPagar > 0.005 || x.retencao > 0.005)
    .sort((a, b) => String(a.profissional || '').localeCompare(String(b.profissional || ''), 'pt-BR'));
}

/**
 * Balanço da obra: mão de obra (contratos por medição e demais contratos de mão de obra) × contrato com o cliente.
 * `contratos` = [{ total, executado, pago }]; área em m² (opcional). Sem valor do cliente ou área, o indicador fica nulo.
 */
export function balancoObra({ valorCliente = null, area = null, contratos = [] }) {
  const maoDeObra = r2(contratos.reduce((s, c) => s + n0(c.total), 0));
  const executado = r2(contratos.reduce((s, c) => s + n0(c.executado), 0));
  const pago = r2(contratos.reduce((s, c) => s + n0(c.pago), 0));
  const cli = valorCliente == null || valorCliente === '' ? null : n0(valorCliente);
  const m2 = area == null || area === '' || !(n0(area) > 0) ? null : n0(area);
  return {
    maoDeObra, executado, pago, valorCliente: cli, area: m2,
    pctDoCliente: cli ? (maoDeObra / cli) * 100 : null,
    moPorM2: m2 ? r2(maoDeObra / m2) : null, pagoPorM2: m2 ? r2(pago / m2) : null, clientePorM2: m2 && cli != null ? r2(cli / m2) : null,
  };
}
