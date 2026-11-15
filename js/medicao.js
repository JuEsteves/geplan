// Medição por contrato de mão de obra (modo nuvem) — planilha de avanço físico-financeiro de cada contrato "por medição":
//  • planilha por PORCENTAGEM (etapas com peso % do contrato; padrão) ou por AMBIENTE (unidade, quantidade e preço);
//  • medições numeradas e datadas com o acumulado executado, retenção (padrão 5%, devolvida com o último pagamento);
//  • aditivos (+) e glosas (−), que entram no Financeiro como aditivos do compromisso;
//  • pagamentos independentes da medição (mostra "pago além do executado"), cada um vira despesa paga no Financeiro;
//  • página Pagamentos: lista da sexta-feira, obra × profissional, balanço (mão de obra × contrato do cliente, R$/m²) e PIX.
// Regras e permissões no banco (migração 0016): só o engenheiro responsável pelo contrato lança medições, aditivos,
// glosas e pagamentos; a chave PIX só o administrador vê (ou quem ele liberar). Cálculos em js/medicaoRegras.js.
import * as store from './store.js';
import { esc, I, ui, toast, ask, formDialog, queueRender, parseNum, fmtIn, secao, ajuda, commit } from './ui.js';
import { fmtBRL, isoBR, todayISO, fmtNum } from './schedule.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { liberado, pode } from './permissoes.js';
import { idObraDaRota, noModulo } from './escopo.js';
import { membros as listarMembros } from './nuvem/conta.js';
import { numeroContrato, STATUS_CONTRATO, resumoContrato } from './contratosRegras.js';
import {
  FORMAS_MEDICAO, numeroMedicao, valorItem, fracao, acumuladoAte, valoresMedicao, conferirPlanilha, resumoMedicao,
  proximaSexta, listaDaSemana, balancoObra, r2,
} from './medicaoRegras.js';

const vazioObra = () => ({ contratos: [], itens: [], medicoes: [], linhas: [], pagamentos: [], carregando: false, em: 0, erro: '' });
const D = { porObra: new Map(), base: { em: 0, carregando: false, erro: '' }, profissionais: [], pix: new Map(), membros: [], acessoPix: [] };
const ctx = () => nuvem.contexto();
const papel = () => ctx()?.papel;
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const veValores = () => ['admin', 'engenheiro', 'financeiro'].includes(papel());
const eAdmin = () => papel() === 'admin';
const disponivel = () => nuvemConfigurada() && nuvem.ativo() && !!ctx();
const souResponsavel = (k) => !!k?.responsible_id && k.responsible_id === ctx()?.userId && ['admin', 'engenheiro'].includes(papel());
const podeContratar = () => veValores() && liberado('comprar');
const prof = (id) => D.profissionais.find((w) => w.id === id);
const obraNome = (id) => store.obra(id)?.nome || 'obra';
const vivos = (xs) => xs.filter((x) => !x.deleted_at);
const qtd = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 }));
const pct = (n) => `${fmtNum(n, n >= 10 || n === 0 ? 0 : 1)}%`;
const badge = (st) => `<span class="badge ${STATUS_CONTRATO[st]?.cls || ''}">${esc(STATUS_CONTRATO[st]?.rotulo || st)}</span>`;
const FORMAS_PG = ['PIX', 'Transferência', 'Dinheiro', 'Cheque', 'Outro'];
const TIPOS_PIX = { '': '—', cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', telefone: 'Telefone', aleatoria: 'Chave aleatória' };

/* ---------- dados ---------- */
async function carregarBase(forcar = false) {
  const b = D.base;
  if (b.carregando || (!forcar && b.em && Date.now() - b.em < 60000)) return;
  b.carregando = true;
  try {
    const c = await sb(); const org = ctx().orgId;
    const [ws, px, ac, ms] = await Promise.all([
      c.from('workers').select('id, name, kind, specialties, status, phone').eq('org_id', org).is('deleted_at', null).order('name'),
      c.from('worker_bank_info').select('*').eq('org_id', org),
      c.from('org_pix_access').select('user_id').eq('org_id', org),
      listarMembros(org).catch(() => []),
    ]);
    D.profissionais = ok(ws, 'profissionais') || [];
    D.pix = new Map((ok(px, 'PIX') || []).map((x) => [x.worker_id, x]));
    D.acessoPix = (ok(ac, 'acesso ao PIX') || []).map((x) => x.user_id);
    D.membros = ms || [];
    b.erro = '';
  } catch (e) { b.erro = e.message; }
  b.carregando = false; b.em = Date.now();
  queueRender();
}

/** Carrega contratos por medição e tudo o que for deles nas obras pedidas (uma consulta por tabela). */
async function carregarObras(ids, forcar = false) {
  const faltam = ids.filter((id) => { const d = D.porObra.get(id); return forcar || !d || (!d.carregando && Date.now() - d.em > 60000); });
  if (!faltam.length) return;
  for (const id of faltam) D.porObra.set(id, { ...(D.porObra.get(id) || vazioObra()), carregando: true });
  try {
    const c = await sb();
    const [ks, its, ms, ls, ps] = await Promise.all([
      c.from('labor_contracts').select('*').in('project_id', faltam).is('deleted_at', null).order('number'),
      c.from('labor_contract_items').select('*').in('project_id', faltam).order('position'),
      c.from('labor_measurements').select('*').in('project_id', faltam).is('deleted_at', null).order('number'),
      c.from('labor_measurement_lines').select('*').in('project_id', faltam),
      c.from('labor_payments').select('*').in('project_id', faltam).order('number'),
    ]);
    const dados = { contratos: ok(ks, 'contratos') || [], itens: ok(its, 'planilha') || [], medicoes: ok(ms, 'medições') || [],
      linhas: ok(ls, 'medições') || [], pagamentos: ok(ps, 'pagamentos') || [] };
    for (const id of faltam) {
      D.porObra.set(id, { contratos: dados.contratos.filter((x) => x.project_id === id), itens: dados.itens.filter((x) => x.project_id === id),
        medicoes: dados.medicoes.filter((x) => x.project_id === id), linhas: dados.linhas.filter((x) => x.project_id === id),
        pagamentos: dados.pagamentos.filter((x) => x.project_id === id), carregando: false, em: Date.now(), erro: '' });
    }
  } catch (e) { for (const id of faltam) D.porObra.set(id, { ...vazioObra(), em: Date.now(), erro: e.message }); }
  queueRender();
}
/** Outra tela mudou contratos da obra (Contratos): a próxima abertura da medição recarrega. */
export function invalidarMedicao(pid) { const d = D.porObra.get(pid); if (d && !d.carregando) d.em = 0; }
export function limparMedicao() { D.porObra.clear(); Object.assign(D, { base: { em: 0, carregando: false, erro: '' }, profissionais: [], pix: new Map(), membros: [], acessoPix: [] }); }

/** Depois de uma ação no banco: (se mexeu no Financeiro) envia/baixa as obras; recarrega a medição da obra. */
async function depois(pid, { obras = false } = {}) {
  if (obras) { await nuvem.enviar().catch(() => {}); if (!nuvem.pendente()) await nuvem.baixar().catch(() => {}); }
  await carregarObras([pid], true);
}

function garantir(ids) {
  if (!D.base.em && !D.base.carregando) setTimeout(() => carregarBase());
  const precisa = ids.filter((id) => { const d = D.porObra.get(id); return !d || (!d.carregando && Date.now() - d.em > 60000); });
  if (precisa.length) setTimeout(() => carregarObras(precisa));
  return ids.every((id) => D.porObra.get(id)?.em);
}

const porMedicao = (d) => d.contratos.filter((k) => k.payment_mode === 'medicao');
const resumoDe = (d, k) => resumoMedicao(k, d.itens, d.medicoes, d.pagamentos);

/* ---------- aba Medições da obra ---------- */
/** Abas da medição na obra: medição dos contratos e avanço físico (o avanço continua separado da medição). */
export function navMedicao(oid, aba) {
  const abas = [['', 'Medição dos contratos'], ['avanco', 'Avanço físico']];
  return `<nav class="row abas-sup">${abas.map(([k, r]) => `<a class="btn sm ${k === aba ? 'primary' : ''}" href="#/obra/${oid}/medicoes${k ? `/${k}` : ''}" ${k === aba ? 'aria-current="page"' : ''}>${r}</a>`).join('')}</nav>`;
}

/** Aba Medições da obra (modo nuvem). `resto` = [] (lista) ou ['contrato', id]. */
export function viewMedicaoObra(c, resto = []) {
  const { o } = c;
  if (!disponivel()) return '<div class="card empty"><p>Carregando os dados da empresa…</p></div>';
  if (!veValores()) return `${navMedicao(o.id, '')}<div class="card empty" style="margin-top:12px"><p>Seu perfil não vê a medição e os valores de mão de obra. O avanço físico está na aba ao lado.</p></div>`;
  if (!garantir([o.id])) return `${navMedicao(o.id, '')}<div class="card empty" style="margin-top:12px"><p>Carregando…</p></div>`;
  const d = D.porObra.get(o.id);
  if (d.erro) return `${navMedicao(o.id, '')}<div class="alert err" style="margin-top:12px">${esc(d.erro)}</div>`;
  if (resto[0] === 'contrato' && resto[1]) return viewContrato(o, d, resto[1]);
  return `${navMedicao(o.id, '')}<div style="margin-top:12px">${viewLista(o, d)}</div>`;
}

function barra(p) {
  return `<div class="faixa-barra" style="margin-top:4px" title="${pct(p)}"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></div>`;
}

function viewLista(o, d) {
  const ks = porMedicao(d);
  const linhas = ks.map((k) => ({ k, r: resumoDe(d, k), w: prof(k.worker_id) }));
  const vig = linhas.filter((x) => x.k.status !== 'rascunho');
  const soma = (f) => vig.reduce((s, x) => s + f(x.r), 0);
  return `<div class="page-head" style="margin-bottom:10px"><div><h2>Medição dos contratos</h2><div class="muted">Cada contrato de mão de obra pago por medição tem a sua planilha (por porcentagem ou por ambiente), as medições numeradas, a retenção e os pagamentos.</div></div>
    <div class="row"><a class="btn" href="#/pagamentos">Pagamentos da semana</a><button class="btn" data-act="mcAtualizar">Atualizar</button></div></div>
  <div class="stack">
    ${ks.length ? `<div class="kpis">
        <div class="card kpi"><div class="k-label">Total contratado ${ajuda('Valor dos contratos + aditivos − glosas (contratos ativos).')}</div><div class="k-value">${fmtBRL(soma((r) => r.total))}</div><div class="k-sub">${vig.length} contrato(s) · ${linhas.length - vig.length} em rascunho</div></div>
        <div class="card kpi"><div class="k-label">Executado (medido)</div><div class="k-value">${fmtBRL(soma((r) => r.executado))}</div></div>
        <div class="card kpi"><div class="k-label">Pago</div><div class="k-value">${fmtBRL(soma((r) => r.pago + r.devolvido))}</div></div>
        <div class="card kpi"><div class="k-label">A pagar pelo medido ${ajuda('Executado − retenção − glosas − pago. Quem recebeu além do executado não entra aqui.')}</div><div class="k-value">${fmtBRL(soma((r) => Math.max(0, r.aPagar)))}</div></div>
        <div class="card kpi"><div class="k-label">Retenção guardada</div><div class="k-value">${fmtBRL(soma((r) => r.retencaoADevolver))}</div><div class="k-sub">devolvida com o último pagamento</div></div></div>
      <div class="card table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Contrato</th><th>Profissional</th><th>Forma de medição</th><th>Responsável</th><th class="num">Total</th><th>Executado</th><th class="num">Pago</th><th class="num">A pagar</th><th>Situação</th></tr></thead><tbody>
        ${linhas.map(({ k, r, w }) => `<tr data-act="mcAbrir" data-id="${k.id}" tabindex="0">
          <td class="nowrap"><b>${numeroContrato(k.number)}</b><div class="small">${esc(k.title)}</div></td>
          <td class="small">${esc(w?.name || '—')}${w?.specialties ? `<div class="muted">${esc(w.specialties)}</div>` : ''}</td>
          <td class="small">${esc(FORMAS_MEDICAO[k.measure_mode]?.rotulo || k.measure_mode)}</td>
          <td class="small">${k.responsible_label ? esc(k.responsible_label) : '<span class="badge warn">sem responsável</span>'}</td>
          <td class="num nowrap">${fmtBRL(r.total)}</td>
          <td class="small" style="min-width:130px">${fmtBRL(r.executado)} <span class="muted">(${pct(r.pctExec)})</span>${barra(r.pctExec)}</td>
          <td class="num nowrap">${fmtBRL(r.pago + r.devolvido)}</td>
          <td class="num nowrap">${r.alemDoExecutado ? `<span class="badge crit" title="pago além do executado">+${fmtBRL(r.alemDoExecutado)} além</span>` : fmtBRL(Math.max(0, r.aPagar))}</td>
          <td>${badge(k.status)}</td></tr>`).join('')}
      </tbody></table></div>`
    : `<div class="card empty"><p>Nenhum contrato pago por medição nesta obra.</p><p class="muted small">Crie o contrato em <b>Contratos</b> com a forma de pagamento <b>Por medição</b>; ele aparece aqui para montar a planilha e medir.</p>
        <a class="btn primary" href="#/obra/${o.id}/contratos">Ir para Contratos</a></div>`}
    <div class="muted small">Só o engenheiro responsável por cada contrato lança medições e pagamentos (conferido pelo banco). Os pagamentos entram no Financeiro da obra como despesas pagas do contrato.</div>
  </div>`;
}

/* ---------- contrato ---------- */
function editavel(k, d) {
  const semFechada = !d.medicoes.some((m) => m.contract_id === k.id && m.status === 'fechada');
  return semFechada && ['rascunho', 'vigente'].includes(k.status) && (souResponsavel(k) || podeContratar());
}

function viewContrato(o, d, id) {
  const k = d.contratos.find((x) => x.id === id);
  const voltar = `<a class="muted small" href="#/obra/${o.id}/medicoes">← Medição dos contratos</a>`;
  if (!k) {
    // contrato criado há pouco em outra tela: recarrega uma vez antes de dizer que não existe
    if (!d.carregando && Date.now() - d.em > 3000) { setTimeout(() => carregarObras([o.id], true)); return `${voltar}<div class="card empty"><p>Carregando…</p></div>`; }
    return `${voltar}<div class="card empty"><p>Contrato não encontrado.</p></div>`;
  }
  if (k.payment_mode !== 'medicao') return `${voltar}<div class="card empty"><p>Este contrato não é pago por medição (${esc(k.payment_mode)}).</p><a class="btn" href="#/obra/${o.id}/contratos/${k.id}">Abrir o contrato</a></div>`;
  const w = prof(k.worker_id);
  const r = resumoDe(d, k);
  const resp = souResponsavel(k);
  const meds = d.medicoes.filter((m) => m.contract_id === k.id).sort((a, b) => a.number - b.number);
  const rasc = meds.find((m) => m.status === 'rascunho');
  const pix = D.pix.get(k.worker_id);
  const forma = FORMAS_MEDICAO[k.measure_mode] || FORMAS_MEDICAO.percentual;
  const podeForma = editavel(k, d) && !meds.length;
  const avisos = [];
  if (k.status === 'rascunho') avisos.push(`<div class="alert info small">Contrato em rascunho: monte a planilha e ative o contrato em <a href="#/obra/${o.id}/contratos/${k.id}">Contratos</a> para começar a medir.</div>`);
  if (!k.responsible_id) avisos.push(`<div class="alert warn small"><b>Sem engenheiro responsável.</b> Só o responsável lança medições e pagamentos. ${eAdmin() ? 'Defina em "Trocar responsável".' : 'O administrador define.'}</div>`);
  else if (!resp) avisos.push(`<div class="muted small">Medições, aditivos, glosas e pagamentos deste contrato são lançados por <b>${esc(k.responsible_label || 'o responsável')}</b>. Você consulta.</div>`);
  return `${voltar}
  <div class="page-head" style="margin-top:4px"><div><h2>${numeroContrato(k.number)} — ${esc(k.title)} ${badge(k.status)}</h2>
      <div class="muted small">${esc(w?.name || '—')}${w?.specialties ? ` · ${esc(w.specialties)}` : ''} · <b>${esc(forma.rotulo)}</b> · retenção ${fmtNum(Number(k.retention_pct), 2)}% · responsável: ${esc(k.responsible_label || '—')}</div>
      ${pix && pix.pix_key ? `<div class="small" style="margin-top:4px">PIX (${esc(TIPOS_PIX[pix.pix_type] || '')}): <b>${esc(pix.pix_key)}</b>${pix.holder ? ` · ${esc(pix.holder)}` : ''}${pix.bank ? ` · ${esc(pix.bank)}` : ''}</div>` : ''}</div>
    <div class="row" style="gap:6px;flex-wrap:wrap">
      ${podeForma ? `<button class="btn" data-act="mcForma" data-id="${k.id}">Forma de medição e retenção</button>` : ''}
      ${eAdmin() || (k.status === 'rascunho' && podeContratar()) ? `<button class="btn" data-act="mcResponsavel" data-id="${k.id}">Trocar responsável</button>` : ''}
      <a class="btn" href="#/obra/${o.id}/contratos/${k.id}">Contrato</a></div></div>
  <div class="stack">
    ${avisos.join('')}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Valor do contrato</div><div class="k-value">${fmtBRL(r.valor)}</div><div class="k-sub">${r.aditivos ? `+ ${fmtBRL(r.aditivos)} aditivos` : 'sem aditivos'}${r.glosas ? ` · − ${fmtBRL(r.glosas)} glosas` : ''}</div></div>
      <div class="card kpi"><div class="k-label">Executado</div><div class="k-value">${fmtBRL(r.executado)}</div><div class="k-sub">${pct(r.pctExec)} de ${fmtBRL(r.base)} · ${r.medicoes} medição(ões)</div>${barra(r.pctExec)}</div>
      <div class="card kpi"><div class="k-label">Pago</div><div class="k-value">${fmtBRL(r.pago)}</div><div class="k-sub">${r.devolvido ? `+ ${fmtBRL(r.devolvido)} de retenção devolvida` : `saldo do contrato ${fmtBRL(r.saldo)}`}</div></div>
      ${r.alemDoExecutado ? `<div class="card kpi kpi-alerta"><div class="k-label">Pago além do executado</div><div class="k-value">${fmtBRL(r.alemDoExecutado)}</div><div class="k-sub">adiantado em relação ao medido</div></div>`
        : `<div class="card kpi"><div class="k-label">A pagar pelo medido ${ajuda('Executado − retenção − glosas − pago.')}</div><div class="k-value">${fmtBRL(Math.max(0, r.aPagar))}</div></div>`}
      <div class="card kpi"><div class="k-label">Retenção guardada</div><div class="k-value">${fmtBRL(r.retencaoADevolver)}</div><div class="k-sub">${r.completo || k.status === 'concluido' ? 'pode ser devolvida' : 'devolvida com o último pagamento'}</div></div></div>
    ${secao({ id: 'mc:planilha', area: 'orc', titulo: `Planilha do contrato · ${esc(forma.rotulo.toLowerCase())}`, n: vivos(d.itens).filter((i) => i.contract_id === k.id && i.kind === 'servico').length,
      acoes: editavel(k, d) ? `<button class="btn sm" data-act="mcItemNovo" data-id="${k.id}">${I.plus} ${k.measure_mode === 'ambiente' ? 'Item' : 'Etapa'}</button>` : '', corpo: planilha(k, d) })}
    ${secao({ id: 'mc:medicoes', area: 'orc', titulo: 'Medições', n: meds.filter((m) => m.status === 'fechada').length,
      acoes: resp && k.status === 'vigente' && !rasc ? `<button class="btn sm primary" data-act="mcNovaMedicao" data-id="${k.id}">${I.plus} Nova medição</button>` : '', corpo: medicoes(k, d, meds, rasc, resp) })}
    ${secao({ id: 'mc:ajustes', area: 'orc', titulo: 'Aditivos e glosas', n: vivos(d.itens).filter((i) => i.contract_id === k.id && i.kind !== 'servico').length,
      acoes: resp && k.status === 'vigente' ? `<button class="btn sm" data-act="mcAjuste" data-id="${k.id}" data-tipo="aditivo">${I.plus} Aditivo</button><button class="btn sm" data-act="mcAjuste" data-id="${k.id}" data-tipo="glosa">− Glosa</button>` : '', corpo: ajustes(k, d, resp) })}
    ${secao({ id: 'mc:pagamentos', area: 'orc', titulo: 'Pagamentos', n: vivos(d.pagamentos).filter((p) => p.contract_id === k.id).length,
      acoes: resp && k.status !== 'rascunho' ? `<button class="btn sm primary" data-act="mcPagar" data-id="${k.id}">${I.plus} Registrar pagamento</button>${r.retencaoADevolver > 0.005 && (r.completo || k.status === 'concluido') ? `<button class="btn sm" data-act="mcDevolver" data-id="${k.id}">Devolver retenção</button>` : ''}` : '', corpo: pagamentos(k, d, r, resp) })}
  </div>`;
}

function planilha(k, d) {
  const its = vivos(d.itens).filter((i) => i.contract_id === k.id && i.kind === 'servico').sort((a, b) => a.position - b.position);
  const ult = [...d.medicoes].filter((m) => m.contract_id === k.id && m.status === 'fechada').sort((a, b) => b.number - a.number)[0];
  const acum = ult ? acumuladoAte(ult, d.medicoes, d.linhas) : new Map();
  const ed = editavel(k, d);
  const conf = conferirPlanilha(k, d.itens);
  const amb = k.measure_mode === 'ambiente';
  const inp = (i, campo, v, w = 90, dec = 4) => (ed ? `<input class="cell" ${['description', 'group_name', 'unit'].includes(campo) ? '' : 'inputmode="decimal"'} data-chg="mcItem" data-id="${i.id}" data-k="${campo}" value="${esc(['description', 'group_name', 'unit'].includes(campo) ? v ?? '' : fmtIn(v, dec))}" style="width:${w}px">` : null);
  if (!its.length) {
    return `<div class="muted small">${ed ? `Sem itens ainda. Use <b>+ ${amb ? 'Item' : 'Etapa'}</b>.` : 'Sem itens.'} ${esc(FORMAS_MEDICAO[k.measure_mode]?.texto || '')}</div>`;
  }
  let grupoAnt = null;
  const linhas = its.map((i) => {
    const v = valorItem(i, k); const f = fracao(acum.get(i.id), i);
    // consulta: a fase/ambiente vira uma linha de título; edição: fica na coluna (editável)
    const cab = !ed && i.group_name !== grupoAnt ? (grupoAnt = i.group_name, i.group_name ? `<tr class="lvl1"><td colspan="${amb ? 9 : 7}">${esc(i.group_name)}</td></tr>` : '') : '';
    const acoes = ed ? `<td><button class="btn sm ghost" data-act="mcItemRemover" data-id="${i.id}" title="Remover">${I.trash}</button></td>` : '<td></td>';
    if (amb) return `${cab}<tr><td>${inp(i, 'group_name', i.group_name, 120) ?? ''}</td><td>${inp(i, 'description', i.description, 200) ?? esc(i.description)}</td>
      <td>${inp(i, 'unit', i.unit, 50) ?? esc(i.unit)}</td><td class="num">${inp(i, 'quantity', i.quantity, 80) ?? qtd(i.quantity)}</td>
      <td class="num">${inp(i, 'unit_price', i.unit_price, 90, 2) ?? (i.unit_price == null ? '—' : fmtBRL(i.unit_price))}</td><td class="num nowrap">${fmtBRL(v)}</td>
      <td class="num">${qtd(acum.get(i.id)?.qty_acum ?? 0)} <span class="muted small">(${pct(f * 100)})</span></td><td class="num nowrap">${fmtBRL(r2(f * v))}</td>${acoes}</tr>`;
    return `${cab}<tr><td>${inp(i, 'group_name', i.group_name, 120) ?? ''}</td><td>${inp(i, 'description', i.description, 220) ?? esc(i.description)}</td>
      <td class="num">${inp(i, 'weight_pct', i.weight_pct, 70) ?? `${fmtNum(Number(i.weight_pct), 2)}%`}</td><td class="num nowrap">${fmtBRL(v)}</td>
      <td class="num">${pct(f * 100)}</td><td class="num nowrap">${fmtBRL(r2(f * v))}</td>${acoes}</tr>`;
  }).join('');
  const cabecalho = amb ? '<th>Ambiente</th><th>Item</th><th>Un</th><th class="num">Qtd</th><th class="num">Preço unit.</th><th class="num">Total</th><th class="num">Executado (acum.)</th><th class="num">Executado R$</th><th></th>'
    : '<th>Fase</th><th>Etapa</th><th class="num">Peso</th><th class="num">Valor</th><th class="num">Executado (acum.)</th><th class="num">Executado R$</th><th></th>';
  const totalCols = amb ? `<th colspan="5">Total</th><th class="num nowrap">${fmtBRL(conf.soma)}</th><th></th><th class="num nowrap">${fmtBRL(r2(its.reduce((s, i) => s + r2(fracao(acum.get(i.id), i) * valorItem(i, k)), 0)))}</th><th></th>`
    : `<th colspan="2">Total</th><th class="num">${fmtNum(conf.soma, 2)}%</th><th class="num nowrap">${fmtBRL(r2(its.reduce((s, i) => s + valorItem(i, k), 0)))}</th><th></th><th class="num nowrap">${fmtBRL(r2(its.reduce((s, i) => s + r2(fracao(acum.get(i.id), i) * valorItem(i, k)), 0)))}</th><th></th>`;
  return `${!conf.ok ? `<div class="alert warn small">${esc(conf.msg)} ${amb ? `Valor do contrato: ${fmtBRL(k.amount)}.` : ''} A primeira medição só fecha com a planilha conferida.</div>` : ''}
    <div class="table-wrap"><table class="data"><thead><tr>${cabecalho}</tr></thead><tbody>${linhas}</tbody><tfoot><tr>${totalCols}</tr></tfoot></table></div>
    <div class="muted small">${ed ? 'A planilha pode ser ajustada até a primeira medição fechada; depois, mudanças entram como aditivo ou glosa.' : 'Planilha fixada pela primeira medição: mudanças entram como aditivo ou glosa.'}</div>`;
}

function medicoes(k, d, meds, rasc, resp) {
  const fech = meds.filter((m) => m.status === 'fechada');
  const ultima = fech[fech.length - 1];
  const lista = meds.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Medição</th><th>Data</th><th class="num">Valor do período</th><th class="num">Retenção</th><th class="num">Líquido</th><th>Situação</th><th>Lançada por</th><th></th></tr></thead><tbody>
    ${meds.map((m) => { const v = valoresMedicao(k, d.itens, d.medicoes, d.linhas, m);
      return `<tr><td class="nowrap"><b>${numeroMedicao(m.number)}</b></td><td>${isoBR(m.measure_date)}</td><td class="num nowrap">${fmtBRL(v.bruto)}</td>
        <td class="num nowrap">${fmtBRL(v.retencao)} <span class="muted small">(${fmtNum(v.pctRetencao, 2)}%)</span></td><td class="num nowrap"><b>${fmtBRL(v.liquido)}</b></td>
        <td>${m.status === 'fechada' ? '<span class="badge good">fechada</span>' : '<span class="badge warn">em lançamento</span>'}${m.reopen_reason ? ` ${ajuda(`Reaberta: ${m.reopen_reason}`)}` : ''}</td>
        <td class="small">${esc(m.closed_label || m.created_label || '')}</td>
        <td>${resp && m === ultima && !rasc ? `<button class="btn sm" data-act="mcReabrir" data-id="${m.id}">Reabrir</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="muted small">Nenhuma medição ainda.</div>';
  return `${lista}${rasc ? editorMedicao(k, d, rasc, resp) : ''}`;
}

function editorMedicao(k, d, m, resp) {
  const ant = [...d.medicoes].filter((x) => x.contract_id === k.id && x.status === 'fechada' && x.number < m.number).sort((a, b) => b.number - a.number)[0];
  const antes = ant ? acumuladoAte(ant, d.medicoes, d.linhas) : new Map();
  const agora = new Map(d.linhas.filter((l) => l.measurement_id === m.id).map((l) => [l.item_id, l]));
  const its = vivos(d.itens).filter((i) => i.contract_id === k.id && i.kind !== 'glosa').sort((a, b) => (b.kind === 'servico') - (a.kind === 'servico') || a.position - b.position);
  const v = valoresMedicao(k, d.itens, d.medicoes, d.linhas, m);
  const porQtd = (i) => k.measure_mode === 'ambiente' && i.quantity != null;
  const linhas = its.map((i) => {
    const va = valorItem(i, k); const la = antes.get(i.id); const ln = agora.get(i.id);
    const fa = fracao(la, i); const fn = ln ? fracao(ln, i) : fa;
    const q = porQtd(i);
    const atual = ln ? (q ? ln.qty_acum : ln.pct_acum) : null;
    const anterior = q ? qtd(la?.qty_acum ?? 0) + (i.unit ? ` ${esc(i.unit)}` : '') : pct(fa * 100);
    return `<tr><td>${i.kind === 'aditivo' ? '<span class="badge info">aditivo</span> ' : ''}${i.group_name ? `<span class="muted small">${esc(i.group_name)} · </span>` : ''}${esc(i.description)}</td>
      <td class="num nowrap">${fmtBRL(va)}</td><td class="num">${anterior}</td>
      <td class="num">${resp ? `<input class="cell" inputmode="decimal" data-chg="mcLinha" data-m="${m.id}" data-item="${i.id}" data-tipo="${q ? 'qty' : 'pct'}" value="${fmtIn(atual, 4)}" placeholder="${q ? fmtIn(la?.qty_acum ?? 0, 4) : fmtIn(fa * 100, 4)}" style="width:90px"> ${q ? esc(i.unit || '') : '%'}` : (atual == null ? '—' : q ? qtd(atual) : pct(atual))}
        ${q ? `<div class="muted small">de ${qtd(i.quantity)}</div>` : ''}</td>
      <td class="num nowrap">${fmtBRL(r2(r2(fn * va) - r2(fa * va)))}</td></tr>`;
  }).join('');
  return `<div class="card card-pad stack" style="margin-top:12px;border-left:4px solid var(--warn)">
    <div class="row between" style="gap:10px;flex-wrap:wrap"><h3 style="margin:0">${numeroMedicao(m.number)} — em lançamento</h3>
      <label class="field" style="margin:0">Data da medição <input type="date" ${resp ? `data-chg="mcData" data-id="${m.id}"` : 'disabled'} value="${esc(m.measure_date)}"></label></div>
    <div class="muted small">Informe o <b>acumulado</b> executado até esta medição (${k.measure_mode === 'ambiente' ? 'quantidade de cada item' : '% de cada etapa'}). Deixe em branco o que não mudou. O valor do período é o acumulado menos o da medição anterior.</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="num">Valor do item</th><th class="num">Acumulado anterior</th><th class="num">Acumulado agora</th><th class="num">Valor no período</th></tr></thead><tbody>${linhas}</tbody>
      <tfoot><tr><th colspan="4">Valor do período</th><th class="num nowrap">${fmtBRL(v.bruto)}</th></tr>
        <tr><th colspan="4">Retenção (${fmtNum(v.pctRetencao, 2)}%)</th><th class="num nowrap">− ${fmtBRL(v.retencao)}</th></tr>
        <tr><th colspan="4">Líquido da medição</th><th class="num nowrap">${fmtBRL(v.liquido)}</th></tr></tfoot></table></div>
    ${resp ? `<label class="field">Observações<textarea rows="2" data-chg="mcNotas" data-id="${m.id}">${esc(m.notes || '')}</textarea></label>
      <div class="row" style="gap:6px"><button class="btn primary" data-act="mcFechar" data-id="${m.id}">Fechar medição</button><button class="btn danger" data-act="mcDescartar" data-id="${m.id}">Descartar</button></div>` : ''}
  </div>`;
}

function ajustes(k, d, resp) {
  const its = d.itens.filter((i) => i.contract_id === k.id && i.kind !== 'servico').sort((a, b) => a.position - b.position);
  if (!its.length) return '<div class="muted small">Nenhum aditivo ou glosa. Aditivo soma ao contrato (e é medido como os outros itens); glosa desconta do valor a pagar. Os dois entram no Financeiro como aditivo do compromisso.</div>';
  const ult = [...d.medicoes].filter((m) => m.contract_id === k.id && m.status === 'fechada').sort((a, b) => b.number - a.number)[0];
  const acum = ult ? acumuladoAte(ult, d.medicoes, d.linhas) : new Map();
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Tipo</th><th>Data</th><th>Descrição</th><th class="num">Valor</th><th class="num">Executado</th><th></th></tr></thead><tbody>
    ${its.map((i) => `<tr${i.deleted_at ? ' class="muted" style="text-decoration:line-through"' : ''}><td>${i.kind === 'aditivo' ? '<span class="badge info">aditivo</span>' : '<span class="badge warn">glosa</span>'}</td>
      <td>${i.item_date ? isoBR(i.item_date) : '—'}</td><td>${i.group_name ? `<span class="muted small">${esc(i.group_name)} · </span>` : ''}${esc(i.description)}${i.quantity != null ? ` <span class="muted small">(${qtd(i.quantity)} ${esc(i.unit)} × ${fmtBRL(i.unit_price)})</span>` : ''}${i.deleted_at ? `<div class="small">removido: ${esc(i.cancel_reason)}</div>` : ''}</td>
      <td class="num nowrap">${i.kind === 'glosa' ? '− ' : '+ '}${fmtBRL(i.amount)}</td>
      <td class="num">${i.kind === 'aditivo' && !i.deleted_at ? pct(fracao(acum.get(i.id), i) * 100) : '—'}</td>
      <td>${resp && !i.deleted_at && k.status === 'vigente' ? `<button class="btn sm ghost" data-act="mcAjusteRemover" data-id="${i.id}" title="Remover">${I.trash}</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function pagamentos(k, d, r, resp) {
  const ps = d.pagamentos.filter((p) => p.contract_id === k.id).sort((a, b) => a.number - b.number);
  const lista = ps.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Nº</th><th>Data</th><th>Tipo</th><th>Forma</th><th class="num">Valor</th><th>Observação</th><th>Lançado por</th><th></th></tr></thead><tbody>
    ${ps.map((p) => `<tr${p.deleted_at ? ' class="muted" style="text-decoration:line-through"' : ''}><td>${p.number}</td><td>${isoBR(p.pay_date)}</td>
      <td>${p.kind === 'retencao' ? '<span class="badge info">devolução da retenção</span>' : 'pagamento'}</td><td class="small">${esc(p.method || '')}</td>
      <td class="num nowrap">${fmtBRL(p.amount)}</td><td class="small">${esc(p.notes || '')}${p.deleted_at ? `<div>estornado: ${esc(p.cancel_reason)}</div>` : ''}</td>
      <td class="small">${esc(p.created_label || '')}</td>
      <td>${resp && !p.deleted_at ? `<button class="btn sm" data-act="mcEstornar" data-id="${p.id}">Estornar</button>` : ''}</td></tr>`).join('')}
  </tbody><tfoot><tr><th colspan="4">Total pago</th><th class="num nowrap">${fmtBRL(r.pago + r.devolvido)}</th><th colspan="3"></th></tr></tfoot></table></div>`
    : '<div class="muted small">Nenhum pagamento registrado.</div>';
  return `${lista}${r.alemDoExecutado ? `<div class="alert warn small">Pago <b>${fmtBRL(r.alemDoExecutado)}</b> além do executado (medido − retenção − glosas).</div>` : ''}
    <div class="muted small">O pagamento é independente da medição. Cada pagamento vira, no Financeiro da obra, uma despesa paga deste contrato (abate do comprometido, sem contar duas vezes).</div>`;
}

/* ---------- página Pagamentos (empresa) ---------- */
const ABAS_PG = [['semana', 'Pagamento da semana'], ['profissionais', 'Por profissional'], ['balanco', 'Balanço das obras'], ['pix', 'PIX dos profissionais']];

export function viewPagamentos(route) {
  const head = '<div class="page-head"><div><h1>Pagamentos de mão de obra</h1><div class="muted">Lista de pagamento da sexta-feira, resumo por profissional, balanço de cada obra e chaves PIX.</div></div></div>';
  if (!disponivel()) return `${head}<div class="card empty"><p>${nuvemConfigurada() ? 'Carregando os dados da empresa…' : 'Funciona no modo nuvem (banco de dados da empresa).'}</p></div>`;
  if (!veValores()) return `${head}<div class="card empty"><p>Seu perfil não vê valores de mão de obra.</p></div>`;
  const aba = ABAS_PG.some(([k]) => k === route.secao) ? route.secao : 'semana';
  const ids = store.obras().map((o) => o.id);
  const nav = `<nav class="row abas-sup">${ABAS_PG.map(([k, r]) => `<a class="btn sm ${k === aba ? 'primary' : ''}" href="#/pagamentos/${k}" ${k === aba ? 'aria-current="page"' : ''}>${r}</a>`).join('')}</nav>`;
  if (!garantir(ids) || !D.base.em) return `${head}${nav}<div class="card empty" style="margin-top:12px"><p>Carregando…</p></div>`;
  const erro = [D.base.erro, ...ids.map((id) => D.porObra.get(id)?.erro)].filter(Boolean)[0];
  const corpo = { semana: abaSemana, profissionais: abaProfissionais, balanco: abaBalanco, pix: abaPix }[aba](ids);
  return `${head}${nav}<div class="stack" style="margin-top:12px">${erro ? `<div class="alert err">${esc(erro)}</div>` : ''}${corpo}
    <div class="muted small">Cadastro de profissionais: <a href="#/medicoes/profissionais">Profissionais</a> · Boletins de medição antigos (só consulta): <a href="#/medicoes/boletins">abrir</a></div></div>`;
}

function todasAsLinhas(ids) {
  return ids.flatMap((id) => { const d = D.porObra.get(id); return porMedicao(d).filter((k) => k.status !== 'rascunho').map((k) => ({ k, r: resumoDe(d, k), d, obra: id, profissional: prof(k.worker_id)?.name || '—' })); });
}
const linkContrato = (x) => `#/obra/${x.obra}/medicoes/contrato/${x.k.id}`;
const pixDe = (wid) => { const p = D.pix.get(wid); return p?.pix_key ? `${esc(p.pix_key)}<div class="muted small">${esc(TIPOS_PIX[p.pix_type] || '')}${p.holder ? ` · ${esc(p.holder)}` : ''}</div>` : '<span class="muted">—</span>'; };
const vePix = () => eAdmin() || D.acessoPix.includes(ctx()?.userId);

function abaSemana(ids) {
  const sexta = ui.mcSemana || proximaSexta(todayISO());
  const lista = listaDaSemana(todasAsLinhas(ids));
  const total = lista.reduce((s, x) => s + x.aPagar + x.retencao, 0);
  return `<div class="row between" style="gap:10px;flex-wrap:wrap"><label class="field" style="margin:0">Pagamento de sexta-feira <input type="date" data-chg="mcSemana" value="${esc(sexta)}"></label>
      <button class="btn" data-act="mcImprimir">Imprimir</button></div>
    <div class="muted small">O que cada profissional tem a receber pelo que já foi medido (líquido da retenção e das glosas, menos o já pago) e as retenções que podem ser devolvidas (contrato 100% medido ou concluído). O pagamento é registrado no contrato, pelo engenheiro responsável.</div>
    ${lista.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Profissional</th>${vePix() ? '<th>PIX</th>' : ''}<th>Obra · contrato</th><th>Última medição</th><th>Responsável</th><th class="num">A pagar</th><th class="num">Retenção a devolver</th><th class="num">Total</th></tr></thead><tbody>
      ${lista.map((x) => `<tr><td><b>${esc(x.profissional)}</b></td>${vePix() ? `<td class="small">${pixDe(x.k.worker_id)}</td>` : ''}
        <td class="small">${esc(obraNome(x.obra))}<div><a href="${linkContrato(x)}">${numeroContrato(x.k.number)} — ${esc(x.k.title)}</a></div></td>
        <td class="small">${x.r.ultimaData ? isoBR(x.r.ultimaData) : '—'}</td><td class="small">${esc(x.k.responsible_label || '—')}</td>
        <td class="num nowrap">${fmtBRL(x.aPagar)}</td><td class="num nowrap">${x.retencao ? fmtBRL(x.retencao) : '—'}</td><td class="num nowrap"><b>${fmtBRL(x.aPagar + x.retencao)}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="${vePix() ? 7 : 6}">Total da sexta-feira ${isoBR(sexta)}</th><th class="num nowrap">${fmtBRL(total)}</th></tr></tfoot></table></div>`
    : '<div class="card empty"><p>Ninguém a receber pelo que foi medido até agora.</p></div>'}
    ${!vePix() ? '<div class="muted small">A chave PIX aparece só para o administrador e para quem ele liberar.</div>' : ''}`;
}

function abaProfissionais(ids) {
  const linhas = todasAsLinhas(ids).sort((a, b) => a.profissional.localeCompare(b.profissional, 'pt-BR') || obraNome(a.obra).localeCompare(obraNome(b.obra), 'pt-BR'));
  if (!linhas.length) return '<div class="card empty"><p>Nenhum contrato por medição ativo.</p></div>';
  const grupos = new Map();
  for (const x of linhas) { if (!grupos.has(x.profissional)) grupos.set(x.profissional, []); grupos.get(x.profissional).push(x); }
  const s = (xs, f) => xs.reduce((a, x) => a + f(x.r), 0);
  return `<div class="card table-wrap"><table class="data"><thead><tr><th>Profissional · obra</th><th>Contrato</th><th class="num">Total</th><th>Executado</th><th class="num">Pago</th><th class="num">A pagar</th><th class="num">Retenção</th></tr></thead><tbody>
    ${[...grupos].map(([nome, xs]) => `<tr class="lvl1"><td colspan="2">${esc(nome)}</td><td class="num nowrap">${fmtBRL(s(xs, (r) => r.total))}</td><td class="nowrap">${fmtBRL(s(xs, (r) => r.executado))}</td>
        <td class="num nowrap">${fmtBRL(s(xs, (r) => r.pago + r.devolvido))}</td><td class="num nowrap">${fmtBRL(s(xs, (r) => Math.max(0, r.aPagar)))}</td><td class="num nowrap">${fmtBRL(s(xs, (r) => r.retencaoADevolver))}</td></tr>
      ${xs.map((x) => `<tr><td class="small">${esc(obraNome(x.obra))}</td><td class="small"><a href="${linkContrato(x)}">${numeroContrato(x.k.number)} — ${esc(x.k.title)}</a> ${badge(x.k.status)}</td>
        <td class="num nowrap">${fmtBRL(x.r.total)}</td><td class="small" style="min-width:130px">${pct(x.r.pctExec)}${barra(x.r.pctExec)}</td><td class="num nowrap">${fmtBRL(x.r.pago + x.r.devolvido)}</td>
        <td class="num nowrap">${x.r.alemDoExecutado ? `<span class="badge crit">+${fmtBRL(x.r.alemDoExecutado)} além</span>` : fmtBRL(Math.max(0, x.r.aPagar))}</td><td class="num nowrap">${fmtBRL(x.r.retencaoADevolver)}</td></tr>`).join('')}`).join('')}
  </tbody></table></div>`;
}

function abaBalanco(ids) {
  const linhas = ids.map((id) => {
    const o = store.obra(id); const d = D.porObra.get(id);
    const contratos = d.contratos.filter((k) => k.status !== 'rascunho').map((k) => {
      if (k.payment_mode === 'medicao') { const r = resumoDe(d, k); return { total: r.total, executado: r.executado, pago: r.pago + r.devolvido }; }
      const r = resumoContrato(k, o.despesas || []);
      return { total: Number(k.amount) || 0, executado: r.lancado, pago: r.pago };
    });
    return { o, b: balancoObra({ valorCliente: o.valorContratado, area: o.areaConstruida, contratos }), n: contratos.length };
  });
  const podeEditar = pode('cadastro');
  const t = balancoObra({ contratos: linhas.map((x) => ({ total: x.b.maoDeObra, executado: x.b.executado, pago: x.b.pago })) });
  return `<div class="muted small">Mão de obra contratada (contratos ativos + aditivos − glosas) comparada ao contrato com o cliente e à área construída. O valor do contrato com o cliente vem do cadastro da obra.</div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Obra</th><th class="num">Contrato do cliente</th><th class="num">Área (m²)</th><th class="num">Mão de obra contratada</th><th class="num">% do contrato do cliente</th><th class="num">Mão de obra R$/m²</th><th class="num">Executado</th><th class="num">Pago</th><th class="num">Pago R$/m²</th></tr></thead><tbody>
    ${linhas.map(({ o, b, n }) => `<tr><td><a href="#/obra/${o.id}/medicoes">${esc(o.nome)}</a><div class="muted small">${n} contrato(s)</div></td>
      <td class="num nowrap">${b.valorCliente == null ? `<a class="muted small" href="#/obra/${o.id}/config">informar</a>` : fmtBRL(b.valorCliente)}</td>
      <td class="num">${podeEditar ? `<input class="cell" inputmode="decimal" data-chg="mcArea" data-id="${o.id}" value="${fmtIn(o.areaConstruida, 2)}" placeholder="m²" style="width:90px">` : (b.area == null ? '—' : fmtNum(b.area, 2))}</td>
      <td class="num nowrap">${fmtBRL(b.maoDeObra)}</td><td class="num">${b.pctDoCliente == null ? '—' : pct(b.pctDoCliente)}</td>
      <td class="num nowrap">${b.moPorM2 == null ? '—' : fmtBRL(b.moPorM2)}</td><td class="num nowrap">${fmtBRL(b.executado)}</td><td class="num nowrap">${fmtBRL(b.pago)}</td>
      <td class="num nowrap">${b.pagoPorM2 == null ? '—' : fmtBRL(b.pagoPorM2)}</td></tr>`).join('')}
    </tbody><tfoot><tr><th>Total</th><th></th><th></th><th class="num nowrap">${fmtBRL(t.maoDeObra)}</th><th></th><th></th><th class="num nowrap">${fmtBRL(t.executado)}</th><th class="num nowrap">${fmtBRL(t.pago)}</th><th></th></tr></tfoot></table></div>`;
}

function abaPix() {
  if (!vePix()) return '<div class="card empty"><p>As chaves PIX dos profissionais ficam visíveis só para o administrador e para quem ele liberar.</p></div>';
  const ws = D.profissionais.filter((w) => w.status === 'ativo' || D.pix.get(w.id));
  const admin = eAdmin();
  const tabela = ws.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Profissional</th><th>Tipo</th><th>Chave PIX</th><th>Titular</th><th>Banco</th></tr></thead><tbody>
    ${ws.map((w) => { const p = D.pix.get(w.id) || {}; const campo = (k, v, wd) => (admin ? `<input class="cell" data-chg="mcPix" data-id="${w.id}" data-k="${k}" value="${esc(v || '')}" style="width:${wd}px">` : esc(v || '—'));
      return `<tr><td><b>${esc(w.name)}</b>${w.specialties ? `<div class="muted small">${esc(w.specialties)}</div>` : ''}</td>
        <td>${admin ? `<select data-chg="mcPix" data-id="${w.id}" data-k="pix_type">${Object.entries(TIPOS_PIX).map(([k, r]) => `<option value="${k}" ${k === (p.pix_type || '') ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(TIPOS_PIX[p.pix_type || ''])}</td>
        <td>${campo('pix_key', p.pix_key, 200)}</td><td>${campo('holder', p.holder, 160)}</td><td>${campo('bank', p.bank, 140)}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="card empty"><p>Nenhum profissional cadastrado.</p></div>';
  const liberar = admin ? `<div class="card card-pad stack"><h2 style="margin:0">Quem pode ver as chaves PIX</h2>
      <div class="muted small">O administrador sempre vê. Marque as pessoas que também podem ver (por exemplo, quem faz os pagamentos). Só o administrador altera as chaves. O banco confere.</div>
      ${D.membros.filter((m) => !['admin', 'cliente'].includes(m.role)).map((m) => `<label class="check"><input type="checkbox" data-chg="mcPixAcesso" data-user="${m.user_id}" ${D.acessoPix.includes(m.user_id) ? 'checked' : ''}> ${esc(m.nome || m.email)} <span class="muted small">(${esc(m.role)})</span></label>`).join('') || '<div class="muted small">Nenhum outro membro na empresa.</div>'}</div>` : '';
  return `${tabela}${liberar}`;
}

/* ---------- ações ---------- */
const obraAtual = () => store.obra(idObraDaRota());
const dadosDe = (o) => D.porObra.get(o.id);
const contrato = (o, id) => dadosDe(o)?.contratos.find((x) => x.id === id);
const rpc = async (fn, args, onde) => ok(await (await sb()).rpc(fn, args), onde);

async function escolherResponsavel(k) {
  if (!D.membros.length) await carregarBase(true);
  const opcoes = D.membros.filter((m) => ['admin', 'engenheiro'].includes(m.role));
  if (!opcoes.length) throw new Error('Nenhum engenheiro ou administrador encontrado na empresa.');
  const v = await formDialog({ title: `Responsável por ${numeroContrato(k.number)}`, ok: 'Salvar', text: 'Só o engenheiro responsável lança medições, aditivos, glosas e pagamentos deste contrato.',
    fields: [{ name: 'u', label: 'Engenheiro responsável', type: 'select', value: k.responsible_id || opcoes[0].user_id, options: opcoes.map((m) => ({ value: m.user_id, label: `${m.nome || m.email} (${m.role})` })) }] });
  return v?.u || null;
}

export const acoesMedicao = {
  async mcAtualizar() { const o = obraAtual(); await Promise.all([carregarBase(true), carregarObras([o.id], true)]); },
  mcAbrir(d) { location.hash = noModulo(`#/obra/${obraAtual().id}/medicoes/contrato/${d.id}`); },
  mcImprimir() { window.print(); },
  async mcResponsavel(d) {
    const o = obraAtual(); const k = contrato(o, d.id);
    const u = await escolherResponsavel(k); if (!u || u === k.responsible_id) return;
    ok(await (await sb()).from('labor_contracts').update({ responsible_id: u }).eq('id', k.id), 'responsável');
    await carregarObras([o.id], true); toast('Responsável alterado.');
  },
  async mcForma(d) {
    const o = obraAtual(); const k = contrato(o, d.id);
    const v = await formDialog({ title: 'Forma de medição e retenção', ok: 'Salvar', text: 'Pode ser mudada até a primeira medição. Ao trocar, revise a planilha: por porcentagem usa o peso de cada etapa; por ambiente, quantidade e preço.',
      fields: [{ name: 'modo', label: 'Forma de medição', type: 'select', value: k.measure_mode, options: Object.entries(FORMAS_MEDICAO).map(([value, f]) => ({ value, label: `${f.rotulo} — ${f.texto}` })) },
        { name: 'ret', label: 'Retenção (%)', value: fmtIn(k.retention_pct, 2), hint: 'Padrão 5%. Devolvida com o último pagamento.' }] });
    if (!v) return;
    const ret = parseNum(v.ret);
    if (!(ret >= 0 && ret <= 30)) throw new Error('Retenção entre 0% e 30%.');
    ok(await (await sb()).from('labor_contracts').update({ measure_mode: v.modo, retention_pct: ret }).eq('id', k.id), 'forma de medição');
    await carregarObras([o.id], true); toast('Forma de medição salva.');
  },
  async mcItemNovo(d) {
    const o = obraAtual(); const k = contrato(o, d.id); const dd = dadosDe(o);
    const amb = k.measure_mode === 'ambiente';
    const its = vivos(dd.itens).filter((i) => i.contract_id === k.id);
    const ultimo = [...its].filter((i) => i.kind === 'servico').sort((a, b) => b.position - a.position)[0];
    const resta = r2(100 - its.filter((i) => i.kind === 'servico').reduce((s, i) => s + (Number(i.weight_pct) || 0), 0));
    const v = await formDialog({ title: amb ? 'Novo item (ambiente)' : 'Nova etapa', ok: 'Adicionar',
      fields: amb ? [{ name: 'grupo', label: 'Ambiente', value: ultimo?.group_name || '', placeholder: 'ex.: Banheiro social' },
        { name: 'desc', label: 'Serviço *', required: true, placeholder: 'ex.: Assentamento de piso' }, { name: 'un', label: 'Unidade', value: 'm²' },
        { name: 'qtd', label: 'Quantidade *', required: true }, { name: 'preco', label: 'Preço unitário (R$) *', required: true }]
        : [{ name: 'grupo', label: 'Fase', value: ultimo?.group_name || '', placeholder: 'ex.: Estrutura' },
          { name: 'desc', label: 'Etapa *', required: true, placeholder: 'ex.: Fundação' },
          { name: 'peso', label: 'Peso no contrato (%) *', required: true, value: resta > 0 ? fmtIn(resta, 4) : '', hint: `Os pesos das etapas somam 100% do contrato (falta ${fmtNum(Math.max(0, resta), 2)}%).` }] });
    if (!v) return;
    const dados = { contract_id: k.id, project_id: o.id, kind: 'servico', position: (Math.max(0, ...its.map((i) => i.position)) || 0) + 1, group_name: v.grupo.trim(), description: v.desc.trim() };
    if (amb) {
      const q = parseNum(v.qtd); const p = parseNum(v.preco);
      if (!(q > 0)) throw new Error('Quantidade inválida.'); if (!(p >= 0)) throw new Error('Preço inválido.');
      Object.assign(dados, { unit: v.un.trim(), quantity: q, unit_price: p });
    } else {
      const p = parseNum(v.peso); if (!(p > 0 && p <= 100)) throw new Error('Peso entre 0 e 100%.');
      dados.weight_pct = p;
    }
    ok(await (await sb()).from('labor_contract_items').insert(dados), 'planilha');
    await carregarObras([o.id], true);
  },
  async mcItemRemover(d) {
    const o = obraAtual(); const i = dadosDe(o).itens.find((x) => x.id === d.id);
    if (!(await ask(`Remover "${i.description}" da planilha?`, 'Remover'))) return;
    ok(await (await sb()).from('labor_contract_items').update({ deleted_at: new Date().toISOString() }).eq('id', i.id), 'planilha');
    await carregarObras([o.id], true);
  },
  async mcNovaMedicao(d) {
    const o = obraAtual(); const k = contrato(o, d.id);
    const conf = conferirPlanilha(k, dadosDe(o).itens);
    if (!conf.ok && !dadosDe(o).medicoes.some((m) => m.contract_id === k.id && m.status === 'fechada')) toast(`Atenção: ${conf.msg} A medição só fecha com a planilha conferida.`, 6000);
    ok(await (await sb()).from('labor_measurements').insert({ contract_id: k.id, project_id: o.id, measure_date: todayISO() }), 'medição');
    await carregarObras([o.id], true);
  },
  async mcFechar(d) {
    const o = obraAtual(); const dd = dadosDe(o); const m = dd.medicoes.find((x) => x.id === d.id); const k = contrato(o, m.contract_id);
    const v = valoresMedicao(k, dd.itens, dd.medicoes, dd.linhas, m);
    if (!(await ask(`Fechar ${numeroMedicao(m.number)} de ${isoBR(m.measure_date)}?\nValor do período: ${fmtBRL(v.bruto)}\nRetenção: ${fmtBRL(v.retencao)}\nLíquido: ${fmtBRL(v.liquido)}\n\nDepois de fechada, a planilha fica fixa e a medição só muda se for reaberta.`, 'Fechar medição'))) return;
    await rpc('medicao_mo_fechar', { p_id: m.id }, 'fechar medição');
    await carregarObras([o.id], true); toast(`${numeroMedicao(m.number)} fechada.`);
  },
  async mcDescartar(d) {
    const o = obraAtual(); const m = dadosDe(o).medicoes.find((x) => x.id === d.id);
    if (!(await ask(`Descartar a ${numeroMedicao(m.number)} em lançamento? (Fica registrado na auditoria.)`, 'Descartar'))) return;
    ok(await (await sb()).from('labor_measurements').update({ deleted_at: new Date().toISOString() }).eq('id', m.id), 'medição');
    await carregarObras([o.id], true);
  },
  async mcReabrir(d) {
    const o = obraAtual(); const m = dadosDe(o).medicoes.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Reabrir ${numeroMedicao(m.number)}`, ok: 'Reabrir', text: 'A medição volta a ficar em lançamento para correção. O motivo fica registrado.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    await rpc('medicao_mo_reabrir', { p_id: m.id, p_motivo: v.motivo }, 'reabrir medição');
    await carregarObras([o.id], true);
  },
  async mcAjuste(d) {
    const o = obraAtual(); const k = contrato(o, d.id); const glosa = d.tipo === 'glosa';
    const amb = k.measure_mode === 'ambiente' && !glosa;
    const v = await formDialog({ title: glosa ? `Glosa em ${numeroContrato(k.number)}` : `Aditivo em ${numeroContrato(k.number)}`, ok: 'Lançar',
      text: glosa ? 'Desconto no valor a pagar (ex.: serviço refeito, material danificado). Entra no Financeiro como aditivo negativo do contrato.'
        : 'Serviço a mais. Soma ao contrato, é medido como os outros itens e entra no Financeiro como aditivo do contrato.',
      fields: [{ name: 'data', label: 'Data', type: 'date', value: todayISO(), required: true },
        { name: 'grupo', label: amb ? 'Ambiente' : 'Fase / grupo', value: '' }, { name: 'desc', label: 'Descrição *', type: 'textarea', required: true },
        ...(amb ? [{ name: 'un', label: 'Unidade', value: 'm²' }, { name: 'qtd', label: 'Quantidade (opcional)', hint: 'Com quantidade e preço, o valor é qtd × preço e a medição é por quantidade.' }, { name: 'preco', label: 'Preço unitário (opcional)' }] : []),
        { name: 'valor', label: `Valor (R$)${amb ? ' — se não informar quantidade e preço' : ' *'}`, required: !amb }] });
    if (!v) return;
    const q = amb ? parseNum(v.qtd) : null; const p = amb ? parseNum(v.preco) : null;
    const valor = parseNum(v.valor);
    if (!(q > 0 && p >= 0) && !(valor > 0)) throw new Error('Informe o valor (ou quantidade e preço).');
    await rpc('medicao_mo_ajuste', { p_contract: k.id, p_kind: glosa ? 'glosa' : 'aditivo', p_group: v.grupo || '', p_description: v.desc, p_amount: valor,
      p_unit: amb ? v.un || '' : '', p_quantity: q > 0 && p >= 0 ? q : null, p_unit_price: q > 0 && p >= 0 ? p : null, p_date: v.data }, glosa ? 'glosa' : 'aditivo');
    await depois(o.id, { obras: true }); toast(glosa ? 'Glosa lançada.' : 'Aditivo lançado.');
  },
  async mcAjusteRemover(d) {
    const o = obraAtual(); const i = dadosDe(o).itens.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Remover ${i.kind}`, ok: 'Remover', text: `"${i.description}" (${fmtBRL(i.amount)}) sai do contrato e do Financeiro. Fica registrado com o motivo.`,
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    await rpc('medicao_mo_ajuste_remover', { p_item: i.id, p_motivo: v.motivo }, 'remover');
    await depois(o.id, { obras: true });
  },
  async mcPagar(d) {
    const o = obraAtual(); const k = contrato(o, d.id); const r = resumoDe(dadosDe(o), k);
    const v = await formDialog({ title: `Pagamento — ${numeroContrato(k.number)}`, ok: 'Registrar pagamento',
      text: `A pagar pelo medido: ${fmtBRL(Math.max(0, r.aPagar))}. O pagamento é independente da medição; se passar do executado, aparece como "pago além do executado". Vira despesa paga deste contrato no Financeiro.`,
      fields: [{ name: 'data', label: 'Data do pagamento', type: 'date', value: todayISO(), required: true },
        { name: 'valor', label: 'Valor (R$) *', value: r.aPagar > 0 ? fmtIn(r.aPagar, 2) : '', required: true },
        { name: 'forma', label: 'Forma', type: 'select', value: 'PIX', options: FORMAS_PG.map((x) => ({ value: x, label: x })) },
        { name: 'obs', label: 'Observação', value: '' }] });
    if (!v) return;
    const valor = parseNum(v.valor); if (!(valor > 0)) throw new Error('Valor inválido.');
    await rpc('medicao_mo_pagar', { p_contract: k.id, p_date: v.data, p_amount: valor, p_kind: 'pagamento', p_method: v.forma, p_notes: v.obs || '' }, 'pagamento');
    await depois(o.id, { obras: true }); toast('Pagamento registrado (e lançado no Financeiro).');
  },
  async mcDevolver(d) {
    const o = obraAtual(); const k = contrato(o, d.id); const r = resumoDe(dadosDe(o), k);
    const v = await formDialog({ title: `Devolver a retenção — ${numeroContrato(k.number)}`, ok: 'Devolver',
      text: `Retenção guardada: ${fmtBRL(r.retencaoADevolver)}. É devolvida com o último pagamento: o banco só aceita com o contrato 100% medido ou concluído.`,
      fields: [{ name: 'data', label: 'Data', type: 'date', value: todayISO(), required: true }, { name: 'valor', label: 'Valor (R$)', value: fmtIn(r.retencaoADevolver, 2), required: true },
        { name: 'forma', label: 'Forma', type: 'select', value: 'PIX', options: FORMAS_PG.map((x) => ({ value: x, label: x })) }] });
    if (!v) return;
    await rpc('medicao_mo_pagar', { p_contract: k.id, p_date: v.data, p_amount: parseNum(v.valor), p_kind: 'retencao', p_method: v.forma, p_notes: '' }, 'retenção');
    await depois(o.id, { obras: true }); toast('Retenção devolvida.');
  },
  async mcEstornar(d) {
    const o = obraAtual(); const p = dadosDe(o).pagamentos.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Estornar pagamento ${p.number}`, ok: 'Estornar', text: `${fmtBRL(p.amount)} de ${isoBR(p.pay_date)} sai dos totais e do Financeiro (a despesa é desativada, não apagada).`,
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    await rpc('medicao_mo_estornar', { p_payment: p.id, p_motivo: v.motivo }, 'estorno');
    await depois(o.id, { obras: true });
  },
};

export const mudancasMedicao = {
  async mcItem(d, el) {
    const o = obraAtual();
    const texto = ['description', 'group_name', 'unit'].includes(d.k);
    const valor = texto ? el.value.trim() : parseNum(el.value);
    if (d.k === 'description' && !valor) { toast('Informe a descrição.'); return queueRender(); }
    if (!texto && valor != null && !(valor >= 0)) { toast('Número inválido.'); return queueRender(); }
    ok(await (await sb()).from('labor_contract_items').update({ [d.k]: valor }).eq('id', d.id), 'planilha');
    await carregarObras([o.id], true);
  },
  async mcLinha(d, el) {
    const o = obraAtual(); const c = await sb();
    const v = parseNum(el.value);
    if (v == null) { ok(await c.from('labor_measurement_lines').delete().eq('measurement_id', d.m).eq('item_id', d.item), 'medição'); return carregarObras([o.id], true); }
    if (!(v >= 0) || (d.tipo === 'pct' && v > 100)) { toast(d.tipo === 'pct' ? 'Informe um % entre 0 e 100.' : 'Quantidade inválida.'); return queueRender(); }
    const linha = { measurement_id: d.m, project_id: o.id, item_id: d.item, pct_acum: d.tipo === 'pct' ? v : null, qty_acum: d.tipo === 'qty' ? v : null };
    const ja = dadosDe(o).linhas.find((l) => l.measurement_id === d.m && l.item_id === d.item);
    if (ja) ok(await c.from('labor_measurement_lines').update({ pct_acum: linha.pct_acum, qty_acum: linha.qty_acum }).eq('id', ja.id), 'medição');
    else ok(await c.from('labor_measurement_lines').insert(linha), 'medição');
    await carregarObras([o.id], true);
  },
  async mcData(d, el) {
    const o = obraAtual(); if (!el.value) return queueRender();
    ok(await (await sb()).from('labor_measurements').update({ measure_date: el.value }).eq('id', d.id), 'medição');
    await carregarObras([o.id], true);
  },
  async mcNotas(d, el) {
    const o = obraAtual();
    ok(await (await sb()).from('labor_measurements').update({ notes: el.value.trim() }).eq('id', d.id), 'medição');
    await carregarObras([o.id], true); toast('Observações salvas.');
  },
  mcSemana(d, el) { ui.mcSemana = el.value || proximaSexta(todayISO()); queueRender(); },
  mcArea(d, el) {
    const o = store.obra(d.id); const v = parseNum(el.value);
    if (v != null && !(v > 0)) { toast('Área inválida.'); return queueRender(); }
    o.areaConstruida = v; commit(o);
  },
  async mcPix(d, el) {
    const c = await sb(); const atual = D.pix.get(d.id);
    const dados = { [d.k]: el.value.trim() };
    if (atual) ok(await c.from('worker_bank_info').update(dados).eq('worker_id', d.id), 'PIX');
    else ok(await c.from('worker_bank_info').insert({ worker_id: d.id, org_id: ctx().orgId, ...dados }), 'PIX');
    await carregarBase(true); toast('PIX salvo.');
  },
  async mcPixAcesso(d, el) {
    const c = await sb(); const org = ctx().orgId;
    if (el.checked) ok(await c.from('org_pix_access').insert({ org_id: org, user_id: d.user }), 'acesso ao PIX');
    else ok(await c.from('org_pix_access').delete().eq('org_id', org).eq('user_id', d.user), 'acesso ao PIX');
    await carregarBase(true); toast(el.checked ? 'Acesso ao PIX liberado.' : 'Acesso ao PIX retirado.');
  },
};
