// Telas da obra: Orçamento, Vínculos (orçamento × EAP), Atividades (EAP + cronograma), Gantt, Curva S,
// Acompanhamento e Configurações.
import * as store from './store.js';
import { calcular, fmtPct, liderDe } from './calculo.js';
import { cronograma, criaCiclo } from './cpm.js';
import { curvaS, avanco, fracPlanejada } from './curvaS.js';
import { formatNotacao, resolverNotacao } from './predecessoras.js';
import { filhosDe, renumerar, novaAtividade, novoItem, novaComposicao, TIPOS, DURACAO_PADRAO, uid } from './model.js';
import { toDay, fmtBR, isoBR, todayDay, todayISO, fmtNum, fmtNumFix, fmtBRL, dateParts, MESES, weekday, feriadosNacionais } from './schedule.js';
import { esc, I, ui, toast, formDialog, ask, info, commit, queueRender, parseNum, fmtIn } from './ui.js';
import { exportExcel, exportPDF } from './export.js';
import { modeloDaEAP } from './importador.js';

export const TABS = [
  ['orcamento', 'Orçamento'], ['vinculos', 'Vínculos'], ['atividades', 'Atividades'], ['gantt', 'Gantt'],
  ['curva', 'Curva S'], ['acompanhamento', 'Acompanhamento'], ['config', 'Configurações'],
];

const natural = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
const vazio = (v) => v === '' || v === null || v === undefined;

/* ---------- contexto calculado ---------- */
export function contexto(o) {
  const lib = store.lib();
  const calc = calcular(o, lib);
  const cron = cronograma(o, lib, calc);
  const filhos = filhosDe(o);
  const porId = new Map(o.eap.map((a) => [a.id, a]));
  const idPorCodigo = new Map(o.eap.map((a) => [a.codigo, a.id]));
  const codigoDe = (id) => porId.get(id)?.codigo || '';
  const depsDe = new Map();
  for (const d of o.dependencias) { if (!depsDe.has(d.atividadeId)) depsDe.set(d.atividadeId, []); depsDe.get(d.atividadeId).push(d); }
  const predsTexto = (a) => formatNotacao(depsDe.get(a.id) || [], codigoDe) || a.predTexto || '';
  return { o, lib, calc, cron, filhos, porId, idPorCodigo, codigoDe, depsDe, predsTexto };
}

/* ---------- árvore: expandir/recolher ---------- */
function expSet(o) {
  if (!ui.expandidos[o.id]) {
    let s = [];
    try { s = JSON.parse(localStorage.getItem(`planobras:exp:${o.id}`) || '[]'); } catch {}
    ui.expandidos[o.id] = new Set(s);
  }
  return ui.expandidos[o.id];
}
function salvarExp(o) { try { localStorage.setItem(`planobras:exp:${o.id}`, JSON.stringify([...expSet(o)])); } catch {} }
/** Nível 1 começa aberto; os demais fechados. O conjunto guarda as exceções. */
const aberto = (o, a) => (a.nivel === 1) !== expSet(o).has(a.id);

/** Linhas visíveis da árvore (respeitando busca e filtro de alertas). */
function linhasVisiveis(c, { busca = '', soAlertas = false } = {}) {
  const { o, filhos, calc } = c;
  const termo = busca.trim().toLowerCase();
  const filtro = termo || soAlertas;
  const casa = (a) => {
    const A = calc.ativ.get(a.id);
    if (soAlertas && !(A.alertas.length || c.cron.nos.get(a.id)?.ciclo)) return false;
    if (termo && !(`${a.codigo} ${a.descricao}`.toLowerCase().includes(termo))) return false;
    return true;
  };
  const out = [];
  const visita = (parentId) => {
    for (const a of filhos.get(parentId) || []) {
      const temF = (filhos.get(a.id) || []).length > 0;
      if (filtro) {
        const ini = out.length;
        out.push(a);
        visita(a.id);
        if (out.length === ini + 1 && !casa(a)) out.pop();
        continue;
      }
      out.push(a);
      if (temF && aberto(o, a)) visita(a.id);
    }
  };
  visita(null);
  return out;
}

/* ---------- cabeçalho da obra ---------- */
export function viewObra(route) {
  const o = store.obra(route.id);
  if (!o) return `<div class="card empty"><p>Obra não encontrada.</p><a class="btn" href="#/obras">Voltar</a></div>`;
  const c = contexto(o);
  const tab = TABS.some(([k]) => k === route.tab) ? route.tab : 'atividades';
  const body = { orcamento: tabOrcamento, vinculos: tabVinculos, atividades: tabAtividades, gantt: tabGantt, curva: tabCurva, acompanhamento: tabAcompanhamento, config: tabConfig }[tab](c);
  const temEAP = o.eap.length > 0;
  const alertas = c.calc.alertasItens + c.calc.alertasAtiv;
  return `<div class="page-head" style="margin-bottom:10px"><div>
      <a href="#/obras" class="muted small" style="text-decoration:none">← Obras</a>
      <h1>${esc(o.nome)}</h1>
      <div class="row small muted">
        <span>Início <b class="ink">${fmtBR(c.cron.inicio)}</b></span>·
        <span>Término <b class="ink">${temEAP ? fmtBR(c.cron.termino) : '—'}</b></span>·
        <span><b class="ink">${c.cron.durTotal}</b> dias úteis</span>·
        <span><b class="ink">${fmtNum(c.calc.totalHH, 0)}</b> HH</span>·
        <span><b class="ink">${fmtBRL(c.calc.totalOrcamento)}</b></span>
        ${alertas ? `· <a href="#/obra/${o.id}/atividades" data-act="verAlertas" class="badge warn" style="text-decoration:none">${I.alert} ${alertas} alerta${alertas > 1 ? 's' : ''}</a>` : ''}
      </div></div></div>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/obra/${o.id}/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</nav>
    ${c.cron.ciclo ? `<div class="alert err" style="margin-bottom:14px"><b>Dependência circular</b> entre ${c.cron.cicloIds.map((id) => c.codigoDe(id)).slice(0, 12).join(', ')}. Revise as predecessoras.</div>` : ''}
    ${body}`;
}

/* =====================================================================
   ORÇAMENTO
   ===================================================================== */
function compOptions(lib, selected) {
  const ativas = lib.composicoes.filter((x) => x.ativa || x.id === selected).sort((a, b) => natural(a.codigo, b.codigo));
  return `<option value="">— Composição —</option>`
    + ativas.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.codigo)} — ${esc(x.descricao)} (${esc(x.unidade)})${x.ativa ? '' : ` · v${x.versao} inativa`}</option>`).join('')
    + `<option value="__new__">＋ Nova composição…</option>`;
}

function badgeItem(I_) {
  if (I_.status === 'OK') return '<span class="badge good">OK</span>';
  if (I_.status === 'Sem vínculo') return '<span class="badge warn">Sem vínculo</span>';
  return `<span class="badge crit">Verificar · ${fmtPct(I_.pctSoma)}</span>`;
}

function tabOrcamento(c) {
  const { o, calc, lib } = c;
  const f = ui.orcFilter.trim().toLowerCase();
  const itens = [...o.orcamento].sort((a, b) => natural(a.codigo, b.codigo))
    .filter((it) => !f || `${it.codigo} ${it.etapa} ${it.subetapa} ${calc.itens.get(it.id).comp?.descricao || ''}`.toLowerCase().includes(f));
  const grupos = new Map();
  for (const it of itens) {
    const k = it.etapa || '(sem etapa)';
    if (!grupos.has(k)) grupos.set(k, new Map());
    const s = it.subetapa || '';
    if (!grupos.get(k).has(s)) grupos.get(k).set(s, []);
    grupos.get(k).get(s).push(it);
  }
  let rows = '';
  for (const [etapa, subs] of grupos) {
    const totE = [...subs.values()].flat().reduce((s, it) => s + calc.itens.get(it.id).total, 0);
    rows += `<tr class="lvl1"><td colspan="6">${esc(etapa)}</td><td class="num">${fmtBRL(totE)}</td><td colspan="2"></td></tr>`;
    for (const [sub, lista] of subs) {
      if (sub) rows += `<tr class="lvl2"><td></td><td colspan="8">${esc(sub)}</td></tr>`;
      for (const it of lista) {
        const X = calc.itens.get(it.id);
        rows += `<tr>
          <td><input class="cell w-code" data-chg="itemField" data-f="codigo" data-id="${it.id}" data-key="ic:${it.id}" value="${esc(it.codigo)}"></td>
          <td style="min-width:260px"><select class="cell" data-chg="itemComp" data-id="${it.id}" data-key="icomp:${it.id}">${compOptions(lib, it.composicaoId)}</select>
            ${X.comp && X.lider ? `<div class="muted small">líder: ${esc(X.lider.funcao)} · ${fmtNum(X.lider.coef, 4)} h/${esc(X.comp.unidade)}</div>` : ''}</td>
          <td>${esc(X.comp?.unidade || '')}</td>
          <td><input class="cell w-num" inputmode="decimal" data-chg="itemField" data-f="quantidade" data-id="${it.id}" data-key="iq:${it.id}" value="${fmtIn(it.quantidade, 4)}"></td>
          <td><input class="cell w-num" inputmode="decimal" data-chg="itemField" data-f="custoUnit" data-id="${it.id}" data-key="iu:${it.id}" value="${fmtIn(it.custoUnit, 2)}"></td>
          <td class="num">${fmtNum(X.vinculos.reduce((s, r) => s + r.hh, 0), 1)}</td>
          <td class="num nowrap">${fmtBRL(X.total)}</td>
          <td><a href="#/obra/${o.id}/vinculos" data-act="irVinculo" data-id="${it.id}" style="text-decoration:none">${badgeItem(X)}</a></td>
          <td class="nowrap"><button class="icon-btn" title="Editar etapa/subetapa" data-act="itemEditar" data-id="${it.id}">${I.more}</button><button class="icon-btn danger" title="Excluir item" data-act="itemExcluir" data-id="${it.id}">${I.trash}</button></td>
        </tr>`;
      }
    }
  }
  const pend = [...calc.itens.values()].filter((x) => x.status !== 'OK').length;
  return `<div class="stack">
    <div class="row">
      <input data-inp="orcFilter" data-key="orcFilter" value="${esc(ui.orcFilter)}" placeholder="Buscar item, etapa ou composição…" style="flex:1;min-width:200px">
      <button class="btn primary" data-act="itemNovo">${I.plus} Item</button>
      <button class="btn" data-act="exportXlsx">Exportar Excel</button>
    </div>
    ${pend ? `<div class="alert err">${pend} ite${pend > 1 ? 'ns' : 'm'} do orçamento com vínculo diferente de 100% — veja a aba <a href="#/obra/${o.id}/vinculos">Vínculos</a>.</div>` : ''}
    ${o.orcamento.length ? `<div class="card table-wrap"><table class="data">
      <thead><tr><th>Item</th><th>Composição</th><th>Un.</th><th class="num">Quantidade</th><th class="num">Custo unit. (R$)</th><th class="num">HH</th><th class="num">Total</th><th>Vínculo EAP</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5"><b>Total do orçamento</b></td><td class="num"><b>${fmtNum(calc.totalHH, 1)}</b></td><td class="num nowrap"><b>${fmtBRL(calc.totalOrcamento)}</b></td><td colspan="2" class="small muted">alocado na EAP: ${fmtBRL(calc.totalAlocado)}</td></tr></tfoot>
    </table></div>` : `<div class="card empty"><p>Nenhum item no orçamento.</p><button class="btn primary" data-act="itemNovo">${I.plus} Adicionar item</button></div>`}
    <div class="muted small">HH = quantidade × coeficiente da função líder da composição. Total = quantidade × custo unitário. Cada item precisa ser distribuído 100% entre as atividades da EAP (aba Vínculos).</div>
  </div>`;
}

/* =====================================================================
   VÍNCULOS (orçamento × EAP)
   ===================================================================== */
function datalistAtividades(c) {
  const folhas = c.o.eap.filter((a) => !(c.filhos.get(a.id) || []).length);
  return `<datalist id="dl-ativ">${folhas.map((a) => `<option value="${esc(a.codigo)} — ${esc(a.descricao)}"></option>`).join('')}</datalist>`;
}
const rotuloAtiv = (c, id) => { const a = c.porId.get(id); return a ? `${a.codigo} — ${a.descricao}` : ''; };

function tabVinculos(c) {
  const { o, calc } = c;
  const f = ui.orcFilter.trim().toLowerCase();
  const porCalc = new Map(calc.vinculos.map((r) => [r.v.id, r]));
  let itens = [...o.orcamento].sort((a, b) => natural(a.codigo, b.codigo));
  if (ui.vincFilter === 'verificar') itens = itens.filter((it) => calc.itens.get(it.id).status !== 'OK');
  if (f) itens = itens.filter((it) => `${it.codigo} ${calc.itens.get(it.id).comp?.descricao || ''}`.toLowerCase().includes(f));
  const cards = itens.map((it) => {
    const X = calc.itens.get(it.id);
    const vs = o.vinculos.filter((v) => v.itemId === it.id);
    const soma = vs.reduce((s, v) => s + (Number(v.pct) || 0), 0);
    const cls = Math.round(soma * 10000) === 10000 ? 'ok' : soma > 1 ? 'over' : 'under';
    const linhas = vs.map((v) => {
      const r = porCalc.get(v.id);
      return `<tr>
        <td style="min-width:260px"><input class="cell" list="dl-ativ" data-chg="vincAtiv" data-id="${v.id}" data-key="va:${v.id}" value="${esc(rotuloAtiv(c, v.atividadeId))}" placeholder="Digite o código da atividade (ex.: 2.4.4)"></td>
        <td><div class="qty"><input class="cell w-pct" inputmode="decimal" data-chg="vincPct" data-id="${v.id}" data-key="vp:${v.id}" value="${fmtIn((Number(v.pct) || 0) * 100, 4)}"><span>%</span></div></td>
        <td class="num nowrap">${r ? `${fmtNum(r.qtd, 3)} ${esc(r.unidade)}` : '—'}</td>
        <td class="num">${r ? fmtNum(r.hh, 2) : '—'}</td>
        <td class="num nowrap">${r ? fmtBRL(r.custo) : '—'}</td>
        <td><button class="icon-btn danger" title="Remover vínculo" data-act="vincExcluir" data-id="${v.id}">${I.trash}</button></td>
      </tr>`;
    }).join('');
    return `<div class="card vinc-card" id="item-${it.id}">
      <div class="vinc-head">
        <div><b>${esc(it.codigo)}</b> ${esc(X.comp?.descricao || '(sem composição)')}
          <div class="muted small">${fmtNum(it.quantidade, 3)} ${esc(X.comp?.unidade || '')} · ${fmtBRL(X.total)} · ${X.lider ? `${esc(X.lider.funcao)} ${fmtNum(X.lider.coef, 4)} h/${esc(X.comp.unidade)}` : 'sem função líder'}</div></div>
        ${badgeItem(X)}
      </div>
      <div class="pctbar ${cls}" title="${fmtPct(soma)} vinculado"><div style="width:${Math.min(100, soma * 100)}%"></div></div>
      ${vs.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Atividade da EAP</th><th>% da quantidade</th><th class="num">Qtd alocada</th><th class="num">HH</th><th class="num">Custo alocado</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>` : ''}
      <div class="row" style="padding:8px 12px">
        <button class="btn sm" data-act="vincNovo" data-id="${it.id}">${I.link} Vincular atividade</button>
        ${vs.length > 1 ? `<button class="btn sm" data-act="vincIgual" data-id="${it.id}">Distribuir igualmente</button>` : ''}
        ${vs.length && cls !== 'ok' ? `<button class="btn sm" data-act="vincCompletar" data-id="${it.id}">Completar 100% na última</button>` : ''}
      </div>
    </div>`;
  }).join('');
  const nV = [...calc.itens.values()].filter((x) => x.status !== 'OK').length;
  return `<div class="stack">
    ${datalistAtividades(c)}
    <div class="row">
      <div class="seg">${[['todos', 'Todos'], ['verificar', `Verificar (${nV})`]].map(([k, l]) => `<button data-act="vincFiltro" data-f="${k}" class="${ui.vincFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input data-inp="orcFilter" data-key="vincBusca" value="${esc(ui.orcFilter)}" placeholder="Buscar item…" style="flex:1;min-width:180px">
    </div>
    <div class="muted small">Distribua a quantidade de cada item do orçamento entre as atividades da EAP. A soma deve dar 100%. Ex.: aço O-2.02 → 60% corte e dobra (2.4.3) + 40% montagem (2.4.5).</div>
    ${cards || `<div class="card empty"><p>${o.orcamento.length ? 'Nenhum item com esse filtro.' : 'Cadastre itens na aba Orçamento.'}</p></div>`}
  </div>`;
}

/* =====================================================================
   ATIVIDADES (EAP + cronograma)
   ===================================================================== */
function desvioLB(c, a) {
  const b = c.o.linhaBase?.itens?.[a.id];
  const n = c.cron.nos.get(a.id);
  if (!b || !n) return null;
  return c.cron.cal.idxPrev(n.termino) - c.cron.cal.idxPrev(b.termino);
}

function tabAtividades(c) {
  const { o, calc, cron, filhos } = c;
  const linhas = linhasVisiveis(c, { busca: ui.ativFilter, soAlertas: ui.ativSoAlertas });
  const temLB = !!o.linhaBase;
  const criticas = [...cron.nos.values()].filter((n) => n.folha && n.critico).length;
  const rows = linhas.map((a) => {
    const A = calc.ativ.get(a.id), n = cron.nos.get(a.id);
    const temF = (filhos.get(a.id) || []).length > 0;
    const ab = temF && aberto(o, a);
    const ind = (a.nivel - 1) * 14;
    const alertas = [...A.alertas, ...(n.ciclo ? ['Dependência circular'] : [])];
    const dv = temLB ? desvioLB(c, a) : null;
    const leaf = !temF;
    return `<tr class="lvl${Math.min(a.nivel, 3)}${n.critico && ui.showCrit && leaf ? ' crit-row' : ''}">
      <td class="nowrap code-cell" style="padding-left:${6 + ind}px">${temF ? `<button class="tog" data-act="toggle" data-id="${a.id}" aria-label="${ab ? 'Recolher' : 'Expandir'}">${ab ? I.down : I.right}</button>` : '<span class="tog-sp"></span>'}${esc(a.codigo)}</td>
      <td class="desc"><input class="cell" data-chg="atvField" data-f="descricao" data-id="${a.id}" data-key="ad:${a.id}" value="${esc(a.descricao)}"></td>
      <td>${leaf ? `<select class="cell w-tipo" data-chg="atvField" data-f="tipo" data-id="${a.id}">${TIPOS.map((t) => `<option ${t === a.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}</td>
      <td class="small">${esc(A.funcaoLider || (leaf ? '—' : ''))}</td>
      <td class="num">${A.hh ? fmtNum(A.hh, 1) : ''}</td>
      <td>${leaf ? `<input class="cell w-sm" inputmode="numeric" data-chg="atvField" data-f="equipe" data-id="${a.id}" data-key="ae:${a.id}" value="${vazio(a.equipe) ? '' : fmtIn(a.equipe, 2)}" placeholder="—">` : ''}</td>
      <td class="num">${leaf ? (A.durCalc ?? '—') : ''}</td>
      <td>${leaf ? `<input class="cell w-sm" inputmode="numeric" data-chg="atvField" data-f="duracaoManual" data-id="${a.id}" data-key="am:${a.id}" value="${vazio(a.duracaoManual) ? '' : a.duracaoManual}" placeholder="—">` : ''}</td>
      <td class="num"><b class="${A.provisoria ? 'prov' : ''}" title="${A.provisoria ? 'Duração provisória (padrão do tipo)' : ''}">${n.dur}</b></td>
      <td class="nowrap">${fmtBR(n.inicio)}${a.inicioReal ? ' <span class="badge info" title="Início real">R</span>' : a.inicioFixado ? ' <span class="badge" title="Início fixado">F</span>' : ''}</td>
      <td class="nowrap">${fmtBR(n.termino)}</td>
      <td>${leaf ? `<input class="cell w-pred" data-chg="atvPred" data-id="${a.id}" data-key="ap:${a.id}" value="${esc(c.predsTexto(a))}" placeholder="ex.: 2.4.2 ou 3.1 II+5">` : `<span class="muted small" title="${esc(a.obs || '')}">${esc((a.obs || '').replace(/^Predecessora original \(resumo\): /, 'orig.: '))}</span>`}</td>
      <td class="num">${n.ciclo ? '—' : n.folga}</td>
      <td class="num nowrap">${A.custo ? fmtBRL(A.custo) : ''}</td>
      ${temLB ? `<td class="num">${dv == null ? '' : dv > 0 ? `<span class="badge crit">+${dv}</span>` : dv < 0 ? `<span class="badge good">${dv}</span>` : '0'}</td>` : ''}
      <td class="nowrap">${alertas.length ? `<span class="warn-ico" title="${esc(alertas.join('\n'))}">${I.alert}</span>` : ''}${leaf && n.critico && ui.showCrit ? '<span class="badge crit" title="Caminho crítico">C</span>' : ''}</td>
      <td><button class="icon-btn" title="Mais opções" data-act="atvMenu" data-id="${a.id}">${I.more}</button></td>
    </tr>`;
  }).join('');
  const nAl = [...calc.ativ.values()].filter((x) => x.alertas.length).length;
  return `<div class="stack">
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Início</div><div class="k-value">${fmtBR(cron.inicio)}</div></div>
      <div class="card kpi"><div class="k-label">Término previsto</div><div class="k-value">${o.eap.length ? fmtBR(cron.termino) : '—'}</div></div>
      <div class="card kpi"><div class="k-label">Prazo</div><div class="k-value">${cron.durTotal}</div><div class="k-sub">dias úteis</div></div>
      <div class="card kpi"><div class="k-label">Caminho crítico</div><div class="k-value">${criticas}</div><div class="k-sub">atividades sem folga</div></div>
      <div class="card kpi"><div class="k-label">Alertas</div><div class="k-value" style="color:${nAl ? 'var(--warn)' : 'inherit'}">${nAl}</div><div class="k-sub">atividades</div></div>
    </div>
    <div class="row">
      <input data-inp="ativFilter" data-key="ativFilter" value="${esc(ui.ativFilter)}" placeholder="Buscar código ou atividade…" style="flex:1;min-width:180px">
      <label class="check"><input type="checkbox" data-chg="soAlertas" ${ui.ativSoAlertas ? 'checked' : ''}> Só com alertas</label>
      <div class="seg"><button data-act="expNivel" data-n="1">Etapas</button><button data-act="expNivel" data-n="2">Subetapas</button><button data-act="expNivel" data-n="9">Tudo</button></div>
    </div>
    <div class="row">
      <button class="btn sm" data-act="atvNovaEtapa">${I.plus} Etapa</button>
      <button class="btn sm" data-act="exportXlsx">Exportar Excel</button>
      <button class="btn sm" data-act="exportPdf">Exportar PDF</button>
      <span style="flex:1"></span>
      ${temLB ? `<span class="muted small">Linha de base de ${isoBR(o.linhaBase.data)}</span><button class="btn sm" data-act="saveBase">Atualizar linha de base</button><button class="btn sm danger" data-act="clearBase">Remover</button>`
        : `<button class="btn sm" data-act="saveBase" title="Congela o cronograma atual para comparar depois">Salvar linha de base</button>`}
    </div>
    ${o.eap.length ? `<div class="card table-wrap tree-wrap"><table class="data tree">
      <thead><tr><th>Código</th><th>Atividade</th><th>Tipo</th><th>Função líder</th><th class="num">HH</th><th>Equipe</th><th class="num" title="Duração calculada">Calc.</th><th title="Duração manual">Manual</th><th class="num" title="Duração adotada (dias úteis)">Dur.</th><th>Início</th><th>Término</th><th>Predecessoras</th><th class="num">Folga</th><th class="num">Custo</th>${temLB ? '<th class="num" title="Desvio do término em relação à linha de base (dias úteis)">LB</th>' : ''}<th></th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="17" class="muted">Nenhuma atividade com esse filtro.</td></tr>`}</tbody></table></div>`
      : `<div class="card empty"><p>A obra ainda não tem EAP.</p><button class="btn primary" data-act="atvNovaEtapa">${I.plus} Criar a primeira etapa</button></div>`}
    <div class="muted small"><b>Duração</b> = ARRED.PARA.CIMA(HH ÷ (equipe × ${fmtNum(calc.jornada)} h × ${fmtNum(calc.eficiencia)})). A duração manual tem prioridade. Valores em <i class="prov">itálico</i> são provisórios (padrão do tipo).
    <b>Predecessoras:</b> <code class="k">3.2</code> término→início · <code class="k">3.2 TI-10</code> começa 10 dias úteis antes do fim · <code class="k">3.1 II+5</code> 5 dias após o início · <code class="k">6.1/6.2 TI-5</code> várias.</div>
  </div>`;
}

/* =====================================================================
   GANTT
   ===================================================================== */
const ZOOM = { dia: 22, semana: 8, mes: 2.6 };
const ROW_H = 30, HEAD_H = 42;

function tabGantt(c) {
  const { o, cron, calc, filhos } = c;
  if (!o.eap.length) return `<div class="card empty"><p>Monte a EAP para gerar o Gantt.</p></div>`;
  const linhas = linhasVisiveis(c, { busca: ui.ativFilter });
  const temLB = !!o.linhaBase;
  const dw = ZOOM[ui.zoom] || 8;
  const today = todayDay();
  let d0 = cron.inicio, d1 = cron.termino;
  if (temLB && ui.showBase) for (const b of Object.values(o.linhaBase.itens)) { d0 = Math.min(d0, b.inicio); d1 = Math.max(d1, b.termino); }
  d0 -= ui.zoom === 'dia' ? 2 : 7; d1 += ui.zoom === 'dia' ? 6 : 21;
  const W = (d1 - d0 + 1) * dw;
  const x = (d) => (d - d0) * dw;
  const H = linhas.length * ROW_H;
  const yOf = new Map(linhas.map((a, i) => [a.id, i * ROW_H]));

  let head = '';
  for (let d = d0; d <= d1; d++) {
    const p = dateParts(d);
    if (p.d === 1 || d === d0) {
      head += `<line class="g-grid" x1="${x(d)}" y1="0" x2="${x(d)}" y2="${HEAD_H}"/>`;
      const proxMes = d + (new Date(Date.UTC(p.y, p.m + 1, 1)).getTime() / 86400000 - d);
      const cabe = (Math.min(proxMes, d1) - d) * dw > 44;
      if (cabe) head += `<text x="${x(d) + 4}" y="15" style="font-weight:600">${MESES[p.m]}/${String(p.y).slice(2)}</text>`;
    }
    if (ui.zoom === 'dia') head += `<text x="${x(d) + dw / 2}" y="34" text-anchor="middle" ${cron.cal.isWork(d) ? '' : 'opacity=".45"'}>${p.d}</text>`;
    else if (ui.zoom === 'semana' && weekday(d) === 1) head += `<text x="${x(d) + 2}" y="34">${p.d}</text><line class="g-grid" x1="${x(d)}" y1="22" x2="${x(d)}" y2="${HEAD_H}"/>`;
  }
  let bg = '', bars = '', arrows = '';
  if (ui.zoom !== 'mes') for (let d = d0; d <= d1; d++) if (!cron.cal.isWork(d)) bg += `<rect class="g-nonwork" x="${x(d)}" y="0" width="${dw}" height="${H}"/>`;
  for (let d = d0; d <= d1; d++) if (dateParts(d).d === 1) bg += `<line class="g-grid" x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}"/>`;
  linhas.forEach((a, i) => {
    if (a.nivel === 1) bg += `<rect class="g-etaparow" x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}"/>`;
    bg += `<line class="g-rowline" x1="0" y1="${(i + 1) * ROW_H - 0.5}" x2="${W}" y2="${(i + 1) * ROW_H - 0.5}"/>`;
  });
  const vis = new Set(linhas.map((a) => a.id));
  for (const a of linhas) {
    const n = cron.nos.get(a.id), A = calc.ativ.get(a.id), y = yOf.get(a.id);
    const tip = `${a.codigo} ${a.descricao}\n${fmtBR(n.inicio)} → ${fmtBR(n.termino)} · ${n.dur} dia(s) úteis${A.provisoria ? ' (provisória)' : ''}\n${A.hh ? `${fmtNum(A.hh, 1)} HH · ` : ''}${A.custo ? `${fmtBRL(A.custo)} · ` : ''}folga ${n.folga}${n.critico ? ' · CRÍTICA' : ''}`;
    if (!n.folha) {
      const bx = x(n.inicio), bw = Math.max(3, x(n.termino + 1) - bx);
      bars += `<g><title>${esc(tip)}</title><path class="g-etapa" d="M${bx} ${y + 10}h${bw}v7l-4 -3H${bx + 4}l-4 3z"/></g>`;
      continue;
    }
    if (temLB && ui.showBase) {
      const b = o.linhaBase.itens[a.id];
      if (b) bars += `<rect class="g-base" x="${x(b.inicio)}" y="${y + ROW_H - 7}" width="${Math.max(2, x(b.termino + 1) - x(b.inicio))}" height="3" rx="1.5"/>`;
    }
    if (n.dur === 0) { const cx = x(n.inicio); bars += `<g><title>${esc(tip)}</title><path class="g-ms" d="M${cx} ${y + 8}l7 7-7 7-7-7z"/></g>`; continue; }
    const crit = ui.showCrit && n.critico ? ' crit' : '';
    const bx = x(n.inicio), bw = Math.max(3, x(n.termino + 1) - bx), by = y + 7, bh = ROW_H - 14 - (temLB && ui.showBase ? 3 : 0);
    const pct = Math.min(100, Number(a.pct) || 0);
    bars += `<g><title>${esc(tip)}</title><rect class="g-bar${crit}${A.provisoria ? ' prov' : ''}" x="${bx + 1}" y="${by}" width="${bw - 2}" height="${bh}" rx="3"/>
      ${pct > 0 ? `<rect class="g-prog${crit}" x="${bx + 1}" y="${by}" width="${Math.max(0, (bw - 2) * pct / 100)}" height="${bh}" rx="3"/>` : ''}</g>`;
    for (const dpd of c.depsDe.get(a.id) || []) {
      if (!vis.has(dpd.predecessoraId)) continue;
      const p = cron.nos.get(dpd.predecessoraId);
      const sy = yOf.get(dpd.predecessoraId) + ROW_H / 2, ty = y + ROW_H / 2;
      const sx = dpd.tipo === 'SS' ? x(p.inicio) : x(p.termino + 1) - 1;
      const tx = bx + 1;
      const path = dpd.tipo === 'SS'
        ? `M${sx} ${sy}H${sx - 5}V${ty}H${tx - 2}`
        : tx >= sx + 10 ? `M${sx} ${sy}H${sx + 5}V${ty}H${tx - 2}` : `M${sx} ${sy}H${sx + 5}V${y - 1}H${tx - 8}V${ty}H${tx - 2}`;
      arrows += `<path class="g-arrow" d="${path}" marker-end="url(#ah)"/>`;
    }
  }
  const todayLine = today >= d0 && today <= d1 ? `<line class="g-today" x1="${x(today) + dw / 2}" y1="0" x2="${x(today) + dw / 2}" y2="${H}"><title>Hoje</title></line>` : '';
  const left = linhas.map((a) => {
    const temF = (filhos.get(a.id) || []).length > 0, ab = temF && aberto(o, a);
    return `<div class="g-row lvl${Math.min(a.nivel, 3)}" style="padding-left:${4 + (a.nivel - 1) * 12}px">${temF ? `<button class="tog" data-act="toggle" data-id="${a.id}">${ab ? I.down : I.right}</button>` : '<span class="tog-sp"></span>'}<span class="g-code">${esc(a.codigo)}</span><span class="g-name" title="${esc(a.descricao)}">${esc(a.descricao)}</span></div>`;
  }).join('');
  return `<div class="gantt-toolbar">
      <div class="seg">${Object.keys(ZOOM).map((z) => `<button data-act="zoom" data-z="${z}" class="${ui.zoom === z ? 'on' : ''}">${{ dia: 'Dia', semana: 'Semana', mes: 'Mês' }[z]}</button>`).join('')}</div>
      <div class="seg"><button data-act="expNivel" data-n="1">Etapas</button><button data-act="expNivel" data-n="2">Subetapas</button><button data-act="expNivel" data-n="9">Tudo</button></div>
      <label class="check"><input type="checkbox" data-chg="toggleCrit" ${ui.showCrit ? 'checked' : ''}> Caminho crítico</label>
      ${temLB ? `<label class="check"><input type="checkbox" data-chg="toggleBase" ${ui.showBase ? 'checked' : ''}> Linha de base</label>` : ''}
      <span style="flex:1"></span>
      <button class="btn sm" data-act="exportPdf">Exportar PDF</button>
    </div>
    <div class="legend" style="margin-bottom:10px">
      <span><i style="background:var(--bar)"></i>Atividade</span>${ui.showCrit ? '<span><i style="background:var(--crit)"></i>Caminho crítico</span>' : ''}
      <span><i style="background:var(--bar);opacity:.45"></i>Duração provisória</span><span><i style="background:var(--bar-progress)"></i>Executado</span>
      <span><i style="background:var(--bar-etapa)"></i>Etapa/subetapa</span>${temLB && ui.showBase ? '<span><i style="background:var(--bar-base);height:3px"></i>Linha de base</span>' : ''}
      <span><i style="background:none;border-left:2px dashed var(--today);width:2px;height:12px"></i>Hoje</span>
    </div>
    <div class="card gantt" id="gantt">
      <div class="gantt-left"><div class="g-head" style="height:${HEAD_H}px">Etapa / atividade</div>${left}</div>
      <div class="gantt-right" style="width:${W}px">
        <svg class="g-headsvg" width="${W}" height="${HEAD_H}">${head}</svg>
        <svg width="${W}" height="${H}" style="display:block"><defs><marker id="ah" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path class="g-arrow-head" d="M0 0L6 3L0 6z"/></marker></defs>
          ${bg}${todayLine}${arrows}${bars}</svg>
      </div>
    </div>
    <div class="muted small" style="margin-top:8px">Passe o mouse (ou toque) nas barras para ver os detalhes. As setas aparecem entre atividades visíveis.</div>`;
}

/* =====================================================================
   CURVA S
   ===================================================================== */
function tabCurva(c) {
  const { o, calc, cron } = c;
  if (!o.eap.length) return `<div class="card empty"><p>Monte a EAP e o orçamento para gerar a Curva S.</p></div>`;
  const cs = curvaS(calc, cron, ui.curvaPeriodo);
  const hoje = avanco(o, calc, cron, todayDay());
  const rows = cs.periodos.map((p) => `<tr><td class="nowrap">${p.label}</td><td class="num">${fmtNumFix(p.fisPer, 1)}%</td><td class="num">${fmtNumFix(p.fisAc, 1)}%</td><td class="num nowrap">${fmtBRL(p.finPer)}</td><td class="num nowrap">${fmtBRL(p.finAc)}</td></tr>`).join('');
  return `<div class="stack">
    <div class="row">
      <div class="seg">${[['semana', 'Semana'], ['mes', 'Mês']].map(([k, l]) => `<button data-act="curvaPer" data-p="${k}" class="${ui.curvaPeriodo === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="muted small">Física ponderada por ${cs.pesoHH ? 'HH' : 'duração (sem HH no orçamento)'} · financeira pelo custo alocado nas atividades, distribuído igualmente nos dias úteis.</span>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Total de HH</div><div class="k-value">${fmtNum(cs.totalHH, 0)}</div></div>
      <div class="card kpi"><div class="k-label">Custo alocado</div><div class="k-value" style="font-size:20px">${fmtBRL(cs.totalCusto)}</div></div>
      <div class="card kpi"><div class="k-label">Físico hoje (plan. / real)</div><div class="k-value">${fmtNum(hoje.fisicoPlan, 1)}% <span class="muted" style="font-size:16px">/ ${fmtNum(hoje.fisicoReal, 1)}%</span></div></div>
      <div class="card kpi"><div class="k-label">Financeiro hoje (plan. / real)</div><div class="k-value" style="font-size:18px">${fmtBRL(hoje.finPlan)}</div><div class="k-sub">real ${fmtBRL(hoje.finReal)}</div></div>
    </div>
    <div class="card card-pad"><div class="row between" style="margin-bottom:8px"><h2>Curva S física (% acumulado)</h2>
      <div class="legend"><span><i style="background:var(--series-plan);height:2px"></i>Planejado</span><span><i style="background:var(--series-real);height:2px"></i>Real (medições)</span></div></div>
      <div class="chart-wrap" id="curvaFis"></div></div>
    <div class="card card-pad"><div class="row between" style="margin-bottom:8px"><h2>Curva S financeira (R$ acumulado)</h2>
      <div class="legend"><span><i style="background:var(--series-plan);height:2px"></i>Planejado</span><span><i style="background:var(--series-real);height:2px"></i>Real (medições)</span></div></div>
      <div class="chart-wrap" id="curvaFin"></div></div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Período</th><th class="num">Físico no período</th><th class="num">Físico acumulado</th><th class="num">Financeiro no período</th><th class="num">Financeiro acumulado</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted small">A curva real é formada pelas medições registradas na aba Acompanhamento.</div>
  </div>`;
}

const compactBRL = (v) => v >= 1e6 ? `R$ ${fmtNum(v / 1e6, 1)} mi` : v >= 1e3 ? `R$ ${fmtNum(v / 1e3, 0)} mil` : fmtBRL(v);

function desenharCurva(el, plan, real, { max, fmtY, ticks }) {
  if (!el || !plan.length) return;
  const W = 800, H = 260, ml = 64, mr = 16, mt = 12, mb = 28;
  const dMin = plan[0].day, dMax = Math.max(plan[plan.length - 1].day, ...real.map((p) => p.day));
  const X = (d) => ml + ((d - dMin) / Math.max(1, dMax - dMin)) * (W - ml - mr);
  const Y = (v) => mt + (1 - v / (max || 1)) * (H - mt - mb);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.day).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('');
  let grid = '';
  for (const t of ticks) grid += `<line class="${t ? 'gridline' : 'baseline'}" x1="${ml}" x2="${W - mr}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${ml - 6}" y="${Y(t) + 4}" text-anchor="end">${fmtY(t)}</text>`;
  const meses = [];
  { const dt = new Date(dMin * 86400000); dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() + 1); while (dt.getTime() / 86400000 <= dMax) { meses.push(Math.floor(dt.getTime() / 86400000)); dt.setUTCMonth(dt.getUTCMonth() + 1); } }
  const step = Math.ceil(meses.length / 8) || 1;
  const xt = meses.filter((_, i) => i % step === 0).map((d) => { const p = dateParts(d); return `<text x="${X(d)}" y="${H - 8}" text-anchor="middle">${MESES[p.m]}/${String(p.y).slice(2)}</text>`; }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img"><g class="axis">${grid}${xt}</g>
    <path class="line-plan" d="${path(plan)}"/>
    ${real.length ? `<path class="line-real" d="${path(real)}"/>${real.slice(1).map((p) => `<circle class="dot-real" cx="${X(p.day)}" cy="${Y(p.v)}" r="4.5"/>`).join('')}` : ''}
    <line class="crosshair hidden" y1="${mt}" y2="${H - mb}"/><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="transparent" class="hit"/></svg><div class="tooltip hidden"></div>`;
  const svgEl = el.querySelector('svg'), hit = el.querySelector('.hit'), cx = el.querySelector('.crosshair'), tip = el.querySelector('.tooltip');
  const move = (ev) => {
    const r = svgEl.getBoundingClientRect();
    const day = dMin + (((ev.clientX - r.left) / r.width) * W - ml) / (W - ml - mr) * (dMax - dMin);
    let best = plan[0]; for (const p of plan) if (Math.abs(p.day - day) < Math.abs(best.day - day)) best = p;
    const ultReal = [...real].reverse().find((m) => m.day <= best.day && m !== real[0]);
    cx.setAttribute('x1', X(best.day)); cx.setAttribute('x2', X(best.day)); cx.classList.remove('hidden');
    tip.innerHTML = `<b>${fmtBR(best.day)}</b><div class="t-row"><span class="sw" style="background:var(--series-plan)"></span>Planejado: ${fmtY(best.v, true)}</div>${ultReal ? `<div class="t-row"><span class="sw" style="background:var(--series-real)"></span>Real (${fmtBR(ultReal.day)}): ${fmtY(ultReal.v, true)}</div>` : ''}`;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(r.width - tip.offsetWidth, Math.max(0, (X(best.day) / W) * r.width + 12)) + 'px'; tip.style.top = '8px';
  };
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cx.classList.add('hidden'); tip.classList.add('hidden'); });
}

export function desenharCurvas(o) {
  const c = contexto(o);
  const cs = curvaS(c.calc, c.cron, ui.curvaPeriodo);
  if (!cs.periodos.length) return;
  const ini = cs.periodos[0].ini - 1;
  const med = [...(o.medicoes || [])].sort((a, b) => a.data.localeCompare(b.data));
  const fis = [{ day: ini, v: 0 }, ...cs.periodos.map((p) => ({ day: p.fim, v: p.fisAc }))];
  const fin = [{ day: ini, v: 0 }, ...cs.periodos.map((p) => ({ day: p.fim, v: p.finAc }))];
  const rf = med.length ? [{ day: ini, v: 0 }, ...med.map((m) => ({ day: toDay(m.data), v: Number(m.fisico) || 0 }))] : [];
  const rfin = med.filter((m) => m.financeiro != null).length ? [{ day: ini, v: 0 }, ...med.filter((m) => m.financeiro != null).map((m) => ({ day: toDay(m.data), v: m.financeiro }))] : [];
  desenharCurva(document.getElementById('curvaFis'), fis, rf, { max: 100, ticks: [0, 25, 50, 75, 100], fmtY: (v, full) => `${fmtNum(v, full ? 1 : 0)}%` });
  const maxF = Math.max(cs.totalCusto, ...rfin.map((p) => p.v)) || 1;
  desenharCurva(document.getElementById('curvaFin'), fin, rfin, { max: maxF, ticks: [0, maxF / 4, maxF / 2, (3 * maxF) / 4, maxF], fmtY: (v, full) => (full ? fmtBRL(v) : compactBRL(v)) });
}

/* =====================================================================
   ACOMPANHAMENTO
   ===================================================================== */
function statusDe(n, cal, day) {
  const pct = Number(n.a.pct) || 0;
  const plan = fracPlanejada(n, cal, day) * 100;
  if (pct >= 100) return { label: 'Concluída', cls: 'good', plan };
  if (pct + 0.5 < plan) return { label: 'Atrasada', cls: 'crit', plan };
  if (pct === 0 && plan === 0) return { label: 'Não iniciada', cls: '', plan };
  if (pct > plan + 0.5) return { label: 'Adiantada', cls: 'info', plan };
  return { label: 'Em dia', cls: 'info', plan };
}

function tabAcompanhamento(c) {
  const { o, calc, cron, filhos } = c;
  if (!o.eap.length) return `<div class="card empty"><p>Monte a EAP antes de acompanhar a execução.</p></div>`;
  ui.statusDate ||= todayISO();
  const day = toDay(ui.statusDate) ?? todayDay();
  const av = avanco(o, calc, cron, day);
  const folhas = [...cron.nos.values()].filter((n) => n.folha);
  const st = new Map(folhas.map((n) => [n.id, statusDe(n, cron.cal, day)]));
  const atrasadas = [...st.values()].filter((s) => s.label === 'Atrasada').length;
  const concl = [...st.values()].filter((s) => s.label === 'Concluída').length;
  const desvio = av.fisicoReal - av.fisicoPlan;
  const linhas = linhasVisiveis(c, { busca: ui.ativFilter });
  const rows = linhas.map((a) => {
    const n = cron.nos.get(a.id), temF = (filhos.get(a.id) || []).length > 0, ab = temF && aberto(o, a);
    const s = st.get(a.id);
    return `<tr class="lvl${Math.min(a.nivel, 3)}">
      <td class="nowrap code-cell" style="padding-left:${6 + (a.nivel - 1) * 14}px">${temF ? `<button class="tog" data-act="toggle" data-id="${a.id}">${ab ? I.down : I.right}</button>` : '<span class="tog-sp"></span>'}${esc(a.codigo)}</td>
      <td>${esc(a.descricao)}</td>
      <td class="nowrap small">${fmtBR(n.inicio)} → ${fmtBR(n.termino)}</td>
      <td class="num">${temF ? '' : `${fmtNum(s.plan, 0)}%`}</td>
      <td>${temF ? '' : `<input class="cell w-sm" inputmode="decimal" data-chg="atvPct" data-id="${a.id}" data-key="pc:${a.id}" value="${fmtIn(Number(a.pct) || 0, 1)}">`}</td>
      <td>${temF ? '' : `<input type="date" class="cell" data-chg="atvField" data-f="inicioReal" data-id="${a.id}" value="${a.inicioReal || ''}">`}</td>
      <td>${temF ? '' : `<input type="date" class="cell" data-chg="atvField" data-f="fimReal" data-id="${a.id}" value="${a.fimReal || ''}">`}</td>
      <td>${temF ? '' : `<span class="badge ${s.cls}">${s.label}</span>`}</td>
    </tr>`;
  }).join('');
  const med = [...(o.medicoes || [])].sort((a, b) => a.data.localeCompare(b.data));
  return `<div class="stack">
    <div class="card card-pad row">
      <label class="field" style="max-width:200px">Data de referência<input type="date" data-chg="statusDate" value="${ui.statusDate}"></label>
      <span style="flex:1"></span>
      <button class="btn primary" data-act="registrarMedicao">Registrar medição em ${isoBR(ui.statusDate)}</button>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Físico planejado</div><div class="k-value">${fmtNum(av.fisicoPlan, 1)}%</div></div>
      <div class="card kpi"><div class="k-label">Físico executado</div><div class="k-value">${fmtNum(av.fisicoReal, 1)}%</div></div>
      <div class="card kpi"><div class="k-label">Desvio</div><div class="k-value" style="color:${desvio < -0.5 ? 'var(--crit)' : desvio > 0.5 ? 'var(--good)' : 'inherit'}">${desvio > 0 ? '+' : ''}${fmtNum(desvio, 1)} pts</div><div class="k-sub">${desvio < -0.5 ? 'atrasado' : desvio > 0.5 ? 'adiantado' : 'em dia'}</div></div>
      <div class="card kpi"><div class="k-label">Financeiro executado</div><div class="k-value" style="font-size:18px">${fmtBRL(av.finReal)}</div><div class="k-sub">planejado ${fmtBRL(av.finPlan)}</div></div>
      <div class="card kpi"><div class="k-label">Atividades atrasadas</div><div class="k-value" style="color:${atrasadas ? 'var(--crit)' : 'inherit'}">${atrasadas}</div><div class="k-sub">${concl} de ${folhas.length} concluídas</div></div>
    </div>
    <div class="row">
      <input data-inp="ativFilter" data-key="ativFilter2" value="${esc(ui.ativFilter)}" placeholder="Buscar atividade…" style="flex:1;min-width:180px">
      <div class="seg"><button data-act="expNivel" data-n="1">Etapas</button><button data-act="expNivel" data-n="2">Subetapas</button><button data-act="expNivel" data-n="9">Tudo</button></div>
    </div>
    <div class="card table-wrap tree-wrap"><table class="data tree">
      <thead><tr><th>Código</th><th>Atividade</th><th>Previsto</th><th class="num">Plan. %</th><th>Real %</th><th>Início real</th><th>Fim real</th><th>Situação</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${med.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Medição</th><th class="num">Físico plan.</th><th class="num">Físico real</th><th class="num">Financeiro plan.</th><th class="num">Financeiro real</th><th></th></tr></thead><tbody>
      ${med.map((m) => `<tr><td>${isoBR(m.data)}</td><td class="num">${fmtNum(m.fisicoPlan, 1)}%</td><td class="num">${fmtNum(m.fisico, 1)}%</td><td class="num">${m.financeiroPlan == null ? '—' : fmtBRL(m.financeiroPlan)}</td><td class="num">${m.financeiro == null ? '—' : fmtBRL(m.financeiro)}</td>
        <td style="text-align:right"><button class="icon-btn danger" data-act="delMedicao" data-d="${m.data}" title="Excluir medição">${I.trash}</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="muted small">Ao informar o fim real, a atividade passa a usar as datas reais e o restante do cronograma é reprojetado. O avanço físico é ponderado por HH.</div>
  </div>`;
}

/* =====================================================================
   CONFIGURAÇÕES
   ===================================================================== */
function tabConfig(c) {
  const { o, lib, cron } = c;
  const dn = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const y0 = dateParts(cron.inicio).y, y1 = Math.max(dateParts(cron.termino).y, y0) + 1;
  const anos = []; for (let a = y0; a <= y1; a++) anos.push(a);
  const lista = (arr, act) => arr.length ? [...arr].sort((a, b) => a.data.localeCompare(b.data)).map((f) => `<div class="list-item"><span style="flex:1"><b>${isoBR(f.data)}</b> <span class="muted">${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][weekday(toDay(f.data))]}</span> · ${esc(f.desc || '')}</span><button class="icon-btn danger" data-act="${act}" data-d="${f.data}" title="Remover">${I.trash}</button></div>`).join('') : '<div class="muted small">Nenhum.</div>';
  const pad = { ...DURACAO_PADRAO, ...(o.duracaoPadrao || {}) };
  return `<div class="stack" style="max-width:860px">
    <div class="card card-pad stack"><h2>Dados da obra</h2>
      <div class="grid-form">
        <label class="field">Nome da obra<input data-chg="obraField" data-f="nome" value="${esc(o.nome)}"></label>
        <label class="field">Data de início<input type="date" data-chg="obraField" data-f="inicio" value="${o.inicio}"></label>
        <label class="field">Jornada (h por dia útil)<input inputmode="decimal" data-chg="obraField" data-f="jornada" value="${fmtIn(o.jornada, 2)}"></label>
        <label class="field">Eficiência (0 a 1)<input inputmode="decimal" data-chg="obraField" data-f="eficiencia" value="${fmtIn(o.eficiencia, 3)}"><span class="muted small" style="font-weight:400">perdas, clima, deslocamentos (0,85 = 85%)</span></label>
      </div></div>
    <div class="card card-pad stack"><h2>Duração padrão por tipo (dias úteis)</h2>
      <p class="muted small" style="margin:0">Usada provisoriamente em atividades sem vínculo com o orçamento e sem duração manual. Elas aparecem com alerta até você definir a duração.</p>
      <div class="grid-form">${TIPOS.map((t) => `<label class="field">${t}<input inputmode="numeric" data-chg="durPadrao" data-t="${t}" value="${pad[t]}"></label>`).join('')}</div></div>
    <div class="card card-pad stack"><h2>Dias úteis</h2>
      <div class="dias">${dn.map((d, i) => `<label><input type="checkbox" data-chg="calDia" data-d="${i}" ${(o.calendario.dias || []).includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
    <div class="card card-pad stack">
      <div class="row between"><h2>Feriados desta obra</h2>
        <div class="row"><select id="anoFer" style="width:auto">${anos.map((a) => `<option>${a}</option>`).join('')}</select><button class="btn sm" data-act="addFeriadosNac">Adicionar feriados nacionais</button></div></div>
      <div class="row"><input type="date" id="ferData" style="width:auto"><input id="ferDesc" placeholder="Descrição (ex.: aniversário da cidade)" style="flex:1;min-width:160px" data-enter="addFeriado"><button class="btn" data-act="addFeriado">${I.plus} Adicionar</button></div>
      <div class="hol-list">${lista(o.calendario.feriados || [], 'delFeriado')}</div></div>
    <div class="card card-pad stack"><h2>Feriados gerais (todas as obras)</h2>
      <div class="row"><input type="date" id="ferGData" style="width:auto"><input id="ferGDesc" placeholder="Descrição" style="flex:1;min-width:160px" data-enter="addFeriadoGeral"><button class="btn" data-act="addFeriadoGeral">${I.plus} Adicionar</button></div>
      <div class="hol-list">${lista(lib.feriadosGlobais || [], 'delFeriadoGeral')}</div></div>
    <div class="card card-pad row">
      <button class="btn" data-act="salvarModelo">Salvar EAP como modelo</button>
      <button class="btn" data-act="dupObra">${I.copy} Duplicar obra</button>
      <span style="flex:1"></span>
      <button class="btn danger" data-act="delObra">${I.trash} Excluir obra</button>
    </div>
  </div>`;
}

/* =====================================================================
   AÇÕES
   ===================================================================== */
const obraAtual = () => store.obra(location.hash.split('/')[2]);
const ativ = (o, id) => o.eap.find((a) => a.id === id);

async function novaComposicaoRapida() {
  const v = await formDialog({
    title: 'Nova composição', ok: 'Criar',
    fields: [
      { name: 'codigo', label: 'Código', required: true, placeholder: 'ex.: C011' },
      { name: 'descricao', label: 'Descrição do serviço', required: true },
      { name: 'unidade', label: 'Unidade', required: true, value: 'm²', list: 'unidades' },
      { name: 'funcao', label: 'Função líder (define o prazo)', required: true, value: 'Pedreiro' },
      { name: 'coef', label: 'Coeficiente da função líder (h/unid)', required: true, placeholder: 'ex.: 0,85' },
    ],
  });
  if (!v) return null;
  const lib = store.lib();
  const cpos = novaComposicao({ codigo: v.codigo.trim(), descricao: v.descricao.trim(), unidade: v.unidade.trim(), maoObra: [{ id: uid(), funcao: v.funcao.trim(), coef: parseNum(v.coef) || 0, lider: true }] });
  lib.composicoes.push(cpos);
  store.touch(lib);
  return cpos;
}

function proximoCodigoItem(o) {
  const nums = o.orcamento.map((it) => it.codigo.match(/(\d+)$/)?.[1]).filter(Boolean).map(Number);
  return `O-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
}

/** Menu da atividade (detalhes + estrutura). */
async function menuAtividade(o, a) {
  const c = contexto(o);
  const temF = (c.filhos.get(a.id) || []).length > 0;
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(a.codigo)} — ${esc(a.descricao)}</h2>
    <div class="stack" style="margin-top:14px">
      ${temF ? '' : `<div class="grid-form">
        <label class="field">Início fixado<input type="date" name="inicioFixado" value="${a.inicioFixado || ''}"><span class="muted small" style="font-weight:400">trava a data (ex.: concreteira agendada)</span></label>
        <label class="field">Início real<input type="date" name="inicioReal" value="${a.inicioReal || ''}"></label>
        <label class="field">Fim real<input type="date" name="fimReal" value="${a.fimReal || ''}"></label></div>`}
      <label class="field">Observação<textarea name="obs" rows="2">${esc(a.obs || '')}</textarea></label>
      <div class="row wrap-btns">
        <button type="button" class="btn sm" data-r="filho">${I.plus} Subatividade</button>
        <button type="button" class="btn sm" data-r="irmao">${I.plus} Atividade abaixo</button>
        <button type="button" class="btn sm" data-r="cima">${I.up} Subir</button>
        <button type="button" class="btn sm" data-r="baixo">${I.down} Descer</button>
        <button type="button" class="btn sm danger" data-r="excluir">${I.trash} Excluir</button>
      </div>
    </div>
    <div class="actions"><button type="button" class="btn" data-r="cancel">Cancelar</button><button class="btn primary" value="ok">Salvar</button></div></form>`;
  const r = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    const form = dlg.querySelector('form');
    form.onsubmit = (e) => { e.preventDefault(); finish({ acao: 'salvar', vals: Object.fromEntries(new FormData(form)) }); };
    dlg.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => finish(b.dataset.r === 'cancel' ? null : { acao: b.dataset.r, vals: Object.fromEntries(new FormData(form)) }); });
    dlg.oncancel = () => finish(null); dlg.onclose = () => finish(null);
    dlg.showModal();
  });
  if (!r) return;
  const salvarCampos = () => {
    a.obs = r.vals.obs ?? a.obs;
    if (!temF) { a.inicioFixado = r.vals.inicioFixado || ''; a.inicioReal = r.vals.inicioReal || ''; a.fimReal = r.vals.fimReal || ''; if (a.fimReal) a.pct = 100; }
  };
  salvarCampos();
  const irmaos = o.eap.filter((x) => (x.parentId || null) === (a.parentId || null));
  if (r.acao === 'filho' || r.acao === 'irmao') {
    const v = await formDialog({ title: r.acao === 'filho' ? `Nova subatividade de ${a.codigo}` : `Nova atividade abaixo de ${a.codigo}`, ok: 'Criar', fields: [
      { name: 'descricao', label: 'Descrição', required: true },
      { name: 'tipo', label: 'Tipo', type: 'select', value: 'Execução', options: TIPOS.map((t) => ({ value: t, label: t })) },
    ] });
    if (!v) return commit(o);
    const parentId = r.acao === 'filho' ? a.id : a.parentId;
    const nova = novaAtividade({ parentId, descricao: v.descricao.trim(), tipo: v.tipo, etapa: a.etapa });
    if (r.acao === 'filho') {
      // a atividade vira grupo: os vínculos e dependências dela passam para a nova subatividade
      if (!temF) {
        o.vinculos.forEach((x) => { if (x.atividadeId === a.id) x.atividadeId = nova.id; });
        o.dependencias.forEach((x) => { if (x.atividadeId === a.id) x.atividadeId = nova.id; });
        Object.assign(nova, { equipe: a.equipe, duracaoManual: a.duracaoManual });
        a.equipe = null; a.duracaoManual = null;
      }
      const ultimo = [...o.eap].reverse().find((x) => x.parentId === a.id);
      o.eap.splice(o.eap.indexOf(ultimo || a) + 1, 0, nova);
    } else o.eap.splice(o.eap.indexOf(a) + 1, 0, nova);
    if (r.acao === 'filho') { expSet(o).add(a.id); if (a.nivel === 1) expSet(o).delete(a.id); salvarExp(o); }
    renumerar(o);
    ui.pendingFocus = `ad:${nova.id}`;
    return commit(o);
  }
  if (r.acao === 'cima' || r.acao === 'baixo') {
    const i = irmaos.indexOf(a), j = i + (r.acao === 'cima' ? -1 : 1);
    if (j >= 0 && j < irmaos.length) {
      const b = irmaos[j];
      const ia = o.eap.indexOf(a), ib = o.eap.indexOf(b);
      [o.eap[ia], o.eap[ib]] = [o.eap[ib], o.eap[ia]];
      renumerar(o);
    }
    return commit(o);
  }
  if (r.acao === 'excluir') {
    const ids = new Set([a.id]);
    let mudou = true;
    while (mudou) { mudou = false; for (const x of o.eap) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) { ids.add(x.id); mudou = true; } }
    const nV = o.vinculos.filter((v) => ids.has(v.atividadeId)).length;
    if (!(await ask(`Excluir ${a.codigo} — ${a.descricao}${ids.size > 1 ? ` e ${ids.size - 1} subatividade(s)` : ''}?${nV ? `\n${nV} vínculo(s) com o orçamento serão removidos (os itens ficarão com "Verificar").` : ''}`, 'Excluir'))) return commit(o);
    o.eap = o.eap.filter((x) => !ids.has(x.id));
    o.vinculos = o.vinculos.filter((v) => !ids.has(v.atividadeId));
    o.dependencias = o.dependencias.filter((d) => !ids.has(d.atividadeId) && !ids.has(d.predecessoraId));
    renumerar(o);
    return commit(o);
  }
  commit(o);
}

function expandirNivel(o, n) {
  const s = expSet(o); s.clear();
  for (const a of o.eap) {
    const querAberto = a.nivel < n;
    if (querAberto !== (a.nivel === 1)) s.add(a.id);
  }
  salvarExp(o);
}

export const acoesObra = {
  verAlertas() { ui.ativSoAlertas = true; },
  toggle(d) { const o = obraAtual(); const s = expSet(o); s.has(d.id) ? s.delete(d.id) : s.add(d.id); salvarExp(o); queueRender(); },
  expNivel(d) { expandirNivel(obraAtual(), Number(d.n)); queueRender(); },
  zoom(d) { ui.zoom = d.z; localStorage.setItem('planobras:zoom', d.z); const g = document.getElementById('gantt'); if (g) g.scrollLeft = 0; queueRender(); },
  curvaPer(d) { ui.curvaPeriodo = d.p; queueRender(); },
  vincFiltro(d) { ui.vincFilter = d.f; queueRender(); },
  async exportXlsx() { const o = obraAtual(); try { toast('Gerando Excel…'); await exportExcel(o, contexto(o)); } catch (e) { toast(e.message); } },
  async exportPdf() { const o = obraAtual(); try { toast('Gerando PDF…'); await exportPDF(o, contexto(o), linhasVisiveis(contexto(o), {})); } catch (e) { toast(e.message); } },

  // Orçamento
  async itemNovo() {
    const o = obraAtual(); const lib = store.lib();
    const etapas = [...new Set([...o.eap.filter((a) => a.nivel === 1).map((a) => a.descricao), ...o.orcamento.map((i) => i.etapa)])].filter(Boolean);
    const subs = [...new Set([...o.eap.filter((a) => a.nivel === 2).map((a) => a.descricao), ...o.orcamento.map((i) => i.subetapa)])].filter(Boolean);
    const v = await formDialog({
      title: 'Novo item do orçamento', ok: 'Adicionar',
      html: `<datalist id="dl-etapas">${etapas.map((e) => `<option value="${esc(e)}">`).join('')}</datalist><datalist id="dl-subs">${subs.map((e) => `<option value="${esc(e)}">`).join('')}</datalist>${datalistAtividades(contexto(o))}`,
      fields: [
        { name: 'codigo', label: 'Código do item', required: true, value: proximoCodigoItem(o) },
        { name: 'etapa', label: 'Etapa', list: 'dl-etapas' },
        { name: 'subetapa', label: 'Subetapa', list: 'dl-subs' },
        { name: 'composicaoId', label: 'Composição', type: 'select', value: '', options: [{ value: '', label: '— escolher depois —' }, ...lib.composicoes.filter((x) => x.ativa).sort((a, b) => natural(a.codigo, b.codigo)).map((x) => ({ value: x.id, label: `${x.codigo} — ${x.descricao} (${x.unidade})` }))] },
        { name: 'quantidade', label: 'Quantidade', placeholder: '0' },
        { name: 'custoUnit', label: 'Custo unitário (R$)', placeholder: '0,00' },
        { name: 'ativ', label: 'Vincular 100% à atividade (opcional)', list: 'dl-ativ', placeholder: 'ex.: 2.4.4' },
      ],
    });
    if (!v) return;
    const it = novoItem({ codigo: v.codigo.trim(), etapa: v.etapa.trim(), subetapa: v.subetapa.trim(), composicaoId: v.composicaoId, quantidade: parseNum(v.quantidade) || 0, custoUnit: parseNum(v.custoUnit) || 0 });
    o.orcamento.push(it);
    const cod = v.ativ.split('—')[0].trim();
    if (cod) {
      const a = o.eap.find((x) => x.codigo === cod);
      if (a) o.vinculos.push({ id: uid(), itemId: it.id, atividadeId: a.id, pct: 1 }); else toast(`Atividade ${cod} não encontrada — vincule depois na aba Vínculos.`);
    }
    commit(o);
  },
  async itemEditar(d) {
    const o = obraAtual(); const it = o.orcamento.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Item ${it.codigo}`, fields: [
      { name: 'etapa', label: 'Etapa', value: it.etapa }, { name: 'subetapa', label: 'Subetapa', value: it.subetapa },
    ] });
    if (!v) return;
    it.etapa = v.etapa.trim(); it.subetapa = v.subetapa.trim();
    commit(o);
  },
  async itemExcluir(d) {
    const o = obraAtual(); const it = o.orcamento.find((x) => x.id === d.id);
    if (!(await ask(`Excluir o item ${it.codigo}? Os vínculos dele com a EAP também serão removidos.`, 'Excluir'))) return;
    o.orcamento = o.orcamento.filter((x) => x.id !== d.id);
    o.vinculos = o.vinculos.filter((v) => v.itemId !== d.id);
    commit(o);
  },
  irVinculo(d) { ui.vincFilter = 'todos'; ui.orcFilter = ''; setTimeout(() => document.getElementById(`item-${d.id}`)?.scrollIntoView({ block: 'center' }), 60); },

  // Vínculos
  vincNovo(d) {
    const o = obraAtual();
    const soma = o.vinculos.filter((v) => v.itemId === d.id).reduce((s, v) => s + (Number(v.pct) || 0), 0);
    const v = { id: uid(), itemId: d.id, atividadeId: null, pct: Math.max(0, Math.round((1 - soma) * 10000) / 10000) };
    o.vinculos.push(v);
    ui.pendingFocus = `va:${v.id}`;
    commit(o);
  },
  async vincExcluir(d) { const o = obraAtual(); o.vinculos = o.vinculos.filter((v) => v.id !== d.id); commit(o); },
  vincIgual(d) {
    const o = obraAtual(); const vs = o.vinculos.filter((v) => v.itemId === d.id);
    const p = Math.floor(10000 / vs.length) / 10000;
    vs.forEach((v, i) => { v.pct = i === vs.length - 1 ? Math.round((1 - p * (vs.length - 1)) * 10000) / 10000 : p; });
    commit(o);
  },
  vincCompletar(d) {
    const o = obraAtual(); const vs = o.vinculos.filter((v) => v.itemId === d.id);
    const outros = vs.slice(0, -1).reduce((s, v) => s + (Number(v.pct) || 0), 0);
    vs[vs.length - 1].pct = Math.max(0, Math.round((1 - outros) * 10000) / 10000);
    commit(o);
  },

  // Atividades
  async atvNovaEtapa() {
    const o = obraAtual();
    const v = await formDialog({ title: 'Nova etapa (nível 1)', ok: 'Criar', fields: [{ name: 'descricao', label: 'Nome da etapa', required: true, placeholder: 'ex.: Fundação' }] });
    if (!v) return;
    const a = novaAtividade({ descricao: v.descricao.trim(), etapa: v.descricao.trim() });
    o.eap.push(a); renumerar(o);
    ui.pendingFocus = `ad:${a.id}`;
    commit(o);
  },
  atvMenu(d) { const o = obraAtual(); menuAtividade(o, ativ(o, d.id)); },
  async saveBase() {
    const o = obraAtual();
    if (o.linhaBase && !(await ask('Substituir a linha de base atual pelo cronograma de hoje?', 'Substituir'))) return;
    const c = contexto(o); const itens = {};
    for (const n of c.cron.nos.values()) itens[n.id] = { inicio: n.inicio, termino: n.termino };
    o.linhaBase = { data: todayISO(), itens };
    commit(o); toast('Linha de base salva.');
  },
  async clearBase() { const o = obraAtual(); if (!(await ask('Remover a linha de base?', 'Remover'))) return; o.linhaBase = null; commit(o); },

  // Acompanhamento
  registrarMedicao() {
    const o = obraAtual(); const c = contexto(o);
    const av = avanco(o, c.calc, c.cron, toDay(ui.statusDate));
    o.medicoes = (o.medicoes || []).filter((m) => m.data !== ui.statusDate);
    o.medicoes.push({ data: ui.statusDate, fisico: av.fisicoReal, fisicoPlan: av.fisicoPlan, financeiro: av.finReal, financeiroPlan: av.finPlan });
    commit(o); toast('Medição registrada.');
  },
  delMedicao(d) { const o = obraAtual(); o.medicoes = o.medicoes.filter((m) => m.data !== d.d); commit(o); },

  // Configurações
  addFeriadosNac() {
    const o = obraAtual(); const ano = Number(document.getElementById('anoFer').value);
    const have = new Set(o.calendario.feriados.map((f) => f.data));
    const novos = feriadosNacionais(ano).filter((f) => !have.has(f.data));
    o.calendario.feriados.push(...novos); commit(o);
    toast(`${novos.length} feriados de ${ano} adicionados (Carnaval e Corpus Christi são ponto facultativo; remova se trabalhar).`, 5000);
  },
  addFeriado() {
    const o = obraAtual(); const data = document.getElementById('ferData').value;
    if (!data) return toast('Escolha a data.');
    if (o.calendario.feriados.some((f) => f.data === data)) return toast('Essa data já está na lista.');
    o.calendario.feriados.push({ data, desc: document.getElementById('ferDesc').value.trim() }); commit(o);
  },
  delFeriado(d) { const o = obraAtual(); o.calendario.feriados = o.calendario.feriados.filter((f) => f.data !== d.d); commit(o); },
  addFeriadoGeral() {
    const lib = store.lib(); const data = document.getElementById('ferGData').value;
    if (!data) return toast('Escolha a data.');
    if (lib.feriadosGlobais.some((f) => f.data === data)) return toast('Essa data já está na lista.');
    lib.feriadosGlobais.push({ data, desc: document.getElementById('ferGDesc').value.trim() }); commit(lib);
  },
  delFeriadoGeral(d) { const lib = store.lib(); lib.feriadosGlobais = lib.feriadosGlobais.filter((f) => f.data !== d.d); commit(lib); },
  async salvarModelo() {
    const o = obraAtual();
    const v = await formDialog({ title: 'Salvar EAP como modelo', ok: 'Salvar', text: 'O modelo guarda a estrutura, os tipos e as predecessoras, para criar novas obras.', fields: [{ name: 'nome', label: 'Nome do modelo', required: true, value: `EAP ${o.nome}` }] });
    if (!v) return;
    const c = contexto(o);
    const lib = store.lib();
    lib.modelosEAP.push(modeloDaEAP(v.nome.trim(), o.eap.map((a) => ({ codigo: a.codigo, nivel: a.nivel, etapa: a.etapa, subetapa: a.subetapa, descricao: a.descricao, tipo: a.tipo, pred: c.predsTexto(a), equipe: a.equipe, duracaoManual: a.duracaoManual }))));
    commit(lib); toast('Modelo salvo. Use-o ao criar uma nova obra.');
  },
  async dupObra() {
    const o = obraAtual();
    const v = await formDialog({ title: 'Duplicar obra', ok: 'Duplicar', fields: [{ name: 'nome', label: 'Nome da nova obra', required: true, value: `${o.nome} (cópia)` }] });
    if (!v) return;
    const copia = store.duplicateObra(o, v.nome.trim());
    location.hash = `#/obra/${copia.id}/atividades`; toast('Obra duplicada.');
  },
  async delObra() {
    const o = obraAtual();
    if (!(await ask(`Excluir a obra "${o.nome}"? O arquivo também irá para a lixeira do Google Drive.`, 'Excluir obra'))) return;
    store.deleteObra(o.id); location.hash = '#/obras';
  },
};

export const mudancasObra = {
  async itemComp(d, el) {
    const o = obraAtual(); const it = o.orcamento.find((x) => x.id === d.id);
    if (el.value === '__new__') { const cpos = await novaComposicaoRapida(); if (cpos) it.composicaoId = cpos.id; }
    else it.composicaoId = el.value;
    commit(o);
  },
  itemField(d, el) {
    const o = obraAtual(); const it = o.orcamento.find((x) => x.id === d.id);
    if (d.f === 'codigo') { if (!el.value.trim()) return queueRender(); it.codigo = el.value.trim(); }
    else { const n = parseNum(el.value); it[d.f] = Math.max(0, n ?? 0); }
    commit(o);
  },
  vincAtiv(d, el) {
    const o = obraAtual(); const v = o.vinculos.find((x) => x.id === d.id);
    const cod = el.value.split('—')[0].trim();
    const a = o.eap.find((x) => x.codigo === cod);
    if (!a) { el.classList.add('invalid'); return toast(`Atividade "${cod}" não encontrada.`); }
    const temFilhos = o.eap.some((x) => x.parentId === a.id);
    if (temFilhos) { el.classList.add('invalid'); return toast(`${cod} é uma etapa/subetapa. Vincule a uma atividade do último nível.`); }
    v.atividadeId = a.id; commit(o);
  },
  vincPct(d, el) {
    const o = obraAtual(); const v = o.vinculos.find((x) => x.id === d.id);
    const n = parseNum(el.value);
    v.pct = Math.max(0, (n ?? 0) / 100); commit(o);
  },
  atvField(d, el) {
    const o = obraAtual(); const a = ativ(o, d.id);
    if (d.f === 'descricao') { if (!el.value.trim()) return queueRender(); a.descricao = el.value.trim(); }
    else if (d.f === 'equipe' || d.f === 'duracaoManual') { const n = parseNum(el.value); a[d.f] = n == null ? null : Math.max(0, d.f === 'equipe' ? n : Math.round(n)); }
    else if (d.f === 'fimReal') { a.fimReal = el.value; if (el.value) a.pct = 100; }
    else a[d.f] = el.value;
    commit(o);
  },
  atvPred(d, el) {
    const o = obraAtual(); const a = ativ(o, d.id);
    const idPorCodigo = new Map(o.eap.map((x) => [x.codigo, x.id]));
    try {
      const r = resolverNotacao(el.value, a.id, idPorCodigo);
      if (r.textoLivre) { a.predTexto = el.value.trim(); o.dependencias = o.dependencias.filter((x) => x.atividadeId !== a.id); toast('Predecessora em texto: defina o início fixado da atividade (menu ⋯).', 4500); return commit(o); }
      const preds = r.deps.map((x) => x.predecessoraId);
      if (criaCiclo(o, a.id, preds)) throw new Error('Essa ligação cria uma dependência circular.');
      o.dependencias = o.dependencias.filter((x) => x.atividadeId !== a.id).concat(r.deps.map((x) => ({ id: uid(), atividadeId: a.id, ...x })));
      a.predTexto = '';
      commit(o);
    } catch (e) { el.classList.add('invalid'); toast(e.message, 4500); }
  },
  atvPct(d, el) {
    const o = obraAtual(); const a = ativ(o, d.id);
    a.pct = Math.min(100, Math.max(0, parseNum(el.value) ?? 0));
    if (a.pct > 0 && !a.inicioReal) a.inicioReal = ui.statusDate || todayISO();
    if (a.pct >= 100 && !a.fimReal) a.fimReal = ui.statusDate || todayISO();
    commit(o);
  },
  soAlertas(d, el) { ui.ativSoAlertas = el.checked; queueRender(); },
  statusDate(d, el) { ui.statusDate = el.value || todayISO(); queueRender(); },
  toggleCrit(d, el) { ui.showCrit = el.checked; queueRender(); },
  toggleBase(d, el) { ui.showBase = el.checked; queueRender(); },
  obraField(d, el) {
    const o = obraAtual();
    if (d.f === 'nome') { if (!el.value.trim()) return queueRender(); o.nome = el.value.trim(); }
    else if (d.f === 'inicio') { if (!el.value) return queueRender(); o.inicio = el.value; }
    else if (d.f === 'jornada') o.jornada = Math.min(24, Math.max(0.5, parseNum(el.value) || 8.8));
    else if (d.f === 'eficiencia') { let e = parseNum(el.value) || 0.85; if (e > 1) e /= 100; o.eficiencia = Math.min(1, Math.max(0.05, e)); }
    commit(o);
  },
  durPadrao(d, el) { const o = obraAtual(); o.duracaoPadrao = { ...DURACAO_PADRAO, ...(o.duracaoPadrao || {}), [d.t]: Math.max(0, Math.round(parseNum(el.value) ?? 0)) }; commit(o); },
  calDia(d, el) {
    const o = obraAtual(); const s = new Set(o.calendario.dias);
    if (el.checked) s.add(Number(d.d)); else s.delete(Number(d.d));
    if (!s.size) { toast('Deixe pelo menos um dia útil.'); return queueRender(); }
    o.calendario.dias = [...s].sort(); commit(o);
  },
};

export const entradasObra = {
  orcFilter(el) { ui.orcFilter = el.value; queueRender(); },
  ativFilter(el) { ui.ativFilter = el.value; queueRender(); },
};

/** Depois de desenhar a tela da obra. */
export function depoisObra(route, prevScroll) {
  const o = store.obra(route.id);
  if (!o) return;
  if (route.tab === 'gantt') {
    const g = document.getElementById('gantt');
    if (g) { if (prevScroll != null) g.scrollLeft = prevScroll; else { const t = g.querySelector('.g-today'); if (t) g.scrollLeft = Math.max(0, Number(t.getAttribute('x1')) - 160); } }
  }
  if (route.tab === 'curva') desenharCurvas(o);
}
