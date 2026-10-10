// Importador da planilha modelo (abas EAP Detalhada, Composicoes, Orcamento, Vinculo_Orc_EAP e Duracao_Atividades).
// lerArquivo() → interpretar() (puro, testável) → aplicar…() para gravar na biblioteca/obra.

import { LIBS, loadScript } from './libs.js';
import { uid, novaObra, novaAtividade, novoItem, novaComposicao, normalizaTipo, renumerar } from './model.js';
import { parseNotacao } from './predecessoras.js';

export async function lerArquivo(file) {
  await loadScript(LIBS.xlsx);
  const buf = await file.arrayBuffer();
  return window.XLSX.read(buf, { type: 'array' });
}

/* ---------- leitura das abas ---------- */

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

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

/** Acha a linha de cabeçalho e o índice das colunas pedidas (por trechos do texto do cabeçalho). */
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
    const h = cabecalho(rows, { cod: ['cod. composicao', 'codigo'], desc: ['descricao'], un: ['unid'], funcao: ['funcao'], coef: ['coef'], lider: ['lider'], 'fonte?': ['fonte'] });
    if (!h) avisos.push('Aba Composicoes: cabeçalho não reconhecido.');
    else {
      const porCod = new Map();
      for (const r of rows.slice(h.linha + 1)) {
        const cod = txt(r[h.idx.cod]);
        if (!cod) continue;
        if (!porCod.has(cod)) porCod.set(cod, { codigo: cod, descricao: txt(r[h.idx.desc]), unidade: txt(r[h.idx.un]), fonte: h.idx.fonte >= 0 ? txt(r[h.idx.fonte]) : '', maoObra: [] });
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
        const codigo = txt(r[h.idx.item]);
        if (!/^\d+(\.\d+)*$/.test(codigo)) continue;
        res.atividades.push({
          codigo, nivel: codigo.split('.').length + (codigo.includes('.') ? 0 : 0),
          etapa: txt(r[h.idx.etapa]), subetapa: txt(r[h.idx.sub]), descricao: txt(r[h.idx.ativ]),
          pred: txt(r[h.idx.pred]), tipo: h.idx.tipo >= 0 ? txt(r[h.idx.tipo]) : '',
        });
      }
    }
  } else avisos.push('Aba EAP Detalhada não encontrada.');

  // Orçamento
  const wsO = aba(wb, 'Orcamento', 'Orçamento');
  if (wsO) {
    const rows = linhas(wsO);
    const h = cabecalho(rows, { item: ['item orc'], etapa: ['etapa'], sub: ['subetapa'], comp: ['cod. composicao', 'composicao'], 'desc?': ['descricao'], qtd: ['quantidade'], 'cu?': ['custo unit'], 'total?': ['total'] });
    if (!h) avisos.push('Aba Orcamento: cabeçalho não reconhecido.');
    else {
      for (const r of rows.slice(h.linha + 1)) {
        const codigo = txt(r[h.idx.item]);
        if (!codigo) continue;
        const qtd = numero(r[h.idx.qtd]) || 0;
        let cu = h.idx.cu >= 0 ? numero(r[h.idx.cu]) : null;
        const total = h.idx.total >= 0 ? numero(r[h.idx.total]) : null;
        if (cu == null && total != null && qtd) cu = total / qtd;
        res.orcamento.push({ codigo, etapa: txt(r[h.idx.etapa]), subetapa: txt(r[h.idx.sub]), comp: txt(r[h.idx.comp]), descricao: h.idx.desc >= 0 ? txt(r[h.idx.desc]) : '', quantidade: qtd, custoUnit: cu || 0 });
      }
    }
  } else avisos.push('Aba Orcamento não encontrada.');

  // Vínculos
  const wsV = aba(wb, 'Vinculo_Orc_EAP', 'Vinculo');
  if (wsV) {
    const rows = linhas(wsV);
    const h = cabecalho(rows, { item: ['item orc'], ativ: ['id atividade'], pct: ['%'] });
    if (!h) avisos.push('Aba Vinculo_Orc_EAP: cabeçalho não reconhecido.');
    else {
      for (const r of rows.slice(h.linha + 1)) {
        const item = txt(r[h.idx.item]), ativ = txt(r[h.idx.ativ]);
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
        const id = txt(r[h.idx.id]);
        if (!/^\d+(\.\d+)*$/.test(id)) continue;
        res.duracoes.set(id, { equipe: numero(r[h.idx.equipe]), manual: numero(r[h.idx.manual]) });
      }
    }
  }
  return res;
}

/* ---------- gravação ---------- */

const assinatura = (mo) => mo.map((f) => `${f.funcao.toLowerCase()}|${Number(f.coef)}|${f.lider ? 1 : 0}`).sort().join(';');

/**
 * Junta as composições lidas na biblioteca: mesma composição → reaproveita; código existente com coeficientes
 * diferentes → nova versão (a anterior fica inativa). Retorna mapa código → id e um relatório.
 */
export function aplicarComposicoes(dados, lib) {
  const porCodigo = new Map();
  const rel = { novas: 0, versoes: 0, iguais: 0 };
  for (const c of dados.composicoes) {
    const existentes = lib.composicoes.filter((x) => x.codigo === c.codigo);
    const ativa = existentes.find((x) => x.ativa) || existentes[existentes.length - 1];
    const mo = c.maoObra.map((f) => ({ id: uid(), funcao: f.funcao, coef: f.coef, lider: f.lider }));
    if (ativa && assinatura(ativa.maoObra) === assinatura(mo)) { porCodigo.set(c.codigo, ativa.id); rel.iguais++; continue; }
    if (ativa && norm(ativa.descricao) !== norm(c.descricao)) rel.conflitos = (rel.conflitos || []).concat(`${c.codigo}: "${ativa.descricao}" (biblioteca) × "${c.descricao}" (planilha)`);
    const f = norm(c.fonte);
    const fonte = !f ? 'Obra própria' : f.startsWith('sinapi') ? 'SINAPI' : f.startsWith('tcpo') ? 'TCPO' : f.startsWith('obra') || f.startsWith('rdo') ? 'Obra própria' : 'Outra';
    const nova = novaComposicao({
      codigo: c.codigo, descricao: c.descricao, unidade: c.unidade, fonte, maoObra: mo,
      versao: existentes.length ? Math.max(...existentes.map((x) => x.versao || 1)) + 1 : 1,
      obs: fonte === 'Outra' ? c.fonte : '',
    });
    existentes.forEach((x) => { x.ativa = false; });
    lib.composicoes.push(nova);
    porCodigo.set(c.codigo, nova.id);
    if (existentes.length) rel.versoes++; else rel.novas++;
  }
  // composições já existentes na biblioteca que a planilha só referencia
  for (const c of lib.composicoes) if (c.ativa && !porCodigo.has(c.codigo)) porCodigo.set(c.codigo, c.id);
  return { porCodigo, rel };
}

/** Monta as atividades (níveis 1, 2 e 3) e as dependências a partir das linhas da EAP. */
export function montarEAP(obra, atividades, duracoes = new Map()) {
  const porCodigo = new Map();
  const avisos = [];
  const garantir = (codigo, base) => {
    if (porCodigo.has(codigo)) return porCodigo.get(codigo);
    const partes = codigo.split('.');
    const pai = partes.length > 1 ? garantir(partes.slice(0, -1).join('.'), base) : null;
    const nivel = partes.length;
    const desc = nivel === 1 ? base.etapa : nivel === 2 ? base.subetapa : base.descricao;
    const a = novaAtividade({ codigo, nivel, parentId: pai?.id || null, etapa: base.etapa, subetapa: nivel >= 2 ? base.subetapa : '', descricao: desc || codigo });
    porCodigo.set(codigo, a);
    obra.eap.push(a);
    return a;
  };
  for (const r of atividades) {
    const a = garantir(r.codigo, r);
    if (r.nivel >= 3 || r.descricao) a.descricao = r.descricao || a.descricao;
    if (r.tipo) a.tipo = normalizaTipo(r.tipo);
    a._pred = r.pred;
  }
  const temFilhos = new Set(obra.eap.filter((a) => a.parentId).map((a) => a.parentId));
  for (const a of obra.eap) {
    const pred = a._pred; delete a._pred;
    const d = duracoes.get(a.codigo);
    if (d) { if (d.equipe != null) a.equipe = d.equipe; if (d.manual != null) a.duracaoManual = d.manual; }
    if (temFilhos.has(a.id)) { if (pred && /\d/.test(pred)) a.obs = `Predecessora original (resumo): ${pred.replace(/\(orig\.?\)/i, '').trim()}`; continue; }
    if (!pred) continue;
    let p;
    try { p = parseNotacao(pred); } catch (e) { avisos.push(`${a.codigo}: ${e.message}`); continue; }
    if (p.textoLivre) { a.predTexto = pred.trim(); a.obs = p.obs; avisos.push(`${a.codigo}: predecessora "${pred.trim()}" não é uma atividade — defina o início fixado.`); continue; }
    for (const dep of p.deps) {
      const pr = porCodigo.get(dep.codigo);
      if (!pr) { avisos.push(`${a.codigo}: predecessora ${dep.codigo} não existe.`); continue; }
      obra.dependencias.push({ id: uid(), atividadeId: a.id, predecessoraId: pr.id, tipo: dep.tipo, lag: dep.lag });
    }
  }
  return { porCodigo, avisos };
}

/** Cria a obra completa a partir dos dados interpretados. Altera `lib` (composições). */
export function criarObraImportada(dados, { nome, inicio }, lib) {
  const obra = novaObra({ nome, inicio });
  if (dados.premissas.jornada > 0) obra.jornada = dados.premissas.jornada;
  if (dados.premissas.eficiencia > 0) obra.eficiencia = dados.premissas.eficiencia;
  const avisos = [...dados.avisos];
  const { porCodigo: compPorCodigo, rel } = aplicarComposicoes(dados, lib);
  const { porCodigo: ativPorCodigo, avisos: av } = montarEAP(obra, dados.atividades, dados.duracoes);
  avisos.push(...av);

  const itemPorCodigo = new Map();
  for (const o of dados.orcamento) {
    const compId = compPorCodigo.get(o.comp) || '';
    if (!compId) avisos.push(`Item ${o.codigo}: composição ${o.comp} não encontrada.`);
    const it = novoItem({ codigo: o.codigo, etapa: o.etapa, subetapa: o.subetapa, composicaoId: compId, descricao: '', quantidade: o.quantidade, custoUnit: o.custoUnit });
    obra.orcamento.push(it);
    itemPorCodigo.set(o.codigo, it.id);
  }
  for (const v of dados.vinculos) {
    const itemId = itemPorCodigo.get(v.item), atividadeId = ativPorCodigo.get(v.atividade)?.id;
    if (!itemId) { avisos.push(`Vínculo: item ${v.item} não existe no orçamento.`); continue; }
    if (!atividadeId) { avisos.push(`Vínculo: atividade ${v.atividade} não existe na EAP.`); continue; }
    obra.vinculos.push({ id: uid(), itemId, atividadeId, pct: v.pct });
  }
  renumerar(obra);
  return { obra, avisos, rel };
}

/** Modelo de EAP reutilizável (só estrutura, tipos e predecessoras). */
export function modeloDaEAP(nome, atividades) {
  return { id: uid(), nome, criadoEm: new Date().toISOString().slice(0, 10), atividades: atividades.map((a) => ({ ...a })) };
}
