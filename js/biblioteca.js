// Telas gerais: Obras (lista, nova obra, modelos de EAP), Composições e Importar planilha.
import * as store from './store.js';
import { calcular, validarComposicao, liderDe } from './calculo.js';
import { cronograma } from './cpm.js';
import { avanco } from './curvaS.js';
import { novaComposicao, FONTES, uid, novaObra } from './model.js';
import { lerArquivo, interpretar, aplicarComposicoes, modeloDaPlanilha, etapasDoModelo, selecaoPadrao, instanciarModelo } from './importador.js';
import { fmtBR, fmtNum, fmtBRL, todayISO, todayDay } from './schedule.js';
import { esc, I, ui, toast, formDialog, ask, info, commit, queueRender, parseNum, fmtIn } from './ui.js';

const natural = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true });

/* ---------- Escolha de fases do modelo ---------- */

/**
 * Janela para escolher as fases (etapas/subetapas) de um modelo. Em obra existente, o que já está na obra aparece
 * marcado e travado. Resolve com { sel, orcamento, quantidades, novas } ou null.
 */
export function escolherFases(m, obra = null) {
  const etapas = etapasDoModelo(m);
  // fases do modelo que já estão na obra (pelo vínculo modeloAtivId; obras antigas pelo código original)
  const porIdM = new Map(m.eap.map((a) => [a.id, a]));
  const ligados = new Set();
  for (const a of obra?.eap || []) {
    if (a.modeloId !== m.id) continue;
    const n = a.modeloAtivId ? porIdM.get(a.modeloAtivId) : m.eap.find((x) => x.codigoOrig && x.codigoOrig === a.codigoModelo);
    for (let x = n; x; x = x.parentId ? porIdM.get(x.parentId) : null) ligados.add(x.id);
  }
  const etapaNaObra = (e) => ligados.has(e.id);
  const subNaObra = (s) => ligados.has(s.id);  const padrao = selecaoPadrao(m);
  const temOrc = (m.orcamento || []).length > 0;
  const subs = (e, ativa) => e.subetapas.length ? `<details class="fase-subs"><summary>${e.subetapas.length} subetapa(s)</summary>
    ${e.subetapas.map((s) => {
      const ja = subNaObra(s);
      // obra nova: segue a etapa; obra existente: subetapas novas de etapas que já estão na obra começam desmarcadas
      const marcado = ja || (obra ? !etapaNaObra(e) && ativa : ativa);
      return `<label class="check"><input type="checkbox" name="s" value="${esc(s.id)}" data-etapa="${esc(e.id)}" ${marcado ? 'checked' : ''} ${ja ? 'disabled' : ''}> <span class="muted">${esc(s.codigo)}</span> ${esc(s.nome)}${ja ? ' <span class="badge">na obra</span>' : ''}</label>`; }).join('')}</details>` : '';
  const grupos = [];
  for (const e of etapas) { const g = grupos.find((x) => x.base === e.base); if (g) g.etapas.push(e); else grupos.push({ base: e.base, etapas: [e] }); }
  const html = grupos.map((g) => {
    if (g.etapas.length === 1) {
      const e = g.etapas[0]; const ja = etapaNaObra(e);
      const marcado = obra ? ja : padrao.etapas.has(e.id);
      return `<div class="fase"><label class="check"><input type="checkbox" name="e" value="${esc(e.id)}" ${marcado ? 'checked' : ''} ${ja ? 'disabled' : ''}> <b>${esc(e.codigo)}</b> ${esc(e.nome)} <span class="muted small">· ${e.nAtiv} atividades</span>${ja ? ' <span class="badge">na obra</span>' : ''}</label>${subs(e, marcado)}</div>`;
    }
    const jaE = g.etapas.find(etapaNaObra);
    return `<div class="fase fase-var"><div class="small muted" style="margin-bottom:4px">Alternativas — escolha uma:</div>
      ${g.etapas.map((e) => { const marcado = jaE ? jaE === e : !obra && padrao.etapas.has(e.id); return `<label class="check"><input type="radio" name="v-${esc(g.base)}" value="${esc(e.id)}" ${marcado ? 'checked' : ''} ${jaE ? 'disabled' : ''}> <b>${esc(e.codigo)}</b> ${esc(e.nome)} <span class="muted small">· ${e.nAtiv} atividades</span>${jaE === e ? ' <span class="badge">na obra</span>' : ''}</label>${subs(e, marcado)}`; }).join('')}
      ${jaE ? '' : `<label class="check"><input type="radio" name="v-${esc(g.base)}" value="" ${obra ? 'checked' : ''}> <span class="muted">Nenhuma</span></label>`}
    </div>`;
  }).join('');
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide"><h2>${obra ? 'Adicionar fases do modelo' : 'Escolha as fases da obra'}</h2>
    <p class="muted small" style="margin:6px 0 10px">Modelo <b>${esc(m.nome)}</b>. Marque as etapas (e, se quiser, ajuste as subetapas). Você pode adicionar outras fases depois, na aba Atividades.</p>
    <div class="row" style="margin-bottom:8px"><button type="button" class="btn sm" data-x="todas">Marcar todas</button><button type="button" class="btn sm" data-x="nenhuma">Desmarcar todas</button></div>
    <div class="fases">${html}</div>
    ${temOrc ? `<div class="stack" style="margin-top:12px"><label class="check"><input type="checkbox" name="orc" checked> Trazer os itens de orçamento vinculados a essas fases</label>
      <label class="check"><input type="checkbox" name="qtd"> Com as quantidades e custos do modelo (desmarcado: quantidades zeradas para você preencher)</label></div>` : ''}
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${obra ? 'Adicionar' : 'Criar obra'}</button></div></form>`;
  const form = dlg.querySelector('form');
  // marcar/desmarcar etapa marca/desmarca as subetapas
  form.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'e') form.querySelectorAll(`input[name="s"][data-etapa="${CSS.escape(t.value)}"]:not(:disabled)`).forEach((s) => { s.checked = t.checked; });
    if (t.type === 'radio') {
      const grupo = form.querySelectorAll(`input[name="${CSS.escape(t.name)}"]`);
      grupo.forEach((r) => { if (r.value) form.querySelectorAll(`input[name="s"][data-etapa="${CSS.escape(r.value)}"]:not(:disabled)`).forEach((s) => { s.checked = r.checked; }); });
    }
  });
  form.querySelector('[data-x="todas"]').onclick = () => form.querySelectorAll('input[name="e"]:not(:disabled), input[name="s"]:not(:disabled)').forEach((x) => { x.checked = true; });
  form.querySelector('[data-x="nenhuma"]').onclick = () => form.querySelectorAll('input[name="e"]:not(:disabled), input[name="s"]:not(:disabled)').forEach((x) => { x.checked = false; });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const sel = { etapas: new Set(), subetapas: new Set() };
      form.querySelectorAll('input[name="e"]:checked').forEach((x) => sel.etapas.add(x.value));
      form.querySelectorAll('input[type="radio"]:checked').forEach((x) => { if (x.value) sel.etapas.add(x.value); });
      form.querySelectorAll('input[name="s"]:checked').forEach((x) => sel.subetapas.add(x.value));
      for (const e of etapas) for (const s of e.subetapas) if (subNaObra(s)) { sel.subetapas.add(s.id); sel.etapas.add(e.id); }
      for (const e of etapas) if (etapaNaObra(e)) sel.etapas.add(e.id);
      const novas = [...sel.etapas].filter((id) => !ligados.has(id)).length;
      if (!sel.etapas.size) { toast('Marque pelo menos uma etapa.'); done = false; return; }
      finish({ sel, novas, orcamento: !!form.querySelector('input[name="orc"]')?.checked, quantidades: !!form.querySelector('input[name="qtd"]')?.checked });
    };
    dlg.querySelector('button[value="cancel"]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    dlg.showModal();
  });
}

/* ---------- Obras ---------- */
export function viewObras() {
  const list = store.obras();
  const lib = store.lib();
  const cards = list.map((o) => {
    const calc = calcular(o, lib);
    const cron = cronograma(o, lib, calc);
    const av = avanco(o, calc, cron, todayDay());
    return `<a class="card obra-card" href="#/obra/${o.id}/atividades">
      <h2>${esc(o.nome)}</h2>
      <div class="meta">
        <div>Início<b>${fmtBR(cron.inicio)}</b></div>
        <div>Término previsto<b>${o.eap.length ? fmtBR(cron.termino) : '—'}</b></div>
        <div>Prazo<b>${cron.durTotal} dias úteis</b></div>
        <div>Orçamento<b>${fmtBRL(calc.totalOrcamento)}</b></div>
      </div>
      <div class="progress" title="Avanço físico executado: ${fmtNum(av.fisicoReal, 1)}%"><div style="width:${Math.min(100, av.fisicoReal)}%"></div></div>
    </a>`;
  }).join('');
  const modelos = lib.modelosEAP || [];
  return `<div class="page-head"><div><h1>Obras</h1><div class="muted">Orçamento, EAP, cronograma e Curva S de cada obra</div></div>
    <div class="row"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div></div>
    ${list.length ? `<div class="obras-grid">${cards}</div>` : `<div class="card empty"><p>Nenhuma obra ainda.</p>
      <p class="small">${modelos.length ? 'Crie uma obra a partir do modelo inicial e escolha as fases.' : 'Comece importando a planilha modelo — ela vira o modelo inicial para as próximas obras.'}</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div></div>`}
    <div class="card" style="margin-top:18px"><div class="card-pad" style="padding-bottom:6px"><h2>Modelos de EAP</h2><div class="muted small">Ao criar uma obra, você escolhe um modelo e as fases que entram. O modelo inicial (★) vem selecionado.</div></div>
      ${modelos.length ? modelos.map((m) => {
        const et = etapasDoModelo(m);
        const padrao = lib.modeloPadraoId === m.id;
        return `<div class="list-item"><span style="flex:1"><b>${padrao ? '★ ' : ''}${esc(m.nome)}</b> <span class="muted small">· ${et.filter((e) => !e.variante).length} etapas · ${et.reduce((s, e) => s + e.nAtiv, 0)} atividades${m.orcamento?.length ? ` · ${m.orcamento.length} itens de orçamento` : ''} · ${m.criadoEm || ''}</span></span>
          ${padrao ? '<span class="badge info">modelo inicial</span>' : `<button class="btn sm" data-act="modeloPadrao" data-id="${m.id}">Tornar inicial</button>`}
          <a class="btn sm" href="#/fases/${m.id}">Editar fases</a>
          <button class="icon-btn danger" data-act="delModelo" data-id="${m.id}" title="Excluir modelo">${I.trash}</button></div>`;
      }).join('') : `<div class="list-item muted small">Nenhum modelo. Importe a planilha, crie um na aba <a href="#/fases">Fases</a> ou, numa obra, use Configurações › Salvar EAP como modelo.</div>`}</div>`;
}

/* ---------- Composições ---------- */
function usoComp(id) { return store.obras().filter((o) => o.orcamento.some((it) => it.composicaoId === id)).length; }

export function viewComposicoes() {
  const lib = store.lib();
  const f = ui.compFilter.trim().toLowerCase();
  const list = [...lib.composicoes].sort((a, b) => natural(a.codigo, b.codigo) || (b.versao - a.versao))
    .filter((c) => !f || `${c.codigo} ${c.descricao} ${c.etapaEap || ''} ${c.refSinapi || ''} ${c.fonte}`.toLowerCase().includes(f));
  const cards = list.map((c) => {
    const erros = validarComposicao(c);
    const uso = usoComp(c.id);
    return `<div class="card comp-card2${c.ativa ? '' : ' inativa'}">
      <div class="comp-top">
        <input class="cell w-code" data-chg="compField" data-f="codigo" data-id="${c.id}" data-key="cc:${c.id}" value="${esc(c.codigo)}" placeholder="Código">
        <input class="cell" style="flex:1;min-width:180px" data-chg="compField" data-f="descricao" data-id="${c.id}" data-key="cd:${c.id}" value="${esc(c.descricao)}" placeholder="Descrição do serviço">
        <input class="cell w-un" list="unidades" data-chg="compField" data-f="unidade" data-id="${c.id}" value="${esc(c.unidade)}" title="Unidade">
        <select class="cell w-fonte" data-chg="compField" data-f="fonte" data-id="${c.id}" title="Fonte">${FONTES.map((x) => `<option ${x === c.fonte ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input class="cell w-code" data-chg="compField" data-f="refSinapi" data-id="${c.id}" value="${esc(c.refSinapi || '')}" placeholder="Ref. SINAPI" title="Código SINAPI de referência">
        <span class="badge ${c.ativa ? 'info' : ''}" title="Versão">v${c.versao || 1}${c.ativa ? '' : ' · inativa'}</span>
        ${uso ? `<span class="badge" title="Obras que usam">${uso} obra${uso > 1 ? 's' : ''}</span>` : ''}
        ${erros.length ? `<span class="badge crit">${esc(erros.join(' · '))}</span>` : ''}
      </div>
      <table class="data mo">
        <thead><tr><th>Função (mão de obra)</th><th class="num">Coef. (h/${esc(c.unidade)})</th><th title="A função líder define o prazo">Líder</th><th class="num">Produção da função líder</th><th></th></tr></thead>
        <tbody>${c.maoObra.map((m) => `<tr>
          <td><input class="cell" data-chg="moField" data-f="funcao" data-c="${c.id}" data-id="${m.id}" value="${esc(m.funcao)}"></td>
          <td><input class="cell w-num" inputmode="decimal" data-chg="moField" data-f="coef" data-c="${c.id}" data-id="${m.id}" value="${fmtIn(m.coef, 4)}"></td>
          <td><input type="radio" name="lider-${c.id}" data-chg="moLider" data-c="${c.id}" data-id="${m.id}" ${m.lider ? 'checked' : ''} aria-label="Função líder"></td>
          <td class="num small muted">${m.lider && m.coef > 0 ? `≈ ${fmtNum(8 * 0.85 / m.coef, 2)} ${esc(c.unidade)}/dia por profissional` : ''}</td>
          <td><button class="icon-btn danger" data-act="moExcluir" data-c="${c.id}" data-id="${m.id}" title="Remover função">${I.trash}</button></td></tr>`).join('')}</tbody>
      </table>
      <div class="row" style="padding:8px 12px">
        <button class="btn sm" data-act="moNova" data-c="${c.id}">${I.plus} Função</button>
        <button class="btn sm" data-act="compVersao" data-id="${c.id}" title="Cria uma cópia com versão nova (a atual fica inativa)">Nova versão</button>
        <button class="btn sm" data-act="compDuplicar" data-id="${c.id}" title="Cria uma composição própria a partir desta (ex.: ajustar um coeficiente do SINAPI)">${I.copy} Duplicar como própria</button>
        ${!c.ativa ? `<button class="btn sm" data-act="compAtivar" data-id="${c.id}">Tornar ativa</button>` : ''}
        <input class="cell" style="max-width:190px" data-chg="compField" data-f="etapaEap" data-id="${c.id}" value="${esc(c.etapaEap || '')}" placeholder="Etapa da EAP" title="Etapa da EAP">
        <input class="cell" style="flex:1;min-width:160px" data-chg="compField" data-f="obs" data-id="${c.id}" value="${esc(c.obs || '')}" placeholder="Observação / ação">
        <button class="icon-btn danger" data-act="compExcluir" data-id="${c.id}" title="Excluir composição">${I.trash}</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="page-head"><div><h1>Composições</h1><div class="muted">Coeficientes de mão de obra por função (h/unidade). A função líder define a duração. Tudo editável.</div></div>
    <div class="row"><label class="btn">${I.upload} Importar da planilha<input type="file" accept=".xlsx,.xls" data-chg="compImportar" hidden></label><button class="btn primary" data-act="compNova">${I.plus} Composição própria</button></div></div>
    <div class="tabs"><a href="#/composicoes" class="active">Minha biblioteca (${lib.composicoes.length})</a><a href="#/sinapi">Base SINAPI</a></div>
    <div class="stack">
      <input data-inp="compFilter" data-key="compFilter" value="${esc(ui.compFilter)}" placeholder="Buscar por código, descrição, etapa, fonte ou ref. SINAPI…">
      <div class="muted small">${lib.composicoes.length} composições. Prioridade de uso: Própria (validada por RDO) › SINAPI › SINAPI (família) › Própria (sugerida). Coeficientes SINAPI: registre mês de referência, UF e regime na observação.</div>
      ${cards || `<div class="card empty"><p>${f ? 'Nenhuma composição encontrada.' : 'Nenhuma composição cadastrada.'}</p></div>`}
    </div>`;
}

/* ---------- Importar planilha ---------- */
let importacao = null; // { arquivo, dados }

export function viewImportar() {
  if (!importacao) {
    return `<div class="page-head"><div><a href="#/obras" class="muted small" style="text-decoration:none">← Obras</a><h1>Importar planilha</h1>
      <div class="muted">Salva a planilha como modelo de EAP (e composições) para criar obras escolhendo as fases</div></div></div>
      <div class="card card-pad stack" style="max-width:760px">
        <p style="margin:0">A planilha deve ter as abas <b>EAP Detalhada</b> e <b>Composicoes</b> e, se quiser, <b>Orcamento</b>, <b>Vinculo_Orc_EAP</b> e <b>Duracao_Atividades</b> — as mesmas colunas do modelo.</p>
        <label class="btn primary" style="align-self:flex-start">${I.upload} Escolher arquivo .xlsx<input type="file" accept=".xlsx,.xls" data-chg="importarArquivo" hidden></label>
        <p class="muted small" style="margin:0">O arquivo é lido no seu navegador; nada é enviado para a internet além do seu Google Drive.</p>
      </div>`;
  }
  const d = importacao.dados;
  const m = modeloDaPlanilha(d, 'x');
  const etapas = etapasDoModelo(m);
  const variantes = etapas.filter((e) => e.variante);
  const lib = store.lib();
  return `<div class="page-head"><div><a href="#/obras" class="muted small" style="text-decoration:none">← Obras</a><h1>Importar planilha</h1><div class="muted">${esc(importacao.arquivo)}</div></div></div>
    <div class="stack" style="max-width:860px">
      <div class="kpis">
        <div class="card kpi"><div class="k-label">Etapas</div><div class="k-value">${etapas.length}</div><div class="k-sub">${variantes.length ? `${variantes.length} alternativa(s)` : 'sem alternativas'}</div></div>
        <div class="card kpi"><div class="k-label">Atividades (nível 3)</div><div class="k-value">${d.atividades.filter((a) => a.nivel >= 3).length}</div></div>
        <div class="card kpi"><div class="k-label">Composições</div><div class="k-value">${d.composicoes.length}</div></div>
        <div class="card kpi"><div class="k-label">Itens de orçamento</div><div class="k-value">${d.orcamento.length}</div><div class="k-sub">${d.vinculos.length} vínculos</div></div>
        <div class="card kpi"><div class="k-label">Premissas</div><div class="k-value" style="font-size:18px">${fmtNum(d.premissas.jornada || 8.8)} h · ${fmtNum((d.premissas.eficiencia || 0.85) * 100)}%</div><div class="k-sub">jornada · eficiência</div></div>
      </div>
      ${variantes.length ? `<div class="alert info">Alternativas de escopo encontradas: ${variantes.map((v) => `<b>${esc(v.codigo)}</b> ${esc(v.nome)}`).join('; ')}. Ao criar a obra você escolhe qual entra (só uma por etapa).</div>` : ''}
      ${d.avisos.length ? `<div class="alert err"><b>Avisos da leitura</b><ul style="margin:6px 0 0;padding-left:18px">${d.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      <form class="card card-pad stack" id="formImport">
        <label class="field">Nome do modelo<input name="nome" required value="${esc(importacao.arquivo.replace(/\.xlsx?(\.xlsx?)?$/i, '').replace(/[_-]+/g, ' '))}"></label>
        <label class="check"><input type="checkbox" name="padrao" ${!lib.modeloPadraoId || !(lib.modelosEAP || []).length ? 'checked' : 'checked'}> Usar como <b>modelo inicial</b> das novas obras</label>
        <div class="muted small">As composições da planilha entram na biblioteca: mesmos coeficientes → aproveita (atualizando fonte, ref. SINAPI e etapa); coeficientes diferentes → nova versão.</div>
        <div class="row"><button type="button" class="btn" data-act="importarCancelar">Cancelar</button>
          <button type="button" class="btn" data-act="importarModelo">Salvar modelo</button>
          <button type="button" class="btn primary" data-act="importarModeloObra">Salvar modelo e criar obra</button></div>
      </form>
    </div>`;
}

/** Cria uma obra a partir de um modelo, perguntando as fases. */
async function criarObraDoModelo(m, nome, inicio) {
  const r = await escolherFases(m, null);
  if (!r) return null;
  const lib = store.lib();
  const o = novaObra({ nome, inicio });
  if (m.premissas?.jornada > 0) o.jornada = m.premissas.jornada;
  if (m.premissas?.eficiencia > 0) o.eficiencia = m.premissas.eficiencia;
  const res = instanciarModelo(o, m, r.sel, { orcamento: r.orcamento, quantidades: r.quantidades }, lib);
  store.addObra(o);
  location.hash = `#/obra/${o.id}/atividades`;
  if (res.avisos.length) setTimeout(() => info('Obra criada', `<p style="margin-top:0">${o.eap.length} itens na EAP, ${o.dependencias.length} predecessoras, ${o.orcamento.length} itens de orçamento.</p><details><summary>${res.avisos.length} aviso(s)</summary><ul class="small">${res.avisos.slice(0, 40).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>`), 80);
  return o;
}

/* ---------- ações ---------- */
const comp = (id) => store.lib().composicoes.find((c) => c.id === id);

async function salvarModeloImportado() {
  const form = document.getElementById('formImport');
  if (!form.reportValidity()) return null;
  const v = Object.fromEntries(new FormData(form));
  const lib = store.lib();
  const { rel } = aplicarComposicoes(importacao.dados, lib);
  const m = modeloDaPlanilha(importacao.dados, v.nome.trim());
  lib.modelosEAP.push(m);
  if (v.padrao || !lib.modeloPadraoId) lib.modeloPadraoId = m.id;
  store.touch(lib);
  importacao = null;
  toast(`Modelo salvo. Composições: ${rel.novas} nova(s), ${rel.versoes} nova(s) versão(ões), ${rel.iguais} atualizada(s).`, 5000);
  if (rel.conflitos.length) await info('Atenção nas composições', `<p>Mesmo código com descrição diferente — a da planilha virou nova versão (confira em Composições):</p><ul class="small">${rel.conflitos.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`);
  return m;
}

export const acoesBiblioteca = {
  async newObra() {
    const lib = store.lib();
    const obras = store.obras();
    const modelos = lib.modelosEAP || [];
    const pad = modelos.find((m) => m.id === lib.modeloPadraoId);
    const opcoes = [
      ...(pad ? [{ value: `m:${pad.id}`, label: `★ Modelo inicial: ${pad.nome} (escolher fases)` }] : []),
      ...modelos.filter((m) => m !== pad).map((m) => ({ value: `m:${m.id}`, label: `Modelo: ${m.nome} (escolher fases)` })),
      { value: '', label: 'EAP vazia' },
      ...obras.map((o) => ({ value: `o:${o.id}`, label: `Cópia da obra: ${o.nome}` })),
    ];
    const v = await formDialog({ title: 'Nova obra', ok: 'Continuar', fields: [
      { name: 'nome', label: 'Nome da obra', required: true, placeholder: 'ex.: Residência Silva' },
      { name: 'inicio', label: 'Data de início', type: 'date', required: true, value: todayISO() },
      { name: 'base', label: 'Começar com', type: 'select', value: opcoes[0].value, options: opcoes },
    ] });
    if (!v) return;
    if (v.base.startsWith('m:')) return criarObraDoModelo(modelos.find((m) => m.id === v.base.slice(2)), v.nome.trim(), v.inicio);
    let o;
    if (v.base.startsWith('o:')) { o = store.duplicateObra(store.obra(v.base.slice(2)), v.nome.trim()); o.inicio = v.inicio; store.touch(o); }
    else o = store.addObra(novaObra({ nome: v.nome.trim(), inicio: v.inicio }));
    location.hash = `#/obra/${o.id}/atividades`;
  },
  modeloPadrao(d) { const lib = store.lib(); lib.modeloPadraoId = d.id; commit(lib); toast('Modelo inicial definido.'); },
  async modeloRenomear(d) {
    const lib = store.lib(); const m = lib.modelosEAP.find((x) => x.id === d.id);
    const v = await formDialog({ title: 'Renomear modelo', fields: [{ name: 'nome', label: 'Nome', required: true, value: m.nome }] });
    if (!v) return; m.nome = v.nome.trim(); commit(lib);
  },
  async delModelo(d) {
    const lib = store.lib(); const m = lib.modelosEAP.find((x) => x.id === d.id);
    if (!(await ask(`Excluir o modelo "${m.nome}"? As obras criadas com ele não mudam, mas não será mais possível adicionar fases dele.`, 'Excluir'))) return;
    lib.modelosEAP = lib.modelosEAP.filter((x) => x.id !== d.id);
    if (lib.modeloPadraoId === d.id) lib.modeloPadraoId = lib.modelosEAP[0]?.id || null;
    commit(lib);
  },

  // Composições
  compNova() {
    const lib = store.lib();
    const nums = lib.composicoes.map((c) => c.codigo.match(/(\d+)$/)?.[1]).filter(Boolean).map(Number);
    const c = novaComposicao({ codigo: `C${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`, descricao: 'Nova composição' });
    lib.composicoes.push(c);
    ui.compFilter = ''; ui.pendingFocus = `cd:${c.id}`;
    commit(lib);
  },
  moNova(d) { const lib = store.lib(); comp(d.c).maoObra.push({ id: uid(), funcao: 'Servente', coef: 0, lider: false }); commit(lib); },
  moExcluir(d) {
    const lib = store.lib(); const c = comp(d.c);
    const m = c.maoObra.find((x) => x.id === d.id);
    c.maoObra = c.maoObra.filter((x) => x.id !== d.id);
    if (m?.lider && c.maoObra.length) { c.maoObra[0].lider = true; toast(`${c.maoObra[0].funcao} passou a ser a função líder.`); }
    commit(lib);
  },
  compVersao(d) {
    const lib = store.lib(); const c = comp(d.id);
    const irmas = lib.composicoes.filter((x) => x.codigo === c.codigo);
    const nova = { ...JSON.parse(JSON.stringify(c)), id: uid(), versao: Math.max(...irmas.map((x) => x.versao || 1)) + 1, ativa: true };
    nova.maoObra.forEach((m) => { m.id = uid(); });
    irmas.forEach((x) => { x.ativa = false; });
    lib.composicoes.push(nova);
    commit(lib);
    toast(`Versão ${nova.versao} criada. Itens de orçamento existentes continuam na versão que usavam.`, 4500);
  },
  async compDuplicar(d) {
    const lib = store.lib(); const c = comp(d.id);
    const nums = lib.composicoes.map((x) => x.codigo.match(/^P(\d+)$/)?.[1]).filter(Boolean).map(Number);
    const v = await formDialog({ title: 'Duplicar como composição própria', ok: 'Criar', fields: [
      { name: 'codigo', label: 'Código', required: true, value: `P${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}` },
      { name: 'descricao', label: 'Descrição', required: true, value: c.descricao },
    ] });
    if (!v) return;
    const nova = { ...JSON.parse(JSON.stringify(c)), id: uid(), codigo: v.codigo.trim(), descricao: v.descricao.trim(), fonte: 'Própria (sugerida)', versao: 1, ativa: true,
      obs: [c.refSinapi ? `baseada no SINAPI ${c.refSinapi}` : `baseada em ${c.codigo}`, c.obs].filter(Boolean).join(' · ') };
    nova.maoObra.forEach((m) => { m.id = uid(); });
    lib.composicoes.push(nova);
    ui.compFilter = nova.codigo; ui.pendingFocus = `cd:${nova.id}`;
    commit(lib);
  },
  compAtivar(d) { const lib = store.lib(); const c = comp(d.id); lib.composicoes.filter((x) => x.codigo === c.codigo).forEach((x) => { x.ativa = x.id === c.id; }); commit(lib); },
  async compExcluir(d) {
    const lib = store.lib(); const c = comp(d.id); const uso = usoComp(d.id);
    if (!(await ask(uso ? `A composição ${c.codigo} é usada em ${uso} obra(s). Os itens do orçamento ficarão sem composição. Excluir mesmo assim?` : `Excluir a composição ${c.codigo} — ${c.descricao}?`, 'Excluir'))) return;
    lib.composicoes = lib.composicoes.filter((x) => x.id !== d.id);
    commit(lib);
  },

  // Importação
  importarCancelar() { importacao = null; queueRender(); },
  async importarModelo() { const m = await salvarModeloImportado(); if (m) { location.hash = '#/obras'; queueRender(); } },
  async importarModeloObra() {
    const m = await salvarModeloImportado();
    if (!m) return;
    queueRender();
    const v = await formDialog({ title: 'Nova obra', ok: 'Escolher fases', text: `A partir do modelo "${m.nome}".`, fields: [
      { name: 'nome', label: 'Nome da obra', required: true }, { name: 'inicio', label: 'Data de início', type: 'date', required: true, value: todayISO() },
    ] });
    if (!v) { location.hash = '#/obras'; return; }
    const o = await criarObraDoModelo(m, v.nome.trim(), v.inicio);
    if (!o) location.hash = '#/obras';
  },
};

export const mudancasBiblioteca = {
  compField(d, el) {
    const lib = store.lib(); const c = comp(d.id);
    const v = el.value.trim();
    if ((d.f === 'codigo' || d.f === 'descricao') && !v) return queueRender();
    c[d.f] = v; commit(lib);
  },
  moField(d, el) {
    const lib = store.lib(); const m = comp(d.c).maoObra.find((x) => x.id === d.id);
    if (d.f === 'coef') m.coef = Math.max(0, parseNum(el.value) ?? 0); else m.funcao = el.value.trim();
    commit(lib);
  },
  moLider(d) { const lib = store.lib(); comp(d.c).maoObra.forEach((m) => { m.lider = m.id === d.id; }); commit(lib); },
  async compImportar(d, el) {
    const f = el.files[0]; if (!f) return;
    try {
      const dados = interpretar(await lerArquivo(f));
      if (!dados.composicoes.length) return toast('Nenhuma composição encontrada na aba Composicoes.');
      const lib = store.lib();
      const { rel } = aplicarComposicoes(dados, lib);
      commit(lib);
      toast(`Composições: ${rel.novas} nova(s), ${rel.versoes} nova(s) versão(ões), ${rel.iguais} atualizada(s).`, 5000);
    } catch (e) { toast('Erro ao ler a planilha: ' + e.message, 5000); }
    el.value = '';
  },
  async importarArquivo(d, el) {
    const f = el.files[0]; if (!f) return;
    try {
      toast('Lendo a planilha…');
      const dados = interpretar(await lerArquivo(f));
      if (!dados.atividades.length) return toast('Não encontrei a aba EAP Detalhada com o cabeçalho esperado.', 5000);
      importacao = { arquivo: f.name, dados };
      queueRender();
    } catch (e) { toast('Erro ao ler a planilha: ' + e.message, 5000); }
  },
};

export const entradasBiblioteca = {
  compFilter(el) { ui.compFilter = el.value; queueRender(); },
};
