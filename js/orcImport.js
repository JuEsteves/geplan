// Importação de orçamento por Excel: arquivo → associação de colunas → pré-visualização com validação →
// confirmação (incluir novos / atualizar existentes pelo código) → relatório. Nada é gravado antes da confirmação,
// e uma revisão do orçamento é salva antes de aplicar (opcional, marcada por padrão).
import * as store from './store.js';
import { LIBS, loadScript } from './libs.js';
import { novoItem, registrar } from './model.js';
import { snapshotOrcamento } from './financeiro.js';
import { norm } from './importador.js';
import { esc, toast, info, commit, parseNum } from './ui.js';
import { fmtNum, fmtBRL } from './schedule.js';
import { usuario } from './gestao.js';

export const CAMPOS = [
  { k: 'codigo', label: 'Código do item', obrig: true, pistas: ['item', 'codigo', 'cod'] },
  { k: 'etapa', label: 'Etapa / grupo', pistas: ['etapa', 'grupo'] },
  { k: 'subetapa', label: 'Subetapa / subgrupo', pistas: ['subetapa', 'subgrupo'] },
  { k: 'descricao', label: 'Descrição do serviço', pistas: ['descricao', 'servico', 'discriminacao'] },
  { k: 'unidade', label: 'Unidade', pistas: ['unid', 'un'] },
  { k: 'quantidade', label: 'Quantidade', obrig: true, pistas: ['quant', 'qtd', 'qtde'] },
  { k: 'custoUnit', label: 'Custo unitário (R$)', pistas: ['custo unit', 'preco unit', 'valor unit', 'unitario'] },
  { k: 'total', label: 'Total (R$) — usado se não houver custo unitário', pistas: ['total'] },
  { k: 'comp', label: 'Código da composição', pistas: ['composicao', 'cod. comp', 'sinapi'] },
];

/** Sugere a coluna de cada campo pelo texto do cabeçalho. */
export function sugerirMapeamento(cabecalho) {
  const h = cabecalho.map((x) => norm(x));
  const usados = new Set(), map = {};
  for (const f of CAMPOS) {
    let j = -1;
    for (const p of f.pistas) { j = h.findIndex((x, i) => !usados.has(i) && x && (x === p || x.startsWith(p))); if (j >= 0) break; }
    if (j < 0) for (const p of f.pistas) { j = h.findIndex((x, i) => !usados.has(i) && x.includes(p)); if (j >= 0) break; }
    map[f.k] = j; if (j >= 0) usados.add(j);
  }
  return map;
}

/** Valida e converte as linhas conforme o mapeamento. Puro (testável). */
export function validarLinhas(linhas, map, obra, lib, primeiraLinha = 1) {
  const compsPorCodigo = new Map();
  for (const c of lib.composicoes) if (!compsPorCodigo.has(c.codigo) || c.ativa) compsPorCodigo.set(c.codigo, c);
  const existentes = new Map(obra.orcamento.map((i) => [String(i.codigo).trim().toLowerCase(), i]));
  const vistos = new Map();
  const v = (r, k) => (map[k] >= 0 ? r[map[k]] : '');
  const out = [];
  linhas.forEach((r, n) => {
    if (r.every((x) => x === '' || x == null)) return;
    const codigo = String(v(r, 'codigo') ?? '').trim();
    const reg = { linha: n + primeiraLinha, codigo, etapa: String(v(r, 'etapa') ?? '').trim(), subetapa: String(v(r, 'subetapa') ?? '').trim(), descricao: String(v(r, 'descricao') ?? '').trim(), unidade: String(v(r, 'unidade') ?? '').trim(), erros: [], avisos: [] };
    const num = (x) => { if (x === '' || x == null) return null; const n = typeof x === 'number' ? x : parseNum(x); return Number.isFinite(n) ? n : null; };
    reg.quantidade = num(v(r, 'quantidade'));
    let cu = num(v(r, 'custoUnit'));
    const tot = num(v(r, 'total'));
    if (cu == null && tot != null && reg.quantidade) cu = tot / reg.quantidade;
    reg.custoUnit = cu ?? 0;
    const compCod = String(v(r, 'comp') ?? '').trim();
    reg.comp = compCod ? compsPorCodigo.get(compCod) || null : null;
    if (!codigo) reg.erros.push('sem código');
    if (reg.quantidade == null || reg.quantidade < 0) reg.erros.push('quantidade inválida');
    if (cu == null && map.custoUnit >= 0) reg.avisos.push('sem custo unitário (fica 0)');
    if (cu != null && cu < 0) reg.erros.push('custo negativo');
    if (!reg.descricao && !reg.comp) reg.erros.push('sem descrição nem composição');
    if (compCod && !reg.comp) reg.avisos.push(`composição ${compCod} não está na biblioteca`);
    const k = codigo.toLowerCase();
    if (codigo && vistos.has(k)) reg.erros.push(`código repetido na planilha (linha ${vistos.get(k)})`);
    else if (codigo) vistos.set(k, reg.linha);
    reg.existente = codigo ? existentes.get(k) || null : null;
    out.push(reg);
  });
  return out;
}

/** Aplica as linhas válidas. modo: 'novos' (pula existentes) ou 'atualizar' (novos + atualiza pelo código). */
export function aplicarImportacao(obra, regs, modo) {
  const rel = { incluidos: 0, atualizados: 0, ignorados: [] };
  for (const r of regs) {
    if (r.erros.length) { rel.ignorados.push(`linha ${r.linha} (${r.codigo || 'sem código'}): ${r.erros.join(', ')}`); continue; }
    const dados = { etapa: r.etapa, subetapa: r.subetapa, descricao: r.comp ? '' : r.descricao, unidade: r.comp ? '' : r.unidade, quantidade: r.quantidade, custoUnit: r.custoUnit, ...(r.comp ? { composicaoId: r.comp.id } : {}) };
    if (r.existente) {
      if (modo !== 'atualizar') { rel.ignorados.push(`linha ${r.linha} (${r.codigo}): já existe na obra`); continue; }
      Object.assign(r.existente, Object.fromEntries(Object.entries(dados).filter(([k, x]) => !(k === 'etapa' || k === 'subetapa') || x)));
      rel.atualizados++;
    } else {
      obra.orcamento.push(novoItem({ codigo: r.codigo, composicaoId: r.comp?.id || '', ...dados }));
      rel.incluidos++;
    }
  }
  return rel;
}

/* ---------- interface ---------- */
function janela(html, montar) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = html;
  const form = dlg.querySelector('form');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    form.onsubmit = (e) => { e.preventDefault(); finish(form); };
    form.querySelector('[value="cancel"]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    montar?.(form);
    dlg.showModal();
  });
}

function escolherArquivo() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv';
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}

export async function importarOrcamentoExcel(obra) {
  const file = await escolherArquivo();
  if (!file) return;
  let wb;
  try { await loadScript(LIBS.xlsx); wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' }); }
  catch (e) { return toast('Não foi possível ler o arquivo: ' + e.message, 5000); }
  const X = window.XLSX;
  const ler = (nome) => X.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '' });
  const acharCab = (rows) => { let best = 0, bestN = -1; rows.slice(0, 20).forEach((r, i) => { const n = r.filter((x) => typeof x === 'string' && x.trim()).length; if (n > bestN) { bestN = n; best = i; } }); return best; };
  let aba = wb.SheetNames.find((n) => /or[cç]amento/i.test(n)) || wb.SheetNames[0];
  let rows = ler(aba), iCab = acharCab(rows), map = sugerirMapeamento(rows[iCab] || []);

  // 1) associação de colunas
  const montarMapa = () => {
    const cab = rows[iCab] || [];
    const opt = (sel) => `<option value="-1">— não importar —</option>${cab.map((h, j) => `<option value="${j}" ${j === sel ? 'selected' : ''}>${String.fromCharCode(65 + (j % 26))}${j >= 26 ? Math.floor(j / 26) : ''}: ${esc(String(h || '(vazio)').slice(0, 40))}</option>`).join('')}`;
    return `<form method="dialog" class="dlg-wide"><h2>Importar orçamento — associar colunas</h2>
      <p class="muted small" style="margin:6px 0 10px">${esc(file.name)} · ${rows.length - iCab - 1} linhas de dados. Confira qual coluna da planilha corresponde a cada campo.</p>
      <div class="grid-form">
        <label class="field">Aba<select name="aba">${wb.SheetNames.map((n) => `<option ${n === aba ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label class="field">Linha do cabeçalho<input name="cab" inputmode="numeric" value="${iCab + 1}"></label>
      </div>
      <div class="grid-form" style="margin-top:10px">${CAMPOS.map((f) => `<label class="field">${f.label}${f.obrig ? ' *' : ''}<select name="m_${f.k}">${opt(map[f.k])}</select></label>`).join('')}</div>
      <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Pré-visualizar</button></div></form>`;
  };
  for (;;) {
    let reabrir = false; // trocar a aba ou a linha do cabeçalho fecha e reabre o diálogo com as novas colunas
    const form = await janela(montarMapa(), (f) => {
      f.aba.onchange = () => { aba = f.aba.value; rows = ler(aba); iCab = acharCab(rows); map = sugerirMapeamento(rows[iCab] || []); reabrir = true; document.getElementById('dlg').close(); };
      f.cab.onchange = () => { iCab = Math.max(0, (parseInt(f.cab.value, 10) || 1) - 1); map = sugerirMapeamento(rows[iCab] || []); reabrir = true; document.getElementById('dlg').close(); };
    });
    if (!form) { if (reabrir) continue; return; }
    for (const f of CAMPOS) map[f.k] = parseInt(form[`m_${f.k}`].value, 10);
    const faltam = CAMPOS.filter((f) => f.obrig && map[f.k] < 0);
    if (faltam.length) { toast(`Associe: ${faltam.map((f) => f.label).join(', ')}.`, 4000); continue; }
    break;
  }

  // 2) pré-visualização e confirmação
  const regs = validarLinhas(rows.slice(iCab + 1), map, obra, store.lib(), iCab + 2);
  const erros = regs.filter((r) => r.erros.length), exist = regs.filter((r) => !r.erros.length && r.existente);
  const novos = regs.filter((r) => !r.erros.length && !r.existente);
  const prev = regs.slice(0, 40).map((r) => `<tr class="${r.erros.length ? 'erro' : ''}"><td>${r.linha}</td><td>${esc(r.codigo)}</td><td>${esc(r.comp ? `${r.comp.codigo} ${r.comp.descricao}` : r.descricao)}</td><td>${esc(r.comp?.unidade || r.unidade)}</td><td class="num">${r.quantidade == null ? '—' : fmtNum(r.quantidade, 3)}</td><td class="num">${fmtBRL(r.custoUnit)}</td>
    <td class="small">${r.erros.length ? `<span class="badge crit">${esc(r.erros.join(', '))}</span>` : r.existente ? '<span class="badge warn">já existe</span>' : '<span class="badge good">novo</span>'}${r.avisos.length ? `<div class="muted">${esc(r.avisos.join('; '))}</div>` : ''}</td></tr>`).join('');
  const form2 = await janela(`<form method="dialog" class="dlg-wide"><h2>Importar orçamento — conferir</h2>
    <div class="row" style="margin:8px 0"><span class="badge good">${novos.length} novos</span><span class="badge warn">${exist.length} já existem (mesmo código)</span><span class="badge crit">${erros.length} com erro (serão ignorados)</span></div>
    <div class="table-wrap" style="max-height:44vh;overflow:auto"><table class="data"><thead><tr><th>Linha</th><th>Código</th><th>Serviço</th><th>Un.</th><th class="num">Qtd</th><th class="num">Custo unit.</th><th>Situação</th></tr></thead><tbody>${prev}</tbody></table></div>
    ${regs.length > 40 ? `<div class="muted small">Mostrando 40 de ${regs.length} linhas.</div>` : ''}
    <div class="stack" style="margin-top:10px">
      <label class="check"><input type="radio" name="modo" value="novos" checked> Incluir só os novos (não mexer nos itens que já existem)</label>
      <label class="check"><input type="radio" name="modo" value="atualizar" ${exist.length ? '' : 'disabled'}> Incluir os novos e <b>atualizar</b> os ${exist.length} existentes pelo código (quantidade, custo, descrição)</label>
      <label class="check"><input type="checkbox" name="revisao" checked> Salvar uma revisão do orçamento atual antes (para comparar/desfazer)</label>
    </div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok" ${novos.length + exist.length ? '' : 'disabled'}>Importar</button></div></form>`);
  if (!form2) return;
  const modo = form2.querySelector('[name=modo]:checked').value;
  if (form2.revisao.checked) obra.revisoesOrcamento.unshift(snapshotOrcamento(obra, store.lib(), `Antes da importação de ${file.name}`));
  const rel = aplicarImportacao(obra, regs, modo);
  registrar(obra, 'Orçamento importado do Excel', `${file.name}: ${rel.incluidos} incluídos, ${rel.atualizados} atualizados, ${rel.ignorados.length} ignorados`, usuario());
  commit(obra);
  info('Importação concluída', `<p style="margin-top:0"><b>${rel.incluidos}</b> itens incluídos · <b>${rel.atualizados}</b> atualizados · <b>${rel.ignorados.length}</b> ignorados.</p>
    ${rel.ignorados.length ? `<details open><summary>Itens ignorados (corrija na planilha e importe de novo)</summary><ul class="small">${rel.ignorados.slice(0, 80).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    <p class="small muted">Próximo passo: vincule os itens novos às atividades na aba Vínculos.</p>`);
}
