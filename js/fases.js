// Aba Fases: biblioteca de fases (modelos de EAP) independente das obras.
// Aqui a pessoa cria, renomeia, reordena e exclui etapas, subetapas e atividades, define tipo, equipe, duração
// e predecessoras. As obras puxam as fases daqui (Nova obra / "+ Fases do modelo").
import * as store from './store.js';
import { filhosDe, renumerar, novaAtividade, TIPOS, uid } from './model.js';
import { formatNotacao, resolverNotacao } from './predecessoras.js';
import { criaCiclo } from './cpm.js';
import { modeloVazio, duplicarModelo, etapasDoModelo } from './importador.js';
import { esc, I, ui, toast, formDialog, ask, commit, queueRender, parseNum, fmtIn } from './ui.js';

const vazio = (v) => v === '' || v === null || v === undefined;

export function modeloAtual(id) {
  const lib = store.lib();
  const ms = lib.modelosEAP || [];
  return ms.find((m) => m.id === id) || ms.find((m) => m.id === lib.modeloPadraoId) || ms[0] || null;
}

/* ---------- expandir/recolher (nível 1 aberto por padrão) ---------- */
function expSet(M) {
  const k = `m:${M.id}`;
  if (!ui.expandidos[k]) {
    let s = [];
    try { s = JSON.parse(localStorage.getItem(`planobras:exp:${k}`) || '[]'); } catch {}
    ui.expandidos[k] = new Set(s);
  }
  return ui.expandidos[k];
}
const salvarExp = (M) => { try { localStorage.setItem(`planobras:exp:m:${M.id}`, JSON.stringify([...expSet(M)])); } catch {} };
const aberto = (M, a) => (a.nivel === 1) !== expSet(M).has(a.id);

function linhas(M, filhos, busca) {
  const termo = busca.trim().toLowerCase();
  const out = [];
  const visita = (pid) => {
    for (const a of filhos.get(pid) || []) {
      const temF = (filhos.get(a.id) || []).length > 0;
      if (termo) {
        const ini = out.length; out.push(a); visita(a.id);
        if (out.length === ini + 1 && !`${a.codigo} ${a.descricao}`.toLowerCase().includes(termo)) out.pop();
        continue;
      }
      out.push(a);
      if (temF && aberto(M, a)) visita(a.id);
    }
  };
  visita(null);
  return out;
}

export function viewFases(route) {
  const lib = store.lib();
  const modelos = lib.modelosEAP || [];
  const M = modeloAtual(route.id);
  const cab = `<div class="page-head"><div><h1>Fases</h1><div class="muted">Biblioteca de fases (modelos de EAP), independente das obras. Edite à vontade: as obras puxam as fases daqui.</div></div>
    <div class="row"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="fModeloNovo">${I.plus} Novo modelo</button></div></div>`;
  if (!M) return `${cab}<div class="card empty"><p>Nenhum modelo de fases ainda.</p><p class="small">Importe a planilha modelo ou crie um modelo do zero e vá acrescentando as etapas.</p>
    <div class="row" style="justify-content:center"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="fModeloNovo">${I.plus} Criar modelo do zero</button></div></div>`;
  const filhos = filhosDe(M);
  const porId = new Map(M.eap.map((a) => [a.id, a]));
  const depsDe = new Map();
  for (const d of M.dependencias) { if (!depsDe.has(d.atividadeId)) depsDe.set(d.atividadeId, []); depsDe.get(d.atividadeId).push(d); }
  const codigoDe = (id) => porId.get(id)?.codigo || '';
  const vis = linhas(M, filhos, ui.fasesBusca || '');
  const etapas = etapasDoModelo(M);
  const nFolhas = M.eap.filter((a) => !(filhos.get(a.id) || []).length).length;
  const rows = vis.map((a) => {
    const temF = (filhos.get(a.id) || []).length > 0, ab = temF && aberto(M, a), leaf = !temF;
    const base = a.varianteDe ? porId.get(a.varianteDe) : null;
    return `<tr class="lvl${Math.min(a.nivel, 3)}">
      <td class="nowrap code-cell" style="padding-left:${6 + (a.nivel - 1) * 14}px">${temF ? `<button class="tog" data-act="fToggle" data-id="${a.id}">${ab ? I.down : I.right}</button>` : '<span class="tog-sp"></span>'}${esc(a.codigo)}</td>
      <td class="desc"><input class="cell" data-chg="fCampo" data-f="descricao" data-id="${a.id}" data-key="fd:${a.id}" value="${esc(a.descricao)}">${base ? `<div class="small muted">alternativa à etapa ${esc(base.codigo)} — ${esc(base.descricao)}</div>` : ''}</td>
      <td>${leaf ? `<select class="cell w-tipo" data-chg="fCampo" data-f="tipo" data-id="${a.id}">${TIPOS.map((t) => `<option ${t === a.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select>` : `<span class="muted small">${temF ? (filhos.get(a.id) || []).length + ' itens' : ''}</span>`}</td>
      <td>${leaf ? `<input class="cell w-sm" inputmode="decimal" data-chg="fCampo" data-f="equipe" data-id="${a.id}" value="${vazio(a.equipe) ? '' : fmtIn(a.equipe, 2)}" placeholder="—">` : ''}</td>
      <td>${leaf ? `<input class="cell w-sm" inputmode="numeric" data-chg="fCampo" data-f="duracaoManual" data-id="${a.id}" value="${vazio(a.duracaoManual) ? '' : a.duracaoManual}" placeholder="—">` : ''}</td>
      <td>${leaf ? `<input class="cell w-pred" data-chg="fPred" data-id="${a.id}" data-key="fp:${a.id}" value="${esc(formatNotacao(depsDe.get(a.id) || [], codigoDe) || a.predTexto || '')}" placeholder="ex.: 3.4.2 ou 3.1 II+5">` : `<span class="muted small">${esc((a.obs || '').replace(/^Predecessora original \(resumo\): /, 'orig.: '))}</span>`}</td>
      <td><button class="icon-btn" title="Mais opções" data-act="fMenu" data-id="${a.id}">${I.more}</button></td>
    </tr>`;
  }).join('');
  return `${cab}
    <div class="card card-pad row" style="margin-bottom:14px">
      <label class="field" style="flex:1;min-width:220px">Modelo<select data-chg="fModeloSel">${modelos.map((m) => `<option value="${m.id}" ${m.id === M.id ? 'selected' : ''}>${m.id === lib.modeloPadraoId ? '★ ' : ''}${esc(m.nome)}</option>`).join('')}</select></label>
      ${M.id === lib.modeloPadraoId ? '<span class="badge info">modelo inicial</span>' : `<button class="btn sm" data-act="fModeloPadrao" data-id="${M.id}">Tornar inicial</button>`}
      <button class="btn sm" data-act="fModeloRenomear" data-id="${M.id}">Renomear</button>
      <button class="btn sm" data-act="fModeloDuplicar" data-id="${M.id}">${I.copy} Duplicar</button>
      <button class="btn sm danger" data-act="fModeloExcluir" data-id="${M.id}">${I.trash} Excluir</button>
    </div>
    <div class="kpis" style="margin-bottom:14px">
      <div class="card kpi"><div class="k-label">Etapas</div><div class="k-value">${etapas.filter((e) => !e.variante).length}</div><div class="k-sub">${etapas.filter((e) => e.variante).length} alternativa(s)</div></div>
      <div class="card kpi"><div class="k-label">Atividades</div><div class="k-value">${nFolhas}</div></div>
      <div class="card kpi"><div class="k-label">Predecessoras</div><div class="k-value">${M.dependencias.length}</div></div>
      <div class="card kpi"><div class="k-label">Itens de orçamento</div><div class="k-value">${(M.orcamento || []).length}</div><div class="k-sub">vinculados às fases</div></div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <input data-inp="fasesBusca" data-key="fasesBusca" value="${esc(ui.fasesBusca || '')}" placeholder="Buscar fase ou atividade…" style="flex:1;min-width:180px">
      <div class="seg"><button data-act="fExpNivel" data-n="1">Etapas</button><button data-act="fExpNivel" data-n="2">Subetapas</button><button data-act="fExpNivel" data-n="9">Tudo</button></div>
      <button class="btn sm primary" data-act="fNovaEtapa">${I.plus} Etapa</button>
    </div>
    ${M.eap.length ? `<div class="card table-wrap tree-wrap"><table class="data tree">
      <thead><tr><th>Código</th><th>Fase / atividade</th><th>Tipo</th><th title="Nº de profissionais da função líder">Equipe</th><th title="Duração manual (dias úteis) — para cura, fornecedor, documentação…">Duração</th><th>Predecessoras</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">Nada encontrado.</td></tr>'}</tbody></table></div>`
      : `<div class="card empty"><p>Modelo vazio.</p><button class="btn primary" data-act="fNovaEtapa">${I.plus} Criar a primeira etapa</button></div>`}
    <div class="muted small" style="margin-top:8px">Use o menu ⋯ para criar subfases, mover, excluir ou marcar uma etapa como <b>alternativa</b> de outra (ex.: piscina de fibra × alvenaria — só uma entra em cada obra). Mudanças aqui valem para as próximas fases adicionadas às obras; obras já criadas não são alteradas.</div>`;
}

/* ---------- ações ---------- */
const M_ = () => modeloAtual(location.hash.split('/')[2]);
const ativ = (M, id) => M.eap.find((a) => a.id === id);

async function menu(M, a) {
  const filhos = filhosDe(M);
  const temF = (filhos.get(a.id) || []).length > 0;
  const raizes = (filhos.get(null) || []).filter((x) => x.id !== a.id && !x.varianteDe);
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(a.codigo)} — ${esc(a.descricao)}</h2>
    <div class="stack" style="margin-top:14px">
      <label class="field">Observação<textarea name="obs" rows="2">${esc(a.obs || '')}</textarea></label>
      ${!a.parentId ? `<label class="field">Alternativa de outra etapa?<select name="varianteDe"><option value="">Não — etapa normal</option>${raizes.map((r) => `<option value="${r.id}" ${a.varianteDe === r.id ? 'selected' : ''}>Sim, alternativa à ${esc(r.codigo)} — ${esc(r.descricao)}</option>`).join('')}</select><span class="muted small" style="font-weight:400">Ex.: Piscina de fibra como alternativa à Piscina de alvenaria. Na obra, escolhe-se uma.</span></label>` : ''}
      <div class="row wrap-btns">
        <button type="button" class="btn sm" data-r="filho">${I.plus} Subfase / atividade</button>
        <button type="button" class="btn sm" data-r="irmao">${I.plus} Item abaixo</button>
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
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    dlg.showModal();
  });
  if (!r) return;
  const lib = store.lib();
  a.obs = r.vals.obs ?? a.obs;
  if (!a.parentId && 'varianteDe' in r.vals) a.varianteDe = r.vals.varianteDe || null;
  if (r.acao === 'filho' || r.acao === 'irmao') {
    const v = await formDialog({ title: r.acao === 'filho' ? `Nova subfase de ${a.codigo}` : `Novo item abaixo de ${a.codigo}`, ok: 'Criar', fields: [
      { name: 'descricao', label: 'Nome', required: true },
      { name: 'tipo', label: 'Tipo (se for atividade)', type: 'select', value: 'Execução', options: TIPOS.map((t) => ({ value: t, label: t })) },
    ] });
    if (!v) { renumerar(M); return commit(lib); }
    const nova = novaAtividade({ parentId: r.acao === 'filho' ? a.id : a.parentId, descricao: v.descricao.trim(), tipo: v.tipo });
    if (r.acao === 'filho') {
      if (!temF) { // vira grupo: vínculos e dependências passam para a nova atividade
        (M.vinculos || []).forEach((x) => { if (x.atividadeId === a.id) x.atividadeId = nova.id; });
        M.dependencias.forEach((x) => { if (x.atividadeId === a.id) x.atividadeId = nova.id; });
        Object.assign(nova, { equipe: a.equipe, duracaoManual: a.duracaoManual }); a.equipe = null; a.duracaoManual = null;
      }
      const ultimo = [...M.eap].reverse().find((x) => x.parentId === a.id);
      M.eap.splice(M.eap.indexOf(ultimo || a) + 1, 0, nova);
      if (a.nivel === 1) expSet(M).delete(a.id); else expSet(M).add(a.id);
      salvarExp(M);
    } else M.eap.splice(M.eap.indexOf(a) + 1, 0, nova);
    renumerar(M);
    ui.pendingFocus = `fd:${nova.id}`;
    return commit(lib);
  }
  if (r.acao === 'cima' || r.acao === 'baixo') {
    const irmaos = M.eap.filter((x) => (x.parentId || null) === (a.parentId || null));
    const j = irmaos.indexOf(a) + (r.acao === 'cima' ? -1 : 1);
    if (j >= 0 && j < irmaos.length) { const b = irmaos[j]; const ia = M.eap.indexOf(a), ib = M.eap.indexOf(b); [M.eap[ia], M.eap[ib]] = [M.eap[ib], M.eap[ia]]; }
    renumerar(M);
    return commit(lib);
  }
  if (r.acao === 'excluir') {
    const ids = new Set([a.id]);
    let mudou = true;
    while (mudou) { mudou = false; for (const x of M.eap) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) { ids.add(x.id); mudou = true; } }
    if (!(await ask(`Excluir ${a.codigo} — ${a.descricao}${ids.size > 1 ? ` e ${ids.size - 1} subitem(ns)` : ''} deste modelo? As obras já criadas não mudam.`, 'Excluir'))) { renumerar(M); return commit(lib); }
    M.eap = M.eap.filter((x) => !ids.has(x.id));
    M.eap.forEach((x) => { if (ids.has(x.varianteDe)) x.varianteDe = null; });
    M.vinculos = (M.vinculos || []).filter((v) => !ids.has(v.atividadeId));
    M.dependencias = M.dependencias.filter((d) => !ids.has(d.atividadeId) && !ids.has(d.predecessoraId));
  }
  renumerar(M);
  commit(lib);
}

export const acoesFases = {
  async fModeloNovo() {
    const lib = store.lib();
    const v = await formDialog({ title: 'Novo modelo de fases', ok: 'Criar', fields: [
      { name: 'nome', label: 'Nome do modelo', required: true, placeholder: 'ex.: Residência térrea padrão' },
      { name: 'padrao', label: 'Usar como modelo inicial das novas obras', type: 'checkbox', value: !(lib.modelosEAP || []).length },
    ] });
    if (!v) return;
    const M = modeloVazio(v.nome.trim());
    lib.modelosEAP.push(M);
    if (v.padrao || !lib.modeloPadraoId) lib.modeloPadraoId = M.id;
    store.touch(lib);
    location.hash = `#/fases/${M.id}`;
  },
  fModeloPadrao(d) { const lib = store.lib(); lib.modeloPadraoId = d.id; commit(lib); toast('Modelo inicial definido.'); },
  async fModeloRenomear(d) {
    const lib = store.lib(); const M = lib.modelosEAP.find((x) => x.id === d.id);
    const v = await formDialog({ title: 'Renomear modelo', fields: [{ name: 'nome', label: 'Nome', required: true, value: M.nome }] });
    if (!v) return; M.nome = v.nome.trim(); commit(lib);
  },
  async fModeloDuplicar(d) {
    const lib = store.lib(); const M = lib.modelosEAP.find((x) => x.id === d.id);
    const v = await formDialog({ title: 'Duplicar modelo', ok: 'Duplicar', fields: [{ name: 'nome', label: 'Nome da cópia', required: true, value: `${M.nome} (cópia)` }] });
    if (!v) return;
    const C = duplicarModelo(M, v.nome.trim());
    lib.modelosEAP.push(C); store.touch(lib);
    location.hash = `#/fases/${C.id}`;
  },
  async fModeloExcluir(d) {
    const lib = store.lib(); const M = lib.modelosEAP.find((x) => x.id === d.id);
    if (!(await ask(`Excluir o modelo "${M.nome}"? As obras criadas com ele não mudam, mas não será mais possível adicionar fases dele.`, 'Excluir'))) return;
    lib.modelosEAP = lib.modelosEAP.filter((x) => x.id !== d.id);
    if (lib.modeloPadraoId === d.id) lib.modeloPadraoId = lib.modelosEAP[0]?.id || null;
    commit(lib); location.hash = '#/fases';
  },
  fToggle(d) { const M = M_(); const s = expSet(M); s.has(d.id) ? s.delete(d.id) : s.add(d.id); salvarExp(M); queueRender(); },
  fExpNivel(d) {
    const M = M_(); const s = expSet(M); s.clear();
    for (const a of M.eap) if ((a.nivel < Number(d.n)) !== (a.nivel === 1)) s.add(a.id);
    salvarExp(M); queueRender();
  },
  async fNovaEtapa() {
    const M = M_(); const lib = store.lib();
    const v = await formDialog({ title: 'Nova etapa', ok: 'Criar', fields: [{ name: 'descricao', label: 'Nome da etapa', required: true, placeholder: 'ex.: Muro de arrimo' }] });
    if (!v) return;
    const a = novaAtividade({ descricao: v.descricao.trim() });
    M.eap.push(a); renumerar(M);
    ui.pendingFocus = `fd:${a.id}`;
    commit(lib);
  },
  fMenu(d) { const M = M_(); menu(M, ativ(M, d.id)); },
};

export const mudancasFases = {
  fModeloSel(d, el) { location.hash = `#/fases/${el.value}`; },
  fCampo(d, el) {
    const M = M_(); const a = ativ(M, d.id); const lib = store.lib();
    if (d.f === 'descricao') { if (!el.value.trim()) return queueRender(); a.descricao = el.value.trim(); }
    else if (d.f === 'equipe' || d.f === 'duracaoManual') { const n = parseNum(el.value); a[d.f] = n == null ? null : Math.max(0, d.f === 'duracaoManual' ? Math.round(n) : n); }
    else a[d.f] = el.value;
    commit(lib);
  },
  fPred(d, el) {
    const M = M_(); const a = ativ(M, d.id); const lib = store.lib();
    try {
      const r = resolverNotacao(el.value, a.id, new Map(M.eap.map((x) => [x.codigo, x.id])));
      if (r.textoLivre) { a.predTexto = el.value.trim(); M.dependencias = M.dependencias.filter((x) => x.atividadeId !== a.id); return commit(lib); }
      if (criaCiclo(M, a.id, r.deps.map((x) => x.predecessoraId))) throw new Error('Essa ligação cria uma dependência circular.');
      M.dependencias = M.dependencias.filter((x) => x.atividadeId !== a.id).concat(r.deps.map((x) => ({ id: uid(), atividadeId: a.id, ...x })));
      a.predTexto = '';
      commit(lib);
    } catch (e) { el.classList.add('invalid'); toast(e.message, 4500); }
  },
};

export const entradasFases = {
  fasesBusca(el) { ui.fasesBusca = el.value; queueRender(); },
};
