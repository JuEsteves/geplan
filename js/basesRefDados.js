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
