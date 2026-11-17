// Regras do financeiro da EMPRESA (puras e testáveis; as mesmas do banco, migração 0019).
// Plano de contas em árvore · rateio por centro de custo (soma 100%, centavos sem perda) · situação e saldo dos
// lançamentos pelas baixas · contas a pagar/receber por vencimento.

export const TIPOS_CONTA = {
  receita: 'Receita', deducao: 'Dedução da receita', custo_obra: 'Custo de obra', despesa_adm: 'Despesa administrativa',
  despesa_financeira: 'Despesa financeira', imposto_lucro: 'Imposto sobre o lucro', recursos_cliente: 'Recursos de clientes (fora da DRE)',
  nao_operacional: 'Fora do resultado',
};
export const REGIMES = { '': 'Não informado', simples: 'Simples Nacional', presumido: 'Lucro Presumido', real: 'Lucro Real' };
export const FORMAS = { pix: 'PIX', boleto: 'Boleto', transferencia: 'Transferência', cartao: 'Cartão', dinheiro: 'Dinheiro', cheque: 'Cheque', debito_automatico: 'Débito automático', outro: 'Outro' };
export const SITUACOES = { aberto: 'Em aberto', parcial: 'Parcial', quitado: 'Quitado', cancelado: 'Cancelado' };
export const TIPOS_BANCO = { corrente: 'Conta corrente', poupanca: 'Poupança', aplicacao: 'Aplicação', caixa: 'Caixa (espécie)' };

const partes = (code) => String(code || '').split('.').map(Number);
export function compararCodigo(a, b) {
  const x = partes(a), y = partes(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/** Plano de contas na ordem da árvore, com nível e se é analítica (sem subcontas = aceita lançamento). */
export function arvoreContas(contas) {
  const comFilhos = new Set((contas || []).map((c) => c.parent_id).filter(Boolean));
  return [...(contas || [])].sort((a, b) => compararCodigo(a.code, b.code))
    .map((c) => ({ ...c, nivel: partes(c.code).length, analitica: !comFilhos.has(c.id) }));
}

/** Contas em que se pode lançar: analíticas e ativas; a receber só receita, recursos de clientes ou fora do resultado. */
export function contasLancaveis(contas, tipo) {
  const ok = tipo === 'receber' ? ['receita', 'recursos_cliente', 'nao_operacional'] : null;
  return arvoreContas(contas).filter((c) => c.analitica && c.active && (!ok || ok.includes(c.kind)));
}

/** Próximo código livre de subconta: 4 → 4.10 se já existem 4.1…4.9. */
export function proximoCodigo(contas, pai) {
  const filhos = (contas || []).filter((c) => c.parent_id === pai.id).map((c) => partes(c.code).at(-1));
  return `${pai.code}.${(filhos.length ? Math.max(...filhos) : 0) + 1}`;
}

/** Confere o rateio digitado: centro escolhido, sem repetir, percentual > 0 e soma 100 (tolerância 0,0001). */
export function validarRateio(linhas) {
  const l = (linhas || []).filter((x) => x.cost_center_id || x.pct);
  if (!l.length) return { erro: 'Informe o centro de custo.' };
  const vistos = new Set();
  for (const x of l) {
    if (!x.cost_center_id) return { erro: 'Escolha o centro de custo de cada linha do rateio.' };
    if (vistos.has(x.cost_center_id)) return { erro: 'O mesmo centro de custo aparece duas vezes no rateio.' };
    vistos.add(x.cost_center_id);
    if (!(Number(x.pct) > 0) || Number(x.pct) > 100) return { erro: 'Cada percentual do rateio precisa ser maior que 0 e no máximo 100.' };
  }
  const soma = Math.round(l.reduce((s, x) => s + Number(x.pct), 0) * 10000) / 10000;
  if (Math.abs(soma - 100) > 0.0001) return { erro: `O rateio soma ${String(soma).replace('.', ',')}%; precisa dar 100%.` };
  return { linhas: l.map((x) => ({ cost_center_id: x.cost_center_id, pct: Number(x.pct) })) };
}

/** Divide igualmente entre n centros, com 4 casas e o resíduo no último (soma exatamente 100). */
export function dividirIgual(n) {
  if (!(n > 0)) return [];
  const base = Math.floor((100 / n) * 10000) / 10000;
  const l = Array(n).fill(base);
  l[n - 1] = Math.round((100 - base * (n - 1)) * 10000) / 10000;
  return l;
}

/** Valor de cada centro no rateio, em centavos exatos (o resíduo fica no último). */
export function ratearValor(valor, pcts) {
  const cents = Math.round((Number(valor) || 0) * 100);
  let usados = 0;
  return (pcts || []).map((p, i, a) => {
    const c = i === a.length - 1 ? cents - usados : Math.round(cents * Number(p) / 100);
    usados += c;
    return c / 100;
  });
}

/** Saldo e situação do lançamento pelas baixas não estornadas (mesma regra do banco). */
export function saldoLancamento(e, baixas) {
  const validas = (baixas || []).filter((b) => b.entry_id === e.id && !b.deleted_at);
  const pago = Math.round(validas.reduce((s, b) => s + Number(b.amount), 0) * 100) / 100;
  const valor = Number(e.amount) || 0;
  const saldo = e.status === 'cancelado' ? 0 : Math.max(0, Math.round((valor - pago) * 100) / 100);
  const situacao = e.status === 'cancelado' ? 'cancelado' : pago >= valor - 0.005 ? 'quitado' : pago > 0 ? 'parcial' : 'aberto';
  return { pago, saldo, situacao, baixas: validas, clientePagou: validas.some((b) => b.paid_by === 'cliente') };
}

/** Lançamentos filtrados e totais (a pagar e a receber em aberto, vencidos, pago e recebido no mês). */
export function resumoLancamentos(entradas, baixas, { hoje, mes = hoje?.slice(0, 7), tipo = '', situacao = 'abertos', centro = '', splits = [] } = {}) {
  const porEntrada = new Map();
  for (const s of splits || []) { if (!porEntrada.has(s.entry_id)) porEntrada.set(s.entry_id, []); porEntrada.get(s.entry_id).push(s); }
  const linhas = (entradas || []).map((e) => ({ ...e, ...saldoLancamento(e, baixas), rateio: porEntrada.get(e.id) || [] }));
  const filtradas = linhas.filter((e) => (!tipo || e.kind === tipo)
    && (situacao === 'todos' || (situacao === 'abertos' ? ['aberto', 'parcial'].includes(e.situacao) : e.situacao === situacao))
    && (!centro || e.rateio.some((r) => r.cost_center_id === centro)))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.description.localeCompare(b.description));
  const abertas = linhas.filter((e) => ['aberto', 'parcial'].includes(e.situacao));
  const soma = (l, f) => Math.round(l.reduce((s, x) => s + f(x), 0) * 100) / 100;
  const doMes = (b) => !b.deleted_at && b.method !== 'retencao' && String(b.pay_date).slice(0, 7) === mes;
  const tipoDe = new Map(linhas.map((e) => [e.id, e.kind]));
  return {
    linhas: filtradas,
    totais: {
      aPagar: soma(abertas.filter((e) => e.kind === 'pagar'), (e) => e.saldo),
      aReceber: soma(abertas.filter((e) => e.kind === 'receber'), (e) => e.saldo),
      vencidosPagar: soma(abertas.filter((e) => e.kind === 'pagar' && e.due_date < hoje), (e) => e.saldo),
      vencidosReceber: soma(abertas.filter((e) => e.kind === 'receber' && e.due_date < hoje), (e) => e.saldo),
      pagoMes: soma((baixas || []).filter((b) => doMes(b) && tipoDe.get(b.entry_id) === 'pagar' && b.paid_by !== 'cliente'), (b) => Number(b.amount)),
      recebidoMes: soma((baixas || []).filter((b) => doMes(b) && tipoDe.get(b.entry_id) === 'receber'), (b) => Number(b.amount)),
    },
  };
}

/* ---------- Contrato do cliente (migração 0022) ---------- */
export const REGIMES_CONTRATO = { administracao: 'Administração', empreitada: 'Empreitada / preço fechado' };
export const TAXAS = { nenhuma: 'Sem taxa', percentual_custos: '% sobre os custos do mês', fixo_mensal: 'Valor fixo por mês', percentual_orcamento: '% do orçamento, em parcelas mensais' };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Meses 'AAAA-MM' de `de` até `ate` (inclusive). */
export function mesesEntre(de, ate) {
  const out = [];
  let [a, m] = String(de).slice(0, 7).split('-').map(Number);
  const [fa, fm] = String(ate).slice(0, 7).split('-').map(Number);
  while (a < fa || (a === fa && m <= fm)) { out.push(`${a}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; a++; } if (out.length > 240) break; }
  return out;
}

/** Etapa raiz (nível 1) de uma atividade/fase da EAP. */
export function faseRaiz(obra, id) {
  const porId = new Map((obra?.eap || []).map((a) => [a.id, a]));
  let a = porId.get(id), n = 0;
  while (a && a.parentId && n++ < 20) a = porId.get(a.parentId);
  return a && !a.parentId ? a.id : null;
}

/** Custos lançados na obra (despesas, inclusive sobras transferidas) no mês 'AAAA-MM', ou até o fim dele (acumulado). */
export function custosDaObra(obra, mes, { acumulado = false } = {}) {
  return (obra?.despesas || []).filter((d) => d.data && (acumulado ? d.data.slice(0, 7) <= mes : d.data.slice(0, 7) === mes));
}

/** Pagamentos que o CLIENTE fez direto (baixas "cliente pagou") rateados para a obra, no mês ou acumulado.
 *  Devolve [{ entry, data, valor, verbaId }] com o valor já multiplicado pelo percentual do rateio. */
export function pagosPeloCliente({ entradas, splits, baixas, centroId, mes, acumulado = false }) {
  const pct = new Map((splits || []).filter((s) => s.cost_center_id === centroId).map((s) => [s.entry_id, Number(s.pct)]));
  return (baixas || []).filter((b) => !b.deleted_at && b.paid_by === 'cliente' && pct.has(b.entry_id)
    && (acumulado ? String(b.pay_date).slice(0, 7) <= mes : String(b.pay_date).slice(0, 7) === mes))
    .map((b) => { const e = (entradas || []).find((x) => x.id === b.entry_id); return { entry: e, data: b.pay_date, valor: r2(Number(b.amount) * pct.get(b.entry_id) / 100), verbaId: e?.allowance_id || null }; });
}

/** Recebimentos do cliente para a obra (baixas de contas a receber rateadas para o centro da obra), separados em
 *  aportes (recursos do cliente, grupo 7) e receitas da construtora (taxa, contrato — grupo 1). */
export function recebidosDoCliente({ entradas, splits, baixas, contas, centroId, mes, acumulado = false }) {
  const pct = new Map((splits || []).filter((s) => s.cost_center_id === centroId).map((s) => [s.entry_id, Number(s.pct)]));
  const kindConta = new Map((contas || []).map((c) => [c.id, c.kind]));
  const out = { aportes: 0, receitas: 0, lista: [] };
  for (const b of baixas || []) {
    if (b.deleted_at || !pct.has(b.entry_id)) continue;
    const e = (entradas || []).find((x) => x.id === b.entry_id);
    if (!e || e.kind !== 'receber') continue;
    const d = String(b.pay_date).slice(0, 7);
    if (acumulado ? d > mes : d !== mes) continue;
    const valor = r2(Number(b.amount) * pct.get(b.entry_id) / 100);
    const aporte = kindConta.get(e.account_id) === 'recursos_cliente';
    out[aporte ? 'aportes' : 'receitas'] = r2(out[aporte ? 'aportes' : 'receitas'] + valor);
    out.lista.push({ data: b.pay_date, descricao: e.description, valor, aporte });
  }
  return out;
}

/** Taxa de administração de um mês. `custosMes` = base do "% sobre os custos" (custos da obra + o que o cliente pagou
 *  direto); `orcamento` = base do "% do orçamento". Antes do mês de início, ou depois das parcelas, a taxa é zero. */
export function taxaDoMes(k, { mes, custosMes = 0, orcamento = 0 }) {
  if (!k || k.fee_kind === 'nenhuma') return { valor: 0, regra: 'sem taxa' };
  const inicio = String(k.start_month).slice(0, 7);
  if (mes < inicio) return { valor: 0, regra: 'antes do início do contrato' };
  const v = Number(k.fee_value) || 0;
  if (k.fee_kind === 'percentual_custos') return { valor: r2(custosMes * v / 100), regra: `${String(v).replace('.', ',')}% de ${custosMes.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` };
  if (k.fee_kind === 'fixo_mensal') return { valor: r2(v), regra: 'valor fixo mensal' };
  const n = Number(k.fee_installments) || 1;
  const idx = mesesEntre(inicio, mes).length;   // 1 = primeira parcela
  if (idx > n) return { valor: 0, regra: `parcelas encerradas (${n})` };
  const total = Math.round(orcamento * v) ;   // centavos: orçamento × % ÷ 100 × 100
  const parcela = Math.floor(total / n);
  return { valor: (idx === n ? total - parcela * (n - 1) : parcela) / 100, regra: `parcela ${idx} de ${n} (${String(v).replace('.', ',')}% do orçamento)` };
}

/** Verba com teto: gasto = custos da obra nas etapas da verba + o que o cliente pagou direto ligado à verba.
 *  Acima do teto, o excedente é do cliente; abaixo, a diferença volta para o cliente. */
export function situacaoVerba(v, { custosAcum = [], obra, clienteAcum = [] }) {
  const fases = new Set(v.phase_ids || []);
  const daObra = r2(custosAcum.filter((d) => fases.has(faseRaiz(obra, d.faseId))).reduce((s, d) => s + (Number(d.valor) || 0), 0));
  const doCliente = r2(clienteAcum.filter((c) => c.verbaId === v.id).reduce((s, c) => s + c.valor, 0));
  const gasto = r2(daObra + doCliente);
  const teto = Number(v.cap) || 0;
  return { teto, daObra, doCliente, gasto, saldo: r2(teto - gasto), excedente: r2(Math.max(0, gasto - teto)), usoPct: teto > 0 ? Math.round(gasto / teto * 1000) / 10 : null };
}

/** Prestação de contas do mês (obra por administração): recursos do cliente, taxa, pagos direto e verbas.
 *  `orcamento` = custo direto orçado da obra. Valores do mês e acumulados até o fim do mês. */
export function prestacaoDeContas({ obra, contrato, verbas = [], mes, entradas, splits, baixas, contas, centroId, orcamento = 0 }) {
  const base = { entradas, splits, baixas, centroId };
  const custosMes = custosDaObra(obra, mes), custosAcum = custosDaObra(obra, mes, { acumulado: true });
  const soma = (l) => r2(l.reduce((s, d) => s + (Number(d.valor) || 0), 0));
  const clienteMes = pagosPeloCliente({ ...base, mes }), clienteAcum = pagosPeloCliente({ ...base, mes, acumulado: true });
  const recMes = recebidosDoCliente({ ...base, contas, mes }), recAcum = recebidosDoCliente({ ...base, contas, mes, acumulado: true });
  const meses = contrato ? mesesEntre(contrato.start_month, mes) : [];
  const taxas = meses.map((m) => ({ mes: m, ...taxaDoMes(contrato, { mes: m, orcamento,
    custosMes: soma(custosDaObra(obra, m)) + r2(pagosPeloCliente({ ...base, mes: m }).reduce((s, c) => s + c.valor, 0)) }) }));
  const taxaMes = taxas.find((t) => t.mes === mes) || { valor: 0, regra: '' };
  const taxaAcum = r2(taxas.reduce((s, t) => s + t.valor, 0));
  const pagoEmpresaAcum = soma(custosAcum);
  // por etapa (mês)
  const porEtapa = new Map();
  for (const d of [...custosMes].sort((a, b) => a.data.localeCompare(b.data))) {
    const f = faseRaiz(obra, d.faseId);
    if (!porEtapa.has(f)) porEtapa.set(f, { faseId: f, despesas: [], total: 0 });
    const g = porEtapa.get(f); g.despesas.push(d); g.total = r2(g.total + (Number(d.valor) || 0));
  }
  const ordem = new Map((obra?.eap || []).filter((a) => !a.parentId).map((a, i) => [a.id, i]));
  return {
    mes,
    custos: { mes: soma(custosMes), acumulado: pagoEmpresaAcum, porEtapa: [...porEtapa.values()].sort((a, b) => (ordem.get(a.faseId) ?? 999) - (ordem.get(b.faseId) ?? 999)) },
    clienteDireto: { mes: r2(clienteMes.reduce((s, c) => s + c.valor, 0)), acumulado: r2(clienteAcum.reduce((s, c) => s + c.valor, 0)), lista: clienteMes },
    recebido: { aportesMes: recMes.aportes, receitasMes: recMes.receitas, aportesAcum: recAcum.aportes, receitasAcum: recAcum.receitas, lista: recMes.lista },
    taxa: { mes: taxaMes.valor, regra: taxaMes.regra, acumulado: taxaAcum, recebida: recAcum.receitas, aReceber: r2(taxaAcum - recAcum.receitas), meses: taxas },
    // recursos do cliente: aportes recebidos − custos pagos pela construtora (positivo = saldo a favor do cliente)
    saldoRecursos: r2(recAcum.aportes - pagoEmpresaAcum),
    verbas: verbas.filter((v) => v.active !== false).map((v) => ({ ...v, ...situacaoVerba(v, { custosAcum, obra, clienteAcum }) })),
  };
}

/* ---------- DRE (competência) e fluxo de caixa (migração 0023) ---------- */
const GRUPOS_DRE = [['receita', 'Receita bruta'], ['deducao', '(−) Deduções da receita'], ['custo_obra', '(−) Custos das obras'],
  ['despesa_adm', '(−) Despesas administrativas'], ['despesa_financeira', '(−) Despesas financeiras'], ['imposto_lucro', '(−) Impostos sobre o lucro']];

/** Fator do lançamento para o filtro de centro de custo (1 sem filtro; pct/100 do centro; 0 se não rateado para ele). */
function fatorCentro(splits, centroId) {
  if (!centroId) return () => 1;
  const m = new Map((splits || []).filter((s) => s.cost_center_id === centroId).map((s) => [s.entry_id, Number(s.pct) / 100]));
  return (id) => m.get(id) || 0;
}

/** DRE gerencial por competência, mês a mês. Lançamentos da empresa pela competência (vezes o rateio, com filtro de
 *  centro) e custos lançados nas obras pela data, na conta da categoria. Obra por administração: custos fora da DRE
 *  (recursos do cliente). `obrasMov` = fin_obras_movimentos (tipo 'custo'); `projetoDoCentro` = obra do centro filtrado. */
export function montarDRE({ contas = [], entradas = [], splits = [], obrasMov = [], meses = [], centroId = null, projetoDoCentro = null }) {
  const fator = fatorCentro(splits, centroId);
  const noPeriodo = new Set(meses);
  const porConta = new Map();
  const linha = (c) => { if (!porConta.has(c.id)) porConta.set(c.id, { id: c.id, code: c.code, name: c.name, kind: c.kind, valores: {}, total: 0 }); return porConta.get(c.id); };
  const somar = (l, mes, v) => { l.valores[mes] = r2((l.valores[mes] || 0) + v); l.total = r2(l.total + v); };
  const contaPorId = new Map(contas.map((c) => [c.id, c]));
  const contaCat = new Map(contas.filter((c) => c.obra_category).map((c) => [c.obra_category, c]));
  const fora = { aportes: {}, custosAdm: {}, clienteDireto: {}, naoOperacional: {} };
  const somaFora = (k, mes, v) => { fora[k][mes] = r2((fora[k][mes] || 0) + v); };
  for (const e of entradas) {
    if (e.status === 'cancelado') continue;
    const mes = String(e.competence).slice(0, 7);
    if (!noPeriodo.has(mes)) continue;
    const f = fator(e.id); if (!f) continue;
    const c = contaPorId.get(e.account_id); if (!c) continue;
    const v = Number(e.amount) * f;
    if (c.kind === 'recursos_cliente') somaFora(e.kind === 'receber' ? 'aportes' : 'clienteDireto', mes, v);
    else if (c.kind === 'nao_operacional') somaFora('naoOperacional', mes, e.kind === 'receber' ? v : -v);
    else somar(linha(c), mes, v);
  }
  for (const m of obrasMov) {
    if (m.tipo !== 'custo') continue;
    if (centroId && m.project_id !== projetoDoCentro) continue;
    const mes = String(m.dia).slice(0, 7);
    if (!noPeriodo.has(mes)) continue;
    if (m.client_funds) { somaFora('custosAdm', mes, Number(m.valor)); continue; }
    const c = contaCat.get(m.categoria) || contaCat.get('Outro');
    if (c) somar(linha(c), mes, Number(m.valor));
  }
  const grupos = GRUPOS_DRE.map(([kind, titulo]) => {
    const ls = [...porConta.values()].filter((l) => l.kind === kind).sort((a, b) => compararCodigo(a.code, b.code));
    const valores = {}; for (const mes of meses) valores[mes] = r2(ls.reduce((s, l) => s + (l.valores[mes] || 0), 0));
    return { kind, titulo, contas: ls, valores, total: r2(ls.reduce((s, l) => s + l.total, 0)) };
  });
  const g = Object.fromEntries(grupos.map((x) => [x.kind, x]));
  const calc = (f) => { const o = {}; for (const mes of meses) o[mes] = r2(f(mes)); o.total = r2(meses.reduce((s, mes) => s + o[mes], 0)); return o; };
  const v = (k, mes) => g[k].valores[mes] || 0;
  const receitaLiquida = calc((mes) => v('receita', mes) - v('deducao', mes));
  const lucroBruto = calc((mes) => receitaLiquida[mes] - v('custo_obra', mes));
  const antesIR = calc((mes) => lucroBruto[mes] - v('despesa_adm', mes) - v('despesa_financeira', mes));
  const liquido = calc((mes) => antesIR[mes] - v('imposto_lucro', mes));
  const rb = g.receita.total;
  const tot = (o) => ({ ...o, total: r2(meses.reduce((s, mes) => s + (o[mes] || 0), 0)) });
  return { meses, grupos, receitaLiquida, lucroBruto, antesIR, liquido, margem: rb ? Math.round(liquido.total / rb * 1000) / 10 : null,
    fora: { aportes: tot(fora.aportes), custosAdm: tot(fora.custosAdm), clienteDireto: tot(fora.clienteDireto), naoOperacional: tot(fora.naoOperacional) } };
}

const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Dias 'AAAA-MM-DD' de `de` até `ate`. */
export function diasEntre(de, ate) { const out = []; for (let d = de; d <= ate && out.length < 400; d = somaDias(d, 1)) out.push(d); return out; }

/** Fluxo de caixa por mês ('mes') ou dia ('dia'): previsto × realizado e saldo projetado.
 *  Realizado: recebimentos e pagamentos da empresa (o que o cliente pagou direto não passa pelo caixa) + pagamentos das
 *  despesas das obras. Previsto: saldos em aberto pelo vencimento (vencidos entram no período de hoje). Saldo inicial =
 *  saldos iniciais das contas + tudo o que foi realizado antes do período (só sem filtro de centro). */
export function montarFluxo({ entradas = [], splits = [], baixas = [], obrasMov = [], bancos = [], de, ate, gran = 'mes', hoje, centroId = null, projetoDoCentro = null }) {
  const chave = (iso) => (gran === 'mes' ? String(iso).slice(0, 7) : String(iso).slice(0, 10));
  const periodos = gran === 'mes' ? mesesEntre(de, ate) : diasEntre(de, ate);
  const hojeK = chave(hoje);
  const fator = fatorCentro(splits, centroId);
  const tipo = new Map(entradas.map((e) => [e.id, e]));
  const P = new Map(periodos.map((k) => [k, { chave: k, entradasPrevistas: 0, entradasRealizadas: 0, saidasPrevistas: 0, saidasRealizadas: 0 }]));
  let anterior = centroId ? 0 : bancos.reduce((s, b) => s + (Number(b.opening_balance) || 0), 0);
  const inicioK = periodos[0];
  const real = (iso, campo, v) => { const k = chave(iso); if (k < inicioK) { if (!centroId) anterior += campo === 'entradasRealizadas' ? v : -v; return; } const p = P.get(k); if (p) p[campo] = r2(p[campo] + v); };
  const prev = (iso, campo, v) => { let k = chave(iso); if (k < hojeK) k = hojeK; const p = P.get(k); if (p && k >= hojeK) p[campo] = r2(p[campo] + v); };
  for (const b of baixas) {
    if (b.deleted_at || b.paid_by === 'cliente' || b.method === 'retencao') continue;   // retenção na nota não é dinheiro no caixa
    const e = tipo.get(b.entry_id); if (!e) continue;
    const f = fator(e.id); if (!f) continue;
    real(b.pay_date, e.kind === 'receber' ? 'entradasRealizadas' : 'saidasRealizadas', Number(b.amount) * f);
  }
  for (const e of entradas) {
    if (!['aberto', 'parcial'].includes(saldoLancamento(e, baixas).situacao)) continue;
    const f = fator(e.id); if (!f) continue;
    prev(e.due_date, e.kind === 'receber' ? 'entradasPrevistas' : 'saidasPrevistas', saldoLancamento(e, baixas).saldo * f);
  }
  for (const m of obrasMov) {
    if (centroId && m.project_id !== projetoDoCentro) continue;
    if (m.tipo === 'pagamento') real(m.dia, 'saidasRealizadas', Number(m.valor));
    else if (m.tipo === 'previsto') prev(m.dia, 'saidasPrevistas', Number(m.valor));
  }
  let saldo = r2(anterior);
  const lista = periodos.map((k) => {
    const p = P.get(k);
    const passado = k < hojeK;
    saldo = r2(saldo + p.entradasRealizadas - p.saidasRealizadas + (passado ? 0 : p.entradasPrevistas - p.saidasPrevistas));
    return { ...p, passado, atual: k === hojeK, saldo };
  });
  const soma = (c) => r2(lista.reduce((s, p) => s + p[c], 0));
  return { periodos: lista, saldoInicial: r2(anterior), totais: { entradasPrevistas: soma('entradasPrevistas'), entradasRealizadas: soma('entradasRealizadas'),
    saidasPrevistas: soma('saidasPrevistas'), saidasRealizadas: soma('saidasRealizadas') },
    // menor saldo de hoje em diante (o que interessa para "vai faltar caixa?")
    menorSaldo: (lista.some((p) => !p.passado) ? lista.filter((p) => !p.passado) : lista).reduce((m, p) => (m == null || p.saldo < m.saldo ? p : m), null) };
}

/* ---------- Fiscal: notas de serviço com retenções (migração 0024) ---------- */
/** Retenções da nota (mesma conta do banco): INSS sobre a base informada; ISS sobre o bruto (só desconta se retido);
 *  IRRF, PIS, COFINS e CSLL em valor. Devolve os valores, o total retido e o líquido a receber. */
export function calcularRetencoes({ bruto = 0, inssBase = 0, inssAliq = 0, issAliq = 0, issRetido = false, irrf = 0, pis = 0, cofins = 0, csll = 0 }) {
  const inss = r2(Number(inssBase) * Number(inssAliq) / 100);
  const iss = r2(Number(bruto) * Number(issAliq) / 100);
  const total = r2(inss + (issRetido ? iss : 0) + Number(irrf) + Number(pis) + Number(cofins) + Number(csll));
  return { inss, iss, total, liquido: r2(Number(bruto) - total), erro: total > Number(bruto) + 0.005 ? 'As retenções passam do valor bruto.' : Number(inssBase) > Number(bruto) + 0.005 ? 'A base do INSS não pode passar do bruto.' : '' };
}
/** Sugestões de alíquota por regime (sempre editáveis; o contador confirma). PCC = PIS 0,65% + COFINS 3% + CSLL 1%. */
export function sugestaoRetencoes(regime) {
  return { inssAliq: 11, issAliq: 0, issRetido: false, irrfAliq: 0, pccAliq: { pis: 0.65, cofins: 3, csll: 1 },
    nota: regime === 'simples'
      ? 'Simples Nacional: em geral não há retenção de IRRF nem de PIS/COFINS/CSLL; o INSS de 11% é retido em cessão de mão de obra e empreitada.'
      : 'Lucro Presumido/Real: INSS 11% (3,5% se a empresa recolhe a CPRB); IRRF 1,5% e PIS/COFINS/CSLL 4,65% só quando o tomador é obrigado a reter.' };
}

/** INSS por obra (CNO) e mês: retido nas notas de serviço × guias lançadas na conta 3.7 com o centro da obra. */
export function inssPorObra({ notas = [], entradas = [], splits = [], contas = [], centros = [] }) {
  const conta37 = contas.find((c) => c.code === '3.7')?.id;
  const obraDoCentro = new Map(centros.filter((c) => c.project_id).map((c) => [c.id, c.project_id]));
  const L = new Map();
  const linha = (pid, mes) => { const k = `${pid}|${mes}`; if (!L.has(k)) L.set(k, { projectId: pid, mes, retido: 0, guias: 0, notas: 0 }); return L.get(k); };
  for (const n of notas) {
    if (n.status === 'cancelada') continue;
    const l = linha(n.project_id, String(n.competence).slice(0, 7));
    l.retido = r2(l.retido + Number(n.inss_amount)); l.notas += 1;
  }
  for (const e of entradas) {
    if (e.status === 'cancelado' || e.account_id !== conta37) continue;
    for (const s of splits.filter((x) => x.entry_id === e.id)) {
      const pid = obraDoCentro.get(s.cost_center_id); if (!pid) continue;
      const l = linha(pid, String(e.competence).slice(0, 7));
      l.guias = r2(l.guias + Number(e.amount) * Number(s.pct) / 100);
    }
  }
  return [...L.values()].sort((a, b) => b.mes.localeCompare(a.mes));
}

/** Contas a pagar da empresa no formato da tela "Contas a pagar" (junto com as despesas das obras). */
export function titulosParaContas(entradas, baixas, nomeCentro = () => '') {
  return (entradas || []).filter((e) => e.kind === 'pagar').map((e) => ({ e, s: saldoLancamento(e, baixas) }))
    .filter(({ s }) => ['aberto', 'parcial'].includes(s.situacao))
    .map(({ e, s }) => ({ obraId: null, obra: nomeCentro(e) || 'Empresa', despesaId: e.id, empresa: true, fornecedor: e.party_name || '', documento: e.document || '',
      descricao: e.description, categoria: '', data: e.competence, vencimento: e.due_date, valor: Number(e.amount), pago: s.pago, saldo: s.saldo }));
}
