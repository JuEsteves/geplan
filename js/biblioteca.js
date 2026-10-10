// Telas gerais: Obras (lista, nova obra, modelos de EAP), Composições e Importar planilha.
import * as store from './store.js';
import { calcular, validarComposicao, liderDe } from './calculo.js';
import { cronograma } from './cpm.js';
import { avanco } from './curvaS.js';
import { novaComposicao, FONTES, uid, novaObra, novaAtividade, normalizaTipo, renumerar } from './model.js';
import { lerArquivo, interpretar, aplicarComposicoes, criarObraImportada, modeloDaEAP, montarEAP } from './importador.js';
import { fmtBR, fmtNum, fmtBRL, todayISO, todayDay } from './schedule.js';
import { esc, I, ui, toast, formDialog, ask, info, commit, queueRender, parseNum, fmtIn } from './ui.js';

const natural = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true });

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
      <p class="small">Comece importando a planilha modelo (EAP, composições, orçamento e vínculos) ou crie uma obra do zero.</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div></div>`}
    ${modelos.length ? `<div class="card" style="margin-top:18px"><div class="card-pad" style="padding-bottom:6px"><h2>Modelos de EAP</h2><div class="muted small">Usados para criar novas obras com a mesma estrutura de etapas e predecessoras.</div></div>
      ${modelos.map((m) => `<div class="list-item"><span style="flex:1"><b>${esc(m.nome)}</b> <span class="muted small">· ${m.atividades.length} itens · ${m.criadoEm || ''}</span></span><button class="icon-btn danger" data-act="delModelo" data-id="${m.id}" title="Excluir modelo">${I.trash}</button></div>`).join('')}</div>` : ''}`;
}

/** Cria a EAP de uma obra a partir de um modelo salvo. */
function aplicarModelo(o, m) {
  montarEAP(o, m.atividades.map((a) => ({ ...a, nivel: a.nivel || a.codigo.split('.').length })), new Map(m.atividades.filter((a) => a.equipe != null || a.duracaoManual != null).map((a) => [a.codigo, { equipe: a.equipe ?? null, manual: a.duracaoManual ?? null }])));
  renumerar(o);
}

/* ---------- Composições ---------- */
function usoComp(id) { return store.obras().filter((o) => o.orcamento.some((it) => it.composicaoId === id)).length; }

export function viewComposicoes() {
  const lib = store.lib();
  const f = ui.compFilter.trim().toLowerCase();
  const list = [...lib.composicoes].sort((a, b) => natural(a.codigo, b.codigo) || (b.versao - a.versao))
    .filter((c) => !f || `${c.codigo} ${c.descricao}`.toLowerCase().includes(f));
  const cards = list.map((c) => {
    const erros = validarComposicao(c);
    const uso = usoComp(c.id);
    const L = liderDe(c);
    return `<div class="card comp-card2${c.ativa ? '' : ' inativa'}">
      <div class="comp-top">
        <input class="cell w-code" data-chg="compField" data-f="codigo" data-id="${c.id}" data-key="cc:${c.id}" value="${esc(c.codigo)}" placeholder="Código">
        <input class="cell" style="flex:1;min-width:180px" data-chg="compField" data-f="descricao" data-id="${c.id}" data-key="cd:${c.id}" value="${esc(c.descricao)}" placeholder="Descrição do serviço">
        <input class="cell w-un" list="unidades" data-chg="compField" data-f="unidade" data-id="${c.id}" value="${esc(c.unidade)}" title="Unidade">
        <select class="cell w-fonte" data-chg="compField" data-f="fonte" data-id="${c.id}" title="Fonte">${FONTES.map((x) => `<option ${x === c.fonte ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <span class="badge ${c.ativa ? 'info' : ''}" title="Versão">v${c.versao || 1}${c.ativa ? '' : ' · inativa'}</span>
        ${uso ? `<span class="badge" title="Obras que usam">${uso} obra${uso > 1 ? 's' : ''}</span>` : ''}
        ${erros.length ? `<span class="badge crit">${esc(erros.join(' · '))}</span>` : ''}
      </div>
      <table class="data mo">
        <thead><tr><th>Função (mão de obra)</th><th class="num">Coef. (h/${esc(c.unidade)})</th><th title="A função líder define o prazo">Líder</th><th class="num">Produção da equipe líder</th><th></th></tr></thead>
        <tbody>${c.maoObra.map((m) => `<tr>
          <td><input class="cell" data-chg="moField" data-f="funcao" data-c="${c.id}" data-id="${m.id}" value="${esc(m.funcao)}"></td>
          <td><input class="cell w-num" inputmode="decimal" data-chg="moField" data-f="coef" data-c="${c.id}" data-id="${m.id}" value="${fmtIn(m.coef, 4)}"></td>
          <td><input type="radio" name="lider-${c.id}" data-chg="moLider" data-c="${c.id}" data-id="${m.id}" ${m.lider ? 'checked' : ''} aria-label="Função líder"></td>
          <td class="num small muted">${m.lider && m.coef > 0 ? `≈ ${fmtNum(8.8 * 0.85 / m.coef, 2)} ${esc(c.unidade)}/dia por profissional` : ''}</td>
          <td><button class="icon-btn danger" data-act="moExcluir" data-c="${c.id}" data-id="${m.id}" title="Remover função">${I.trash}</button></td></tr>`).join('')}</tbody>
      </table>
      <div class="row" style="padding:8px 12px">
        <button class="btn sm" data-act="moNova" data-c="${c.id}">${I.plus} Função</button>
        <button class="btn sm" data-act="compVersao" data-id="${c.id}" title="Cria uma cópia com versão nova (a atual fica inativa)">Nova versão</button>
        ${!c.ativa ? `<button class="btn sm" data-act="compAtivar" data-id="${c.id}">Tornar ativa</button>` : ''}
        <span style="flex:1"></span>
        <input class="cell" style="max-width:320px" data-chg="compField" data-f="obs" data-id="${c.id}" value="${esc(c.obs || '')}" placeholder="Observação / referência">
        <button class="icon-btn danger" data-act="compExcluir" data-id="${c.id}" title="Excluir composição">${I.trash}</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="page-head"><div><h1>Composições</h1><div class="muted">Coeficientes de mão de obra por função (h/unidade). A função líder define a duração.</div></div>
    <div class="row"><label class="btn">${I.upload} Importar da planilha<input type="file" accept=".xlsx,.xls" data-chg="compImportar" hidden></label><button class="btn primary" data-act="compNova">${I.plus} Nova composição</button></div></div>
    <div class="stack">
      <input data-inp="compFilter" data-key="compFilter" value="${esc(ui.compFilter)}" placeholder="Buscar por código ou descrição…">
      ${cards || `<div class="card empty"><p>${f ? 'Nenhuma composição encontrada.' : 'Nenhuma composição cadastrada.'}</p></div>`}
      <div class="muted small">Produção ≈ jornada 8,8 h × eficiência 0,85 ÷ coeficiente (referência; cada obra usa a própria jornada e eficiência). Coeficiente próprio (Obra própria / RDO) prevalece sobre SINAPI/TCPO — registre sempre a fonte.</div>
    </div>`;
}

/* ---------- Importar planilha ---------- */
let importacao = null; // { arquivo, dados }

export function viewImportar() {
  if (!importacao) {
    return `<div class="page-head"><div><a href="#/obras" class="muted small" style="text-decoration:none">← Obras</a><h1>Importar planilha</h1>
      <div class="muted">Cria uma obra a partir do modelo de orçamento × cronograma (.xlsx)</div></div></div>
      <div class="card card-pad stack" style="max-width:760px">
        <p style="margin:0">A planilha deve ter as abas <b>EAP Detalhada</b>, <b>Composicoes</b>, <b>Orcamento</b>, <b>Vinculo_Orc_EAP</b> e (opcional) <b>Duracao_Atividades</b> — as mesmas colunas do modelo.</p>
        <label class="btn primary" style="align-self:flex-start">${I.upload} Escolher arquivo .xlsx<input type="file" accept=".xlsx,.xls" data-chg="importarArquivo" hidden></label>
        <p class="muted small" style="margin:0">O arquivo é lido no seu navegador; nada é enviado para a internet além do seu Google Drive.</p>
      </div>`;
  }
  const d = importacao.dados;
  const folhas = d.atividades.filter((a) => a.codigo.split('.').length >= 3).length;
  return `<div class="page-head"><div><a href="#/obras" class="muted small" style="text-decoration:none">← Obras</a><h1>Importar planilha</h1><div class="muted">${esc(importacao.arquivo)}</div></div></div>
    <div class="stack" style="max-width:860px">
      <div class="kpis">
        <div class="card kpi"><div class="k-label">Linhas da EAP</div><div class="k-value">${d.atividades.length}</div><div class="k-sub">${folhas} atividades de nível 3</div></div>
        <div class="card kpi"><div class="k-label">Composições</div><div class="k-value">${d.composicoes.length}</div></div>
        <div class="card kpi"><div class="k-label">Itens do orçamento</div><div class="k-value">${d.orcamento.length}</div></div>
        <div class="card kpi"><div class="k-label">Vínculos</div><div class="k-value">${d.vinculos.length}</div></div>
        <div class="card kpi"><div class="k-label">Equipes/durações</div><div class="k-value">${d.duracoes.size}</div></div>
      </div>
      ${d.avisos.length ? `<div class="alert info"><b>Avisos da leitura</b><ul style="margin:6px 0 0;padding-left:18px">${d.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      <form class="card card-pad stack" id="formImport">
        <div class="grid-form">
          <label class="field">Nome da obra<input name="nome" required value="${esc(importacao.arquivo.replace(/\.xlsx?(\.xlsx?)?$/i, '').replace(/[_-]+/g, ' '))}"></label>
          <label class="field">Data de início<input type="date" name="inicio" required value="${todayISO()}"></label>
          <label class="field">Jornada (h/dia útil)<input name="jornada" inputmode="decimal" value="${fmtIn(d.premissas.jornada || 8.8, 2)}"></label>
          <label class="field">Eficiência<input name="eficiencia" inputmode="decimal" value="${fmtIn(d.premissas.eficiencia || 0.85, 3)}"></label>
        </div>
        <label class="check"><input type="checkbox" name="modelo" checked> Salvar a EAP também como modelo (para novas obras)</label>
        <div class="row"><button type="button" class="btn" data-act="importarCancelar">Cancelar</button><button type="button" class="btn primary" data-act="importarCriar">Criar obra</button></div>
      </form>
      <div class="muted small">Composições com o mesmo código e os mesmos coeficientes são reaproveitadas; se os coeficientes forem diferentes, é criada uma nova versão.</div>
    </div>`;
}

/* ---------- ações ---------- */
const comp = (id) => store.lib().composicoes.find((c) => c.id === id);

export const acoesBiblioteca = {
  async newObra() {
    const lib = store.lib();
    const obras = store.obras();
    const opcoes = [{ value: '', label: 'EAP vazia' }, ...(lib.modelosEAP || []).map((m) => ({ value: `m:${m.id}`, label: `Modelo: ${m.nome}` })), ...obras.map((o) => ({ value: `o:${o.id}`, label: `Cópia da obra: ${o.nome}` }))];
    const v = await formDialog({ title: 'Nova obra', ok: 'Criar obra', fields: [
      { name: 'nome', label: 'Nome da obra', required: true, placeholder: 'ex.: Residência Silva' },
      { name: 'inicio', label: 'Data de início', type: 'date', required: true, value: todayISO() },
      { name: 'base', label: 'Começar com', type: 'select', value: '', options: opcoes },
    ] });
    if (!v) return;
    let o;
    if (v.base.startsWith('o:')) { o = store.duplicateObra(store.obra(v.base.slice(2)), v.nome.trim()); o.inicio = v.inicio; store.touch(o); }
    else {
      o = novaObra({ nome: v.nome.trim(), inicio: v.inicio });
      if (v.base.startsWith('m:')) aplicarModelo(o, lib.modelosEAP.find((m) => m.id === v.base.slice(2)));
      store.addObra(o);
    }
    location.hash = `#/obra/${o.id}/atividades`;
  },
  async delModelo(d) {
    const lib = store.lib(); const m = lib.modelosEAP.find((x) => x.id === d.id);
    if (!(await ask(`Excluir o modelo "${m.nome}"? As obras criadas com ele não mudam.`, 'Excluir'))) return;
    lib.modelosEAP = lib.modelosEAP.filter((x) => x.id !== d.id); commit(lib);
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
  compAtivar(d) { const lib = store.lib(); const c = comp(d.id); lib.composicoes.filter((x) => x.codigo === c.codigo).forEach((x) => { x.ativa = x.id === c.id; }); commit(lib); },
  async compExcluir(d) {
    const lib = store.lib(); const c = comp(d.id); const uso = usoComp(d.id);
    if (!(await ask(uso ? `A composição ${c.codigo} é usada em ${uso} obra(s). Os itens do orçamento ficarão sem composição. Excluir mesmo assim?` : `Excluir a composição ${c.codigo} — ${c.descricao}?`, 'Excluir'))) return;
    lib.composicoes = lib.composicoes.filter((x) => x.id !== d.id);
    commit(lib);
  },

  // Importação
  importarCancelar() { importacao = null; queueRender(); },
  async importarCriar() {
    const form = document.getElementById('formImport');
    if (!form.reportValidity()) return;
    const v = Object.fromEntries(new FormData(form));
    const lib = store.lib();
    const d = importacao.dados;
    d.premissas.jornada = parseNum(v.jornada) || d.premissas.jornada;
    d.premissas.eficiencia = parseNum(v.eficiencia) || d.premissas.eficiencia;
    const { obra, avisos, rel } = criarObraImportada(d, { nome: v.nome.trim(), inicio: v.inicio }, lib);
    if (v.modelo) lib.modelosEAP.push(modeloDaEAP(`EAP ${v.nome.trim()}`, d.atividades));
    store.touch(lib);
    store.addObra(obra);
    importacao = null;
    location.hash = `#/obra/${obra.id}/atividades`;
    const calc = calcular(obra, lib);
    await info('Obra importada', `<p style="margin-top:0"><b>${obra.eap.length}</b> itens na EAP, <b>${obra.orcamento.length}</b> itens de orçamento, <b>${obra.vinculos.length}</b> vínculos e <b>${obra.dependencias.length}</b> predecessoras.</p>
      <p>Composições: ${rel.novas} nova(s), ${rel.versoes} nova(s) versão(ões), ${rel.iguais} reaproveitada(s).</p>
      ${rel.conflitos?.length ? `<div class="alert err small">Mesmo código com descrição diferente (a da planilha virou nova versão — confira em Composições): ${rel.conflitos.map(esc).join('; ')}</div>` : ''}
      <p>Total do orçamento: <b>${fmtBRL(calc.totalOrcamento)}</b> · alocado na EAP: <b>${fmtBRL(calc.totalAlocado)}</b>.</p>
      <p><b>${calc.alertasAtiv}</b> atividades com alerta (a maioria por estar sem duração definida — usam a duração padrão do tipo até você preencher). Use o filtro "Só com alertas" na aba Atividades.</p>
      ${avisos.length ? `<details><summary>${avisos.length} aviso(s)</summary><ul class="small">${avisos.slice(0, 50).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}`);
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
      toast(`Composições: ${rel.novas} nova(s), ${rel.versoes} nova(s) versão(ões), ${rel.iguais} já existente(s).`, 5000);
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
