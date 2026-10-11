// Importador da planilha modelo e modelos de EAP.
//
// Planilha → interpretar() (puro) → modeloDaPlanilha() → instanciarModelo() na obra, escolhendo as fases.
// Abas: EAP Detalhada, Composicoes, Orcamento, Vinculo_Orc_EAP e Duracao_Atividades.
// Variantes de escopo: etapas com letra no código (ex.: 11B = alternativa à etapa 11). Só uma por etapa entra na obra;
// predecessoras externas são trocadas automaticamente (11.9.5 → 11B.9.5).

import { LIBS, loadScript } from './libs.js';
import { uid, novaObra, novaAtividade, novoItem, novaComposicao, normalizaTipo, normalizaFonte, renumerar, filhosDe } from './model.js';
import { parseNotacao } from './predecessoras.js';

export async function lerArquivo(file) {
  await loadScript(LIBS.xlsx);
  const buf = await file.arrayBuffer();
  return window.XLSX.read(buf, { type: 'array' });
}

/* ---------- leitura das abas ---------- */

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const CODIGO = /^\d+[A-Za-z]?(\.\d+)*$/;

/** Linhas de uma aba como arrays; textos vêm como exibidos (códigos "2.10" não viram número). */
function linhas(ws) {
  const X = window.XLSX;
  if (!ws || !ws['!ref']) return [];
  const r = X.utils.decode_range(ws['!ref']);
  const out = [];
  for (let R = r.s.r; R <= r.e.r; R++) {
    const row = [];
    for (let C = r.s.c; C <= r.e.c; C++) {
      const cell = ws[X.utils.encode_cell({ r: R, c: C })];
      row.push(cell ? { v: cell.v, w: cell.t === 's' ? cell.v : (cell.w ?? String(cell.v)) } : null);
    }
    out.push(row);
  }
  return out;
}

const txt = (c) => (c ? String(c.w ?? c.v ?? '').trim() : '');
const numero = (c) => {
  if (!c || c.v === '' || c.v == null) return null;
  if (typeof c.v === 'number') return c.v;
  const s = String(c.v).trim().replace(/\s|R\$|%/g, '');
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return isNaN(n) ? null : n;
};

/** Acha a linha de cabeçalho e o índice das colunas pedidas (por trechos do texto do cabeçalho). Nome com "?" é opcional. */
function cabecalho(rows, colunas) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const h = rows[i].map((c) => norm(txt(c)));
    const idx = {};
    let ok = true;
    for (const [nome, padroes] of Object.entries(colunas)) {
      const j = h.findIndex((x) => padroes.some((p) => x.includes(p)));
      if (j < 0 && !nome.endsWith('?')) { ok = false; break; }
      idx[nome.replace('?', '')] = j;
    }
    if (ok) return { linha: i, idx };
  }
  return null;
}
const col = (r, j) => (j >= 0 ? r[j] : null);

function aba(wb, ...nomes) {
  const alvo = nomes.map(norm);
  const nome = wb.SheetNames.find((n) => alvo.includes(norm(n))) || wb.SheetNames.find((n) => alvo.some((a) => norm(n).includes(a)));
  return nome ? wb.Sheets[nome] : null;
}

/** Interpreta a pasta de trabalho. Não grava nada. */
export function interpretar(wb) {
  const avisos = [];
  const res = { composicoes: [], atividades: [], orcamento: [], vinculos: [], duracoes: new Map(), premissas: {}, avisos };

  // Composições (uma linha por função)
  const wsC = aba(wb, 'Composicoes', 'Composições');
  if (wsC) {
    const rows = linhas(wsC);
    const h = cabecalho(rows, { cod: ['cod. composicao', 'codigo'], desc: ['descricao'], un: ['unid'], funcao: ['funcao'], coef: ['coef'], lider: ['lider'], 'fonte?': ['fonte'], 'ref?': ['ref. sinapi', 'sinapi'], 'etapa?': ['etapa da eap', 'etapa'], 'obs?': ['observacao'] });
    if (!h) avisos.push('Aba Composicoes: cabeçalho não reconhecido.');
    else {
      const porCod = new Map();
      for (const r of rows.slice(h.linha + 1)) {
        const cod = txt(r[h.idx.cod]);
        if (!cod) continue;
        if (!porCod.has(cod)) {
          porCod.set(cod, {
            codigo: cod, descricao: txt(r[h.idx.desc]), unidade: txt(r[h.idx.un]), fonte: txt(col(r, h.idx.fonte)),
            refSinapi: txt(col(r, h.idx.ref)), etapaEap: txt(col(r, h.idx.etapa)), obs: txt(col(r, h.idx.obs)), maoObra: [],
          });
        }
        porCod.get(cod).maoObra.push({ funcao: txt(r[h.idx.funcao]), coef: numero(r[h.idx.coef]) || 0, lider: /^s/i.test(txt(r[h.idx.lider])) });
      }
      res.composicoes = [...porCod.values()];
      for (const c of res.composicoes) {
        const n = c.maoObra.filter((f) => f.lider).length;
        if (n !== 1) avisos.push(`Composição ${c.codigo}: ${n === 0 ? 'sem função líder' : 'mais de uma função líder'}.`);
      }
    }
  } else avisos.push('Aba Composicoes não encontrada.');

  // EAP Detalhada
  const wsE = aba(wb, 'EAP Detalhada');
  if (wsE) {
    const rows = linhas(wsE);
    const h = cabecalho(rows, { item: ['item'], etapa: ['etapa'], sub: ['subetapa'], ativ: ['atividade detalhada', 'atividade'], pred: ['predecessora'], 'tipo?': ['tipo'] });
    if (!h) avisos.push('Aba EAP Detalhada: cabeçalho não reconhecido.');
    else {
      for (const r of rows.slice(h.linha + 1)) {
        const codigo = txt(r[h.idx.item]).toUpperCase();
        if (!CODIGO.test(codigo)) continue;
        res.atividades.push({
          codigo, nivel: codigo.split('.').length,
          etapa: txt(r[h.idx.etapa]), subetapa: txt(r[h.idx.sub]), descricao: txt(r[h.idx.ativ]),
          pred: txt(r[h.idx.pred]), tipo: txt(col(r, h.idx.tipo)),
        });
      }
    }
  } else avisos.push('Aba EAP Detalhada não encontrada.');

  // Orçamento
  const wsO = aba(wb, 'Orcamento', 'Orçamento');
  if (wsO) {
    const rows = linhas(wsO);
    const h = cabecalho(rows, { item: ['item orc'], etapa: ['etapa'], sub: ['subetapa'], comp: ['cod. composicao', 'composicao'], qtd: ['quantidade'], 'cu?': ['custo unit'], 'total?': ['total'] });
    if (!h) avisos.push('Aba Orcamento: cabeçalho não reconhecido.');
    else {
      for (const r of rows.slice(h.linha + 1)) {
        const codigo = txt(r[h.idx.item]);
        if (!codigo) continue;
        const qtd = numero(r[h.idx.qtd]) || 0;
        let cu = numero(col(r, h.idx.cu));
        const total = numero(col(r, h.idx.total));
        if (cu == null && total != null && qtd) cu = total / qtd;
        res.orcamento.push({ codigo, etapa: txt(r[h.idx.etapa]), subetapa: txt(r[h.idx.sub]), comp: txt(r[h.idx.comp]), quantidade: qtd, custoUnit: cu || 0 });
      }
    }
  }

  // Vínculos
  const wsV = aba(wb, 'Vinculo_Orc_EAP', 'Vinculo');
  if (wsV) {
    const rows = linhas(wsV);
    const h = cabecalho(rows, { item: ['item orc'], ativ: ['id atividade'], pct: ['%'] });
    if (h) {
      for (const r of rows.slice(h.linha + 1)) {
        const item = txt(r[h.idx.item]), ativ = txt(r[h.idx.ativ]).toUpperCase();
        if (!item || !ativ) continue;
        let pct = numero(r[h.idx.pct]);
        if (pct == null) continue;
        if (pct > 1.0001) pct /= 100;
        res.vinculos.push({ item, atividade: ativ, pct });
      }
    }
  }

  // Duração das atividades (equipe e duração manual) + premissas
  const wsD = aba(wb, 'Duracao_Atividades', 'Duração');
  if (wsD) {
    const rows = linhas(wsD);
    for (const r of rows.slice(0, 10)) {
      const k = norm(txt(r[0]));
      if (k.startsWith('jornada')) res.premissas.jornada = numero(r[1]);
      if (k.startsWith('eficiencia')) res.premissas.eficiencia = numero(r[1]);
    }
    const h = cabecalho(rows, { id: ['id atividade'], equipe: ['equipe'], manual: ['duracao manual'] });
    if (h) {
      for (const r of rows.slice(h.linha + 1)) {
        const id = txt(r[h.idx.id]).toUpperCase();
        if (!CODIGO.test(id)) continue;
        res.duracoes.set(id, { equipe: numero(r[h.idx.equipe]), manual: numero(r[h.idx.manual]) });
      }
    }
  }
  return res;
}

/* ---------- composições ---------- */

const assinatura = (mo) => mo.map((f) => `${f.funcao.toLowerCase()}|${Number(f.coef)}|${f.lider ? 1 : 0}`).sort().join(';');

/**
 * Junta as composições lidas na biblioteca: mesmos coeficientes → reaproveita (atualizando fonte, ref. SINAPI, etapa e
 * observação); código existente com coeficientes diferentes → nova versão (a anterior fica inativa).
 */
export function aplicarComposicoes(dados, lib) {
  const porCodigo = new Map();
  const rel = { novas: 0, versoes: 0, iguais: 0, conflitos: [] };
  for (const c of dados.composicoes) {
    const existentes = lib.composicoes.filter((x) => x.codigo === c.codigo);
    const ativa = existentes.find((x) => x.ativa) || existentes[existentes.length - 1];
    const mo = c.maoObra.map((f) => ({ id: uid(), funcao: f.funcao, coef: f.coef, lider: f.lider }));
    const meta = { fonte: normalizaFonte(c.fonte), refSinapi: c.refSinapi || '', etapaEap: c.etapaEap || '', obs: c.obs || '' };
    if (ativa && assinatura(ativa.maoObra) === assinatura(mo)) {
      Object.assign(ativa, { descricao: c.descricao || ativa.descricao, unidade: c.unidade || ativa.unidade }, meta);
      porCodigo.set(c.codigo, ativa.id); rel.iguais++; continue;
    }
    if (ativa && norm(ativa.descricao) !== norm(c.descricao)) rel.conflitos.push(`${c.codigo}: "${ativa.descricao}" (biblioteca) × "${c.descricao}" (planilha)`);
    const nova = novaComposicao({
      codigo: c.codigo, descricao: c.descricao, unidade: c.unidade, maoObra: mo, ...meta,
      versao: existentes.length ? Math.max(...existentes.map((x) => x.versao || 1)) + 1 : 1,
    });
    existentes.forEach((x) => { x.ativa = false; });
    lib.composicoes.push(nova);
    porCodigo.set(c.codigo, nova.id);
    if (existentes.length) rel.versoes++; else rel.novas++;
  }
  return { porCodigo, rel };
}

/* ---------- modelos de EAP ---------- */


/* ---------- modelos de EAP (formato 3) ----------
   Um modelo é uma EAP "de catálogo", editável na aba Fases, com a mesma estrutura de uma obra:
   { id, kind:'modelo', nome, versao:3, premissas, eap:[atividades com id/parentId], dependencias, orcamento, vinculos }
   - itens de orçamento guardam o CÓDIGO da composição (comp), não o id da biblioteca;
   - etapas alternativas (variantes) têm `varianteDe` = id da etapa base (só uma entra em cada obra).
   As obras guardam o vínculo com o modelo em `modeloId` + `modeloAtivId`, então renomear/reordenar fases no modelo
   não quebra as obras já criadas. */

const etapaDe = (codigo) => String(codigo).split('.')[0];
const baseDe = (etapa) => etapa.replace(/[A-Za-z]+$/, '');

/** Modelo antigo (lista de linhas com códigos e predecessoras em texto) → modelo formato 3. */
export function converterModelo(m2) {
  if ((m2.versao || 1) >= 3) return m2;
  const M = { id: m2.id || uid(), kind: 'modelo', nome: m2.nome, criadoEm: m2.criadoEm || new Date().toISOString().slice(0, 10), versao: 3,
    premissas: { ...(m2.premissas || {}) }, eap: [], dependencias: [], orcamento: [], vinculos: [], avisos: [] };
  const porCodigo = new Map();
  const linha = new Map((m2.atividades || []).map((a) => [a.codigo, a]));
  const garantir = (codigo, base) => {
    if (porCodigo.has(codigo)) return porCodigo.get(codigo);
    const partes = codigo.split('.');
    const pai = partes.length > 1 ? garantir(partes.slice(0, -1).join('.'), base) : null;
    const nivel = partes.length;
    const row = linha.get(codigo) || {};
    const desc = row.descricao || (nivel === 1 ? base.etapa : nivel === 2 ? base.subetapa : '') || codigo;
    const a = novaAtividade({ parentId: pai?.id || null, nivel, codigo, codigoOrig: codigo, descricao: desc, etapa: base.etapa || '', subetapa: nivel >= 2 ? base.subetapa || '' : '' });
    if (row.tipo) a.tipo = normalizaTipo(row.tipo);
    if (row.equipe != null) a.equipe = row.equipe;
    if (row.duracaoManual != null) a.duracaoManual = row.duracaoManual;
    a._pred = row.pred || '';
    porCodigo.set(codigo, a);
    M.eap.push(a);
    return a;
  };
  for (const r of m2.atividades || []) garantir(r.codigo, r);
  // variantes: etapa com letra aponta para a etapa base
  for (const a of M.eap) if (!a.parentId && a.codigo !== baseDe(a.codigo) && porCodigo.has(baseDe(a.codigo))) a.varianteDe = porCodigo.get(baseDe(a.codigo)).id;
  const temFilhos = new Set(M.eap.filter((a) => a.parentId).map((a) => a.parentId));
  for (const a of M.eap) {
    const pred = a._pred; delete a._pred;
    if (!pred) continue;
    if (temFilhos.has(a.id)) { if (/\d/.test(pred)) a.obs = `Predecessora original (resumo): ${pred.replace(/\(orig\.?\)/i, '').trim()}`; continue; }
    let p;
    try { p = parseNotacao(pred); } catch (e) { M.avisos.push(`${a.codigo}: ${e.message}`); continue; }
    if (p.textoLivre) { a.predTexto = pred.trim(); a.obs = p.obs; M.avisos.push(`${a.codigo}: predecessora "${pred.trim()}" não é uma atividade — defina o início fixado na obra.`); continue; }
    for (const d of p.deps) {
      const pr = porCodigo.get(d.codigo);
      if (!pr) { M.avisos.push(`${a.codigo}: predecessora ${d.codigo} não existe.`); continue; }
      M.dependencias.push({ id: uid(), atividadeId: a.id, predecessoraId: pr.id, tipo: d.tipo, lag: d.lag });
    }
  }
  const itemPorCodigo = new Map();
  for (const o of m2.orcamento || []) {
    const it = { id: uid(), codigo: o.codigo, etapa: o.etapa || '', subetapa: o.subetapa || '', comp: o.comp || '', quantidade: Number(o.quantidade) || 0, custoUnit: Number(o.custoUnit) || 0 };
    M.orcamento.push(it); itemPorCodigo.set(o.codigo, it.id);
  }
  for (const v of m2.vinculos || []) {
    const itemId = itemPorCodigo.get(v.item), atividadeId = porCodigo.get(v.atividade)?.id;
    if (itemId && atividadeId) M.vinculos.push({ id: uid(), itemId, atividadeId, pct: v.pct });
  }
  renumerar(M);
  return M;
}

/** Modelo a partir da planilha interpretada: EAP + durações + itens de orçamento e vínculos. */
export function modeloDaPlanilha(dados, nome) {
  return converterModelo({
    id: uid(), nome, versao: 2, premissas: { ...dados.premissas },
    atividades: dados.atividades.map((r) => { const d = dados.duracoes.get(r.codigo); return { ...r, equipe: d?.equipe ?? null, duracaoManual: d?.manual ?? null }; }),
    orcamento: dados.orcamento, vinculos: dados.vinculos,
  });
}

/** Modelo vazio, para montar as fases do zero na aba Fases. */
export function modeloVazio(nome) {
  return { id: uid(), kind: 'modelo', nome, criadoEm: new Date().toISOString().slice(0, 10), versao: 3, premissas: { jornada: 8, eficiencia: 0.85 }, eap: [], dependencias: [], orcamento: [], vinculos: [] };
}

/** Cópia de modelo (ou da EAP de uma obra) com novos ids. */
function copiarEstrutura(src, { obra = false } = {}) {
  const map = new Map();
  const eap = src.eap.map((a) => {
    const n = novaAtividade({
      parentId: a.parentId, nivel: a.nivel, codigo: a.codigo, descricao: a.descricao, etapa: a.etapa, subetapa: a.subetapa,
      tipo: a.tipo, equipe: a.equipe ?? null, duracaoManual: a.duracaoManual ?? null, predTexto: a.predTexto || '', obs: a.obs || '',
      varianteDe: a.varianteDe || null, codigoOrig: obra ? a.codigo : a.codigoOrig || a.codigo,
    });
    map.set(a.id, n.id);
    return n;
  });
  eap.forEach((n) => { n.parentId = n.parentId ? map.get(n.parentId) || null : null; if (n.varianteDe) n.varianteDe = map.get(n.varianteDe) || null; });
  const dependencias = src.dependencias.filter((d) => map.has(d.atividadeId) && map.has(d.predecessoraId))
    .map((d) => ({ id: uid(), atividadeId: map.get(d.atividadeId), predecessoraId: map.get(d.predecessoraId), tipo: d.tipo, lag: d.lag }));
  return { eap, dependencias, map };
}

export function duplicarModelo(M, nome) {
  const { eap, dependencias, map } = copiarEstrutura(M);
  const itens = new Map();
  const orcamento = (M.orcamento || []).map((o) => { const n = { ...o, id: uid() }; itens.set(o.id, n.id); return n; });
  const vinculos = (M.vinculos || []).filter((v) => itens.has(v.itemId) && map.has(v.atividadeId)).map((v) => ({ id: uid(), itemId: itens.get(v.itemId), atividadeId: map.get(v.atividadeId), pct: v.pct }));
  return { ...modeloVazio(nome), premissas: { ...(M.premissas || {}) }, eap, dependencias, orcamento, vinculos };
}

/** Modelo a partir de uma obra (estrutura, tipos, predecessoras, equipes e itens de orçamento). */
export function modeloDaObra(nome, obra, lib) {
  const comps = new Map(lib.composicoes.map((c) => [c.id, c]));
  const { eap, dependencias, map } = copiarEstrutura(obra, { obra: true });
  const itens = new Map();
  const orcamento = obra.orcamento.map((it) => { const id = uid(); itens.set(it.id, id); return { id, codigo: it.codigo, etapa: it.etapa, subetapa: it.subetapa, comp: comps.get(it.composicaoId)?.codigo || '', quantidade: it.quantidade, custoUnit: it.custoUnit }; });
  const vinculos = obra.vinculos.filter((v) => itens.has(v.itemId) && map.has(v.atividadeId)).map((v) => ({ id: uid(), itemId: itens.get(v.itemId), atividadeId: map.get(v.atividadeId), pct: v.pct }));
  return { ...modeloVazio(nome), premissas: { jornada: obra.jornada, eficiencia: obra.eficiencia }, eap, dependencias, orcamento, vinculos };
}

/** Etapas do modelo (nível 1), com subetapas e variantes. */
export function etapasDoModelo(M) {
  const filhos = filhosDe(M);
  const folhas = (id) => { const f = filhos.get(id) || []; return f.length ? f.reduce((s, x) => s + folhas(x.id), 0) : 1; };
  const raizes = filhos.get(null) || [];
  const lista = raizes.map((a, i) => ({
    id: a.id, codigo: a.codigo, nome: a.descricao, variante: !!a.varianteDe, base: a.varianteDe || a.id, ordem: i,
    subetapas: (filhos.get(a.id) || []).map((s) => ({ id: s.id, codigo: s.codigo, nome: s.descricao })),
    nAtiv: (filhos.get(a.id) || []).length ? folhas(a.id) : 0,
  }));
  for (const E of lista) E.grupo = lista.filter((x) => x.base === E.base).map((x) => x.id);
  return lista;
}

/** Seleção padrão: todas as etapas e subetapas, escolhendo a etapa base quando há variante. */
export function selecaoPadrao(M) {
  const etapas = etapasDoModelo(M);
  return {
    etapas: new Set(etapas.filter((e) => !e.variante).map((e) => e.id)),
    subetapas: new Set(etapas.flatMap((e) => e.subetapas.map((s) => s.id))),
  };
}

/**
 * Adiciona à obra as fases escolhidas do modelo (pode ser chamado várias vezes, para ir acrescentando fases).
 * - Atividades entram na posição do modelo e guardam `modeloId`/`modeloAtivId`.
 * - Predecessoras são recalculadas para as atividades do modelo (exceto as editadas à mão): se a predecessora não
 *   está na obra, usa a variante escolhida (11.x → 11B.x) ou, na falta, as predecessoras dela (em cadeia).
 * - Itens de orçamento do modelo entram se tiverem vínculo com atividades presentes (quantidade zerada, se pedido).
 */
export function instanciarModelo(obra, M, sel, { orcamento = true, quantidades = false } = {}, lib) {
  const avisos = [];
  const filhosM = filhosDe(M);
  const porIdM = new Map(M.eap.map((a) => [a.id, a]));
  const idx = new Map(M.eap.map((a, i) => [a.id, i]));
  const ordemDe = (a) => (a.varianteDe && idx.has(a.varianteDe) ? idx.get(a.varianteDe) + 0.5 : idx.get(a.id));
  const raizDe = (a) => { let x = a; while (x.parentId) x = porIdM.get(x.parentId); return x; };
  const subDe = (a) => { let x = a; while (x.parentId && porIdM.get(x.parentId).parentId) x = porIdM.get(x.parentId); return x.parentId ? x : null; };
  const incluir = (a) => { if (!sel.etapas.has(raizDe(a).id)) return false; const s = subDe(a); return !s || sel.subetapas.has(s.id); };
  const mapaObra = () => {
    const m = new Map();
    for (const a of obra.eap) {
      if (a.modeloId !== M.id) continue;
      if (a.modeloAtivId && porIdM.has(a.modeloAtivId)) m.set(a.modeloAtivId, a);
      else if (a.codigoModelo) { const n = M.eap.find((x) => x.codigoOrig === a.codigoModelo); if (n) { a.modeloAtivId = n.id; m.set(n.id, a); } }
    }
    return m;
  };
  let existentes = mapaObra();
  let adicionadas = 0;

  const inserir = (a) => {
    const irmaos = obra.eap.filter((x) => (x.parentId || null) === (a.parentId || null));
    const depois = irmaos.find((x) => x.modeloId === M.id && x.modeloOrdem > a.modeloOrdem);
    if (depois) obra.eap.splice(obra.eap.indexOf(depois), 0, a); else obra.eap.push(a);
  };
  const garantir = (n) => {
    if (existentes.has(n.id)) return existentes.get(n.id);
    const pai = n.parentId ? garantir(porIdM.get(n.parentId)) : null;
    const raiz = raizDe(n), sub = subDe(n);
    const a = novaAtividade({
      parentId: pai?.id || null, descricao: n.descricao, etapa: raiz.descricao, subetapa: sub ? sub.descricao : (n.parentId ? n.descricao : ''),
      tipo: n.tipo || 'Execução', equipe: n.equipe ?? null, duracaoManual: n.duracaoManual ?? null, obs: n.obs || '',
      modeloId: M.id, modeloAtivId: n.id, modeloOrdem: ordemDe(n),
    });
    inserir(a);
    existentes.set(n.id, a);
    adicionadas++;
    return a;
  };
  for (const n of M.eap) if (incluir(n)) garantir(n);

  // Predecessoras
  existentes = mapaObra();
  const presentesRaiz = new Set([...existentes.keys()].filter((id) => !porIdM.get(id).parentId));
  const grupoDe = (raiz) => M.eap.filter((x) => !x.parentId && (x.id === raiz.id || x.varianteDe === raiz.id || (raiz.varianteDe && (x.id === raiz.varianteDe || x.varianteDe === raiz.varianteDe))));
  const caminho = (n) => { const p = []; let x = n; while (x.parentId) { const irm = filhosM.get(x.parentId) || []; p.unshift(irm.indexOf(x)); x = porIdM.get(x.parentId); } return p; };
  const seguir = (raiz, path) => { let x = raiz; for (const i of path) { x = (filhosM.get(x.id) || [])[i]; if (!x) return null; } return x; };
  const depsM = new Map();
  for (const d of M.dependencias) { if (!depsM.has(d.atividadeId)) depsM.set(d.atividadeId, []); depsM.get(d.atividadeId).push(d); }
  const resolver = (predId, tipo, lag, visto = new Set()) => {
    if (existentes.has(predId)) return [{ id: existentes.get(predId).id, tipo, lag }];
    const pn = porIdM.get(predId);
    if (!pn) return [];
    const raiz = raizDe(pn);
    for (const alt of grupoDe(raiz)) {
      if (alt.id === raiz.id || !presentesRaiz.has(alt.id)) continue;
      const eq = seguir(alt, caminho(pn));
      if (eq && existentes.has(eq.id)) return [{ id: existentes.get(eq.id).id, tipo, lag }];
    }
    if (visto.has(predId)) return [];
    visto.add(predId);
    return (depsM.get(predId) || []).flatMap((d) => resolver(d.predecessoraId, d.tipo, d.lag, visto));
  };
  const temFilhosObra = new Set(obra.eap.filter((a) => a.parentId).map((a) => a.parentId));
  const idsModelo = new Set([...existentes.values()].map((a) => a.id));
  const manuais = new Set(obra.eap.filter((a) => a.predManual).map((a) => a.id));
  obra.dependencias = obra.dependencias.filter((d) => !(idsModelo.has(d.atividadeId) && !manuais.has(d.atividadeId)));
  for (const [mid, a] of existentes) {
    if (manuais.has(a.id) || temFilhosObra.has(a.id)) continue;
    const n = porIdM.get(mid);
    a.predTexto = n.predTexto || '';
    if (n.predTexto) avisos.push(`${n.codigo}: predecessora "${n.predTexto}" não é uma atividade — defina o início fixado.`);
    const vistos = new Set();
    for (const d of depsM.get(mid) || []) {
      for (const r of resolver(d.predecessoraId, d.tipo, d.lag)) {
        const k = `${r.id}|${r.tipo}|${r.lag}`;
        if (r.id === a.id || vistos.has(k)) continue;
        vistos.add(k);
        obra.dependencias.push({ id: uid(), atividadeId: a.id, predecessoraId: r.id, tipo: r.tipo, lag: r.lag });
      }
    }
  }

  // Orçamento
  let itensNovos = 0;
  if (orcamento && M.orcamento?.length) {
    const ativas = new Map();
    for (const c of lib.composicoes) if (!ativas.has(c.codigo) || c.ativa) ativas.set(c.codigo, c.id);
    for (const o of M.orcamento) {
      const vs = (M.vinculos || []).filter((v) => v.itemId === o.id && existentes.has(v.atividadeId) && !temFilhosObra.has(existentes.get(v.atividadeId).id));
      if (!vs.length) continue;
      let it = obra.orcamento.find((x) => x.modeloId === M.id && (x.modeloItemId === o.id || (!x.modeloItemId && x.codigoModelo === o.codigo)));
      if (!it) {
        const compId = ativas.get(o.comp) || '';
        if (!compId && o.comp) avisos.push(`Item ${o.codigo}: composição ${o.comp} não está na biblioteca.`);
        it = novoItem({ codigo: o.codigo, etapa: o.etapa, subetapa: o.subetapa, composicaoId: compId, quantidade: quantidades ? o.quantidade : 0, custoUnit: o.custoUnit, modeloId: M.id, modeloItemId: o.id });
        obra.orcamento.push(it);
        itensNovos++;
      }
      for (const v of vs) {
        const atividadeId = existentes.get(v.atividadeId).id;
        if (!obra.vinculos.some((x) => x.itemId === it.id && x.atividadeId === atividadeId)) obra.vinculos.push({ id: uid(), itemId: it.id, atividadeId, pct: v.pct });
      }
    }
  }
  renumerar(obra);
  return { adicionadas, itens: itensNovos, avisos };
}

/** Cria a obra completa a partir dos dados interpretados (todas as fases, variante base). Altera `lib`. */
export function criarObraImportada(dados, { nome, inicio }, lib, sel = null) {
  const { rel } = aplicarComposicoes(dados, lib);
  const modelo = modeloDaPlanilha(dados, `EAP ${nome}`);
  const obra = novaObra({ nome, inicio });
  if (dados.premissas.jornada > 0) obra.jornada = dados.premissas.jornada;
  if (dados.premissas.eficiencia > 0) obra.eficiencia = dados.premissas.eficiencia;
  const r = instanciarModelo(obra, modelo, sel || selecaoPadrao(modelo), { orcamento: true, quantidades: true }, lib);
  return { obra, avisos: [...dados.avisos, ...(modelo.avisos || []), ...r.avisos], rel, modelo };
}
