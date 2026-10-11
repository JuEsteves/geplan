// Base SINAPI dentro do GEPLAN.
// A Caixa não oferece API pública: publica todo mês planilhas Excel (ZIP por UF) com as composições analíticas.
// Aqui a pessoa importa essa planilha uma vez; a base fica salva neste aparelho (IndexedDB) e pode ser pesquisada.
// Cada composição pode ser adicionada à biblioteca (com as funções de mão de obra e coeficientes) e ajustada à vontade.
import * as store from './store.js';
import { LIBS, loadScript } from './libs.js';
import { novaComposicao, uid } from './model.js';
import { norm } from './importador.js';
import { esc, I, ui, toast, formDialog, info, ask, commit, queueRender } from './ui.js';
import { fmtNum } from './schedule.js';

/* ---------- armazenamento (IndexedDB) ---------- */
const DB = 'geplan-sinapi', STORE = 'base';
const abrir = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function idb(modo, fn) {
  const db = await abrir();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, modo); const st = tx.objectStore(STORE);
    const req = fn(st); tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error);
  });
}
let base = null, carregando = null;
export async function carregarBase() {
  if (base) return base;
  carregando ||= idb('readonly', (st) => st.get('atual')).then((b) => { base = b || null; return base; }).catch(() => null);
  return carregando;
}
async function salvarBase(b) { await idb('readwrite', (st) => st.put(b, 'atual')); base = b; carregando = null; }
async function apagarBase() { await idb('readwrite', (st) => st.delete('atual')); base = null; carregando = null; }

/* ---------- leitura da planilha da Caixa ---------- */
const COLS = {
  compCod: ['codigo da composicao', 'cod. composicao', 'codigo composicao', 'cod composicao'],
  compDesc: ['descricao da composicao', 'descricao composicao'],
  compUn: ['unidade da composicao', 'unidade composicao'],
  tipo: ['tipo item', 'tipo do item', 'tipo'],
  itemCod: ['codigo item', 'codigo do item', 'cod. item', 'codigo insumo'],
  itemDesc: ['descricao item', 'descricao do item', 'descricao insumo'],
  itemUn: ['unidade item', 'unidade do item', 'unid. item'],
  coef: ['coeficiente', 'coef'],
  grupo: ['descricao da classe', 'grupo', 'classe'],
  desc: ['descricao'], un: ['unidade', 'unid'],
};

function acharCabecalho(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = rows[i].map((c) => norm(c));
    if (!h.some((x) => x.includes('coeficiente'))) continue;
    if (!h.some((x) => x.includes('codigo') || x.startsWith('cod'))) continue;
    const idx = {};
    const usados = new Set();
    for (const [k, pads] of Object.entries(COLS)) {
      let j = -1;
      for (const p of pads) { j = h.findIndex((x, n) => !usados.has(n) && (x === p || x.startsWith(p))); if (j >= 0) break; }
      if (j < 0) for (const p of pads) { j = h.findIndex((x, n) => !usados.has(n) && x.includes(p)); if (j >= 0) break; }
      idx[k] = j;
      if (j >= 0 && !['desc', 'un'].includes(k)) usados.add(j);
    }
    if (idx.compCod < 0) idx.compCod = h.findIndex((x) => x === 'codigo' || x.startsWith('codigo'));
    if (idx.compCod >= 0 && idx.coef >= 0) return { linha: i, idx };
  }
  return null;
}

const TIPOS_ITEM = /^(composicao|insumo|comp|ins)/;

/** Lê a pasta de trabalho da Caixa (formato "analítico"). Puro: retorna { composicoes, ref, avisos }. */
export function interpretarSinapi(wb) {
  const X = window.XLSX;
  const comps = new Map();
  let ref = '';
  for (const nome of wb.SheetNames) {
    const rows = X.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '' });
    if (!ref) {
      const topo = rows.slice(0, 12).flat().map((x) => String(x)).join(' ');
      const m = topo.match(/(\d{2})\/(\d{4})/);
      const UFS = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';
      const uf = topo.match(new RegExp(`(?:localidade|uf|estado)\\s*[:\\-]?\\s*(${UFS})(?![A-Za-zÀ-ÿ])`, 'i'))
        || topo.match(new RegExp(`(?:^|[^A-Za-zÀ-ÿ])(${UFS})(?![A-Za-zÀ-ÿ])`));
      const reg = /n[aã]o\s+desonerad/i.test(topo) ? 'não desonerado' : /desonerad/i.test(topo) ? 'desonerado' : '';
      if (m) ref = [uf?.[1], `${m[1]}/${m[2]}`, reg].filter(Boolean).join(' · ');
    }
    const h = acharCabecalho(rows);
    if (!h) continue;
    const { idx } = h;
    const v = (r, k) => (idx[k] >= 0 ? r[idx[k]] : '');
    let atual = null;
    for (const r of rows.slice(h.linha + 1)) {
      const cc = String(v(r, 'compCod') ?? '').trim();
      if (!cc || !/\d/.test(cc)) continue;
      const tipo = norm(v(r, 'tipo'));
      if (!comps.has(cc)) comps.set(cc, { c: cc, d: '', u: '', g: '', it: [] });
      atual = comps.get(cc);
      // layout clássico: descrição/unidade da composição repetidas em todas as linhas (colunas sem 'item')
      const descComp = String(v(r, 'compDesc') || (idx.compDesc < 0 && idx.itemDesc >= 0 ? v(r, 'desc') : '') || '').trim();
      const unComp = String(v(r, 'compUn') || (idx.compUn < 0 && idx.itemUn >= 0 ? v(r, 'un') : '') || '').trim();
      if (descComp && !atual.d) atual.d = descComp;
      if (unComp && !atual.u) atual.u = unComp;
      if (!atual.g) atual.g = String(v(r, 'grupo') || '').trim();
      const ehItem = TIPOS_ITEM.test(tipo) || (String(v(r, 'itemCod') || '').trim() && v(r, 'coef') !== '');
      if (!ehItem) {
        // linha de cabeçalho da composição (layout em que a descrição/unidade da composição vem numa linha própria)
        if (!atual.d) atual.d = String(v(r, 'desc') || '').trim();
        if (!atual.u) atual.u = String(v(r, 'un') || '').trim();
        continue;
      }
      const coef = typeof v(r, 'coef') === 'number' ? v(r, 'coef') : Number(String(v(r, 'coef')).replace(/\./g, '').replace(',', '.'));
      if (!isFinite(coef)) continue;
      const itemDesc = String((idx.itemDesc >= 0 ? v(r, 'itemDesc') : v(r, 'desc')) || '').trim();
      const itemUn = String((idx.itemUn >= 0 ? v(r, 'itemUn') : v(r, 'un')) || '').trim();
      atual.it.push([tipo.startsWith('comp') ? 'C' : 'I', String(v(r, 'itemCod') || '').trim(), itemDesc, itemUn, coef]);
    }
  }
  const composicoes = [...comps.values()].filter((c) => c.d && c.it.length);
  const avisos = [];
  if (!composicoes.length) avisos.push('Não encontrei composições analíticas (colunas de código da composição, item e coeficiente) nesta planilha.');
  return { composicoes, ref, avisos };
}

/* ---------- mão de obra ---------- */
const AJUDANTE = /servente|ajudante|auxiliar|apontador/i;
const nomeFuncao = (d) => {
  const s = d.replace(/\s+com\s+encargos\s+complementares/i, '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** Funções de mão de obra (itens em horas) e a líder sugerida (maior coeficiente que não seja ajudante/servente). */
export function maoDeObra(c) {
  const mo = c.it.filter((i) => /^h$/i.test(i[3].trim()) || /^h\b/i.test(i[3].trim())).map((i) => ({ funcao: nomeFuncao(i[2]), coef: Number(i[4]) || 0, ref: i[1] }));
  if (!mo.length) return [];
  const cand = mo.filter((f) => !AJUDANTE.test(f.funcao));
  const lider = (cand.length ? cand : mo).reduce((a, b) => (b.coef > a.coef ? b : a));
  return mo.map((f) => ({ ...f, lider: f === lider }));
}

/* ---------- tela ---------- */
export function viewSinapi() {
  const lib = store.lib();
  const abas = `<div class="tabs"><a href="#/composicoes">Minha biblioteca (${lib.composicoes.length})</a><a href="#/sinapi" class="active">Base SINAPI</a></div>`;
  const cab = `<div class="page-head"><div><h1>Composições</h1><div class="muted">Pesquise na base SINAPI e adicione à sua biblioteca para usar e ajustar os coeficientes.</div></div></div>${abas}`;
  if (!base) {
    return `${cab}<div class="card card-pad stack" style="max-width:820px" id="sinapiVazio">
      <h2>Importar a base SINAPI</h2>
      <p style="margin:0">A Caixa não oferece uma API: ela publica todo mês, por estado, planilhas Excel com as composições e seus coeficientes. Você importa a planilha uma vez e passa a pesquisar tudo aqui dentro.</p>
      <ol class="small" style="margin:0;padding-left:18px">
        <li>No site da Caixa, abra <a href="https://www.caixa.gov.br/poder-publico/modernizacao-gestao/sinapi/Paginas/default.aspx" target="_blank" rel="noopener">SINAPI</a> › Referências de preços e custos.</li>
        <li>Escolha o <b>estado</b> e o <b>mês</b> e baixe o arquivo <b>ZIP com as planilhas (XLSX)</b> — desonerado ou não, conforme o seu orçamento.</li>
        <li>Extraia o ZIP e escolha abaixo a planilha de <b>composições analíticas</b> (a que tem os coeficientes de cada item).</li>
      </ol>
      <div class="row"><label class="btn primary">${I.upload} Importar planilha do SINAPI<input type="file" accept=".xlsx,.xls,.xlsb" data-chg="sinapiArquivo" hidden></label></div>
      <p class="muted small" style="margin:0">A base fica salva neste aparelho (não ocupa o seu Google Drive). Em outro aparelho, importe de novo. As composições que você adicionar à biblioteca são sincronizadas normalmente.</p>
    </div>`;
  }
  const termo = (ui.sinapiBusca || '').trim();
  let res = [];
  if (termo) {
    const palavras = norm(termo).split(' ').filter(Boolean);
    for (const c of base.composicoes) {
      const alvo = `${c.c} ${norm(c.d)}`;
      if (palavras.every((p) => alvo.includes(p))) { res.push(c); if (res.length >= 60) break; }
    }
  }
  const naLib = new Set(lib.composicoes.map((c) => c.refSinapi).filter(Boolean));
  const cards = res.map((c) => {
    const mo = maoDeObra(c);
    return `<div class="card sinapi-item">
      <div class="row between" style="align-items:flex-start"><div style="flex:1;min-width:200px"><b>${esc(c.c)}</b> ${esc(c.d)} <span class="muted">(${esc(c.u)})</span>${c.g ? `<div class="small muted">${esc(c.g)}</div>` : ''}</div>
        <div class="row">${naLib.has(c.c) ? '<span class="badge good">na biblioteca</span>' : ''}<button class="btn sm" data-act="sinapiDetalhe" data-c="${esc(c.c)}">Ver itens</button><button class="btn sm primary" data-act="sinapiAdicionar" data-c="${esc(c.c)}">${I.plus} Adicionar à biblioteca</button></div></div>
      <div class="small" style="margin-top:6px">${mo.length ? mo.map((f) => `<span class="chip${f.lider ? ' lider' : ''}">${esc(f.funcao)} ${fmtNum(f.coef, 4)} h/${esc(c.u)}${f.lider ? ' · líder' : ''}</span>`).join(' ') : '<span class="muted">sem mão de obra em horas (verifique os itens)</span>'}</div>
    </div>`;
  }).join('');
  return `${cab}<div class="stack">
    <div class="card card-pad row between"><div><b>Base SINAPI ${esc(base.ref || '')}</b><div class="muted small">${fmtNum(base.composicoes.length, 0)} composições · importada em ${esc(base.importadoEm)} · arquivo ${esc(base.arquivo || '')}</div></div>
      <div class="row"><label class="btn sm">${I.upload} Atualizar (outro mês)<input type="file" accept=".xlsx,.xls,.xlsb" data-chg="sinapiArquivo" hidden></label><button class="btn sm danger" data-act="sinapiApagar">${I.trash} Remover base</button></div></div>
    <input data-inp="sinapiBusca" data-key="sinapiBusca" value="${esc(termo)}" placeholder="Pesquise por código ou palavras (ex.: alvenaria bloco ceramico 14, 87529, chapisco)">
    ${termo ? (cards || '<div class="card empty"><p>Nada encontrado.</p></div>') + (res.length >= 60 ? '<div class="muted small">Mostrando as 60 primeiras. Refine a busca.</div>' : '') : '<div class="muted small">Digite para pesquisar. Ao adicionar, a composição entra na sua biblioteca com as funções de mão de obra (itens em horas) e a função líder sugerida — tudo editável.</div>'}
  </div>`;
}

export function depoisSinapi() {
  if (!base && !carregando) carregarBase().then((b) => { if (b) queueRender(); });
}

/* ---------- ações ---------- */
const achar = (cod) => base?.composicoes.find((c) => c.c === cod);

export function adicionarDaSinapi(c, lib) {
  const mo = maoDeObra(c);
  const existentes = lib.composicoes.filter((x) => x.codigo === c.c);
  const maoObra = mo.length ? mo.map((f) => ({ id: uid(), funcao: f.funcao, coef: f.coef, lider: f.lider })) : [{ id: uid(), funcao: 'Profissional', coef: 0, lider: true }];
  const nova = novaComposicao({
    codigo: c.c, descricao: c.d, unidade: c.u, fonte: 'SINAPI', refSinapi: c.c, etapaEap: '', maoObra,
    obs: `SINAPI ${base?.ref || ''}`.trim(), versao: existentes.length ? Math.max(...existentes.map((x) => x.versao || 1)) + 1 : 1,
  });
  existentes.forEach((x) => { x.ativa = false; });
  lib.composicoes.push(nova);
  return nova;
}

export const acoesSinapi = {
  sinapiDetalhe(d) {
    const c = achar(d.c); if (!c) return;
    info(`${c.c} — ${c.d}`, `<p class="muted small" style="margin-top:0">Unidade: ${esc(c.u)}${c.g ? ` · ${esc(c.g)}` : ''} · ${esc(base.ref || '')}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Tipo</th><th>Código</th><th>Item</th><th>Un.</th><th class="num">Coeficiente</th></tr></thead><tbody>
      ${c.it.map((i) => `<tr><td>${i[0] === 'C' ? 'Composição' : 'Insumo'}</td><td>${esc(i[1])}</td><td>${esc(i[2])}</td><td>${esc(i[3])}</td><td class="num">${fmtNum(i[4], 7)}</td></tr>`).join('')}
      </tbody></table></div>`);
  },
  sinapiAdicionar(d) {
    const c = achar(d.c); if (!c) return;
    const lib = store.lib();
    const nova = adicionarDaSinapi(c, lib);
    commit(lib);
    toast(`${nova.codigo} adicionada à biblioteca${nova.versao > 1 ? ` (versão ${nova.versao})` : ''}. Ajuste os coeficientes em Minha biblioteca.`, 4500);
  },
  async sinapiApagar() {
    if (!(await ask('Remover a base SINAPI deste aparelho? As composições já adicionadas à biblioteca continuam.', 'Remover'))) return;
    await apagarBase(); queueRender();
  },
};

export const mudancasSinapi = {
  async sinapiArquivo(d, el) {
    const f = el.files[0]; if (!f) return;
    try {
      toast('Lendo a planilha do SINAPI… (pode levar alguns segundos)', 6000);
      await loadScript(LIBS.xlsx);
      const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const r = interpretarSinapi(wb);
      if (!r.composicoes.length) { el.value = ''; return info('Planilha não reconhecida', `<p>${esc(r.avisos.join(' '))}</p><p class="small muted">Escolha a planilha de composições <b>analíticas</b> (com os itens e coeficientes de cada composição). Se o formato da Caixa mudou, me mande o arquivo para eu ajustar a leitura.</p>`); }
      const v = await formDialog({ title: 'Base SINAPI', ok: 'Salvar base', text: `${fmtNum(r.composicoes.length, 0)} composições encontradas.`, fields: [{ name: 'ref', label: 'Referência (UF · mês/ano · regime)', value: r.ref, placeholder: 'ex.: SP · 08/2026 · não desonerado' }] });
      if (!v) { el.value = ''; return; }
      await salvarBase({ ref: v.ref.trim(), arquivo: f.name, importadoEm: new Date().toLocaleDateString('pt-BR'), composicoes: r.composicoes });
      toast('Base SINAPI salva neste aparelho.');
      queueRender();
    } catch (e) { toast('Erro ao ler a planilha: ' + e.message, 6000); }
    el.value = '';
  },
};

export const entradasSinapi = {
  sinapiBusca(el) { ui.sinapiBusca = el.value; queueRender(); },
};
