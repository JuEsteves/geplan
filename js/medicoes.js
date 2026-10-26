// Medições por atividade e profissional (modo nuvem): boletins de medição (atividades da EAP, executado no período,
// produção de cada profissional), conferência e aprovação, valores pelo vínculo de remuneração, lançamento no
// Financeiro, cadastro de profissionais (sem dados bancários) e resumos por profissional, atividade e fase.
// Regras e permissões conferidas pelo banco (migração 0009). O supervisor vê só quantidades — o banco não envia a ele
// vínculos nem valores. O avanço físico continua na aba Medições de cada obra; o boletim aprovado grava lá também.
import * as store from './store.js';
import { esc, I, ui, toast, ask, info, formDialog, queueRender, parseNum, fmtIn } from './ui.js';
import { fmtBRL, isoBR, todayISO, fmtNum } from './schedule.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { invalidarALancar } from './nuvem/aLancar.js';
import { pode, liberado } from './permissoes.js';
import { obraEmFoco, ir } from './escopo.js';
import { calcular } from './calculo.js';
import { quantidadePlanejada, medicoesDe, idsDaFase } from './execucao.js';
import { docValido, formatarDoc, tipoDoc, soDigitos, emailValido, normalizar } from './validacao.js';
import { carregarFornecedores, fornecedoresAtivos } from './fornecedores.js';
import {
  FORMAS, MEDIDAS, STATUS_BOLETIM, numeroBoletim, vinculoVigente, valorLinha, conferirProducao, previaAcumulado,
  situacaoPagamento, linhasResumo, somarPor,
} from './medicoesRegras.js';

const vazio = () => ({ carregado: false, carregando: false, erro: '', em: 0, profissionais: [], vinculos: [], boletins: [], itens: [], linhas: [], pagamentos: [], eventos: new Map() });
const M = vazio();
const ctx = () => nuvem.contexto();
const papel = () => ctx()?.papel;
const disponivel = () => nuvemConfigurada() && nuvem.ativo() && papel() && papel() !== 'cliente';
const veValores = () => ['admin', 'engenheiro', 'financeiro'].includes(papel());
const podeMedir = () => pode('execucao');
const podeAprovar = () => liberado('aprovar_medicao');
const podeCadastrar = () => ['admin', 'engenheiro', 'supervisor', 'financeiro'].includes(papel());
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const qtd = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 }));
const obraNome = (id) => store.obra(id)?.nome || 'obra';
const ativ = (pid, id) => (store.obra(pid)?.eap || []).find((a) => a.id === id);
const raiz = (pid, id) => { let a = ativ(pid, id); while (a?.parentId) a = ativ(pid, a.parentId); return a; };
const prof = (id) => M.profissionais.find((w) => w.id === id);
const badge = (st) => `<span class="badge ${STATUS_BOLETIM[st]?.cls || ''}">${esc(STATUS_BOLETIM[st]?.rotulo || st)}</span>`;
const itensDe = (sid) => M.itens.filter((i) => i.sheet_id === sid).sort((a, b) => a.position - b.position);
const linhasDe = (iid) => M.linhas.filter((l) => l.item_id === iid);
const pagDe = (lid) => M.pagamentos.find((p) => p.worker_line_id === lid) || null;
const despesa = (pid, id) => (store.obra(pid)?.despesas || []).find((d) => d.id === id) || null;

/* ---------- dados ---------- */
export async function carregarMedicoes(forcar = false) {
  if (!disponivel() || M.carregando || (M.carregado && !forcar)) return;
  M.carregando = true; M.erro = '';
  try {
    const c = await sb(); const org = ctx().orgId;
    const ids = store.obras().map((o) => o.id);
    const nada = { data: [] };
    const [ws, ags, bs, its, ls, ps] = await Promise.all([
      c.from('workers').select('*').eq('org_id', org).is('deleted_at', null).order('name'),
      veValores() && ids.length ? c.from('worker_agreements').select('*').in('project_id', ids).is('deleted_at', null).order('valid_from') : nada,
      ids.length ? c.from('measurement_sheets').select('*').in('project_id', ids).is('deleted_at', null).order('period_start', { ascending: false }) : nada,
      ids.length ? c.from('measurement_items').select('*').in('project_id', ids).order('position') : nada,
      ids.length ? c.from('measurement_workers').select('*').in('project_id', ids).order('created_at') : nada,
      veValores() && ids.length ? c.from('measurement_pay').select('*').in('project_id', ids) : nada,
    ]);
    Object.assign(M, { profissionais: ok(ws, 'profissionais') || [], vinculos: ok(ags, 'vínculos') || [], boletins: ok(bs, 'boletins') || [],
      itens: ok(its, 'itens') || [], linhas: ok(ls, 'produção') || [], pagamentos: ok(ps, 'valores') || [], carregado: true, em: Date.now() });
  } catch (e) { M.erro = e.message; }
  M.carregando = false;
  queueRender();
}
async function carregarEventos(sid) {
  const c = await sb();
  M.eventos.set(sid, ok(await c.from('measurement_events').select('*').eq('sheet_id', sid).order('id', { ascending: false }), 'histórico') || []);
  queueRender();
}
export function limparMedicoes() { Object.assign(M, vazio()); }
async function depois(sid, { obras = false } = {}) {
  invalidarALancar();
  if (obras) { await nuvem.enviar().catch(() => {}); if (!nuvem.pendente()) await nuvem.baixar().catch(() => {}); }
  await carregarMedicoes(true);
  if (sid) await carregarEventos(sid).catch(() => {});
}

/* ---------- telas ---------- */
const ABAS = [['boletins', 'Boletins de medição'], ['resumo', 'Resumo por profissional'], ['atividades', 'Por atividade e fase'], ['profissionais', 'Profissionais']];
function indisponivel() {
  return `<div class="page-head"><div><h1>Medições</h1></div></div><div class="card empty"><p>${!nuvemConfigurada()
    ? 'Boletins por atividade e por profissional funcionam no modo nuvem. No modo local, use a aba Medições de cada obra (avanço físico).'
    : papel() === 'cliente' ? 'Seu perfil não tem acesso às medições.' : 'Carregando os dados da empresa…'}</p>
    <a class="btn" href="#/modulo/medicoes">Avanço físico por obra</a></div>`;
}

export function viewMedicoes(route) {
  if (!disponivel()) return indisponivel();
  if (!M.carregando && (!M.carregado || Date.now() - M.em > 60000)) setTimeout(() => carregarMedicoes(true));
  if (!M.carregado) return `<div class="page-head"><div><h1>Medições</h1></div></div><div class="card empty"><p>${M.erro ? esc(M.erro) : 'Carregando…'}</p></div>`;
  if (route.secao === 'boletim') return viewBoletim(route.id);
  if (route.secao === 'profissional') return viewProfissional(route.id);
  const aba = ABAS.some(([k]) => k === route.secao) ? route.secao : 'boletins';
  const corpo = { boletins: viewBoletins, resumo: viewResumo, atividades: viewAtividades, profissionais: viewProfissionais }[aba]();
  const foco = obraEmFoco();
  return `<div class="page-head"><div><h1>Medições</h1><div class="muted">Medição por atividade e por profissional: avanço físico e produção para pagamento, relacionados mas separados.</div></div>
    <div class="row">${aba === 'boletins' && podeMedir() ? `<button class="btn primary" data-act="medNovoBoletim">${I.plus} Novo boletim</button>` : ''}
    ${aba === 'profissionais' && podeCadastrar() ? `<button class="btn primary" data-act="medNovoProf">${I.plus} Novo profissional</button>` : ''}
    ${foco ? '' : '<a class="btn" href="#/modulo/medicoes">Avanço físico por obra</a>'}</div></div>
  ${navMedicoes(aba)}
  <div class="stack" style="margin-top:12px">${M.erro ? `<div class="alert err">${esc(M.erro)}</div>` : ''}${corpo}
  ${!veValores() ? '<div class="muted small">Seu perfil vê as quantidades medidas. Valores de mão de obra ficam com administrador, engenheiro e financeiro.</div>' : ''}</div>`;
}

/** Abas das medições. Dentro da obra, inclui o avanço físico da própria obra (aba "avanco"). */
export function navMedicoes(aba) {
  const foco = obraEmFoco();
  const abas = foco ? [['avanco', 'Avanço físico'], ...ABAS] : ABAS;
  return `<nav class="row abas-sup">${abas.map(([k, r]) => `<a class="btn sm ${k === aba ? 'primary' : ''}" href="${foco ? `#/obra/${foco}/medicoes/${k}` : `#/medicoes/${k}`}" ${k === aba ? 'aria-current="page"' : ''}>${r}</a>`).join('')}</nav>`;
}

// Dentro da página da obra, os filtros são da própria obra (a obra fica fixa); no menu geral, de todas as obras.
const filtro = () => {
  const foco = obraEmFoco();
  const novo = () => ({ obra: foco, status: '', profissional: '', atividade: '', fase: '', de: '', ate: '' });
  if (!foco) return ui.medF ||= novo();
  const m = ui.medFObra ||= {};
  return m[foco] ||= novo();
};
const selObra = (f) => obraEmFoco() ? '' : `<label class="field">Obra<select data-chg="medFiltro" data-k="obra"><option value="">Todas</option>${store.obras().map((o) => `<option value="${o.id}" ${o.id === f.obra ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select></label>`;
const fasesDe = (o) => (o?.eap || []).filter((a) => a.nivel <= 2 && (o.eap || []).some((x) => x.parentId === a.id));

function viewBoletins() {
  const f = filtro();
  const lista = M.boletins.filter((b) => (!f.obra || b.project_id === f.obra) && (!f.status || b.status === f.status));
  return `<div class="grid-form">${selObra(f)}<label class="field">Situação<select data-chg="medFiltro" data-k="status"><option value="">Todas</option>${Object.entries(STATUS_BOLETIM).map(([k, v]) => `<option value="${k}" ${k === f.status ? 'selected' : ''}>${v.rotulo}</option>`).join('')}</select></label></div>
  ${lista.length ? `<div class="card table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Boletim</th><th>Obra</th><th>Fase</th><th>Período</th><th>Situação</th><th class="num">Atividades</th><th class="num">Profissionais</th>${veValores() ? '<th class="num">Valor aprovado</th>' : ''}</tr></thead><tbody>
    ${lista.map((b) => { const its = itensDe(b.id); const ls = M.linhas.filter((l) => l.sheet_id === b.id); const val = M.pagamentos.filter((p) => p.sheet_id === b.id).reduce((a, p) => a + (Number(p.amount) || 0), 0);
      return `<tr data-act="medAbrir" data-id="${b.id}" tabindex="0"><td class="nowrap"><b>${numeroBoletim(b.number)}</b></td><td class="small">${esc(obraNome(b.project_id))}</td><td class="small">${esc(ativ(b.project_id, b.phase_id)?.descricao || '—')}</td>
        <td class="nowrap small">${isoBR(b.period_start)} a ${isoBR(b.period_end)}</td><td>${badge(b.status)}</td><td class="num">${its.length}</td><td class="num">${new Set(ls.map((l) => l.worker_id)).size}</td>
        ${veValores() ? `<td class="num nowrap">${b.status === 'aprovado' ? fmtBRL(val) : '—'}</td>` : ''}</tr>`; }).join('')}
  </tbody></table></div>` : `<div class="card empty"><p>Nenhum boletim de medição.</p>${podeMedir() ? `<button class="btn primary" data-act="medNovoBoletim">${I.plus} Criar o primeiro</button>` : ''}</div>`}`;
}

function viewBoletim(id) {
  const b = M.boletins.find((x) => x.id === id);
  if (!b) return '<div class="card empty"><p>Boletim não encontrado.</p><a class="btn" href="#/medicoes">Voltar</a></div>';
  if (!M.eventos.has(id)) { M.eventos.set(id, null); setTimeout(() => carregarEventos(id).catch(() => {})); }
  const o = store.obra(b.project_id);
  const editavel = podeMedir() && ['rascunho', 'devolvido'].includes(b.status);
  const conferindo = podeAprovar() && b.status === 'conferencia';
  const its = itensDe(b.id);
  const totalValor = M.pagamentos.filter((p) => p.sheet_id === b.id).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const aLancar = M.pagamentos.filter((p) => p.sheet_id === b.id && !p.expense_id && Number(p.amount) > 0).length;
  const ev = M.eventos.get(id);
  return `<div class="page-head"><div><a class="muted small" href="#/medicoes/boletins">← Boletins</a><h1>${numeroBoletim(b.number)} — ${esc(obraNome(b.project_id))} ${badge(b.status)}</h1>
      <div class="muted small">Período ${isoBR(b.period_start)} a ${isoBR(b.period_end)}${b.phase_id ? ` · Fase: ${esc(ativ(b.project_id, b.phase_id)?.descricao || '')}` : ''} · criado por ${esc(b.created_label || '—')}${b.submitted_label ? ` · enviado por ${esc(b.submitted_label)}` : ''}${b.approved_label ? ` · aprovado por ${esc(b.approved_label)} em ${new Date(b.approved_at).toLocaleString('pt-BR')}` : ''}</div></div>
    <div class="row" style="gap:6px;flex-wrap:wrap">
      ${editavel ? `<button class="btn" data-act="medAddItem" data-id="${b.id}">${I.plus} Atividade</button><button class="btn primary" data-act="medEnviar" data-id="${b.id}">Enviar para conferência</button>` : ''}
      ${editavel && b.status === 'rascunho' ? `<button class="btn danger" data-act="medExcluir" data-id="${b.id}">Excluir rascunho</button>` : ''}
      ${conferindo ? `<button class="btn primary" data-act="medAprovar" data-id="${b.id}">Aprovar</button><button class="btn" data-act="medDevolver" data-id="${b.id}">Devolver</button>` : ''}
      ${b.status === 'aprovado' && pode('financeiro') && aLancar ? `<button class="btn primary" data-act="medLancar" data-id="${b.id}">Lançar no Financeiro</button>` : ''}</div></div>
  <div class="stack">
    ${b.review_note ? `<div class="alert err small">Devolvido para correção: ${esc(b.review_note)}</div>` : ''}
    ${conferindo ? '<div class="alert info small">Conferência: ajuste a <b>quantidade aprovada</b> de cada profissional, se necessário, e aprove. A produzida (informada por quem mediu) fica registrada.</div>' : ''}
    ${!its.length ? `<div class="card empty"><p>Nenhuma atividade neste boletim.</p>${editavel ? `<button class="btn primary" data-act="medAddItem" data-id="${b.id}">${I.plus} Incluir atividade da EAP</button>` : ''}</div>`
      : its.map((it) => blocoItem(b, o, it, editavel, conferindo)).join('')}
    ${veValores() && b.status === 'aprovado' ? `<div class="card card-pad row between"><b>Valor aprovado no boletim</b><b>${fmtBRL(totalValor)}</b></div>` : ''}
    ${b.notes ? `<div class="card card-pad small">${esc(b.notes)}</div>` : ''}
    <div class="card card-pad stack"><h2>Histórico</h2>${ev == null ? '<div class="muted small">Carregando…</div>' : ev.length ? `<ul class="lista historico-sup">${ev.map((e) => `<li><div class="small"><b>${esc(e.author_label || '—')}</b> <span class="muted">${new Date(e.created_at).toLocaleString('pt-BR')}</span></div>${esc(e.body)}</li>`).join('')}</ul>` : '<div class="muted small">Sem registros.</div>'}</div>
    <div class="muted small">Executado no período = avanço físico da atividade. A produção de cada profissional (para pagamento) não pode passar do executado, em quantidade. Ao aprovar, o banco grava a medição de avanço (acumulado anterior + período) e congela os valores pelo vínculo vigente em ${isoBR(b.period_end)}.</div>
  </div>`;
}

function blocoItem(b, o, it, editavel, conferindo) {
  const a = ativ(b.project_id, it.activity_id); const f = raiz(b.project_id, it.activity_id);
  const ls = linhasDe(it.id);
  const prev = b.status === 'aprovado' ? null : previaAcumulado(medicoesDe(o, it.activity_id), it, b.period_start);
  const temQtd = Number(it.planned_qty) > 0;
  const anterior = b.status === 'aprovado' ? (temQtd ? it.previous_qty : it.previous_pct) : (temQtd ? prev.anterior : prev.anteriorPct);
  const acumulado = b.status === 'aprovado' ? (temQtd ? it.accum_qty : it.accum_pct) : (temQtd ? prev.acumulado : prev.pct);
  const conf = conferirProducao(it, ls, { aprovada: conferindo || b.status === 'aprovado' });
  const un = esc(it.unit || '');
  const campo = (k, v, w = 90) => (editavel ? `<input class="cell" data-chg="medItem" data-id="${it.id}" data-k="${k}" inputmode="decimal" value="${v == null ? '' : fmtIn(v, 4)}" style="width:${w}px">` : qtd(v));
  return `<div class="card card-pad stack">
    <div class="row between" style="gap:8px;flex-wrap:wrap"><div><b>${esc(a?.codigo || '')} ${esc(a?.descricao || 'atividade')}</b>${f && f.id !== a?.id ? `<div class="muted small">${esc(f.descricao)}</div>` : ''}</div>
      ${editavel ? `<button class="icon-btn danger" title="Tirar do boletim" data-act="medRemItem" data-id="${it.id}" data-b="${b.id}">${I.trash}</button>` : ''}</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Unidade</th><th class="num">Prevista</th><th class="num">Acumulado anterior</th><th class="num">Executado no período</th>${temQtd ? '' : '<th class="num">% no período</th>'}<th class="num">Novo acumulado</th><th class="num">Saldo</th><th>Critério</th></tr></thead><tbody><tr>
      <td>${un || '—'}</td><td class="num">${temQtd ? qtd(it.planned_qty) : 'sem quantidade prevista'}</td>
      <td class="num">${temQtd ? qtd(anterior) : `${fmtNum(anterior || 0, 1)}%`}</td>
      <td class="num">${campo('period_qty', it.period_qty)} ${un}</td>
      ${temQtd ? '' : `<td class="num">${campo('period_pct', it.period_pct, 70)} %</td>`}
      <td class="num"><b>${temQtd ? qtd(acumulado) : it.period_pct == null && b.status !== 'aprovado' ? '<span class="muted small">sem % informado</span>' : acumulado == null ? '—' : `${fmtNum(acumulado, 1)}%`}</b></td>
      <td class="num">${temQtd ? qtd(Math.max(0, Number(it.planned_qty) - (Number(acumulado) || 0))) : '—'}</td>
      <td class="small">${editavel ? `<input class="cell" data-chg="medItem" data-id="${it.id}" data-k="criterion" value="${esc(it.criterion || '')}" placeholder="ex.: m² de forma montada">` : esc(it.criterion || '')}</td></tr></tbody></table></div>
    <div class="row between small" style="flex-wrap:wrap;gap:6px"><b>Produção por profissional</b>
      <span class="${conf.ok ? 'muted' : 'badge crit'}">Em quantidade: ${qtd(conf.soma)} de ${qtd(conf.executado)} ${un}${conf.ok ? (conf.sobra > 0 ? ` (${qtd(conf.sobra)} sem produção individual)` : '') : ' — passa do executado'}</span></div>
    ${ls.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Profissional</th><th>Medida</th><th class="num">Produzida</th><th class="num">Aprovada</th>${veValores() ? '<th>Vínculo</th><th class="num">Valor</th><th>Pagamento</th>' : ''}<th>Obs.</th><th></th></tr></thead><tbody>
      ${ls.map((l) => {
        const w = prof(l.worker_id); const p = pagDe(l.id);
        const vin = veValores() ? (p ? M.vinculos.find((x) => x.id === p.agreement_id) : vinculoVigente(M.vinculos, l.worker_id, b.project_id, it.activity_id, b.period_end)) : null;
        const v = p ? { valor: p.amount == null ? null : Number(p.amount), tipo: p.pay_type } : valorLinha(vin, l.measure, l.approved_qty ?? l.produced_qty);
        const sit = p ? situacaoPagamento(v.valor, despesa(b.project_id, p.expense_id)) : null;
        return `<tr><td><a href="#/medicoes/profissional/${l.worker_id}">${esc(w?.name || '—')}</a></td><td class="small">${esc(MEDIDAS[l.measure])}</td>
          <td class="num">${editavel ? `<input class="cell" data-chg="medLinha" data-id="${l.id}" data-k="produced_qty" inputmode="decimal" value="${fmtIn(l.produced_qty, 4)}" style="width:80px">` : qtd(l.produced_qty)}</td>
          <td class="num">${conferindo ? `<input class="cell" data-chg="medLinha" data-id="${l.id}" data-k="approved_qty" inputmode="decimal" value="${l.approved_qty == null ? fmtIn(l.produced_qty, 4) : fmtIn(l.approved_qty, 4)}" style="width:80px">` : qtd(l.approved_qty)}</td>
          ${veValores() ? `<td class="small">${vin ? `${esc(FORMAS[vin.pay_type]?.rotulo || vin.pay_type)}${vin.unit_price != null ? ` · ${fmtBRL(vin.unit_price)}${vin.unit ? `/${esc(vin.unit)}` : ''}` : ''}${vin.contract_amount != null ? ` · ${fmtBRL(vin.contract_amount)}` : ''}` : '<span class="badge warn">sem vínculo vigente</span>'}</td>
            <td class="num nowrap">${v.erro ? `<span class="badge crit" title="${esc(v.erro)}">medida incompatível</span>` : v.valor == null ? '—' : `${fmtBRL(v.valor)}${p ? '' : ' <span class="muted small">(prévia)</span>'}`}</td>
            <td class="small">${sit ? `<span class="badge ${sit.cls}">${sit.rotulo}</span>` : '—'}</td>` : ''}
          <td class="small">${esc(l.notes || '')}</td><td>${editavel ? `<button class="icon-btn danger" data-act="medRemLinha" data-id="${l.id}" data-b="${b.id}" title="Remover">${I.trash}</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="muted small">Nenhuma produção individual registrada (o executado pode ser de equipe sem pagamento por produção).</div>'}
    ${editavel ? `<div><button class="btn sm" data-act="medAddLinha" data-id="${it.id}" data-b="${b.id}">${I.plus} Profissional</button></div>` : ''}
  </div>`;
}

function viewResumo() {
  const f = filtro();
  const o = f.obra ? store.obra(f.obra) : null;
  const lista = linhasResumo({ boletins: M.boletins, itens: M.itens, linhas: M.linhas, pagamentos: M.pagamentos,
    filtros: { obra: f.obra, profissional: f.profissional, fases: f.fase && o ? idsDaFase(o, f.fase) : null, de: f.de, ate: f.ate } });
  const tot = somarPor(lista, (x) => x.l.worker_id);
  return `<div class="grid-form">${selObra(f)}
      <label class="field">Fase<select data-chg="medFiltro" data-k="fase"><option value="">${o ? 'Todas' : 'Escolha a obra'}</option>${fasesDe(o).map((a) => `<option value="${a.id}" ${a.id === f.fase ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}</select></label>
      <label class="field">Profissional<select data-chg="medFiltro" data-k="profissional"><option value="">Todos</option>${M.profissionais.map((w) => `<option value="${w.id}" ${w.id === f.profissional ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>
      <label class="field">De<input type="date" data-chg="medFiltro" data-k="de" value="${esc(f.de)}"></label><label class="field">Até<input type="date" data-chg="medFiltro" data-k="ate" value="${esc(f.ate)}"></label></div>
    ${tot.size ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Profissional</th><th class="num">Linhas</th><th class="num">Produzida</th><th class="num">Aprovada</th>${veValores() ? '<th class="num">Valor aprovado</th><th class="num">Pago</th><th class="num">Saldo a pagar</th>' : ''}</tr></thead><tbody>
      ${[...tot.entries()].map(([wid, t]) => {
        const pago = veValores() ? lista.filter((x) => x.l.worker_id === wid && x.p?.expense_id).reduce((a, x) => { const d = despesa(x.b.project_id, x.p.expense_id); const pg = d ? (d.pagamentos || []).reduce((s, p) => s + (Number(p.valor) || 0), 0) : 0; const share = d && Number(d.valor) ? Math.min(1, pg / Number(d.valor)) : 0; return a + Number(x.p.amount || 0) * share; }, 0) : 0;
        return `<tr><td><a href="#/medicoes/profissional/${wid}">${esc(prof(wid)?.name || '—')}</a></td><td class="num">${t.n}</td><td class="num">${qtd(t.produzida)}</td><td class="num">${qtd(t.aprovada)}</td>
          ${veValores() ? `<td class="num nowrap">${t.temValor ? fmtBRL(t.valor) : '—'}</td><td class="num nowrap">${fmtBRL(pago)}</td><td class="num nowrap"><b>${fmtBRL(Math.max(0, t.valor - pago))}</b></td>` : ''}</tr>`;
      }).join('')}</tbody></table></div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Boletim</th><th>Obra · atividade</th><th>Profissional</th><th>Medida</th><th class="num">Produzida</th><th class="num">Aprovada</th>${veValores() ? '<th class="num">Valor unit.</th><th class="num">Valor</th><th>Pagamento</th>' : ''}<th>Situação</th></tr></thead><tbody>
      ${lista.map(({ l, i, b, p }) => { const a = ativ(b.project_id, i.activity_id); const sit = p ? situacaoPagamento(p.amount == null ? null : Number(p.amount), despesa(b.project_id, p.expense_id)) : null;
        return `<tr><td class="nowrap"><a href="#/medicoes/boletim/${b.id}">${numeroBoletim(b.number)}</a><div class="muted small">${isoBR(b.period_end)}</div></td><td class="small">${esc(obraNome(b.project_id))}<div>${esc(a?.codigo || '')} ${esc(a?.descricao || '')}</div></td>
          <td class="small">${esc(prof(l.worker_id)?.name || '')}</td><td class="small">${esc(MEDIDAS[l.measure])}</td><td class="num">${qtd(l.produced_qty)}</td><td class="num">${qtd(l.approved_qty)}</td>
          ${veValores() ? `<td class="num nowrap">${p?.unit_price != null ? fmtBRL(p.unit_price) : '—'}</td><td class="num nowrap">${p?.amount != null ? fmtBRL(p.amount) : '—'}</td><td class="small">${sit ? `<span class="badge ${sit.cls}">${sit.rotulo}</span>` : '—'}</td>` : ''}
          <td>${badge(b.status)}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="card empty"><p>Nenhuma produção com esses filtros.</p></div>'}
    <div class="muted small">Aprovada = conferida e aprovada no boletim. Valor = congelado na aprovação pelo vínculo vigente. Pago = proporcional aos pagamentos da despesa lançada no Financeiro (aprovação e pagamento são separados).</div>`;
}

function viewAtividades() {
  const f = filtro();
  const o = f.obra ? store.obra(f.obra) : store.obras()[0];
  if (!o) return '<div class="card empty"><p>Nenhuma obra.</p></div>';
  const daFase = f.fase ? idsDaFase(o, f.fase) : null;
  const its = M.itens.filter((i) => i.project_id === o.id && (!daFase || daFase.has(i.activity_id)));
  const B = new Map(M.boletins.map((b) => [b.id, b]));
  const porAtiv = new Map();
  for (const i of its) {
    const b = B.get(i.sheet_id); if (!b) continue;
    const t = porAtiv.get(i.activity_id) || { exec: 0, execAprov: 0, unid: i.unit, prevista: i.planned_qty, valor: 0, temValor: false, prof: new Map() };
    t.exec += Number(i.period_qty) || 0; if (b.status === 'aprovado') t.execAprov += Number(i.period_qty) || 0;
    for (const l of linhasDe(i.id)) {
      const p = pagDe(l.id);
      const pp = t.prof.get(l.worker_id) || { q: 0, v: 0 };
      pp.q += Number(l.approved_qty ?? l.produced_qty) || 0;
      if (p?.amount != null) { pp.v += Number(p.amount); t.valor += Number(p.amount); t.temValor = true; }
      t.prof.set(l.worker_id, pp);
    }
    porAtiv.set(i.activity_id, t);
  }
  return `<div class="grid-form">${obraEmFoco() ? '' : `<label class="field">Obra<select data-chg="medFiltro" data-k="obra">${store.obras().map((x) => `<option value="${x.id}" ${x.id === o.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>`}
      <label class="field">Fase<select data-chg="medFiltro" data-k="fase"><option value="">Todas</option>${fasesDe(o).map((a) => `<option value="${a.id}" ${a.id === f.fase ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}</select></label></div>
    ${porAtiv.size ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Atividade</th><th class="num">Prevista</th><th class="num">Executado (boletins)</th><th class="num">Aprovado</th><th class="num">Avanço físico</th><th>Por profissional</th>${veValores() ? '<th class="num">Valor aprovado</th>' : ''}</tr></thead><tbody>
      ${[...porAtiv.entries()].map(([aid, t]) => { const a = ativ(o.id, aid);
        return `<tr><td><b>${esc(a?.codigo || '')}</b> ${esc(a?.descricao || '')}<div class="muted small">${esc(raiz(o.id, aid)?.descricao || '')}</div></td><td class="num">${t.prevista ? `${qtd(t.prevista)} ${esc(t.unid)}` : '—'}</td>
          <td class="num">${qtd(t.exec)} ${esc(t.unid)}</td><td class="num">${qtd(t.execAprov)} ${esc(t.unid)}</td><td class="num">${fmtNum(Number(a?.pct) || 0, 1)}%</td>
          <td class="small">${[...t.prof.entries()].map(([w, pp]) => `${esc(prof(w)?.name || '')}: ${qtd(pp.q)}${veValores() && pp.v ? ` (${fmtBRL(pp.v)})` : ''}`).join('<br>') || '—'}</td>
          ${veValores() ? `<td class="num nowrap">${t.temValor ? fmtBRL(t.valor) : '—'}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>`
      : '<div class="card empty"><p>Nenhuma atividade medida em boletins nesta seleção.</p></div>'}
    <div class="muted small">Avanço físico = % da atividade (medições aprovadas). Executado = soma dos períodos nos boletins. Valores por profissional não somam ao avanço físico: são critérios separados.</div>`;
}

function viewProfissionais() {
  const t = normalizar((ui.medProfBusca || '').trim());
  const lista = M.profissionais.filter((w) => !t || normalizar(`${w.name} ${w.specialties} ${w.doc_number}`).includes(t));
  return `<div class="row"><input data-inp="medProfBusca" data-key="medProfBusca" value="${esc(ui.medProfBusca || '')}" placeholder="Buscar por nome, especialidade ou CPF/CNPJ…" style="flex:1;min-width:200px"></div>
    ${lista.length ? `<div class="card table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Profissional</th><th>Tipo</th><th>Especialidades</th><th>Contato</th><th class="num">Medições</th><th>Situação</th></tr></thead><tbody>
      ${lista.map((w) => `<tr data-act="medAbrirProf" data-id="${w.id}" tabindex="0"><td><b>${esc(w.name)}</b>${w.doc_number ? `<div class="muted small">${tipoDoc(w.doc_number)} ${formatarDoc(w.doc_number)}</div>` : ''}</td><td class="small">${{ pessoa: 'Pessoa', empresa: 'Empresa', equipe: 'Equipe' }[w.kind]}</td>
        <td class="small">${esc(w.specialties || '')}</td><td class="small">${esc(w.phone || w.email || '')}</td><td class="num">${M.linhas.filter((l) => l.worker_id === w.id).length}</td>
        <td><span class="badge ${w.status === 'ativo' ? 'good' : ''}">${w.status === 'ativo' ? 'Ativo' : 'Inativo'}</span></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty"><p>Nenhum profissional cadastrado.</p>${podeCadastrar() ? `<button class="btn primary" data-act="medNovoProf">${I.plus} Cadastrar</button>` : ''}</div>`}
    <div class="muted small">Cadastro central da empresa. Nenhum dado bancário é guardado: o pagamento é feito pelo Financeiro.</div>`;
}

function viewProfissional(id) {
  const w = prof(id);
  if (!w) return '<div class="card empty"><p>Profissional não encontrado.</p><a class="btn" href="#/medicoes/profissionais">Voltar</a></div>';
  const vincs = M.vinculos.filter((a) => a.worker_id === w.id);
  const lista = linhasResumo({ boletins: M.boletins, itens: M.itens, linhas: M.linhas, pagamentos: M.pagamentos, filtros: { profissional: w.id } });
  const t = somarPor(lista, () => 'x').get('x') || { produzida: 0, aprovada: 0, valor: 0, temValor: false };
  const forn = w.supplier_id ? fornecedoresAtivos().find((s) => s.id === w.supplier_id) : null;
  return `<div class="page-head"><div><a class="muted small" href="#/medicoes/profissionais">← Profissionais</a><h1>${esc(w.name)} <span class="badge ${w.status === 'ativo' ? 'good' : ''}">${w.status === 'ativo' ? 'Ativo' : 'Inativo'}</span></h1>
      <div class="muted small">${{ pessoa: 'Pessoa', empresa: 'Empresa', equipe: 'Equipe' }[w.kind]}${w.doc_number ? ` · ${tipoDoc(w.doc_number)} ${formatarDoc(w.doc_number)}` : ''}${w.specialties ? ` · ${esc(w.specialties)}` : ''}${forn ? ` · fornecedor: <a href="#/fornecedores/${forn.id}">${esc(forn.trade_name)}</a>` : ''}</div></div>
    ${podeCadastrar() ? `<div class="row"><button class="btn" data-act="medEditarProf" data-id="${w.id}">Editar</button><button class="btn" data-act="medStatusProf" data-id="${w.id}">${w.status === 'ativo' ? 'Inativar' : 'Reativar'}</button></div>` : ''}</div>
  <div class="stack">
    <div class="kpis"><div class="card kpi"><div class="k-label">Linhas de produção</div><div class="k-value">${lista.length}</div></div>
      <div class="card kpi"><div class="k-label">Aprovada</div><div class="k-value" style="font-size:20px">${qtd(t.aprovada)}</div><div class="k-sub">somatório nas unidades de cada atividade</div></div>
      ${veValores() ? `<div class="card kpi"><div class="k-label">Valor aprovado</div><div class="k-value" style="font-size:20px">${t.temValor ? fmtBRL(t.valor) : '—'}</div></div>` : ''}</div>
    ${veValores() ? `<div class="card card-pad stack"><div class="row between"><h2>Vínculos de remuneração</h2><button class="btn sm" data-act="medNovoVinculo" data-id="${w.id}">${I.plus} Vínculo</button></div>
      ${vincs.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Obra</th><th>Forma</th><th class="num">Valor</th><th>Atividades</th><th>Vigência</th><th></th></tr></thead><tbody>
        ${vincs.map((a) => `<tr><td class="small">${esc(obraNome(a.project_id))}${a.role_name ? `<div class="muted">${esc(a.role_name)}</div>` : ''}</td><td class="small">${esc(FORMAS[a.pay_type]?.rotulo)}</td>
          <td class="num nowrap">${a.unit_price != null ? `${fmtBRL(a.unit_price)}${a.unit ? `/${esc(a.unit)}` : ''}` : a.contract_amount != null ? fmtBRL(a.contract_amount) : '—'}</td>
          <td class="small">${(a.activity_ids || []).length ? a.activity_ids.map((x) => esc(ativ(a.project_id, x)?.codigo || '?')).join(', ') : 'todas'}</td>
          <td class="small nowrap">${isoBR(a.valid_from)} a ${a.valid_to ? isoBR(a.valid_to) : 'sem fim'}</td>
          <td>${!a.valid_to ? `<button class="btn sm" data-act="medEncerrarVinculo" data-id="${a.id}">Encerrar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted small">Nenhum vínculo. Sem vínculo, a produção é registrada mas não tem valor automático.</div>'}
      <div class="muted small">Para mudar o valor: encerre o vínculo (data final) e crie outro. Medições já aprovadas mantêm o valor da época.</div></div>` : ''}
    <div class="card card-pad stack"><h2>Histórico de produção</h2>${lista.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Boletim</th><th>Obra · atividade</th><th>Medida</th><th class="num">Produzida</th><th class="num">Aprovada</th>${veValores() ? '<th class="num">Valor</th><th>Pagamento</th>' : ''}</tr></thead><tbody>
      ${lista.map(({ l, i, b, p }) => { const a = ativ(b.project_id, i.activity_id); const sit = p ? situacaoPagamento(p.amount == null ? null : Number(p.amount), despesa(b.project_id, p.expense_id)) : null;
        return `<tr><td class="nowrap"><a href="#/medicoes/boletim/${b.id}">${numeroBoletim(b.number)}</a> ${badge(b.status)}<div class="muted small">${isoBR(b.period_start)} a ${isoBR(b.period_end)}</div></td><td class="small">${esc(obraNome(b.project_id))}<div>${esc(a?.codigo || '')} ${esc(a?.descricao || '')}</div></td>
          <td class="small">${esc(MEDIDAS[l.measure])}</td><td class="num">${qtd(l.produced_qty)} ${l.measure === 'qtd' ? esc(i.unit || '') : ''}</td><td class="num">${qtd(l.approved_qty)}</td>
          ${veValores() ? `<td class="num nowrap">${p?.amount != null ? fmtBRL(p.amount) : '—'}</td><td class="small">${sit ? `<span class="badge ${sit.cls}">${sit.rotulo}</span>` : '—'}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>` : '<div class="muted small">Nenhuma produção registrada.</div>'}</div>
    ${w.notes ? `<div class="card card-pad small">${esc(w.notes)}</div>` : ''}
  </div>`;
}

/* ---------- formulários ---------- */
async function formProfissional(w = null) {
  await carregarFornecedores().catch(() => {});
  const v = await formDialog({ title: w ? `Editar ${w.name}` : 'Novo profissional', ok: 'Salvar', text: 'Sem dados bancários: o pagamento é feito pelo Financeiro.', fields: [
    { name: 'name', label: 'Nome *', required: true, value: w?.name || '' },
    { name: 'kind', label: 'Tipo', type: 'select', value: w?.kind || 'pessoa', options: [{ value: 'pessoa', label: 'Pessoa' }, { value: 'empresa', label: 'Empresa prestadora' }, { value: 'equipe', label: 'Equipe' }] },
    { name: 'doc', label: 'CPF ou CNPJ (opcional)', value: w?.doc_number ? formatarDoc(w.doc_number) : '' },
    { name: 'specialties', label: 'Especialidades / funções', value: w?.specialties || '', placeholder: 'ex.: pedreiro, armador' },
    { name: 'phone', label: 'Telefone', value: w?.phone || '' }, { name: 'email', label: 'E-mail', value: w?.email || '' },
    { name: 'supplier', label: 'Fornecedor cadastrado (se for empresa)', type: 'select', value: w?.supplier_id || '', options: [{ value: '', label: '—' }, ...fornecedoresAtivos().map((s) => ({ value: s.id, label: s.trade_name }))] },
    { name: 'notes', label: 'Observações', type: 'textarea', value: w?.notes || '' },
  ] });
  if (!v) return null;
  const doc = soDigitos(v.doc);
  if (doc && (![11, 14].includes(doc.length) || !docValido(doc))) throw new Error('CPF/CNPJ inválido: confira os dígitos.');
  if (!emailValido(v.email.trim())) throw new Error('E-mail inválido.');
  const linha = { name: v.name.trim(), kind: v.kind, doc_number: doc, specialties: v.specialties.trim(), phone: v.phone.trim(), email: v.email.trim(), supplier_id: v.supplier || null, notes: v.notes.trim() };
  const c = await sb();
  const r = w ? await c.from('workers').update(linha).eq('id', w.id).select().single() : await c.from('workers').insert({ ...linha, org_id: ctx().orgId }).select().single();
  if (r.error && /duplicate|unique/i.test(r.error.message)) throw new Error('Já existe profissional com este CPF/CNPJ.');
  const salvo = ok(r, 'profissional');
  await carregarMedicoes(true);
  toast(w ? 'Profissional atualizado.' : 'Profissional cadastrado.');
  return salvo;
}

async function formVinculo(w) {
  const obras = store.obras();
  const v = await formDialog({ title: `Vínculo de remuneração — ${w.name}`, ok: 'Salvar', fields: [
    { name: 'obra', label: 'Obra *', type: 'select', value: obras[0]?.id, options: obras.map((o) => ({ value: o.id, label: o.nome })) },
    { name: 'tipo', label: 'Forma de remuneração', type: 'select', value: 'unidade', options: Object.entries(FORMAS).map(([value, f]) => ({ value, label: f.rotulo })) },
    { name: 'funcao', label: 'Função neste vínculo', placeholder: 'ex.: pedreiro' },
    { name: 'unidade', label: 'Unidade (por unidade: m², m³, m…)', placeholder: 'm²' },
    { name: 'preco', label: 'Valor unitário / diária / hora (R$)' },
    { name: 'contrato', label: 'Valor contratado do serviço (R$) — para valor fixo' },
    { name: 'atividades', label: 'Códigos das atividades da EAP abrangidas (vazio = todas)', placeholder: 'ex.: 4.1.1, 4.1.2' },
    { name: 'de', label: 'Vigência — início *', type: 'date', required: true, value: todayISO() },
    { name: 'ate', label: 'Vigência — fim (opcional)', type: 'date' },
    { name: 'cond', label: 'Condições específicas / critério', type: 'textarea' },
  ] });
  if (!v) return;
  const o = store.obra(v.obra);
  const codigos = v.atividades.split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean);
  const ids = codigos.map((cod) => (o.eap || []).find((a) => a.codigo === cod)?.id);
  if (ids.some((x) => !x)) throw new Error(`Código não encontrado na EAP de ${o.nome}: ${codigos.filter((_, i) => !ids[i]).join(', ')}`);
  const preco = v.preco.trim() ? parseNum(v.preco) : null, contrato = v.contrato.trim() ? parseNum(v.contrato) : null;
  if (v.tipo === 'unidade' && (preco == null || !v.unidade.trim())) throw new Error('Por unidade: informe a unidade e o valor unitário.');
  if (['diaria', 'hora'].includes(v.tipo) && preco == null) throw new Error('Informe o valor da diária/hora.');
  if (v.tipo === 'empreitada' && contrato == null) throw new Error('Valor fixo: informe o valor contratado do serviço.');
  const c = await sb();
  ok(await c.from('worker_agreements').insert({ org_id: ctx().orgId, worker_id: w.id, project_id: o.id, pay_type: v.tipo, role_name: v.funcao.trim(), unit: v.unidade.trim(),
    unit_price: preco, contract_amount: contrato, activity_ids: ids, valid_from: v.de, valid_to: v.ate || null, conditions: v.cond.trim() }), 'vínculo');
  await carregarMedicoes(true);
  toast('Vínculo cadastrado.');
}

async function formBoletim() {
  const obras = store.obras();
  let ultima = ''; try { ultima = localStorage.getItem('planobras:ultimaObra') || ''; } catch {}
  const v = await formDialog({ title: 'Novo boletim de medição', ok: 'Criar', fields: [
    { name: 'obra', label: 'Obra *', type: 'select', value: obraEmFoco() || (obras.some((o) => o.id === ultima) ? ultima : obras[0]?.id), options: obras.map((o) => ({ value: o.id, label: o.nome })) },
    { name: 'de', label: 'Período — início *', type: 'date', required: true },
    { name: 'ate', label: 'Período — fim *', type: 'date', required: true, value: todayISO() },
    { name: 'notes', label: 'Observações', type: 'textarea' },
  ] });
  if (!v) return null;
  if (v.ate < v.de) throw new Error('O fim do período é antes do início.');
  const c = await sb();
  await nuvem.enviar().catch(() => {});
  const b = ok(await c.from('measurement_sheets').insert({ project_id: v.obra, period_start: v.de, period_end: v.ate, notes: v.notes.trim() }).select().single(), 'boletim');
  await carregarMedicoes(true);
  toast(`${numeroBoletim(b.number)} criado.`);
  return b;
}

async function formItem(b) {
  const o = store.obra(b.project_id);
  const calc = calcular(o, store.lib());
  const ja = new Set(itensDe(b.id).map((i) => i.activity_id));
  const folhas = (o.eap || []).filter((a) => !(o.eap || []).some((x) => x.parentId === a.id) && !ja.has(a.id));
  const v = await formDialog({ title: `Incluir atividade — ${numeroBoletim(b.number)}`, ok: 'Incluir',
    text: 'Atividades com quantidade prevista no orçamento usam a unidade dela. Sem quantidade prevista, informe a unidade e o executado (para a produção) e o % executado (para o avanço físico).', fields: [
    { name: 'a', label: 'Atividade da EAP *', type: 'select', value: folhas[0]?.id, options: folhas.map((a) => {
      const p = quantidadePlanejada(calc, a.id); return { value: a.id, label: `${a.codigo} ${a.descricao}${p ? ` — prevista ${fmtNum(p.qtd, 2)} ${p.unidade}` : ''}` }; }) },
    { name: 'q', label: 'Executado no período (quantidade)' },
    { name: 'un', label: 'Unidade (só se a atividade não tiver quantidade prevista)', placeholder: 'ex.: m², m³, m, un' },
    { name: 'pct', label: '% executado no período (só se não houver quantidade prevista)' },
    { name: 'crit', label: 'Critério de medição', placeholder: 'ex.: m² de alvenaria assentada' },
  ] });
  if (!v || !v.a) return;
  const plan = quantidadePlanejada(calc, v.a);
  const n = v.q.trim() ? parseNum(v.q) : null;
  const pct = !plan && v.pct.trim() ? parseNum(v.pct) : null;
  if (n != null && !(n >= 0)) throw new Error('Quantidade inválida.');
  if (pct != null && !(pct >= 0 && pct <= 100)) throw new Error('O % executado vai de 0 a 100.');
  if (!plan && n != null && !v.un.trim()) throw new Error('Informe a unidade do executado.');
  const c = await sb();
  ok(await c.from('measurement_items').insert({ sheet_id: b.id, project_id: b.project_id, activity_id: v.a, position: itensDe(b.id).length,
    unit: plan?.unidade || v.un.trim(), planned_qty: plan ? plan.qtd : null, period_qty: n, period_pct: plan ? null : pct, criterion: v.crit.trim() }), 'atividade');
  await carregarMedicoes(true);
}

async function formLinha(b, it) {
  const ativos = M.profissionais.filter((w) => w.status === 'ativo');
  if (!ativos.length) throw new Error('Cadastre os profissionais primeiro (aba Profissionais).');
  const v = await formDialog({ title: 'Produção do profissional', ok: 'Incluir', fields: [
    { name: 'w', label: 'Profissional *', type: 'select', value: ativos[0].id, options: ativos.map((w) => ({ value: w.id, label: w.name })) },
    { name: 'm', label: 'Medida', type: 'select', value: 'qtd', options: Object.entries(MEDIDAS).map(([value, label]) => ({ value, label: value === 'qtd' ? `Quantidade (${it.unit || 'unid.'})` : label })) },
    { name: 'q', label: 'Produzida *', required: true },
    { name: 'obs', label: 'Observação' },
  ] });
  if (!v) return;
  const q = parseNum(v.q);
  if (!(q >= 0)) throw new Error('Informe a quantidade produzida.');
  const c = await sb();
  ok(await c.from('measurement_workers').insert({ item_id: it.id, sheet_id: b.id, project_id: b.project_id, worker_id: v.w, measure: v.m, produced_qty: q, notes: v.obs.trim() }), 'produção');
  await carregarMedicoes(true);
}

/* ---------- ações ---------- */
const boletim = (id) => M.boletins.find((b) => b.id === id);
export const acoesMedicoes = {
  async medNovoBoletim() { const b = await formBoletim(); if (b) ir(`#/medicoes/boletim/${b.id}`); },
  medAbrir(d) { ir(`#/medicoes/boletim/${d.id}`); },
  async medExcluir(d) {
    if (!(await ask('Excluir este boletim em rascunho? (Fica registrado na auditoria.)', 'Excluir'))) return;
    ok(await (await sb()).from('measurement_sheets').update({ deleted_at: new Date().toISOString() }).eq('id', d.id), 'boletim');
    await carregarMedicoes(true); ir('#/medicoes/boletins');
  },
  async medAddItem(d) { await formItem(boletim(d.id)); },
  async medRemItem(d) {
    if (!(await ask('Tirar esta atividade (e a produção dos profissionais nela) do boletim?', 'Tirar'))) return;
    ok(await (await sb()).from('measurement_items').delete().eq('id', d.id), 'atividade');
    await carregarMedicoes(true);
  },
  async medAddLinha(d) { const b = boletim(d.b); await formLinha(b, M.itens.find((i) => i.id === d.id)); },
  async medRemLinha(d) {
    ok(await (await sb()).from('measurement_workers').delete().eq('id', d.id), 'produção');
    await carregarMedicoes(true);
  },
  async medEnviar(d) {
    const b = boletim(d.id);
    for (const it of itensDe(b.id)) { const c = conferirProducao(it, linhasDe(it.id)); if (!c.ok) throw new Error(`A produção passa do executado em ${ativ(b.project_id, it.activity_id)?.descricao || 'uma atividade'}.`); }
    ok(await (await sb()).rpc('medicao_acao', { p_sheet: b.id, p_acao: 'enviar', p_comment: '' }), 'boletim');
    await depois(b.id); toast('Boletim enviado para conferência.');
  },
  async medAprovar(d) {
    const b = boletim(d.id);
    if (!(await ask(`Aprovar ${numeroBoletim(b.number)}? O avanço físico das atividades e os valores dos profissionais serão gravados e não mudam depois.`, 'Aprovar'))) return;
    ok(await (await sb()).rpc('medicao_acao', { p_sheet: b.id, p_acao: 'aprovar', p_comment: '' }), 'boletim');
    await depois(b.id, { obras: true }); toast('Boletim aprovado.');
  },
  async medDevolver(d) {
    const v = await formDialog({ title: 'Devolver para correção', ok: 'Devolver', fields: [{ name: 'c', label: 'O que precisa ser corrigido (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('medicao_acao', { p_sheet: d.id, p_acao: 'devolver', p_comment: v.c }), 'boletim');
    await depois(d.id); toast('Boletim devolvido.');
  },
  async medLancar(d) {
    const v = await formDialog({ title: 'Lançar no Financeiro', ok: 'Lançar', text: 'Cria uma despesa de mão de obra por profissional com valor aprovado ainda não lançado. O pagamento é registrado depois, no Financeiro.', fields: [{ name: 'venc', label: 'Vencimento (opcional)', type: 'date' }] });
    if (!v) return;
    const n = ok(await (await sb()).rpc('medicao_lancar_despesas', { p_sheet: d.id, p_due: v.venc || null }), 'Financeiro');
    await depois(d.id, { obras: true }); toast(`${n} despesa(s) lançada(s) no Financeiro.`);
  },
  async medNovoProf() { const w = await formProfissional(); if (w) ir(`#/medicoes/profissional/${w.id}`); },
  medAbrirProf(d) { ir(`#/medicoes/profissional/${d.id}`); },
  async medEditarProf(d) { await formProfissional(prof(d.id)); },
  async medStatusProf(d) {
    const w = prof(d.id);
    ok(await (await sb()).from('workers').update({ status: w.status === 'ativo' ? 'inativo' : 'ativo' }).eq('id', w.id), 'profissional');
    await carregarMedicoes(true);
  },
  async medNovoVinculo(d) { await formVinculo(prof(d.id)); },
  async medEncerrarVinculo(d) {
    const v = await formDialog({ title: 'Encerrar vínculo', ok: 'Encerrar', text: 'Depois de encerrado, crie um vínculo novo com o valor atualizado. Boletins aprovados não mudam.', fields: [{ name: 'ate', label: 'Último dia de vigência', type: 'date', required: true, value: todayISO() }] });
    if (!v) return;
    ok(await (await sb()).from('worker_agreements').update({ valid_to: v.ate }).eq('id', d.id), 'vínculo');
    await carregarMedicoes(true);
  },
};
export const mudancasMedicoes = {
  medFiltro(d, el) { filtro()[d.k] = el.value; if (d.k === 'obra') filtro().fase = ''; queueRender(); },
  async medItem(d, el) {
    const v = d.k === 'criterion' ? el.value.trim() : (el.value.trim() === '' ? null : parseNum(el.value));
    if (d.k !== 'criterion' && v != null && !(v >= 0)) { toast('Quantidade inválida.'); return carregarMedicoes(true); }
    const r = await (await sb()).from('measurement_items').update({ [d.k]: v }).eq('id', d.id);
    if (r.error) { toast(erroBanco(r.error).message, 7000); }
    await carregarMedicoes(true);
  },
  async medLinha(d, el) {
    const v = parseNum(el.value);
    if (!(v >= 0)) { toast('Quantidade inválida.'); return carregarMedicoes(true); }
    const r = await (await sb()).from('measurement_workers').update({ [d.k]: v }).eq('id', d.id);
    if (r.error) toast(erroBanco(r.error).message, 7000);
    await carregarMedicoes(true);
  },
};
export const entradasMedicoes = { medProfBusca(el) { ui.medProfBusca = el.value; queueRender(); } };
