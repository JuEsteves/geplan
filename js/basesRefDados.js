// Bases de referência (SINAPI e bases próprias): leitura da planilha e gravação no banco. Sem tela e sem navegador —
// o mesmo código roda no site (importação manual) e no robô mensal (tools/sinapi/robo.mjs, Node).
//
// Planilha da Caixa a partir de 2025 ("SINAPI_Referência_AAAA_MM.xlsx", dentro do ZIP "formato-xlsx"): uma pasta só
// com as 27 UF. Abas usadas: CSD/CCD (custo das composições sem/com desoneração, colunas "Custo (R$)" e "%AS" por UF),
// ISD/ICD (preço dos insumos por UF) e "Analítico" (itens e coeficientes de cada composição). As abas são achadas
// pelo título do relatório e pelos cabeçalhos, não pela posição — se a Caixa mudar a ordem das colunas, continua lendo.

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
export const REGIMES = { nao_desonerado: 'Não desonerado', desonerado: 'Desonerado' };

export const normBusca = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const txt = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Número da planilha: número de verdade, ou texto "1.089,43"; "-" e vazio = sem valor. */
export function numeroPlanilha(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = txt(v);
  if (!s || s === '-') return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

// Nas abas de custos a Caixa põe o código como hiperlink para o analítico — =HYPERLINK("#"&…; 104658) — e o valor
// guardado no arquivo vem 0. O código certo é o último argumento da fórmula.
const HIPERLINK = /HYPERLINK\(.*[,;]\s*"?([^",;()]+)"?\s*\)\s*$/i;
function resolverHiperlinks(ws) {
  for (const [ref, cel] of Object.entries(ws)) {
    if (ref[0] === '!' || !cel?.f) continue;
    const m = HIPERLINK.exec(cel.f);
    if (!m) continue;
    const v = m[1].trim();
    if (/^\d+$/.test(v)) Object.assign(cel, { t: 'n', v: Number(v), w: v }); else Object.assign(cel, { t: 's', v, w: v });
  }
}
// Custo/preço zerado aparece como hífen: a Caixa não publicou o valor (falta preço de algum item na UF).
const valorPublicado = (v) => { const n = numeroPlanilha(v); return n == null || n === 0 ? null : n; };

/** Mês de referência "09/2026" → "2026-09-01". */
function mesDe(linhas) {
  for (const r of linhas.slice(0, 12)) {
    for (let i = 0; i < r.length; i++) {
      if (!/m[eê]s de refer/i.test(txt(r[i]))) continue;
      const m = r.slice(i + 1).map(txt).join(' ').match(/(\d{2})\/(\d{4})/);
      if (m) return `${m[2]}-${m[1]}-01`;
    }
  }
  return '';
}
const titulo = (linhas) => normBusca(linhas.slice(0, 4).flat().map(txt).join(' '));
const regimeDoTitulo = (t) => (/sem encargos/.test(t) ? '' : /sem desonera/.test(t) ? 'nao_desonerado' : /com desonera/.test(t) ? 'desonerado' : '');
const acharLinha = (linhas, teste, max = 40) => linhas.slice(0, max).findIndex((r) => teste(r.map((c) => normBusca(c))));
const col = (h, ...pads) => { for (const p of pads) { const j = h.findIndex((x) => x.startsWith(p)); if (j >= 0) return j; } return -1; };

/** Colunas de UF: a própria linha de cabeçalho (insumos) ou uma das linhas logo acima (composições). */
function colunasUF(linhas, iCab, colunas) {
  for (let i = iCab; i >= Math.max(0, iCab - 6); i--) {
    const r = linhas[i];
    const m = new Map();
    for (const j of colunas) { const v = txt(r[j]).toUpperCase(); if (UFS.includes(v)) m.set(j, v); }
    if (m.size >= Math.min(5, colunas.length)) return m;
  }
  return new Map();
}

function lerComposicoes(linhas, regime, comps) {
  const iCab = acharLinha(linhas, (h) => h.some((x) => x.startsWith('codigo da composicao')) && h.some((x) => x.startsWith('custo')));
  if (iCab < 0) return 0;
  const h = linhas[iCab].map(normBusca);
  const cCod = col(h, 'codigo da composicao'), cDesc = col(h, 'descricao'), cUn = col(h, 'unidade'), cGr = col(h, 'grupo');
  const custoCols = h.map((x, j) => (x.startsWith('custo') ? j : -1)).filter((j) => j >= 0);
  const uf = colunasUF(linhas, iCab, custoCols);
  let n = 0;
  for (const r of linhas.slice(iCab + 1)) {
    const codigo = txt(r[cCod]);
    if (!/^\d+$/.test(codigo)) continue;
    const c = comps.get(codigo) || { codigo, grupo: '', descricao: '', unidade: '', situacao: '', custos: {} };
    c.grupo ||= txt(r[cGr]); c.descricao ||= txt(r[cDesc]); c.unidade ||= txt(r[cUn]);
    const valores = {};
    for (const [j, u] of uf) { const v = valorPublicado(r[j]); if (v != null) valores[u] = v; }
    c.custos[regime] = valores;
    comps.set(codigo, c); n++;
  }
  return n;
}

function lerInsumos(linhas, regime, insumos) {
  const iCab = acharLinha(linhas, (h) => h.some((x) => x.startsWith('codigo do insumo')));
  if (iCab < 0) return 0;
  const h = linhas[iCab].map(normBusca);
  const cCod = col(h, 'codigo do insumo'), cDesc = col(h, 'descricao'), cUn = col(h, 'unidade'), cCl = col(h, 'classificacao'), cOr = col(h, 'origem');
  const uf = colunasUF(linhas, iCab, h.map((_, j) => j).filter((j) => j > Math.max(cCod, cDesc, cUn, cOr)));
  let n = 0;
  for (const r of linhas.slice(iCab + 1)) {
    const codigo = txt(r[cCod]);
    if (!/^\d+$/.test(codigo)) continue;
    const it = insumos.get(codigo) || { codigo, classificacao: txt(r[cCl]), descricao: txt(r[cDesc]), unidade: txt(r[cUn]), origem: txt(r[cOr]), precos: {} };
    const valores = {};
    for (const [j, u] of uf) { const v = valorPublicado(r[j]); if (v != null) valores[u] = v; }
    it.precos[regime] = valores;
    insumos.set(codigo, it); n++;
  }
  return n;
}

function lerAnalitico(linhas, comps, itens) {
  const iCab = acharLinha(linhas, (h) => h.some((x) => x.startsWith('codigo da composicao')) && h.some((x) => x.startsWith('coeficiente')));
  if (iCab < 0) return 0;
  const h = linhas[iCab].map(normBusca);
  const cComp = col(h, 'codigo da composicao'), cTipo = col(h, 'tipo item', 'tipo'), cItem = col(h, 'codigo do item'), cDesc = col(h, 'descricao'),
    cUn = col(h, 'unidade'), cCoef = col(h, 'coeficiente'), cSit = col(h, 'situacao'), cGr = col(h, 'grupo');
  const pos = new Map();
  let n = 0;
  for (const r of linhas.slice(iCab + 1)) {
    const comp = txt(r[cComp]);
    if (!/^\d+$/.test(comp)) continue;
    const tipo = normBusca(r[cTipo]);
    if (!tipo) {
      // linha da própria composição
      const c = comps.get(comp) || { codigo: comp, grupo: '', descricao: '', unidade: '', situacao: '', custos: {} };
      c.grupo ||= txt(r[cGr]); c.descricao ||= txt(r[cDesc]); c.unidade ||= txt(r[cUn]); c.situacao = txt(r[cSit]);
      comps.set(comp, c);
      continue;
    }
    const p = (pos.get(comp) || 0) + 1; pos.set(comp, p);
    itens.push({ composicao: comp, posicao: p, tipo: tipo.startsWith('comp') ? 'C' : 'I', codigo: txt(r[cItem]), descricao: txt(r[cDesc]),
      unidade: txt(r[cUn]), coeficiente: numeroPlanilha(r[cCoef]) ?? 0, situacao: txt(r[cSit]) });
    n++;
  }
  return n;
}

/**
 * Lê a pasta de trabalho de referência do SINAPI. `XLSX` = biblioteca SheetJS (no site: window.XLSX; no robô: import).
 * Retorna { mes, regimes, ufs, composicoes, itens, insumos, avisos }.
 */
export function interpretarReferenciaSinapi(wb, XLSX) {
  const comps = new Map(), insumos = new Map(), itens = [];
  const regimes = new Set();
  let mes = '';
  const contagem = {};
  for (const nome of wb.SheetNames) {
    resolverHiperlinks(wb.Sheets[nome]);
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '' });
    const t = titulo(linhas);
    mes ||= mesDe(linhas);
    if (/custos de composicoes/.test(t)) {
      const reg = regimeDoTitulo(t);
      if (reg) { contagem[nome] = lerComposicoes(linhas, reg, comps); regimes.add(reg); }
    } else if (/precos de insumos/.test(t)) {
      const reg = regimeDoTitulo(t);
      if (reg) contagem[nome] = lerInsumos(linhas, reg, insumos);
    } else if (/analitico de composicoes/.test(t) && !/com custo/.test(t)) {
      contagem[nome] = lerAnalitico(linhas, comps, itens);
    }
  }
  const composicoes = [...comps.values()].filter((c) => c.descricao)
    .map((c) => ({ ...c, busca: normBusca(`${c.codigo} ${c.descricao}`) }));
  const ufs = new Set();
  for (const c of composicoes) for (const r of Object.values(c.custos)) for (const u of Object.keys(r)) ufs.add(u);
  const avisos = [];
  if (!mes) avisos.push('Não achei o mês de referência na planilha.');
  if (!composicoes.length) avisos.push('Não achei composições (abas de custos de composições e analítico).');
  if (!itens.length) avisos.push('Não achei o analítico (itens e coeficientes das composições).');
  if (!regimes.size) avisos.push('Não achei os custos por UF (abas sem/com desoneração).');
  return { mes, regimes: [...regimes], ufs: UFS.filter((u) => ufs.has(u)), composicoes, itens, insumos: [...insumos.values()], contagem, avisos };
}

/* ---------- bases da empresa (TCPO, bases estaduais, planilha própria): qualquer planilha, colunas associadas ---------- */
export const CAMPOS_BASE = [
  ['codigo', 'Código da composição', true], ['descricao', 'Descrição da composição', true], ['unidade', 'Unidade'], ['custo', 'Custo unitário (R$)'],
  ['grupo', 'Grupo / capítulo'], ['itemCodigo', 'Código do item (insumo)'], ['itemDescricao', 'Descrição do item'], ['itemUnidade', 'Unidade do item'],
  ['coeficiente', 'Coeficiente / consumo do item'], ['tipo', 'Tipo do item (insumo/composição)'],
];
// ordem de sugestão: primeiro as colunas de item (mais específicas), depois as da composição
const PADROES = [
  ['itemCodigo', /cod.*(insumo|item)/], ['itemDescricao', /desc.*(insumo|item)/], ['itemUnidade', /(unid|^un).*(insumo|item)/],
  ['coeficiente', /coef|consumo|indice|^quant/], ['tipo', /^tipo/], ['codigo', /cod|^compos/], ['descricao', /^desc|descri|servico|^nome/],
  ['unidade', /^unid|^un\b|^un\.?$/], ['custo', /custo|preco|valor/], ['grupo', /grupo|classe|capitulo|familia|etapa/],
];

/** Linha de cabeçalho: a primeira (até a 30ª) com 3 ou mais textos, entre eles um de código ou descrição. */
export function acharCabecalhoBase(linhas) {
  return linhas.slice(0, 30).findIndex((r) => {
    const h = r.map((c) => normBusca(c)).filter((x) => x && !/^[\d.,]+$/.test(x));
    return h.length >= 3 && h.some((x) => /cod|descri/.test(x));
  });
}

/** Sugere a coluna de cada campo pelo nome do cabeçalho (cada coluna usada uma vez). Retorna { campo: índice | -1 }. */
export function sugerirColunas(cabecalho) {
  const h = cabecalho.map((c) => normBusca(c));
  const usadas = new Set();
  const mapa = Object.fromEntries(CAMPOS_BASE.map(([k]) => [k, -1]));
  for (const [k, re] of PADROES) {
    const j = h.findIndex((x, i) => x && !usadas.has(i) && re.test(x));
    if (j >= 0) { mapa[k] = j; usadas.add(j); }
  }
  return mapa;
}

/**
 * Lê uma base da empresa com as colunas associadas. Aceita: uma linha por composição (com custo) ou o analítico
 * (linhas de item com coeficiente, abaixo da linha da composição ou repetindo o código dela). O custo vale para a UF e o
 * regime informados. Retorna o mesmo formato do SINAPI ({ composicoes, itens, insumos, ufs, regimes, avisos }).
 */
export function interpretarBaseEmpresa(linhas, iCab, mapa, { uf, regime = 'nao_desonerado', mes = '' }) {
  const v = (r, k) => (mapa[k] >= 0 ? r[mapa[k]] : '');
  const comps = new Map(), itens = [], pos = new Map();
  const comItens = mapa.coeficiente >= 0 && (mapa.itemCodigo >= 0 || mapa.itemDescricao >= 0);
  let atual = null;
  for (const r of linhas.slice(iCab + 1)) {
    const temItem = comItens && !!txt(v(r, mapa.itemCodigo >= 0 ? 'itemCodigo' : 'itemDescricao')) && numeroPlanilha(v(r, 'coeficiente')) != null;
    const cod = txt(v(r, 'codigo')) || (temItem ? atual : '');
    if (!cod) continue;
    if (!comps.has(cod)) comps.set(cod, { codigo: cod, grupo: '', descricao: '', unidade: '', situacao: '', custos: {} });
    const c = comps.get(cod);
    atual = cod;
    // colunas da composição que não são as mesmas do item (layout com a composição repetida em cada linha)
    const propria = (k, ki) => !temItem || mapa[k] !== mapa[ki];
    if (propria('descricao', 'itemDescricao')) c.descricao ||= txt(v(r, 'descricao'));
    if (propria('unidade', 'itemUnidade')) c.unidade ||= txt(v(r, 'unidade'));
    c.grupo ||= txt(v(r, 'grupo'));
    const custo = valorPublicado(v(r, 'custo'));
    if (custo != null && !temItem) c.custos[regime] = { [uf]: custo };
    if (temItem) {
      const p = (pos.get(cod) || 0) + 1; pos.set(cod, p);
      itens.push({ composicao: cod, posicao: p, tipo: /comp/.test(normBusca(v(r, 'tipo'))) ? 'C' : 'I', codigo: txt(v(r, 'itemCodigo')),
        descricao: txt(v(r, 'itemDescricao')), unidade: txt(v(r, 'itemUnidade')), coeficiente: numeroPlanilha(v(r, 'coeficiente')) ?? 0, situacao: '' });
    }
  }
  const composicoes = [...comps.values()].filter((c) => c.descricao).map((c) => ({ ...c, busca: normBusca(`${c.codigo} ${c.descricao}`) }));
  const validos = new Set(composicoes.map((c) => c.codigo));
  const avisos = [];
  if (mapa.codigo < 0 || mapa.descricao < 0) avisos.push('Associe as colunas de código e de descrição da composição.');
  else if (!composicoes.length) avisos.push('Nenhuma composição com código e descrição foi encontrada abaixo do cabeçalho.');
  const temCusto = composicoes.some((c) => Object.keys(c.custos).length);
  return { mes, regimes: temCusto ? [regime] : [], ufs: temCusto ? [uf] : [], composicoes, itens: itens.filter((i) => validos.has(i.composicao)), insumos: [], avisos };
}

/** Custo de uma composição para a tela: base de uma UF só (da empresa) usa o próprio preço; o SINAPI, a UF/regime escolhidos. */
export const custoNaBase = (comp, base, uf, regime) => (base?.org_id && (base.ufs || []).length === 1
  ? custoEm(comp, base.ufs[0], (base.regimes || [])[0] || regime) : custoEm(comp, uf, regime));

/** Nome da versão: "SINAPI 09/2026" (+ " · retificação 01" quando o arquivo é uma retificação). */
export function nomeVersao(fonte, mes, arquivo = '') {
  const m = /^(\d{4})-(\d{2})/.exec(mes || '');
  const ret = /retifica\D*(\d+)/i.exec(arquivo || '');
  return `${fonte}${m ? ` ${m[2]}/${m[1]}` : ''}${ret ? ` · retificação ${ret[1].padStart(2, '0')}` : ''}`;
}

const LOTE = 1000;
/**
 * Grava a base no banco (cliente supabase-js já autenticado: administrador da plataforma no site, ou chave de serviço
 * no robô). Cria a versão "importando", insere em lotes e publica; se algo falhar, apaga a versão incompleta.
 */
export async function gravarBase(c, dados, { orgId = null, fonte = 'SINAPI', nome, arquivo = '' }, progresso = () => {}) {
  const ok = ({ data, error }, onde) => { if (error) throw new Error(`${onde}: ${error.message}`); return data; };
  const base = ok(await c.from('ref_bases').insert({ org_id: orgId, fonte, nome: nome || nomeVersao(fonte, dados.mes, arquivo), mes: dados.mes || null,
    arquivo, ufs: dados.ufs, regimes: dados.regimes }).select('id').single(), 'versão');
  try {
    const partes = [
      ['ref_composicoes', dados.composicoes.map(({ codigo, grupo, descricao, unidade, situacao, custos, busca }) => ({ base_id: base.id, codigo, grupo, descricao, unidade, situacao, custos, busca }))],
      ['ref_insumos', dados.insumos.map((i) => ({ base_id: base.id, ...i }))],
      ['ref_itens', dados.itens.map((i) => ({ base_id: base.id, ...i }))],
    ];
    const total = partes.reduce((a, [, l]) => a + l.length, 0);
    let feito = 0;
    for (const [tabela, linhas] of partes) {
      for (let i = 0; i < linhas.length; i += LOTE) {
        ok(await c.from(tabela).insert(linhas.slice(i, i + LOTE)), tabela);
        feito += Math.min(LOTE, linhas.length - i);
        progresso(feito, total);
      }
    }
    const totais = ok(await c.rpc('ref_publicar_base', { p_base: base.id }), 'publicar');
    return { id: base.id, totais };
  } catch (e) {
    await c.from('ref_bases').delete().eq('id', base.id);
    throw e;
  }
}

/* ---------- mão de obra e comparação (usados pela tela) ---------- */
const AJUDANTE = /servente|ajudante|auxiliar|apontador/i;
const nomeFuncao = (d) => {
  const s = d.replace(/\s+com\s+encargos\s+complementares/i, '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** Funções de mão de obra (itens em horas) e a líder sugerida (maior coeficiente que não seja ajudante/servente). */
export function maoDeObraItens(itens) {
  const mo = itens.filter((i) => /^h\b/i.test(String(i.unidade).trim())).map((i) => ({ funcao: nomeFuncao(i.descricao), coef: Number(i.coeficiente) || 0, ref: i.codigo }));
  if (!mo.length) return [];
  const cand = mo.filter((f) => !AJUDANTE.test(f.funcao));
  const lider = (cand.length ? cand : mo).reduce((a, b) => (b.coef > a.coef ? b : a));
  return mo.map((f) => ({ ...f, lider: f === lider }));
}

/** Custo da composição numa UF e regime (null quando a Caixa não publicou). */
export const custoEm = (comp, uf, regime) => {
  const v = comp?.custos?.[regime]?.[uf];
  return typeof v === 'number' ? v : null;
};

/** Variação percentual de b em relação a a (null sem os dois valores). */
export const variacao = (a, b) => (a > 0 && b != null ? Math.round(((b - a) / a) * 1000) / 10 : null);
