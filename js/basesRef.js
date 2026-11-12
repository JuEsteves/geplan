// Composições › Bases de referência (modo nuvem): pesquisa no SINAPI (base pública, atualizada todo mês pelo robô da
// plataforma) e nas bases da empresa; custo por UF e regime (desonerado ou não), itens e coeficientes, comparação entre
// estados e entre meses/bases, e "Adicionar à biblioteca" — a composição é COPIADA para a biblioteca da empresa
// (Própria) e pode ser ajustada à vontade; a base de referência nunca é alterada. Dados e permissões: migração 0014.
import * as store from './store.js';
import { esc, I, ui, toast, ask, info, formDialog, commit, queueRender } from './ui.js';
import { fmtBRL, fmtNum } from './schedule.js';
import { sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { novaComposicao, uid } from './model.js';
import { LIBS, loadScript } from './libs.js';
import { UFS, REGIMES, maoDeObraItens, custoEm, variacao, interpretarReferenciaSinapi, nomeVersao, gravarBase, CAMPOS_BASE, acharCabecalhoBase, sugerirColunas, interpretarBaseEmpresa, custoNaBase } from './basesRefDados.js';

const B = { carregado: false, carregando: false, erro: '', bases: [], admin: false, refOrg: null, busca: new Map(), detalhe: new Map(), importando: '' };
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const ctx = () => nuvem.contexto();
const nomeBase = (id) => B.bases.find((b) => b.id === id)?.nome || 'base';
const mesBR = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

/** Escolhas da tela: base, UF e regime (padrão da empresa; cada pessoa pode trocar na tela). */
function sel() {
  const s = ui.refSel ||= { base: '', uf: '', regime: '', termo: '' };
  if (!s.base || !B.bases.some((b) => b.id === s.base)) s.base = B.bases.find((b) => b.status === 'publicada')?.id || '';
  if (!s.uf) s.uf = B.refOrg?.uf || 'SP';
  if (!s.regime) s.regime = B.refOrg?.regime || 'nao_desonerado';
  return s;
}

export async function carregarBases(forcar = false) {
  if (B.carregando || (B.carregado && !forcar)) return;
  B.carregando = true; B.erro = '';
  try {
    const c = await sb();
    const [bs, org, perfil] = await Promise.all([
      c.from('ref_bases').select('id, org_id, fonte, nome, mes, arquivo, status, ufs, regimes, totais, criado_em, publicado_em').order('mes', { ascending: false, nullsFirst: false }).order('criado_em', { ascending: false }),
      c.from('organizations').select('ref_uf, ref_regime').eq('id', ctx().orgId).maybeSingle(),
      c.from('user_profiles').select('is_platform_admin').eq('id', ctx().userId).maybeSingle(),
    ]);
    B.bases = ok(bs, 'bases') || [];
    const o = org.data;
    B.refOrg = o ? { uf: o.ref_uf || '', regime: o.ref_regime || 'nao_desonerado' } : null;
    B.admin = !!perfil.data?.is_platform_admin;
    B.carregado = true;
  } catch (e) { B.erro = e.message; }
  B.carregando = false;
  queueRender();
}
export function limparBases() { Object.assign(B, { carregado: false, carregando: false, erro: '', bases: [], admin: false, refOrg: null, busca: new Map(), detalhe: new Map(), importando: '' }); ui.refSel = null; }

async function buscar(baseId, termo) {
  const chave = `${baseId}|${termo}`;
  if (B.busca.has(chave)) return;
  B.busca.set(chave, null);
  try {
    const c = await sb();
    const comps = ok(await c.rpc('ref_buscar', { p_base: baseId, p_termo: termo, p_limite: 60 }), 'pesquisa') || [];
    const codigos = comps.map((x) => x.codigo);
    const itens = codigos.length ? ok(await c.from('ref_itens').select('composicao, codigo, descricao, unidade, coeficiente').eq('base_id', baseId).in('composicao', codigos).ilike('unidade', 'h%'), 'itens') || [] : [];
    B.busca.set(chave, comps.map((x) => ({ ...x, mo: maoDeObraItens(itens.filter((i) => i.composicao === x.codigo)) })));
  } catch (e) { B.busca.set(chave, { erro: e.message }); }
  queueRender();
}

async function carregarDetalhe(baseId, codigo) {
  const chave = `${baseId}|${codigo}`;
  if (B.detalhe.has(chave)) return;
  B.detalhe.set(chave, null);
  try {
    const c = await sb();
    const [comp, itens, versoes, maoTodas] = await Promise.all([
      c.from('ref_composicoes').select('*').eq('base_id', baseId).eq('codigo', codigo).maybeSingle(),
      c.from('ref_itens').select('*').eq('base_id', baseId).eq('composicao', codigo).order('posicao'),
      c.from('ref_composicoes').select('base_id, descricao, unidade, custos').eq('codigo', codigo),
      c.from('ref_itens').select('base_id, unidade, coeficiente, descricao, codigo').eq('composicao', codigo).ilike('unidade', 'h%'),
    ]);
    const its = ok(itens, 'itens') || [];
    const cods = (t) => [...new Set(its.filter((i) => i.tipo === t).map((i) => i.codigo))];
    const [ins, aux] = await Promise.all([
      cods('I').length ? c.from('ref_insumos').select('codigo, precos').eq('base_id', baseId).in('codigo', cods('I')) : { data: [] },
      cods('C').length ? c.from('ref_composicoes').select('codigo, custos').eq('base_id', baseId).in('codigo', cods('C')) : { data: [] },
    ]);
    const precos = new Map([...(ok(ins, 'insumos') || []).map((x) => [`I${x.codigo}`, x.precos]), ...(ok(aux, 'composições') || []).map((x) => [`C${x.codigo}`, x.custos])]);
    const mo = ok(maoTodas, 'mão de obra') || [];
    B.detalhe.set(chave, { comp: ok(comp, 'composição'), itens: its, precos,
      versoes: (ok(versoes, 'versões') || []).map((v) => ({ ...v, horas: mo.filter((m) => m.base_id === v.base_id).reduce((a, m) => a + Number(m.coeficiente || 0), 0),
        assinatura: mo.filter((m) => m.base_id === v.base_id).map((m) => `${m.codigo}:${Number(m.coeficiente)}`).sort().join('|') })) });
  } catch (e) { B.detalhe.set(chave, { erro: e.message }); }
  queueRender();
}

/* ---------- telas ---------- */
const abasComposicoes = () => `<div class="tabs"><a href="#/composicoes">Minha biblioteca (${store.lib().composicoes.length})</a><a href="#/bases" class="active">Bases de referência</a></div>`;
const cabecalho = (sub = '') => `<div class="page-head"><div><h1>Composições</h1><div class="muted">${sub || 'Bases de referência (SINAPI e bases da empresa): pesquise, compare estados e meses e adicione à sua biblioteca para usar e ajustar.'}</div></div></div>${abasComposicoes()}`;
const opcoes = (lista, atual) => lista.map(([v, r]) => `<option value="${esc(v)}" ${v === atual ? 'selected' : ''}>${esc(r)}</option>`).join('');
const chipsMO = (mo, un) => (mo.length ? mo.map((f) => `<span class="chip${f.lider ? ' lider' : ''}">${esc(f.funcao)} ${fmtNum(f.coef, 4)} h/${esc(un)}${f.lider ? ' · líder' : ''}</span>`).join(' ') : '<span class="muted">sem mão de obra em horas</span>');

export function viewBases(route) {
  if (!nuvem.ativo()) return `${cabecalho()}<div class="card empty"><p>As bases de referência ficam no banco da empresa (modo nuvem).</p></div>`;
  if (!B.carregado) { setTimeout(() => carregarBases()); return `${cabecalho()}<div class="card empty"><p>${B.erro ? esc(B.erro) : 'Carregando…'}</p></div>`; }
  if (route.base && route.codigo) return viewDetalhe(route.base, decodeURIComponent(route.codigo));
  const s = sel();
  const publicadas = B.bases.filter((b) => b.status === 'publicada');
  const base = B.bases.find((b) => b.id === s.base);
  const termo = s.termo.trim();
  let res = null;
  if (base && termo) { const chave = `${base.id}|${termo}`; if (!B.busca.has(chave)) setTimeout(() => buscar(base.id, termo)); res = B.busca.get(chave); }
  const naLib = new Set(store.lib().composicoes.map((c) => c.refSinapi).filter(Boolean));
  const padraoOrg = B.refOrg && B.refOrg.uf === s.uf && B.refOrg.regime === s.regime;
  return `${cabecalho()}<div class="stack">
    ${B.erro ? `<div class="alert err">${esc(B.erro)}</div>` : ''}
    ${publicadas.length ? `<div class="card card-pad stack">
      <div class="grid-form">
        <label class="field">Base<select data-chg="refSel" data-k="base">${opcoes(publicadas.map((b) => [b.id, `${b.nome}${b.org_id ? ' (da empresa)' : ''}`]), s.base)}</select></label>
        <label class="field">Estado (UF)<select data-chg="refSel" data-k="uf">${opcoes(UFS.map((u) => [u, u]), s.uf)}</select></label>
        <label class="field">Regime<select data-chg="refSel" data-k="regime">${opcoes(Object.entries(REGIMES), s.regime)}</select></label>
      </div>
      <div class="row between small" style="flex-wrap:wrap;gap:6px"><span class="muted">${base ? `${esc(base.nome)} · ${fmtNum(base.totais?.composicoes || 0, 0)} composições · publicada em ${new Date(base.publicado_em).toLocaleDateString('pt-BR')}` : ''}</span>
        ${padraoOrg ? '<span class="badge good">padrão da empresa</span>' : ctx()?.papel === 'admin' ? '<button class="btn sm" data-act="refPadrao">Usar UF e regime como padrão da empresa</button>' : ''}</div>
      <input data-inp="refBusca" data-key="refBusca" value="${esc(s.termo)}" placeholder="Pesquise por código ou palavras (ex.: alvenaria bloco ceramico 14, 87529, chapisco)">
    </div>
    ${!termo ? '<div class="muted small">Digite para pesquisar. Os custos mostrados são do estado e do regime escolhidos. Ao adicionar, a composição é copiada para a sua biblioteca (Própria), com as funções de mão de obra e a líder sugerida — tudo editável; a base de referência não muda.</div>'
      : res == null ? '<div class="card empty"><p>Pesquisando…</p></div>' : res.erro ? `<div class="alert err">${esc(res.erro)}</div>`
      : res.length ? res.map((c) => { const v = custoNaBase(c, base, s.uf, s.regime);
        return `<div class="card sinapi-item">
          <div class="row between" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:200px"><b>${esc(c.codigo)}</b> ${esc(c.descricao)} <span class="muted">(${esc(c.unidade)})</span>${c.grupo ? `<div class="small muted">${esc(c.grupo)}</div>` : ''}</div>
            <div class="row" style="gap:6px;flex-wrap:wrap"><b class="nowrap">${v == null ? '<span class="muted small">sem custo nesta UF</span>' : `${fmtBRL(v)}`}</b>${naLib.has(c.codigo) ? '<span class="badge good">na biblioteca</span>' : ''}
              <a class="btn sm" href="#/bases/${base.id}/${encodeURIComponent(c.codigo)}">Detalhes e comparação</a><button class="btn sm primary" data-act="refAdicionar" data-base="${base.id}" data-c="${esc(c.codigo)}">${I.plus} Adicionar à biblioteca</button></div></div>
          <div class="small" style="margin-top:6px">${chipsMO(c.mo, c.unidade)}</div></div>`; }).join('') + (res.length >= 60 ? '<div class="muted small">Mostrando as 60 primeiras. Refine a busca.</div>' : '')
      : '<div class="card empty"><p>Nada encontrado.</p></div>'}`
    : `<div class="card empty"><p>Nenhuma base de referência publicada ainda.</p><p class="muted small">O SINAPI entra automaticamente todo mês pelo robô da plataforma${B.admin ? ' — ou importe a planilha abaixo' : ''}.</p></div>`}
    ${painelEmpresa()}
    ${B.admin ? painelAdmin() : ''}
  </div>`;
}

const gravaBaseEmpresa = () => ['admin', 'engenheiro'].includes(ctx()?.papel);
function painelEmpresa() {
  const minhas = B.bases.filter((b) => b.org_id);
  if (!minhas.length && !gravaBaseEmpresa()) return '';
  return `<div class="card card-pad stack"><div class="row between" style="flex-wrap:wrap;gap:8px"><div><h2 style="margin:0">Bases da empresa</h2>
      <div class="muted small">TCPO, bases estaduais (ex.: ORSE, SEINFRA, SIURB) ou a sua própria planilha. Só a sua empresa vê. Você indica quais colunas são código, descrição, unidade, custo e, se houver, os itens com coeficientes.</div></div>
      ${gravaBaseEmpresa() ? (B.importando ? `<span class="badge info">${esc(B.importando)}</span>` : `<label class="btn primary">${I.upload} Importar planilha<input type="file" accept=".xlsx,.xls,.csv" data-chg="refImportarEmpresa" hidden></label>`) : ''}</div>
    ${minhas.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Base</th><th>Fonte</th><th>Preços</th><th class="num">Composições</th><th class="num">Itens</th><th>Importada</th><th></th></tr></thead><tbody>
      ${minhas.map((b) => `<tr><td><b>${esc(b.nome)}</b><div class="muted small">${esc(b.arquivo)}</div></td><td>${esc(b.fonte)}</td>
        <td class="small">${(b.ufs || []).length ? `${esc(b.ufs.join(', '))} · ${esc((b.regimes || []).map((r) => REGIMES[r]?.toLowerCase()).join(', '))}` : 'sem custo'}</td>
        <td class="num">${fmtNum(b.totais?.composicoes || 0, 0)}</td><td class="num">${fmtNum(b.totais?.itens || 0, 0)}</td>
        <td class="small nowrap">${b.status === 'publicada' ? new Date(b.publicado_em).toLocaleDateString('pt-BR') : '<span class="badge warn">incompleta</span>'}</td>
        <td>${gravaBaseEmpresa() ? `<button class="icon-btn danger" title="Retirar esta base" data-act="refExcluir" data-id="${b.id}">${I.trash}</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="muted small">Nenhuma base da empresa ainda.</div>'}</div>`;
}

function painelAdmin() {
  return `<details class="card card-pad" ${B.importando ? 'open' : ''}><summary style="cursor:pointer;font-weight:600">Administração da plataforma: versões do SINAPI</summary>
    <div class="stack" style="margin-top:10px">
      <p class="muted small" style="margin:0">O robô mensal importa sozinho. Se ele falhar (a Caixa mudou o formato ou o endereço), importe aqui: em caixa.gov.br › SINAPI › Relatórios Mensais, baixe o ZIP <b>formato-xlsx</b> do mês, extraia e escolha o arquivo <b>SINAPI_Referência_AAAA_MM.xlsx</b>.</p>
      ${B.importando ? `<div class="alert info small">${esc(B.importando)}</div>` : `<div><label class="btn primary">${I.upload} Importar planilha de referência do SINAPI<input type="file" accept=".xlsx" data-chg="refImportar" hidden></label></div>`}
      <div class="table-wrap"><table class="data"><thead><tr><th>Versão</th><th>Arquivo</th><th>Situação</th><th class="num">Composições</th><th class="num">Itens</th><th class="num">Insumos</th><th>Publicada</th><th></th></tr></thead><tbody>
        ${B.bases.filter((b) => !b.org_id).map((b) => `<tr><td><b>${esc(b.nome)}</b></td><td class="small">${esc(b.arquivo)}</td><td>${b.status === 'publicada' ? '<span class="badge good">publicada</span>' : '<span class="badge warn">importando</span>'}</td>
          <td class="num">${fmtNum(b.totais?.composicoes || 0, 0)}</td><td class="num">${fmtNum(b.totais?.itens || 0, 0)}</td><td class="num">${fmtNum(b.totais?.insumos || 0, 0)}</td>
          <td class="small nowrap">${b.publicado_em ? new Date(b.publicado_em).toLocaleString('pt-BR') : '—'}</td>
          <td><button class="icon-btn danger" title="Retirar esta versão" data-act="refExcluir" data-id="${b.id}">${I.trash}</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nenhuma versão.</td></tr>'}
      </tbody></table></div>
    </div></details>`;
}

function viewDetalhe(baseId, codigo) {
  const s = sel();
  const chave = `${baseId}|${codigo}`;
  if (!B.detalhe.has(chave)) setTimeout(() => carregarDetalhe(baseId, codigo));
  const d = B.detalhe.get(chave);
  const voltar = '<a class="muted small" href="#/bases">← Bases de referência</a>';
  if (!d) return `${cabecalho()}${voltar}<div class="card empty"><p>Carregando…</p></div>`;
  if (d.erro || !d.comp) return `${cabecalho()}${voltar}<div class="card empty"><p>${esc(d.erro || 'Composição não encontrada nesta base.')}</p></div>`;
  const c = d.comp;
  const base = B.bases.find((b) => b.id === baseId);
  const custo = custoNaBase(c, base, s.uf, s.regime);
  const preco = (i) => d.precos.get(`${i.tipo}${i.codigo}`)?.[s.regime]?.[s.uf] ?? null;
  const soma = d.itens.reduce((a, i) => a + (preco(i) == null ? 0 : preco(i) * Number(i.coeficiente)), 0);
  const faltaPreco = d.itens.some((i) => preco(i) == null);
  const mo = maoDeObraItens(d.itens);
  const valores = UFS.map((u) => ({ u, nd: custoEm(c, u, 'nao_desonerado'), de: custoEm(c, u, 'desonerado') }));
  const doRegime = valores.map((x) => (s.regime === 'desonerado' ? x.de : x.nd)).filter((v) => v != null);
  const min = doRegime.length ? Math.min(...doRegime) : null, max = doRegime.length ? Math.max(...doRegime) : null;
  const atual = d.versoes.find((v) => v.base_id === baseId);
  const versoes = d.versoes.map((v) => ({ ...v, base: B.bases.find((b) => b.id === v.base_id) })).filter((v) => v.base?.status === 'publicada')
    .sort((a, b) => String(b.base.mes || '').localeCompare(String(a.base.mes || '')) || a.base.nome.localeCompare(b.base.nome));
  return `${cabecalho()}<div class="stack">
    <div class="page-head" style="margin:0"><div>${voltar}<h2 style="margin:4px 0">${esc(c.codigo)} — ${esc(c.descricao)}</h2>
      <div class="muted small">${esc(c.unidade)}${c.grupo ? ` · ${esc(c.grupo)}` : ''}${c.situacao ? ` · ${esc(c.situacao)}` : ''} · ${esc(base?.nome || '')}</div></div>
      <button class="btn primary" data-act="refAdicionar" data-base="${baseId}" data-c="${esc(c.codigo)}">${I.plus} Adicionar à biblioteca</button></div>
    <div class="grid-form card card-pad">
      <label class="field">Estado (UF)<select data-chg="refSel" data-k="uf">${opcoes(UFS.map((u) => [u, u]), s.uf)}</select></label>
      <label class="field">Regime<select data-chg="refSel" data-k="regime">${opcoes(Object.entries(REGIMES), s.regime)}</select></label>
      <div><div class="muted small">${base?.org_id && (base.ufs || []).length === 1 ? `Custo da base (${esc(base.ufs[0])})` : `Custo em ${esc(s.uf)} (${esc(REGIMES[s.regime])})`}</div><div style="font-size:22px;font-weight:700">${custo == null ? '—' : fmtBRL(custo)}</div></div>
    </div>
    <div class="card card-pad stack"><h2 style="margin:0">Mão de obra (horas por ${esc(c.unidade)})</h2><div class="small">${chipsMO(mo, c.unidade)}</div>
      <div class="muted small">É daqui que sai a duração das atividades no GEPLAN: quantidade × horas ÷ (equipe × jornada × eficiência). Na biblioteca você ajusta à sua equipe.</div></div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Tipo</th><th>Código</th><th>Item</th><th>Un.</th><th class="num">Coeficiente</th><th class="num">Preço em ${esc(s.uf)}</th><th class="num">Parcial</th></tr></thead><tbody>
      ${d.itens.map((i) => { const p = preco(i); return `<tr><td class="small">${i.tipo === 'C' ? 'Composição' : 'Insumo'}</td><td>${esc(i.codigo)}</td><td class="small">${esc(i.descricao)}</td><td>${esc(i.unidade)}</td>
        <td class="num">${fmtNum(i.coeficiente, 7)}</td><td class="num nowrap">${p == null ? '—' : fmtBRL(p)}</td><td class="num nowrap">${p == null ? '—' : fmtBRL(p * Number(i.coeficiente))}</td></tr>`; }).join('')}
      </tbody><tfoot><tr><th colspan="6">Soma dos itens${faltaPreco ? ' (há item sem preço nesta UF)' : ''}</th><th class="num nowrap">${fmtBRL(soma)}</th></tr></tfoot></table></div>
    ${base?.org_id ? '' : `<div class="card card-pad stack"><h2 style="margin:0">Comparar estados</h2>
      <div class="muted small">${min != null ? `Menor ${fmtBRL(min)} · maior ${fmtBRL(max)} (${esc(REGIMES[s.regime].toLowerCase())}).` : ''} Em branco: a Caixa não publicou custo (falta preço de algum item na UF).</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>UF</th><th class="num">Não desonerado</th><th class="num">Desonerado</th><th class="num">vs ${esc(s.uf)}</th></tr></thead><tbody>
        ${valores.map((x) => { const v = s.regime === 'desonerado' ? x.de : x.nd; const dv = variacao(custo, v);
          return `<tr class="${x.u === s.uf ? 'linha-destaque' : ''}"><td><b>${x.u}</b></td><td class="num nowrap">${x.nd == null ? '—' : fmtBRL(x.nd)}</td><td class="num nowrap">${x.de == null ? '—' : fmtBRL(x.de)}</td>
            <td class="num small">${x.u === s.uf || dv == null ? '' : `${dv > 0 ? '+' : ''}${fmtNum(dv, 1)}%`}</td></tr>`; }).join('')}
      </tbody></table></div></div>`}
    <div class="card card-pad stack"><h2 style="margin:0">Comparar meses e bases</h2>
      ${versoes.length > 1 ? `<div class="table-wrap"><table class="data"><thead><tr><th>Base</th><th class="num">Custo em ${esc(s.uf)}</th><th class="num">vs esta</th><th class="num">Horas de mão de obra</th><th>Coeficientes</th></tr></thead><tbody>
        ${versoes.map((v) => { const val = custoNaBase(v, v.base, s.uf, s.regime); const dv = variacao(custo, val);
          return `<tr class="${v.base_id === baseId ? 'linha-destaque' : ''}"><td><a href="#/bases/${v.base_id}/${encodeURIComponent(codigo)}">${esc(v.base.nome)}</a>${v.base.org_id ? ' <span class="badge">empresa</span>' : ''}</td>
            <td class="num nowrap">${val == null ? '—' : fmtBRL(val)}</td><td class="num small">${v.base_id === baseId || dv == null ? '' : `${dv > 0 ? '+' : ''}${fmtNum(dv, 1)}%`}</td>
            <td class="num">${fmtNum(v.horas, 4)} h</td><td class="small">${v.base_id === baseId ? 'esta' : v.assinatura === atual?.assinatura ? 'iguais' : '<span class="badge warn">mudaram</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="muted small">Esta composição (mesmo código) só existe nesta base. Quando entrar o próximo mês, a comparação aparece aqui.</div>'}</div>
    ${cardComparar(baseId, c, custo, mo)}
  </div>`;
}

/** Comparar com uma composição de outra base (códigos diferentes, ex.: SINAPI × TCPO × própria). */
function cardComparar(baseId, c, custo, mo) {
  const s = sel();
  const cs = ui.refComp ||= { base: '', termo: '', alvo: null };
  const outras = B.bases.filter((b) => b.status === 'publicada' && b.id !== baseId);
  if (!outras.length) return '';
  if (!outras.some((b) => b.id === cs.base)) cs.base = outras[0].id;
  const termo = cs.termo.trim();
  let res = null;
  if (termo) { const k = `${cs.base}|${termo}`; if (!B.busca.has(k)) setTimeout(() => buscar(cs.base, termo)); res = B.busca.get(k); }
  const horas = (m) => m.reduce((a, f) => a + f.coef, 0);
  let tabela = '';
  if (cs.alvo) {
    const k = `${cs.alvo.base}|${cs.alvo.codigo}`;
    if (!B.detalhe.has(k)) setTimeout(() => carregarDetalhe(cs.alvo.base, cs.alvo.codigo));
    const d2 = B.detalhe.get(k);
    if (d2?.comp) {
      const b2 = B.bases.find((b) => b.id === cs.alvo.base);
      const c2 = d2.comp, v2 = custoNaBase(c2, b2, s.uf, s.regime), mo2 = maoDeObraItens(d2.itens), dv = variacao(custo, v2);
      const linha = (b, x, v, m, extra = '') => `<tr><td class="small">${esc(b?.nome || '')}</td><td><b>${esc(x.codigo)}</b></td><td class="small">${esc(x.descricao)}</td><td>${esc(x.unidade)}</td>
        <td class="num nowrap">${v == null ? '—' : fmtBRL(v)}${extra}</td><td class="num">${fmtNum(horas(m), 4)} h</td><td class="small">${m.map((f) => `${esc(f.funcao)} ${fmtNum(f.coef, 4)}`).join('<br>') || '—'}</td></tr>`;
      tabela = `<div class="table-wrap"><table class="data"><thead><tr><th>Base</th><th>Código</th><th>Descrição</th><th>Un.</th><th class="num">Custo</th><th class="num">Horas de mão de obra</th><th>Funções (h/un.)</th></tr></thead><tbody>
        ${linha(B.bases.find((b) => b.id === baseId), c, custo, mo)}${linha(b2, c2, v2, mo2, dv == null ? '' : ` <span class="muted small">(${dv > 0 ? '+' : ''}${fmtNum(dv, 1)}%)</span>`)}</tbody></table></div>
        ${normUn(c.unidade) !== normUn(c2.unidade) ? `<div class="alert warn small">Unidades diferentes (${esc(c.unidade)} × ${esc(c2.unidade)}): compare com cuidado.</div>` : ''}
        <div><button class="btn sm" data-act="refCompLimpar">Limpar comparação</button></div>`;
    } else tabela = `<div class="muted small">${d2?.erro ? esc(d2.erro) : 'Carregando…'}</div>`;
  }
  return `<div class="card card-pad stack"><h2 style="margin:0">Comparar com outra composição</h2>
    <div class="muted small">Escolha a base e pesquise a composição equivalente (os códigos mudam entre SINAPI, TCPO e bases próprias).</div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><select data-chg="refCompBase" style="width:auto">${opcoes(outras.map((b) => [b.id, `${b.nome}${b.org_id ? ' (da empresa)' : ''}`]), cs.base)}</select>
      <input data-inp="refCompBusca" data-key="refCompBusca" value="${esc(cs.termo)}" placeholder="Pesquisar nesta base…" style="flex:1;min-width:200px"></div>
    ${termo ? (res == null ? '<div class="muted small">Pesquisando…</div>' : res.erro ? `<div class="alert err small">${esc(res.erro)}</div>` : res.length
      ? `<ul class="lista">${res.slice(0, 8).map((x) => `<li class="row between" style="gap:8px"><span class="small"><b>${esc(x.codigo)}</b> ${esc(x.descricao)} <span class="muted">(${esc(x.unidade)})</span></span>
          <button class="btn sm" data-act="refCompEscolher" data-base="${cs.base}" data-c="${esc(x.codigo)}">Comparar</button></li>`).join('')}</ul>` : '<div class="muted small">Nada encontrado.</div>') : ''}
    ${tabela}</div>`;
}
const normUn = (u) => String(u || '').toLowerCase().replace(/[²2]/g, '2').replace(/[³3]/g, '3').replace(/\s|\./g, '');
const letraColuna = (j) => { let s = ''; for (let n = j + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/* ---------- ações ---------- */
async function adicionar(baseId, codigo) {
  const s = sel();
  const c = await sb();
  const [comp, itens] = await Promise.all([
    c.from('ref_composicoes').select('*').eq('base_id', baseId).eq('codigo', codigo).maybeSingle(),
    c.from('ref_itens').select('*').eq('base_id', baseId).eq('composicao', codigo).order('posicao'),
  ]);
  const x = ok(comp, 'composição');
  if (!x) throw new Error('Composição não encontrada.');
  const mo = maoDeObraItens(ok(itens, 'itens') || []);
  const lib = store.lib();
  const existentes = lib.composicoes.filter((y) => y.codigo === x.codigo);
  const base = B.bases.find((b) => b.id === baseId);
  const fonte = base?.fonte === 'SINAPI' ? 'SINAPI' : 'Própria (sugerida)';
  const nova = novaComposicao({
    codigo: x.codigo, descricao: x.descricao, unidade: x.unidade, fonte, refSinapi: base?.fonte === 'SINAPI' ? x.codigo : '', etapaEap: '',
    maoObra: mo.length ? mo.map((f) => ({ id: uid(), funcao: f.funcao, coef: f.coef, lider: f.lider })) : [{ id: uid(), funcao: 'Profissional', coef: 0, lider: true }],
    obs: `${base?.nome || ''} · ${s.uf} · ${REGIMES[s.regime].toLowerCase()}${custoNaBase(x, base, s.uf, s.regime) != null ? ` · custo ${fmtBRL(custoNaBase(x, base, s.uf, s.regime))}` : ''}`.trim(),
    versao: existentes.length ? Math.max(...existentes.map((y) => y.versao || 1)) + 1 : 1,
  });
  existentes.forEach((y) => { y.ativa = false; });
  lib.composicoes.push(nova);
  commit(lib);
  return nova;
}

export const acoesBases = {
  async refAdicionar(d) {
    const nova = await adicionar(d.base, d.c);
    toast(`${nova.codigo} copiada para a sua biblioteca${nova.versao > 1 ? ` (versão ${nova.versao})` : ''}. Ajuste em Minha biblioteca — a base de referência não muda.`, 5000);
  },
  refCompEscolher(d) { (ui.refComp ||= { base: '', termo: '', alvo: null }).alvo = { base: d.base, codigo: d.c }; queueRender(); },
  refCompLimpar() { if (ui.refComp) ui.refComp.alvo = null; queueRender(); },
  async refPadrao() {
    const s = sel();
    ok(await (await sb()).rpc('definir_referencia_org', { p_org: ctx().orgId, p_uf: s.uf, p_regime: s.regime }), 'referência');
    B.refOrg = { uf: s.uf, regime: s.regime };
    toast(`Padrão da empresa: ${s.uf} · ${REGIMES[s.regime].toLowerCase()}.`);
    queueRender();
  },
  async refExcluir(d) {
    const b = B.bases.find((x) => x.id === d.id);
    const alcance = b?.org_id ? 'Ela some da pesquisa da sua empresa' : 'Ela some da pesquisa para todas as empresas';
    if (!(await ask(`Retirar a versão "${b?.nome}"? ${alcance}. As composições já copiadas para a biblioteca continuam.`, 'Retirar'))) return;
    ok(await (await sb()).from('ref_bases').delete().eq('id', d.id), 'versão');
    B.busca.clear(); B.detalhe.clear();
    await carregarBases(true);
  },
};

export const mudancasBases = {
  refSel(d, el) { sel()[d.k] = el.value; queueRender(); },
  refCompBase(d, el) { Object.assign(ui.refComp ||= { base: '', termo: '', alvo: null }, { base: el.value }); queueRender(); },
  /** Base da empresa: escolhe a aba, sugere as colunas, a pessoa confere e o app grava (mesmo caminho do SINAPI). */
  async refImportarEmpresa(d, el) {
    const f = el.files[0]; el.value = '';
    if (!f) return;
    try {
      B.importando = 'Lendo a planilha…'; queueRender();
      await loadScript(LIBS.xlsx);
      await new Promise((r) => setTimeout(r, 50));
      const X = window.XLSX;
      const wb = X.read(await f.arrayBuffer(), { type: 'array' });
      B.importando = ''; queueRender();
      const abas = wb.SheetNames.map((n) => ({ n, linhas: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) })).filter((a) => a.linhas.length);
      if (!abas.length) throw new Error('A planilha está vazia.');
      let aba = abas.reduce((a, b) => (b.linhas.length > a.linhas.length ? b : a));
      if (abas.length > 1) {
        const v = await formDialog({ title: 'Importar base da empresa', ok: 'Continuar', text: 'Em qual aba estão as composições?',
          fields: [{ name: 'aba', label: 'Aba', type: 'select', value: aba.n, options: abas.map((a) => ({ value: a.n, label: `${a.n} (${a.linhas.length} linhas)` })) }] });
        if (!v) return;
        aba = abas.find((a) => a.n === v.aba);
      }
      const iCab = acharCabecalhoBase(aba.linhas);
      if (iCab < 0) throw new Error('Não achei a linha de cabeçalho (com "código" e "descrição") nas 30 primeiras linhas da aba.');
      const sug = sugerirColunas(aba.linhas[iCab]);
      const opc = [{ value: '-1', label: '— não usar —' }, ...aba.linhas[iCab].map((c, j) => ({ value: String(j), label: `${letraColuna(j)} · ${String(c ?? '').replace(/\s+/g, ' ').trim() || '(sem título)'}` }))];
      const v = await formDialog({ title: 'Importar base da empresa', ok: 'Ler e conferir',
        text: `Aba "${aba.n}", cabeçalho na linha ${iCab + 1}. Confira as colunas sugeridas — os itens (coeficientes) são opcionais.`,
        fields: [
          { name: 'fonte', label: 'Fonte (ex.: TCPO, ORSE, SEINFRA, Própria)', value: /tcpo/i.test(f.name) ? 'TCPO' : '', required: true },
          { name: 'nome', label: 'Nome da versão', value: f.name.replace(/\.[^.]+$/, ''), required: true },
          { name: 'uf', label: 'UF dos preços', type: 'select', value: sel().uf, options: UFS.map((u) => ({ value: u, label: u })) },
          { name: 'regime', label: 'Regime dos preços', type: 'select', value: sel().regime, options: Object.entries(REGIMES).map(([k, r]) => ({ value: k, label: r })) },
          ...CAMPOS_BASE.map(([k, rot, obrig]) => ({ name: `c_${k}`, label: `${rot}${obrig ? ' *' : ''}`, type: 'select', value: String(sug[k]), options: opc })),
        ] });
      if (!v) return;
      const mapa = Object.fromEntries(CAMPOS_BASE.map(([k]) => [k, Number(v[`c_${k}`])]));
      const dados = interpretarBaseEmpresa(aba.linhas, iCab, mapa, { uf: v.uf, regime: v.regime });
      if (dados.avisos.length) throw new Error(dados.avisos.join(' '));
      const comCusto = dados.composicoes.filter((c) => Object.keys(c.custos).length).length;
      const ex = dados.composicoes.slice(0, 3).map((c) => `${c.codigo} — ${c.descricao}${c.unidade ? ` (${c.unidade})` : ''}`).join('; ');
      if (!(await ask(`${fmtNum(dados.composicoes.length, 0)} composições (${fmtNum(comCusto, 0)} com custo) e ${fmtNum(dados.itens.length, 0)} itens. Exemplos: ${ex}. Importar como "${v.nome.trim()}" (só a sua empresa vê)?`, 'Importar'))) return;
      B.importando = 'Gravando…'; queueRender();
      const r = await gravarBase(await sb(), dados, { orgId: ctx().orgId, fonte: v.fonte.trim(), nome: v.nome.trim(), arquivo: f.name },
        (feito, total) => { B.importando = `Gravando… ${Math.round((feito / total) * 100)}%`; queueRender(); });
      B.importando = '';
      toast(`${v.nome.trim()}: ${fmtNum(r.totais.composicoes, 0)} composições importadas.`, 5000);
      await carregarBases(true);
      sel().base = r.id; queueRender();
    } catch (e) { B.importando = ''; queueRender(); info('Não foi possível importar', `<p>${esc(e.message)}</p>`); }
  },
  async refImportar(d, el) {
    const f = el.files[0]; el.value = '';
    if (!f) return;
    try {
      B.importando = 'Lendo a planilha (pode levar um minuto)…'; queueRender();
      await loadScript(LIBS.xlsx);
      await new Promise((r) => setTimeout(r, 50));
      const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const dados = interpretarReferenciaSinapi(wb, window.XLSX);
      if (dados.avisos.length) throw new Error(dados.avisos.join(' '));
      const nome = nomeVersao('SINAPI', dados.mes, f.name);
      const v = await formDialog({ title: 'Importar SINAPI', ok: 'Importar e publicar', text: `${nome}: ${fmtNum(dados.composicoes.length, 0)} composições, ${fmtNum(dados.itens.length, 0)} itens do analítico, ${fmtNum(dados.insumos.length, 0)} insumos; ${dados.ufs.length} UF; regimes: ${dados.regimes.map((r) => REGIMES[r].toLowerCase()).join(' e ')}. Fica disponível para todas as empresas.`,
        fields: [{ name: 'nome', label: 'Nome da versão', value: nome, required: true }] });
      if (!v) { B.importando = ''; queueRender(); return; }
      const r = await gravarBase(await sb(), dados, { fonte: 'SINAPI', nome: v.nome.trim(), arquivo: f.name }, (feito, total) => { B.importando = `Gravando no banco… ${Math.round(feito / total * 100)}%`; queueRender(); });
      B.importando = '';
      toast(`${v.nome} publicada: ${fmtNum(r.totais.composicoes, 0)} composições.`, 5000);
      await carregarBases(true);
    } catch (e) { B.importando = ''; queueRender(); info('Não foi possível importar', `<p>${esc(e.message)}</p>`); }
  },
};

export const entradasBases = {
  refBusca(el) { sel().termo = el.value; queueRender(); },
  refCompBusca(el) { (ui.refComp ||= { base: '', termo: '', alvo: null }).termo = el.value; queueRender(); },
};
