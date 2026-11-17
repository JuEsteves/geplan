// Financeiro da EMPRESA (modo nuvem): lançamentos a pagar e a receber com rateio por centro de custo e baixas;
// cadastros de plano de contas (com De/Para contábil), centros de custo, contas bancárias e regime tributário.
// Separado dos custos de cada obra (que ficam com a engenharia). Lê e grava direto no banco (migração 0019):
// vê = administrador, financeiro e contador; grava = administrador e financeiro. O banco confere tudo.
import * as store from './store.js';
import { esc, I, ui, toast, ask, formDialog, info, queueRender, parseNum, fmtIn } from './ui.js';
import { fmtBRL, isoBR, todayISO } from './schedule.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { veFinEmpresa, gravaFinEmpresa } from './permissoes.js';
import { datalistFornecedores, idDoFornecedorPorNome, carregarFornecedores } from './fornecedores.js';
import { ir } from './escopo.js';
import {
  TIPOS_CONTA, REGIMES, FORMAS, SITUACOES, TIPOS_BANCO, arvoreContas, contasLancaveis, proximoCodigo, validarRateio, dividirIgual,
  ratearValor, saldoLancamento, resumoLancamentos, titulosParaContas, REGIMES_CONTRATO, TAXAS, prestacaoDeContas,
  montarDRE, montarFluxo, mesesEntre, calcularRetencoes, sugestaoRetencoes, inssPorObra, lerOFX, sugerirConciliacao, resumoConta,
  montarExportacao, arquivoContabil, resumoAuditoria,
} from './financeiroEmpresaRegras.js';
import { urlTemporaria } from './nuvem/arquivos.js';
import { contexto } from './obra.js';

const vazio = () => ({ carregado: false, carregando: false, erro: '', em: 0, contas: [], centros: [], bancos: [], entradas: [], splits: [], baixas: [], regime: '', contratos: [], verbas: [], notas: [], extratos: [], linhasBanco: [] });
const F = vazio();
const ctx = () => nuvem.contexto();
const disponivel = () => nuvemConfigurada() && nuvem.ativo() && !!ctx()?.papel && veFinEmpresa();
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const centroPorId = (id) => F.centros.find((c) => c.id === id);
const contaPorId = (id) => F.contas.find((c) => c.id === id);
const bancoPorId = (id) => F.bancos.find((b) => b.id === id);
const nomeCentro = (c) => (c ? `${c.code ? `${c.code} · ` : ''}${c.name}` : '—');

/* ---------- dados ---------- */
export async function carregarFinEmpresa(forcar = false) {
  if (!disponivel() || F.carregando || (F.carregado && !forcar)) return;
  F.carregando = true; F.erro = '';
  try {
    const c = await sb();
    const org = ctx().orgId;
    const [contas, centros, bancos, entradas, splits, baixas, empresa, contratos, verbas, notas, extratos, linhasBanco] = await Promise.all([
      c.from('fin_accounts').select('*').eq('org_id', org),
      c.from('fin_cost_centers').select('*').eq('org_id', org).order('name'),
      c.from('fin_bank_accounts').select('*').eq('org_id', org).order('name'),
      c.from('fin_entries').select('*').eq('org_id', org).order('due_date'),
      c.from('fin_entry_splits').select('*').eq('org_id', org),
      c.from('fin_settlements').select('*').eq('org_id', org).order('pay_date'),
      c.from('organizations').select('tax_regime').eq('id', org).maybeSingle(),
      c.from('client_contracts').select('*').eq('org_id', org),
      c.from('contract_allowances').select('*').eq('org_id', org).order('position'),
      c.from('service_invoices').select('*').eq('org_id', org).order('issue_date', { ascending: false }),
      c.from('fin_bank_statements').select('*').eq('org_id', org).order('created_at', { ascending: false }),
      c.from('fin_bank_lines').select('*').eq('org_id', org).order('posted_date', { ascending: false }).limit(3000),
    ]);
    F.extratos = ok(extratos, 'extratos') || []; F.linhasBanco = ok(linhasBanco, 'linhas do extrato') || [];
    F.contratos = ok(contratos, 'contratos') || []; F.verbas = ok(verbas, 'verbas') || []; F.notas = ok(notas, 'notas fiscais') || [];
    Object.assign(F, { contas: ok(contas, 'plano de contas') || [], centros: ok(centros, 'centros de custo') || [], bancos: ok(bancos, 'contas bancárias') || [],
      entradas: ok(entradas, 'lançamentos') || [], splits: ok(splits, 'rateio') || [], baixas: ok(baixas, 'baixas') || [],
      regime: ok(empresa, 'empresa')?.tax_regime || '' });
    F.carregado = true; F.em = Date.now();
  } catch (e) { F.erro = e.message; }
  F.carregando = false;
  queueRender();
}
export function limparFinEmpresa() { Object.assign(F, vazio()); }

/** Contas a pagar da empresa para a tela "Contas a pagar" (junto com as das obras). Carrega sob demanda. */
export function contasDaEmpresa() {
  if (!disponivel()) return { pronto: true, lista: [] };
  if (!F.carregado && !F.carregando) setTimeout(() => carregarFinEmpresa());
  const nome = (e) => {
    const cs = F.splits.filter((s) => s.entry_id === e.id).map((s) => centroPorId(s.cost_center_id)?.name).filter(Boolean);
    return cs.length ? `Empresa · ${cs.length > 1 ? `rateio (${cs.length} centros)` : cs[0]}` : 'Empresa';
  };
  return { pronto: F.carregado, lista: titulosParaContas(F.entradas, F.baixas, nome) };
}

/* ---------- janelas ---------- */
function janela(titulo, corpo, okRot = 'Salvar') {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>${esc(titulo)}</h2><div class="stack" style="margin-top:12px">${corpo}</div>
    <div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${esc(okRot)}</button></div></form>`;
  const form = dlg.querySelector('form');
  return { dlg, form, erro: (m) => { const e = form.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; if (m) e.scrollIntoView({ block: 'nearest' }); } };
}
function abrir({ dlg, form, erro }, salvar) {
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[value=ok]'); btn.disabled = true; erro('');
      try { const v = await salvar(Object.fromEntries(new FormData(form))); if (v !== undefined) finish(v); else btn.disabled = false; }
      catch (err) { btn.disabled = false; erro(err.message); }
    };
    dlg.showModal();
    form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')?.focus();
  });
}

/* ---------- telas ---------- */
const SECOES = [['lancamentos', 'Lançamentos'], ['contratos', 'Contratos com clientes'], ['dre', 'DRE'], ['caixa', 'Fluxo de caixa'], ['cadastros', 'Cadastros financeiros']];

/* ----- custos e pagamentos das obras (só totais), para DRE e caixa — fin_obras_movimentos ----- */
const MOV = { chave: '', carregando: false, linhas: [], erro: '' };
function movObras(de, ate) {
  const chave = `${de}|${ate}`;
  if (MOV.chave !== chave && !MOV.carregando) {
    MOV.carregando = true;
    sb().then((c) => c.rpc('fin_obras_movimentos', { p_org: ctx().orgId, p_de: de, p_ate: ate }))
      .then(({ data, error }) => { if (error) throw erroBanco(error, 'custos das obras'); MOV.linhas = (data || []).map((m) => ({ ...m, valor: Number(m.valor) })); MOV.erro = ''; })
      .catch((e) => { MOV.erro = e.message; MOV.linhas = []; })
      .finally(() => { MOV.chave = chave; MOV.carregando = false; queueRender(); });
  }
  return MOV.chave === chave ? MOV.linhas : null;
}
const fimDoMes = (m) => { const d = new Date(`${m}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const somaMeses = (m, n) => { const d = new Date(`${m}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const filtroCentro = (k) => `<label class="field" style="max-width:280px">Centro de custo<select data-chg="finRel" data-k="${k}">${[['', 'Empresa inteira (consolidado)'], ...F.centros.filter((c) => c.active).map((c) => [c.id, nomeCentro(c)])]
  .map(([v, l]) => `<option value="${v}" ${(ui.finRel?.[k] || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const R = () => (ui.finRel ||= { de: `${todayISO().slice(0, 4)}-01`, ate: todayISO().slice(0, 7), centroDre: '', gran: 'mes', centroCx: '' });
const celula = (v, forte = false) => `<td class="num nowrap">${v ? `${forte ? '<b>' : ''}${v < 0 ? `<span style="color:var(--crit)">${fmtBRL(v)}</span>` : fmtBRL(v)}${forte ? '</b>' : ''}` : '<span class="muted">—</span>'}</td>`;

function viewDRE() {
  const f = R();
  const meses = mesesEntre(f.de, f.ate).slice(0, 24);
  const mov = movObras(`${meses[0]}-01`, fimDoMes(meses.at(-1)));
  const cc = centroPorId(f.centroDre);
  const filtros = `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
    <label class="field" style="max-width:170px">De<input type="month" value="${f.de}" data-chg="finRel" data-k="de"></label>
    <label class="field" style="max-width:170px">Até<input type="month" value="${f.ate}" data-chg="finRel" data-k="ate"></label>${filtroCentro('centroDre')}</div>`;
  if (!mov) return `${filtros}<div class="card empty"><p>${MOV.erro ? esc(MOV.erro) : 'Calculando…'}</p></div>`;
  const d = montarDRE({ contas: F.contas, entradas: F.entradas, splits: F.splits, obrasMov: mov, meses, centroId: f.centroDre || null, projetoDoCentro: cc?.project_id || null });
  const cab = `<th>Conta</th>${meses.map((m) => `<th class="num">${rotMes(m)}</th>`).join('')}${meses.length > 1 ? '<th class="num">Total</th>' : ''}`;
  const lin = (rot, vals, { forte = false, cls = '', indent = 0 } = {}) => `<tr class="${cls}"><td style="padding-left:${8 + indent * 16}px">${forte ? `<b>${rot}</b>` : rot}</td>${meses.map((m) => celula(vals[m] || 0, forte)).join('')}${meses.length > 1 ? celula(vals.total ?? 0, true) : ''}</tr>`;
  const grupo = (kind) => {
    const g = d.grupos.find((x) => x.kind === kind);
    return lin(esc(g.titulo), { ...g.valores, total: g.total }, { forte: true }) + g.contas.map((c) => lin(`<span class="muted">${esc(c.code)}</span> ${esc(c.name)}`, c.valores && { ...c.valores, total: c.total }, { indent: 1 })).join('');
  };
  const sub = (rot, o) => lin(rot, o, { forte: true, cls: 'linha-subtotal' });
  return `${filtros}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Receita bruta</div><div class="k-value" style="font-size:19px">${fmtBRL(d.grupos[0].total)}</div><div class="k-sub">${meses.length} mês(es)</div></div>
      <div class="card kpi"><div class="k-label">Resultado líquido</div><div class="k-value" style="font-size:19px${d.liquido.total < 0 ? ';color:var(--crit)' : ''}">${fmtBRL(d.liquido.total)}</div><div class="k-sub">${d.margem != null ? `margem ${String(d.margem).replace('.', ',')}% da receita` : 'sem receita no período'}</div></div>
    </div>
    <div class="card table-wrap"><table class="data dre"><thead><tr>${cab}</tr></thead><tbody>
      ${grupo('receita')}${grupo('deducao')}${sub('= Receita líquida', d.receitaLiquida)}
      ${grupo('custo_obra')}${sub('= Lucro bruto', d.lucroBruto)}
      ${grupo('despesa_adm')}${grupo('despesa_financeira')}${sub('= Resultado antes dos impostos sobre o lucro', d.antesIR)}
      ${grupo('imposto_lucro')}${sub('= Resultado líquido', d.liquido)}
    </tbody></table></div>
    <h2 style="margin:6px 0 0">Fora da DRE (no período)</h2>
    <div class="card table-wrap"><table class="data"><thead><tr>${cab}</tr></thead><tbody>
      ${lin('Aportes recebidos de clientes (obras por administração)', d.fora.aportes)}
      ${lin('Custos de obras por administração (recursos do cliente)', d.fora.custosAdm)}
      ${lin('Pagos direto pelos clientes / com recursos de clientes', d.fora.clienteDireto)}
      ${lin('Movimentações fora do resultado (empréstimos, investimentos, retiradas)', d.fora.naoOperacional)}
    </tbody></table></div>
    <div class="muted small">Regime de <b>competência</b>: lançamentos da empresa pelo mês de competência e custos das obras pela data da despesa, na conta da categoria (Material → 3.1, Mão de obra → 3.2…). Obras <b>por administração</b> ficam fora: o dinheiro é do cliente; entram na DRE só a taxa e as receitas lançadas. Com um centro de custo escolhido, os lançamentos rateados entram pela parte daquele centro.</div>`;
}

function viewCaixa() {
  const f = R();
  const hoje = todayISO();
  const mesHoje = hoje.slice(0, 7);
  const [de, ate] = f.gran === 'dia' ? [`${mesHoje}-01`, fimDoMes(mesHoje)] : [`${somaMeses(mesHoje, -3)}-01`, fimDoMes(somaMeses(mesHoje, 8))];
  const mov = movObras('2000-01-01', ate);
  const cc = centroPorId(f.centroCx);
  const filtros = `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
    <label class="field" style="max-width:220px">Visão<select data-chg="finRel" data-k="gran"><option value="mes" ${f.gran === 'mes' ? 'selected' : ''}>Mensal (3 meses atrás a 8 à frente)</option><option value="dia" ${f.gran === 'dia' ? 'selected' : ''}>Diária (mês atual)</option></select></label>
    ${filtroCentro('centroCx')}</div>`;
  if (!mov) return `${filtros}<div class="card empty"><p>${MOV.erro ? esc(MOV.erro) : 'Calculando…'}</p></div>`;
  const x = montarFluxo({ entradas: F.entradas, splits: F.splits, baixas: F.baixas, obrasMov: mov, bancos: F.bancos.filter((b) => b.active), de, ate, gran: f.gran, hoje,
    centroId: f.centroCx || null, projetoDoCentro: cc?.project_id || null });
  const rot = (k) => (f.gran === 'mes' ? rotMes(k) : isoBR(k));
  const negativo = x.periodos.find((p) => !p.passado && p.saldo < 0);
  return `${filtros}
    ${negativo ? `<div class="alert err small"><b>Vai faltar caixa:</b> o saldo projetado fica negativo em ${rot(negativo.chave)} (${fmtBRL(negativo.saldo)}). Antecipe recebimentos, negocie prazos ou programe um aporte.</div>` : ''}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Saldo no início</div><div class="k-value" style="font-size:19px">${fmtBRL(x.saldoInicial)}</div><div class="k-sub">${f.centroCx ? 'com filtro de centro: começa em zero' : 'saldos iniciais das contas + realizado antes'}</div></div>
      <div class="card kpi"><div class="k-label">Menor saldo projetado</div><div class="k-value" style="font-size:19px${x.menorSaldo?.saldo < 0 ? ';color:var(--crit)' : ''}">${fmtBRL(x.menorSaldo?.saldo || 0)}</div><div class="k-sub">${x.menorSaldo ? rot(x.menorSaldo.chave) : ''}</div></div>
      <div class="card kpi"><div class="k-label">A receber previsto</div><div class="k-value" style="font-size:19px">${fmtBRL(x.totais.entradasPrevistas)}</div><div class="k-sub">no período</div></div>
      <div class="card kpi"><div class="k-label">A pagar previsto</div><div class="k-value" style="font-size:19px">${fmtBRL(x.totais.saidasPrevistas)}</div><div class="k-sub">empresa e obras</div></div>
    </div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>${f.gran === 'mes' ? 'Mês' : 'Dia'}</th><th class="num">Entradas previstas</th><th class="num">Entradas realizadas</th><th class="num">Saídas previstas</th><th class="num">Saídas realizadas</th><th class="num">Saldo</th></tr></thead><tbody>
      ${x.periodos.map((p) => `<tr${p.atual ? ' style="outline:2px solid var(--cor-area, var(--accent));outline-offset:-2px"' : ''}><td class="nowrap">${rot(p.chave)}${p.atual ? ' <span class="badge info">hoje</span>' : p.passado ? '' : ' <span class="muted small">previsto</span>'}</td>
        ${celula(p.passado ? 0 : p.entradasPrevistas)}${celula(p.entradasRealizadas)}${celula(p.passado ? 0 : -p.saidasPrevistas)}${celula(-p.saidasRealizadas)}${celula(p.saldo, true)}</tr>`).join('')}
    </tbody></table></div>
    <div class="muted small">Regime de <b>caixa</b>. Realizado = recebimentos e pagamentos da empresa (o que o cliente pagou direto na loja não passa pelo caixa) + pagamentos das despesas das obras. Previsto = saldos em aberto pela data de vencimento; o que já venceu e não foi pago entra no período de hoje. Saldo = saldo anterior + realizado (passado) ou previsto (de hoje em diante). Cadastre o saldo inicial de cada conta em Cadastros financeiros.</div>`;
}
const ABAS_CAD = [['plano', 'Plano de contas'], ['centros', 'Centros de custo'], ['bancos', 'Contas bancárias'], ['empresa', 'Regime tributário']];

export function viewFinEmpresa(route) {
  const cab = (t, s) => `<div class="page-head"><div><h1>${t}</h1><div class="muted">${s}</div></div>${route.secao === 'lancamentos' && gravaFinEmpresa() && F.carregado
    ? `<div class="row"><button class="btn" data-act="finNovo" data-k="receber">${I.plus} Conta a receber</button><button class="btn primary" data-act="finNovo" data-k="pagar">${I.plus} Conta a pagar</button></div>` : ''}</div>`;
  if (!nuvemConfigurada()) return `${cab('Financeiro da empresa', '')}<div class="card empty"><p>O financeiro da empresa funciona no modo nuvem (banco de dados da empresa).</p></div>`;
  if (!veFinEmpresa()) return `${cab('Financeiro da empresa', '')}<div class="card empty"><p>Seu perfil não acessa o financeiro da empresa (só administrador, financeiro e contador).</p></div>`;
  if (!F.carregando && (!F.carregado || Date.now() - F.em > 60000)) setTimeout(() => carregarFinEmpresa(true));
  const t = route.secao === 'cadastros' ? ['Cadastros financeiros', 'Plano de contas com De/Para contábil, centros de custo, contas bancárias e regime tributário.']
    : route.secao === 'contratos' ? ['Contratos com clientes', 'Regime de cada obra, taxa de administração, verbas com teto, recebimentos e prestação de contas mensal.']
      : route.secao === 'dre' ? ['DRE gerencial', 'Resultado da construtora por competência: receitas, deduções, custos das obras, despesas e resultado líquido.']
      : route.secao === 'caixa' ? ['Fluxo de caixa', 'Previsto × realizado, mês a mês ou dia a dia, com o saldo projetado — para saber se vai faltar caixa.']
      : route.secao === 'fiscal' ? ['Fiscal', 'Notas de serviço emitidas com retenções, notas de compra das obras e INSS por obra (CNO).']
      : route.secao === 'conciliacao' ? ['Conciliação bancária', 'Importe o extrato do banco (OFX) e confira cada linha com os pagamentos e recebimentos lançados.']
      : route.secao === 'exportacao' ? ['Exportação para o contador', 'Arquivo com os lançamentos do período (data, valor, histórico, conta débito, conta crédito e centro de custo) para importar na contabilidade.']
      : route.secao === 'auditoria' ? ['Auditoria', 'Quem fez o quê e quando: cada criação, alteração, estorno e cancelamento, com o antes e o depois.']
      : ['Lançamentos da empresa', 'Contas a pagar e a receber do escritório e das obras, com rateio por centro de custo. Os custos lançados dentro de cada obra continuam em Custos da obra.'];
  if (!F.carregado) return `${cab(...t)}<div class="card empty"><p>${F.erro ? esc(F.erro) : 'Carregando…'}</p></div>`;
  if (route.secao === 'prestacao') return viewPrestacao(route.aba, route.mes);
  if (route.secao === 'contratos' && route.aba) return viewContrato(route.aba);
  const nav = '';
  const corpo = route.secao === 'cadastros' ? viewCadastros(route.aba || 'plano') : route.secao === 'contratos' ? viewContratos()
    : route.secao === 'dre' ? viewDRE() : route.secao === 'caixa' ? viewCaixa() : route.secao === 'fiscal' ? viewFiscal(route.aba || 'saida') : route.secao === 'conciliacao' ? viewConciliacao()
    : route.secao === 'exportacao' ? viewExportacao() : route.secao === 'auditoria' ? viewAuditoria() : viewLancamentos();
  return `${cab(...t)}${nav}<div class="stack" style="margin-top:12px">${F.erro ? `<div class="alert err">${esc(F.erro)}</div>` : ''}${ctx().papel === 'contador' ? '<div class="alert info small">Perfil contador: consulta e exportação. Lançamentos e cadastros ficam com o administrador e o financeiro.</div>' : ''}${corpo}</div>`;
}

/* ----- Lançamentos ----- */
function filtros() {
  ui.finF ||= { tipo: '', situacao: 'abertos', centro: '' };
  return ui.finF;
}
function rotRateio(e) {
  if (!e.rateio.length) return '—';
  if (e.rateio.length === 1) return esc(nomeCentro(centroPorId(e.rateio[0].cost_center_id)));
  return e.rateio.map((r) => `${esc(centroPorId(r.cost_center_id)?.name || '?')} ${fmtIn(r.pct, 2)}%`).join('<br>');
}
function viewLancamentos() {
  const f = filtros();
  const hoje = todayISO();
  const r = resumoLancamentos(F.entradas, F.baixas, { hoje, tipo: f.tipo, situacao: f.situacao, centro: f.centro, splits: F.splits });
  const t = r.totais;
  const kpi = (tt, v, s, cor = '') => `<div class="card kpi"><div class="k-label">${tt}</div><div class="k-value" style="font-size:19px${cor ? `;color:${cor}` : ''}">${fmtBRL(v)}</div><div class="k-sub">${s}</div></div>`;
  const grava = gravaFinEmpresa();
  const linhas = r.linhas.map((e) => {
    const conta = contaPorId(e.account_id);
    const venc = ['aberto', 'parcial'].includes(e.situacao) && e.due_date < hoje;
    return `<tr${e.situacao === 'cancelado' ? ' style="opacity:.6"' : ''}><td class="nowrap">${isoBR(e.due_date)}${venc ? '<div><span class="badge crit">vencido</span></div>' : ''}</td>
      <td><span class="badge ${e.kind === 'pagar' ? 'warn' : 'good'}">${e.kind === 'pagar' ? 'Pagar' : 'Receber'}</span></td>
      <td><b>${esc(e.description)}</b>${e.party_name ? `<div class="small">${esc(e.party_name)}</div>` : ''}<div class="muted small">${esc(conta ? `${conta.code} ${conta.name}` : '')}${e.document ? ` · ${esc(e.document)}` : ''} · competência ${esc(e.competence.slice(5, 7))}/${esc(e.competence.slice(0, 4))}</div></td>
      <td class="small">${rotRateio(e)}</td>
      <td class="num nowrap">${fmtBRL(e.amount)}</td><td class="num nowrap">${e.pago ? fmtBRL(e.pago) : '—'}${e.clientePagou ? '<div class="muted small">cliente pagou</div>' : ''}</td>
      <td class="num nowrap"><b>${e.situacao === 'cancelado' ? '—' : fmtBRL(e.saldo)}</b></td>
      <td><span class="badge ${{ quitado: 'good', parcial: 'info', cancelado: '' }[e.situacao] || 'warn'}">${SITUACOES[e.situacao]}</span></td>
      <td class="nowrap">${grava && ['aberto', 'parcial'].includes(e.situacao) ? `<button class="btn sm primary" data-act="finBaixar" data-id="${e.id}">${e.kind === 'pagar' ? 'Pagar' : 'Receber'}</button> ` : ''}
        <button class="icon-btn" title="Detalhes, baixas e estorno" data-act="finDetalhe" data-id="${e.id}">${I.more}</button></td></tr>`;
  }).join('');
  const sel = (k, opcoes) => `<select data-chg="finFiltro" data-k="${k}">${opcoes.map(([v, l]) => `<option value="${v}" ${f[k] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="kpis">
      ${kpi('A pagar (em aberto)', t.aPagar, t.vencidosPagar ? `${fmtBRL(t.vencidosPagar)} vencido` : 'nada vencido', t.vencidosPagar ? 'var(--crit)' : '')}
      ${kpi('A receber (em aberto)', t.aReceber, t.vencidosReceber ? `${fmtBRL(t.vencidosReceber)} vencido` : 'nada vencido')}
      ${kpi('Pago neste mês', t.pagoMes, 'pela empresa (sem o que o cliente pagou direto)')}
      ${kpi('Recebido neste mês', t.recebidoMes, 'entradas registradas')}
    </div>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="field" style="max-width:160px">Tipo${sel('tipo', [['', 'Pagar e receber'], ['pagar', 'A pagar'], ['receber', 'A receber']])}</label>
      <label class="field" style="max-width:170px">Situação${sel('situacao', [['abertos', 'Em aberto'], ['quitado', 'Quitados'], ['cancelado', 'Cancelados'], ['todos', 'Todos']])}</label>
      <label class="field" style="max-width:260px">Centro de custo${sel('centro', [['', 'Todos'], ...F.centros.filter((c) => c.active).map((c) => [c.id, nomeCentro(c)])])}</label>
    </div>
    ${linhas ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Vencimento</th><th>Tipo</th><th>Descrição</th><th>Centro de custo</th><th class="num">Valor</th><th class="num">Pago / recebido</th><th class="num">Saldo</th><th>Situação</th><th></th></tr></thead><tbody>${linhas}</tbody>
      <tfoot><tr><th colspan="6">Saldo dos lançamentos listados</th><th class="num nowrap">${fmtBRL(r.linhas.reduce((s, e) => s + e.saldo, 0))}</th><th colspan="2"></th></tr></tfoot></table></div>`
      : `<div class="card empty"><p>Nenhum lançamento ${f.situacao === 'abertos' ? 'em aberto' : 'neste filtro'}.</p>${grava ? '<p class="small muted">Lance aqui as contas do escritório (aluguel, salários, contador, impostos) e as receitas (taxa de administração, medições). O que é gasto de obra continua em Custos da obra.</p>' : ''}</div>`}
    <div class="muted small">Rateio: um lançamento pode ser dividido entre vários centros de custo (ex.: salário do engenheiro entre a Matriz e as obras). "Cliente pagou direto" registra o que o cliente da obra por administração pagou na loja, sem passar pela conta da empresa. Nada é apagado: baixa errada é estornada e lançamento errado é cancelado, sempre com motivo.</div>`;
}

/* ----- Cadastros ----- */
function viewCadastros(aba) {
  const nav = `<nav class="row" style="gap:6px;flex-wrap:wrap">${ABAS_CAD.map(([k, r]) => `<a class="btn sm ${k === aba ? 'primary' : ''}" href="#/fin/cadastros/${k}" ${k === aba ? 'aria-current="page"' : ''}>${r}</a>`).join('')}</nav>`;
  const corpo = { plano: abaPlano, centros: abaCentros, bancos: abaBancos, empresa: abaRegime }[aba] || abaPlano;
  return nav + corpo();
}
function abaPlano() {
  const grava = gravaFinEmpresa();
  const linhas = arvoreContas(F.contas).map((c) => `<tr${c.active ? '' : ' style="opacity:.55"'}><td class="nowrap" style="padding-left:${8 + (c.nivel - 1) * 16}px">${c.nivel === 1 ? `<b>${esc(c.code)}</b>` : esc(c.code)}</td>
    <td>${c.nivel === 1 ? `<b>${esc(c.name)}</b>` : esc(c.name)}${c.obra_category ? `<div class="muted small">recebe os custos "${esc(c.obra_category)}" das obras</div>` : ''}${c.active ? '' : ' <span class="badge">inativa</span>'}</td>
    <td class="small">${c.nivel === 1 ? esc(TIPOS_CONTA[c.kind]) : ''}</td>
    <td class="small">${esc(c.accounting_code || '')}${c.accounting_name ? `<div class="muted">${esc(c.accounting_name)}</div>` : ''}</td>
    <td class="nowrap">${grava ? `<button class="btn sm" data-act="finConta" data-id="${c.id}">Editar</button>${c.nivel === 1 ? ` <button class="btn sm" data-act="finSubconta" data-id="${c.id}" title="Nova conta dentro de ${esc(c.name)}">${I.plus} Conta</button>` : ''}` : ''}</td></tr>`).join('');
  return `<div class="card table-wrap"><table class="data"><thead><tr><th>Código</th><th>Conta</th><th>Tipo</th><th>De/Para contábil</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="muted small">Plano gerencial da construtora, já pronto para usar. Nas contas que vêm prontas, o código e o tipo não mudam: renomeie à vontade e crie as suas com "+ Conta" no grupo. Os grupos 1 a 6 formam a DRE; o 7 (recursos de clientes das obras por administração) e o 8 (transferências, empréstimos, investimentos e retiradas) ficam fora do resultado e entram só no fluxo de caixa. No <b>De/Para contábil</b>, informe a conta (ou o código reduzido) do plano do seu contador — é o que vai na exportação para a contabilidade.</div>`;
}
function abaCentros() {
  const grava = gravaFinEmpresa();
  const ordem = { matriz: 0, obra: 1, outro: 2 };
  const linhas = [...F.centros].sort((a, b) => ordem[a.kind] - ordem[b.kind] || a.name.localeCompare(b.name, 'pt-BR')).map((c) => `<tr${c.active ? '' : ' style="opacity:.55"'}>
    <td>${esc(c.code || '')}</td><td><b>${esc(c.name)}</b>${c.active ? '' : ' <span class="badge">inativo</span>'}</td>
    <td class="small">${{ matriz: 'Administrativo / Matriz', obra: 'Obra', outro: 'Outro' }[c.kind]}</td>
    <td class="small">${c.kind === 'obra' ? (c.client_funds ? '<span class="badge info">por administração</span><div class="muted">custos com recursos do cliente, fora da DRE</div>' : 'empreitada / preço fechado') : '—'}</td>
    <td class="nowrap">${grava ? `<button class="btn sm" data-act="finCentro" data-id="${c.id}">Editar</button>` : ''}</td></tr>`).join('');
  return `${grava ? `<div><button class="btn sm" data-act="finCentro">${I.plus} Centro de custo</button></div>` : ''}
    <div class="card table-wrap"><table class="data"><thead><tr><th>Código</th><th>Centro de custo</th><th>Tipo</th><th>Contrato</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="muted small">A Matriz e um centro para cada obra são criados sozinhos (o nome acompanha a obra). Marque <b>por administração</b> nas obras em que o cliente paga os custos: esses valores ficam em "recursos do cliente" e não inflam o faturamento da construtora.</div>`;
}
function abaBancos() {
  const grava = gravaFinEmpresa();
  const saldo = (b) => {
    const mov = F.baixas.filter((s) => !s.deleted_at && s.bank_account_id === b.id).reduce((t, s) => {
      const e = F.entradas.find((x) => x.id === s.entry_id);
      return t + (e?.kind === 'receber' ? 1 : -1) * Number(s.amount);
    }, 0);
    return Number(b.opening_balance) + mov;
  };
  const linhas = F.bancos.map((b) => `<tr${b.active ? '' : ' style="opacity:.55"'}><td><b>${esc(b.name)}</b>${b.active ? '' : ' <span class="badge">inativa</span>'}<div class="muted small">${esc(TIPOS_BANCO[b.kind])}${b.bank ? ` · ${esc(b.bank)}` : ''}${b.agency ? ` · ag. ${esc(b.agency)}` : ''}${b.account_number ? ` · c/c ${esc(b.account_number)}` : ''}</div></td>
    <td class="small">${b.cost_center_id ? esc(nomeCentro(centroPorId(b.cost_center_id))) : 'Empresa'}</td><td class="small">${esc(b.accounting_code || '—')}</td>
    <td class="num nowrap">${fmtBRL(b.opening_balance)}<div class="muted small">em ${isoBR(b.opening_date)}</div></td><td class="num nowrap"><b>${fmtBRL(saldo(b))}</b></td>
    <td class="nowrap">${grava ? `<button class="btn sm" data-act="finBanco" data-id="${b.id}">Editar</button>` : ''}</td></tr>`).join('');
  return `${grava ? `<div><button class="btn sm" data-act="finBanco">${I.plus} Conta bancária</button></div>` : ''}
    <div class="card table-wrap"><table class="data"><thead><tr><th>Conta</th><th>Uso</th><th>Conta contábil</th><th class="num">Saldo inicial</th><th class="num">Saldo pelo sistema</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="muted small">Saldo pelo sistema = saldo inicial + recebimentos − pagamentos lançados aqui. A conferência com o extrato do banco (arquivo OFX) vem na etapa de conciliação. Conta de uma obra específica (patrimônio de afetação): escolha a obra em "Uso".</div>`;
}
function abaRegime() {
  const admin = ctx().papel === 'admin';
  return `<div class="card card-pad stack" style="max-width:720px"><h2>Regime tributário da empresa</h2>
    <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap"><label class="field" style="max-width:260px">Regime<select data-chg="finRegime" ${admin ? '' : 'disabled'}>${Object.entries(REGIMES).map(([k, l]) => `<option value="${k}" ${F.regime === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${admin ? '' : '<span class="muted small">Só o administrador altera.</span>'}</div>
    <div class="small"><b>Simples Nacional:</b> os impostos sobre o faturamento saem num guia só (DAS, conta 2.1). <b>Lucro Presumido:</b> PIS, COFINS e ISS sobre o faturamento (contas 2.2 a 2.4) e IRPJ e CSLL sobre o lucro presumido (6.1 e 6.2). O regime define quais impostos aparecem na DRE e nas retenções das notas de serviço (próximas etapas). Confirme com o seu contador.</div></div>`;
}

/* ----- Conciliação bancária ----- */
const bancoConc = () => { ui.finConc ||= {}; const ativos = F.bancos.filter((b) => b.active); if (!ativos.some((b) => b.id === ui.finConc.banco)) ui.finConc.banco = (ativos.find((b) => b.kind !== 'caixa') || ativos[0])?.id || ''; return bancoPorId(ui.finConc.banco); };
/** Candidatos a conciliar com as linhas da conta: baixas da empresa nesta conta e pagamentos das despesas das obras. */
function candidatosConc(banco) {
  const ligadasB = new Set(F.linhasBanco.map((l) => l.settlement_id).filter(Boolean));
  const ligadosP = new Set(F.linhasBanco.map((l) => l.payment_id).filter(Boolean));
  const kind = new Map(F.entradas.map((e) => [e.id, e]));
  const out = F.baixas.filter((b) => !b.deleted_at && b.bank_account_id === banco.id && !ligadasB.has(b.id)).map((b) => {
    const e = kind.get(b.entry_id);
    return { tipo: 'baixa', id: b.id, valor: (e?.kind === 'receber' ? 1 : -1) * Number(b.amount), data: b.pay_date, descricao: `${e?.description || ''}${e?.party_name ? ` — ${e.party_name}` : ''}` };
  });
  for (const o of store.obras()) for (const d of o.despesas || []) {
    if (d.transferenciaId) continue;
    for (const p of d.pagamentos || []) if (p.id && !ligadosP.has(p.id)) out.push({ tipo: 'pagamento', id: p.id, valor: -Number(p.valor), data: p.data, descricao: `${o.nome}: ${d.fornecedor || ''} ${d.documento || ''}`.trim() });
  }
  return out;
}
function viewConciliacao() {
  const banco = bancoConc();
  if (!banco) return '<div class="card empty"><p>Cadastre uma conta bancária em Cadastros financeiros.</p></div>';
  const grava = gravaFinEmpresa();
  const linhas = F.linhasBanco.filter((l) => l.bank_account_id === banco.id);
  const pend = linhas.filter((l) => l.status === 'pendente');
  const sug = sugerirConciliacao(pend, candidatosConc(banco));
  const r = resumoConta(banco, { baixas: F.baixas, entradas: F.entradas, linhas: F.linhasBanco, extratos: F.extratos });
  const ref = (l) => { if (l.settlement_id) { const b = F.baixas.find((x) => x.id === l.settlement_id); const e = b && F.entradas.find((x) => x.id === b.entry_id); return e ? esc(e.description) : 'baixa'; }
    if (l.payment_id) { for (const o of store.obras()) for (const d of o.despesas || []) if ((d.pagamentos || []).some((p) => p.id === l.payment_id)) return `${esc(o.nome)}: ${esc(d.fornecedor || '')} ${esc(d.documento || '')}`; return 'pagamento de obra'; } return ''; };
  const valor = (v) => `<span style="color:${v < 0 ? 'var(--crit)' : 'var(--good, inherit)'}">${fmtBRL(v)}</span>`;
  return `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="field" style="max-width:300px">Conta<select data-chg="finConcBanco">${F.bancos.filter((b) => b.active).map((b) => `<option value="${b.id}" ${b.id === banco.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      ${grava ? `<button class="btn primary" data-act="finImportarOfx">Importar extrato (OFX)</button>${sug.size ? `<button class="btn" data-act="finConciliarTodas">Conciliar as ${sug.size} sugestões</button>` : ''}` : ''}</div>
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Saldo pelo sistema</div><div class="k-value" style="font-size:19px">${fmtBRL(r.sistema)}</div><div class="k-sub">saldo inicial + baixas nesta conta</div></div>
      <div class="card kpi"><div class="k-label">Saldo do extrato</div><div class="k-value" style="font-size:19px">${r.extrato != null ? fmtBRL(r.extrato) : '—'}</div><div class="k-sub">${r.extratoData ? `em ${isoBR(r.extratoData)}` : 'importe um extrato'}</div></div>
      <div class="card kpi"><div class="k-label">Diferença</div><div class="k-value" style="font-size:19px${r.diferenca ? ';color:var(--crit)' : ''}">${r.diferenca != null ? fmtBRL(r.diferenca) : '—'}</div><div class="k-sub">${r.diferenca ? 'algo do banco ainda não está no sistema (ou vice-versa)' : r.diferenca === 0 ? 'conta batendo' : ''}</div></div>
      <div class="card kpi"><div class="k-label">Linhas do extrato</div><div class="k-value">${r.pendentes}</div><div class="k-sub">pendentes · ${r.conciliadas} conciliadas · ${r.ignoradas} ignoradas</div></div>
    </div>
    <h2 style="margin:6px 0 0">Pendentes</h2>
    ${pend.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Data</th><th>No extrato</th><th class="num">Valor</th><th>Sugestão do sistema</th><th></th></tr></thead><tbody>
      ${pend.map((l) => { const s = sug.get(l.id); return `<tr><td class="nowrap">${isoBR(l.posted_date)}</td><td class="small">${esc(l.memo || '—')}${l.note ? `<div class="muted">${esc(l.note)}</div>` : ''}</td><td class="num nowrap">${valor(Number(l.amount))}</td>
        <td class="small">${s ? `<span class="badge ${s.tipo === 'baixa' ? 'info' : ''}">${s.tipo === 'baixa' ? 'lançamento' : 'pagamento de obra'}</span> ${esc(s.descricao)}<div class="muted">${isoBR(s.data)}${s.dias ? ` · ${s.dias} dia(s) de diferença` : ' · mesma data'}</div>` : '<span class="muted">nenhum lançamento com este valor</span>'}</td>
        <td class="nowrap">${grava ? `${s ? `<button class="btn sm primary" data-act="finConciliar" data-l="${l.id}" data-t="${s.tipo}" data-id="${s.id}">Conciliar</button> ` : ''}<button class="btn sm" data-act="finEscolherConc" data-l="${l.id}">Escolher</button> <button class="btn sm" data-act="finLancarLinha" data-l="${l.id}">Lançar</button> <button class="btn sm" data-act="finIgnorarLinha" data-l="${l.id}">Ignorar</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="card empty"><p>${linhas.length ? 'Tudo conciliado nesta conta.' : 'Nenhum extrato importado nesta conta.'}</p>${!linhas.length ? '<p class="small muted">No site do banco, exporte o extrato no formato OFX (às vezes chamado "Money" ou "Microsoft Money") e importe aqui.</p>' : ''}</div>`}
    ${linhas.some((l) => l.status !== 'pendente') ? `<details><summary class="small"><b>Conciliadas e ignoradas</b> (${linhas.length - pend.length})</summary><div class="card table-wrap"><table class="data"><thead><tr><th>Data</th><th>No extrato</th><th class="num">Valor</th><th>Ligada a</th><th></th></tr></thead><tbody>
      ${linhas.filter((l) => l.status !== 'pendente').slice(0, 200).map((l) => `<tr><td class="nowrap">${isoBR(l.posted_date)}</td><td class="small">${esc(l.memo || '')}</td><td class="num nowrap">${valor(Number(l.amount))}</td>
        <td class="small">${l.status === 'ignorado' ? `<span class="badge">ignorada</span> ${esc(l.note)}` : ref(l)}<div class="muted">por ${esc(l.matched_label || '—')}</div></td>
        <td>${grava ? `<button class="btn sm" data-act="finDesconciliar" data-l="${l.id}">Desfazer</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}
    <div class="muted small">A sugestão junta linha e lançamento de <b>mesmo valor</b> com data até 5 dias de diferença (pagamentos e recebimentos da empresa nesta conta, ou pagamentos das notas das obras). "Lançar" cria o lançamento para o que só aparece no banco (tarifa, juros, rendimento) já pago e conciliado. Conciliado não se estorna nem se edita: desfaça a conciliação antes (com motivo). Extrato importado de novo não duplica linhas.</div>`;
}
async function importarOfx() {
  const banco = bancoConc();
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.ofx,.OFX,application/x-ofx,text/plain';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const texto = await f.text();
    const x = lerOFX(texto);
    if (x.erro) return toast(x.erro, 6000);
    const ent = x.linhas.filter((l) => l.valor > 0).reduce((s, l) => s + l.valor, 0), sai = x.linhas.filter((l) => l.valor < 0).reduce((s, l) => s + l.valor, 0);
    const conf = await formDialog({ title: `Importar ${f.name}`, ok: 'Importar',
      text: `${x.linhas.length} lançamento(s) de ${isoBR(x.linhas.map((l) => l.data).sort()[0])} a ${isoBR(x.linhas.map((l) => l.data).sort().at(-1))} — entradas ${fmtBRL(ent)}, saídas ${fmtBRL(sai)}${x.saldo != null ? `, saldo ${fmtBRL(x.saldo)}` : ''}. Vai para a conta "${banco.name}"${x.conta ? ` (no arquivo: conta ${x.conta})` : ''}. Linhas já importadas antes ficam de fora.`,
      fields: [] });
    if (!conf) return;
    const r = ok(await (await sb()).rpc('importar_extrato', { p_bank_account: banco.id, p_file_name: f.name, p_linhas: x.linhas, p_saldo: x.saldo, p_saldo_data: x.saldoData }), 'importar extrato');
    await carregarFinEmpresa(true);
    toast(`${r.novas} linha(s) nova(s)${r.repetidas ? `, ${r.repetidas} já importada(s)` : ''}.`, 5000);
  };
  inp.click();
}

/* ----- Exportação contábil ----- */
const somaDiasISO = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const XF = () => {
  if (!ui.finExp) { const ant = somaMeses(todayISO().slice(0, 7), -1); ui.finExp = { de: `${ant}-01`, ate: fimDoMes(ant), banco: '', porCentro: '1', formato: 'csv' }; }
  const ativos = F.bancos.filter((b) => b.active);
  if (!ativos.some((b) => b.id === ui.finExp.banco)) ui.finExp.banco = (ativos.find((b) => b.kind !== 'caixa') || ativos[0])?.id || '';
  return ui.finExp;
};
const PO = { chave: '', carregando: false, linhas: [], erro: '' };
function pagamentosObras(de, ate) {
  const chave = `${de}|${ate}|${F.em}`;
  if (PO.chave !== chave && !PO.carregando) {
    PO.carregando = true;
    sb().then((c) => c.rpc('contabil_pagamentos_obras', { p_org: ctx().orgId, p_de: de, p_ate: ate }))
      .then(({ data, error }) => { if (error) throw erroBanco(error, 'pagamentos das obras'); PO.linhas = (data || []).map((p) => ({ ...p, amount: Number(p.amount) })); PO.erro = ''; })
      .catch((e) => { PO.erro = e.message; PO.linhas = []; })
      .finally(() => { PO.chave = chave; PO.carregando = false; queueRender(); });
  }
  return PO.chave === chave ? PO.linhas : null;
}
function dadosExportacao() {
  const f = XF();
  const pag = pagamentosObras(f.de, f.ate);
  if (!pag) return null;
  return montarExportacao({ de: f.de, ate: f.ate, entradas: F.entradas, splits: F.splits, baixas: F.baixas, contas: F.contas, centros: F.centros, bancos: F.bancos,
    pagObras: pag, bancoObras: f.banco, porCentro: f.porCentro === '1' });
}
function viewExportacao() {
  const f = XF();
  const x = dadosExportacao();
  const sel = (k, opcoes) => `<select data-chg="finExp" data-k="${k}">${opcoes.map(([v, l]) => `<option value="${v}" ${f[k] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const filtros = `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="field" style="max-width:170px">De<input type="date" value="${f.de}" data-chg="finExp" data-k="de"></label>
      <label class="field" style="max-width:170px">Até<input type="date" value="${f.ate}" data-chg="finExp" data-k="ate"></label>
      <label class="field" style="max-width:280px">Conta que paga as obras${sel('banco', [['', '— escolha —'], ...F.bancos.filter((b) => b.active).map((b) => [b.id, b.name])])}</label>
      <label class="field" style="max-width:240px">Rateio${sel('porCentro', [['1', 'Uma linha por centro de custo'], ['0', 'Uma linha por pagamento']])}</label>
      <label class="field" style="max-width:200px">Formato${sel('formato', [['csv', 'CSV (Excel, ;)'], ['txt', 'TXT (separado por |)']])}</label>
      ${x ? `<button class="btn primary" data-act="finBaixarContabil" ${x.linhas.length ? '' : 'disabled'}>Baixar arquivo</button>` : ''}</div>`;
  if (PO.erro) return `${filtros}<div class="alert err">${esc(PO.erro)}</div>`;
  if (!x) return `${filtros}<div class="card empty"><p>Carregando os pagamentos das obras…</p></div>`;
  const prev = x.linhas.slice(0, 300).map((l) => `<tr><td class="nowrap">${isoBR(l.data)}</td><td class="num nowrap">${fmtBRL(l.valor)}</td><td class="small">${esc(l.historico)}${l.origem === 'obra' ? ' <span class="badge">obra</span>' : ''}</td>
    <td class="small">${l.debito ? esc(l.debito) : '<span class="badge crit">sem conta</span>'}</td><td class="small">${l.credito ? esc(l.credito) : '<span class="badge crit">sem conta</span>'}</td><td class="small">${esc(l.centro || '—')}</td></tr>`).join('');
  return `${filtros}
    ${x.pendencias.length ? `<div class="alert warn small"><b>Antes de mandar ao contador, complete o De/Para</b> (Cadastros financeiros):<ul style="margin:6px 0 0 18px">${x.pendencias.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Lançamentos no arquivo</div><div class="k-value">${x.linhas.length}</div><div class="k-sub">${x.linhas.filter((l) => l.origem === 'obra').length} pagamentos de obras</div></div>
      <div class="card kpi"><div class="k-label">Valor total</div><div class="k-value" style="font-size:19px">${fmtBRL(x.total)}</div><div class="k-sub">entradas e saídas somadas</div></div>
      <div class="card kpi"><div class="k-label">Sem conta contábil</div><div class="k-value" style="${x.semConta ? 'color:var(--crit)' : ''}">${x.semConta}</div><div class="k-sub">${x.semConta ? 'débito ou crédito em branco' : 'tudo com De/Para'}</div></div>
    </div>
    ${prev ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Data</th><th class="num">Valor</th><th>Histórico</th><th>Conta débito</th><th>Conta crédito</th><th>Centro de custo</th></tr></thead><tbody>${prev}</tbody></table></div>${x.linhas.length > 300 ? `<div class="muted small">Mostrando 300 de ${x.linhas.length}; o arquivo leva todos.</div>` : ''}`
      : '<div class="card empty"><p>Nenhum pagamento ou recebimento no período.</p></div>'}
    <div class="muted small">Regime de caixa: o que entrou e saiu das contas da empresa no período. Pagamento: débito na conta do plano (De/Para) e crédito no banco; recebimento: débito no banco e crédito na conta do plano. Pagamentos das obras vão na conta da categoria (por administração: 7.2, recursos do cliente) e saem da conta conciliada com o extrato ou, se não conciliados, da conta escolhida acima. Ficam de fora o que não é dinheiro: "cliente pagou direto" e as retenções das notas (veja Fiscal). Colunas: Data; Valor; Histórico; Conta Débito; Conta Crédito; Centro de Custo.</div>`;
}
function baixarContabil() {
  const f = XF();
  const x = dadosExportacao();
  if (!x?.linhas.length) return toast('Nada para exportar no período.');
  const txt = arquivoContabil(x.linhas, f.formato);
  const blob = new Blob([f.formato === 'csv' ? `﻿${txt}` : txt], { type: f.formato === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `contabil-geplan-${f.de}-a-${f.ate}.${f.formato}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${x.linhas.length} lançamento(s) exportado(s)${x.semConta ? ` — ${x.semConta} sem conta contábil` : ''}.`, 5000);
}

/* ----- Auditoria ----- */
const AF = () => (ui.finAud ||= { de: somaDiasISO(todayISO(), -30), ate: todayISO(), area: '', busca: '' });
const AU = { chave: '', carregando: false, lista: [], erro: '' };
function listaAuditoria(f) {
  const chave = `${f.de}|${f.ate}|${f.area}|${F.em}`;
  if (AU.chave !== chave && !AU.carregando) {
    AU.carregando = true;
    sb().then((c) => c.rpc('auditoria_listar', { p_org: ctx().orgId, p_de: f.de, p_ate: f.ate, p_area: f.area, p_limite: 500 }))
      .then(({ data, error }) => { if (error) throw erroBanco(error, 'auditoria'); AU.lista = data || []; AU.erro = ''; })
      .catch((e) => { AU.erro = e.message; AU.lista = []; })
      .finally(() => { AU.chave = chave; AU.carregando = false; queueRender(); });
  }
  return AU.chave === chave ? AU.lista : null;
}
function viewAuditoria() {
  const f = AF();
  const admin = ctx().papel === 'admin';
  if (!admin) f.area = '';
  const filtros = `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="field" style="max-width:170px">De<input type="date" value="${f.de}" data-chg="finAud" data-k="de"></label>
      <label class="field" style="max-width:170px">Até<input type="date" value="${f.ate}" data-chg="finAud" data-k="ate"></label>
      ${admin ? `<label class="field" style="max-width:220px">Área<select data-chg="finAud" data-k="area">${[['', 'Tudo'], ['financeiro', 'Financeiro da empresa'], ['obras', 'Obras (custos, diário, medições…)'], ['compras', 'Compras, fornecedores e estoque'], ['cadastros', 'Cadastros']]
        .map(([v, l]) => `<option value="${v}" ${f.area === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
      <label class="field" style="max-width:240px">Procurar<input type="search" value="${esc(f.busca)}" placeholder="pessoa, assunto, obra…" data-chg="finAud" data-k="busca"></label></div>`;
  const lista = listaAuditoria(f);
  if (AU.erro) return `${filtros}<div class="alert err">${esc(AU.erro)}</div>`;
  if (!lista) return `${filtros}<div class="card empty"><p>Carregando…</p></div>`;
  const b = f.busca.trim().toLowerCase();
  const regs = lista.map((r) => ({ r, s: resumoAuditoria(r) }))
    .filter(({ r, s }) => !b || `${r.quem} ${s.assunto} ${s.tabela} ${r.obra || ''} ${s.acao}`.toLowerCase().includes(b));
  const quando = (t) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const cor = { Criou: 'good', Alterou: 'info', Apagou: 'crit', Excluiu: 'crit', Estornou: 'warn', Cancelou: 'warn' };
  const linhas = regs.map(({ r, s }) => `<tr><td class="nowrap small">${quando(r.changed_at)}</td><td class="small"><b>${esc(r.quem)}</b></td>
    <td class="small"><span class="badge ${cor[s.acao] || ''}">${esc(s.acao)}</span> ${esc(s.tabela)}${r.obra ? `<div class="muted">${esc(r.obra)}</div>` : ''}</td>
    <td class="small">${esc(s.assunto || '—')}</td>
    <td class="small">${s.campos.slice(0, 6).map((c) => `<div><span class="muted">${esc(c.campo)}:</span> ${c.antes ? `<s>${esc(c.antes)}</s>` : ''}${c.antes && c.depois ? ' → ' : ''}${esc(c.depois)}</div>`).join('')}${s.campos.length > 6 ? `<div class="muted">+${s.campos.length - 6} campo(s)</div>` : ''}</td></tr>`).join('');
  return `${filtros}
    ${linhas ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Quando</th><th>Quem</th><th>O quê</th><th>Assunto</th><th>O que mudou</th></tr></thead><tbody>${linhas}</tbody></table></div>`
      : '<div class="card empty"><p>Nenhuma alteração neste período.</p></div>'}
    <div class="muted small">${lista.length >= 500 ? 'Mostrando as 500 alterações mais recentes do período; diminua o período para ver as anteriores. ' : ''}A trilha é gravada pelo próprio banco a cada alteração e ninguém a altera nem apaga pelo app. ${admin ? 'O administrador vê tudo da empresa.' : 'Seu perfil vê as alterações do financeiro da empresa; o administrador vê tudo.'}</div>`;
}

/* ----- Fiscal ----- */
const ABAS_FISCAL = [['saida', 'Notas de serviço (saída)'], ['entrada', 'Notas de compra (entrada)'], ['inss', 'INSS por obra (CNO)']];
const NE = { carregado: false, carregando: false, lista: [], arquivos: new Map(), erro: '' };
async function carregarNotasEntrada() {
  if (NE.carregando) return;
  NE.carregando = true;
  try {
    const ids = store.obras().map((o) => o.id);
    const c = await sb();
    const docs = ids.length ? ok(await c.from('purchase_documents').select('*').in('project_id', ids).is('deleted_at', null).order('issue_date', { ascending: false }), 'notas de compra') || [] : [];
    const fids = docs.map((d) => d.file_id).filter(Boolean);
    const arqs = fids.length ? ok(await c.from('purchase_files').select('id, name, storage_path, mime_type').in('id', fids), 'arquivos') || [] : [];
    const grupos = docs.length ? ok(await c.from('purchase_groups').select('id, name, letter, supplier_name, order_id').in('id', [...new Set(docs.map((d) => d.group_id))]), 'ordens') || [] : [];
    const peds = grupos.length ? ok(await c.from('purchase_orders').select('id, number').in('id', [...new Set(grupos.map((g) => g.order_id))]), 'pedidos') || [] : [];
    const gp = new Map(grupos.map((g) => [g.id, { ...g, numero: peds.find((p) => p.id === g.order_id)?.number }]));
    NE.lista = docs.map((d) => ({ ...d, grupo: gp.get(d.group_id) }));
    NE.arquivos = new Map(arqs.map((a) => [a.id, a]));
    NE.carregado = true; NE.erro = '';
  } catch (e) { NE.erro = e.message; }
  NE.carregando = false;
  queueRender();
}
function viewFiscal(aba) {
  const nav = `<nav class="row" style="gap:6px;flex-wrap:wrap">${ABAS_FISCAL.map(([k, r]) => `<a class="btn sm ${k === aba ? 'primary' : ''}" href="#/fin/fiscal/${k}">${r}</a>`).join('')}</nav>`;
  return nav + ({ saida: abaNotasSaida, entrada: abaNotasEntrada, inss: abaInss }[aba] || abaNotasSaida)();
}
function abaNotasSaida() {
  const grava = gravaFinEmpresa();
  const ativas = F.notas.filter((n) => n.status === 'emitida');
  const soma = (k) => ativas.reduce((s, n) => s + Number(n[k]), 0);
  const linhas = F.notas.map((n) => {
    const e = F.entradas.find((x) => x.id === n.entry_id);
    const s = e ? saldoLancamento(e, F.baixas) : null;
    return `<tr${n.status === 'cancelada' ? ' style="opacity:.6"' : ''}><td class="nowrap"><b>${esc(n.number)}${n.series ? `/${esc(n.series)}` : ''}</b><div class="muted small">${isoBR(n.issue_date)}</div></td>
      <td>${esc(store.obra(n.project_id)?.nome || '')}${n.cno ? `<div class="muted small">CNO ${esc(n.cno)}</div>` : ''}<div class="small">${esc(n.client_name)}</div></td>
      <td class="num nowrap">${fmtBRL(n.gross)}</td>
      <td class="small nowrap">${n.inss_amount > 0 ? `INSS ${fmtBRL(n.inss_amount)}<br>` : ''}${n.iss_withheld && n.iss_amount > 0 ? `ISS ${fmtBRL(n.iss_amount)}<br>` : ''}${n.irrf_amount > 0 ? `IRRF ${fmtBRL(n.irrf_amount)}<br>` : ''}${Number(n.pis_amount) + Number(n.cofins_amount) + Number(n.csll_amount) > 0 ? `PIS/COFINS/CSLL ${fmtBRL(Number(n.pis_amount) + Number(n.cofins_amount) + Number(n.csll_amount))}` : ''}${n.withheld_total > 0 ? '' : '—'}</td>
      <td class="num nowrap"><b>${fmtBRL(n.net)}</b></td>
      <td class="small">${n.status === 'cancelada' ? `Cancelada<div class="muted">${esc(n.cancel_reason)}</div>` : s ? `<span class="badge ${s.situacao === 'quitado' ? 'good' : 'warn'}">${s.situacao === 'quitado' ? 'Recebida' : `a receber ${fmtBRL(s.saldo)}`}</span>` : ''}</td>
      <td class="nowrap">${grava && n.status === 'emitida' ? `${s && s.saldo > 0 ? `<button class="btn sm primary" data-act="finBaixar" data-id="${n.entry_id}">Receber</button> ` : ''}<button class="btn sm danger" data-act="finCancelarNf" data-id="${n.id}">Cancelar</button>` : ''}</td></tr>`;
  }).join('');
  return `${grava ? `<div><button class="btn primary" data-act="finNovaNf">${I.plus} Registrar nota de serviço</button></div>` : ''}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Notas emitidas</div><div class="k-value" style="font-size:19px">${fmtBRL(soma('gross'))}</div><div class="k-sub">${ativas.length} nota(s) · valor bruto</div></div>
      <div class="card kpi"><div class="k-label">Retido pelos tomadores</div><div class="k-value" style="font-size:19px">${fmtBRL(soma('withheld_total'))}</div><div class="k-sub">INSS ${fmtBRL(soma('inss_amount'))}</div></div>
      <div class="card kpi"><div class="k-label">Líquido a receber</div><div class="k-value" style="font-size:19px">${fmtBRL(soma('net'))}</div><div class="k-sub">bruto − retenções</div></div>
    </div>
    ${linhas ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Nota</th><th>Obra / tomador</th><th class="num">Bruto</th><th>Retenções</th><th class="num">Líquido</th><th>Situação</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>`
      : '<div class="card empty"><p>Nenhuma nota de serviço registrada.</p></div>'}
    <div class="muted small">O GEPLAN <b>registra</b> a nota emitida no portal da prefeitura (não emite). Cada nota vira uma conta a receber pelo valor bruto (receita na DRE); as retenções entram como baixa "retenção" e o que falta receber é o líquido. Alíquotas são sugestões editáveis: confirme com o seu contador. Regime da empresa: <b>${esc(REGIMES[F.regime] || 'não informado')}</b>.</div>`;
}
function abaNotasEntrada() {
  if (!NE.carregado && !NE.carregando) setTimeout(carregarNotasEntrada);
  if (!NE.carregado) return `<div class="card empty"><p>${NE.erro ? esc(NE.erro) : 'Carregando…'}</p></div>`;
  const tipos = { nota_fiscal: 'NF-e', pedido_fornecedor: 'Pedido do fornecedor', recibo: 'Recibo' };
  const linhas = NE.lista.map((d) => { const a = d.file_id && NE.arquivos.get(d.file_id); const g = d.grupo; return `<tr><td class="nowrap">${isoBR(d.issue_date)}</td>
    <td><b>${esc(tipos[d.kind])} ${esc(d.number)}${d.series ? `/${esc(d.series)}` : ''}</b>${d.access_key ? `<div class="muted small">${esc(d.access_key)}</div>` : ''}</td>
    <td>${esc(g?.supplier_name || '')}<div class="muted small">${g ? `<a href="#/suprimentos/pedido/${g.order_id}/compras">PED-${String(g.numero).padStart(4, '0')}-${esc(g.letter)}</a> ${esc(g.name)}` : ''}</div></td>
    <td class="small">${esc(store.obra(d.project_id)?.nome || '')}</td><td class="num nowrap">${fmtBRL(d.amount)}</td>
    <td>${a ? `<button class="btn sm" data-act="finArquivo" data-path="${esc(a.storage_path)}">${/xml/i.test(a.mime_type || a.name) ? 'Baixar XML' : 'Abrir'}</button>` : '—'}</td></tr>`; }).join('');
  return `${linhas ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Data</th><th>Documento</th><th>Fornecedor / ordem de compra</th><th>Obra</th><th class="num">Valor</th><th>Arquivo</th></tr></thead><tbody>${linhas}</tbody></table></div>`
    : '<div class="card empty"><p>Nenhuma nota de compra registrada.</p><p class="small muted">As notas de compra são registradas em Suprimentos, em cada ordem de compra (o XML preenche os dados).</p></div>'}
    <div class="muted small">Notas registradas nas ordens de compra das obras que você pode ver. O XML da NF-e fica guardado em área privada e pode ser baixado para o contador.</div>`;
}
function abaInss() {
  const linhas = inssPorObra({ notas: F.notas, entradas: F.entradas, splits: F.splits, contas: F.contas, centros: F.centros });
  const obras = store.obras();
  return `<div class="card table-wrap"><table class="data"><thead><tr><th>Obra</th><th>CNO</th><th>Competência</th><th class="num">INSS retido nas notas</th><th class="num">Guias lançadas (conta 3.7)</th></tr></thead><tbody>
    ${linhas.map((l) => { const o = obras.find((x) => x.id === l.projectId); return `<tr><td>${esc(o?.nome || '—')}</td><td class="small">${o?.cno ? esc(o.cno) : '<span class="badge warn">sem CNO</span>'}</td><td>${rotMes(l.mes)}</td>
      <td class="num nowrap">${fmtBRL(l.retido)}<div class="muted small">${l.notas} nota(s)</div></td><td class="num nowrap">${fmtBRL(l.guias)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">Nenhuma nota com INSS retido nem guia lançada.</td></tr>'}
  </tbody></table></div>
  <div class="card table-wrap"><table class="data"><thead><tr><th>Obra</th><th>CNO</th></tr></thead><tbody>
    ${obras.map((o) => `<tr><td>${esc(o.nome)}</td><td>${o.cno ? esc(o.cno) : `<span class="badge warn">sem CNO</span> <a class="small" href="#/obra/${o.id}/config">informar no Cadastro da obra</a>`}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="muted small">Controle básico dos recolhimentos previdenciários por obra: o INSS retido pelos tomadores nas notas de serviço e as guias (DCTFWeb/GPS) lançadas como conta a pagar na conta <b>3.7 Encargos da mão de obra própria</b>, com o centro de custo da obra. O CNO é informado no Cadastro de cada obra. A apuração é do contador.</div>`;
}

/* ----- Contratos com clientes ----- */
const contratoDaObra = (pid) => F.contratos.find((k) => k.project_id === pid);
const verbasDe = (k) => F.verbas.filter((v) => v.contract_id === k.id);
const centroDaObra = (pid) => F.centros.find((c) => c.project_id === pid);
const mesAtual = () => todayISO().slice(0, 7);
const rotMes = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const orcamentoDa = (o) => { try { return contexto(o).calc.totalOrcamento || 0; } catch { return 0; } };
const contaPorCodigo = (code) => F.contas.find((c) => c.code === code);
function descTaxa(k) {
  if (!k) return '—';
  const v = String(Number(k.fee_value)).replace('.', ',');
  return { nenhuma: 'sem taxa', percentual_custos: `${v}% sobre os custos do mês`, fixo_mensal: `${fmtBRL(k.fee_value)} por mês`,
    percentual_orcamento: `${v}% do orçamento em ${k.fee_installments} parcela(s)` }[k.fee_kind];
}
function prestacaoDa(pid, mes) {
  const o = store.obra(pid), k = contratoDaObra(pid), cc = centroDaObra(pid);
  if (!o || !k || !cc) return null;
  return prestacaoDeContas({ obra: o, contrato: k, verbas: verbasDe(k), mes, entradas: F.entradas, splits: F.splits, baixas: F.baixas, contas: F.contas, centroId: cc.id, orcamento: orcamentoDa(o) });
}

function viewContratos() {
  const grava = gravaFinEmpresa();
  const obras = store.obras();
  if (!obras.length) return '<div class="card empty"><p>Nenhuma obra visível para o seu usuário.</p></div>';
  const linhas = obras.map((o) => {
    const k = contratoDaObra(o.id);
    const p = k && prestacaoDa(o.id, mesAtual());
    return `<tr class="${k ? 'tabela-clicavel' : ''}"><td><b>${esc(o.nome)}</b>${k?.client_name ? `<div class="muted small">${esc(k.client_name)}</div>` : ''}</td>
      <td>${k ? `<span class="badge ${k.regime === 'administracao' ? 'info' : ''}">${esc(REGIMES_CONTRATO[k.regime])}</span>` : '<span class="muted small">sem contrato</span>'}</td>
      <td class="small">${k ? esc(descTaxa(k)) : '—'}</td>
      <td class="num nowrap">${p ? (k.regime === 'administracao' ? `${fmtBRL(p.saldoRecursos)}<div class="muted small">${p.saldoRecursos >= 0 ? 'a favor do cliente' : 'a reembolsar pelo cliente'}</div>` : `${fmtBRL(Math.max(0, Number(k.contract_value || 0) - p.recebido.receitasAcum))}<div class="muted small">a receber do contrato</div>`) : '—'}</td>
      <td class="num nowrap">${p && k.fee_kind !== 'nenhuma' ? fmtBRL(p.taxa.aReceber) : '—'}</td>
      <td class="nowrap">${k ? `<a class="btn sm primary" href="#/fin/contratos/${o.id}">Abrir</a>` : grava ? `<button class="btn sm" data-act="finContrato" data-p="${o.id}">${I.plus} Contrato</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="card table-wrap"><table class="data"><thead><tr><th>Obra / cliente</th><th>Regime</th><th>Taxa de administração</th><th class="num">Recursos do cliente / contrato</th><th class="num">Taxa a receber</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="muted small"><b>Administração:</b> o cliente paga os custos da obra (aportes, ou direto ao fornecedor) e a construtora recebe a taxa; esse dinheiro fica fora da DRE. <b>Verba com teto:</b> o que passar do teto é do cliente; o que sobrar volta para ele. <b>Empreitada:</b> preço fechado; o valor do contrato é receita da construtora.</div>`;
}

function viewContrato(pid) {
  const o = store.obra(pid), k = contratoDaObra(pid), cc = centroDaObra(pid);
  const voltar = '<a class="muted small" href="#/fin/contratos">← Contratos com clientes</a>';
  if (!o) return `${voltar}<div class="card empty"><p>Obra não encontrada (ou você não está na equipe dela).</p></div>`;
  if (!k) return `${voltar}<div class="card empty"><p>${esc(o.nome)} ainda não tem contrato com o cliente.</p>${gravaFinEmpresa() ? `<button class="btn primary" data-act="finContrato" data-p="${pid}">${I.plus} Cadastrar contrato</button>` : ''}</div>`;
  const grava = gravaFinEmpresa();
  const mes = mesAtual();
  const p = prestacaoDa(pid, mes);
  const adm = k.regime === 'administracao';
  const kpi = (t, v, s = '', cor = '') => `<div class="card kpi"><div class="k-label">${t}</div><div class="k-value" style="font-size:19px${cor ? `;color:${cor}` : ''}">${v}</div><div class="k-sub">${s}</div></div>`;
  const etapas = (o.eap || []).filter((a) => !a.parentId);
  const nomeEtapa = (id) => { const a = etapas.find((x) => x.id === id); return a ? `${a.codigo} ${a.descricao}` : '?'; };
  const lancada = (m) => F.entradas.find((e) => e.kind === 'receber' && e.status !== 'cancelado' && e.document === `TAXA ${rotMes(m)}` && F.splits.some((s) => s.entry_id === e.id && s.cost_center_id === cc?.id));
  const meses = p.taxa.meses.slice(-12).reverse();
  return `<div class="page-head"><div>${voltar}<h1>${esc(o.nome)}</h1>
      <div class="muted">${esc(k.client_name || 'Cliente não informado')} · <b>${esc(REGIMES_CONTRATO[k.regime])}</b> · taxa: ${esc(descTaxa(k))} · desde ${rotMes(String(k.start_month).slice(0, 7))}${!adm && k.contract_value ? ` · contrato ${fmtBRL(k.contract_value)}` : ''}</div></div>
    <div class="row">${grava ? `<button class="btn" data-act="finContrato" data-p="${pid}">Editar contrato</button><button class="btn" data-act="finParcelas" data-p="${pid}">Gerar parcelas a receber</button>` : ''}
      <button class="btn primary" data-act="finPrestacao" data-p="${pid}">Prestação de contas</button></div></div>
  <div class="stack">
    <div class="kpis">
      ${adm ? kpi('Aportes do cliente (acumulado)', fmtBRL(p.recebido.aportesAcum), 'contas a receber de "aportes" já recebidas')
        + kpi('Custos pagos pela construtora', fmtBRL(p.custos.acumulado), 'despesas lançadas na obra até hoje')
        + kpi(p.saldoRecursos >= 0 ? 'Saldo a favor do cliente' : 'A reembolsar pelo cliente', fmtBRL(Math.abs(p.saldoRecursos)), 'aportes − custos pagos', p.saldoRecursos < 0 ? 'var(--crit)' : '')
        : kpi('Valor do contrato', fmtBRL(k.contract_value || 0), '') + kpi('Recebido', fmtBRL(p.recebido.receitasAcum), '') + kpi('A receber', fmtBRL(Math.max(0, Number(k.contract_value || 0) - p.recebido.receitasAcum)), '')}
      ${p.clienteDireto.acumulado ? kpi('Pago direto pelo cliente', fmtBRL(p.clienteDireto.acumulado), 'na loja, cartão, cheque…') : ''}
      ${k.fee_kind !== 'nenhuma' ? kpi('Taxa de administração', fmtBRL(p.taxa.acumulado), `recebida ${fmtBRL(p.taxa.recebida)} · a receber ${fmtBRL(p.taxa.aReceber)}`) : ''}
    </div>
    <div class="row"><h2 style="flex:1;margin:0">Verbas com teto</h2>${grava ? `<button class="btn sm" data-act="finVerba" data-k="${k.id}">${I.plus} Verba</button>` : ''}</div>
    ${p.verbas.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Verba</th><th>Etapas da obra</th><th class="num">Teto</th><th class="num">Gasto</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
      ${p.verbas.map((v) => `<tr><td><b>${esc(v.name)}</b>${v.doCliente ? `<div class="muted small">${fmtBRL(v.doCliente)} pagos direto pelo cliente</div>` : ''}</td><td class="small">${(v.phase_ids || []).map(nomeEtapa).map(esc).join('<br>') || '—'}</td>
        <td class="num nowrap">${fmtBRL(v.teto)}</td><td class="num nowrap">${fmtBRL(v.gasto)}${v.usoPct != null ? `<div class="muted small">${String(v.usoPct).replace('.', ',')}% do teto</div>` : ''}</td>
        <td class="num nowrap">${v.excedente ? `<span style="color:var(--crit)">−${fmtBRL(v.excedente)}</span><div class="muted small">passou: por conta do cliente</div>` : `${fmtBRL(v.saldo)}<div class="muted small">sobra volta para o cliente</div>`}</td>
        <td>${grava ? `<button class="btn sm" data-act="finVerba" data-k="${k.id}" data-id="${v.id}">Editar</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="muted small">Nenhuma verba. Ex.: esquadrias até R$ 30.000, ligada à etapa "Esquadrias" da obra.</div>'}
    ${k.fee_kind !== 'nenhuma' ? `<h2 style="margin:6px 0 0">Taxa de administração por mês</h2>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Mês</th><th>Cálculo</th><th class="num">Taxa</th><th>Conta a receber</th></tr></thead><tbody>
      ${meses.map((t) => { const e = lancada(t.mes); return `<tr><td>${rotMes(t.mes)}</td><td class="small">${esc(t.regra)}</td><td class="num nowrap">${fmtBRL(t.valor)}</td>
        <td class="small">${e ? `<span class="badge ${{ quitado: 'good', parcial: 'info' }[e.status] || 'warn'}">${esc(SITUACOES[e.status])}</span> ${fmtBRL(e.amount)}` : grava && t.valor > 0 ? `<button class="btn sm" data-act="finLancarTaxa" data-p="${pid}" data-m="${t.mes}">Lançar a receber</button>` : '—'}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="muted small">"% sobre os custos" usa os custos lançados na obra no mês mais o que o cliente pagou direto. O mês corrente ainda pode mudar até o fim do mês.</div>` : ''}
  </div>`;
}

/* ----- Prestação de contas (para imprimir / salvar em PDF) ----- */
function viewPrestacao(pid, mesRota) {
  const mes = /^\d{4}-\d{2}$/.test(mesRota || '') ? mesRota : mesAtual();
  const o = store.obra(pid), k = contratoDaObra(pid);
  if (!o || !k) return '<div class="card empty"><p>Obra ou contrato não encontrado.</p><a class="btn" href="#/fin/contratos">Voltar</a></div>';
  const p = prestacaoDa(pid, mes);
  const etapas = (o.eap || []).filter((a) => !a.parentId);
  const nomeEtapa = (id) => { const a = etapas.find((x) => x.id === id); return a ? `${a.codigo} ${a.descricao}` : 'Sem etapa'; };
  const adm = k.regime === 'administracao';
  const linha = (t, v, forte = false) => `<tr><th>${t}</th><td class="num">${forte ? `<b>${v}</b>` : v}</td></tr>`;
  return `<div class="row no-print" style="gap:8px;margin-bottom:10px;flex-wrap:wrap"><a class="btn" href="#/fin/contratos/${pid}">← Contrato</a>
      <label class="field" style="max-width:170px">Mês<input type="month" value="${mes}" data-chg="finMesPrestacao" data-p="${pid}"></label>
      <button class="btn primary" data-act="finImprimir">Imprimir / salvar em PDF</button></div>
  <div class="card rdo-folha">
    <table class="rdo-cab"><tr><td class="rdo-cab-titulo" colspan="4">PRESTAÇÃO DE CONTAS — ${rotMes(mes)}</td></tr>
      <tr><th>Construtora</th><td>${esc(ctx().orgNome || '')}</td><th>Obra</th><td>${esc(o.nome)}</td></tr>
      <tr><th>Cliente</th><td>${esc(k.client_name || '')}</td><th>Contrato</th><td>${esc(REGIMES_CONTRATO[k.regime])}${k.fee_kind !== 'nenhuma' ? ` · taxa ${esc(descTaxa(k))}` : ''}</td></tr></table>
    <div class="rdo-secao"><h3>Resumo</h3><table class="rdo-tab"><tbody>
      ${adm ? `${linha('Aportes recebidos no mês', fmtBRL(p.recebido.aportesMes))}${linha('Custos da obra no mês (pagos pela construtora)', fmtBRL(p.custos.mes))}
        ${linha('Pago direto pelo cliente no mês', fmtBRL(p.clienteDireto.mes))}${linha('Aportes recebidos até o mês', fmtBRL(p.recebido.aportesAcum))}
        ${linha('Custos pagos pela construtora até o mês', fmtBRL(p.custos.acumulado))}
        ${linha(p.saldoRecursos >= 0 ? 'Saldo a favor do cliente' : 'Valor a reembolsar pelo cliente', fmtBRL(Math.abs(p.saldoRecursos)), true)}`
        : `${linha('Valor do contrato', fmtBRL(k.contract_value || 0))}${linha('Recebido no mês', fmtBRL(p.recebido.receitasMes))}${linha('Recebido até o mês', fmtBRL(p.recebido.receitasAcum))}
        ${linha('Saldo do contrato', fmtBRL(Math.max(0, Number(k.contract_value || 0) - p.recebido.receitasAcum)), true)}`}
      ${k.fee_kind !== 'nenhuma' ? `${linha(`Taxa de administração do mês (${esc(p.taxa.regra)})`, fmtBRL(p.taxa.mes))}${linha('Taxa a receber até o mês', fmtBRL(p.taxa.aReceber), true)}` : ''}
    </tbody></table></div>
    ${adm ? `<div class="rdo-secao"><h3>Custos da obra no mês, por etapa</h3>
      ${p.custos.porEtapa.length ? `<table class="rdo-tab"><thead><tr><th>Data</th><th>Documento</th><th>Fornecedor / descrição</th><th class="num">Valor</th></tr></thead><tbody>
        ${p.custos.porEtapa.map((g) => `<tr><th colspan="3">${esc(nomeEtapa(g.faseId))}</th><th class="num">${fmtBRL(g.total)}</th></tr>
          ${g.despesas.map((d) => `<tr><td>${isoBR(d.data)}</td><td>${esc(d.documento || '')}</td><td>${esc(d.fornecedor || '')}${d.descricao ? ` — ${esc(d.descricao)}` : ''}</td><td class="num">${fmtBRL(d.valor)}</td></tr>`).join('')}`).join('')}
        <tr><th colspan="3">Total do mês</th><th class="num">${fmtBRL(p.custos.mes)}</th></tr></tbody></table>` : '<div>Nenhum custo lançado no mês.</div>'}</div>` : ''}
    ${p.clienteDireto.lista.length ? `<div class="rdo-secao"><h3>Pagos direto pelo cliente no mês</h3><table class="rdo-tab"><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th></tr></thead><tbody>
      ${p.clienteDireto.lista.map((c) => `<tr><td>${isoBR(c.data)}</td><td>${esc(c.entry?.description || '')}${c.entry?.party_name ? ` — ${esc(c.entry.party_name)}` : ''}</td><td class="num">${fmtBRL(c.valor)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${p.verbas.length ? `<div class="rdo-secao"><h3>Verbas com teto (acumulado até o mês)</h3><table class="rdo-tab"><thead><tr><th>Verba</th><th class="num">Teto</th><th class="num">Gasto</th><th class="num">Saldo</th><th>Situação</th></tr></thead><tbody>
      ${p.verbas.map((v) => `<tr><td>${esc(v.name)}</td><td class="num">${fmtBRL(v.teto)}</td><td class="num">${fmtBRL(v.gasto)}</td><td class="num">${fmtBRL(v.saldo)}</td>
        <td>${v.excedente ? `Passou ${fmtBRL(v.excedente)} do teto — por conta do cliente` : 'Dentro do teto — a sobra volta para o cliente'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${p.recebido.lista.length ? `<div class="rdo-secao"><h3>Recebimentos do cliente no mês</h3><table class="rdo-tab"><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th></tr></thead><tbody>
      ${p.recebido.lista.map((r) => `<tr><td>${isoBR(r.data)}</td><td>${esc(r.descricao)}${r.aporte ? ' (aporte)' : ''}</td><td class="num">${fmtBRL(r.valor)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="muted small" style="margin-top:12px">Emitido em ${new Date().toLocaleDateString('pt-BR')} pelo GEPLAN. Valores conforme os lançamentos registrados até a data de emissão.</div>
  </div>`;
}

/* ---------- formulários ---------- */
const opcoesContas =(tipo, sel) => contasLancaveis(F.contas, tipo).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('');
const opcoesCentros = (sel) => `<option value="">— centro —</option>${F.centros.filter((c) => c.active || c.id === sel).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(nomeCentro(c))}</option>`).join('')}`;
const linhaRateio = (r = {}) => `<div class="row lin-rateio" style="gap:6px"><select class="r-cc" style="flex:1">${opcoesCentros(r.cost_center_id)}</select>
  <input class="r-pct" inputmode="decimal" style="width:90px" value="${r.pct != null ? fmtIn(r.pct, 4) : ''}" placeholder="%"><span class="r-val small muted" style="width:110px;text-align:right"></span>
  <button type="button" class="icon-btn danger r-rm" title="Tirar do rateio">${I.trash}</button></div>`;

function formularioLancamento(kind, e = null) {
  setTimeout(() => carregarFornecedores().catch(() => {}));
  const rateio = e ? F.splits.filter((s) => s.entry_id === e.id) : [{ cost_center_id: F.centros.find((c) => c.kind === 'matriz')?.id, pct: 100 }];
  const hoje = todayISO();
  const corpo = `<div class="grid-form">
      <label class="field">Descrição *<input name="descricao" maxlength="200" value="${esc(e?.description || '')}" placeholder="${kind === 'pagar' ? 'ex.: Aluguel do escritório' : 'ex.: Taxa de administração — novembro'}"></label>
      <label class="field">${kind === 'pagar' ? 'Fornecedor / favorecido' : 'Cliente / pagador'}<input name="parte" list="lista-fornecedores" maxlength="160" value="${esc(e?.party_name || '')}"></label>
      <label class="field">Conta (plano de contas) *<select name="conta"><option value="">— escolha —</option>${opcoesContas(kind, e?.account_id)}</select></label>
      <label class="field">Documento<input name="documento" maxlength="60" value="${esc(e?.document || '')}" placeholder="NF, boleto, recibo…"></label>
      <label class="field">Competência (mês) *<input type="month" name="competencia" value="${esc((e?.competence || hoje).slice(0, 7))}"></label>
      <label class="field">Vencimento *<input type="date" name="vencimento" value="${esc(e?.due_date || hoje)}"></label>
      <label class="field">Valor (R$) *<input name="valor" inputmode="decimal" value="${e ? fmtIn(e.amount, 2) : ''}"></label>
      ${kind === 'pagar' && F.verbas.length ? `<label class="field">Verba com teto (opcional)<select name="verba"><option value="">— nenhuma —</option>${F.verbas.filter((v) => v.active || v.id === e?.allowance_id).map((v) => {
        const k = F.contratos.find((x) => x.id === v.contract_id);
        return `<option value="${v.id}" ${v.id === e?.allowance_id ? 'selected' : ''}>${esc(store.obra(k?.project_id)?.nome || 'Obra')} · ${esc(v.name)}</option>`;
      }).join('')}</select></label>` : ''}
    </div>
    <fieldset><legend>Centro de custo / rateio</legend>
      <div data-rateio class="stack" style="gap:6px">${rateio.map(linhaRateio).join('')}</div>
      <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn sm" data-r-mais>${I.plus} Dividir com outro centro</button><button type="button" class="btn sm" data-r-igual>Dividir igualmente</button><span class="small" data-r-soma></span></div>
    </fieldset>
    <label class="field">Observações<textarea name="obs" rows="2" maxlength="1000">${esc(e?.notes || '')}</textarea></label>
    ${datalistFornecedores()}
    <div class="muted small">Competência = mês a que a despesa ou receita pertence (DRE). Vencimento = quando se paga ou recebe (fluxo de caixa).</div>`;
  const j = janela(`${e ? 'Editar' : 'Nova'} conta a ${kind === 'pagar' ? 'pagar' : 'receber'}`, corpo);
  const atualizar = () => {
    const linhas = [...j.form.querySelectorAll('.lin-rateio')];
    const pcts = linhas.map((l) => parseNum(l.querySelector('.r-pct').value) || 0);
    const vals = ratearValor(parseNum(j.form.valor.value) || 0, pcts);
    linhas.forEach((l, i) => { l.querySelector('.r-val').textContent = vals[i] ? fmtBRL(vals[i]) : ''; });
    const soma = Math.round(pcts.reduce((a, b) => a + b, 0) * 10000) / 10000;
    const el = j.form.querySelector('[data-r-soma]');
    el.textContent = `soma ${fmtIn(soma, 2)}%`; el.style.color = Math.abs(soma - 100) > 0.0001 ? 'var(--crit)' : '';
  };
  j.form.addEventListener('input', atualizar);
  j.form.addEventListener('change', atualizar);
  j.form.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-r-mais]')) j.form.querySelector('[data-rateio]').insertAdjacentHTML('beforeend', linhaRateio());
    if (ev.target.closest('[data-r-igual]')) {
      const ls = [...j.form.querySelectorAll('.lin-rateio')];
      dividirIgual(ls.length).forEach((p, i) => { ls[i].querySelector('.r-pct').value = fmtIn(p, 4); });
    }
    const rm = ev.target.closest('.r-rm');
    if (rm && j.form.querySelectorAll('.lin-rateio').length > 1) rm.closest('.lin-rateio').remove();
    atualizar();
  });
  atualizar();
  return abrir(j, async (v) => {
    const descricao = (v.descricao || '').trim();
    if (descricao.length < 2) throw new Error('Informe a descrição.');
    if (!v.conta) throw new Error('Escolha a conta do plano de contas.');
    if (!/^\d{4}-\d{2}$/.test(v.competencia || '')) throw new Error('Informe o mês de competência.');
    if (!v.vencimento) throw new Error('Informe o vencimento.');
    const valor = parseNum(v.valor);
    if (!(valor > 0)) throw new Error('Informe o valor.');
    const r = validarRateio([...j.form.querySelectorAll('.lin-rateio')].map((l) => ({ cost_center_id: l.querySelector('.r-cc').value, pct: parseNum(l.querySelector('.r-pct').value) })));
    if (r.erro) throw new Error(r.erro);
    await carregarFornecedores().catch(() => {});
    const parte = (v.parte || '').trim();
    ok(await (await sb()).rpc('fin_salvar_lancamento', { p_org: ctx().orgId, p_kind: kind, p_description: descricao, p_account: v.conta,
      p_competence: `${v.competencia}-01`, p_due: v.vencimento, p_amount: valor, p_rateio: r.linhas, p_party: parte,
      p_supplier: kind === 'pagar' ? idDoFornecedorPorNome(parte) : null, p_document: (v.documento || '').trim(), p_notes: (v.obs || '').trim(), p_id: e?.id || null, p_allowance: kind === 'pagar' ? (v.verba || null) : null }), 'lançamento');
    await carregarFinEmpresa(true);
    toast(e ? 'Lançamento atualizado.' : 'Lançamento registrado.');
    return true;
  });
}

function formularioBaixa(e) {
  const s = saldoLancamento(e, F.baixas);
  const pagar = e.kind === 'pagar';
  const bancos = F.bancos.filter((b) => b.active);
  const corpo = `<p class="muted small" style="margin:0"><b>${esc(e.description)}</b>${e.party_name ? ` · ${esc(e.party_name)}` : ''} · valor ${fmtBRL(e.amount)} · ${s.pago ? `já ${pagar ? 'pago' : 'recebido'} ${fmtBRL(s.pago)} · ` : ''}saldo <b>${fmtBRL(s.saldo)}</b></p>
    <div class="grid-form">
      <label class="field">Data *<input type="date" name="data" value="${todayISO()}" max="${todayISO()}"></label>
      <label class="field">Valor (R$) *<input name="valor" inputmode="decimal" value="${fmtIn(s.saldo, 2)}"></label>
      <label class="field">Forma<select name="forma">${Object.entries(FORMAS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      ${pagar ? `<label class="field">Quem pagou<select name="quem"><option value="empresa">A empresa</option><option value="cliente">O cliente, direto (obra por administração)</option></select></label>` : ''}
      <label class="field" data-banco>Conta bancária *<select name="banco">${bancos.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
    </div>
    <label class="field">Observações<input name="obs" maxlength="500"></label>
    <div class="muted small">Pagamento parcial: informe só o valor pago agora; o restante continua em aberto.</div>`;
  const j = janela(`${pagar ? 'Pagar' : 'Receber'}`, corpo, pagar ? 'Registrar pagamento' : 'Registrar recebimento');
  if (pagar) j.form.quem.onchange = () => { j.form.querySelector('[data-banco]').hidden = j.form.quem.value === 'cliente'; };
  return abrir(j, async (v) => {
    if (!v.data || v.data > todayISO()) throw new Error('Informe a data (não pode ser futura).');
    const valor = parseNum(v.valor);
    if (!(valor > 0)) throw new Error('Informe o valor.');
    if (valor > s.saldo + 0.005) throw new Error(`O valor passa do saldo (${fmtBRL(s.saldo)}).`);
    const cliente = pagar && v.quem === 'cliente';
    if (!cliente && !v.banco) throw new Error('Escolha a conta bancária (ou cadastre uma em Cadastros financeiros).');
    ok(await (await sb()).from('fin_settlements').insert({ entry_id: e.id, org_id: ctx().orgId, pay_date: v.data, amount: valor, method: v.forma,
      paid_by: cliente ? 'cliente' : 'empresa', bank_account_id: cliente ? null : v.banco, notes: (v.obs || '').trim() }), 'baixa');
    await carregarFinEmpresa(true);
    toast(pagar ? 'Pagamento registrado.' : 'Recebimento registrado.');
    return true;
  });
}

function detalhe(e) {
  const s = saldoLancamento(e, F.baixas);
  const grava = gravaFinEmpresa();
  const conta = contaPorId(e.account_id);
  const rateio = F.splits.filter((x) => x.entry_id === e.id);
  const vals = ratearValor(e.amount, rateio.map((r) => r.pct));
  const todas = F.baixas.filter((b) => b.entry_id === e.id);
  info(e.description, `<div class="stack small">
    <div>${e.kind === 'pagar' ? 'Conta a pagar' : 'Conta a receber'} · ${esc(SITUACOES[s.situacao])}${e.cancel_reason ? ` — ${esc(e.cancel_reason)}` : ''}</div>
    <div>Conta: <b>${esc(conta ? `${conta.code} ${conta.name}` : '')}</b>${conta?.accounting_code ? ` · contábil ${esc(conta.accounting_code)}` : ''}</div>
    <div>Competência ${esc(e.competence.slice(5, 7))}/${esc(e.competence.slice(0, 4))} · vencimento ${isoBR(e.due_date)} · valor ${fmtBRL(e.amount)}${e.document ? ` · ${esc(e.document)}` : ''}</div>
    <div><b>Rateio</b><ul class="lista">${rateio.map((r, i) => `<li>${esc(nomeCentro(centroPorId(r.cost_center_id)))} — ${fmtIn(r.pct, 2)}% = ${fmtBRL(vals[i])}</li>`).join('')}</ul></div>
    <div><b>Baixas</b>${todas.length ? `<ul class="lista">${todas.map((b) => `<li${b.deleted_at ? ' style="opacity:.6"' : ''}>${isoBR(b.pay_date)} · ${fmtBRL(b.amount)} · ${esc(FORMAS[b.method] || b.method)} · ${b.paid_by === 'cliente' ? 'cliente pagou direto' : esc(bancoPorId(b.bank_account_id)?.name || '')} · por ${esc(b.created_label || '—')}
      ${b.deleted_at ? `<div class="muted">estornada: ${esc(b.undo_reason)}</div>` : grava ? ` <button class="btn sm danger" data-act="finEstornar" data-id="${b.id}">Estornar</button>` : ''}</li>`).join('')}</ul>` : ' nenhuma.'}</div>
    ${e.notes ? `<div>Obs.: ${esc(e.notes)}</div>` : ''}
    <div class="muted">Lançado por ${esc(e.created_label || '—')} em ${new Date(e.created_at).toLocaleString('pt-BR')}.</div>
    ${grava && e.status !== 'cancelado' ? `<div class="row" style="gap:6px">${e.status !== 'quitado' ? `<button class="btn sm" data-act="finEditar" data-id="${e.id}">Editar</button>` : ''}${!s.baixas.length ? `<button class="btn sm danger" data-act="finCancelar" data-id="${e.id}">Cancelar lançamento</button>` : ''}</div>` : ''}
  </div>`);
}

async function formularioConta(c, pai = null) {
  const novo = !c;
  const base = pai || contaPorId(c?.parent_id);
  const v = await formDialog({ title: novo ? `Nova subconta de ${pai.code} ${pai.name}` : `Conta ${c.code}`, ok: 'Salvar',
    text: c?.is_system ? 'Conta padrão: o código e o tipo não mudam; renomeie e informe o De/Para contábil.' : '',
    fields: [
      ...(novo ? [{ name: 'code', label: 'Código', value: proximoCodigo(F.contas, pai), required: true }] : []),
      { name: 'name', label: 'Nome', value: c?.name || '', required: true },
      { name: 'acc', label: 'De/Para: conta contábil ou código reduzido', value: c?.accounting_code || '' },
      { name: 'accn', label: 'Nome da conta no plano do contador', value: c?.accounting_name || '' },
      ...(novo ? [] : [{ name: 'ativa', label: 'Conta ativa', type: 'checkbox', value: c.active }]),
    ] });
  if (!v) return;
  const dados = { name: v.name.trim(), accounting_code: v.acc.trim(), accounting_name: v.accn.trim() };
  const cl = await sb();
  if (novo) ok(await cl.from('fin_accounts').insert({ ...dados, org_id: ctx().orgId, parent_id: pai.id, code: v.code.trim(), kind: base.kind }), 'conta');
  else ok(await cl.from('fin_accounts').update({ ...dados, active: v.ativa }).eq('id', c.id), 'conta');
  await carregarFinEmpresa(true);
  toast('Plano de contas atualizado.');
}

async function formularioCentro(c) {
  const v = await formDialog({ title: c ? `Centro de custo ${c.name}` : 'Novo centro de custo', ok: 'Salvar',
    text: c?.kind === 'obra' ? 'O nome acompanha o nome da obra.' : '',
    fields: [
      ...(c?.kind === 'obra' ? [] : [{ name: 'name', label: 'Nome', value: c?.name || '', required: true }]),
      { name: 'code', label: 'Código (opcional)', value: c?.code || '' },
      ...(c?.kind === 'obra' ? [{ name: 'adm', label: 'Obra por administração (custos pagos com recursos do cliente, fora da DRE)', type: 'checkbox', value: c.client_funds }] : []),
      ...(c ? [{ name: 'ativo', label: 'Centro ativo', type: 'checkbox', value: c.active }] : []),
    ] });
  if (!v) return;
  const cl = await sb();
  const dados = { code: (v.code || '').trim(), ...(c?.kind === 'obra' ? { client_funds: !!v.adm } : { name: v.name.trim() }), ...(c ? { active: !!v.ativo } : {}) };
  if (c) ok(await cl.from('fin_cost_centers').update(dados).eq('id', c.id), 'centro de custo');
  else ok(await cl.from('fin_cost_centers').insert({ ...dados, org_id: ctx().orgId, kind: 'outro' }), 'centro de custo');
  await carregarFinEmpresa(true);
  toast('Centro de custo salvo.');
}

async function formularioBanco(b) {
  const v = await formDialog({ title: b ? `Conta ${b.name}` : 'Nova conta bancária', ok: 'Salvar', fields: [
    { name: 'name', label: 'Nome (como aparece na tela)', value: b?.name || '', required: true },
    { name: 'kind', label: 'Tipo', type: 'select', value: b?.kind || 'corrente', options: Object.entries(TIPOS_BANCO).map(([value, label]) => ({ value, label })) },
    { name: 'bank', label: 'Banco', value: b?.bank || '' }, { name: 'agency', label: 'Agência', value: b?.agency || '' },
    { name: 'number', label: 'Conta', value: b?.account_number || '' },
    { name: 'cc', label: 'Uso', type: 'select', value: b?.cost_center_id || '', options: [{ value: '', label: 'Empresa (geral)' }, ...F.centros.filter((c) => c.kind === 'obra').map((c) => ({ value: c.id, label: `Só da obra ${c.name}` }))] },
    { name: 'acc', label: 'Conta contábil (De/Para)', value: b?.accounting_code || '' },
    { name: 'saldo', label: 'Saldo inicial (R$)', value: b ? fmtIn(b.opening_balance, 2) : '0,00' },
    { name: 'data', label: 'Data do saldo inicial', type: 'date', value: b?.opening_date || todayISO() },
    ...(b ? [{ name: 'ativa', label: 'Conta ativa', type: 'checkbox', value: b.active }] : []),
  ] });
  if (!v) return;
  const saldo = parseNum(v.saldo);
  if (saldo == null || !isFinite(saldo)) return toast('Saldo inicial inválido.');
  const dados = { name: v.name.trim(), kind: v.kind, bank: v.bank.trim(), agency: v.agency.trim(), account_number: v.number.trim(), cost_center_id: v.cc || null,
    accounting_code: v.acc.trim(), opening_balance: saldo, opening_date: v.data || todayISO(), ...(b ? { active: !!v.ativa } : {}) };
  const cl = await sb();
  if (b) ok(await cl.from('fin_bank_accounts').update(dados).eq('id', b.id), 'conta bancária');
  else ok(await cl.from('fin_bank_accounts').insert({ ...dados, org_id: ctx().orgId }), 'conta bancária');
  await carregarFinEmpresa(true);
  toast('Conta bancária salva.');
}

/* ----- contrato do cliente ----- */
async function formularioContrato(pid) {
  const o = store.obra(pid), k = contratoDaObra(pid);
  const v = await formDialog({ title: `${k ? 'Contrato' : 'Novo contrato'} — ${o?.nome || ''}`, ok: 'Salvar',
    text: 'Administração: o cliente paga os custos e a construtora recebe a taxa (fora da DRE). Empreitada: preço fechado.',
    fields: [
      { name: 'cliente', label: 'Cliente', value: k?.client_name || o?.cliente?.nome || '' },
      { name: 'regime', label: 'Regime', type: 'select', value: k?.regime || 'administracao', options: Object.entries(REGIMES_CONTRATO).map(([value, label]) => ({ value, label })) },
      { name: 'valor', label: 'Valor do contrato (empreitada) (R$)', value: k?.contract_value != null ? fmtIn(k.contract_value, 2) : '' },
      { name: 'taxa', label: 'Taxa de administração', type: 'select', value: k?.fee_kind || 'percentual_custos', options: Object.entries(TAXAS).map(([value, label]) => ({ value, label })) },
      { name: 'taxaValor', label: 'Taxa: percentual (%) ou valor mensal (R$)', value: k ? fmtIn(k.fee_value, 2) : '' },
      { name: 'parcelas', label: 'Parcelas (só para "% do orçamento")', value: k?.fee_installments ?? '' },
      { name: 'inicio', label: 'Mês de início', type: 'month', value: String(k?.start_month || todayISO()).slice(0, 7) },
      { name: 'obs', label: 'Observações', type: 'textarea', value: k?.notes || '' },
    ] });
  if (!v) return;
  const valor = (v.valor || '').trim() ? parseNum(v.valor) : null;
  const taxa = (v.taxaValor || '').trim() ? parseNum(v.taxaValor) : 0;
  const parcelas = String(v.parcelas || '').trim() ? Number(v.parcelas) : null;
  if (valor != null && !(valor >= 0)) return toast('Valor do contrato inválido.');
  if (!(taxa >= 0)) return toast('Taxa inválida.');
  if (v.taxa === 'percentual_orcamento' && !(Number.isInteger(parcelas) && parcelas >= 1)) return toast('Informe o número de parcelas da taxa.');
  if (!/^\d{4}-\d{2}$/.test(v.inicio || '')) return toast('Informe o mês de início.');
  const dados = { client_name: v.cliente.trim(), regime: v.regime, contract_value: valor, fee_kind: v.taxa, fee_value: v.taxa === 'nenhuma' ? 0 : taxa,
    fee_installments: v.taxa === 'percentual_orcamento' ? parcelas : null, start_month: `${v.inicio}-01`, notes: (v.obs || '').trim() };
  const c = await sb();
  if (k) ok(await c.from('client_contracts').update(dados).eq('id', k.id), 'contrato');
  else ok(await c.from('client_contracts').insert({ ...dados, org_id: ctx().orgId, project_id: pid }), 'contrato');
  await carregarFinEmpresa(true);
  toast('Contrato salvo.');
  ir(`#/fin/contratos/${pid}`);
}

async function formularioVerba(k, vb = null) {
  const o = store.obra(k.project_id);
  const etapas = (o?.eap || []).filter((a) => !a.parentId);
  const marcadas = new Set(vb?.phase_ids || []);
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>${vb ? `Verba — ${esc(vb.name)}` : 'Nova verba com teto'}</h2><div class="stack" style="margin-top:12px">
    <div class="grid-form"><label class="field">Nome *<input name="nome" maxlength="120" value="${esc(vb?.name || '')}" placeholder="ex.: Esquadrias"></label>
      <label class="field">Teto (R$) *<input name="teto" inputmode="decimal" value="${vb ? fmtIn(vb.cap, 2) : ''}"></label></div>
    <fieldset><legend>Etapas da obra que contam nesta verba</legend><div class="grid-form">${etapas.map((a) => `<label class="check"><input type="checkbox" name="fase" value="${a.id}" ${marcadas.has(a.id) ? 'checked' : ''}> ${esc(a.codigo)} ${esc(a.descricao)}</label>`).join('') || '<span class="muted small">A obra ainda não tem EAP.</span>'}</div></fieldset>
    <div class="muted small">Também contam os pagamentos que o cliente fez direto e que forem ligados a esta verba no lançamento.</div>
    ${vb ? `<label class="check"><input type="checkbox" name="ativa" ${vb.active ? 'checked' : ''}> Verba ativa</label>` : ''}
    </div><div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Salvar</button></div></form>`;
  const j = { dlg, form: dlg.querySelector('form'), erro: (m) => { const e = dlg.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; } };
  return abrir(j, async (v) => {
    const nome = (v.nome || '').trim();
    if (nome.length < 2) throw new Error('Informe o nome da verba.');
    const teto = parseNum(v.teto);
    if (!(teto >= 0)) throw new Error('Informe o teto.');
    const dados = { name: nome, cap: teto, phase_ids: [...j.form.querySelectorAll('[name=fase]:checked')].map((x) => x.value), ...(vb ? { active: !!j.form.ativa?.checked } : {}) };
    const c = await sb();
    if (vb) ok(await c.from('contract_allowances').update(dados).eq('id', vb.id), 'verba');
    else ok(await c.from('contract_allowances').insert({ ...dados, contract_id: k.id, org_id: ctx().orgId, position: verbasDe(k).length }), 'verba');
    await carregarFinEmpresa(true);
    toast('Verba salva.');
    return true;
  });
}

async function formularioParcelas(pid) {
  const k = contratoDaObra(pid), cc = centroDaObra(pid);
  const adm = k.regime === 'administracao';
  const v = await formDialog({ title: `Gerar parcelas a receber — ${store.obra(pid)?.nome || ''}`, ok: 'Gerar',
    text: adm ? 'Aportes do cliente para pagar os custos da obra (conta 7.1, fora da DRE). Lance só se o cliente paga em parcelas; se ele paga direto ao fornecedor, não precisa.' : 'Parcelas do contrato de empreitada (conta 1.1, receita da construtora).',
    fields: [
      { name: 'desc', label: 'Descrição', value: adm ? 'Aporte do cliente' : 'Parcela do contrato' },
      { name: 'total', label: 'Valor total (R$)', value: !adm && k.contract_value ? fmtIn(k.contract_value, 2) : '' },
      { name: 'n', label: 'Número de parcelas', value: '1' },
      { name: 'venc', label: 'Primeiro vencimento', type: 'date', value: todayISO() },
    ] });
  if (!v) return;
  const total = parseNum(v.total), n = Number(v.n);
  if (!(total > 0)) return toast('Informe o valor total.');
  if (!(Number.isInteger(n) && n >= 1 && n <= 120)) return toast('Número de parcelas inválido (1 a 120).');
  if (!v.venc) return toast('Informe o primeiro vencimento.');
  const conta = contaPorCodigo(adm ? '7.1' : '1.1');
  const valores = ratearValor(total, Array(n).fill(100 / n));
  const c = await sb();
  for (let i = 0; i < n; i++) {
    const d = new Date(`${v.venc}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i);
    const venc = d.toISOString().slice(0, 10);
    ok(await c.rpc('fin_salvar_lancamento', { p_org: ctx().orgId, p_kind: 'receber', p_description: `${v.desc.trim()}${n > 1 ? ` ${i + 1}/${n}` : ''}`, p_account: conta.id,
      p_competence: `${venc.slice(0, 7)}-01`, p_due: venc, p_amount: valores[i], p_rateio: [{ cost_center_id: cc.id, pct: 100 }], p_party: k.client_name || '',
      p_document: '', p_notes: '', p_id: null }), 'parcela');
  }
  await carregarFinEmpresa(true);
  toast(`${n} parcela(s) a receber lançada(s).`);
}

async function lancarTaxa(pid, mes) {
  const k = contratoDaObra(pid), cc = centroDaObra(pid);
  const t = prestacaoDa(pid, mes).taxa.meses.find((x) => x.mes === mes);
  if (!(t?.valor > 0)) return toast('Sem taxa neste mês.');
  const fim = new Date(`${mes}-01T12:00:00Z`); fim.setUTCMonth(fim.getUTCMonth() + 1); fim.setUTCDate(10);
  ok(await (await sb()).rpc('fin_salvar_lancamento', { p_org: ctx().orgId, p_kind: 'receber', p_description: `Taxa de administração ${rotMes(mes)}`, p_account: contaPorCodigo('1.2').id,
    p_competence: `${mes}-01`, p_due: fim.toISOString().slice(0, 10), p_amount: t.valor, p_rateio: [{ cost_center_id: cc.id, pct: 100 }], p_party: k.client_name || '',
    p_document: `TAXA ${rotMes(mes)}`, p_notes: t.regra, p_id: null }), 'taxa');
  await carregarFinEmpresa(true);
  toast(`Taxa de ${rotMes(mes)} lançada a receber: ${fmtBRL(t.valor)}.`);
}

/* ----- nota de serviço ----- */
function formularioNotaServico() {
  const obras = store.obras();
  const sug = sugestaoRetencoes(F.regime);
  const receitas = contasLancaveis(F.contas, 'receber').filter((c) => c.kind === 'receita');
  const hoje = todayISO();
  const contaPadrao = (pid) => (contratoDaObra(pid)?.regime === 'empreitada' ? contaPorCodigo('1.1') : contaPorCodigo('1.2'))?.id;
  const obraIni = obras[0]?.id || '';
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>Registrar nota de serviço (NFS-e)</h2><div class="stack" style="margin-top:12px">
    <p class="muted small" style="margin:0">Registre a nota já emitida no portal da prefeitura. ${esc(sug.nota)}</p>
    <div class="grid-form">
      <label class="field">Obra *<select name="obra">${obras.map((o) => `<option value="${o.id}">${esc(o.nome)}</option>`).join('')}</select></label>
      <label class="field">Número *<input name="numero" maxlength="30"></label>
      <label class="field">Série<input name="serie" maxlength="10" style="width:90px"></label>
      <label class="field">Emissão *<input type="date" name="data" value="${hoje}" max="${hoje}"></label>
      <label class="field">Competência<input type="month" name="comp" value="${hoje.slice(0, 7)}"></label>
      <label class="field">Vencimento<input type="date" name="venc" value="${hoje}"></label>
      <label class="field">Tomador (cliente)<input name="tomador" maxlength="160" value="${esc(contratoDaObra(obraIni)?.client_name || '')}"></label>
      <label class="field">CPF/CNPJ do tomador<input name="doc" maxlength="20" inputmode="numeric"></label>
      <label class="field">Conta de receita *<select name="conta">${receitas.map((c) => `<option value="${c.id}" ${c.id === contaPadrao(obraIni) ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field">Valor bruto (R$) *<input name="bruto" inputmode="decimal"></label>
    </div>
    <label class="field">Descrição do serviço<input name="desc" maxlength="1000" placeholder="ex.: Medição 3 — alvenaria e reboco"></label>
    <fieldset><legend>Retenções na fonte</legend><div class="grid-form">
      <label class="field">Base do INSS (R$)<input name="inssBase" inputmode="decimal" placeholder="vazio = valor bruto"></label>
      <label class="field">INSS (%)<input name="inssAliq" inputmode="decimal" value="${fmtIn(sug.inssAliq, 2)}" style="width:90px"></label>
      <label class="field">ISS (%)<input name="issAliq" inputmode="decimal" value="0" style="width:90px"></label>
      <label class="check" style="align-self:end"><input type="checkbox" name="issRet"> ISS retido pelo tomador</label>
      <label class="field">IRRF (R$)<input name="irrf" inputmode="decimal" value="0"></label>
      <label class="field">PIS (R$)<input name="pis" inputmode="decimal" value="0"></label>
      <label class="field">COFINS (R$)<input name="cofins" inputmode="decimal" value="0"></label>
      <label class="field">CSLL (R$)<input name="csll" inputmode="decimal" value="0"></label>
    </div>
    <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn sm" data-irrf>IRRF 1,5%</button><button type="button" class="btn sm" data-pcc>PIS/COFINS/CSLL 4,65%</button><button type="button" class="btn sm" data-zerar>Sem IRRF e PCC</button></div></fieldset>
    <div class="card card-pad small" data-resumo></div>
    </div><div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Registrar nota</button></div></form>`;
  const f = dlg.querySelector('form');
  const j = { dlg, form: f, erro: (m) => { const e = f.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; } };
  const val = () => {
    const bruto = parseNum(f.bruto.value) || 0;
    return { bruto, inssBase: f.inssBase.value.trim() ? parseNum(f.inssBase.value) || 0 : bruto, inssAliq: parseNum(f.inssAliq.value) || 0, issAliq: parseNum(f.issAliq.value) || 0,
      issRetido: f.issRet.checked, irrf: parseNum(f.irrf.value) || 0, pis: parseNum(f.pis.value) || 0, cofins: parseNum(f.cofins.value) || 0, csll: parseNum(f.csll.value) || 0 };
  };
  const resumo = () => {
    const v = val(), r = calcularRetencoes(v);
    f.querySelector('[data-resumo]').innerHTML = `Bruto <b>${fmtBRL(v.bruto)}</b> · INSS ${fmtBRL(r.inss)} · ISS ${fmtBRL(r.iss)}${v.issRetido ? ' (retido)' : ' (não retido)'} · IRRF ${fmtBRL(v.irrf)} · PCC ${fmtBRL(v.pis + v.cofins + v.csll)}<br>Retido <b>${fmtBRL(r.total)}</b> · <b>Líquido a receber ${fmtBRL(r.liquido)}</b>${r.erro ? ` <span class="badge crit">${esc(r.erro)}</span>` : ''}`;
  };
  f.obra.onchange = () => { f.tomador.value = contratoDaObra(f.obra.value)?.client_name || f.tomador.value; const cp = contaPadrao(f.obra.value); if (cp) f.conta.value = cp; };
  f.addEventListener('input', resumo); f.addEventListener('change', resumo);
  f.addEventListener('click', (e) => {
    const b = parseNum(f.bruto.value) || 0;
    const r2 = (n) => fmtIn(Math.round(n * 100) / 100, 2);
    if (e.target.closest('[data-irrf]')) f.irrf.value = r2(b * 0.015);
    if (e.target.closest('[data-pcc]')) { f.pis.value = r2(b * sug.pccAliq.pis / 100); f.cofins.value = r2(b * sug.pccAliq.cofins / 100); f.csll.value = r2(b * sug.pccAliq.csll / 100); }
    if (e.target.closest('[data-zerar]')) { f.irrf.value = '0'; f.pis.value = '0'; f.cofins.value = '0'; f.csll.value = '0'; }
    resumo();
  });
  resumo();
  return abrir(j, async (v) => {
    const x = val(), r = calcularRetencoes(x);
    if (!(v.numero || '').trim()) throw new Error('Informe o número da nota.');
    if (!(x.bruto > 0)) throw new Error('Informe o valor bruto.');
    if (!v.data || v.data > todayISO()) throw new Error('Informe a data de emissão (não pode ser futura).');
    if (r.erro) throw new Error(r.erro);
    ok(await (await sb()).rpc('registrar_nfse', { p_org: ctx().orgId, p_project: v.obra, p_number: v.numero.trim(), p_issue_date: v.data, p_gross: x.bruto, p_account: v.conta,
      p_due: v.venc || v.data, p_series: (v.serie || '').trim(), p_competence: v.comp ? `${v.comp}-01` : null, p_client_name: (v.tomador || '').trim(), p_client_doc: (v.doc || '').trim(),
      p_description: (v.desc || '').trim(), p_inss_base: x.inssBase, p_inss_rate: x.inssAliq, p_iss_rate: x.issAliq, p_iss_withheld: x.issRetido,
      p_irrf: x.irrf, p_pis: x.pis, p_cofins: x.cofins, p_csll: x.csll }), 'nota fiscal');
    await carregarFinEmpresa(true);
    toast(`NFS-e ${v.numero.trim()} registrada — líquido a receber ${fmtBRL(r.liquido)}.`);
    return true;
  });
}

/* ---------- ações ---------- */
const entrada = (id) => F.entradas.find((x) => x.id === id);
const fecharDlg = () => { const d = document.getElementById('dlg'); if (d.open) d.close(); };
export const acoesFinEmpresa = {
  async finNovo(d) { await formularioLancamento(d.k); },
  async finEditar(d) { fecharDlg(); const e = entrada(d.id); await formularioLancamento(e.kind, e); },
  async finBaixar(d) { await formularioBaixa(entrada(d.id)); },
  finDetalhe(d) { detalhe(entrada(d.id)); },
  async finEstornar(d) {
    fecharDlg();
    const v = await formDialog({ title: 'Estornar baixa', ok: 'Estornar', text: 'A baixa fica no histórico como estornada e o lançamento volta a ter saldo.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).from('fin_settlements').update({ deleted_at: new Date().toISOString(), undo_reason: v.motivo.trim() }).eq('id', d.id), 'estorno');
    await carregarFinEmpresa(true);
    toast('Baixa estornada.');
  },
  async finCancelar(d) {
    fecharDlg();
    const v = await formDialog({ title: 'Cancelar lançamento', ok: 'Cancelar lançamento', text: 'O lançamento continua no histórico como cancelado.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('fin_cancelar_lancamento', { p_id: d.id, p_reason: v.motivo }), 'cancelar');
    await carregarFinEmpresa(true);
    toast('Lançamento cancelado.');
  },
  async finConta(d) { await formularioConta(contaPorId(d.id)); },
  async finSubconta(d) { await formularioConta(null, contaPorId(d.id)); },
  async finCentro(d) { await formularioCentro(d.id ? centroPorId(d.id) : null); },
  async finBanco(d) { await formularioBanco(d.id ? bancoPorId(d.id) : null); },
  async finContrato(d) { await formularioContrato(d.p); },
  async finVerba(d) { const k = F.contratos.find((x) => x.id === d.k); await formularioVerba(k, d.id ? F.verbas.find((x) => x.id === d.id) : null); },
  async finParcelas(d) { await formularioParcelas(d.p); },
  async finLancarTaxa(d) { await lancarTaxa(d.p, d.m); },
  finPrestacao(d) { ir(`#/fin/prestacao/${d.p}/${mesAtual()}`); },
  finImprimir() { window.print(); },
  async finNovaNf() { await formularioNotaServico(); },
  async finImportarOfx() { await importarOfx(); },
  finBaixarContabil() { baixarContabil(); },
  async finConciliar(d) {
    ok(await (await sb()).rpc('conciliar_linha', { p_line: d.l, p_settlement: d.t === 'baixa' ? d.id : null, p_payment: d.t === 'pagamento' ? d.id : null }), 'conciliar');
    await carregarFinEmpresa(true);
    toast('Linha conciliada.');
  },
  async finConciliarTodas() {
    const banco = bancoConc();
    const pend = F.linhasBanco.filter((l) => l.bank_account_id === banco.id && l.status === 'pendente');
    const sug = sugerirConciliacao(pend, candidatosConc(banco));
    const c = await sb();
    let n = 0, falhas = 0;
    for (const [linha, s] of sug) {
      const { error } = await c.rpc('conciliar_linha', { p_line: linha, p_settlement: s.tipo === 'baixa' ? s.id : null, p_payment: s.tipo === 'pagamento' ? s.id : null });
      if (error) falhas++; else n++;
    }
    await carregarFinEmpresa(true);
    toast(`${n} linha(s) conciliada(s)${falhas ? `; ${falhas} não (confira uma a uma)` : ''}.`, 5000);
  },
  async finEscolherConc(d) {
    const l = F.linhasBanco.find((x) => x.id === d.l);
    const cands = candidatosConc(bancoConc()).filter((c) => Math.abs(c.valor - Number(l.amount)) <= 0.005)
      .sort((a, b) => Math.abs(new Date(a.data) - new Date(l.posted_date)) - Math.abs(new Date(b.data) - new Date(l.posted_date)));
    if (!cands.length) return toast('Nenhum lançamento com este valor. Use "Lançar" para criar um.', 5000);
    const v = await formDialog({ title: `Conciliar ${fmtBRL(l.amount)} de ${isoBR(l.posted_date)}`, ok: 'Conciliar', text: l.memo || '',
      fields: [{ name: 'c', label: 'Lançamento de mesmo valor', type: 'select', value: `${cands[0].tipo}|${cands[0].id}`,
        options: cands.map((c) => ({ value: `${c.tipo}|${c.id}`, label: `${isoBR(c.data)} · ${c.tipo === 'baixa' ? '' : 'obra · '}${c.descricao}` })) }] });
    if (!v) return;
    const [t, id] = v.c.split('|');
    await acoesFinEmpresa.finConciliar({ l: l.id, t, id });
  },
  async finLancarLinha(d) {
    const l = F.linhasBanco.find((x) => x.id === d.l);
    const kind = Number(l.amount) > 0 ? 'receber' : 'pagar';
    const contas = contasLancaveis(F.contas, kind);
    const padrao = contaPorCodigo(kind === 'pagar' ? '5.1' : '1.4');
    const v = await formDialog({ title: `Lançar ${fmtBRL(l.amount)} de ${isoBR(l.posted_date)}`, ok: 'Lançar e conciliar', text: 'Para o que só aparece no banco (tarifa, juros, rendimento, IOF): cria o lançamento já pago nesta conta e concilia.',
      fields: [{ name: 'desc', label: 'Descrição', value: l.memo || '' },
        { name: 'conta', label: 'Conta', type: 'select', value: padrao?.id || contas[0]?.id, options: contas.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })) },
        { name: 'cc', label: 'Centro de custo', type: 'select', value: F.centros.find((c) => c.kind === 'matriz')?.id, options: F.centros.filter((c) => c.active).map((c) => ({ value: c.id, label: nomeCentro(c) })) }] });
    if (!v) return;
    ok(await (await sb()).rpc('lancar_linha_extrato', { p_line: l.id, p_account: v.conta, p_cost_center: v.cc, p_description: v.desc.trim() }), 'lançar');
    await carregarFinEmpresa(true);
    toast('Lançado e conciliado.');
  },
  async finIgnorarLinha(d) {
    const v = await formDialog({ title: 'Ignorar linha do extrato', ok: 'Ignorar', text: 'Use para o que não precisa de lançamento (ex.: transferência entre contas da própria empresa já lançada na outra conta).',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('ignorar_linha', { p_line: d.l, p_reason: v.motivo }), 'ignorar');
    await carregarFinEmpresa(true);
  },
  async finDesconciliar(d) {
    const v = await formDialog({ title: 'Desfazer conciliação', ok: 'Desfazer', text: 'A linha volta para pendente; o lançamento fica livre para ser corrigido ou estornado.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('desconciliar_linha', { p_line: d.l, p_reason: v.motivo }), 'desfazer');
    await carregarFinEmpresa(true);
  },
  async finCancelarNf(d) {
    const n = F.notas.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Cancelar NFS-e ${n.number}`, ok: 'Cancelar nota', text: 'Cancele também no portal da prefeitura. A conta a receber e a retenção são canceladas; fica no histórico.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('cancelar_nfse', { p_id: n.id, p_reason: v.motivo }), 'cancelar nota');
    await carregarFinEmpresa(true);
    toast('Nota cancelada.');
  },
  async finArquivo(d) {
    const url = await urlTemporaria(d.path, 300);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) info('Arquivo', `<p><a href="${esc(url)}" target="_blank" rel="noopener">Clique para abrir</a> (link válido por 5 minutos).</p>`);
  },
};
export const mudancasFinEmpresa = {
  finFiltro(d, el) { filtros()[d.k] = el.value; queueRender(); },
  finConcBanco(d, el) { (ui.finConc ||= {}).banco = el.value; queueRender(); },
  finExp(d, el) {
    const f = XF();
    if (['de', 'ate'].includes(d.k) && !el.value) return;
    f[d.k] = el.value;
    if (f.de > f.ate) f[d.k === 'de' ? 'ate' : 'de'] = el.value;
    queueRender();
  },
  finAud(d, el) {
    const f = AF();
    if (['de', 'ate'].includes(d.k) && !el.value) return;
    f[d.k] = el.value;
    if (f.de > f.ate) f[d.k === 'de' ? 'ate' : 'de'] = el.value;
    queueRender();
  },
  finRel(d, el) {
    const f = R();
    f[d.k] = el.value;
    if (f.de > f.ate) f[d.k === 'de' ? 'ate' : 'de'] = el.value;
    queueRender();
  },
  finMesPrestacao(d, el) { if (/^\d{4}-\d{2}$/.test(el.value)) ir(`#/fin/prestacao/${d.p}/${el.value}`); },
  async finRegime(d, el) {
    if (!(await ask(`Definir o regime tributário como "${REGIMES[el.value]}"?`, 'Definir'))) { el.value = F.regime; return; }
    ok(await (await sb()).rpc('definir_regime_tributario', { p_org: ctx().orgId, p_regime: el.value }), 'regime');
    await carregarFinEmpresa(true);
    toast('Regime tributário salvo.');
  },
};
void store;
