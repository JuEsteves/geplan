import * as store from './store.js';
import * as S from './schedule.js';
import * as drive from './drive.js';
import { exportExcel, exportPDF } from './export.js';
import { ALLOWED_EMAIL_HASHES } from './config.js';

/* ---------- acesso (login com Google + lista de contas autorizadas) ---------- */
let authorized = false;
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function isAllowed(email) {
  if (!email) return false;
  return ALLOWED_EMAIL_HASHES.includes(await sha256(email.trim().toLowerCase()));
}

const $view = document.getElementById('view');
const $sync = document.getElementById('sync');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
const I = {
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  archive: svg('<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>'),
  restore: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
};

const ui = {
  zoom: localStorage.getItem('planobras:zoom') || 'dia',
  showCrit: true,
  showBase: true,
  compFilter: '',
  statusDate: S.todayISO(),
  pendingFocus: null,
};

/* ---------- utilidades ---------- */
function toast(msg, ms = 3200) {
  const el = document.createElement('div');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function formDialog({ title, fields, ok = 'Salvar', text = '' }) {
  const dlg = document.getElementById('dlg');
  const field = (f) => {
    const attrs = `name="${f.name}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.list ? `list="${f.list}"` : ''} placeholder="${esc(f.placeholder || '')}"`;
    const input = f.type === 'select'
      ? `<select ${attrs}>${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : `<input type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${attrs}>`;
    return `<label class="field">${esc(f.label)}${input}${f.hint ? `<span class="muted small" style="font-weight:400">${esc(f.hint)}</span>` : ''}</label>`;
  };
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}
    <div class="stack" style="margin-top:14px">${fields.map(field).join('')}</div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    const form = dlg.querySelector('form');
    form.onsubmit = (e) => {
      e.preventDefault();
      finish(e.submitter?.value === 'ok' ? Object.fromEntries(new FormData(form)) : null);
    };
    dlg.querySelector('button[value="cancel"]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    dlg.querySelector('input, select')?.focus();
  });
}

/** Confirmação própria (o confirm() nativo é bloqueado em alguns navegadores embutidos). */
function ask(message, ok = 'Confirmar') {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog"><h2>Confirmar</h2><p style="margin:12px 0 0">${esc(message)}</p>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button type="button" class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    dlg.querySelector('button[value="ok"]').onclick = () => finish(true);
    dlg.querySelector('button[value="cancel"]').onclick = () => finish(false);
    dlg.oncancel = () => finish(false);
    dlg.onclose = () => finish(false);
    dlg.showModal();
    dlg.querySelector('button[value="ok"]').focus();
  });
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 0);
}
function commit(...docs) {
  docs.forEach((d) => store.touch(d));
  queueRender();
}

const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
};

/* ---------- rotas ---------- */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'obra' && parts[1]) return { name: 'obra', id: parts[1], tab: parts[2] || 'orcamento' };
  if (['etapas', 'composicoes', 'drive'].includes(parts[0])) return { name: parts[0] };
  return { name: 'obras' };
}

const LOGO_MARK = (stroke = '#fff') => `<svg class="logo-mark" viewBox="0 0 300 420" aria-hidden="true"><g fill="none" stroke="${stroke}" stroke-width="26"><polyline points="20,420 20,226 125,164"/><polyline points="133,160 133,98 257,25 257,240"/></g><polygon fill="${stroke}" points="120,170 194,127 194,420 120,420"/><polygon fill="#d8b7a3" points="222,192 300,238 300,420 222,420"/></svg>`;

function renderGate(error = '') {
  document.body.classList.add('locked');
  document.getElementById('gate').innerHTML = `<div class="gate-card">
    ${LOGO_MARK()}
    <div class="gate-name">GEPLAN</div>
    <div class="gate-tag">GESTÃO E PLANEJAMENTO DE OBRAS</div>
    <p class="gate-slogan">Da estratégia à execução</p>
    <button class="gate-btn" id="gateLogin" type="button">
      <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
      Entrar com Google
    </button>
    ${error ? `<div class="gate-error">${esc(error)}</div>` : ''}
    <p class="gate-note">Acesso restrito a usuários autorizados.</p>
  </div>`;
  document.getElementById('gateLogin').onclick = login;
}

async function login() {
  const btn = document.getElementById('gateLogin');
  btn.disabled = true; btn.lastChild.textContent = ' Entrando…';
  try {
    const user = await drive.signIn();
    if (!(await isAllowed(user.emailAddress))) {
      drive.disconnect();
      return renderGate(`A conta ${user.emailAddress} não tem acesso ao GEPLAN.`);
    }
    // Outra conta usou este aparelho antes: não misturar os dados
    if (store.meta.owner && store.meta.owner !== user.emailAddress.toLowerCase()) store.clearLocal();
    store.meta.owner = user.emailAddress.toLowerCase();
    store.saveMeta();
    authorized = true;
    document.body.classList.remove('locked');
    render();
    drive.init();
    await drive.activate(user);
  } catch (e) {
    renderGate(e.message || 'Não foi possível entrar.');
  }
}

function render() {
  if (!authorized) return renderGate();
  document.body.classList.remove('locked');
  const route = parseRoute();
  // mantém o foco/cursor do campo que estava ativo
  const ae = document.activeElement;
  const focusKey = ui.pendingFocus || (ae && $view.contains(ae) ? ae.dataset.key : null);
  const sel = ae && ae.dataset?.key === focusKey && 'selectionStart' in ae ? (() => { try { return [ae.selectionStart, ae.selectionEnd]; } catch { return null; } })() : null;
  const scrollGantt = document.querySelector('.gantt')?.scrollLeft;

  let html;
  if (route.name === 'obra') html = viewObra(route);
  else if (route.name === 'etapas') html = viewEtapas();
  else if (route.name === 'composicoes') html = viewComposicoes();
  else if (route.name === 'drive') html = viewDrive();
  else html = viewObras();
  $view.innerHTML = html;

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === route.name || (a.dataset.nav === 'obras' && route.name === 'obra'));
  });

  if (focusKey) {
    const el = $view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus({ preventScroll: !ui.pendingFocus });
      if (ui.pendingFocus && el.select) el.select();
      else if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
    }
    ui.pendingFocus = null;
  }
  afterRender(route, scrollGantt);
}

/* ---------- Obras ---------- */
function viewObras() {
  const list = store.obras();
  const lib = store.lib();
  const cards = list.map((o) => {
    const sc = S.compute(o, lib);
    const pr = S.progress(sc, S.todayDay());
    return `<a class="card obra-card" href="#/obra/${o.id}">
      <h2>${esc(o.nome)}</h2>
      <div class="meta">
        <div>Início<b>${S.fmtBR(sc.inicio)}</b></div>
        <div>Término previsto<b>${sc.rows.length ? S.fmtBR(sc.termino) : '—'}</b></div>
        <div>Duração<b>${sc.durTotal} dias úteis</b></div>
        <div>Executado<b>${S.fmtNum(pr.real, 1)}%</b></div>
      </div>
      <div class="progress" title="Executado"><div style="width:${Math.min(100, pr.real)}%"></div></div>
    </a>`;
  }).join('');
  return `<div class="page-head"><div><h1>Obras</h1><div class="muted">Orçamento de quantitativos e cronograma de cada obra</div></div>
    <button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div>
    ${list.length ? `<div class="obras-grid">${cards}</div>` : `<div class="card empty"><p>Nenhuma obra ainda.</p>
      <p class="small">Sugestão de ordem: 1) cadastre as <a href="#/etapas">etapas</a>, 2) as <a href="#/composicoes">composições</a> com o tempo por unidade, 3) crie a obra e preencha os quantitativos.</p>
      <button class="btn primary" data-act="newObra">${I.plus} Criar primeira obra</button></div>`}`;
}

/* ---------- Biblioteca: Etapas ---------- */
function etapaUso(etapaId) {
  return store.obras().filter((o) => o.etapas.some((e) => e.etapaId === etapaId)).length;
}
function viewEtapas() {
  const lib = store.lib();
  const ativas = lib.etapas.filter((e) => !e.arquivada);
  const arq = lib.etapas.filter((e) => e.arquivada);
  const item = (e, i, n) => {
    const uso = etapaUso(e.id);
    return `<div class="list-item">
      <span class="idx">${i + 1}</span>
      <input data-chg="etapaNome" data-id="${e.id}" data-key="etapaNome:${e.id}" value="${esc(e.nome)}">
      <span class="badge" title="Obras que usam esta etapa">${uso} obra${uso === 1 ? '' : 's'}</span>
      <button class="icon-btn" title="Subir" data-act="moveEtapaLib" data-id="${e.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>${I.up}</button>
      <button class="icon-btn" title="Descer" data-act="moveEtapaLib" data-id="${e.id}" data-dir="1" ${i === n - 1 ? 'disabled' : ''}>${I.down}</button>
      <button class="icon-btn" title="Arquivar (etapa antiga)" data-act="archiveEtapa" data-id="${e.id}">${I.archive}</button>
    </div>`;
  };
  return `<div class="page-head"><div><h1>Etapas</h1><div class="muted">Etapas da construção usadas para organizar o orçamento das obras</div></div></div>
    <div class="card card-pad" style="margin-bottom:14px">
      <div class="row"><input id="novaEtapa" data-key="novaEtapa" placeholder="Nome da nova etapa (ex.: Impermeabilização do baldrame)" data-enter="addEtapa" style="flex:1;min-width:200px">
      <button class="btn primary" data-act="addEtapa">${I.plus} Adicionar</button></div>
    </div>
    <div class="card">${ativas.length ? ativas.map((e, i) => item(e, i, ativas.length)).join('') : '<div class="empty"><p>Nenhuma etapa cadastrada.</p></div>'}</div>
    ${arq.length ? `<details class="card archived" style="margin-top:14px"><summary>Etapas arquivadas (${arq.length})</summary>
      ${arq.map((e) => `<div class="list-item"><span class="idx">–</span><input data-chg="etapaNome" data-id="${e.id}" data-key="etapaNome:${e.id}" value="${esc(e.nome)}">
        <button class="icon-btn" title="Reativar" data-act="unarchiveEtapa" data-id="${e.id}">${I.restore}</button>
        <button class="icon-btn danger" title="Excluir" data-act="deleteEtapaLib" data-id="${e.id}">${I.trash}</button></div>`).join('')}
    </details>` : ''}`;
}

/* ---------- Biblioteca: Composições ---------- */
function compUso(compId) {
  return store.obras().filter((o) => o.etapas.some((e) => e.servicos.some((s) => s.composicaoId === compId))).length;
}
function viewComposicoes() {
  const lib = store.lib();
  const f = ui.compFilter.trim().toLowerCase();
  const list = [...lib.composicoes].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .filter((c) => !f || c.nome.toLowerCase().includes(f));
  const rows = list.map((c) => {
    const coef = Number(c.coef) || 0;
    const prod = coef > 0 ? `≈ ${S.fmtNum(8 / coef)} ${esc(c.unidade)}/dia por equipe (8 h)` : '<span class="muted">informe o coeficiente</span>';
    return `<div class="comp-row">
      <div><span class="lbl">Composição</span><input data-chg="compField" data-f="nome" data-id="${c.id}" data-key="compNome:${c.id}" value="${esc(c.nome)}"></div>
      <div><span class="lbl">Unidade</span><input data-chg="compField" data-f="unidade" data-id="${c.id}" data-key="compUn:${c.id}" value="${esc(c.unidade)}" list="unidades"></div>
      <div><span class="lbl">Coef. (h/un)</span><input type="number" step="any" min="0" data-chg="compField" data-f="coef" data-id="${c.id}" data-key="compCoef:${c.id}" value="${coef || ''}" placeholder="0,00"></div>
      <div class="prod">${prod}</div>
      <div><span class="lbl">Observação</span><input data-chg="compField" data-f="obs" data-id="${c.id}" data-key="compObs:${c.id}" value="${esc(c.obs || '')}" placeholder="Equipe, referência…"></div>
      <button class="icon-btn danger" title="Excluir" data-act="deleteComp" data-id="${c.id}">${I.trash}</button>
    </div>`;
  }).join('');
  return `<div class="page-head"><div><h1>Composições</h1><div class="muted">Tempo de execução por unidade de serviço (horas por unidade, para 1 equipe)</div></div>
    <button class="btn primary" data-act="addComp">${I.plus} Nova composição</button></div>
    <div class="alert info" style="margin-bottom:14px">Exemplo: alvenaria com coeficiente <b>0,8 h/m²</b> e 135 m² na obra → 108 h. Com 1 equipe e jornada de 8 h/dia: 108 ÷ 8 = <b>13,5 → 14 dias úteis</b>. Com 2 equipes: 7 dias.</div>
    <div class="card comp-card">
      <div style="padding:10px 12px;border-bottom:1px solid var(--border)"><input data-inp="compFilter" data-key="compFilter" value="${esc(ui.compFilter)}" placeholder="Buscar composição…"></div>
      <div class="comp-head"><div>Composição</div><div>Unidade</div><div>Coef. (h/un)</div><div>Produção equivalente</div><div>Observação</div><div></div></div>
      ${rows || `<div class="empty"><p>${f ? 'Nenhuma composição encontrada.' : 'Nenhuma composição cadastrada.'}</p></div>`}
    </div>`;
}

/* ---------- Obra ---------- */
const TABS = [['orcamento', 'Orçamento'], ['cronograma', 'Cronograma'], ['gantt', 'Gantt'], ['acompanhamento', 'Acompanhamento'], ['config', 'Configurações']];

function viewObra(route) {
  const o = store.obra(route.id);
  if (!o) return `<div class="card empty"><p>Obra não encontrada.</p><a class="btn" href="#/obras">Voltar</a></div>`;
  const lib = store.lib();
  const sc = S.compute(o, lib);
  const body = {
    orcamento: tabOrcamento, cronograma: tabCronograma, gantt: tabGantt, acompanhamento: tabAcompanhamento, config: tabConfig,
  }[route.tab] || tabOrcamento;
  return `<div class="page-head" style="margin-bottom:10px"><div>
      <a href="#/obras" class="muted small" style="text-decoration:none">← Obras</a>
      <h1>${esc(o.nome)}</h1>
      <div class="row small muted">
        <span>Início <b style="color:var(--text)">${S.fmtBR(sc.inicio)}</b></span>·
        <span>Término <b style="color:var(--text)">${sc.rows.length ? S.fmtBR(sc.termino) : '—'}</b></span>·
        <span><b style="color:var(--text)">${sc.durTotal}</b> dias úteis</span>·
        <span><b style="color:var(--text)">${S.fmtNum(sc.horasTotal, 0)}</b> h de serviço</span>
      </div></div></div>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/obra/${o.id}/${k}" class="${route.tab === k ? 'active' : ''}">${l}</a>`).join('')}</nav>
    ${sc.ciclo ? `<div class="alert err" style="margin-bottom:14px"><b>Dependência circular</b> entre os serviços ${sc.cycleRows.map((r) => r.code).join(', ')}. Revise as predecessoras.</div>` : ''}
    ${body(o, sc, lib)}`;
}

function compOptions(lib, selected) {
  const comps = [...lib.composicoes].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return `<option value="">— Selecione a composição —</option>`
    + comps.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.nome)} (${esc(c.unidade)} · ${S.fmtNum(c.coef, 3)} h/${esc(c.unidade)})</option>`).join('')
    + `<option value="__new__">＋ Nova composição…</option>`;
}

function tabOrcamento(o, sc, lib) {
  const used = new Set(o.etapas.map((e) => e.etapaId));
  const disponiveis = lib.etapas.filter((e) => !e.arquivada && !used.has(e.id));
  const cards = sc.etapas.map((et, ei) => {
    const rows = et.rows.map((r, si) => `<div class="srv-row">
      <div class="code">${r.code}${r.critico && !r.ciclo ? ' <span class="badge crit" title="Caminho crítico">C</span>' : ''}</div>
      <div class="srv-name">
        <select data-chg="srvComp" data-e="${et.id}" data-s="${r.id}" data-key="srvComp:${r.id}">${compOptions(lib, r.s.composicaoId)}</select>
        <input data-chg="srvField" data-f="descricao" data-e="${et.id}" data-s="${r.id}" data-key="srvDesc:${r.id}" value="${esc(r.s.descricao || '')}" placeholder="Descrição (opcional), ex.: Alvenaria do pavimento superior">
      </div>
      <div class="c-qty"><span class="lbl">Quantidade</span><div class="qty"><input type="number" step="any" min="0" data-chg="srvField" data-f="quantidade" data-e="${et.id}" data-s="${r.id}" data-key="srvQtd:${r.id}" value="${r.s.quantidade ?? ''}" placeholder="0"><span>${esc(r.unidade)}</span></div></div>
      <div class="c-eq"><span class="lbl">Equipes</span><input type="number" min="1" step="1" data-chg="srvField" data-f="equipes" data-e="${et.id}" data-s="${r.id}" data-key="srvEq:${r.id}" value="${r.equipes}"></div>
      <div class="c-hrs calc"><span class="lbl">Horas</span>${r.horas ? S.fmtNum(r.horas, 1) + ' h' : '—'}</div>
      <div class="c-dur"><span class="lbl">Duração (dias)</span><input type="number" min="0" step="1" class="computed" title="Calculado: ${r.durCalc} dia(s). Digite um valor para fixar a duração; deixe vazio para calcular automaticamente." data-chg="srvField" data-f="duracaoFixa" data-e="${et.id}" data-s="${r.id}" data-key="srvDur:${r.id}" value="${r.fixa ? r.dur : ''}" placeholder="${r.durCalc}"></div>
      <div class="c-pred"><span class="lbl">Predecessoras</span><input data-chg="srvPreds" data-e="${et.id}" data-s="${r.id}" data-key="srvPred:${r.id}" value="${esc(S.formatPreds(r.s.preds, sc.codes))}" placeholder="ex.: 1.2; 3+2"></div>
      <div class="srv-actions">
        <button class="icon-btn" title="Subir" data-act="moveSrv" data-e="${et.id}" data-s="${r.id}" data-dir="-1" ${si === 0 ? 'disabled' : ''}>${I.up}</button>
        <button class="icon-btn" title="Descer" data-act="moveSrv" data-e="${et.id}" data-s="${r.id}" data-dir="1" ${si === et.rows.length - 1 ? 'disabled' : ''}>${I.down}</button>
        <button class="icon-btn danger" title="Remover serviço" data-act="delSrv" data-e="${et.id}" data-s="${r.id}">${I.trash}</button>
      </div>
    </div>`).join('');
    const sum = et.vazia ? 'sem serviços' : `${et.rows.length} serviço${et.rows.length > 1 ? 's' : ''} · ${S.fmtNum(et.horas, 0)} h · ${et.dur} dias úteis · ${S.fmtBR(et.inicio)} → ${S.fmtBR(et.termino)}`;
    return `<div class="card etapa-card">
      <div class="etapa-head"><span class="code">${et.code}</span><h3>${esc(et.nome)}</h3><span class="sum">${sum}</span>
        <button class="icon-btn" title="Subir etapa" data-act="moveEtapaObra" data-e="${et.id}" data-dir="-1" ${ei === 0 ? 'disabled' : ''}>${I.up}</button>
        <button class="icon-btn" title="Descer etapa" data-act="moveEtapaObra" data-e="${et.id}" data-dir="1" ${ei === sc.etapas.length - 1 ? 'disabled' : ''}>${I.down}</button>
        <button class="icon-btn danger" title="Remover etapa da obra" data-act="delEtapaObra" data-e="${et.id}">${I.trash}</button>
      </div>
      ${et.rows.length ? `<div class="srv-head"><div>Cód.</div><div>Serviço (composição)</div><div>Quantidade</div><div>Equipes</div><div style="text-align:right">Horas</div><div>Duração (d)</div><div>Predecessoras</div><div></div></div>${rows}` : ''}
      <div class="etapa-foot"><button class="btn sm" data-act="addSrv" data-e="${et.id}">${I.plus} Serviço</button></div>
    </div>`;
  }).join('');

  return `<div class="stack">
    ${!lib.composicoes.length ? `<div class="alert info">Você ainda não tem composições. Cadastre em <a href="#/composicoes">Composições</a> ou crie direto no seletor de cada serviço ("＋ Nova composição…").</div>` : ''}
    ${cards || `<div class="card empty"><p>Adicione as etapas da obra abaixo.</p></div>`}
    <div class="card card-pad"><div class="row">
      <select id="addEtapaSel" data-key="addEtapaSel" style="flex:1;min-width:200px">
        <option value="">— Escolha uma etapa para adicionar —</option>
        ${disponiveis.map((e) => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}
        <option value="__new__">＋ Nova etapa…</option>
      </select>
      <button class="btn primary" data-act="addEtapaObra">${I.plus} Adicionar etapa</button>
      ${disponiveis.length > 1 ? `<button class="btn" data-act="addTodasEtapas">Adicionar todas (${disponiveis.length})</button>` : ''}
    </div></div>
    <div class="muted small"><b>Predecessoras:</b> use os códigos — <code class="k">1.2</code> (depois do serviço 1.2), <code class="k">3</code> (depois de toda a etapa 3), <code class="k">2.1+2</code> (2 dias úteis após o término), <code class="k">2.1-3</code> (começa 3 dias antes do término). Separe várias com ponto e vírgula. Sem predecessora, o serviço começa no início da obra.
    <br><b>Duração:</b> calculada como quantidade × coeficiente ÷ (equipes × jornada), arredondada para cima. Digite um valor para fixá-la manualmente (0 = marco).</div>
  </div>`;
}

function baseDesvio(o, sc, r) {
  const b = o.linhaBase?.itens?.[r.id];
  if (!b) return null;
  return sc.cal.countUpTo(r.termino) - sc.cal.countUpTo(b.termino);
}

function tabCronograma(o, sc) {
  const hasBase = !!o.linhaBase;
  const corridos = sc.rows.length ? sc.termino - sc.inicio + 1 : 0;
  const crit = sc.rows.filter((r) => r.critico).length;
  let desvioTotal = null;
  if (hasBase && sc.rows.length) {
    const bt = Math.max(...Object.values(o.linhaBase.itens).map((b) => b.termino));
    desvioTotal = sc.cal.countUpTo(sc.termino) - sc.cal.countUpTo(bt);
  }
  const body = sc.etapas.map((et) => `<tr class="etapa-row"><td>${et.code}</td><td colspan="4">${esc(et.nome)}</td><td class="num">${S.fmtNum(et.horas, 1)}</td><td></td><td class="num">${et.vazia ? '' : et.dur}</td><td class="nowrap">${et.vazia ? '' : S.fmtBR(et.inicio)}</td><td class="nowrap">${et.vazia ? '' : S.fmtBR(et.termino)}</td><td></td><td></td>${hasBase ? '<td></td>' : ''}<td></td></tr>`
    + et.rows.map((r) => {
      const dv = hasBase ? baseDesvio(o, sc, r) : null;
      return `<tr>
        <td class="nowrap">${r.code}</td><td>${esc(r.nome)}</td>
        <td class="num">${r.qtd ? S.fmtNum(r.qtd) : ''}</td><td>${esc(r.unidade)}</td><td class="num">${r.coef ? S.fmtNum(r.coef, 3) : ''}</td>
        <td class="num">${r.horas ? S.fmtNum(r.horas, 1) : ''}</td><td class="num">${r.equipes}</td>
        <td class="num">${r.dur}${r.fixa ? '*' : ''}</td>
        <td class="nowrap">${S.fmtBR(r.inicio)}</td><td class="nowrap">${S.fmtBR(r.termino)}</td>
        <td>${esc(S.formatPreds(r.s.preds, sc.codes))}</td>
        <td class="num">${r.folga}</td>
        ${hasBase ? `<td class="num">${dv == null ? '<span class="muted">novo</span>' : dv > 0 ? `<span class="badge crit">+${dv} d</span>` : dv < 0 ? `<span class="badge good">${dv} d</span>` : '0'}</td>` : ''}
        <td>${r.critico ? '<span class="badge crit">Crítico</span>' : ''}</td>
      </tr>`;
    }).join('')).join('');

  return `<div class="stack">
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Início</div><div class="k-value">${S.fmtBR(sc.inicio)}</div></div>
      <div class="card kpi"><div class="k-label">Término previsto</div><div class="k-value">${sc.rows.length ? S.fmtBR(sc.termino) : '—'}</div>${desvioTotal != null ? `<div class="k-sub">${desvioTotal === 0 ? 'igual à linha de base' : desvioTotal > 0 ? `${desvioTotal} dias úteis após a linha de base` : `${-desvioTotal} dias úteis antes da linha de base`}</div>` : ''}</div>
      <div class="card kpi"><div class="k-label">Duração</div><div class="k-value">${sc.durTotal}</div><div class="k-sub">dias úteis · ${corridos} corridos</div></div>
      <div class="card kpi"><div class="k-label">Horas de serviço</div><div class="k-value">${S.fmtNum(sc.horasTotal, 0)}</div><div class="k-sub">jornada de ${sc.jornada} h/dia</div></div>
      <div class="card kpi"><div class="k-label">Caminho crítico</div><div class="k-value">${crit}</div><div class="k-sub">serviços sem folga</div></div>
    </div>
    <div class="row">
      <button class="btn" data-act="exportXlsx">Exportar Excel</button>
      <button class="btn" data-act="exportPdf">Exportar PDF</button>
      <span style="flex:1"></span>
      ${hasBase ? `<span class="muted small">Linha de base salva em ${o.linhaBase.data.split('-').reverse().join('/')}</span><button class="btn sm" data-act="saveBase">Atualizar linha de base</button><button class="btn sm danger" data-act="clearBase">Remover</button>`
        : `<button class="btn" data-act="saveBase" title="Congela o cronograma atual para comparar com as mudanças futuras">Salvar linha de base</button>`}
    </div>
    ${sc.rows.length ? `<div class="card table-wrap"><table class="data">
      <thead><tr><th>Cód.</th><th>Etapa / Serviço</th><th class="num">Quant.</th><th>Un.</th><th class="num">Coef.</th><th class="num">Horas</th><th class="num">Equip.</th><th class="num">Dur. (d)</th><th>Início</th><th>Término</th><th>Predec.</th><th class="num">Folga</th>${hasBase ? '<th class="num">Desvio LB</th>' : ''}<th></th></tr></thead>
      <tbody>${body}</tbody></table></div>
      <div class="muted small">* duração fixada manualmente. Folga = quantos dias úteis o serviço pode atrasar sem atrasar a obra.</div>`
      : `<div class="card empty"><p>Preencha o orçamento para gerar o cronograma.</p><a class="btn" href="#/obra/${o.id}/orcamento">Ir para o orçamento</a></div>`}
  </div>`;
}

/* ---------- Gantt ---------- */
const ZOOM = { dia: 26, semana: 9, mes: 3 };
const ROW_H = 34, HEAD_H = 42;
const MN = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dateParts = (day) => { const d = new Date(day * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };

function tabGantt(o, sc) {
  if (!sc.rows.length) return `<div class="card empty"><p>Preencha o orçamento para gerar o Gantt.</p><a class="btn" href="#/obra/${o.id}/orcamento">Ir para o orçamento</a></div>`;
  const hasBase = !!o.linhaBase;
  const dw = ZOOM[ui.zoom] || 26;
  const today = S.todayDay();
  let d0 = sc.inicio, d1 = sc.termino;
  if (hasBase && ui.showBase) for (const b of Object.values(o.linhaBase.itens)) { d0 = Math.min(d0, b.inicio); d1 = Math.max(d1, b.termino); }
  d0 -= ui.zoom === 'dia' ? 2 : 7;
  d1 += ui.zoom === 'dia' ? 6 : 20;
  const W = (d1 - d0 + 1) * dw;
  const x = (d) => (d - d0) * dw;

  const lines = [];
  for (const et of sc.etapas) { lines.push({ et }); et.rows.forEach((r) => lines.push({ r })); }
  const H = lines.length * ROW_H;
  const yOf = new Map();
  lines.forEach((ln, i) => yOf.set((ln.et || ln.r).id, i * ROW_H));

  // Cabeçalho
  let head = '';
  for (let d = d0; d <= d1; d++) {
    const p = dateParts(d);
    if (p.d === 1 || d === d0) {
      head += `<line class="g-grid" x1="${x(d)}" y1="0" x2="${x(d)}" y2="${HEAD_H}"/>`;
      if (x(d1) - x(d) > 40) head += `<text x="${x(d) + 4}" y="15" style="font-weight:600">${MN[p.m]}/${String(p.y).slice(2)}</text>`;
    }
    if (ui.zoom === 'dia') head += `<text x="${x(d) + dw / 2}" y="34" text-anchor="middle" ${sc.cal.isWork(d) ? '' : 'opacity=".5"'}>${p.d}</text>`;
    else if (ui.zoom === 'semana' && S.weekday(d) === 1) head += `<text x="${x(d) + 2}" y="34">${p.d}</text><line class="g-grid" x1="${x(d)}" y1="22" x2="${x(d)}" y2="${HEAD_H}"/>`;
  }
  head += `<line class="g-grid" x1="0" y1="${HEAD_H - 0.5}" x2="${W}" y2="${HEAD_H - 0.5}"/>`;

  // Corpo
  let bg = '', bars = '', arrows = '';
  for (let d = d0; d <= d1; d++) {
    if (!sc.cal.isWork(d)) bg += `<rect class="g-nonwork" x="${x(d)}" y="0" width="${dw}" height="${H}"/>`;
    if (dateParts(d).d === 1) bg += `<line class="g-grid" x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}"/>`;
  }
  lines.forEach((ln, i) => {
    const y = i * ROW_H;
    if (ln.et) bg += `<rect class="g-etaparow" x="0" y="${y}" width="${W}" height="${ROW_H}"/>`;
    bg += `<line class="g-rowline" x1="0" y1="${y + ROW_H - 0.5}" x2="${W}" y2="${y + ROW_H - 0.5}"/>`;
  });
  const range = (a, b) => `${S.fmtBR(a)} → ${S.fmtBR(b)}`;
  for (const ln of lines) {
    const y = yOf.get((ln.et || ln.r).id);
    if (ln.et) {
      const et = ln.et;
      if (et.vazia) continue;
      const bx = x(et.inicio), bw = x(et.termino + 1) - bx;
      bars += `<g><title>${esc(et.code + ' ' + et.nome)}\n${range(et.inicio, et.termino)} · ${et.dur} dias úteis</title>
        <path class="g-etapa" d="M${bx} ${y + 11}h${bw}v8l-5 -3H${bx + 5}l-5 3z"/></g>`;
      continue;
    }
    const r = ln.r;
    const crit = ui.showCrit && r.critico ? ' crit' : '';
    const pct = Number(r.s.pct) || 0;
    const tip = `${r.code} ${r.nome}\n${range(r.inicio, r.termino)} · ${r.dur} dia(s) úteis\n${r.qtd ? `${S.fmtNum(r.qtd)} ${r.unidade} · ${S.fmtNum(r.horas, 1)} h · ` : ''}folga ${r.folga} d · ${pct}% executado${r.critico ? ' · CRÍTICO' : ''}`;
    if (hasBase && ui.showBase) {
      const b = o.linhaBase.itens[r.id];
      if (b) bars += `<rect class="g-base" x="${x(b.inicio)}" y="${y + ROW_H - 8}" width="${Math.max(2, x(b.termino + 1) - x(b.inicio))}" height="4" rx="2"><title>Linha de base: ${range(b.inicio, b.termino)}</title></rect>`;
    }
    if (r.dur === 0) {
      const cx = x(r.inicio), cy = y + ROW_H / 2 - (hasBase && ui.showBase ? 2 : 0);
      bars += `<g><title>${esc(tip)}</title><path class="g-ms" d="M${cx} ${cy - 7}l7 7-7 7-7-7z"/></g>`;
      continue;
    }
    const bx = x(r.inicio), bw = Math.max(3, x(r.termino + 1) - bx);
    const by = y + 8, bh = ROW_H - 16 - (hasBase && ui.showBase ? 3 : 0);
    bars += `<g><title>${esc(tip)}</title>
      <rect class="g-bar${crit}" x="${bx + 1}" y="${by}" width="${bw - 2}" height="${bh}" rx="4"/>
      ${pct > 0 ? `<rect class="g-prog${crit}" x="${bx + 1}" y="${by}" width="${Math.max(0, (bw - 2) * Math.min(100, pct) / 100)}" height="${bh}" rx="4"/>` : ''}
    </g>`;
    // Setas das predecessoras
    for (const p of r.s.preds || []) {
      const srcRow = sc.byId.get(p.ref);
      const srcEt = sc.etapas.find((e) => e.id === p.ref);
      const src = srcRow || (srcEt && !srcEt.vazia ? srcEt : null);
      if (!src || !yOf.has(src.id)) continue;
      const sx = x(src.termino + 1) - 1, sy = yOf.get(src.id) + ROW_H / 2;
      const tx = bx + 1, ty = y + ROW_H / 2 - (hasBase && ui.showBase ? 1.5 : 0);
      const path = tx >= sx + 10
        ? `M${sx} ${sy}H${sx + 5}V${ty}H${tx - 2}`
        : `M${sx} ${sy}H${sx + 5}V${y - 1}H${tx - 8}V${ty}H${tx - 2}`;
      arrows += `<path class="g-arrow" d="${path}" marker-end="url(#ah)"/>`;
    }
  }
  const todayLine = today >= d0 && today <= d1 ? `<line class="g-today" x1="${x(today) + dw / 2}" y1="0" x2="${x(today) + dw / 2}" y2="${H}"><title>Hoje</title></line>` : '';

  const left = lines.map((ln) => ln.et
    ? `<div class="g-row etapa"><span class="g-code">${ln.et.code}</span><span class="g-name" title="${esc(ln.et.nome)}">${esc(ln.et.nome)}</span></div>`
    : `<div class="g-row"><span class="g-code">${ln.r.code}</span><span class="g-name" title="${esc(ln.r.nome)}">${esc(ln.r.nome)}</span></div>`).join('');

  return `<div class="gantt-toolbar">
      <div class="seg" role="group" aria-label="Escala">${Object.keys(ZOOM).map((z) => `<button data-act="zoom" data-z="${z}" class="${ui.zoom === z ? 'on' : ''}">${{ dia: 'Dia', semana: 'Semana', mes: 'Mês' }[z]}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-chg="toggleCrit" ${ui.showCrit ? 'checked' : ''}> Caminho crítico</label>
      ${hasBase ? `<label class="check"><input type="checkbox" data-chg="toggleBase" ${ui.showBase ? 'checked' : ''}> Linha de base</label>` : ''}
      <span style="flex:1"></span>
      <button class="btn sm" data-act="exportPdf">Exportar PDF</button>
      <button class="btn sm" data-act="exportXlsx">Exportar Excel</button>
    </div>
    <div class="legend" style="margin-bottom:10px">
      <span><i style="background:var(--bar)"></i>Serviço</span>
      ${ui.showCrit ? '<span><i style="background:var(--crit)"></i>Caminho crítico</span>' : ''}
      <span><i style="background:var(--bar-progress)"></i>Executado</span>
      <span><i style="background:var(--bar-etapa)"></i>Etapa</span>
      ${hasBase && ui.showBase ? '<span><i style="background:var(--bar-base);height:4px"></i>Linha de base</span>' : ''}
      <span><i style="background:var(--nonwork);border:1px solid var(--border)"></i>Dia não útil</span>
      <span><i style="background:none;border-left:2px dashed var(--today);width:2px;height:12px"></i>Hoje</span>
    </div>
    <div class="card gantt" id="gantt">
      <div class="gantt-left"><div class="g-head" style="height:${HEAD_H}px">Etapa / Serviço</div>${left}</div>
      <div class="gantt-right" style="width:${W}px">
        <svg class="g-headsvg" width="${W}" height="${HEAD_H}">${head}</svg>
        <svg width="${W}" height="${H}" style="display:block">
          <defs><marker id="ah" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path class="g-arrow-head" d="M0 0L6 3L0 6z"/></marker></defs>
          ${bg}${todayLine}${arrows}${bars}
        </svg>
      </div>
    </div>
    <div class="muted small" style="margin-top:8px">Passe o mouse (ou toque) nas barras para ver os detalhes.</div>`;
}

/* ---------- Acompanhamento ---------- */
function tabAcompanhamento(o, sc) {
  if (!sc.rows.length) return `<div class="card empty"><p>Preencha o orçamento antes de acompanhar a execução.</p></div>`;
  const statusDay = S.toDay(ui.statusDate) ?? S.todayDay();
  const pr = S.progress(sc, statusDay);
  const desvio = pr.real - pr.plan;
  const sts = sc.rows.map((r) => S.statusOf(r, sc.cal, statusDay));
  const atrasados = sts.filter((s) => s.key === 'late').length;
  const concl = sts.filter((s) => s.key === 'done').length;

  const rows = sc.etapas.map((et) => `<tr class="etapa-row"><td>${et.code}</td><td colspan="2">${esc(et.nome)}</td><td class="num">${et.vazia ? '' : S.fmtNum(et.rows.reduce((a, r) => a + r.peso * S.plannedFrac(r, sc.cal, statusDay), 0) / (et.peso || 1) * 100, 0) + '%'}</td><td class="num">${et.vazia ? '' : S.fmtNum(et.pct, 0) + '%'}</td><td colspan="3"></td></tr>`
    + et.rows.map((r) => {
      const st = S.statusOf(r, sc.cal, statusDay);
      return `<tr>
        <td class="nowrap">${r.code}</td><td>${esc(r.nome)}</td>
        <td class="nowrap small">${S.fmtBR(r.inicio)} → ${S.fmtBR(r.termino)}</td>
        <td class="num">${S.fmtNum(st.plan, 0)}%</td>
        <td style="min-width:90px"><input type="number" min="0" max="100" step="5" data-chg="pct" data-e="${et.id}" data-s="${r.id}" data-key="pct:${r.id}" value="${Number(r.s.pct) || 0}"></td>
        <td style="min-width:140px"><input type="date" data-chg="srvField" data-f="inicioReal" data-e="${et.id}" data-s="${r.id}" data-key="ir:${r.id}" value="${r.s.inicioReal || ''}"></td>
        <td style="min-width:140px"><input type="date" data-chg="srvField" data-f="fimReal" data-e="${et.id}" data-s="${r.id}" data-key="fr:${r.id}" value="${r.s.fimReal || ''}"></td>
        <td><span class="badge ${st.cls}">${st.label}</span></td>
      </tr>`;
    }).join('')).join('');

  const med = [...(o.medicoes || [])].sort((a, b) => a.data.localeCompare(b.data));
  return `<div class="stack">
    <div class="card card-pad row">
      <label class="field" style="max-width:200px">Data de referência<input type="date" data-chg="statusDate" data-key="statusDate" value="${ui.statusDate}"></label>
      <span style="flex:1"></span>
      <button class="btn primary" data-act="registrarMedicao">Registrar medição em ${ui.statusDate.split('-').reverse().join('/')}</button>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Planejado até a data</div><div class="k-value">${S.fmtNum(pr.plan, 1)}%</div></div>
      <div class="card kpi"><div class="k-label">Executado</div><div class="k-value">${S.fmtNum(pr.real, 1)}%</div></div>
      <div class="card kpi"><div class="k-label">Desvio</div><div class="k-value" style="color:${desvio < -0.5 ? 'var(--crit)' : desvio > 0.5 ? 'var(--good)' : 'inherit'}">${desvio > 0 ? '+' : ''}${S.fmtNum(desvio, 1)} pts</div><div class="k-sub">${desvio < -0.5 ? 'atrasado' : desvio > 0.5 ? 'adiantado' : 'em dia'}</div></div>
      <div class="card kpi"><div class="k-label">Serviços atrasados</div><div class="k-value" style="color:${atrasados ? 'var(--crit)' : 'inherit'}">${atrasados}</div><div class="k-sub">${concl} de ${sc.rows.length} concluídos</div></div>
    </div>
    <div class="card card-pad">
      <div class="row between" style="margin-bottom:8px"><h2>Curva S</h2>
        <div class="legend"><span><i style="background:var(--series-plan);height:2px"></i>Planejado</span><span><i style="background:var(--series-real);height:2px"></i>Real (medições)</span></div></div>
      <div class="chart-wrap" id="curvaS"></div>
      <div class="muted small" style="margin-top:6px">O avanço é ponderado pelas horas de cada serviço. Registre medições periódicas para formar a curva real.</div>
    </div>
    <div class="card table-wrap"><table class="data">
      <thead><tr><th>Cód.</th><th>Serviço</th><th>Planejado</th><th class="num">Plan. %</th><th>Real %</th><th>Início real</th><th>Fim real</th><th>Situação</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${med.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Medição</th><th class="num">Planejado</th><th class="num">Real</th><th class="num">Desvio</th><th></th></tr></thead><tbody>
      ${med.map((m) => `<tr><td>${m.data.split('-').reverse().join('/')}</td><td class="num">${S.fmtNum(m.plan, 1)}%</td><td class="num">${S.fmtNum(m.real, 1)}%</td><td class="num">${S.fmtNum(m.real - m.plan, 1)} pts</td>
        <td style="text-align:right"><button class="icon-btn danger" title="Excluir medição" data-act="delMedicao" data-d="${m.data}">${I.trash}</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>`;
}

function drawCurvaS(o, sc) {
  const el = document.getElementById('curvaS');
  if (!el) return;
  const plan = S.sCurve(sc);
  const med = [...(o.medicoes || [])].sort((a, b) => a.data.localeCompare(b.data)).map((m) => ({ day: S.toDay(m.data), pct: m.real }));
  const real = med.length ? [{ day: plan[0].day, pct: 0 }, ...med] : [];
  const W = 800, H = 280, ml = 40, mr = 16, mt = 12, mb = 28;
  const dMin = plan[0].day, dMax = Math.max(plan[plan.length - 1].day, ...real.map((p) => p.day));
  const x = (d) => ml + ((d - dMin) / Math.max(1, dMax - dMin)) * (W - ml - mr);
  const y = (p) => mt + (1 - p / 100) * (H - mt - mb);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p.pct).toFixed(1)}`).join('');
  let grid = '';
  for (const v of [0, 25, 50, 75, 100]) grid += `<line class="${v ? 'gridline' : 'baseline'}" x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}"/><text x="${ml - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  const months = [];
  { const dt = new Date(dMin * 86400000); dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() + 1);
    while (dt.getTime() / 86400000 <= dMax) { months.push(Math.floor(dt.getTime() / 86400000)); dt.setUTCMonth(dt.getUTCMonth() + 1); } }
  const step = Math.ceil(months.length / 8) || 1;
  const xt = months.filter((_, i) => i % step === 0).map((d) => { const p = dateParts(d); return `<text x="${x(d)}" y="${H - 8}" text-anchor="middle">${MN[p.m]}/${String(p.y).slice(2)}</text>`; }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Curva S planejada e real">
    <g class="axis">${grid}${xt}</g>
    <path class="line-plan" d="${path(plan)}"/>
    ${real.length ? `<path class="line-real" d="${path(real)}"/>${med.map((p) => `<circle class="dot-real" cx="${x(p.day)}" cy="${y(p.pct)}" r="4.5"/>`).join('')}` : ''}
    <line class="crosshair hidden" id="cs-x" y1="${mt}" y2="${H - mb}"/>
    <rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="transparent" id="cs-hit"/>
  </svg><div class="tooltip hidden" id="cs-tip"></div>`;

  const svgEl = el.querySelector('svg'), hit = el.querySelector('#cs-hit'), cx = el.querySelector('#cs-x'), tip = el.querySelector('#cs-tip');
  const move = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const day = dMin + ((px - ml) / (W - ml - mr)) * (dMax - dMin);
    let best = plan[0];
    for (const p of plan) if (Math.abs(p.day - day) < Math.abs(best.day - day)) best = p;
    const lastReal = [...med].reverse().find((m) => m.day <= best.day);
    cx.setAttribute('x1', x(best.day)); cx.setAttribute('x2', x(best.day)); cx.classList.remove('hidden');
    tip.innerHTML = `<b>${S.fmtBR(best.day)}</b>
      <div class="t-row"><span class="sw" style="background:var(--series-plan)"></span>Planejado: ${S.fmtNum(best.pct, 1)}%</div>
      ${lastReal ? `<div class="t-row"><span class="sw" style="background:var(--series-real)"></span>Real (${S.fmtBR(lastReal.day)}): ${S.fmtNum(lastReal.pct, 1)}%</div>` : ''}`;
    tip.classList.remove('hidden');
    const tx = (x(best.day) / W) * rect.width;
    tip.style.left = Math.min(rect.width - tip.offsetWidth, Math.max(0, tx + 12)) + 'px';
    tip.style.top = '8px';
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cx.classList.add('hidden'); tip.classList.add('hidden'); });
}

/* ---------- Configurações da obra ---------- */
function tabConfig(o, sc) {
  const c = o.calendario;
  const dn = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const y0 = dateParts(sc.inicio).y;
  const y1 = dateParts(sc.termino).y + 1;
  const anos = []; for (let a = y0; a <= Math.max(y1, y0 + 1); a++) anos.push(a);
  const fer = [...(c.feriados || [])].sort((a, b) => a.data.localeCompare(b.data));
  return `<div class="stack" style="max-width:820px">
    <div class="card card-pad stack">
      <h2>Dados da obra</h2>
      <div class="grid-form">
        <label class="field">Nome da obra<input data-chg="obraField" data-f="nome" data-key="obraNome" value="${esc(o.nome)}"></label>
        <label class="field">Data de início<input type="date" data-chg="obraField" data-f="inicio" data-key="obraInicio" value="${o.inicio}"></label>
        <label class="field">Jornada (horas por dia)<input type="number" min="1" max="24" step="0.5" data-chg="calJornada" data-key="calJornada" value="${c.jornada}"></label>
      </div>
    </div>
    <div class="card card-pad stack">
      <h2>Dias úteis</h2>
      <div class="dias">${dn.map((d, i) => `<label><input type="checkbox" data-chg="calDia" data-d="${i}" ${c.dias.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
    </div>
    <div class="card card-pad stack">
      <div class="row between"><h2>Feriados e dias parados</h2>
        <div class="row"><select id="anoFer" style="width:auto">${anos.map((a) => `<option>${a}</option>`).join('')}</select>
        <button class="btn sm" data-act="addFeriadosNac">Adicionar feriados nacionais</button></div></div>
      <div class="row"><input type="date" id="ferData" style="width:auto"><input id="ferDesc" placeholder="Descrição (ex.: aniversário da cidade)" style="flex:1;min-width:160px" data-enter="addFeriado"><button class="btn" data-act="addFeriado">${I.plus} Adicionar</button></div>
      <div class="hol-list">${fer.length ? fer.map((f) => `<div class="list-item"><span><b>${f.data.split('-').reverse().join('/')}</b> <span class="muted">${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][S.weekday(S.toDay(f.data))]}</span> · ${esc(f.desc || '')}</span><button class="icon-btn danger" data-act="delFeriado" data-d="${f.data}" title="Remover">${I.trash}</button></div>`).join('') : '<div class="muted small">Nenhum feriado cadastrado.</div>'}</div>
    </div>
    <div class="card card-pad row">
      <button class="btn" data-act="dupObra">${I.copy} Duplicar obra</button>
      <span style="flex:1"></span>
      <button class="btn danger" data-act="delObra">${I.trash} Excluir obra</button>
    </div>
  </div>`;
}

/* ---------- Google Drive ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

function viewDrive() {
  const connected = drive.isConnected();
  const st = drive.status;
  const user = st.user || drive.savedUser();
  const last = store.meta.lastSync ? new Date(store.meta.lastSync).toLocaleString('pt-BR') : 'nunca';
  const origin = location.origin;
  return `<div class="page-head"><div><h1>Google Drive</h1><div class="muted">Armazenamento principal das suas obras</div></div></div>
  <div class="stack" style="max-width:820px">
    <div class="card card-pad stack">
      <div class="row between"><h2>Conta e conexão</h2><span class="badge ${connected ? (st.state === 'ok' ? 'good' : st.state === 'error' || st.state === 'auth' ? 'crit' : 'warn') : ''}">${connected ? esc(st.message || 'Conectado') : 'Não conectado'}</span></div>
      <div>${user ? `Conta: <b>${esc(user.displayName || '')}</b> ${esc(user.emailAddress || '')}<br>` : ''}Pasta no Drive: <b>Meu Drive › GEPLAN - Planejamento de Obras</b><br><span class="muted small">Última sincronização: ${last}</span></div>
      <div class="row"><button class="btn primary" data-act="syncNow">Sincronizar agora</button><button class="btn danger" data-act="logout">Sair</button></div>
      <div class="muted small">Ao sair, os dados deste aparelho são apagados (eles continuam no seu Google Drive). Use "Sair" em computadores ou celulares de outras pessoas.</div>
    </div>
    <details class="card card-pad">
      <summary style="cursor:pointer;font-weight:600">Autorizar outra pessoa</summary>
      <div class="stack" style="margin-top:12px">
        <p class="muted small" style="margin:0">1) Digite o e-mail Google da pessoa e gere o código. 2) Mande o código para quem mantém o site, para incluir em <code class="k">js/config.js</code>. 3) Adicione o mesmo e-mail em Google Cloud › Google Auth Platform › Público-alvo › <b>Usuários de teste</b>.</p>
        <div class="row"><input id="accessEmail" type="email" placeholder="email@gmail.com" style="flex:1;min-width:200px" data-enter="genAccessCode"><button class="btn" data-act="genAccessCode">Gerar código de acesso</button></div>
        <div id="accessCode"></div>
        <p class="muted small" style="margin:0">Cada pessoa usa o próprio Google Drive: ela não vê as suas obras.</p>
      </div>
    </details>
    <details class="card card-pad" ${drive.clientId() ? '' : 'open'}>
      <summary style="cursor:pointer;font-weight:600">Configuração do Google (Client ID)</summary>
      <div class="stack" style="margin-top:12px">
        <label class="field">Client ID OAuth<input id="clientId" value="${esc(drive.clientId())}" placeholder="0000000000-xxxxxxxx.apps.googleusercontent.com"></label>
        <div><button class="btn" data-act="saveClientId">Salvar Client ID</button></div>
        <ol class="small muted" style="margin:0;padding-left:18px">
          <li>Acesse <b>console.cloud.google.com</b> e crie um projeto (ex.: "GEPLAN").</li>
          <li>Em <b>APIs e serviços › Biblioteca</b>, ative a <b>Google Drive API</b>.</li>
          <li>Em <b>Tela de consentimento OAuth</b>: tipo Externo, preencha nome e e-mail e adicione seu e-mail como <b>usuário de teste</b>.</li>
          <li>Em <b>Credenciais › Criar credenciais › ID do cliente OAuth</b>: tipo <b>Aplicativo da Web</b>; em <b>Origens JavaScript autorizadas</b> adicione <code class="k">${esc(origin)}</code> (e os endereços do GitHub Pages e da Vercel).</li>
          <li>Copie o ID do cliente e cole acima (ou no arquivo <code class="k">js/config.js</code>).</li>
        </ol>
      </div>
    </details>
    <div class="card card-pad stack">
      <h2>Backup</h2>
      <p class="muted" style="margin:0">Cópia de segurança de todas as obras, etapas e composições em um arquivo.</p>
      <div class="row"><button class="btn" data-act="backupExport">Baixar backup (.json)</button>
        <label class="btn">Restaurar backup<input type="file" accept="application/json,.json" data-chg="backupImport" hidden></label></div>
    </div>
    ${installPrompt ? `<div class="card card-pad row between"><div><h2>Instalar como aplicativo</h2><div class="muted small">Abre em tela cheia e funciona sem internet.</div></div><button class="btn primary" data-act="install">Instalar</button></div>` : ''}
  </div>`;
}

/* ---------- pós-render ---------- */
function afterRender(route, prevScroll) {
  if (route.name !== 'obra') return;
  const o = store.obra(route.id);
  if (!o) return;
  if (route.tab === 'gantt') {
    const g = document.getElementById('gantt');
    if (!g) return;
    if (prevScroll != null) g.scrollLeft = prevScroll;
    else {
      const t = g.querySelector('.g-today');
      if (t) g.scrollLeft = Math.max(0, Number(t.getAttribute('x1')) - 120);
    }
  }
  if (route.tab === 'acompanhamento') drawCurvaS(o, S.compute(o, store.lib()));
}

/* ---------- ações (cliques) ---------- */
const curObra = () => store.obra(parseRoute().id);
const findEt = (o, id) => o.etapas.find((e) => e.id === id);
const findSrv = (o, eid, sid) => findEt(o, eid)?.servicos.find((s) => s.id === sid);
const move = (arr, item, dir) => {
  const i = arr.indexOf(item), j = i + Number(dir);
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
};

async function newComposicao(defaultName = '') {
  const v = await formDialog({
    title: 'Nova composição', ok: 'Criar',
    fields: [
      { name: 'nome', label: 'Nome do serviço', required: true, value: defaultName, placeholder: 'ex.: Alvenaria de vedação com bloco cerâmico' },
      { name: 'unidade', label: 'Unidade', required: true, value: 'm²', list: 'unidades' },
      { name: 'coef', label: 'Coeficiente (horas por unidade, 1 equipe)', type: 'number', step: 'any', min: 0, required: true, placeholder: 'ex.: 0,8', hint: 'Se você pensa em produção diária: coef = horas da jornada ÷ produção. Ex.: 10 m²/dia em 8 h → 0,8 h/m²' },
    ],
  });
  if (!v) return null;
  const c = { id: store.uid(), nome: v.nome.trim(), unidade: v.unidade.trim(), coef: num(v.coef), obs: '' };
  store.lib().composicoes.push(c);
  store.touch(store.lib());
  return c;
}

async function newEtapaLib() {
  const v = await formDialog({ title: 'Nova etapa', ok: 'Criar', fields: [{ name: 'nome', label: 'Nome da etapa', required: true, placeholder: 'ex.: Fundação' }] });
  if (!v) return null;
  const e = { id: store.uid(), nome: v.nome.trim(), arquivada: false };
  store.lib().etapas.push(e);
  store.touch(store.lib());
  return e;
}

function addEtapaToObra(o, etapaId) {
  o.etapas.push({ id: store.uid(), etapaId, servicos: [] });
}

const actions = {
  async newObra() {
    const v = await formDialog({
      title: 'Nova obra', ok: 'Criar obra',
      fields: [
        { name: 'nome', label: 'Nome da obra', required: true, placeholder: 'ex.: Residência Silva' },
        { name: 'inicio', label: 'Data de início', type: 'date', required: true, value: S.todayISO() },
      ],
    });
    if (!v) return;
    const o = store.newObra({ nome: v.nome.trim(), inicio: v.inicio });
    location.hash = `#/obra/${o.id}/orcamento`;
  },
  addEtapa() {
    const inp = document.getElementById('novaEtapa');
    const nome = inp.value.trim();
    if (!nome) return inp.focus();
    store.lib().etapas.push({ id: store.uid(), nome, arquivada: false });
    ui.pendingFocus = 'novaEtapa';
    commit(store.lib());
  },
  moveEtapaLib(d) {
    const lib = store.lib();
    const ativas = lib.etapas.filter((e) => !e.arquivada);
    const e = lib.etapas.find((x) => x.id === d.id);
    const other = ativas[ativas.indexOf(e) + Number(d.dir)];
    if (!other) return;
    const i = lib.etapas.indexOf(e), j = lib.etapas.indexOf(other);
    [lib.etapas[i], lib.etapas[j]] = [lib.etapas[j], lib.etapas[i]];
    commit(lib);
  },
  archiveEtapa(d) { store.lib().etapas.find((x) => x.id === d.id).arquivada = true; commit(store.lib()); toast('Etapa arquivada. As obras que já a usam não são afetadas.'); },
  unarchiveEtapa(d) { store.lib().etapas.find((x) => x.id === d.id).arquivada = false; commit(store.lib()); },
  async deleteEtapaLib(d) {
    const uso = etapaUso(d.id);
    if (uso) return toast(`Esta etapa está em ${uso} obra(s). Remova-a das obras antes de excluir.`);
    if (!(await ask('Excluir esta etapa definitivamente?', 'Excluir'))) return;
    const lib = store.lib();
    lib.etapas = lib.etapas.filter((x) => x.id !== d.id);
    commit(lib);
  },
  addComp() {
    const c = { id: store.uid(), nome: 'Nova composição', unidade: 'm²', coef: 0, obs: '' };
    store.lib().composicoes.push(c);
    ui.compFilter = '';
    ui.pendingFocus = `compNome:${c.id}`;
    commit(store.lib());
  },
  async deleteComp(d) {
    const uso = compUso(d.id);
    const c = store.lib().composicoes.find((x) => x.id === d.id);
    if (!(await ask(uso ? `A composição "${c?.nome}" é usada em ${uso} obra(s). Os serviços ficarão sem composição. Excluir mesmo assim?` : `Excluir a composição "${c?.nome}"?`, 'Excluir'))) return;
    const lib = store.lib();
    lib.composicoes = lib.composicoes.filter((x) => x.id !== d.id);
    commit(lib);
  },
  async addEtapaObra() {
    const o = curObra();
    const sel = document.getElementById('addEtapaSel');
    let id = sel.value;
    if (!id) return toast('Escolha uma etapa na lista.');
    if (id === '__new__') { const e = await newEtapaLib(); if (!e) return; id = e.id; }
    addEtapaToObra(o, id);
    commit(o);
  },
  addTodasEtapas() {
    const o = curObra();
    const used = new Set(o.etapas.map((e) => e.etapaId));
    store.lib().etapas.filter((e) => !e.arquivada && !used.has(e.id)).forEach((e) => addEtapaToObra(o, e.id));
    commit(o);
  },
  moveEtapaObra(d) { const o = curObra(); move(o.etapas, findEt(o, d.e), d.dir); commit(o); },
  async delEtapaObra(d) {
    const o = curObra();
    const et = findEt(o, d.e);
    if (et.servicos.length && !(await ask('Remover esta etapa e todos os seus serviços desta obra?', 'Remover'))) return;
    const ids = new Set([et.id, ...et.servicos.map((s) => s.id)]);
    o.etapas = o.etapas.filter((e) => e !== et);
    o.etapas.forEach((e) => e.servicos.forEach((s) => { s.preds = (s.preds || []).filter((p) => !ids.has(p.ref)); }));
    commit(o);
  },
  addSrv(d) {
    const o = curObra();
    const et = findEt(o, d.e);
    const ei = o.etapas.indexOf(et);
    let preds = [];
    if (et.servicos.length) preds = [{ ref: et.servicos[et.servicos.length - 1].id, lag: 0 }];
    else {
      const prev = [...o.etapas.slice(0, ei)].reverse().find((e) => e.servicos.length);
      if (prev) preds = [{ ref: prev.id, lag: 0 }];
    }
    const s = { id: store.uid(), composicaoId: '', descricao: '', quantidade: '', equipes: 1, duracaoFixa: '', preds, pct: 0, inicioReal: '', fimReal: '' };
    et.servicos.push(s);
    ui.pendingFocus = `srvComp:${s.id}`;
    commit(o);
  },
  moveSrv(d) { const o = curObra(); const et = findEt(o, d.e); move(et.servicos, findSrv(o, d.e, d.s), d.dir); commit(o); },
  delSrv(d) {
    const o = curObra();
    const et = findEt(o, d.e);
    et.servicos = et.servicos.filter((s) => s.id !== d.s);
    o.etapas.forEach((e) => e.servicos.forEach((s) => { s.preds = (s.preds || []).filter((p) => p.ref !== d.s); }));
    commit(o);
  },
  zoom(d) { ui.zoom = d.z; localStorage.setItem('planobras:zoom', d.z); document.querySelector('.gantt') && (document.querySelector('.gantt').scrollLeft = 0); render(); afterRenderResetScroll(); },
  async exportXlsx() {
    const o = curObra();
    try { toast('Gerando Excel…'); await exportExcel(o, S.compute(o, store.lib()), store.lib()); } catch (e) { toast(e.message); }
  },
  async exportPdf() {
    const o = curObra();
    try { toast('Gerando PDF…'); await exportPDF(o, S.compute(o, store.lib())); } catch (e) { toast(e.message); }
  },
  async saveBase() {
    const o = curObra();
    if (o.linhaBase && !(await ask('Substituir a linha de base atual pelo cronograma de hoje?', 'Substituir'))) return;
    const sc = S.compute(o, store.lib());
    const itens = {};
    sc.rows.forEach((r) => { itens[r.id] = { inicio: r.inicio, termino: r.termino }; });
    o.linhaBase = { data: S.todayISO(), itens };
    commit(o);
    toast('Linha de base salva.');
  },
  async clearBase() { const o = curObra(); if (!(await ask('Remover a linha de base?', 'Remover'))) return; o.linhaBase = null; commit(o); },
  registrarMedicao() {
    const o = curObra();
    const sc = S.compute(o, store.lib());
    const pr = S.progress(sc, S.toDay(ui.statusDate));
    o.medicoes = (o.medicoes || []).filter((m) => m.data !== ui.statusDate);
    o.medicoes.push({ data: ui.statusDate, real: pr.real, plan: pr.plan });
    commit(o);
    toast('Medição registrada.');
  },
  delMedicao(d) { const o = curObra(); o.medicoes = o.medicoes.filter((m) => m.data !== d.d); commit(o); },
  addFeriadosNac() {
    const o = curObra();
    const ano = Number(document.getElementById('anoFer').value);
    const have = new Set(o.calendario.feriados.map((f) => f.data));
    const novos = S.feriadosNacionais(ano).filter((f) => !have.has(f.data));
    o.calendario.feriados.push(...novos);
    commit(o);
    toast(`${novos.length} feriados de ${ano} adicionados (Carnaval e Corpus Christi são ponto facultativo; remova se trabalhar).`, 5000);
  },
  addFeriado() {
    const o = curObra();
    const data = document.getElementById('ferData').value;
    if (!data) return toast('Escolha a data.');
    if (o.calendario.feriados.some((f) => f.data === data)) return toast('Essa data já está na lista.');
    o.calendario.feriados.push({ data, desc: document.getElementById('ferDesc').value.trim() });
    commit(o);
  },
  delFeriado(d) { const o = curObra(); o.calendario.feriados = o.calendario.feriados.filter((f) => f.data !== d.d); commit(o); },
  dupObra() { const c = store.duplicateObra(curObra()); location.hash = `#/obra/${c.id}/orcamento`; toast('Obra duplicada.'); },
  async delObra() {
    const o = curObra();
    if (!(await ask(`Excluir a obra "${o.nome}"? O arquivo também irá para a lixeira do Google Drive.`, 'Excluir obra'))) return;
    store.deleteObra(o.id);
    location.hash = '#/obras';
  },
  async logout() {
    if (store.hasPending() && navigator.onLine) await drive.sync().catch(() => {});
    const msg = store.hasPending()
      ? 'Há alterações que ainda NÃO foram enviadas ao Google Drive e serão perdidas. Sair mesmo assim?'
      : 'Sair do GEPLAN neste aparelho? Seus dados continuam salvos no Google Drive.';
    if (!(await ask(msg, 'Sair'))) return;
    drive.disconnect();
    store.clearLocal();
    authorized = false;
    location.hash = '#/obras';
    render();
  },
  async genAccessCode() {
    const email = document.getElementById('accessEmail').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Digite um e-mail válido.');
    const code = await sha256(email);
    document.getElementById('accessCode').innerHTML = `<div class="alert info small">Código de acesso de <b>${esc(email)}</b>:<br><code class="k" style="word-break:break-all;user-select:all">${code}</code></div>`;
  },
  async syncNow() { await drive.sync({ interactive: true }).catch((e) => toast(e.message)); render(); },
  saveClientId() { drive.setClientId(document.getElementById('clientId').value); toast('Client ID salvo.'); render(); },
  backupExport() {
    const blob = new Blob([store.exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-planejamento-obras-${S.todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  async install() { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); },
};
function afterRenderResetScroll() {
  const g = document.getElementById('gantt');
  const t = g?.querySelector('.g-today');
  if (g) g.scrollLeft = t ? Math.max(0, Number(t.getAttribute('x1')) - 120) : 0;
}

/* ---------- alterações (campos) ---------- */
const changes = {
  etapaNome(d, el) { const e = store.lib().etapas.find((x) => x.id === d.id); if (!el.value.trim()) return render(); e.nome = el.value.trim(); commit(store.lib()); },
  compField(d, el) {
    const c = store.lib().composicoes.find((x) => x.id === d.id);
    if (d.f === 'coef') c.coef = Math.max(0, num(el.value));
    else if (d.f === 'nome') { if (!el.value.trim()) return render(); c.nome = el.value.trim(); }
    else c[d.f] = el.value.trim();
    commit(store.lib());
  },
  async srvComp(d, el) {
    const o = curObra();
    const s = findSrv(o, d.e, d.s);
    if (el.value === '__new__') {
      const c = await newComposicao();
      if (c) s.composicaoId = c.id;
    } else s.composicaoId = el.value;
    ui.pendingFocus = `srvQtd:${s.id}`;
    commit(o);
  },
  srvField(d, el) {
    const o = curObra();
    const s = findSrv(o, d.e, d.s);
    if (d.f === 'quantidade') s.quantidade = el.value === '' ? '' : Math.max(0, num(el.value));
    else if (d.f === 'equipes') s.equipes = Math.max(1, Math.round(num(el.value)) || 1);
    else if (d.f === 'duracaoFixa') s.duracaoFixa = el.value === '' ? '' : Math.max(0, Math.round(num(el.value)));
    else s[d.f] = el.value;
    commit(o);
  },
  srvPreds(d, el) {
    const o = curObra();
    const s = findSrv(o, d.e, d.s);
    try {
      s.preds = S.parsePreds(el.value, S.buildCodes(o), s.id);
      commit(o);
    } catch (e) {
      el.classList.add('invalid');
      toast(e.message, 4500);
    }
  },
  pct(d, el) {
    const o = curObra();
    const s = findSrv(o, d.e, d.s);
    s.pct = Math.min(100, Math.max(0, num(el.value)));
    if (s.pct > 0 && !s.inicioReal) s.inicioReal = ui.statusDate;
    if (s.pct >= 100 && !s.fimReal) s.fimReal = ui.statusDate;
    commit(o);
  },
  statusDate(d, el) { ui.statusDate = el.value || S.todayISO(); render(); },
  toggleCrit(d, el) { ui.showCrit = el.checked; render(); },
  toggleBase(d, el) { ui.showBase = el.checked; render(); },
  obraField(d, el) {
    const o = curObra();
    if (d.f === 'nome') { if (!el.value.trim()) return render(); o.nome = el.value.trim(); }
    if (d.f === 'inicio') { if (!el.value) return render(); o.inicio = el.value; }
    commit(o);
  },
  calJornada(d, el) { const o = curObra(); o.calendario.jornada = Math.min(24, Math.max(0.5, num(el.value) || 8)); commit(o); },
  calDia(d, el) {
    const o = curObra();
    const dia = Number(d.d);
    const set = new Set(o.calendario.dias);
    if (el.checked) set.add(dia); else set.delete(dia);
    if (!set.size) { toast('Deixe pelo menos um dia útil.'); return render(); }
    o.calendario.dias = [...set].sort();
    commit(o);
  },
  async backupImport(d, el) {
    const f = el.files[0];
    if (!f) return;
    if (!(await ask('Restaurar este backup? Os dados atuais neste aparelho serão substituídos.', 'Restaurar'))) { el.value = ''; return; }
    f.text().then((t) => { store.importAll(t); toast('Backup restaurado.'); render(); }).catch((e) => toast('Erro: ' + e.message));
  },
};

$view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  actions[el.dataset.act]?.(el.dataset, el, e);
});
$view.addEventListener('change', (e) => {
  const el = e.target.closest('[data-chg]');
  if (!el) return;
  changes[el.dataset.chg]?.(el.dataset, el);
});
$view.addEventListener('input', (e) => {
  const el = e.target.closest('[data-inp]');
  if (el?.dataset.inp === 'compFilter') { ui.compFilter = el.value; render(); }
});
$view.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter]');
  if (el) { e.preventDefault(); actions[el.dataset.enter]?.(el.dataset, el); }
});
document.getElementById('newObraTop')?.addEventListener('click', () => actions.newObra());

/* ---------- indicador de sincronização ---------- */
function renderSync() {
  const st = drive.status;
  const map = {
    local: ['', 'Só neste aparelho'], busy: ['busy', 'Sincronizando…'], ok: ['ok', 'Salvo no Drive'],
    pending: ['pending', 'Enviando…'], offline: ['pending', 'Offline'], auth: ['err', 'Reconectar Drive'], error: ['err', 'Erro no Drive'],
  };
  const [cls, label] = map[st.state] || map.local;
  $sync.className = `sync ${cls}`;
  $sync.title = st.message || (st.state === 'local' ? 'Conecte o Google Drive para salvar na nuvem' : '');
  $sync.innerHTML = `<span class="dot"></span>${label}`;
}
$sync.addEventListener('click', async (e) => {
  if (drive.status.state === 'auth') {
    e.preventDefault();
    try { await drive.sync({ interactive: true }); } catch (err) { toast(err.message); }
  }
});

drive.onStatus(() => { renderSync(); if (parseRoute().name === 'drive') queueRender(); });
window.addEventListener('planobras:remote-change', () => { queueRender(); toast('Dados atualizados a partir do Google Drive.'); });
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// Início: entra direto se esta conta já fez login neste aparelho e está autorizada
(async () => {
  const u = drive.savedUser();
  authorized = drive.isConnected() && (await isAllowed(u?.emailAddress));
  if (!authorized && drive.isConnected()) { drive.disconnect(); store.clearLocal(); }
  if (authorized && !store.meta.owner) { store.meta.owner = u.emailAddress.toLowerCase(); store.saveMeta(); }
  render();
  renderSync();
  if (authorized) drive.init();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
