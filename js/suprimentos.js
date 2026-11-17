// Suprimentos (modo nuvem): quadro de compras em colunas e pedido principal com grupos de materiais. Cada grupo
// (madeira, tijolos, cimento…) tem itens, cotações, compra, previsão e entregas próprios; a situação do pedido é
// calculada pelo banco a partir dos grupos (migração 0007) — a tela só mostra e explica. Lê e grava direto no banco;
// liberações por pessoa e regras são conferidas pelo servidor. A compra de cada grupo vira um compromisso no
// Financeiro da obra (com a fase), que chega às obras pela sincronização normal.
import * as store from './store.js';
import { esc, I, ui, toast, ask, info, formDialog, queueRender, parseNum, fmtIn } from './ui.js';
import { fmtBRL, isoBR, todayISO } from './schedule.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { enviarArquivo, urlTemporaria, ACCEPT, tamanhoLegivel, validarArquivo, TAMANHO_MAX_OBRA, TIPOS_ACEITOS } from './nuvem/arquivos.js';
import { liberado, pode } from './permissoes.js';
import { formularioTransferencia } from './estoque.js';
import { obraEmFoco, ir } from './escopo.js';
import { datalistFornecedores, idDoFornecedorPorNome, carregarFornecedores, categoriasFornecedor } from './fornecedores.js';
import {
  STATUS_GRUPO, STATUS_PEDIDO, COLUNAS, PASSAGENS_MANUAIS, OCORRENCIAS, etapaGrupo, numeroPedido, comparativoCotacoes,
  recebidoPorItem, itensComSaldo, pendenciasPedido, resumoPedido, filtrarPedidos, validarItens, painelPorObra,
  codigoOC, agruparPorTipo, conferirDocumentos, somaPrecos,
} from './suprimentosRegras.js';

const vazio = () => ({ carregado: false, carregando: false, erro: '', em: 0, pedidos: [], grupos: new Map(), itens: new Map(),
  cotacoes: new Map(), entregas: new Map(), entregasLista: [], itensEntrega: [], recebido: new Map(), eventos: new Map(), arquivos: new Map(), docs: new Map() });
const S = vazio();
const UNIDADES = ['un', 'pç', 'sc', 'kg', 't', 'm', 'm²', 'm³', 'l', 'cx', 'barra', 'dz', 'lata', 'galão', 'rolo', 'milheiro', 'jogo', 'vb'];
// "grupos" no banco = ORDENS DE COMPRA na tela (uma por fornecedor, com letra fixa: PED-0012-A)
const ABAS = [['resumo', 'Resumo'], ['grupos', 'Itens e ordens de compra'], ['compras', 'Cotações, compras e notas'], ['entregas', 'Entregas'], ['historico', 'Histórico e comentários']];
const TIPOS_DOC = { nota_fiscal: 'Nota fiscal', pedido_fornecedor: 'Pedido do fornecedor', recibo: 'Recibo' };
const oc = (p, g) => codigoOC(p.number, g.letter);
const rotOC = (p, g) => `<span class="badge info" title="Ordem de compra">${esc(oc(p, g))}</span> <b>${esc(g.name)}</b>`;
const docsDe = (gid) => (S.docs.get(gid) || []).filter((d) => !d.deleted_at);
const abertas = (gs) => gs.filter((g) => etapaGrupo(g.status) <= 2);
const seloDocs = (cf) => ({
  sem_documento: '<span class="badge warn">sem nota</span>',
  confere: `<span class="badge good">confere</span> ${fmtBRL(cf.documentos)}`,
  abaixo: `<span class="badge info">falta ${fmtBRL(-cf.diferenca)}</span>`,
  acima: `<span class="badge crit">${fmtBRL(cf.diferenca)} acima da compra</span>`,
}[cf.situacao]);
/** Quem separa os itens em ordens de compra: compras; o solicitante enquanto tudo está em análise (o banco confere). */
function podeSeparar(p, gs) {
  if (['concluido', 'cancelado'].includes(p.status)) return false;
  const ab = abertas(gs);
  if (!ab.some((g) => (S.itens.get(g.id) || []).length)) return false;
  return podeComprar() || (meu(p) && podeSolicitar() && ab.every((g) => g.status === 'analise'));
}

const ctx = () => nuvem.contexto();
const disponivel = () => nuvemConfigurada() && nuvem.ativo() && ctx()?.papel && ctx().papel !== 'cliente';
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const qtd = (n) => (n == null ? '' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 }));
const obraNome = (id) => store.obra(id)?.nome || 'obra';
const podeSolicitar = () => liberado('solicitar');
const podeComprar = () => liberado('comprar');
const podeReceber = () => liberado('receber');
const meu = (p) => p.requested_by === ctx()?.userId;
const pedidoPorId = (id) => S.pedidos.find((p) => p.id === id);
const gruposDe = (pid) => (S.grupos.get(pid) || []).slice().sort((a, b) => a.position - b.position);
const editaPedido = (p) => podeComprar() || (meu(p) && p.status === 'pedido' && podeSolicitar());
const editaGrupo = (g, p) => podeComprar() || (g.status === 'analise' && meu(p) && podeSolicitar());
const nomeCategoria = (id) => categoriasFornecedor().find((c) => c.id === id)?.name || '';
const bGrupo = (st) => `<span class="badge ${STATUS_GRUPO[st]?.cls || ''}">${esc(STATUS_GRUPO[st]?.rotulo || st)}</span>`;
const bPedido = (st) => `<span class="badge ${st === 'concluido' ? 'good' : st === 'cancelado' ? '' : st === 'em_andamento' ? 'warn' : 'info'}">${esc(STATUS_PEDIDO[st] || st)}</span>`;
const previsao = (g) => (g.expected_date ? `${isoBR(g.expected_date)} <span class="muted small">(${esc(g.expected_kind)})</span>` : '—');

/** Fase da EAP (etapa ou subetapa) pelo id. */
function nomeFase(projectId, faseId) {
  const a = (store.obra(projectId)?.eap || []).find((x) => x.id === faseId);
  return a ? `${a.codigo} ${a.descricao}` : '';
}
const fasesDaObra = (o) => (o?.eap || []).filter((a) => a.nivel <= 2 && (o.eap || []).some((x) => x.parentId === a.id));

/* ---------- dados ---------- */
export async function carregarSuprimentos(forcar = false) {
  if (!disponivel() || S.carregando || (S.carregado && !forcar)) return;
  S.carregando = true; S.erro = '';
  try {
    const ids = store.obras().map((o) => o.id);
    if (!ids.length) Object.assign(S, { pedidos: [], grupos: new Map(), itens: new Map(), cotacoes: new Map(), entregas: new Map(), entregasLista: [], itensEntrega: [], recebido: new Map(), docs: new Map() });
    else {
      const c = await sb();
      const [peds, grs, its, cots, ents, ients, docs] = await Promise.all([
        c.from('purchase_orders').select('*').in('project_id', ids).is('deleted_at', null).order('number', { ascending: false }),
        c.from('purchase_groups').select('*').in('project_id', ids).is('deleted_at', null).order('position'),
        c.from('purchase_items').select('*').in('project_id', ids).order('position'),
        c.from('purchase_quotes').select('*').in('project_id', ids).is('deleted_at', null).order('created_at'),
        c.from('purchase_deliveries').select('*').in('project_id', ids).is('deleted_at', null).order('delivery_date', { ascending: false }),
        c.from('purchase_delivery_items').select('*').in('project_id', ids),
        c.from('purchase_documents').select('*').in('project_id', ids).is('deleted_at', null).order('issue_date'),
      ]);
      S.docs = agrupar(ok(docs, 'documentos') || [], 'group_id');
      S.pedidos = ok(peds, 'pedidos') || [];
      S.grupos = agrupar(ok(grs, 'grupos') || [], 'order_id');
      S.itens = agrupar(ok(its, 'itens') || [], 'group_id');
      S.cotacoes = agrupar(ok(cots, 'cotações') || [], 'group_id');
      const entregas = ok(ents, 'entregas') || [];
      S.entregas = agrupar(entregas, 'group_id');
      S.entregasLista = entregas;
      S.itensEntrega = ok(ients, 'entregas') || [];
      S.recebido = recebidoPorItem(entregas, S.itensEntrega);
    }
    S.carregado = true; S.em = Date.now();
  } catch (e) { S.erro = e.message; }
  S.carregando = false;
  queueRender();
}
async function carregarDetalhe(pid) {
  const c = await sb();
  const [ev, arq] = await Promise.all([
    c.from('purchase_events').select('*').eq('order_id', pid).order('id', { ascending: false }),
    c.from('purchase_files').select('*').eq('order_id', pid).is('deleted_at', null).order('created_at', { ascending: false }),
  ]);
  S.eventos.set(pid, ok(ev, 'histórico') || []);
  S.arquivos.set(pid, ok(arq, 'anexos') || []);
  queueRender();
}
function agrupar(linhas, campo) {
  const m = new Map();
  for (const l of linhas) { if (!m.has(l[campo])) m.set(l[campo], []); m.get(l[campo]).push(l); }
  return m;
}
export function limparSuprimentos() { Object.assign(S, vazio()); }

/** Depois de uma ação no banco: recarrega Suprimentos e, se mudou o Financeiro, baixa as obras. */
async function depois(pid, { obras = false } = {}) {
  if (obras) {
    await nuvem.enviar().catch(() => {});
    if (!nuvem.pendente()) await nuvem.baixar().catch(() => {});
  }
  await carregarSuprimentos(true);
  if (pid) await carregarDetalhe(pid).catch(() => {});
}

/* ---------- telas ---------- */
function indisponivel() {
  return `<div class="page-head"><div><h1>Suprimentos</h1></div></div>
  <div class="card empty"><p>${!nuvemConfigurada() ? 'O quadro de compras funciona no modo nuvem (banco de dados da empresa). Este aparelho está no modo local (Google Drive). Os pedidos de compra continuam na aba Financeiro de cada obra.'
    : ctx()?.papel === 'cliente' ? 'Seu perfil não tem acesso a Suprimentos.' : 'Carregando os dados da empresa…'}</p></div>`;
}

export function viewSuprimentos(route) {
  if (!disponivel()) return indisponivel();
  // atualiza sozinho: ao abrir e quando os dados ficaram mais velhos que 1 minuto (a nuvem sincroniza a cada 2)
  if (!S.carregando && (!S.carregado || Date.now() - S.em > 60000)) setTimeout(() => carregarSuprimentos(true));
  if (!store.obras().length) return `<div class="page-head"><div><h1>Suprimentos</h1></div></div><div class="card empty"><p>Nenhuma obra visível para o seu usuário. Os pedidos de compra são sempre de uma obra.</p></div>`;
  if (!S.carregado) return `<div class="page-head"><div><h1>Suprimentos</h1></div></div><div class="card empty"><p>${S.erro ? esc(S.erro) : 'Carregando…'}</p></div>`;
  if (route.secao === 'pedido') return viewPedido(route.id, route.aba || 'resumo');
  if (route.secao === 'entregas') return viewEntregas();
  return viewQuadro();
}

/* ----- Quadro ----- */
// Dentro da página da obra, os filtros são da própria obra (a obra fica fixa); no menu geral, de todas as obras.
function filtrosQuadro() {
  const foco = obraEmFoco();
  const novo = () => ({ busca: '', obra: foco, fase: '', prioridade: '', solicitante: '', comprador: '', fornecedor: '', de: '', ate: '', cancelados: false });
  if (!foco) return ui.supF ||= novo();
  const m = ui.supFObra ||= {};
  return m[foco] ||= novo();
}
const fornecedoresDoPedido = (p) => gruposDe(p.id).map((g) => g.supplier_name).filter(Boolean);

function viewQuadro() {
  const f = filtrosQuadro();
  const hoje = todayISO();
  const lista = filtrarPedidos(S.pedidos, f, { fornecedoresDoPedido });
  const opcoes = (vals, sel, todos) => `<option value="">${todos}</option>${[...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')).map((v) => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;
  const obras = store.obras();
  const foco = obraEmFoco();
  const fases = f.obra ? fasesDaObra(store.obra(f.obra)) : [];
  const sel = (k, html, rot) => `<label class="field">${rot}<select data-chg="supFiltro" data-k="${k}">${html}</select></label>`;
  const colunas = COLUNAS.map((col) => {
    const cards = lista.filter((p) => p.stage === col.etapa);
    return `<section class="kanban-col" aria-label="${esc(col.titulo)}">
      <header><div class="row between"><b>${esc(col.titulo)}</b><span class="badge">${cards.length}</span></div><div class="muted small">${esc(col.texto)}</div></header>
      <div class="kanban-cards">${cards.map((p) => cartao(p, hoje)).join('') || '<div class="muted small kanban-vazio">Nenhum pedido.</div>'}</div></section>`;
  }).join('');
  const atrasados = lista.filter((p) => resumoPedido(p, gruposDe(p.id), hoje).atrasado).length;
  return `<div class="page-head"><div><h1>Quadro de compras</h1><div class="muted">${foco ? 'Pedidos de materiais desta obra, por etapa.' : 'Pedidos de materiais de todas as obras, por etapa.'} O pedido é uma lista de materiais; quem compra separa os itens em ordens de compra, uma por fornecedor. O pedido conclui quando todas as ordens terminam.</div></div>
    <div class="row">${podeSolicitar() ? `<button class="btn primary" data-act="supNovo">${I.plus} Novo pedido</button>` : ''}<button class="btn" data-act="supAtualizar">Atualizar</button></div></div>
  <div class="stack">
    ${S.erro ? `<div class="alert err">${esc(S.erro)}</div>` : ''}
    <details class="card card-pad filtros-sup" ${Object.entries(f).some(([k, v]) => k !== 'busca' && v) ? 'open' : ''}><summary><input data-inp="supBusca" data-key="supBusca" value="${esc(f.busca)}" placeholder="Buscar por número (PED-0001) ou nome do pedido…" style="width:min(420px,100%)" onclick="event.stopPropagation()"> <span class="muted small">Filtros</span></summary>
      <div class="grid-form" style="margin-top:10px">
        ${foco ? '' : sel('obra', `<option value="">Todas as obras</option>${obras.map((o) => `<option value="${o.id}" ${o.id === f.obra ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}`, 'Obra')}
        ${sel('fase', `<option value="">${f.obra ? 'Todas as fases' : 'Escolha a obra'}</option>${fases.map((a) => `<option value="${a.id}" ${a.id === f.fase ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}`, 'Fase')}
        ${sel('solicitante', opcoes(S.pedidos.map((p) => p.requester_label), f.solicitante, 'Todos'), 'Solicitante')}
        ${sel('comprador', opcoes(S.pedidos.map((p) => p.buyer_label), f.comprador, 'Todos'), 'Comprador')}
        ${sel('fornecedor', opcoes(S.pedidos.flatMap(fornecedoresDoPedido), f.fornecedor, 'Todos'), 'Fornecedor')}
        ${sel('prioridade', ['', 'normal', 'urgente'].map((v) => `<option value="${v}" ${v === f.prioridade ? 'selected' : ''}>${v ? (v === 'urgente' ? 'Urgente' : 'Normal') : 'Todas'}</option>`).join(''), 'Prioridade')}
        <label class="field">Criado de<input type="date" data-chg="supFiltro" data-k="de" value="${esc(f.de)}"></label>
        <label class="field">até<input type="date" data-chg="supFiltro" data-k="ate" value="${esc(f.ate)}"></label>
        <label class="check" style="align-self:end"><input type="checkbox" data-chg="supFiltro" data-k="cancelados" ${f.cancelados ? 'checked' : ''}> Mostrar cancelados</label>
      </div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="supLimparFiltros">Limpar filtros</button></div>
    </details>
    <div class="muted small">${lista.length} pedido(s)${atrasados ? ` · <b style="color:var(--crit)">${atrasados} atrasado(s)</b>` : ''}. Cada cartão fica na coluna da ordem de compra menos adiantada.</div>
    ${(foco ? S.pedidos.some((p) => p.project_id === foco) : S.pedidos.length) ? `<div class="kanban">${colunas}</div>` : `<div class="card empty"><p>Nenhum pedido de compra registrado${foco ? ' nesta obra' : ''}.</p>${podeSolicitar() ? `<button class="btn primary" data-act="supNovo">${I.plus} Fazer o primeiro</button>` : '<p class="muted small">Seu usuário não tem a liberação para solicitar materiais.</p>'}</div>`}
  </div>`;
}

function cartao(p, hoje) {
  const gs = gruposDe(p.id);
  const r = resumoPedido(p, gs, hoje);
  const fase = nomeFase(p.project_id, p.phase_id);
  return `<article class="card kcard${r.atrasado ? ' kcard-atraso' : ''}" data-act="supAbrir" data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(numeroPedido(p.number))} ${esc(p.title)}">
    <div class="row between" style="gap:6px"><b>${numeroPedido(p.number)}</b>${bPedido(p.status)}</div>
    <div class="kcard-tit">${esc(p.title)}</div>
    <div class="muted small">${esc(obraNome(p.project_id))}${fase ? ` · ${esc(fase)}` : ''}</div>
    <div class="muted small">${esc(p.requester_label || '')} · ${new Date(p.created_at).toLocaleDateString('pt-BR')}</div>
    <div class="row" style="gap:4px;flex-wrap:wrap">${p.priority === 'urgente' ? '<span class="badge crit">Urgente</span>' : ''}${r.atrasado ? `<span class="badge crit">${I.alert} Atrasado</span>` : ''}</div>
    ${gs.length ? `<div class="barra" title="${r.encerrados} de ${r.total} ordem(ns) de compra encerrada(s)"><span style="width:${r.pct}%"></span></div>
      <div class="small">${r.encerrados} de ${r.total} ordem(ns) de compra concluída(s)</div>
      <ul class="kcard-grupos">${gs.map((g) => `<li><b>${esc(g.letter || '')}</b> ${esc(g.name)}${g.supplier_name ? ` <span class="muted">(${esc(g.supplier_name)})</span>` : ''} — ${esc(STATUS_GRUPO[g.status]?.rotulo || g.status)}</li>`).join('')}</ul>`
      : '<div class="muted small">Sem itens ainda.</div>'}
    <div class="small">${r.proximaPrevisao ? `Previsão: ${isoBR(r.proximaPrevisao)}` : p.needed_date ? `Necessário em ${isoBR(p.needed_date)}` : ''}</div>
  </article>`;
}

/* ----- Pedido (uma página, com abas internas) ----- */
function viewPedido(id, aba) {
  const p = pedidoPorId(id);
  const voltar = '<a class="muted small" href="#/suprimentos">← Quadro de compras</a>';
  if (!p) return `<div class="card empty"><p>Pedido não encontrado (ou sem acesso).</p><a class="btn" href="#/suprimentos">Voltar ao quadro</a></div>`;
  if (!S.eventos.has(id)) { S.eventos.set(id, null); setTimeout(() => carregarDetalhe(id).catch((e) => toast(e.message))); }
  const gs = gruposDe(id);
  const hoje = todayISO();
  const r = resumoPedido(p, gs, hoje);
  const fase = nomeFase(p.project_id, p.phase_id);
  const corpo = { resumo: abaResumo, grupos: abaGrupos, compras: abaCompras, entregas: abaEntregas, historico: abaHistorico }[aba] || abaResumo;
  return `<div class="page-head"><div>${voltar}<h1>${numeroPedido(p.number)} — ${esc(p.title)}</h1>
      <div class="row" style="gap:6px;flex-wrap:wrap">${bPedido(p.status)}${p.priority === 'urgente' ? '<span class="badge crit">Urgente</span>' : ''}${r.atrasado ? `<span class="badge crit">${I.alert} Atrasado</span>` : ''}</div>
      <div class="muted small" style="margin-top:4px"><a href="#/obra/${p.project_id}/compras">${esc(obraNome(p.project_id))}</a>${fase ? ` · Fase: ${esc(fase)}` : ''} · Solicitante: ${esc(p.requester_label || '—')} em ${new Date(p.created_at).toLocaleDateString('pt-BR')}${p.buyer_label ? ` · Comprador: ${esc(p.buyer_label)}` : ''}</div>
      ${gs.length ? `<div class="row" style="gap:8px;margin-top:6px;align-items:center"><div class="barra" style="width:180px"><span style="width:${r.pct}%"></span></div><span class="small">${r.encerrados} de ${r.total} ordem(ns) de compra concluída(s)</span></div>` : ''}</div>
    <div class="row">${editaPedido(p) ? `<button class="btn" data-act="supEditar" data-id="${p.id}">Editar pedido</button>` : ''}
      ${podeSeparar(p, gs) ? `<button class="btn primary" data-act="supSeparar" data-id="${p.id}">Separar por fornecedor</button>` : ''}
      ${!['concluido', 'cancelado'].includes(p.status) && (podeComprar() || (meu(p) && podeSolicitar())) ? `<button class="btn" data-act="supNovoGrupo" data-id="${p.id}">${I.plus} Itens</button>` : ''}
      <button class="btn" data-act="supPendencias" data-id="${p.id}">${p.status === 'concluido' ? 'Conclusão' : 'O que falta para concluir?'}</button></div></div>
  <nav class="row abas-sup" aria-label="Seções do pedido">${ABAS.map(([k, rot]) => `<a class="btn sm ${k === aba ? 'primary' : ''}" href="#/suprimentos/pedido/${p.id}/${k}" ${k === aba ? 'aria-current="page"' : ''}>${rot}</a>`).join('')}</nav>
  <div class="stack" style="margin-top:12px">${S.erro ? `<div class="alert err">${esc(S.erro)}</div>` : ''}${corpo(p, gs, hoje)}</div>`;
}

function abaResumo(p, gs, hoje) {
  const comprados = gs.filter((g) => g.contract_id && g.status !== 'cancelado');
  const soma = (l, f) => l.reduce((a, g) => a + (Number(f(g)) || 0), 0);
  const pend = pendenciasPedido(gs, S.itens, S.recebido);
  const arqs = S.arquivos.get(p.id) || [];
  return `<div class="kpis">
      <div class="card kpi"><div class="k-label">Ordens de compra</div><div class="k-value">${gs.length}</div><div class="k-sub">${gs.filter((g) => etapaGrupo(g.status) === 4).length} encerrada(s)</div></div>
      <div class="card kpi"><div class="k-label">Valor comprado</div><div class="k-value" style="font-size:20px">${comprados.length ? fmtBRL(soma(comprados, (g) => Number(g.amount) + Number(g.freight || 0))) : '—'}</div><div class="k-sub">${comprados.length} ordem(ns) com compra · materiais + frete</div></div>
      <div class="card kpi"><div class="k-label">Frete</div><div class="k-value" style="font-size:20px">${comprados.length ? fmtBRL(soma(comprados, (g) => g.freight)) : '—'}</div></div>
      <div class="card kpi"><div class="k-label">Notas e documentos</div><div class="k-value" style="font-size:20px">${comprados.length ? fmtBRL(soma(comprados, (g) => conferirDocumentos(g, docsDe(g.id)).documentos)) : '—'}</div><div class="k-sub">${comprados.filter((g) => !docsDe(g.id).length).length} ordem(ns) comprada(s) sem documento</div></div>
    </div>
    <div class="grid-2">
      <div class="card card-pad stack"><h2>Dados do pedido</h2><div class="ficha-campos">
        <div><span class="muted small">Necessário em</span><div>${p.needed_date ? isoBR(p.needed_date) : '—'}${p.needed_date && p.needed_date < hoje && !['concluido', 'cancelado'].includes(p.status) ? ' <span class="badge crit">atrasado</span>' : ''}</div></div>
        <div><span class="muted small">Local de entrega</span><div>${esc(p.delivery_location || '—')}</div></div>
        ${p.notes ? `<div><span class="muted small">Observações</span><div>${esc(p.notes)}</div></div>` : ''}
        ${p.concluded_at ? `<div><span class="muted small">Concluído em</span><div>${new Date(p.concluded_at).toLocaleString('pt-BR')}</div></div>` : ''}
      </div></div>
      <div class="card card-pad stack"><h2>${pend.length ? 'O que falta para concluir' : 'Conclusão'}</h2>
        ${pend.length ? `<ul class="lista">${pend.map((x) => `<li><b>${esc(x.grupo)}</b>: ${esc(x.pendencia)}</li>`).join('')}</ul>`
          : gs.length ? '<div class="small">Todas as ordens de compra estão entregues e conferidas, resolvidas ou canceladas.</div>' : '<div class="muted small">Inclua os itens do pedido.</div>'}
        <div class="muted small">O pedido conclui sozinho quando todas as ordens de compra terminam — não há botão para "forçar" a conclusão.</div></div>
    </div>
    <div class="card card-pad stack"><h2>Ordens de compra</h2>${gs.length ? `<div class="table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Ordem</th><th>Etapa</th><th>Fornecedor</th><th class="num">Valor</th><th>Documentos</th><th>Previsão</th></tr></thead><tbody>
      ${gs.map((g) => { const cf = conferirDocumentos(g, docsDe(g.id)); return `<tr data-act="supIrGrupo" data-id="${p.id}" data-g="${g.id}" tabindex="0"><td>${rotOC(p, g)}<div class="muted small">${(S.itens.get(g.id) || []).length} item(ns)</div></td><td>${bGrupo(g.status)}</td><td class="small">${esc(g.supplier_name || '—')}</td>
        <td class="num nowrap">${g.amount != null ? fmtBRL(Number(g.amount) + Number(g.freight || 0)) : '—'}</td><td class="small">${g.contract_id ? seloDocs(cf) : '—'}</td><td class="small nowrap">${previsao(g)}${g.expected_date && g.expected_date < hoje && etapaGrupo(g.status) === 3 ? ' <span class="badge crit">atrasada</span>' : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="muted small">Nenhuma ordem de compra ainda.</div>'}</div>
    <div class="card card-pad stack"><div class="row between"><h2>Anexos</h2>${podeSolicitar() || podeComprar() || podeReceber() ? `<button class="btn sm" data-act="supAnexar" data-id="${p.id}">${I.upload} Anexar</button>` : ''}</div>
      ${listaArquivos(arqs, gs)}
      <div class="muted small">Fotos, especificações e comprovantes em armazenamento privado (link temporário). Até 10 MB por arquivo.</div></div>`;
}

function listaArquivos(arqs, gs) {
  if (!arqs.length) return '<div class="muted small">Nenhum anexo.</div>';
  return `<ul class="lista">${arqs.map((a) => `<li class="row between" style="gap:8px"><span><b>${esc(a.name)}</b> <span class="badge">${esc(a.kind)}</span>${a.group_id ? ` <span class="muted small">${esc(gs.find((g) => g.id === a.group_id)?.name || '')}</span>` : ''}<div class="muted small">${tamanhoLegivel(a.size_bytes)} · ${new Date(a.created_at).toLocaleDateString('pt-BR')}</div></span>
    <button class="btn sm" data-act="supArqAbrir" data-path="${esc(a.storage_path)}" data-nome="${esc(a.name)}">Abrir</button></li>`).join('')}</ul>`;
}

function itensTabela(g, editavel, sobra = false) {
  const its = itensComSaldo(S.itens.get(g.id) || [], S.recebido);
  if (!its.length) return '<div class="muted small">Sem itens.</div>';
  const comprado = etapaGrupo(g.status) >= 3;
  const comPreco = its.some((i) => i.unit_price != null);
  // sobra: material recebido que pode ir para outra obra ou para o estoque, com o custo junto
  const botaoSobra = (i) => (sobra && podeComprar() && i.recebido > 0
    ? `<button class="btn sm" data-act="supSobra" data-id="${g.order_id}" data-g="${g.id}" data-i="${i.id}" title="Mandar a sobra para outra obra ou para o estoque, com o custo junto">Transferir sobra</button>` : '');
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="num">Quantidade</th><th>Unid.</th>${comPreco ? '<th class="num">Preço unit.</th><th class="num">Total</th>' : ''}${comprado ? '<th class="num">Recebido</th><th class="num">Pendente</th>' : ''}<th>Especificação</th>${sobra ? '<th></th>' : ''}</tr></thead><tbody>
    ${its.map((i) => `<tr><td>${esc(i.description)}${i.required === false ? ' <span class="badge">opcional</span>' : ''}${i.notes ? `<div class="muted small">${esc(i.notes)}</div>` : ''}</td><td class="num">${qtd(i.quantity)}</td><td>${esc(i.unit)}</td>
      ${comPreco ? `<td class="num nowrap">${i.unit_price != null ? fmtBRL(i.unit_price) : '—'}</td><td class="num nowrap">${i.unit_price != null ? fmtBRL(Number(i.quantity) * Number(i.unit_price)) : '—'}</td>` : ''}
      ${comprado ? `<td class="num">${qtd(i.recebido)}${i.excedente ? ` <span class="badge warn">+${qtd(i.excedente)}</span>` : ''}</td><td class="num">${i.pendente ? `<b>${qtd(i.pendente)}</b>` : '<span class="badge good">ok</span>'}</td>` : ''}
      <td class="small">${esc(i.spec || '')}</td>${sobra ? `<td class="nowrap">${botaoSobra(i)}</td>` : ''}</tr>`).join('')}</tbody></table></div>${editavel ? '' : ''}`;
}

function abaGrupos(p, gs) {
  if (!gs.length) return `<div class="card empty"><p>Nenhum item neste pedido.</p>${!['concluido', 'cancelado'].includes(p.status) ? `<button class="btn primary" data-act="supNovoGrupo" data-id="${p.id}">${I.plus} Incluir itens</button>` : ''}</div>`;
  const aberto = ui.supGrupoAberto;
  const dica = podeSeparar(p, gs)
    ? `<div class="alert info small row between" style="gap:8px;flex-wrap:wrap"><span>Cada <b>ordem de compra</b> é a compra de <b>um fornecedor</b> (e terá a nota dele). Marque os itens e mande para a loja certa.</span><button class="btn sm primary" data-act="supSeparar" data-id="${p.id}">Separar por fornecedor</button></div>` : '';
  return dica + gs.map((g) => {
    const edita = editaGrupo(g, p) && etapaGrupo(g.status) <= 2;
    const passagens = podeComprar() ? (PASSAGENS_MANUAIS[g.status] || []).filter((s) => etapaGrupo(s) === etapaGrupo(g.status) || etapaGrupo(g.status) <= 2) : [];
    return `<details class="card card-pad grupo-bloco" id="g-${g.id}" ${aberto === g.id || gs.length <= 3 ? 'open' : ''}>
      <summary><span class="row between" style="gap:8px;flex-wrap:wrap"><span>${rotOC(p, g)}${g.supplier_name ? ` <span class="muted small">· ${esc(g.supplier_name)}</span>` : ''}${g.category_id && nomeCategoria(g.category_id) !== g.name ? ` <span class="muted small">· ${esc(nomeCategoria(g.category_id))}</span>` : ''}</span>${bGrupo(g.status)}</span></summary>
      <div class="stack" style="margin-top:10px">
        ${g.description ? `<div class="small">${esc(g.description)}</div>` : ''}
        ${itensTabela(g, edita)}
        ${g.notes ? `<div class="small muted">Obs.: ${esc(g.notes)}</div>` : ''}
        ${g.resolution_reason ? `<div class="alert info small">${g.status === 'cancelado' ? 'Cancelado' : 'Pendência resolvida'} por ${esc(g.resolved_label)} em ${new Date(g.resolved_at).toLocaleDateString('pt-BR')}: ${esc(g.resolution_reason)}</div>` : ''}
        <div class="row" style="gap:6px;flex-wrap:wrap">
          ${edita ? `<button class="btn sm" data-act="supEditarGrupo" data-id="${p.id}" data-g="${g.id}">Editar itens</button>` : ''}
          ${passagens.map((s) => `<button class="btn sm" data-act="supEtapa" data-id="${p.id}" data-g="${g.id}" data-s="${s}">Mover para "${esc(STATUS_GRUPO[s].rotulo)}"</button>`).join('')}
          ${podeComprar() && etapaGrupo(g.status) <= 2 ? `<a class="btn sm primary" href="#/suprimentos/pedido/${p.id}/compras">Cotar e comprar</a>` : ''}
          ${etapaGrupo(g.status) === 3 ? `<a class="btn sm primary" href="#/suprimentos/pedido/${p.id}/entregas">Entregas</a>` : ''}
          ${edita && g.status === 'analise' ? `<button class="btn sm danger" data-act="supExcluirGrupo" data-id="${p.id}" data-g="${g.id}">Excluir ordem</button>` : ''}
          ${podeComprar() && etapaGrupo(g.status) < 4 ? `<button class="btn sm danger" data-act="supEncerrar" data-id="${p.id}" data-g="${g.id}">${g.contract_id ? 'Resolver pendência / cancelar' : 'Cancelar ordem'}</button>` : ''}
        </div>
      </div></details>`;
  }).join('');
}

function abaCompras(p, gs, hoje) {
  if (!gs.length) return '<div class="card empty"><p>Inclua os grupos de materiais para cotar.</p></div>';
  return gs.map((g) => {
    const comp = comparativoCotacoes(S.cotacoes.get(g.id) || []);
    const antes = etapaGrupo(g.status) <= 2 && g.status !== 'cancelado';
    const cotar = antes && podeComprar();
    const tabela = comp.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Fornecedor</th><th class="num">Materiais</th><th class="num">Frete</th><th class="num">Total</th><th class="num">Prazo</th><th>Pagamento</th><th>Validade</th><th>Situação</th><th></th></tr></thead><tbody>
      ${comp.map((c) => `<tr${c.status === 'descartada' ? ' style="opacity:.6"' : ''}><td>${c.supplier_id ? `<a href="#/fornecedores/${c.supplier_id}">${esc(c.supplier_name)}</a>` : esc(c.supplier_name)}${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}</td>
        <td class="num nowrap">${fmtBRL(c.total_amount)}</td><td class="num nowrap">${c.freight_amount != null ? fmtBRL(c.freight_amount) : '—'}</td>
        <td class="num nowrap"><b>${fmtBRL(c.total)}</b>${c.menorValor ? '<div><span class="badge good">menor valor</span></div>' : c.acimaDoMenor ? `<div class="muted small">+${fmtBRL(c.acimaDoMenor)} (${fmtIn(c.acimaPct, 1)}%)</div>` : ''}</td>
        <td class="num nowrap">${c.lead_days != null ? `${c.lead_days} dia(s)` : '—'}${c.menorPrazo ? '<div><span class="badge info">menor prazo</span></div>' : ''}</td>
        <td class="small">${esc(c.payment_terms || '')}</td><td class="small nowrap">${c.valid_until ? `${isoBR(c.valid_until)}${c.valid_until < hoje && c.status === 'recebida' ? ' <span class="badge warn">vencida</span>' : ''}` : '—'}</td>
        <td class="small">${c.status === 'escolhida' ? '<span class="badge good">escolhida</span>' : c.status}</td>
        <td class="nowrap">${cotar && c.status === 'recebida' ? `<button class="btn sm primary" data-act="supComprar" data-id="${p.id}" data-g="${g.id}" data-q="${c.id}">Comprar desta</button> <button class="icon-btn danger" title="Excluir cotação" data-act="supExcluirCot" data-id="${p.id}" data-q="${c.id}">${I.trash}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="muted small">${antes ? 'Nenhuma cotação registrada.' : 'Compra registrada sem cotação.'}</div>`;
    const compra = g.contract_id ? `<div class="ficha-campos">
        <div><span class="muted small">Fornecedor</span><div>${g.supplier_id ? `<a href="#/fornecedores/${g.supplier_id}">${esc(g.supplier_name)}</a>` : esc(g.supplier_name)}</div></div>
        <div><span class="muted small">Valor comprado</span><div>${fmtBRL(g.amount)}${g.freight != null ? ` + frete ${fmtBRL(g.freight)}` : ''} = <b>${fmtBRL(Number(g.amount) + Number(g.freight || 0))}</b></div></div>
        ${g.quoted_amount != null ? `<div><span class="muted small">Cotação escolhida</span><div>${fmtBRL(g.quoted_amount)}</div></div>` : ''}
        <div><span class="muted small">Pagamento</span><div>${esc(g.payment_terms || '—')}</div></div>
        <div><span class="muted small">Data da compra</span><div>${g.purchase_date ? isoBR(g.purchase_date) : '—'}</div></div>
        <div><span class="muted small">Previsão de entrega</span><div>${previsao(g)}</div></div>
      </div>` : '';
    return `<div class="card card-pad stack"><div class="row between" style="gap:8px;flex-wrap:wrap"><h2 style="margin:0">${rotOC(p, g)}</h2>${bGrupo(g.status)}</div>
      ${compra}${g.contract_id ? blocoPrecos(p, g) + blocoDocumentos(p, g) : ''}${tabela}
      ${cotar ? `<div class="row" style="gap:6px"><button class="btn sm" data-act="supNovaCot" data-id="${p.id}" data-g="${g.id}">${I.plus} Registrar cotação</button><button class="btn sm" data-act="supComprar" data-id="${p.id}" data-g="${g.id}">Compra direta (sem cotação)</button></div>` : ''}
      ${!podeComprar() && antes ? '<div class="muted small">Aguardando a equipe de compras.</div>' : ''}</div>`;
  }).join('') + '<div class="muted small">Total = materiais + frete. "Menor valor" e "menor prazo" só ordenam os números informados. A compra registrada entra como compromisso no Financeiro da obra, com a fase do pedido; cotações não escolhidas não entram em custo. Cada nota fiscal (ou pedido do fornecedor) registrada vira a conta a pagar daquela compra — abate o compromisso, não soma de novo.</div>';
}

const podeDocumentar = () => podeComprar() || pode('financeiro');
function blocoPrecos(p, g) {
  const its = S.itens.get(g.id) || [];
  const sp = somaPrecos(its);
  const materiais = Number(g.amount) || 0;
  const aviso = !sp.semPreco && Math.abs(sp.soma - materiais) > 0.05 ? ` <span class="badge warn">itens somam ${fmtBRL(sp.soma)}; compra ${fmtBRL(materiais)}</span>` : '';
  return `<div class="row between small" style="gap:8px;flex-wrap:wrap"><span>${sp.semPreco === its.length ? '<span class="muted">Preço por item não informado.</span>' : `Preço por item: ${its.length - sp.semPreco} de ${its.length} item(ns), somando ${fmtBRL(sp.soma)}.${aviso}`}</span>
    ${podeComprar() && g.status !== 'cancelado' ? `<button class="btn sm" data-act="supPrecos" data-id="${p.id}" data-g="${g.id}">${sp.semPreco === its.length ? 'Informar preço por item' : 'Editar preços'}</button>` : ''}</div>`;
}
function blocoDocumentos(p, g) {
  const docs = docsDe(g.id);
  const cf = conferirDocumentos(g, docs);
  const arqs = S.arquivos.get(p.id) || [];
  return `<div class="stack" style="gap:6px"><div class="row between" style="gap:8px;flex-wrap:wrap"><b>Nota fiscal e documentos do fornecedor</b>${seloDocs(cf)}</div>
    ${docs.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Documento</th><th>Data</th><th class="num">Valor</th><th>Vencimento</th><th>Arquivo</th><th></th></tr></thead><tbody>
      ${docs.map((d) => { const a = d.file_id && arqs.find((x) => x.id === d.file_id); return `<tr><td><b>${esc(TIPOS_DOC[d.kind])} ${esc(d.number)}${d.series ? `/${esc(d.series)}` : ''}</b>${d.access_key ? `<div class="muted small" title="Chave da NF-e">${esc(d.access_key.replace(/(\d{4})/g, '$1 ').trim())}</div>` : ''}${d.notes ? `<div class="muted small">${esc(d.notes)}</div>` : ''}<div class="muted small">por ${esc(d.created_label || '—')}</div></td>
        <td class="nowrap">${isoBR(d.issue_date)}</td><td class="num nowrap">${fmtBRL(d.amount)}</td><td class="nowrap">${d.due_date ? isoBR(d.due_date) : '—'}${d.expense_id ? '<div class="muted small">conta a pagar lançada</div>' : ''}</td>
        <td>${a ? `<button class="btn sm" data-act="supArqAbrir" data-path="${esc(a.storage_path)}" data-nome="${esc(a.name)}">Abrir</button>` : d.file_id ? '<span class="muted small">anexo</span>' : '—'}</td>
        <td class="nowrap">${podeDocumentar() ? `${d.kind === 'pedido_fornecedor' ? `<button class="btn sm" data-act="supDocumento" data-id="${p.id}" data-g="${g.id}" data-sub="${d.id}" title="Chegou a nota: substitui este pedido do fornecedor (a mesma conta a pagar é atualizada)">Chegou a nota</button> ` : ''}<button class="icon-btn danger" title="Excluir documento lançado errado" data-act="supExcluirDoc" data-id="${p.id}" data-doc="${d.id}">${I.trash}</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="muted small">Nenhum documento ainda. Quando o fornecedor mandar a nota fiscal (ou só o pedido dele, ou uma foto), registre aqui.</div>'}
    ${podeDocumentar() && g.status !== 'cancelado' ? `<div><button class="btn sm primary" data-act="supDocumento" data-id="${p.id}" data-g="${g.id}">${I.plus} Registrar nota fiscal ou pedido do fornecedor</button></div>` : ''}</div>`;
}

function abaEntregas(p, gs, hoje) {
  const comprados = gs.filter((g) => g.contract_id || (S.entregas.get(g.id) || []).length);
  if (!comprados.length) return '<div class="card empty"><p>Nenhum grupo comprado ainda. As entregas aparecem aqui depois da compra.</p></div>';
  return comprados.map((g) => {
    const ents = S.entregas.get(g.id) || [];
    const receber = podeReceber() && ['comprado', 'aguardando_entrega', 'retirada', 'entrega_parcial'].includes(g.status);
    const atrasada = g.expected_date && g.expected_date < hoje && etapaGrupo(g.status) === 3;
    return `<div class="card card-pad stack"><div class="row between" style="gap:8px;flex-wrap:wrap"><h2 style="margin:0">${rotOC(p, g)} <span class="muted small">${esc(g.supplier_name)}</span></h2>${bGrupo(g.status)}</div>
      <div class="small">Previsão: ${previsao(g)}${atrasada ? ' <span class="badge crit">atrasada</span>' : ''}</div>
      ${g.status === 'retirada' || g.pickup_address ? `<div class="alert info small"><b>Retirada:</b> ${esc(g.pickup_address || 'endereço não informado')}${g.pickup_instructions ? ` — ${esc(g.pickup_instructions)}` : ''}</div>` : ''}
      ${itensTabela(g, false, true)}
      ${ents.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Data</th><th>Itens recebidos</th><th>Conferência</th><th>Nota/romaneio</th><th>Recebido por</th><th></th></tr></thead><tbody>
        ${ents.map((e) => {
          const its = S.itensEntrega.filter((x) => x.delivery_id === e.id).map((x) => { const it = (S.itens.get(g.id) || []).find((i) => i.id === x.item_id); return `${qtd(x.quantity)} ${esc(it?.unit || '')} ${esc(it?.description || '')}`; });
          const desfaz = (e.received_by === ctx()?.userId && podeReceber()) || podeComprar();
          return `<tr><td class="nowrap">${isoBR(e.delivery_date)}<div class="muted small">${e.kind === 'retirada' ? 'retirada' : 'entrega'}</div></td><td class="small">${its.join('<br>')}</td>
            <td class="small">${e.quantity_ok ? 'Conforme' : '<span class="badge warn">quantidade divergente</span>'}${e.issue !== 'nenhuma' ? `<div><span class="badge crit">${esc(OCORRENCIAS[e.issue] || e.issue)}</span></div>` : ''}${e.notes ? `<div class="muted">${esc(e.notes)}</div>` : ''}</td>
            <td class="small">${esc(e.invoice || '')}</td><td class="small">${esc(e.receiver_label || '')}</td>
            <td>${desfaz && !['cancelado', 'resolvido'].includes(g.status) ? `<button class="icon-btn danger" title="Desfazer registro lançado errado" data-act="supDesfazer" data-id="${p.id}" data-e="${e.id}">${I.trash}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="muted small">Nenhuma entrega registrada.</div>'}
      <div class="row" style="gap:6px;flex-wrap:wrap">${receber ? `<button class="btn sm primary" data-act="supReceber" data-id="${p.id}" data-g="${g.id}">Registrar entrega ou retirada</button>` : ''}
        ${podeComprar() && etapaGrupo(g.status) === 3 ? `<button class="btn sm" data-act="supPrevisao" data-id="${p.id}" data-g="${g.id}">Previsão e retirada</button>` : ''}
        ${podeComprar() && etapaGrupo(g.status) === 3 ? `<button class="btn sm danger" data-act="supEncerrar" data-id="${p.id}" data-g="${g.id}">Resolver pendência</button>` : ''}</div>
    </div>`;
  }).join('') + '<div class="muted small">O grupo fica "Entregue e conferido" quando todos os itens obrigatórios foram recebidos por completo (soma das entregas). Previsão "estimada" ou "confirmada" é informada por quem compra — o sistema não inventa datas.</div>';
}

function abaHistorico(p) {
  const ev = S.eventos.get(p.id);
  return `<div class="card card-pad stack"><h2>Comentários</h2>
      <textarea id="supComentario" rows="2" placeholder="Escreva um comentário para a equipe…" maxlength="2000"></textarea>
      <div><button class="btn sm primary" data-act="supComentar" data-id="${p.id}">Comentar</button></div></div>
    <div class="card card-pad stack"><h2>Histórico</h2>
      ${ev == null ? '<div class="muted small">Carregando…</div>' : !ev.length ? '<div class="muted small">Sem registros.</div>'
        : `<ul class="lista historico-sup">${ev.map((e) => `<li class="${e.kind === 'comentario' ? 'comentario' : ''}"><div class="small"><b>${esc(e.author_label || '—')}</b> <span class="muted">${new Date(e.created_at).toLocaleString('pt-BR')}</span>${e.kind === 'comentario' ? ' <span class="badge info">comentário</span>' : ''}</div><div>${esc(e.body)}</div></li>`).join('')}</ul>`}
      <div class="muted small">Registrado pelo banco a cada mudança (etapas, cotações, compras, previsões, entregas, cancelamentos). Não pode ser editado nem apagado.</div></div>`;
}

/* ----- Entregas: painel por obra + aguardando entrega + recebidas recentemente ----- */
const SITUACOES_ENTREGA = [['', 'Todas'], ['atrasada', 'Atrasadas'], ['aguardando', 'Aguardando entrega'], ['retirada', 'Disponível para retirada'], ['parcial', 'Entrega parcial']];
const ZERO_PAINEL = { pedidosAbertos: 0, concluidos: 0, emCompra: 0, aguardando: 0, parciais: 0, retirada: 0, atrasados: 0, proximaPrevisao: null, ultimaEntrega: null, entregas: 0 };
function somarPainel(lista) {
  const t = { ...ZERO_PAINEL };
  for (const x of lista) {
    for (const k of ['pedidosAbertos', 'concluidos', 'emCompra', 'aguardando', 'parciais', 'retirada', 'atrasados', 'entregas']) t[k] += x[k];
    if (x.proximaPrevisao && (!t.proximaPrevisao || x.proximaPrevisao < t.proximaPrevisao)) t.proximaPrevisao = x.proximaPrevisao;
    if (x.ultimaEntrega && (!t.ultimaEntrega || x.ultimaEntrega > t.ultimaEntrega)) t.ultimaEntrega = x.ultimaEntrega;
  }
  return t;
}

function viewEntregas() {
  const hoje = todayISO();
  const foco = obraEmFoco();
  const f = ui.entF ||= { obra: '', situacao: '' };
  const obraSel = foco || f.obra;
  const painel = painelPorObra({ pedidos: S.pedidos, grupos: [...S.grupos.values()].flat(), entregas: S.entregasLista, hoje });
  const t = obraSel ? (painel.get(obraSel) || ZERO_PAINEL) : somarPainel([...painel.values()]);
  const kpi = (v, rot, sub = '', cls = '') => `<div class="card kpi ${cls}"><div class="k-label">${rot}</div><div class="k-value">${v}</div>${sub ? `<div class="k-sub">${sub}</div>` : ''}</div>`;

  // grupos comprados aguardando entrega/retirada
  const casa = (g, atrasada) => ({ '': true, atrasada, aguardando: ['comprado', 'aguardando_entrega'].includes(g.status), retirada: g.status === 'retirada', parcial: g.status === 'entrega_parcial' }[f.situacao]);
  const linhas = [];
  for (const p of S.pedidos) {
    if (obraSel && p.project_id !== obraSel) continue;
    for (const g of gruposDe(p.id)) {
      if (etapaGrupo(g.status) !== 3) continue;
      const atrasada = !!(g.expected_date && g.expected_date < hoje);
      if (casa(g, atrasada)) linhas.push({ p, g, atrasada });
    }
  }
  linhas.sort((a, b) => Number(b.atrasada) - Number(a.atrasada) || String(a.g.expected_date || '9999').localeCompare(String(b.g.expected_date || '9999')));

  // entregas e retiradas registradas (as mais recentes primeiro)
  const grupoPorId = new Map([...S.grupos.values()].flat().map((g) => [g.id, g]));
  const recebidas = S.entregasLista.filter((e) => !obraSel || e.project_id === obraSel).slice(0, 12);

  // painel por obra (só no menu geral, sem obra escolhida): uma coluna/cartão por obra, as com atraso primeiro
  const obras = store.obras().map((o) => ({ o, n: painel.get(o.id) || ZERO_PAINEL }))
    .sort((a, b) => b.n.atrasados - a.n.atrasados || b.n.aguardando - a.n.aguardando || b.n.pedidosAbertos - a.n.pedidosAbertos || a.o.nome.localeCompare(b.o.nome, 'pt-BR'));
  const linhaN = (rot, v, cls = '') => `<div class="row between small"><span class="muted">${rot}</span><b class="${cls}">${v}</b></div>`;
  const cartaoObra = ({ o, n }) => `<a class="card obra-card stack painel-obra" href="#/obra/${o.id}/entregas" style="gap:4px">
      <div class="row between"><b>${esc(o.nome)}</b>${n.atrasados ? `<span class="badge crit">${n.atrasados} atrasado(s)</span>` : n.aguardando ? '<span class="badge warn">aguardando</span>' : ''}</div>
      ${linhaN('Pedidos em aberto', n.pedidosAbertos)}${linhaN('Grupos em compra (análise/cotação)', n.emCompra)}
      ${linhaN('Aguardando entrega ou retirada', n.aguardando, n.aguardando ? 'warn-ink' : '')}${n.parciais ? linhaN('— com entrega parcial', n.parciais) : ''}
      ${linhaN('Pedidos concluídos', n.concluidos)}
      <div class="muted small">${n.proximaPrevisao ? `Próxima previsão: ${isoBR(n.proximaPrevisao)}` : 'Sem previsão pendente'} · ${n.ultimaEntrega ? `última entrega ${isoBR(n.ultimaEntrega)}` : 'nenhuma entrega'}</div></a>`;

  return `<div class="page-head"><div><h1>Entregas e recebimentos</h1><div class="muted">${foco ? 'Acompanhamento dos pedidos desta obra' : 'Acompanhamento dos pedidos por obra'}: o que está em compra, o que aguarda entrega ou retirada (atrasada = previsão anterior a hoje) e o que já chegou.</div></div>
    <div class="row"><button class="btn" data-act="supAtualizar">Atualizar</button></div></div>
  <div class="stack">
    <div class="kpis kpis-5">
      ${kpi(t.pedidosAbertos, 'Pedidos em aberto', `${t.concluidos} concluído(s)`)}
      ${kpi(t.emCompra, 'Grupos em compra', 'análise ou cotação')}
      ${kpi(t.aguardando, 'Aguardando entrega', t.proximaPrevisao ? `próxima: ${isoBR(t.proximaPrevisao)}` : 'sem previsão pendente')}
      ${kpi(t.atrasados, 'Atrasados', t.parciais ? `${t.parciais} com entrega parcial` : '', t.atrasados ? 'kpi-alerta' : '')}
      ${kpi(t.entregas, 'Entregas registradas', t.ultimaEntrega ? `última: ${isoBR(t.ultimaEntrega)}` : '')}
    </div>
    ${foco ? '' : `<div class="row between"><h2 style="margin:0">Por obra</h2>${f.obra ? `<button class="btn sm" data-act="entObra" data-id="">Ver todas as obras</button>` : ''}</div>
    ${f.obra ? '' : obras.length ? `<div class="obras-grid">${obras.map(cartaoObra).join('')}</div>` : '<div class="card empty"><p>Nenhuma obra.</p></div>'}`}
    <div class="row between" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Aguardando entrega ou retirada</h2>
      <div class="row" style="gap:8px">${foco ? '' : `<select data-chg="entFiltro" data-k="obra" style="width:auto"><option value="">Todas as obras</option>${store.obras().map((o) => `<option value="${o.id}" ${o.id === f.obra ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select>`}
        <select data-chg="entFiltro" data-k="situacao" style="width:auto">${SITUACOES_ENTREGA.map(([k, r]) => `<option value="${k}" ${k === f.situacao ? 'selected' : ''}>${r}</option>`).join('')}</select></div></div>
    ${linhas.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Pedido</th><th>Grupo</th>${obraSel ? '' : '<th>Obra</th>'}<th>Fornecedor</th><th>Previsão</th><th>Etapa</th><th></th></tr></thead><tbody>
    ${linhas.map(({ p, g, atrasada }) => `<tr><td class="nowrap"><a href="#/suprimentos/pedido/${p.id}/entregas">${numeroPedido(p.number)}</a><div class="muted small">${esc(p.title)}</div></td><td><b>${esc(g.name)}</b></td>
      ${obraSel ? '' : `<td class="small"><a href="#/obra/${p.project_id}/entregas">${esc(obraNome(p.project_id))}</a></td>`}<td class="small">${esc(g.supplier_name)}</td><td class="small nowrap">${previsao(g)}${atrasada ? ' <span class="badge crit">atrasada</span>' : ''}</td><td>${bGrupo(g.status)}</td>
      <td>${podeReceber() ? `<button class="btn sm primary" data-act="supReceber" data-id="${p.id}" data-g="${g.id}">Registrar</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : `<div class="card empty"><p>Nenhum grupo ${f.situacao ? 'nesta situação' : 'aguardando entrega'}.</p></div>`}
    <h2 style="margin:0">Recebidas recentemente</h2>
    ${recebidas.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Data</th><th>Pedido · grupo</th>${obraSel ? '' : '<th>Obra</th>'}<th>Fornecedor</th><th>Conferência</th><th>Recebido por</th></tr></thead><tbody>
      ${recebidas.map((e) => { const g = grupoPorId.get(e.group_id); const p = g && pedidoPorId(g.order_id);
        return `<tr><td class="nowrap">${isoBR(e.delivery_date)}<div class="muted small">${e.kind === 'retirada' ? 'retirada' : 'entrega'}</div></td>
          <td class="small">${p ? `<a href="#/suprimentos/pedido/${p.id}/entregas">${numeroPedido(p.number)}</a> · ` : ''}${esc(g?.name || '')}</td>${obraSel ? '' : `<td class="small">${esc(obraNome(e.project_id))}</td>`}
          <td class="small">${esc(g?.supplier_name || '')}</td>
          <td class="small">${e.quantity_ok ? 'Conforme' : '<span class="badge warn">quantidade divergente</span>'}${e.issue && e.issue !== 'nenhuma' ? ` <span class="badge crit">${esc(OCORRENCIAS[e.issue] || e.issue)}</span>` : ''}</td>
          <td class="small">${esc(e.receiver_label || '')}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="card empty"><p>Nenhuma entrega registrada.</p></div>'}
  ${!podeReceber() ? '<div class="muted small">Seu usuário não tem a liberação para registrar entregas.</div>' : ''}</div>`;
}

/* ---------- formulários ---------- */
function janela(titulo, corpo, okRot = 'Salvar') {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>${esc(titulo)}</h2><div class="stack" style="margin-top:12px">${corpo}</div>
    <div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${esc(okRot)}</button></div></form>`;
  const form = dlg.querySelector('form');
  return { dlg, form, erro: (m) => { const e = form.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; if (m) e.scrollIntoView({ block: 'nearest' }); } };
}
function abrir({ dlg, form, erro }, salvar) {
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[value=ok]'); btn.disabled = true; erro('');
      try { const v = await salvar(Object.fromEntries(new FormData(form))); if (v !== undefined) finish(v); else btn.disabled = false; }
      catch (err) { btn.disabled = false; erro(err.message); }
    };
    dlg.showModal();
    form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')?.focus();
  });
}

// comTipo: coluna "Tipo" (categoria do fornecedor, opcional) — só no pedido novo, para já separar por loja
const linhaItem = (it = {}, comTipo = false) => `<tr class="item-linha"><td><input class="i-desc" value="${esc(it.description || '')}" placeholder="ex.: Cimento CP-II 50 kg" maxlength="300"></td>
  <td><input class="i-qtd" inputmode="decimal" value="${it.quantity != null ? fmtIn(it.quantity, 4) : ''}" style="width:80px"></td>
  <td><input class="i-un" list="lista-unidades" value="${esc(it.unit || '')}" style="width:70px" maxlength="20"></td>
  ${comTipo ? `<td><select class="i-tipo" title="Opcional: itens do mesmo tipo vão para a mesma ordem de compra">${opcoesCategoria('').replace('<option value="">—</option>', '<option value="">(sem tipo)</option>')}</select></td>` : ''}
  <td><input class="i-spec" value="${esc(it.spec || '')}" placeholder="opcional"></td></tr>`;
const tabelaItens = (itens, comTipo = false, minimo = 3) => `<div class="table-wrap"><table class="data itens-sol" data-tipo="${comTipo ? 1 : 0}"><thead><tr><th>Material</th><th>Qtd.</th><th>Unid.</th>${comTipo ? '<th>Tipo (opcional)</th>' : ''}<th>Especificação</th></tr></thead>
  <tbody>${[...itens, ...Array(Math.max(1, minimo - itens.length)).fill({})].map((it) => linhaItem(it, comTipo)).join('')}</tbody></table></div>
  <div><button type="button" class="btn sm" data-mais-item>${I.plus} Mais linhas</button></div>`;
const opcoesCategoria = (sel) => `<option value="">—</option>${categoriasFornecedor().filter((c) => c.active || c.id === sel).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
const blocoGrupo = (g = {}, itens = []) => `<fieldset class="grupo-form"><legend>Ordem de compra</legend>
  <div class="grid-form"><label class="field">Nome *<input class="g-nome" value="${esc(g.name || '')}" maxlength="80" placeholder="ex.: Madeira, Tijolos, Cimento e conexões"></label>
  <label class="field">Categoria<select class="g-cat">${opcoesCategoria(g.category_id)}</select></label></div>
  <label class="field">Descrição / observações do grupo<input class="g-desc" value="${esc(g.description || '')}"></label>
  ${tabelaItens(itens)}</fieldset>`;
const listaUnidades = `<datalist id="lista-unidades">${UNIDADES.map((u) => `<option value="${u}">`).join('')}</datalist>`;

function lerItens(raiz) {
  const brutos = [...raiz.querySelectorAll('.item-linha')].map((tr) => ({
    description: tr.querySelector('.i-desc').value, quantity: tr.querySelector('.i-qtd').value.trim() === '' ? '' : parseNum(tr.querySelector('.i-qtd').value),
    unit: tr.querySelector('.i-un').value, spec: tr.querySelector('.i-spec').value,
    ...(tr.querySelector('.i-tipo') ? { tipo: tr.querySelector('.i-tipo').value } : {}),
  }));
  return validarItens(brutos);
}
function ligarItens(form) {
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mais-item]');
    if (b) {
      const t = b.closest('fieldset, .stack, form').querySelector('.itens-sol');
      t.querySelector('tbody').insertAdjacentHTML('beforeend', Array(3).fill(0).map(() => linhaItem({}, t.dataset.tipo === '1')).join(''));
      return;
    }
    if (e.target.closest('[data-mais-grupo]')) form.querySelector('.grupos-form').insertAdjacentHTML('beforeend', blocoGrupo());
  });
}
const opcoesFase = (o, sel) => {
  const fs = fasesDaObra(o);
  return fs.length ? `<option value="">— escolha a fase —</option>${fs.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${a.nivel > 1 ? '  ' : ''}${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}`
    : '<option value="">(a obra ainda não tem EAP)</option>';
};
// Sem EAP não há fases para o pedido: avisa e leva à montagem da EAP da obra.
const avisoEap = (o) => (o && !fasesDaObra(o).length
  ? `<div class="alert warn small">A obra <b>${esc(o.nome)}</b> ainda não tem EAP — o pedido fica sem fase (e o custo não entra por etapa). <a href="#/obra/${o.id}/atividades" onclick="document.getElementById('dlg').close()">Montar a EAP da obra</a></div>` : '');

async function formularioPedido(p = null) {
  await carregarFornecedores().catch(() => {});
  const obras = store.obras();
  let ultima = ''; try { ultima = localStorage.getItem('planobras:ultimaObra') || ''; } catch {}
  const obraIni = p?.project_id || filtrosQuadro().obra || (obras.some((o) => o.id === ultima) ? ultima : obras[0]?.id);
  // pedido novo: só o essencial à vista (obra, fase, quando precisa e a lista); o resto em "mais detalhes"
  const corpo = `<div class="grid-form">
      <label class="field">Obra *<select name="project_id" ${p ? 'disabled' : ''}>${obras.map((o) => `<option value="${o.id}" ${o.id === obraIni ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select></label>
      <label class="field">Fase da obra<select name="phase_id">${opcoesFase(store.obra(obraIni), p?.phase_id)}</select></label>
      <label class="field">Necessário em<input type="date" name="needed_date" value="${esc(p?.needed_date || '')}"></label>
      <label class="field">Prioridade<select name="priority"><option value="normal">Normal</option><option value="urgente" ${p?.priority === 'urgente' ? 'selected' : ''}>Urgente</option></select></label>
    </div>
    <div data-aviso-eap>${p ? '' : avisoEap(store.obra(obraIni))}</div>
    ${p ? '' : `<div class="stack" style="gap:6px"><b>Materiais</b>${tabelaItens([], true, 6)}
      <div class="muted small">Só material, quantidade e unidade já bastam. O <b>tipo</b> é opcional: itens do mesmo tipo já vão juntos para uma ordem de compra; o resto, quem compra separa por fornecedor depois.</div></div>${listaUnidades}`}
    <details ${p ? 'open' : ''}><summary class="small">Mais detalhes (nome do pedido, local de entrega, observações)</summary><div class="stack" style="margin-top:8px">
      <div class="grid-form">
        <label class="field">Nome do pedido<input name="title" maxlength="160" value="${esc(p?.title || '')}" placeholder="vazio = os primeiros materiais da lista"></label>
        <label class="field">Local de entrega<input name="delivery_location" value="${esc(p?.delivery_location || '')}" placeholder="ex.: canteiro, portão 2"></label>
        ${p && podeComprar() ? `<label class="field">Comprador responsável<input name="buyer_label" value="${esc(p.buyer_label || '')}"></label>` : ''}
      </div>
      <label class="field">Observações<textarea name="notes" rows="2">${esc(p?.notes || '')}</textarea></label></div></details>
    ${p ? '' : `<div class="muted small">Solicitante: ${esc(ctx().email)}.</div>`}`;
  const j = janela(p ? `Editar ${numeroPedido(p.number)}` : 'Novo pedido de compra', corpo, p ? 'Salvar' : 'Criar pedido');
  ligarItens(j.form);
  j.form.project_id.onchange = () => {
    const o = store.obra(j.form.project_id.value);
    j.form.phase_id.innerHTML = opcoesFase(o, '');
    j.form.querySelector('[data-aviso-eap]').innerHTML = avisoEap(o);
  };
  return abrir(j, async (v) => {
    const projeto = p?.project_id || v.project_id;
    if (!v.phase_id && fasesDaObra(store.obra(projeto)).length) throw new Error('Escolha a fase da obra (usada para acompanhar os custos por etapa).');
    let grupos = [], nomes = [];
    if (!p) {
      const r = lerItens(j.form);
      if (r.erro) throw new Error(r.erro);
      nomes = r.itens.map((i) => i.description);   // na ordem digitada
      grupos = agruparPorTipo(r.itens, nomeCategoria);
    }
    let titulo = (v.title || '').trim();
    if (!titulo && p) throw new Error('Informe o nome do pedido.');
    if (!titulo) {
      titulo = `${nomes.slice(0, 3).join(', ')}${nomes.length > 3 ? ` e mais ${nomes.length - 3}` : ''}`.slice(0, 160);
    }
    if (titulo.length < 2) throw new Error('Informe o nome do pedido.');
    const dados = { title: titulo, phase_id: v.phase_id || null, priority: v.priority, needed_date: v.needed_date || null,
      delivery_location: (v.delivery_location || '').trim(), notes: (v.notes || '').trim(), ...(p && podeComprar() ? { buyer_label: (v.buyer_label || '').trim() } : {}) };
    const c = await sb();
    if (p) {
      ok(await c.from('purchase_orders').update(dados).eq('id', p.id), 'pedido');
      await depois(p.id);
      toast('Pedido atualizado.');
      return p;
    }
    const novo = ok(await c.from('purchase_orders').insert({ ...dados, project_id: projeto, requested_by: ctx().userId }).select().single(), 'pedido');
    for (const [i, g] of grupos.entries()) await criarGrupo(c, novo, g, i);
    await depois(novo.id);
    toast(`${numeroPedido(novo.number)} criado.`);
    return novo;
  });
}

async function criarGrupo(c, p, g, posicao) {
  const gr = ok(await c.from('purchase_groups').insert({ order_id: p.id, project_id: p.project_id, name: g.name, category_id: g.category_id,
    description: g.description || '', position: posicao }).select().single(), 'grupo');
  ok(await c.from('purchase_items').insert(g.itens.map((it, i) => ({ ...it, position: i, group_id: gr.id, project_id: p.project_id }))), 'itens');
  return gr;
}

async function formularioGrupo(p, g = null) {
  await carregarFornecedores().catch(() => {});
  const itens = g ? (S.itens.get(g.id) || []) : [];
  const corpo = `${blocoGrupo(g || {}, itens)}<label class="field">Observações<input name="notes" value="${esc(g?.notes || '')}"></label>${listaUnidades}`;
  const j = janela(g ? `Editar itens — ${oc(p, g)} ${g.name}` : `Mais itens — nova ordem de compra em ${numeroPedido(p.number)}`, corpo);
  ligarItens(j.form);
  return abrir(j, async (v) => {
    const fs = j.form.querySelector('.grupo-form');
    const nome = fs.querySelector('.g-nome').value.trim();
    if (!nome) throw new Error('Informe o nome da ordem de compra.');
    const r = lerItens(fs);
    if (r.erro) throw new Error(r.erro);
    const c = await sb();
    const dados = { name: nome, category_id: fs.querySelector('.g-cat').value || null, description: fs.querySelector('.g-desc').value.trim(), notes: (v.notes || '').trim() };
    if (!g) {
      const pos = Math.max(-1, ...gruposDe(p.id).map((x) => x.position)) + 1;
      await criarGrupo(c, p, { ...dados, itens: r.itens }, pos);
      ui.supGrupoAberto = null;
    } else {
      ok(await c.from('purchase_groups').update(dados).eq('id', g.id), 'grupo');
      // itens: atualiza os que continuam (mantém o id e o histórico de quantidade), inclui novos, remove os retirados
      const atuais = S.itens.get(g.id) || [];
      for (const [i, it] of r.itens.entries()) {
        const ex = atuais[i];
        if (ex) ok(await c.from('purchase_items').update({ ...it, position: i }).eq('id', ex.id), 'itens');
        else ok(await c.from('purchase_items').insert({ ...it, position: i, group_id: g.id, project_id: g.project_id }), 'itens');
      }
      for (const ex of atuais.slice(r.itens.length)) ok(await c.from('purchase_items').delete().eq('id', ex.id), 'itens');
      ui.supGrupoAberto = g.id;
    }
    await depois(p.id);
    toast(g ? 'Itens atualizados.' : 'Itens incluídos.');
    return true;
  });
}

function formularioCotacao(p, g) {
  setTimeout(() => carregarFornecedores());
  const corpo = `<p class="muted small" style="margin:0">${numeroPedido(p.number)} · grupo <b>${esc(g.name)}</b></p>
    <div class="grid-form">
      <label class="field">Fornecedor *<input name="fornecedor" list="lista-fornecedores" maxlength="160" placeholder="nome do fornecedor"></label>
      <label class="field">Valor dos materiais (R$) *<input name="total" inputmode="decimal"></label>
      <label class="field">Frete (R$)<input name="frete" inputmode="decimal" placeholder="vazio = não informado"></label>
      <label class="field">Prazo de entrega (dias)<input name="prazo" inputmode="numeric"></label>
      <label class="field">Condições de pagamento<input name="pagamento" placeholder="ex.: 28 dias"></label>
      <label class="field">Validade da proposta<input type="date" name="validade"></label>
    </div>
    <label class="field">Observações<input name="obs" placeholder="ex.: marca, itens não cotados"></label>${datalistFornecedores()}`;
  return abrir(janela('Registrar cotação', corpo), async (v) => {
    const nome = (v.fornecedor || '').trim();
    if (nome.length < 2) throw new Error('Informe o fornecedor.');
    const total = parseNum(v.total);
    if (total == null || !(total >= 0)) throw new Error('Informe o valor dos materiais.');
    const frete = v.frete.trim() ? parseNum(v.frete) : null;
    if (frete != null && !(frete >= 0)) throw new Error('Frete inválido.');
    const prazo = v.prazo.trim() ? Number(v.prazo) : null;
    if (prazo != null && !(Number.isInteger(prazo) && prazo >= 0)) throw new Error('O prazo deve ser um número inteiro de dias.');
    await carregarFornecedores();
    const c = await sb();
    ok(await c.from('purchase_quotes').insert({ group_id: g.id, project_id: g.project_id, supplier_id: idDoFornecedorPorNome(nome), supplier_name: nome,
      total_amount: total, freight_amount: frete, lead_days: prazo, payment_terms: v.pagamento.trim(), valid_until: v.validade || null,
      notes: v.obs.trim(), created_by: ctx().userId }), 'cotação');
    await depois(p.id);
    toast('Cotação registrada.');
    return true;
  });
}

function formularioCompra(p, g, cot = null) {
  setTimeout(() => carregarFornecedores());
  const total = cot ? (Number(cot.total_amount) || 0) + (Number(cot.freight_amount) || 0) : 0;
  const corpo = `<p class="muted small" style="margin:0">${numeroPedido(p.number)} · grupo <b>${esc(g.name)}</b>. A compra entra como compromisso "Aprovado" no Financeiro de ${esc(obraNome(p.project_id))}${p.phase_id ? ', na fase do pedido' : ''} — sem etapa de aprovação.</p>
    ${cot ? `<div class="alert info small">Cotação de <b>${esc(cot.supplier_name)}</b>: ${fmtBRL(cot.total_amount)}${cot.freight_amount != null ? ` + frete ${fmtBRL(cot.freight_amount)}` : ''} = <b>${fmtBRL(total)}</b>. As outras cotações do grupo ficam como descartadas.</div>`
      : `<div class="grid-form">
        <label class="field">Fornecedor *<input name="fornecedor" list="lista-fornecedores" maxlength="160"></label>
        <label class="field">Valor dos materiais (R$) *<input name="valor" inputmode="decimal"></label>
        <label class="field">Frete (R$)<input name="frete" inputmode="decimal"></label></div>${datalistFornecedores()}`}
    <div class="grid-form">
      <label class="field">Condições de pagamento<input name="pagamento" value="${esc(cot?.payment_terms || '')}"></label>
      <label class="field">Data da compra<input type="date" name="data" value="${todayISO()}" max="${todayISO()}"></label>
      <label class="field">Previsão de entrega<input type="date" name="previsao"></label>
      <label class="field">A previsão é<select name="tipo"><option value="estimada">Estimada</option><option value="confirmada">Confirmada pelo fornecedor</option></select></label>
    </div>
    <details><summary class="small">Preço de cada item (opcional — ajuda a comparar fornecedores depois)</summary>${tabelaPrecos(g)}</details>`;
  const jc = janela('Registrar compra', corpo, 'Registrar compra');
  ligarSomaPrecos(jc.form);
  return abrir(jc, async (v) => {
    const precos = lerPrecos(jc.form);
    const args = { p_group: g.id, p_quote: cot?.id || null, p_payment_terms: (v.pagamento || '').trim(), p_purchase_date: v.data || null,
      p_expected_date: v.previsao || null, p_expected_kind: v.tipo };
    if (!cot) {
      const nome = (v.fornecedor || '').trim();
      if (nome.length < 2) throw new Error('Informe o fornecedor.');
      const valor = parseNum(v.valor);
      if (valor == null || !(valor >= 0)) throw new Error('Informe o valor da compra.');
      const frete = v.frete.trim() ? parseNum(v.frete) : null;
      if (frete != null && !(frete >= 0)) throw new Error('Frete inválido.');
      await carregarFornecedores();
      Object.assign(args, { p_supplier_name: nome, p_supplier_id: idDoFornecedorPorNome(nome), p_amount: valor, p_freight: frete });
    }
    const c = await sb();
    ok(await c.rpc('registrar_compra_grupo', args), 'compra');
    let semPreco = false;
    if (precos.some((x) => x.unit_price != null)) {
      try { ok(await c.rpc('definir_precos_itens', { p_group: g.id, p_precos: precos }), 'preços'); } catch { semPreco = true; }
    }
    await depois(p.id, { obras: true });
    toast(semPreco ? `Compra de "${g.name}" registrada, mas os preços por item não foram salvos. Use "Informar preço por item".` : `Compra de "${g.name}" registrada.`, semPreco ? 7000 : 3200);
    return true;
  });
}

/* ----- preço por item ----- */
function tabelaPrecos(g) {
  const its = S.itens.get(g.id) || [];
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="num">Qtd.</th><th>Preço unitário (R$)</th></tr></thead><tbody>
    ${its.map((i) => `<tr><td>${esc(i.description)}</td><td class="num nowrap">${qtd(i.quantity)} ${esc(i.unit)}</td>
      <td><input class="p-preco" data-item="${i.id}" data-q="${i.quantity}" inputmode="decimal" style="width:120px" value="${i.unit_price != null ? fmtIn(i.unit_price, 2) : ''}"></td></tr>`).join('')}
    </tbody></table></div><div class="muted small" data-soma-precos></div>`;
}
function lerPrecos(raiz) {
  return [...raiz.querySelectorAll('.p-preco')].map((inp) => {
    const v = inp.value.trim();
    const n = v === '' ? null : parseNum(v);
    if (v !== '' && !(n >= 0)) throw new Error('Preço inválido.');
    return { item_id: inp.dataset.item, unit_price: n };
  });
}
function ligarSomaPrecos(form) {
  const atualizar = () => {
    const el = form.querySelector('[data-soma-precos]');
    if (!el) return;
    let soma = 0, n = 0;
    for (const inp of form.querySelectorAll('.p-preco')) { const x = parseNum(inp.value); if (x >= 0 && inp.value.trim()) { soma += x * Number(inp.dataset.q); n++; } }
    el.textContent = n ? `Itens com preço somam ${fmtBRL(soma)}.` : '';
  };
  form.addEventListener('input', (e) => { if (e.target.classList.contains('p-preco')) atualizar(); });
  atualizar();
}
function formularioPrecos(p, g) {
  const j = janela(`Preço por item — ${oc(p, g)} ${g.name}`, `<p class="muted small" style="margin:0">${esc(g.supplier_name)} · compra de ${fmtBRL(g.amount)} em materiais${g.freight != null ? ` + frete ${fmtBRL(g.freight)}` : ''}. Deixe vazio o que não souber.</p>${tabelaPrecos(g)}`);
  ligarSomaPrecos(j.form);
  return abrir(j, async () => {
    ok(await (await sb()).rpc('definir_precos_itens', { p_group: g.id, p_precos: lerPrecos(j.form) }), 'preços');
    await depois(p.id);
    toast('Preços salvos.');
    return true;
  });
}

/* ----- separar itens por fornecedor (ordens de compra) ----- */
function formularioSeparar(p) {
  const gs = abertas(gruposDe(p.id));
  const linhas = gs.flatMap((g) => (S.itens.get(g.id) || []).map((i) => ({ i, g })));
  const corpo = `<p class="muted small" style="margin:0">Marque os itens que vão para o <b>mesmo fornecedor</b> e escolha a ordem de compra. Cada ordem terá a nota fiscal daquela loja. Pode repetir quantas vezes precisar; ordem que ficar vazia sai do pedido.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th><input type="checkbox" data-marcar-todos title="Marcar todos"></th><th>Item</th><th class="num">Qtd.</th><th>Está na ordem</th></tr></thead><tbody>
      ${linhas.map(({ i, g }) => `<tr><td><input type="checkbox" class="s-item" value="${i.id}"></td><td>${esc(i.description)}</td><td class="num nowrap">${qtd(i.quantity)} ${esc(i.unit)}</td><td class="small nowrap">${esc(oc(p, g))} ${esc(g.name)}${g.status !== 'analise' ? ` <span class="muted">(${esc(STATUS_GRUPO[g.status].rotulo)})</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="grid-form">
      <label class="field">Mandar para<select name="destino"><option value="">Nova ordem de compra…</option>${gs.map((g) => `<option value="${g.id}">${esc(oc(p, g))} ${esc(g.name)}</option>`).join('')}</select></label>
      <label class="field" data-nome-nova>Nome da nova ordem<input name="nome" maxlength="80" placeholder="ex.: Loja de materiais, Conexões, Tijolos"></label>
    </div>
    ${gs.some((g) => g.status !== 'analise') ? '<div class="muted small">Ordem que já tem cotação: confira as cotações depois de mudar os itens dela.</div>' : ''}`;
  const j = janela(`Separar por fornecedor — ${numeroPedido(p.number)}`, corpo, 'Mover itens');
  j.form.destino.onchange = () => { j.form.querySelector('[data-nome-nova]').hidden = !!j.form.destino.value; };
  j.form.querySelector('[data-marcar-todos]').onchange = (e) => j.form.querySelectorAll('.s-item').forEach((x) => { x.checked = e.target.checked; });
  return abrir(j, async (v) => {
    const ids = [...j.form.querySelectorAll('.s-item:checked')].map((x) => x.value);
    if (!ids.length) throw new Error('Marque pelo menos um item.');
    if (!v.destino && !(v.nome || '').trim()) throw new Error('Dê um nome à nova ordem de compra.');
    const id = ok(await (await sb()).rpc('separar_itens', { p_itens: ids, p_destino: v.destino || null, p_nome: (v.nome || '').trim() }), 'separar itens');
    ui.supGrupoAberto = id;
    await depois(p.id);
    toast(`${ids.length} item(ns) movido(s).`);
    return true;
  });
}

/* ----- nota fiscal / pedido do fornecedor ----- */
/** Lê o XML da NF-e (número, série, emissão, valor total, chave e emitente). Só preenche o formulário. */
function lerXmlNfe(texto) {
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const t = (sel, raiz = doc) => raiz.getElementsByTagName(sel)[0]?.textContent?.trim() || '';
  const ide = doc.getElementsByTagName('ide')[0];
  if (!ide) return null;
  const infNFe = doc.getElementsByTagName('infNFe')[0];
  const chave = (t('chNFe') || infNFe?.getAttribute('Id') || '').replace(/\D/g, '');
  const emit = doc.getElementsByTagName('emit')[0];
  const dup = doc.getElementsByTagName('dup')[0];
  return { numero: t('nNF', ide), serie: t('serie', ide), data: (t('dhEmi', ide) || t('dEmi', ide)).slice(0, 10), valor: Number(t('vNF')) || null,
    chave: chave.length === 44 ? chave : '', emitente: emit ? t('xNome', emit) : '', vencimento: dup ? t('dVenc', dup) : '' };
}
function formularioDocumento(p, g, substitui = null) {
  const cf = conferirDocumentos(g, docsDe(g.id));
  const falta = Math.max(0, -cf.diferenca);
  const corpo = `<p class="muted small" style="margin:0">${esc(oc(p, g))} ${esc(g.name)} · ${esc(g.supplier_name)} · compra de ${fmtBRL(cf.compra)}${cf.quantidade ? ` · documentos já registrados: ${fmtBRL(cf.documentos)}` : ''}</p>
    ${substitui ? `<div class="alert info small">Chegou a nota do <b>pedido ${esc(substitui.number)}</b> do fornecedor: a mesma conta a pagar é atualizada (não lança outra).</div>` : ''}
    <label class="field">Arquivo (opcional): XML da nota, PDF ou foto — o XML preenche os campos sozinho<input type="file" name="arquivo" accept=".xml,${ACCEPT}"></label>
    <div class="grid-form">
      <label class="field">Tipo<select name="tipo">${Object.entries(TIPOS_DOC).filter(([k]) => !substitui || k !== 'pedido_fornecedor').map(([k, r]) => `<option value="${k}">${r}</option>`).join('')}</select></label>
      <label class="field">Número *<input name="numero" maxlength="60"></label>
      <label class="field" data-so-nf>Série<input name="serie" maxlength="10" style="width:90px"></label>
      <label class="field">Data do documento *<input type="date" name="data" value="${todayISO()}" max="${todayISO()}"></label>
      <label class="field">Valor (R$) *<input name="valor" inputmode="decimal" value="${substitui ? fmtIn(substitui.amount, 2) : falta ? fmtIn(falta, 2) : ''}"></label>
      <label class="field">Vencimento<input type="date" name="vencimento" value="${esc(substitui?.due_date || '')}"></label>
    </div>
    <label class="field" data-so-nf>Chave de acesso da NF-e (44 números, opcional)<input name="chave" inputmode="numeric" maxlength="60"></label>
    <label class="field">Observações<input name="obs" maxlength="500" placeholder="ex.: nota com 2 itens a menos (falta entregar)"></label>
    <label class="check"><input type="checkbox" name="lancar" ${substitui?.expense_id ? 'checked disabled' : 'checked'}> Lançar como conta a pagar no Custos da obra (ligada a esta compra, sem contar duas vezes)</label>
    <div class="muted small" data-xml-info></div>`;
  const j = janela(substitui ? 'Registrar a nota fiscal' : 'Registrar nota fiscal ou pedido do fornecedor', corpo, 'Registrar');
  const soNf = () => j.form.querySelectorAll('[data-so-nf]').forEach((el) => { el.hidden = j.form.tipo.value !== 'nota_fiscal'; });
  j.form.tipo.onchange = soNf; soNf();
  j.form.arquivo.onchange = async () => {
    const f = j.form.arquivo.files[0];
    const info = j.form.querySelector('[data-xml-info]');
    info.textContent = '';
    if (!f || !/\.xml$/i.test(f.name)) return;
    const x = lerXmlNfe(await f.text());
    if (!x) { info.textContent = 'Não foi possível ler este XML como nota fiscal eletrônica. Preencha os campos à mão.'; return; }
    j.form.tipo.value = 'nota_fiscal'; soNf();
    if (x.numero) j.form.numero.value = x.numero;
    if (x.serie) j.form.serie.value = x.serie;
    if (x.data && x.data <= todayISO()) j.form.data.value = x.data;
    if (x.valor) j.form.valor.value = fmtIn(x.valor, 2);
    if (x.chave) j.form.chave.value = x.chave;
    if (x.vencimento) j.form.vencimento.value = x.vencimento;
    const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const outro = x.emitente && g.supplier_name && !sem(x.emitente).includes(sem(g.supplier_name).split(' ')[0]);
    info.innerHTML = `Preenchido pelo XML${x.emitente ? ` — emitente: <b>${esc(x.emitente)}</b>` : ''}.${outro ? ' <span class="badge warn">confira: o emitente parece outro fornecedor</span>' : ''}${x.valor && Math.abs(x.valor - (falta || cf.compra)) > 0.05 ? ` <span class="badge warn">valor da nota ${fmtBRL(x.valor)} × compra ${fmtBRL(cf.compra)}</span>` : ''}`;
  };
  return abrir(j, async (v) => {
    const numero = (v.numero || '').trim();
    if (!numero) throw new Error('Informe o número do documento.');
    if (!v.data || v.data > todayISO()) throw new Error('Informe a data do documento (não pode ser futura).');
    const valor = parseNum(v.valor);
    if (!(valor > 0)) throw new Error('Informe o valor do documento.');
    const chave = (v.chave || '').replace(/\D/g, '');
    if (chave && chave.length !== 44) throw new Error('A chave da nota fiscal tem 44 números.');
    let f = j.form.arquivo.files[0];
    // XML da NF-e: alguns navegadores não informam o tipo
    if (f && /\.xml$/i.test(f.name) && !['application/xml', 'text/xml'].includes(f.type)) f = new File([f], f.name, { type: 'application/xml' });
    const tipos = { ...TIPOS_ACEITOS, 'application/xml': 'XML', 'text/xml': 'XML' };
    if (f) validarArquivo(f, TAMANHO_MAX_OBRA, tipos);
    const c = await sb();
    let arquivo = null;
    if (f) {
      const caminho = await enviarArquivo(ctx().orgId, 'suprimentos', p.id, f, TAMANHO_MAX_OBRA, tipos);
      arquivo = ok(await c.from('purchase_files').insert({ order_id: p.id, project_id: p.project_id, group_id: g.id,
        kind: v.tipo === 'pedido_fornecedor' ? 'Pedido do fornecedor' : v.tipo === 'nota_fiscal' ? 'Nota fiscal' : 'Comprovante',
        name: f.name, storage_path: caminho, mime_type: f.type, size_bytes: f.size }).select('id').single(), 'arquivo').id;
    }
    ok(await c.rpc('registrar_documento_compra', { p_group: g.id, p_kind: v.tipo, p_number: numero, p_issue_date: v.data, p_amount: valor,
      p_due_date: v.vencimento || null, p_series: v.tipo === 'nota_fiscal' ? (v.serie || '').trim() : '', p_access_key: v.tipo === 'nota_fiscal' ? chave : '',
      p_notes: (v.obs || '').trim(), p_file: arquivo, p_lancar: substitui?.expense_id ? true : !!v.lancar, p_substitui: substitui?.id || null }), 'documento');
    await depois(p.id, { obras: true });
    toast(`${TIPOS_DOC[v.tipo]} ${numero} registrado${v.lancar || substitui?.expense_id ? ' — conta a pagar lançada' : ''}.`);
    return true;
  });
}

function formularioPrevisao(p, g) {
  const corpo = `<p class="muted small" style="margin:0">${numeroPedido(p.number)} · grupo <b>${esc(g.name)}</b> · ${esc(g.supplier_name)}</p>
    <div class="grid-form">
      <label class="field">Previsão de entrega<input type="date" name="previsao" value="${esc(g.expected_date || '')}"></label>
      <label class="field">A previsão é<select name="tipo"><option value="estimada">Estimada</option><option value="confirmada" ${g.expected_kind === 'confirmada' ? 'selected' : ''}>Confirmada pelo fornecedor</option></select></label>
      <label class="field">Situação<select name="etapa">${[g.status, ...(PASSAGENS_MANUAIS[g.status] || [])].map((s) => `<option value="${s}" ${s === g.status ? 'selected' : ''}>${esc(STATUS_GRUPO[s].rotulo)}</option>`).join('')}</select></label>
    </div>
    <label class="field">Endereço de retirada<input name="endereco" value="${esc(g.pickup_address || '')}"></label>
    <label class="field">Instruções de retirada<input name="instrucoes" value="${esc(g.pickup_instructions || '')}" placeholder="ex.: retirar até sexta, levar o pedido impresso"></label>`;
  return abrir(janela('Previsão e retirada', corpo), async (v) => {
    if (v.etapa === 'retirada' && !v.endereco.trim()) throw new Error('Informe o endereço de retirada.');
    const c = await sb();
    ok(await c.from('purchase_groups').update({ expected_date: v.previsao || null, expected_kind: v.tipo, pickup_address: v.endereco.trim(), pickup_instructions: v.instrucoes.trim() }).eq('id', g.id), 'grupo');
    if (v.etapa !== g.status) ok(await c.rpc('mudar_etapa_grupo', { p_group: g.id, p_status: v.etapa }), 'etapa');
    await depois(p.id);
    toast('Previsão atualizada.');
    return true;
  });
}

function formularioEntrega(p, g) {
  const its = itensComSaldo(S.itens.get(g.id) || [], S.recebido);
  const corpo = `<p class="muted small" style="margin:0">${numeroPedido(p.number)} · grupo <b>${esc(g.name)}</b> · ${esc(g.supplier_name)}</p>
    <div class="grid-form">
      <label class="field">Data *<input type="date" name="data" value="${todayISO()}" max="${todayISO()}"></label>
      <label class="field">Tipo<select name="tipo"><option value="entrega">Entrega na obra</option><option value="retirada" ${g.status === 'retirada' ? 'selected' : ''}>Retirada no fornecedor</option></select></label>
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="num">Pedido</th><th class="num">Já recebido</th><th>Recebido agora</th></tr></thead><tbody>
      ${its.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${qtd(i.quantity)} ${esc(i.unit)}</td><td class="num">${qtd(i.recebido)}</td>
        <td><input class="e-qtd" data-item="${i.id}" inputmode="decimal" value="${i.pendente ? fmtIn(i.pendente, 4) : ''}" style="width:90px"> ${esc(i.unit)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="muted small">Já vem preenchido com o que falta. Ajuste para o que chegou de fato (deixe vazio o que não veio).</div>
    <div class="grid-form">
      <label class="field">Quantidade confere com a nota?<select name="conforme"><option value="sim">Sim</option><option value="nao">Não (divergência)</option></select></label>
      <label class="field">Ocorrência<select name="ocorrencia">${Object.entries(OCORRENCIAS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label class="field">Nota fiscal / romaneio<input name="nf"></label>
    </div>
    <label class="field">Observações<input name="obs" placeholder="ex.: 2 sacos rasgados, devolvidos ao motorista"></label>
    <label class="field">Fotos e comprovantes (opcional, até 10 MB cada)<input type="file" name="arquivos" multiple accept="${ACCEPT}"></label>`;
  const j = janela('Registrar entrega ou retirada', corpo, 'Registrar');
  j.form.ocorrencia.onchange = () => { if (['falta', 'avaria', 'produto_diferente'].includes(j.form.ocorrencia.value)) j.form.conforme.value = 'nao'; };
  return abrir(j, async (v) => {
    if (!v.data || v.data > todayISO()) throw new Error('Informe a data (não pode ser futura).');
    const itens = [];
    for (const inp of j.form.querySelectorAll('.e-qtd')) {
      if (!inp.value.trim()) continue;
      const n = parseNum(inp.value);
      if (!(n >= 0)) throw new Error('Quantidade inválida.');
      if (n > 0) itens.push({ item_id: inp.dataset.item, quantity: n });
    }
    if (!itens.length) throw new Error('Informe a quantidade recebida de pelo menos um item.');
    const arquivos = [...j.form.arquivos.files];
    for (const f of arquivos) validarArquivo(f, TAMANHO_MAX_OBRA);
    const c = await sb();
    const id = ok(await c.rpc('registrar_entrega', { p_group: g.id, p_date: v.data, p_items: itens, p_kind: v.tipo, p_quantity_ok: v.conforme === 'sim',
      p_issue: v.ocorrencia, p_invoice: v.nf.trim(), p_notes: v.obs.trim() }), 'entrega');
    let falhas = 0;
    for (const f of arquivos) {
      try {
        const caminho = await enviarArquivo(ctx().orgId, 'suprimentos', p.id, f, TAMANHO_MAX_OBRA);
        ok(await c.from('purchase_files').insert({ order_id: p.id, project_id: p.project_id, group_id: g.id, delivery_id: id,
          kind: f.type.startsWith('image/') ? 'Foto' : 'Comprovante', name: f.name, storage_path: caminho, mime_type: f.type, size_bytes: f.size }), 'anexo');
      } catch { falhas++; }
    }
    await depois(p.id, { obras: true });
    toast(falhas ? `Entrega registrada, mas ${falhas} arquivo(s) não foram enviados. Anexe de novo em Resumo › Anexos.` : 'Entrega registrada.', falhas ? 7000 : 3200);
    return true;
  });
}

function formularioAnexo(p) {
  const gs = gruposDe(p.id);
  const corpo = `<div class="grid-form"><label class="field">Tipo<select name="tipo">${['Especificação', 'Foto', 'Comprovante', 'Proposta', 'Pedido do fornecedor', 'Nota fiscal', 'Outro'].map((t) => `<option>${t}</option>`).join('')}</select></label>
    <label class="field">Ordem de compra (opcional)<select name="grupo"><option value="">Pedido inteiro</option>${gs.map((g) => `<option value="${g.id}">${esc(oc(p, g))} ${esc(g.name)}</option>`).join('')}</select></label></div>
    <label class="field">Arquivos (PDF, imagem, planilha ou documento; até 10 MB cada)<input type="file" name="arquivos" multiple accept="${ACCEPT}"></label>`;
  const j = janela(`Anexar — ${numeroPedido(p.number)}`, corpo, 'Enviar');
  return abrir(j, async (v) => {
    const arquivos = [...j.form.arquivos.files];
    if (!arquivos.length) throw new Error('Escolha pelo menos um arquivo.');
    for (const f of arquivos) validarArquivo(f, TAMANHO_MAX_OBRA);
    const c = await sb();
    for (const f of arquivos) {
      const caminho = await enviarArquivo(ctx().orgId, 'suprimentos', p.id, f, TAMANHO_MAX_OBRA);
      ok(await c.from('purchase_files').insert({ order_id: p.id, project_id: p.project_id, group_id: v.grupo || null, kind: v.tipo, name: f.name,
        storage_path: caminho, mime_type: f.type, size_bytes: f.size }), 'anexo');
    }
    await depois(p.id);
    toast(`${arquivos.length} arquivo(s) anexado(s).`);
    return true;
  });
}

/* ---------- ações ---------- */
const achar = (d) => { const p = pedidoPorId(d.id); const g = d.g ? gruposDe(d.id).find((x) => x.id === d.g) : null; return { p, g }; };
export const acoesSuprimentos = {
  async supNovo() { const p = await formularioPedido(); if (p) ir(`#/suprimentos/pedido/${p.id}/resumo`); },
  supAbrir(d) { ir(`#/suprimentos/pedido/${d.id}/resumo`); },
  supIrGrupo(d) { ui.supGrupoAberto = d.g; ir(`#/suprimentos/pedido/${d.id}/grupos`); },
  async supEditar(d) { await formularioPedido(pedidoPorId(d.id)); },
  async supNovoGrupo(d) { await formularioGrupo(pedidoPorId(d.id)); },
  async supEditarGrupo(d) { const { p, g } = achar(d); await formularioGrupo(p, g); },
  async supExcluirGrupo(d) {
    const { p, g } = achar(d);
    if (!(await ask(`Excluir o grupo "${g.name}"? Ele ainda está em análise; a exclusão fica registrada no histórico.`, 'Excluir'))) return;
    ok(await (await sb()).from('purchase_groups').update({ deleted_at: new Date().toISOString() }).eq('id', g.id), 'grupo');
    await depois(p.id);
  },
  async supEtapa(d) {
    const { p, g } = achar(d);
    ok(await (await sb()).rpc('mudar_etapa_grupo', { p_group: g.id, p_status: d.s }), 'etapa');
    ui.supGrupoAberto = g.id;
    await depois(p.id);
    toast(`"${g.name}": ${STATUS_GRUPO[d.s].rotulo}.`);
  },
  async supEncerrar(d) {
    const { p, g } = achar(d);
    const temEntrega = (S.entregas.get(g.id) || []).length > 0;
    const opcoes = [...(!temEntrega ? [{ value: 'cancelar', label: 'Cancelar o grupo (não será recebido)' }] : []), ...(g.contract_id ? [{ value: 'resolver', label: 'Resolver a pendência (encerrar o que falta, mantendo o que foi recebido)' }] : [])];
    const v = await formDialog({ title: `Encerrar "${g.name}"`, ok: 'Confirmar', text: 'O grupo deixa de bloquear a conclusão do pedido. O motivo e o seu nome ficam no histórico; nada é apagado.',
      fields: [{ name: 'acao', label: 'Ação', type: 'select', value: opcoes[0].value, options: opcoes }, { name: 'motivo', label: 'Motivo (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('encerrar_grupo', { p_group: g.id, p_acao: v.acao, p_reason: v.motivo }), 'grupo');
    await depois(p.id, { obras: !!g.contract_id });
    toast(v.acao === 'cancelar' ? 'Grupo cancelado.' : 'Pendência resolvida.');
  },
  async supNovaCot(d) { const { p, g } = achar(d); await formularioCotacao(p, g); },
  async supExcluirCot(d) {
    if (!(await ask('Excluir esta cotação? Ela sai da comparação (fica registrada no histórico).', 'Excluir'))) return;
    ok(await (await sb()).from('purchase_quotes').update({ deleted_at: new Date().toISOString() }).eq('id', d.q), 'cotação');
    await depois(d.id);
  },
  async supComprar(d) {
    const { p, g } = achar(d);
    const cot = d.q ? (S.cotacoes.get(g.id) || []).find((x) => x.id === d.q) : null;
    await formularioCompra(p, g, cot);
  },
  async supPrevisao(d) { const { p, g } = achar(d); await formularioPrevisao(p, g); },
  async supReceber(d) { const { p, g } = achar(d); await formularioEntrega(p, g); },
  async supDesfazer(d) {
    const v = await formDialog({ title: 'Desfazer registro de entrega', ok: 'Desfazer', text: 'Use quando a entrega foi lançada errada. O grupo e o pedido são recalculados; o registro fica no histórico.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('desfazer_entrega', { p_delivery: d.e, p_reason: v.motivo }), 'entrega');
    await depois(d.id, { obras: true });
    toast('Registro de entrega desfeito.');
  },
  async supPendencias(d) {
    const p = pedidoPorId(d.id);
    const r = ok(await (await sb()).rpc('pendencias_pedido', { p_order: p.id }), 'pendências') || [];
    if (!r.length) return info(numeroPedido(p.number), `<p>${p.status === 'concluido' ? `Pedido <b>concluído</b>${p.concluded_at ? ` em ${new Date(p.concluded_at).toLocaleString('pt-BR')}` : ''}: todos os grupos entregues e conferidos, resolvidos ou cancelados.` : 'Nenhuma pendência.'}</p>`);
    info(`O que falta em ${numeroPedido(p.number)}`, `<p class="small">O pedido conclui sozinho quando todos os grupos terminam. Hoje faltam:</p><ul class="lista">${r.map((x) => `<li><b>${esc(x.grupo)}</b>: ${esc(x.pendencia)}</li>`).join('')}</ul>`);
  },
  async supComentar(d) {
    const el = document.getElementById('supComentario'); const txt = el.value.trim();
    if (!txt) return toast('Escreva o comentário.');
    const p = pedidoPorId(d.id);
    ok(await (await sb()).from('purchase_events').insert({ order_id: p.id, project_id: p.project_id, kind: 'comentario', body: txt }), 'comentário');
    el.value = '';
    await carregarDetalhe(p.id);
  },
  async supAnexar(d) { await formularioAnexo(pedidoPorId(d.id)); },
  async supSeparar(d) { await formularioSeparar(pedidoPorId(d.id)); },
  async supSobra(d) {
    const { p, g } = achar(d);
    const i = itensComSaldo(S.itens.get(g.id) || [], S.recebido).find((x) => x.id === d.i);
    const ok2 = await formularioTransferencia({ deObra: p.project_id, deFase: p.phase_id, item: i.id, descricao: i.description, unidade: i.unit,
      custo: i.unit_price != null ? Number(i.unit_price) : null, max: i.recebido });
    if (ok2) await depois(p.id);
  },
  async supPrecos(d) { const { p, g } = achar(d); await formularioPrecos(p, g); },
  async supDocumento(d) {
    const { p, g } = achar(d);
    if (!S.arquivos.has(p.id)) await carregarDetalhe(p.id).catch(() => {});
    const sub = d.sub ? docsDe(g.id).find((x) => x.id === d.sub) : null;
    await formularioDocumento(p, g, sub);
  },
  async supExcluirDoc(d) {
    const p = pedidoPorId(d.id);
    const v = await formDialog({ title: 'Excluir documento', ok: 'Excluir', text: 'Use quando o documento foi lançado errado. A conta a pagar dele sai junto (se ainda não tem pagamento). O motivo fica no histórico.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('excluir_documento_compra', { p_id: d.doc, p_reason: v.motivo }), 'documento');
    await depois(p.id, { obras: true });
    toast('Documento excluído.');
  },
  async supArqAbrir(d) {
    const url = await urlTemporaria(d.path, 300);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) info('Abrir anexo', `<p><a href="${esc(url)}" target="_blank" rel="noopener">Clique para abrir ${esc(d.nome)}</a> (link válido por 5 minutos).</p>`);
  },
  supLimparFiltros() { const foco = obraEmFoco(); if (foco) delete (ui.supFObra || {})[foco]; else ui.supF = null; queueRender(); },
  async supAtualizar() { await carregarSuprimentos(true); },
  entObra(d) { (ui.entF ||= { obra: '', situacao: '' }).obra = d.id || ''; queueRender(); },
};
export const mudancasSuprimentos = {
  supFiltro(d, el) {
    const f = filtrosQuadro();
    f[d.k] = el.type === 'checkbox' ? el.checked : el.value;
    if (d.k === 'obra') f.fase = '';
    queueRender();
  },
  entFiltro(d, el) { (ui.entF ||= { obra: '', situacao: '' })[d.k] = el.value; queueRender(); },
};
export const entradasSuprimentos = { supBusca(el) { filtrosQuadro().busca = el.value; queueRender(); } };
