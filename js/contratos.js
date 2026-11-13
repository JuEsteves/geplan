// Contratos de mão de obra (empreiteiros e prestadores) — aba "Contratos" da obra (modo nuvem). Lista com o que foi
// lançado e o saldo, "quando contratar" (fases do cronograma que começam logo e ainda não têm contrato), formulário,
// parcelas, ativação, lançamento de parcela no Financeiro, encerramento e o arquivo do contrato assinado.
// Regras e permissões no banco (migração 0015); cálculos da tela em js/contratosRegras.js.
import * as store from './store.js';
import { esc, I, ui, toast, ask, info, formDialog, queueRender, parseNum, fmtIn } from './ui.js';
import { fmtBRL, fmtBR, isoBR, todayISO, todayDay, fmtNum } from './schedule.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { pode, liberado } from './permissoes.js';
import { enviarArquivo, urlTemporaria, ACCEPT } from './nuvem/arquivos.js';
import { FORMAS_PAGAMENTO, STATUS_CONTRATO, numeroContrato, gerarParcelas, resumoContrato, fasesSemContrato } from './contratosRegras.js';

const K = { porObra: new Map(), profissionais: [], carregadoProf: false };
const ctx = () => nuvem.contexto();
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const veValores = () => ['admin', 'engenheiro', 'financeiro'].includes(ctx()?.papel);
const podeContratar = () => veValores() && liberado('comprar');
const podeLancar = () => veValores() && pode('financeiro');
const badge = (st) => `<span class="badge ${STATUS_CONTRATO[st]?.cls || ''}">${esc(STATUS_CONTRATO[st]?.rotulo || st)}</span>`;
const prof = (id) => K.profissionais.find((w) => w.id === id);
const dadosObra = (pid) => K.porObra.get(pid);

async function carregar(pid, forcar = false) {
  const d = K.porObra.get(pid);
  if (d && (d.carregando || (!forcar && Date.now() - d.em < 60000))) return;
  K.porObra.set(pid, { ...(d || { contratos: [], parcelas: [] }), carregando: true });
  try {
    const c = await sb();
    const [ks, ps, ws] = await Promise.all([
      c.from('labor_contracts').select('*').eq('project_id', pid).is('deleted_at', null).order('number'),
      c.from('labor_contract_installments').select('*').eq('project_id', pid).order('number'),
      c.from('workers').select('id, name, kind, specialties, status, phone').eq('org_id', ctx().orgId).is('deleted_at', null).order('name'),
    ]);
    K.profissionais = ok(ws, 'profissionais') || [];
    K.porObra.set(pid, { contratos: ok(ks, 'contratos') || [], parcelas: ok(ps, 'parcelas') || [], carregando: false, em: Date.now(), erro: '' });
  } catch (e) { K.porObra.set(pid, { contratos: [], parcelas: [], carregando: false, em: Date.now(), erro: e.message }); }
  queueRender();
}
export function limparContratos() { K.porObra.clear(); K.profissionais = []; }

/** Depois de uma ação que muda o Financeiro no banco: envia o que estiver pendente, baixa as obras e recarrega. */
async function depois(pid, { obras = false } = {}) {
  if (obras) { await nuvem.enviar().catch(() => {}); if (!nuvem.pendente()) await nuvem.baixar().catch(() => {}); }
  await carregar(pid, true);
}

/* ---------- telas ---------- */
/** Aba Contratos da obra. `c` = contexto da obra (cronograma); `resto` = [id do contrato]. */
export function viewContratos(c, resto = []) {
  const { o } = c;
  if (!nuvemConfigurada() || !nuvem.ativo()) return '<div class="card empty"><p>Contratos de mão de obra funcionam no modo nuvem (banco de dados da empresa).</p></div>';
  if (!veValores()) return '<div class="card empty"><p>Seu perfil não vê contratos e valores de mão de obra.</p></div>';
  const d = dadosObra(o.id);
  if (!d || (!d.carregando && Date.now() - (d.em || 0) > 60000)) setTimeout(() => carregar(o.id));
  if (!d || (d.carregando && !d.em)) return '<div class="card empty"><p>Carregando…</p></div>';
  if (d.erro) return `<div class="alert err">${esc(d.erro)}</div>`;
  if (resto[0]) return viewContrato(c, d, resto[0]);
  return viewLista(c, d);
}

function fasesComDatas(c) {
  return (c.o.eap || []).filter((a) => !a.parentId).map((a) => {
    const n = c.cron.nos.get(a.id);
    return { id: a.id, codigo: a.codigo, descricao: a.descricao, inicio: n?.inicio ?? null, termino: n?.termino ?? null };
  });
}

function viewLista(c, d) {
  const { o } = c;
  const fases = fasesComDatas(c);
  const nomeFase = (id) => { const f = fases.find((x) => x.id === id); return f ? `${f.codigo} ${f.descricao}` : '—'; };
  const sem = fasesSemContrato(fases, d.contratos, todayDay(), 60);
  const totais = d.contratos.filter((k) => k.status !== 'rascunho').reduce((t, k) => { const r = resumoContrato(k, o.despesas); t.valor += Number(k.amount) || 0; t.lancado += r.lancado; return t; }, { valor: 0, lancado: 0 });
  return `<div class="page-head"><div><h1>Contratos de mão de obra</h1><div class="muted">Empreiteiros e prestadores desta obra: escopo (fases da EAP), valor, forma de pagamento e prazo. O contrato vigente entra no Financeiro como compromisso; parcelas e medições lançadas abatem dele.</div></div>
    <div class="row">${podeContratar() ? `<button class="btn primary" data-act="ctrNovo">${I.plus} Novo contrato</button>` : ''}<button class="btn" data-act="ctrAtualizar">Atualizar</button></div></div>
  <div class="stack">
    ${sem.length ? `<div class="card card-pad stack"><h2 style="margin:0">Quando contratar</h2>
      <div class="muted small">Fases do cronograma que começam nos próximos 60 dias (ou já começaram) e ainda não estão em nenhum contrato.</div>
      <ul class="lista">${sem.map((f) => `<li class="row between" style="gap:8px"><span><b>${esc(f.codigo)} ${esc(f.descricao)}</b> <span class="muted small">— ${f.diasAte > 0 ? `começa em ${fmtBR(f.inicio)} (daqui a ${f.diasAte} dia${f.diasAte > 1 ? 's' : ''})` : f.diasAte === 0 ? 'começa hoje' : `começou em ${fmtBR(f.inicio)}`}</span></span>
        ${podeContratar() ? `<button class="btn sm" data-act="ctrNovo" data-fase="${f.id}">Contratar</button>` : ''}</li>`).join('')}</ul></div>` : ''}
    ${d.contratos.length ? `<div class="kpis kpis-5">
        <div class="card kpi"><div class="k-label">Contratos vigentes</div><div class="k-value">${d.contratos.filter((k) => k.status === 'vigente').length}</div><div class="k-sub">${d.contratos.filter((k) => k.status === 'rascunho').length} em rascunho</div></div>
        <div class="card kpi"><div class="k-label">Valor contratado</div><div class="k-value">${fmtBRL(totais.valor)}</div></div>
        <div class="card kpi"><div class="k-label">Lançado no Financeiro</div><div class="k-value">${fmtBRL(totais.lancado)}</div></div>
        <div class="card kpi"><div class="k-label">Saldo a lançar</div><div class="k-value">${fmtBRL(Math.max(0, totais.valor - totais.lancado))}</div></div></div>
      <div class="card table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Contrato</th><th>Profissional</th><th>Escopo</th><th>Pagamento</th><th>Prazo</th><th class="num">Valor</th><th class="num">Lançado</th><th>Situação</th></tr></thead><tbody>
        ${d.contratos.map((k) => { const r = resumoContrato(k, o.despesas); const w = prof(k.worker_id);
          return `<tr data-act="ctrAbrir" data-id="${k.id}" tabindex="0"><td class="nowrap"><b>${numeroContrato(k.number)}</b><div class="small">${esc(k.title)}</div></td>
            <td class="small">${esc(w?.name || '—')}${w?.specialties ? `<div class="muted">${esc(w.specialties)}</div>` : ''}</td>
            <td class="small">${(k.phase_ids || []).map(nomeFase).map(esc).join('<br>') || '<span class="muted">obra toda</span>'}</td>
            <td class="small">${esc(FORMAS_PAGAMENTO[k.payment_mode] || k.payment_mode)}</td>
            <td class="small nowrap">${k.start_date ? isoBR(k.start_date) : '—'}${k.end_date ? ` a ${isoBR(k.end_date)}` : ''}</td>
            <td class="num nowrap">${k.amount == null ? '—' : fmtBRL(k.amount)}</td><td class="num nowrap">${k.status === 'rascunho' ? '—' : `${fmtBRL(r.lancado)}${r.pct != null ? `<div class="muted small">${fmtNum(r.pct, 0)}%</div>` : ''}`}</td>
            <td>${badge(k.status)}</td></tr>`; }).join('')}
      </tbody></table></div>`
    : `<div class="card empty"><p>Nenhum contrato de mão de obra nesta obra.</p>${podeContratar() ? `<button class="btn primary" data-act="ctrNovo">${I.plus} Criar o primeiro</button>` : ''}</div>`}
    <div class="muted small">Profissionais vêm do cadastro de Medições › Profissionais. Contrato por medição é pago pelos boletins (% do serviço); mensal e em parcelas, pelas parcelas lançadas no Financeiro.</div>
  </div>`;
}

function viewContrato(c, d, id) {
  const { o } = c;
  const k = d.contratos.find((x) => x.id === id);
  const voltar = `<a class="muted small" href="#/obra/${o.id}/contratos">← Contratos</a>`;
  if (!k) return `${voltar}<div class="card empty"><p>Contrato não encontrado.</p></div>`;
  const w = prof(k.worker_id);
  const r = resumoContrato(k, o.despesas);
  const ps = d.parcelas.filter((p) => p.contract_id === k.id).sort((a, b) => a.number - b.number);
  const desp = new Map((o.despesas || []).map((x) => [x.id, x]));
  const rascunho = k.status === 'rascunho';
  const fases = fasesComDatas(c);
  const medicoes = (o.despesas || []).filter((x) => k.contract_id && x.compromissoId === k.contract_id && /^MED-/.test(x.documento || ''));
  const campo = (rot, v) => `<div><span class="muted small">${rot}</span><div>${v || '—'}</div></div>`;
  return `${voltar}
  <div class="page-head" style="margin-top:4px"><div><h1>${numeroContrato(k.number)} — ${esc(k.title)} ${badge(k.status)}</h1>
      <div class="muted small">${esc(w?.name || '—')}${w?.specialties ? ` · ${esc(w.specialties)}` : ''} · criado por ${esc(k.created_label || '—')}</div></div>
    <div class="row" style="gap:6px;flex-wrap:wrap">
      ${rascunho && podeContratar() ? `<button class="btn" data-act="ctrEditar" data-id="${k.id}">Editar</button><button class="btn primary" data-act="ctrAtivar" data-id="${k.id}">Ativar contrato</button><button class="btn danger" data-act="ctrExcluir" data-id="${k.id}">Excluir rascunho</button>` : ''}
      ${k.status === 'vigente' && podeContratar() ? `<button class="btn" data-act="ctrEncerrar" data-id="${k.id}">Encerrar</button>` : ''}</div></div>
  <div class="stack">
    ${rascunho ? '<div class="alert info small">Rascunho: confira os dados e as parcelas e clique em <b>Ativar contrato</b>. Ao ativar, o valor entra no Financeiro como compromisso (Contrato · Mão de obra) e, se for por medição, o profissional passa a poder ser medido nos boletins com este valor.</div>' : ''}
    ${k.close_reason ? `<div class="alert ${k.status === 'rescindido' ? 'err' : 'info'} small">${esc(STATUS_CONTRATO[k.status].rotulo)}: ${esc(k.close_reason)}</div>` : ''}
    <div class="card card-pad"><div class="ficha-campos">
      ${campo('Valor', k.amount == null ? '' : fmtBRL(k.amount))}${campo('Forma de pagamento', esc(FORMAS_PAGAMENTO[k.payment_mode]))}
      ${campo('Prazo', `${k.start_date ? isoBR(k.start_date) : '—'}${k.end_date ? ` a ${isoBR(k.end_date)}` : ''}`)}
      ${campo('Fases (escopo)', (k.phase_ids || []).map((pid) => { const f = fases.find((x) => x.id === pid); return f ? esc(`${f.codigo} ${f.descricao}`) : ''; }).join('<br>') || 'obra toda')}
      ${k.status !== 'rascunho' ? `${campo('Lançado no Financeiro', `${fmtBRL(r.lancado)}${r.pct != null ? ` (${fmtNum(r.pct, 0)}%)` : ''}`)}${campo('Pago', fmtBRL(r.pago))}${campo('Saldo a lançar', r.saldo == null ? '' : fmtBRL(r.saldo))}` : ''}
    </div>${k.scope ? `<div style="margin-top:10px"><span class="muted small">Escopo detalhado</span><div class="pre-wrap">${esc(k.scope)}</div></div>` : ''}</div>
    ${['mensal', 'parcelas'].includes(k.payment_mode) ? `<div class="card card-pad stack"><div class="row between"><h2 style="margin:0">Parcelas</h2>${rascunho && podeContratar() ? `<button class="btn sm" data-act="ctrGerarParcelas" data-id="${k.id}">Gerar parcelas</button>` : ''}</div>
      ${ps.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Nº</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
        ${ps.map((p) => { const e = p.expense_id ? desp.get(p.expense_id) : null; const pago = e ? (e.pagamentos || []).reduce((s, x) => s + (Number(x.valor) || 0), 0) : 0;
          return `<tr><td>${p.number}</td>
            <td>${rascunho && podeContratar() ? `<input type="date" class="cell" data-chg="ctrParcela" data-id="${p.id}" data-k="due_date" value="${esc(p.due_date)}">` : isoBR(p.due_date)}</td>
            <td class="num">${rascunho && podeContratar() ? `<input class="cell" inputmode="decimal" data-chg="ctrParcela" data-id="${p.id}" data-k="amount" value="${fmtIn(p.amount, 2)}" style="width:110px">` : fmtBRL(p.amount)}</td>
            <td class="small">${!p.expense_id ? (k.status === 'vigente' && p.due_date < todayISO() ? '<span class="badge warn">vencida, não lançada</span>' : 'a lançar') : pago >= Number(p.amount) - 0.005 ? '<span class="badge good">paga</span>' : '<span class="badge info">lançada no Financeiro</span>'}</td>
            <td>${k.status === 'vigente' && !p.expense_id && podeLancar() ? `<button class="btn sm primary" data-act="ctrLancar" data-id="${p.id}" data-k="${k.id}">Lançar no Financeiro</button>` : ''}</td></tr>`; }).join('')}
        </tbody><tfoot><tr><th colspan="2">Total</th><th class="num nowrap">${fmtBRL(ps.reduce((s, p) => s + Number(p.amount), 0))}</th><th colspan="2">${Math.abs(ps.reduce((s, p) => s + Number(p.amount), 0) - Number(k.amount || 0)) > 0.01 ? '<span class="badge crit">diferente do valor do contrato</span>' : ''}</th></tr></tfoot></table></div>`
        : '<div class="muted small">Sem parcelas ainda. Use "Gerar parcelas" (valor dividido igualmente, uma por mês) e ajuste datas e valores se precisar.</div>'}</div>` : ''}
    ${k.payment_mode === 'medicao' ? `<div class="card card-pad stack"><h2 style="margin:0">Medições</h2>
      <div class="muted small">Pago pelos boletins de medição: em cada boletim, informe o % do serviço executado por ${esc(w?.name || 'este profissional')}; o valor é o % × ${k.amount == null ? 'valor do contrato' : fmtBRL(k.amount)}. ${k.status === 'vigente' ? `<a href="#/obra/${o.id}/medicoes">Abrir Medições</a>` : 'Disponível depois de ativar.'}</div>
      ${medicoes.length ? `<ul class="lista">${medicoes.map((x) => `<li class="row between"><span class="small">${esc(x.documento)} — ${esc(x.descricao || '')}</span><b class="nowrap">${fmtBRL(x.valor)}</b></li>`).join('')}</ul>` : '<div class="muted small">Nenhuma medição lançada ainda.</div>'}</div>` : ''}
    <div class="card card-pad stack"><h2 style="margin:0">Contrato assinado</h2>
      ${k.file_path ? `<div class="row" style="gap:8px"><button class="btn sm" data-act="ctrArquivoAbrir" data-id="${k.id}">${esc(k.file_name || 'Abrir contrato')}</button></div>` : '<div class="muted small">Nenhum arquivo anexado.</div>'}
      ${podeContratar() ? `<div><label class="btn sm">${I.upload} ${k.file_path ? 'Trocar arquivo' : 'Anexar contrato (PDF ou Word)'}<input type="file" accept="${ACCEPT}" data-chg="ctrArquivo" data-id="${k.id}" hidden></label></div>` : ''}
      <div class="muted small">Fica na pasta privada da empresa; só quem vê valores de mão de obra abre.</div></div>
    ${k.notes || podeContratar() ? `<div class="card card-pad stack"><h2 style="margin:0">Observações</h2>${podeContratar() ? `<textarea rows="2" data-chg="ctrNotas" data-id="${k.id}">${esc(k.notes)}</textarea>` : `<div class="pre-wrap">${esc(k.notes)}</div>`}</div>` : ''}
  </div>`;
}

/* ---------- formulário ---------- */
async function formulario(o, k = null, faseInicial = '') {
  if (!K.profissionais.length) await carregar(o.id, true);
  const ativos = K.profissionais.filter((w) => w.status === 'ativo' || w.id === k?.worker_id);
  if (!ativos.length) return info('Cadastre o profissional', '<p>O contrato é com um profissional, empresa ou equipe do cadastro. Cadastre em <b>Medições › Profissionais</b> e volte aqui.</p>');
  const raizes = (o.eap || []).filter((a) => !a.parentId);
  const marcadas = new Set(k ? k.phase_ids || [] : faseInicial ? [faseInicial] : []);
  const v = await formDialog({ title: k ? `Editar ${numeroContrato(k.number)}` : 'Novo contrato de mão de obra', ok: k ? 'Salvar' : 'Criar rascunho',
    text: 'O contrato nasce como rascunho; ao ativar, entra no Financeiro.',
    fields: [
      { name: 'worker', label: 'Profissional / empresa / equipe *', type: 'select', value: k?.worker_id || ativos[0].id, options: ativos.map((w) => ({ value: w.id, label: `${w.name}${w.specialties ? ` — ${w.specialties}` : ''}` })) },
      { name: 'title', label: 'Objeto do contrato *', value: k?.title || '', required: true, placeholder: 'ex.: Execução da obra (empreitada global), Instalações elétricas' },
      { name: 'scope', label: 'Escopo detalhado', type: 'textarea', value: k?.scope || '' },
      { name: 'amount', label: 'Valor total (R$)', value: k?.amount == null ? '' : fmtIn(k.amount, 2), hint: 'Obrigatório, exceto no pagamento avulso.' },
      { name: 'mode', label: 'Forma de pagamento', type: 'select', value: k?.payment_mode || 'medicao', options: Object.entries(FORMAS_PAGAMENTO).map(([value, label]) => ({ value, label })) },
      { name: 'start', label: 'Início', type: 'date', value: k?.start_date || '' },
      { name: 'end', label: 'Término previsto', type: 'date', value: k?.end_date || '' },
      { name: 'notes', label: 'Observações', type: 'textarea', value: k?.notes || '' },
      ...raizes.map((a) => ({ name: `f_${a.id}`, label: `Fase ${a.codigo} ${a.descricao}`, type: 'checkbox', value: marcadas.has(a.id) })),
    ] });
  if (!v) return null;
  const valor = v.amount.trim() ? parseNum(v.amount) : null;
  if (v.amount.trim() && !(valor >= 0)) throw new Error('Valor inválido.');
  if (v.mode !== 'avulso' && valor == null) throw new Error('Informe o valor do contrato.');
  if (v.start && v.end && v.end < v.start) throw new Error('O término é antes do início.');
  const dados = { worker_id: v.worker, title: v.title.trim(), scope: v.scope.trim(), amount: valor, payment_mode: v.mode, start_date: v.start || null,
    end_date: v.end || null, notes: v.notes.trim(), phase_ids: raizes.filter((a) => v[`f_${a.id}`]).map((a) => a.id) };
  const c = await sb();
  await nuvem.enviar().catch(() => {});   // a EAP precisa estar no banco (fases do escopo)
  if (k) { ok(await c.from('labor_contracts').update(dados).eq('id', k.id), 'contrato'); await carregar(o.id, true); return k.id; }
  const novo = ok(await c.from('labor_contracts').insert({ ...dados, org_id: ctx().orgId, project_id: o.id }).select('id').single(), 'contrato');
  await carregar(o.id, true);
  return novo.id;
}

async function gerar(o, k) {
  const ps = dadosObra(o.id).parcelas.filter((p) => p.contract_id === k.id);
  const v = await formDialog({ title: 'Gerar parcelas', ok: 'Gerar', text: `Divide ${fmtBRL(k.amount)} em parcelas iguais, uma por mês${ps.length ? '; substitui as parcelas atuais' : ''}.`,
    fields: [{ name: 'n', label: 'Número de parcelas', type: 'number', min: 1, value: k.payment_mode === 'mensal' && k.start_date && k.end_date ? Math.max(1, Math.round((new Date(k.end_date) - new Date(k.start_date)) / 2629800000)) : 3, required: true },
      { name: 'primeira', label: '1º vencimento', type: 'date', value: k.start_date || todayISO(), required: true }] });
  if (!v) return;
  const lista = gerarParcelas(k.amount, Number(v.n), v.primeira);
  const c = await sb();
  if (ps.length) ok(await c.from('labor_contract_installments').delete().eq('contract_id', k.id), 'parcelas');
  ok(await c.from('labor_contract_installments').insert(lista.map((p) => ({ ...p, contract_id: k.id, project_id: o.id }))), 'parcelas');
  await carregar(o.id, true);
}

/* ---------- ações ---------- */
const obraAtual = () => store.obra(location.hash.split('/')[2]);
const contrato = (o, id) => dadosObra(o.id)?.contratos.find((x) => x.id === id);

export const acoesContratos = {
  async ctrNovo(d) { const o = obraAtual(); const id = await formulario(o, null, d.fase || ''); if (id) location.hash = `#/obra/${o.id}/contratos/${id}`; },
  ctrAbrir(d) { location.hash = `#/obra/${obraAtual().id}/contratos/${d.id}`; },
  async ctrAtualizar() { await carregar(obraAtual().id, true); },
  async ctrEditar(d) { const o = obraAtual(); await formulario(o, contrato(o, d.id)); },
  async ctrGerarParcelas(d) { const o = obraAtual(); await gerar(o, contrato(o, d.id)); },
  async ctrAtivar(d) {
    const o = obraAtual(); const k = contrato(o, d.id);
    if (!(await ask(`Ativar ${numeroContrato(k.number)}? ${k.amount != null ? `${fmtBRL(k.amount)} entram no Financeiro como compromisso. ` : ''}Depois de ativo, valor e condições não mudam.`, 'Ativar'))) return;
    await nuvem.enviar().catch(() => {});
    ok(await (await sb()).rpc('contrato_mo_ativar', { p_id: k.id }), 'ativar');
    await depois(o.id, { obras: true });
    toast(`${numeroContrato(k.number)} vigente.`);
  },
  async ctrLancar(d) {
    const o = obraAtual(); const k = contrato(o, d.k); const p = dadosObra(o.id).parcelas.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Lançar parcela ${p.number}`, ok: 'Lançar', text: `${fmtBRL(p.amount)} viram uma despesa de mão de obra de ${numeroContrato(k.number)} no Financeiro (vencimento ${isoBR(p.due_date)}). O pagamento é registrado lá.`,
      fields: [{ name: 'data', label: 'Data da despesa', type: 'date', value: todayISO(), required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('contrato_mo_lancar_parcela', { p_installment: p.id, p_date: v.data }), 'parcela');
    await depois(o.id, { obras: true });
    toast(`Parcela ${p.number} lançada no Financeiro.`);
  },
  async ctrEncerrar(d) {
    const o = obraAtual(); const k = contrato(o, d.id);
    const v = await formDialog({ title: `Encerrar ${numeroContrato(k.number)}`, ok: 'Encerrar', text: 'O compromisso no Financeiro passa a contar só o que já foi lançado, e o profissional deixa de ser medido por este contrato. Nada é apagado.',
      fields: [{ name: 'st', label: 'Situação', type: 'select', value: 'concluido', options: [{ value: 'concluido', label: 'Concluído (serviço entregue)' }, { value: 'rescindido', label: 'Rescindido' }] },
        { name: 'motivo', label: 'Motivo / observação (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('contrato_mo_encerrar', { p_id: k.id, p_status: v.st, p_motivo: v.motivo }), 'encerrar');
    await depois(o.id, { obras: true });
  },
  async ctrExcluir(d) {
    const o = obraAtual(); const k = contrato(o, d.id);
    if (!(await ask(`Excluir o rascunho ${numeroContrato(k.number)}? (Fica registrado na auditoria.)`, 'Excluir'))) return;
    ok(await (await sb()).from('labor_contracts').update({ deleted_at: new Date().toISOString() }).eq('id', k.id), 'contrato');
    await carregar(o.id, true);
    location.hash = `#/obra/${o.id}/contratos`;
  },
  async ctrArquivoAbrir(d) {
    const k = contrato(obraAtual(), d.id);
    const url = await urlTemporaria(k.file_path, 300);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) info('Abrir contrato', `<p><a href="${esc(url)}" target="_blank" rel="noopener">Clique para abrir ${esc(k.file_name)}</a> (link válido por 5 minutos).</p>`);
  },
};

export const mudancasContratos = {
  async ctrParcela(d, el) {
    const o = obraAtual();
    const valor = d.k === 'amount' ? parseNum(el.value) : el.value;
    if (d.k === 'amount' && !(valor > 0)) { toast('Valor da parcela inválido.'); return queueRender(); }
    ok(await (await sb()).from('labor_contract_installments').update({ [d.k]: valor }).eq('id', d.id), 'parcela');
    await carregar(o.id, true);
  },
  async ctrNotas(d, el) {
    const o = obraAtual();
    ok(await (await sb()).from('labor_contracts').update({ notes: el.value.trim() }).eq('id', d.id), 'observações');
    await carregar(o.id, true); toast('Observações salvas.');
  },
  async ctrArquivo(d, el) {
    const f = el.files[0]; el.value = ''; if (!f) return;
    const o = obraAtual();
    const caminho = await enviarArquivo(ctx().orgId, 'contratos', d.id, f);
    ok(await (await sb()).from('labor_contracts').update({ file_path: caminho, file_name: f.name }).eq('id', d.id), 'contrato');
    await carregar(o.id, true); toast('Contrato anexado.');
  },
};
