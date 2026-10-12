// Fornecedores: cadastro central da empresa (modo nuvem). Lê e grava direto no banco (Supabase), com as regras de
// acesso conferidas pelo servidor (migração 0006). O histórico comercial vem dos contratos/pedidos e despesas das
// obras que o usuário pode ver — nada é preenchido artificialmente.
import * as store from './store.js';
import { esc, I, ui, toast, ask, info, formDialog, queueRender, parseNum, fmtIn } from './ui.js';
import { fmtBRL, fmtNum, isoBR } from './schedule.js';
import { totalCompromisso } from './financeiro.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { enviarArquivo, urlTemporaria, ACCEPT, tamanhoLegivel, validarArquivo } from './nuvem/arquivos.js';
import { docValido, formatarDoc, tipoDoc, soDigitos, emailValido, UFS, normalizar } from './validacao.js';
import { liberado } from './permissoes.js';
import { indicadoresEntrega, OCORRENCIAS } from './suprimentosRegras.js';

const CRITERIOS = [['punctuality', 'Pontualidade'], ['quantity_ok', 'Conformidade da quantidade'], ['quality', 'Qualidade do material'],
  ['service', 'Atendimento'], ['issue_resolution', 'Resolução de ocorrências']];
const TIPOS_DOC = ['Proposta', 'Catálogo', 'Documento cadastral', 'Outro'];

const F = { carregado: false, carregando: false, erro: '', lista: [], categorias: [], secundarias: new Map(), fichas: new Map() };

const papel = () => nuvem.contexto()?.papel;
// gravação segue a liberação "fornecedores" (padrão: admin, engenheiro, compras, financeiro — migração 0007)
export const podeEditarFornecedor = () => !!papel() && papel() !== 'cliente' && liberado('fornecedores');
const podeAvaliar = () => ['admin', 'engenheiro', 'compras', 'financeiro', 'supervisor'].includes(papel());
export const podeCategorias = () => ['admin', 'engenheiro', 'compras'].includes(papel());
const disponivel = () => nuvemConfigurada() && nuvem.ativo() && papel() && papel() !== 'cliente';
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };

/* ---------- dados ---------- */
let carregandoP = null;
/** Carrega a lista (uma vez). Quem chama durante um carregamento recebe a mesma promessa e pode aguardar. */
export function carregarFornecedores(forcar = false) {
  if (!disponivel()) return Promise.resolve();
  if (F.carregando) return carregandoP;
  if (F.carregado && !forcar) return Promise.resolve();
  carregandoP = carregarAgora();
  return carregandoP;
}
async function carregarAgora() {
  F.carregando = true; F.erro = '';
  try {
    const c = await sb(); const org = nuvem.contexto().orgId;
    const [lista, cats, secs] = await Promise.all([
      c.from('suppliers').select('*').eq('org_id', org).is('deleted_at', null).order('trade_name'),
      c.from('supplier_categories').select('*').eq('org_id', org).order('position').order('name'),
      c.from('supplier_secondary_categories').select('supplier_id, category_id').eq('org_id', org),
    ]);
    F.lista = ok(lista, 'fornecedores') || [];
    F.categorias = ok(cats, 'categorias') || [];
    F.secundarias = new Map();
    for (const s of ok(secs, 'categorias') || []) { if (!F.secundarias.has(s.supplier_id)) F.secundarias.set(s.supplier_id, []); F.secundarias.get(s.supplier_id).push(s.category_id); }
    F.carregado = true;
  } catch (e) { F.erro = e.message; }
  F.carregando = false;
  queueRender();
}
async function carregarFicha(id, forcar = false) {
  if (F.fichas.has(id) && !forcar) return;
  F.fichas.set(id, { carregando: true, avaliacoes: [], documentos: [], cotacoes: [], entregas: [], limites: new Map() });
  try {
    const c = await sb();
    const s = fornecedorPorId(id);
    const ids = store.obras().map((o) => o.id);
    const nada = { data: [] };
    const colsCot = 'id, status, project_id, supplier_id, supplier_name, total_amount, freight_amount, lead_days, created_at';
    const colsGr = 'id, order_id, supplier_id, supplier_name, expected_date';
    const [av, docs, cots, cotsSemVinculo, grs, grsSemVinculo] = await Promise.all([
      c.from('supplier_evaluations').select('*').eq('supplier_id', id).order('created_at', { ascending: false }),
      c.from('supplier_documents').select('*').eq('supplier_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
      c.from('purchase_quotes').select(colsCot).eq('supplier_id', id).is('deleted_at', null),
      ids.length ? c.from('purchase_quotes').select(colsCot).in('project_id', ids).is('supplier_id', null).is('deleted_at', null) : nada,
      c.from('purchase_groups').select(colsGr).eq('supplier_id', id).is('deleted_at', null),
      ids.length ? c.from('purchase_groups').select(colsGr).in('project_id', ids).is('supplier_id', null).neq('supplier_name', '').is('deleted_at', null) : nada,
    ]);
    const daqui = (l) => (l || []).filter((x) => s && casaFornecedor(s, null, x.supplier_name));
    const cotacoes = [...(ok(cots, 'cotações') || []), ...daqui(ok(cotsSemVinculo, 'cotações'))];
    // entregas dos grupos comprados deste fornecedor; limite do prazo = data necessária do pedido (ou a previsão do grupo)
    const grupos = [...(ok(grs, 'grupos') || []), ...daqui(ok(grsSemVinculo, 'grupos'))];
    let entregas = [], limites = new Map();
    if (grupos.length) {
      const [ents, peds] = await Promise.all([
        c.from('purchase_deliveries').select('*').in('group_id', grupos.map((g) => g.id)).is('deleted_at', null),
        c.from('purchase_orders').select('id, needed_date').in('id', [...new Set(grupos.map((g) => g.order_id))]),
      ]);
      entregas = ok(ents, 'entregas') || [];
      const nec = new Map((ok(peds, 'pedidos') || []).map((p) => [p.id, p.needed_date]));
      limites = new Map(grupos.map((g) => [g.id, nec.get(g.order_id) || g.expected_date || '']));
    }
    F.fichas.set(id, { carregando: false, avaliacoes: ok(av, 'avaliações') || [], documentos: ok(docs, 'documentos') || [], cotacoes, entregas, limites });
  } catch (e) { F.fichas.set(id, { carregando: false, erro: e.message, avaliacoes: [], documentos: [], cotacoes: [], entregas: [], limites: new Map() }); }
  queueRender();
}
/** Mesmo critério do histórico comercial: ligado pelo cadastro ou, sem vínculo, pelo nome comercial/razão social. */
function casaFornecedor(s, id, nome) {
  if (id) return id === s.id;
  const n = normalizar(nome || '').trim();
  return !!n && [s.trade_name, s.legal_name].some((x) => x && normalizar(x).trim() === n);
}
export const fornecedoresAtivos = () => F.lista.filter((s) => s.status === 'ativo');
/** Categorias de fornecedor da empresa (também usadas nos grupos de materiais dos pedidos). */
export const categoriasFornecedor = () => F.categorias;
export const fornecedorPorId = (id) => F.lista.find((s) => s.id === id);
const nomeCategoria = (id) => F.categorias.find((c) => c.id === id)?.name || '';

/** Busca (sem acentos) por nome, razão social, CPF/CNPJ, categoria, cidade, produtos e contato. */
export function filtrarFornecedores(lista, { busca = '', categoria = '', status = 'ativo', cidade = '' } = {}, aux = {}) {
  const t = normalizar(busca.trim());
  const dig = soDigitos(busca);
  return lista.filter((s) => {
    if (status && s.status !== status) return false;
    if (cidade && normalizar(s.city) !== normalizar(cidade)) return false;
    const cats = [s.main_category_id, ...((aux.secundarias?.get(s.id)) || [])];
    if (categoria && !cats.includes(categoria)) return false;
    if (!t) return true;
    const texto = normalizar([s.trade_name, s.legal_name, s.city, s.state, s.products, s.representative, s.email, s.phone, s.whatsapp,
      ...cats.map((c) => aux.nomeCategoria?.(c) || '')].join(' '));
    return texto.includes(t) || (dig.length >= 3 && (s.doc_number.includes(dig) || soDigitos(s.phone).includes(dig) || soDigitos(s.whatsapp).includes(dig)));
  });
}

/** Histórico comercial a partir das obras visíveis: vínculo pelo cadastro ou, em registros antigos, pelo nome. */
export function historicoFornecedor(s, obras) {
  const nomes = new Set([normalizar(s.trade_name).trim(), normalizar(s.legal_name).trim()].filter(Boolean));
  const casa = (id, nome) => (id ? id === s.id : nomes.has(normalizar(nome).trim()));
  const linhas = [];
  for (const o of obras) {
    for (const k of o.compromissos || []) if (casa(k.fornecedorId, k.fornecedor)) linhas.push({ o, tipo: k.tipo, desc: k.objeto || k.numero || '', data: k.data, valor: totalCompromisso(k), status: k.status, porNome: !k.fornecedorId, k });
    for (const d of o.despesas || []) if (casa(d.fornecedorId, d.fornecedor)) linhas.push({ o, tipo: 'Despesa', desc: [d.documento, d.descricao].filter(Boolean).join(' · '), data: d.data, valor: Number(d.valor) || 0, status: '', porNome: !d.fornecedorId });
  }
  linhas.sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
  const pedidos = linhas.filter((l) => String(l.tipo).startsWith('Pedido'));
  return {
    linhas,
    obras: [...new Set(linhas.map((l) => l.o.id))].length,
    contratado: linhas.filter((l) => l.tipo !== 'Despesa').reduce((a, l) => a + l.valor, 0),
    despesas: linhas.filter((l) => l.tipo === 'Despesa').reduce((a, l) => a + l.valor, 0),
    materiais: [...new Set(pedidos.map((l) => l.k.objeto).filter(Boolean))],
  };
}

/* ---------- telas ---------- */
const indisponivel = () => `<div class="page-head"><div><h1>Fornecedores</h1></div></div>
  <div class="card empty"><p>${!nuvemConfigurada() ? 'O cadastro de fornecedores funciona no modo nuvem (banco de dados da empresa). Este aparelho está no modo local (Google Drive).'
    : papel() === 'cliente' ? 'Seu perfil não tem acesso ao cadastro de fornecedores.' : 'Carregando os dados da empresa…'}</p></div>`;

export function viewFornecedores() {
  if (!disponivel()) return indisponivel();
  if (!F.carregado && !F.carregando) setTimeout(() => carregarFornecedores());
  const f = { busca: ui.fornBusca || '', categoria: ui.fornCategoria || '', status: ui.fornStatus ?? 'ativo', cidade: ui.fornCidade || '' };
  const lista = filtrarFornecedores(F.lista, f, { secundarias: F.secundarias, nomeCategoria });
  const cidades = [...new Set(F.lista.map((s) => s.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const obras = store.obras();
  return `<div class="page-head"><div><h1>Fornecedores</h1><div class="muted">Cadastro central da empresa: contatos, condições comerciais, documentos e histórico.</div></div>
    ${podeEditarFornecedor() ? `<button class="btn primary" data-act="fornNovo">${I.plus} Novo fornecedor</button>` : ''}</div>
  <div class="stack">
    ${F.erro ? `<div class="alert err">${esc(F.erro)}</div>` : ''}
    <div class="row filtros-obras">
      <input data-inp="fornBusca" data-key="fornBusca" value="${esc(f.busca)}" placeholder="Buscar por nome, CPF/CNPJ, cidade, produto ou contato…" style="flex:1;min-width:220px">
      <select data-chg="fornCategoria" style="width:auto"><option value="">Todas as categorias</option>${F.categorias.filter((c) => c.active).map((c) => `<option value="${c.id}" ${c.id === f.categoria ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select data-chg="fornCidade" style="width:auto"><option value="">Todas as cidades</option>${cidades.map((x) => `<option ${x === f.cidade ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <select data-chg="fornStatus" style="width:auto">${[['ativo', 'Ativos'], ['inativo', 'Inativos'], ['', 'Todos']].map(([v, l]) => `<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${F.carregando && !F.carregado ? '<div class="card empty"><p>Carregando…</p></div>'
      : !F.lista.length ? `<div class="card empty"><p>Nenhum fornecedor cadastrado.</p>${podeEditarFornecedor() ? `<button class="btn primary" data-act="fornNovo">${I.plus} Cadastrar o primeiro</button>` : ''}</div>`
      : !lista.length ? '<div class="card empty"><p>Nenhum fornecedor encontrado com esses filtros.</p></div>'
      : `<div class="card table-wrap"><table class="data tabela-clicavel">
        <thead><tr><th>Fornecedor</th><th>Categoria</th><th>Cidade</th><th>Contato</th><th class="num">Registros nas obras</th><th>Status</th></tr></thead>
        <tbody>${lista.map((s) => {
          const h = historicoFornecedor(s, obras);
          return `<tr data-act="fornAbrir" data-id="${s.id}" tabindex="0">
            <td><b>${esc(s.trade_name)}</b>${s.legal_name ? `<div class="muted small">${esc(s.legal_name)}</div>` : ''}${s.doc_number ? `<div class="muted small">${tipoDoc(s.doc_number)} ${formatarDoc(s.doc_number)}</div>` : ''}</td>
            <td class="small">${esc(nomeCategoria(s.main_category_id) || '—')}</td>
            <td class="small">${esc([s.city, s.state].filter(Boolean).join('/') || '—')}</td>
            <td class="small">${esc(s.representative || '')}${s.phone || s.whatsapp ? `<div class="muted">${esc(s.phone || s.whatsapp)}</div>` : ''}</td>
            <td class="num">${h.linhas.length || '—'}</td>
            <td><span class="badge ${s.status === 'ativo' ? 'good' : ''}">${s.status === 'ativo' ? 'Ativo' : 'Inativo'}</span></td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="muted small">${lista.length} de ${F.lista.length} fornecedor(es).</div>`}
  </div>`;
}

const campo = (rot, val) => (val ? `<div><span class="muted small">${rot}</span><div>${val}</div></div>` : '');
const simNao = (v) => (v == null ? '' : v ? 'Sim' : 'Não');

export function viewFornecedor(route) {
  if (!disponivel()) return indisponivel();
  if (!F.carregado && !F.carregando) setTimeout(() => carregarFornecedores());
  const s = fornecedorPorId(route.id);
  if (!s) return F.carregado ? '<div class="card empty"><p>Fornecedor não encontrado.</p><a class="btn" href="#/fornecedores">Voltar</a></div>' : '<div class="card empty"><p>Carregando…</p></div>';
  if (!F.fichas.has(s.id)) setTimeout(() => carregarFicha(s.id));
  const ficha = F.fichas.get(s.id) || { carregando: true, avaliacoes: [], documentos: [] };
  const h = historicoFornecedor(s, store.obras());
  const secs = (F.secundarias.get(s.id) || []).map(nomeCategoria).filter(Boolean);
  const whats = soDigitos(s.whatsapp);
  const medias = CRITERIOS.map(([k, rot]) => {
    const notas = ficha.avaliacoes.map((a) => a[k]).filter((x) => x != null);
    return { rot, n: notas.length, media: notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : null };
  });
  const editar = podeEditarFornecedor();
  return `<div class="page-head"><div><a class="muted small" href="#/fornecedores">← Fornecedores</a><h1>${esc(s.trade_name)} <span class="badge ${s.status === 'ativo' ? 'good' : ''}" style="vertical-align:middle">${s.status === 'ativo' ? 'Ativo' : 'Inativo'}</span></h1>
    <div class="muted">${esc([s.legal_name, s.doc_number ? `${tipoDoc(s.doc_number)} ${formatarDoc(s.doc_number)}` : ''].filter(Boolean).join(' · '))}</div></div>
    ${editar ? `<div class="row"><button class="btn" data-act="fornEditar" data-id="${s.id}">Editar</button><button class="btn ${s.status === 'ativo' ? 'danger' : ''}" data-act="fornStatus" data-id="${s.id}">${s.status === 'ativo' ? 'Inativar' : 'Reativar'}</button></div>` : ''}</div>
  <div class="stack">
    ${s.status === 'inativo' ? `<div class="alert info small">Fornecedor inativo desde ${s.inactivated_at ? new Date(s.inactivated_at).toLocaleDateString('pt-BR') : '—'}. O histórico continua disponível.</div>` : ''}
    <div class="grid-2">
      <div class="card card-pad stack"><h2>Identificação e contato</h2>
        <div class="ficha-campos">
          ${campo('Categoria principal', esc(nomeCategoria(s.main_category_id)))}${campo('Outras categorias', esc(secs.join(', ')))}
          ${campo('Representante', esc(s.representative))}
          ${campo('Telefone', s.phone ? `<a href="tel:${soDigitos(s.phone)}">${esc(s.phone)}</a>` : '')}
          ${campo('WhatsApp', whats ? `<a href="https://wa.me/${whats.length <= 11 ? '55' + whats : whats}" target="_blank" rel="noopener">${esc(s.whatsapp)}</a>` : '')}
          ${campo('E-mail', s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : '')}
          ${campo('Endereço', esc([s.address, [s.city, s.state].filter(Boolean).join('/')].filter(Boolean).join(' — ')))}
          ${campo('Observações de contato', esc(s.contact_notes))}
        </div>
      </div>
      <div class="card card-pad stack"><h2>Atendimento e condições comerciais</h2>
        <div class="ficha-campos">
          ${campo('Regiões atendidas', esc(s.service_regions))}${campo('Entrega na obra', simNao(s.delivers_on_site))}${campo('Retirada no local', simNao(s.allows_pickup))}
          ${campo('Prazo de pagamento', esc(s.payment_terms))}${campo('Frete', esc(s.freight_rule))}
          ${campo('Pedido mínimo', s.min_order != null ? fmtBRL(s.min_order) : '')}${campo('Prazo médio de entrega', s.avg_lead_days != null ? `${s.avg_lead_days} dia(s)` : '')}
          ${campo('Produtos e materiais', esc(s.products))}${campo('Observações comerciais', esc(s.commercial_notes))}${campo('Observações', esc(s.notes))}
        </div>
        <div class="muted small">Condições informadas no cadastro (não são calculadas).</div>
      </div>
    </div>

    <div class="card card-pad stack"><h2>Histórico comercial</h2>
      ${h.linhas.length ? `<div class="kpis">
          <div class="card kpi"><div class="k-label">Obras atendidas</div><div class="k-value">${h.obras}</div></div>
          <div class="card kpi"><div class="k-label">Contratos e pedidos</div><div class="k-value" style="font-size:20px">${fmtBRL(h.contratado)}</div><div class="k-sub">com aditivos</div></div>
          <div class="card kpi"><div class="k-label">Despesas lançadas</div><div class="k-value" style="font-size:20px">${fmtBRL(h.despesas)}</div></div>
        </div>
        ${h.materiais.length ? `<div class="small"><span class="muted">Materiais pedidos:</span> ${h.materiais.map(esc).join(', ')}</div>` : ''}
        <div class="table-wrap"><table class="data"><thead><tr><th>Data</th><th>Obra</th><th>Tipo</th><th>Descrição</th><th class="num">Valor</th><th>Status</th></tr></thead><tbody>
        ${h.linhas.map((l) => `<tr><td class="nowrap small">${l.data ? isoBR(l.data) : '—'}</td><td><a href="#/obra/${l.o.id}/financeiro">${esc(l.o.nome)}</a></td><td class="small">${esc(l.tipo)}${l.porNome ? ' <span class="badge" title="Registro antigo ligado pelo nome do fornecedor">pelo nome</span>' : ''}</td><td class="small">${esc(l.desc)}</td><td class="num nowrap">${fmtBRL(l.valor)}</td><td class="small">${esc(l.status || '')}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<div class="muted small">Nenhum contrato, pedido ou despesa com este fornecedor nas obras que você pode ver.</div>'}
    </div>

    <div class="card card-pad stack"><h2>Cotações e entregas</h2>
      ${(() => {
        const ind = indicadoresEntrega(ficha.entregas || [], ficha.limites || new Map());
        const cots = ficha.cotacoes || [];
        const escolhidas = cots.filter((c) => c.status === 'escolhida').length;
        if (ficha.carregando) return '<div class="muted small">Carregando…</div>';
        if (!cots.length && !ind.entregas) return '<div class="muted small">Nenhuma cotação nem entrega registrada para este fornecedor em Suprimentos.</div>';
        return `<div class="kpis">
          <div class="card kpi"><div class="k-label">Cotações</div><div class="k-value">${cots.length}</div><div class="k-sub">${escolhidas} escolhida(s) para pedido</div></div>
          <div class="card kpi"><div class="k-label">Entregas registradas</div><div class="k-value">${ind.entregas}</div></div>
          <div class="card kpi"><div class="k-label">Entregas no prazo</div><div class="k-value">${ind.pctNoPrazo == null ? '—' : `${fmtNum(ind.pctNoPrazo, 1)}%`}</div><div class="k-sub">${ind.comDataNecessaria ? `${ind.noPrazo} de ${ind.comDataNecessaria} com data necessária` : 'nenhum pedido com data necessária'}</div></div>
          <div class="card kpi"><div class="k-label">Quantidade conforme</div><div class="k-value">${ind.pctConformes == null ? '—' : `${fmtNum(ind.pctConformes, 1)}%`}</div><div class="k-sub">${ind.conformes} de ${ind.entregas} entrega(s)</div></div>
        </div>
        ${ind.totalOcorrencias ? `<div class="small"><span class="muted">Ocorrências:</span> ${Object.entries(ind.ocorrencias).map(([k, n]) => `${esc(OCORRENCIAS[k] || k)} (${n})`).join(', ')}</div>` : ''}
        <div class="muted small">Calculado das entregas registradas em Suprimentos nos grupos comprados deste fornecedor (ligados ao cadastro ou, sem vínculo, pelo nome): "no prazo" = recebida até a data necessária do pedido (ou, sem ela, até a previsão do grupo); "conforme" = sem divergência nem ocorrência. São números do histórico, não uma nota do fornecedor.</div>`;
      })()}
    </div>

    <div class="grid-2">
      <div class="card card-pad stack">
        <div class="row between"><h2>Avaliação da equipe</h2>${podeAvaliar() ? `<button class="btn sm" data-act="fornAvaliar" data-id="${s.id}">Avaliar</button>` : ''}</div>
        <div class="muted small">Notas manuais de 1 a 5 dadas pela equipe. Não são indicadores automáticos.</div>
        ${ficha.avaliacoes.length ? `<table class="data"><tbody>${medias.map((m) => `<tr><td>${m.rot}</td><td class="num">${m.media == null ? '—' : `${fmtNum(m.media, 1)} <span class="muted small">(${m.n})</span>`}</td></tr>`).join('')}</tbody></table>
          <ul class="lista">${ficha.avaliacoes.slice(0, 6).map((a) => `<li class="small"><b>${new Date(a.created_at).toLocaleDateString('pt-BR')}</b> ${esc(a.evaluator_label || '')}${a.project_id ? ` · ${esc(store.obra(a.project_id)?.nome || 'obra')}` : ''}${a.comment ? `<div class="muted">${esc(a.comment)}</div>` : ''}</li>`).join('')}</ul>`
          : `<div class="muted small">${ficha.carregando ? 'Carregando…' : 'Nenhuma avaliação registrada.'}</div>`}
        <div class="muted small">Indicadores calculados das entregas estão no quadro "Cotações e entregas".</div>
      </div>
      <div class="card card-pad stack">
        <div class="row between"><h2>Documentos</h2>${editar ? `<button class="btn sm" data-act="fornDocumento" data-id="${s.id}">${I.upload} Anexar</button>` : ''}</div>
        ${ficha.documentos.length ? `<ul class="lista">${ficha.documentos.map((d) => `<li class="row between" style="gap:8px"><span><b>${esc(d.name)}</b> <span class="badge">${esc(d.kind)}</span><div class="muted small">${tamanhoLegivel(d.size_bytes)} · ${new Date(d.created_at).toLocaleDateString('pt-BR')}</div></span>
          <span class="row" style="gap:6px"><button class="btn sm" data-act="fornDocAbrir" data-path="${esc(d.storage_path)}" data-nome="${esc(d.name)}">Abrir</button>${editar ? `<button class="icon-btn danger" title="Remover" data-act="fornDocRemover" data-id="${d.id}" data-forn="${s.id}">${I.trash}</button>` : ''}</span></li>`).join('')}</ul>`
          : `<div class="muted small">${ficha.carregando ? 'Carregando…' : 'Nenhum documento anexado.'}</div>`}
        <div class="muted small">Arquivos guardados em armazenamento privado: só pessoas da empresa com acesso a fornecedores conseguem abrir (link temporário).</div>
      </div>
    </div>
  </div>`;
}

/* ---------- formulários ---------- */
function janela(titulo, corpo, okRot = 'Salvar') {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>${esc(titulo)}</h2><div class="stack" style="margin-top:12px">${corpo}</div>
    <div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${esc(okRot)}</button></div></form>`;
  const form = dlg.querySelector('form');
  return { dlg, form, erro: (m) => { const e = form.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; } };
}

const sel = (nome, opcoes, valor) => `<select name="${nome}">${opcoes.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(valor ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

/** Abre o cadastro (novo ou edição). Resolve com o fornecedor salvo (ou null). Usado também por Suprimentos. */
export function formularioFornecedor(s = {}) {
  const ativas = F.categorias.filter((c) => c.active || c.id === s.main_category_id);
  const secs = new Set(F.secundarias.get(s.id) || []);
  const triplo = [['', '—'], ['true', 'Sim'], ['false', 'Não']];
  const corpo = `
    <fieldset><legend>Identificação</legend><div class="grid-form">
      <label class="field">Nome comercial *<input name="trade_name" required maxlength="160" value="${esc(s.trade_name || '')}"></label>
      <label class="field">Razão social<input name="legal_name" maxlength="200" value="${esc(s.legal_name || '')}"></label>
      <label class="field">CNPJ ou CPF<input name="doc_number" inputmode="numeric" value="${esc(s.doc_number ? formatarDoc(s.doc_number) : '')}" placeholder="só números ou com pontuação"></label>
      <label class="field">Categoria principal${sel('main_category_id', [['', '—'], ...ativas.map((c) => [c.id, c.name])], s.main_category_id)}</label>
    </div>
    <div class="field" style="margin-top:8px">Outras categorias<div class="chips-check">${ativas.map((c) => `<label class="check small"><input type="checkbox" name="sec" value="${c.id}" ${secs.has(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></div>
    <label class="field">Produtos e materiais fornecidos<input name="products" value="${esc(s.products || '')}" placeholder="ex.: cimento, areia, cal, argamassa"></label></fieldset>
    <fieldset><legend>Contato</legend><div class="grid-form">
      <label class="field">Representante<input name="representative" value="${esc(s.representative || '')}"></label>
      <label class="field">Telefone<input name="phone" inputmode="tel" value="${esc(s.phone || '')}"></label>
      <label class="field">WhatsApp<input name="whatsapp" inputmode="tel" value="${esc(s.whatsapp || '')}"></label>
      <label class="field">E-mail<input name="email" type="email" value="${esc(s.email || '')}"></label>
      <label class="field">Endereço<input name="address" value="${esc(s.address || '')}"></label>
      <label class="field">Cidade<input name="city" value="${esc(s.city || '')}"></label>
      <label class="field">UF${sel('state', [['', '—'], ...UFS.map((u) => [u, u])], s.state)}</label>
    </div><label class="field">Observações de contato<input name="contact_notes" value="${esc(s.contact_notes || '')}"></label></fieldset>
    <fieldset><legend>Atendimento</legend><div class="grid-form">
      <label class="field">Cidades e regiões atendidas<input name="service_regions" value="${esc(s.service_regions || '')}"></label>
      <label class="field">Entrega na obra${sel('delivers_on_site', triplo, s.delivers_on_site == null ? '' : String(s.delivers_on_site))}</label>
      <label class="field">Retirada no local${sel('allows_pickup', triplo, s.allows_pickup == null ? '' : String(s.allows_pickup))}</label>
    </div></fieldset>
    <fieldset><legend>Condições comerciais</legend><div class="grid-form">
      <label class="field">Prazo de pagamento<input name="payment_terms" value="${esc(s.payment_terms || '')}" placeholder="ex.: 28 dias, à vista com 3%"></label>
      <label class="field">Frete<input name="freight_rule" value="${esc(s.freight_rule || '')}" placeholder="ex.: grátis acima de R$ 1.000"></label>
      <label class="field">Pedido mínimo (R$)<input name="min_order" inputmode="decimal" value="${s.min_order != null ? fmtIn(s.min_order, 2) : ''}"></label>
      <label class="field">Prazo médio de entrega (dias)<input name="avg_lead_days" inputmode="numeric" value="${s.avg_lead_days ?? ''}"></label>
    </div><label class="field">Observações comerciais<input name="commercial_notes" value="${esc(s.commercial_notes || '')}"></label>
    <label class="field">Observações gerais<textarea name="notes" rows="2">${esc(s.notes || '')}</textarea></label></fieldset>`;
  const { dlg, form, erro } = janela(s.id ? 'Editar fornecedor' : 'Novo fornecedor', corpo);
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const doc = soDigitos(v.doc_number);
      if ((v.trade_name || '').trim().length < 2) return erro('Informe o nome comercial.');
      if (doc && ![11, 14].includes(doc.length)) return erro('CPF tem 11 dígitos e CNPJ tem 14.');
      if (!docValido(doc)) return erro(`${tipoDoc(doc) || 'Documento'} inválido: confira os dígitos.`);
      if (!emailValido(v.email.trim())) return erro('E-mail inválido.');
      const minOrder = v.min_order.trim() ? parseNum(v.min_order) : null;
      if (minOrder != null && !(minOrder >= 0)) return erro('Pedido mínimo inválido.');
      const prazo = v.avg_lead_days.trim() ? Number(v.avg_lead_days) : null;
      if (prazo != null && !(Number.isInteger(prazo) && prazo >= 0)) return erro('Prazo médio deve ser um número inteiro de dias.');
      const tri = (x) => (x === '' ? null : x === 'true');
      const linha = {
        trade_name: v.trade_name.trim(), legal_name: v.legal_name.trim(), doc_number: doc, main_category_id: v.main_category_id || null,
        products: v.products.trim(), representative: v.representative.trim(), phone: v.phone.trim(), whatsapp: v.whatsapp.trim(),
        email: v.email.trim(), address: v.address.trim(), city: v.city.trim(), state: v.state, contact_notes: v.contact_notes.trim(),
        service_regions: v.service_regions.trim(), delivers_on_site: tri(v.delivers_on_site), allows_pickup: tri(v.allows_pickup),
        payment_terms: v.payment_terms.trim(), freight_rule: v.freight_rule.trim(), min_order: minOrder, avg_lead_days: prazo,
        commercial_notes: v.commercial_notes.trim(), notes: v.notes.trim(),
      };
      const btn = form.querySelector('[value=ok]'); btn.disabled = true; erro('');
      try {
        const c = await sb(); const org = nuvem.contexto().orgId;
        let salvo;
        if (s.id) salvo = ok(await c.from('suppliers').update(linha).eq('id', s.id).select().single(), 'fornecedor');
        else salvo = ok(await c.from('suppliers').insert({ ...linha, org_id: org }).select().single(), 'fornecedor');
        // categorias secundárias: substitui o conjunto
        const marcadas = [...form.querySelectorAll('[name=sec]:checked')].map((x) => x.value).filter((x) => x !== linha.main_category_id);
        ok(await c.from('supplier_secondary_categories').delete().eq('supplier_id', salvo.id), 'categorias');
        if (marcadas.length) ok(await c.from('supplier_secondary_categories').insert(marcadas.map((category_id) => ({ supplier_id: salvo.id, category_id, org_id: org }))), 'categorias');
        await carregarFornecedores(true);
        toast(s.id ? 'Fornecedor atualizado.' : 'Fornecedor cadastrado.');
        finish(salvo);
      } catch (err) {
        btn.disabled = false;
        erro(/duplicate|unique/i.test(err.original || err.message) ? 'Já existe um fornecedor com este CPF/CNPJ.' : err.message);
      }
    };
    dlg.showModal();
    form.querySelector('[name=trade_name]').focus();
  });
}

function formularioAvaliacao(s) {
  const obras = store.obras();
  const notas = [['', '—'], ...[1, 2, 3, 4, 5].map((n) => [n, String(n)])];
  const corpo = `<p class="muted small" style="margin:0">Notas de 1 (ruim) a 5 (ótimo). Preencha só o que você observou.</p>
    <div class="grid-form">${CRITERIOS.map(([k, rot]) => `<label class="field">${rot}${sel(k, notas, '')}</label>`).join('')}
    <label class="field">Obra (opcional)${sel('project_id', [['', '—'], ...obras.map((o) => [o.id, o.nome])], '')}</label></div>
    <label class="field">Comentário<textarea name="comment" rows="2"></textarea></label>`;
  const { dlg, form, erro } = janela(`Avaliar ${s.trade_name}`, corpo, 'Registrar avaliação');
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const linha = Object.fromEntries(CRITERIOS.map(([k]) => [k, v[k] ? Number(v[k]) : null]));
      if (Object.values(linha).every((x) => x == null)) return erro('Dê nota a pelo menos um critério.');
      const ctx = nuvem.contexto();
      try {
        const c = await sb();
        ok(await c.from('supplier_evaluations').insert({ ...linha, org_id: ctx.orgId, supplier_id: s.id, project_id: v.project_id || null,
          comment: v.comment.trim(), evaluated_by: ctx.userId, evaluator_label: ctx.email }), 'avaliação');
        await carregarFicha(s.id, true);
        toast('Avaliação registrada.');
        finish(true);
      } catch (err) { erro(err.message); }
    };
    dlg.showModal();
  });
}

function formularioDocumento(s) {
  const corpo = `<div class="grid-form"><label class="field">Tipo${sel('kind', TIPOS_DOC.map((t) => [t, t]), 'Proposta')}</label>
    <label class="field">Nome (opcional)<input name="name" placeholder="usa o nome do arquivo"></label></div>
    <label class="field">Arquivo (PDF, imagem, planilha ou documento; até 50 MB)<input type="file" name="arquivo" accept="${ACCEPT}" required></label>`;
  const { dlg, form, erro } = janela(`Anexar documento — ${s.trade_name}`, corpo, 'Enviar');
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const file = form.arquivo.files[0];
      try { validarArquivo(file); } catch (err) { return erro(err.message); }
      const btn = form.querySelector('[value=ok]'); btn.disabled = true; btn.textContent = 'Enviando…'; erro('');
      const ctx = nuvem.contexto();
      try {
        const caminho = await enviarArquivo(ctx.orgId, 'fornecedores', s.id, file);
        const c = await sb();
        ok(await c.from('supplier_documents').insert({ org_id: ctx.orgId, supplier_id: s.id, kind: form.kind.value, name: form.name.value.trim() || file.name,
          storage_path: caminho, mime_type: file.type, size_bytes: file.size, uploaded_by: ctx.userId }), 'documento');
        await carregarFicha(s.id, true);
        toast('Documento anexado.');
        finish(true);
      } catch (err) { btn.disabled = false; btn.textContent = 'Enviar'; erro(err.message); }
    };
    dlg.showModal();
  });
}

/* ---------- categorias (Configurações) ---------- */
export function secaoCategorias() {
  if (!disponivel() || !podeCategorias()) return '';
  if (!F.carregado && !F.carregando) setTimeout(() => carregarFornecedores());
  return `<div class="card card-pad stack"><h2>Categorias de fornecedores</h2>
    <p class="muted small" style="margin:0">Usadas no cadastro e na busca de fornecedores. Categorias desativadas somem das opções, mas continuam nos fornecedores que já as usam.</p>
    <div class="row"><input id="catFornNova" placeholder="Nova categoria" style="flex:1;min-width:180px" data-enter="catFornCriar"><button class="btn" data-act="catFornCriar">${I.plus} Adicionar</button></div>
    <div class="hol-list">${F.categorias.map((c) => `<div class="list-item"><span style="flex:1;${c.active ? '' : 'opacity:.55'}">${esc(c.name)}${c.active ? '' : ' <span class="badge">desativada</span>'}</span>
      <button class="btn sm" data-act="catFornRenomear" data-id="${c.id}">Renomear</button><button class="btn sm" data-act="catFornAtivar" data-id="${c.id}">${c.active ? 'Desativar' : 'Reativar'}</button></div>`).join('') || '<div class="muted small">Carregando…</div>'}</div>
  </div>`;
}

/* ---------- ações ---------- */
export const acoesFornecedores = {
  async fornNovo() { const s = await formularioFornecedor(); if (s) location.hash = `#/fornecedores/${s.id}`; },
  fornAbrir(d) { location.hash = `#/fornecedores/${d.id}`; },
  async fornEditar(d) { await formularioFornecedor(fornecedorPorId(d.id)); },
  async fornStatus(d) {
    const s = fornecedorPorId(d.id);
    const novo = s.status === 'ativo' ? 'inativo' : 'ativo';
    if (novo === 'inativo' && !(await ask(`Inativar ${s.trade_name}? Ele deixa de aparecer nas buscas e escolhas, mas o histórico e os documentos continuam guardados.`, 'Inativar'))) return;
    const c = await sb();
    ok(await c.from('suppliers').update({ status: novo }).eq('id', s.id), 'fornecedor');
    await carregarFornecedores(true);
    toast(novo === 'inativo' ? 'Fornecedor inativado.' : 'Fornecedor reativado.');
  },
  async fornAvaliar(d) { await formularioAvaliacao(fornecedorPorId(d.id)); },
  async fornDocumento(d) { await formularioDocumento(fornecedorPorId(d.id)); },
  async fornDocAbrir(d) {
    const url = await urlTemporaria(d.path, 300);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) info('Abrir documento', `<p><a href="${esc(url)}" target="_blank" rel="noopener">Clique para abrir ${esc(d.nome)}</a> (link válido por 5 minutos).</p>`);
  },
  async fornDocRemover(d) {
    if (!(await ask('Remover este documento da ficha? (fica registrado no histórico de alterações)', 'Remover'))) return;
    const c = await sb();
    ok(await c.from('supplier_documents').update({ deleted_at: new Date().toISOString() }).eq('id', d.id), 'documento');
    await carregarFicha(d.forn, true);
  },
  async catFornCriar() {
    const el = document.getElementById('catFornNova'); const nome = el.value.trim();
    if (nome.length < 2) return toast('Digite o nome da categoria.');
    const c = await sb();
    const r = await c.from('supplier_categories').insert({ org_id: nuvem.contexto().orgId, name: nome, position: F.categorias.length + 1 });
    if (r.error) throw /duplicate|unique/i.test(r.error.message) ? new Error('Já existe uma categoria com esse nome.') : erroBanco(r.error);
    el.value = ''; await carregarFornecedores(true);
  },
  async catFornRenomear(d) {
    const cat = F.categorias.find((x) => x.id === d.id);
    const v = await formDialog({ title: 'Renomear categoria', ok: 'Salvar', fields: [{ name: 'nome', label: 'Nome', required: true, value: cat.name }] });
    const nome = v?.nome;
    if (!nome || nome.trim() === cat.name) return;
    const c = await sb();
    ok(await c.from('supplier_categories').update({ name: nome.trim() }).eq('id', d.id), 'categoria');
    await carregarFornecedores(true);
  },
  async catFornAtivar(d) {
    const cat = F.categorias.find((x) => x.id === d.id);
    const c = await sb();
    ok(await c.from('supplier_categories').update({ active: !cat.active }).eq('id', d.id), 'categoria');
    await carregarFornecedores(true);
  },
};
export const entradasFornecedores = { fornBusca(el) { ui.fornBusca = el.value; queueRender(); } };
export const mudancasFornecedores = {
  fornCategoria(d, el) { ui.fornCategoria = el.value; queueRender(); },
  fornCidade(d, el) { ui.fornCidade = el.value; queueRender(); },
  fornStatus(d, el) { ui.fornStatus = el.value; queueRender(); },
};
export function limparFornecedores() { Object.assign(F, { carregado: false, carregando: false, erro: '', lista: [], categorias: [], secundarias: new Map(), fichas: new Map() }); }

/** Datalist com os fornecedores ativos (usado nos formulários do Financeiro). */
export function datalistFornecedores() {
  if (!disponivel()) return '';
  if (!F.carregado && !F.carregando) setTimeout(() => carregarFornecedores());
  return `<datalist id="lista-fornecedores">${fornecedoresAtivos().map((s) => `<option value="${esc(s.trade_name)}">`).join('')}</datalist>`;
}
/** Id do fornecedor cadastrado com este nome (ou null). */
export function idDoFornecedorPorNome(nome) {
  const n = normalizar(nome).trim();
  if (!n) return null;
  return F.lista.find((s) => normalizar(s.trade_name).trim() === n)?.id || null;
}
