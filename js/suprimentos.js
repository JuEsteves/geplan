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
import { enviarArquivo, urlTemporaria, ACCEPT, tamanhoLegivel, validarArquivo, TAMANHO_MAX_OBRA } from './nuvem/arquivos.js';
import { liberado } from './permissoes.js';
import { obraEmFoco, ir } from './escopo.js';
import { datalistFornecedores, idDoFornecedorPorNome, carregarFornecedores, categoriasFornecedor } from './fornecedores.js';
import {
  STATUS_GRUPO, STATUS_PEDIDO, COLUNAS, PASSAGENS_MANUAIS, OCORRENCIAS, etapaGrupo, numeroPedido, comparativoCotacoes,
  recebidoPorItem, itensComSaldo, pendenciasPedido, resumoPedido, filtrarPedidos, validarItens,
} from './suprimentosRegras.js';

const vazio = () => ({ carregado: false, carregando: false, erro: '', em: 0, pedidos: [], grupos: new Map(), itens: new Map(),
  cotacoes: new Map(), entregas: new Map(), itensEntrega: [], recebido: new Map(), eventos: new Map(), arquivos: new Map() });
const S = vazio();
const UNIDADES = ['un', 'pç', 'sc', 'kg', 't', 'm', 'm²', 'm³', 'l', 'cx', 'barra', 'dz', 'lata', 'galão', 'rolo', 'milheiro', 'jogo', 'vb'];
const ABAS = [['resumo', 'Resumo'], ['grupos', 'Grupos de materiais'], ['compras', 'Cotações e compras'], ['entregas', 'Entregas'], ['historico', 'Histórico e comentários']];

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
    if (!ids.length) Object.assign(S, { pedidos: [], grupos: new Map(), itens: new Map(), cotacoes: new Map(), entregas: new Map(), itensEntrega: [], recebido: new Map() });
    else {
      const c = await sb();
      const [peds, grs, its, cots, ents, ients] = await Promise.all([
        c.from('purchase_orders').select('*').in('project_id', ids).is('deleted_at', null).order('number', { ascending: false }),
        c.from('purchase_groups').select('*').in('project_id', ids).is('deleted_at', null).order('position'),
        c.from('purchase_items').select('*').in('project_id', ids).order('position'),
        c.from('purchase_quotes').select('*').in('project_id', ids).is('deleted_at', null).order('created_at'),
        c.from('purchase_deliveries').select('*').in('project_id', ids).is('deleted_at', null).order('delivery_date', { ascending: false }),
        c.from('purchase_delivery_items').select('*').in('project_id', ids),
      ]);
      S.pedidos = ok(peds, 'pedidos') || [];
      S.grupos = agrupar(ok(grs, 'grupos') || [], 'order_id');
      S.itens = agrupar(ok(its, 'itens') || [], 'group_id');
      S.cotacoes = agrupar(ok(cots, 'cotações') || [], 'group_id');
      const entregas = ok(ents, 'entregas') || [];
      S.entregas = agrupar(entregas, 'group_id');
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
  return `<div class="page-head"><div><h1>Quadro de compras</h1><div class="muted">${foco ? 'Pedidos de materiais desta obra, por etapa.' : 'Pedidos de materiais de todas as obras, por etapa.'} Um pedido reúne vários grupos; cada grupo segue o próprio caminho e o pedido só conclui quando todos terminam.</div></div>
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
    <div class="muted small">${lista.length} pedido(s)${atrasados ? ` · <b style="color:var(--crit)">${atrasados} atrasado(s)</b>` : ''}. Cada cartão fica na coluna do grupo menos adiantado.</div>
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
    ${gs.length ? `<div class="barra" title="${r.encerrados} de ${r.total} grupo(s) encerrado(s)"><span style="width:${r.pct}%"></span></div>
      <div class="small">${r.encerrados} de ${r.total} grupo(s) concluído(s)</div>
      <ul class="kcard-grupos">${gs.map((g) => `<li><b>${esc(g.name)}</b> — ${esc(STATUS_GRUPO[g.status]?.rotulo || g.status)}</li>`).join('')}</ul>`
      : '<div class="muted small">Sem grupos de materiais ainda.</div>'}
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
      ${gs.length ? `<div class="row" style="gap:8px;margin-top:6px;align-items:center"><div class="barra" style="width:180px"><span style="width:${r.pct}%"></span></div><span class="small">${r.encerrados} de ${r.total} grupo(s) concluído(s)</span></div>` : ''}</div>
    <div class="row">${editaPedido(p) ? `<button class="btn" data-act="supEditar" data-id="${p.id}">Editar pedido</button>` : ''}
      ${!['concluido', 'cancelado'].includes(p.status) && (podeComprar() || (meu(p) && podeSolicitar())) ? `<button class="btn" data-act="supNovoGrupo" data-id="${p.id}">${I.plus} Grupo</button>` : ''}
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
      <div class="card kpi"><div class="k-label">Grupos</div><div class="k-value">${gs.length}</div><div class="k-sub">${gs.filter((g) => etapaGrupo(g.status) === 4).length} encerrado(s)</div></div>
      <div class="card kpi"><div class="k-label">Valor comprado</div><div class="k-value" style="font-size:20px">${comprados.length ? fmtBRL(soma(comprados, (g) => Number(g.amount) + Number(g.freight || 0))) : '—'}</div><div class="k-sub">${comprados.length} grupo(s) com compra · materiais + frete</div></div>
      <div class="card kpi"><div class="k-label">Frete</div><div class="k-value" style="font-size:20px">${comprados.length ? fmtBRL(soma(comprados, (g) => g.freight)) : '—'}</div></div>
      <div class="card kpi"><div class="k-label">Cotado (escolhidas)</div><div class="k-value" style="font-size:20px">${comprados.some((g) => g.quoted_amount != null) ? fmtBRL(soma(comprados, (g) => g.quoted_amount)) : '—'}</div><div class="k-sub">só cotações que viraram compra</div></div>
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
          : gs.length ? '<div class="small">Todos os grupos estão entregues e conferidos, resolvidos ou cancelados.</div>' : '<div class="muted small">Inclua os grupos de materiais.</div>'}
        <div class="muted small">O pedido conclui sozinho quando todos os grupos terminam — não há botão para "forçar" a conclusão.</div></div>
    </div>
    <div class="card card-pad stack"><h2>Grupos</h2>${gs.length ? `<div class="table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Grupo</th><th>Etapa</th><th>Fornecedor</th><th class="num">Valor</th><th>Previsão</th></tr></thead><tbody>
      ${gs.map((g) => `<tr data-act="supIrGrupo" data-id="${p.id}" data-g="${g.id}" tabindex="0"><td><b>${esc(g.name)}</b>${g.category_id ? `<div class="muted small">${esc(nomeCategoria(g.category_id))}</div>` : ''}</td><td>${bGrupo(g.status)}</td><td class="small">${esc(g.supplier_name || '—')}</td>
        <td class="num nowrap">${g.amount != null ? fmtBRL(Number(g.amount) + Number(g.freight || 0)) : '—'}</td><td class="small nowrap">${previsao(g)}${g.expected_date && g.expected_date < hoje && etapaGrupo(g.status) === 3 ? ' <span class="badge crit">atrasada</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="muted small">Nenhum grupo ainda.</div>'}</div>
    <div class="card card-pad stack"><div class="row between"><h2>Anexos</h2>${podeSolicitar() || podeComprar() || podeReceber() ? `<button class="btn sm" data-act="supAnexar" data-id="${p.id}">${I.upload} Anexar</button>` : ''}</div>
      ${listaArquivos(arqs, gs)}
      <div class="muted small">Fotos, especificações e comprovantes em armazenamento privado (link temporário). Até 10 MB por arquivo.</div></div>`;
}

function listaArquivos(arqs, gs) {
  if (!arqs.length) return '<div class="muted small">Nenhum anexo.</div>';
  return `<ul class="lista">${arqs.map((a) => `<li class="row between" style="gap:8px"><span><b>${esc(a.name)}</b> <span class="badge">${esc(a.kind)}</span>${a.group_id ? ` <span class="muted small">${esc(gs.find((g) => g.id === a.group_id)?.name || '')}</span>` : ''}<div class="muted small">${tamanhoLegivel(a.size_bytes)} · ${new Date(a.created_at).toLocaleDateString('pt-BR')}</div></span>
    <button class="btn sm" data-act="supArqAbrir" data-path="${esc(a.storage_path)}" data-nome="${esc(a.name)}">Abrir</button></li>`).join('')}</ul>`;
}

function itensTabela(g, editavel) {
  const its = itensComSaldo(S.itens.get(g.id) || [], S.recebido);
  if (!its.length) return '<div class="muted small">Sem itens.</div>';
  const comprado = etapaGrupo(g.status) >= 3;
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="num">Quantidade</th><th>Unid.</th>${comprado ? '<th class="num">Recebido</th><th class="num">Pendente</th>' : ''}<th>Especificação</th></tr></thead><tbody>
    ${its.map((i) => `<tr><td>${esc(i.description)}${i.required === false ? ' <span class="badge">opcional</span>' : ''}${i.notes ? `<div class="muted small">${esc(i.notes)}</div>` : ''}</td><td class="num">${qtd(i.quantity)}</td><td>${esc(i.unit)}</td>
      ${comprado ? `<td class="num">${qtd(i.recebido)}${i.excedente ? ` <span class="badge warn">+${qtd(i.excedente)}</span>` : ''}</td><td class="num">${i.pendente ? `<b>${qtd(i.pendente)}</b>` : '<span class="badge good">ok</span>'}</td>` : ''}
      <td class="small">${esc(i.spec || '')}</td></tr>`).join('')}</tbody></table></div>${editavel ? '' : ''}`;
}

function abaGrupos(p, gs) {
  if (!gs.length) return `<div class="card empty"><p>Nenhum grupo de materiais neste pedido.</p>${!['concluido', 'cancelado'].includes(p.status) ? `<button class="btn primary" data-act="supNovoGrupo" data-id="${p.id}">${I.plus} Incluir grupo</button>` : ''}</div>`;
  const aberto = ui.supGrupoAberto;
  return gs.map((g) => {
    const edita = editaGrupo(g, p) && etapaGrupo(g.status) <= 2;
    const passagens = podeComprar() ? (PASSAGENS_MANUAIS[g.status] || []).filter((s) => etapaGrupo(s) === etapaGrupo(g.status) || etapaGrupo(g.status) <= 2) : [];
    return `<details class="card card-pad grupo-bloco" id="g-${g.id}" ${aberto === g.id || gs.length === 1 ? 'open' : ''}>
      <summary><span class="row between" style="gap:8px;flex-wrap:wrap"><span><b>${esc(g.name)}</b>${g.category_id ? ` <span class="muted small">${esc(nomeCategoria(g.category_id))}</span>` : ''}</span>${bGrupo(g.status)}</span></summary>
      <div class="stack" style="margin-top:10px">
        ${g.description ? `<div class="small">${esc(g.description)}</div>` : ''}
        ${itensTabela(g, edita)}
        ${g.notes ? `<div class="small muted">Obs.: ${esc(g.notes)}</div>` : ''}
        ${g.resolution_reason ? `<div class="alert info small">${g.status === 'cancelado' ? 'Cancelado' : 'Pendência resolvida'} por ${esc(g.resolved_label)} em ${new Date(g.resolved_at).toLocaleDateString('pt-BR')}: ${esc(g.resolution_reason)}</div>` : ''}
        <div class="row" style="gap:6px;flex-wrap:wrap">
          ${edita ? `<button class="btn sm" data-act="supEditarGrupo" data-id="${p.id}" data-g="${g.id}">Editar grupo e itens</button>` : ''}
          ${passagens.map((s) => `<button class="btn sm" data-act="supEtapa" data-id="${p.id}" data-g="${g.id}" data-s="${s}">Mover para "${esc(STATUS_GRUPO[s].rotulo)}"</button>`).join('')}
          ${podeComprar() && etapaGrupo(g.status) <= 2 ? `<a class="btn sm primary" href="#/suprimentos/pedido/${p.id}/compras">Cotar e comprar</a>` : ''}
          ${etapaGrupo(g.status) === 3 ? `<a class="btn sm primary" href="#/suprimentos/pedido/${p.id}/entregas">Entregas</a>` : ''}
          ${edita && g.status === 'analise' ? `<button class="btn sm danger" data-act="supExcluirGrupo" data-id="${p.id}" data-g="${g.id}">Excluir grupo</button>` : ''}
          ${podeComprar() && etapaGrupo(g.status) < 4 ? `<button class="btn sm danger" data-act="supEncerrar" data-id="${p.id}" data-g="${g.id}">${g.contract_id ? 'Resolver pendência / cancelar' : 'Cancelar grupo'}</button>` : ''}
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
    return `<div class="card card-pad stack"><div class="row between" style="gap:8px;flex-wrap:wrap"><h2 style="margin:0">${esc(g.name)}</h2>${bGrupo(g.status)}</div>
      ${compra}${tabela}
      ${cotar ? `<div class="row" style="gap:6px"><button class="btn sm" data-act="supNovaCot" data-id="${p.id}" data-g="${g.id}">${I.plus} Registrar cotação</button><button class="btn sm" data-act="supComprar" data-id="${p.id}" data-g="${g.id}">Compra direta (sem cotação)</button></div>` : ''}
      ${!podeComprar() && antes ? '<div class="muted small">Aguardando a equipe de compras.</div>' : ''}</div>`;
  }).join('') + '<div class="muted small">Total = materiais + frete. "Menor valor" e "menor prazo" só ordenam os números informados. A compra registrada entra como compromisso no Financeiro da obra, com a fase do pedido; cotações não escolhidas não entram em custo.</div>';
}

function abaEntregas(p, gs, hoje) {
  const comprados = gs.filter((g) => g.contract_id || (S.entregas.get(g.id) || []).length);
  if (!comprados.length) return '<div class="card empty"><p>Nenhum grupo comprado ainda. As entregas aparecem aqui depois da compra.</p></div>';
  return comprados.map((g) => {
    const ents = S.entregas.get(g.id) || [];
    const receber = podeReceber() && ['comprado', 'aguardando_entrega', 'retirada', 'entrega_parcial'].includes(g.status);
    const atrasada = g.expected_date && g.expected_date < hoje && etapaGrupo(g.status) === 3;
    return `<div class="card card-pad stack"><div class="row between" style="gap:8px;flex-wrap:wrap"><h2 style="margin:0">${esc(g.name)} <span class="muted small">${esc(g.supplier_name)}</span></h2>${bGrupo(g.status)}</div>
      <div class="small">Previsão: ${previsao(g)}${atrasada ? ' <span class="badge crit">atrasada</span>' : ''}</div>
      ${g.status === 'retirada' || g.pickup_address ? `<div class="alert info small"><b>Retirada:</b> ${esc(g.pickup_address || 'endereço não informado')}${g.pickup_instructions ? ` — ${esc(g.pickup_instructions)}` : ''}</div>` : ''}
      ${itensTabela(g, false)}
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

/* ----- Entregas (todas as obras) ----- */
function viewEntregas() {
  const hoje = todayISO();
  const linhas = [];
  const foco = obraEmFoco();
  for (const p of S.pedidos) if (!foco || p.project_id === foco) for (const g of gruposDe(p.id)) if (etapaGrupo(g.status) === 3) linhas.push({ p, g, atrasada: !!(g.expected_date && g.expected_date < hoje) });
  linhas.sort((a, b) => Number(b.atrasada) - Number(a.atrasada) || String(a.g.expected_date || '9999').localeCompare(String(b.g.expected_date || '9999')));
  return `<div class="page-head"><div><h1>Entregas e recebimentos</h1><div class="muted">Grupos comprados aguardando entrega ou retirada, ${foco ? 'dos pedidos desta obra' : 'de todos os pedidos'}. Atrasada = previsão anterior a hoje.</div></div>
    <div class="row"><button class="btn" data-act="supAtualizar">Atualizar</button></div></div>
  <div class="stack">${linhas.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Pedido</th><th>Grupo</th><th>Obra</th><th>Fornecedor</th><th>Previsão</th><th>Etapa</th><th></th></tr></thead><tbody>
    ${linhas.map(({ p, g, atrasada }) => `<tr><td class="nowrap"><a href="#/suprimentos/pedido/${p.id}/entregas">${numeroPedido(p.number)}</a><div class="muted small">${esc(p.title)}</div></td><td><b>${esc(g.name)}</b></td>
      <td class="small">${esc(obraNome(p.project_id))}</td><td class="small">${esc(g.supplier_name)}</td><td class="small nowrap">${previsao(g)}${atrasada ? ' <span class="badge crit">atrasada</span>' : ''}</td><td>${bGrupo(g.status)}</td>
      <td>${podeReceber() ? `<button class="btn sm primary" data-act="supReceber" data-id="${p.id}" data-g="${g.id}">Registrar</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="card empty"><p>Nenhum grupo aguardando entrega.</p></div>'}
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

const linhaItem = (it = {}) => `<tr class="item-linha"><td><input class="i-desc" value="${esc(it.description || '')}" placeholder="ex.: Tábua de pinus 30 cm" maxlength="300"></td>
  <td><input class="i-qtd" inputmode="decimal" value="${it.quantity != null ? fmtIn(it.quantity, 4) : ''}" style="width:80px"></td>
  <td><input class="i-un" list="lista-unidades" value="${esc(it.unit || '')}" style="width:70px" maxlength="20"></td>
  <td><input class="i-spec" value="${esc(it.spec || '')}" placeholder="especificação (opcional)"></td></tr>`;
const tabelaItens = (itens) => `<div class="table-wrap"><table class="data itens-sol"><thead><tr><th>Material</th><th>Qtd.</th><th>Unid.</th><th>Especificação</th></tr></thead>
  <tbody>${[...itens, ...Array(Math.max(1, 3 - itens.length)).fill({})].map(linhaItem).join('')}</tbody></table></div>
  <div><button type="button" class="btn sm" data-mais-item>${I.plus} Mais um item</button></div>`;
const opcoesCategoria = (sel) => `<option value="">—</option>${categoriasFornecedor().filter((c) => c.active || c.id === sel).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
const blocoGrupo = (g = {}, itens = []) => `<fieldset class="grupo-form"><legend>Grupo de materiais</legend>
  <div class="grid-form"><label class="field">Nome do grupo *<input class="g-nome" value="${esc(g.name || '')}" maxlength="80" placeholder="ex.: Madeira, Tijolos, Cimento"></label>
  <label class="field">Categoria<select class="g-cat">${opcoesCategoria(g.category_id)}</select></label></div>
  <label class="field">Descrição / observações do grupo<input class="g-desc" value="${esc(g.description || '')}"></label>
  ${tabelaItens(itens)}</fieldset>`;
const listaUnidades = `<datalist id="lista-unidades">${UNIDADES.map((u) => `<option value="${u}">`).join('')}</datalist>`;

function lerItens(raiz) {
  const brutos = [...raiz.querySelectorAll('.item-linha')].map((tr) => ({
    description: tr.querySelector('.i-desc').value, quantity: tr.querySelector('.i-qtd').value.trim() === '' ? '' : parseNum(tr.querySelector('.i-qtd').value),
    unit: tr.querySelector('.i-un').value, spec: tr.querySelector('.i-spec').value,
  }));
  return validarItens(brutos);
}
function ligarItens(form) {
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mais-item]');
    if (b) { b.closest('fieldset, .stack, form').querySelector('.itens-sol tbody').insertAdjacentHTML('beforeend', linhaItem()); return; }
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
  const corpo = `<div class="grid-form">
      <label class="field">Obra *<select name="project_id" ${p ? 'disabled' : ''}>${obras.map((o) => `<option value="${o.id}" ${o.id === obraIni ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select></label>
      <label class="field">Fase da obra<select name="phase_id">${opcoesFase(store.obra(obraIni), p?.phase_id)}</select></label>
      <label class="field">Descrição do pedido *<input name="title" maxlength="160" value="${esc(p?.title || '')}" placeholder="ex.: Materiais para estrutura"></label>
      <label class="field">Prioridade<select name="priority"><option value="normal">Normal</option><option value="urgente" ${p?.priority === 'urgente' ? 'selected' : ''}>Urgente</option></select></label>
      <label class="field">Necessário em<input type="date" name="needed_date" value="${esc(p?.needed_date || '')}"></label>
      <label class="field">Local de entrega<input name="delivery_location" value="${esc(p?.delivery_location || '')}" placeholder="ex.: canteiro, portão 2"></label>
      ${p && podeComprar() ? `<label class="field">Comprador responsável<input name="buyer_label" value="${esc(p.buyer_label || '')}"></label>` : ''}
    </div>
    <div data-aviso-eap>${p ? '' : avisoEap(store.obra(obraIni))}</div>
    <label class="field">Observações<textarea name="notes" rows="2">${esc(p?.notes || '')}</textarea></label>
    ${p ? '' : `<div class="muted small">Solicitante: ${esc(ctx().email)}. Separe os materiais em grupos — cada grupo pode ser comprado de um fornecedor diferente.</div>
      <div class="grupos-form stack">${blocoGrupo()}</div><div><button type="button" class="btn sm" data-mais-grupo>${I.plus} Mais um grupo</button></div>${listaUnidades}`}`;
  const j = janela(p ? `Editar ${numeroPedido(p.number)}` : 'Novo pedido de compra', corpo, p ? 'Salvar' : 'Criar pedido');
  ligarItens(j.form);
  j.form.project_id.onchange = () => {
    const o = store.obra(j.form.project_id.value);
    j.form.phase_id.innerHTML = opcoesFase(o, '');
    j.form.querySelector('[data-aviso-eap]').innerHTML = avisoEap(o);
  };
  return abrir(j, async (v) => {
    if ((v.title || '').trim().length < 2) throw new Error('Informe a descrição do pedido.');
    const projeto = p?.project_id || v.project_id;
    if (!v.phase_id && fasesDaObra(store.obra(projeto)).length) throw new Error('Escolha a fase da obra (usada para acompanhar os custos por etapa).');
    const grupos = [];
    if (!p) {
      for (const [n, fs] of [...j.form.querySelectorAll('.grupo-form')].entries()) {
        const nome = fs.querySelector('.g-nome').value.trim();
        const r = lerItens(fs);
        if (!nome && r.erro === 'Inclua pelo menos um item.') continue;   // bloco vazio
        if (!nome) throw new Error(`Grupo ${n + 1}: informe o nome.`);
        if (r.erro) throw new Error(`Grupo "${nome}": ${r.erro}`);
        grupos.push({ name: nome, category_id: fs.querySelector('.g-cat').value || null, description: fs.querySelector('.g-desc').value.trim(), itens: r.itens });
      }
      if (!grupos.length) throw new Error('Inclua pelo menos um grupo de materiais com itens.');
    }
    const dados = { title: v.title.trim(), phase_id: v.phase_id || null, priority: v.priority, needed_date: v.needed_date || null,
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
  const j = janela(g ? `Editar grupo — ${g.name}` : `Novo grupo — ${numeroPedido(p.number)}`, corpo);
  ligarItens(j.form);
  return abrir(j, async (v) => {
    const fs = j.form.querySelector('.grupo-form');
    const nome = fs.querySelector('.g-nome').value.trim();
    if (!nome) throw new Error('Informe o nome do grupo.');
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
    toast(g ? 'Grupo atualizado.' : 'Grupo incluído.');
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
    </div>`;
  return abrir(janela('Registrar compra', corpo, 'Registrar compra'), async (v) => {
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
    await depois(p.id, { obras: true });
    toast(`Compra de "${g.name}" registrada.`);
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
  const corpo = `<div class="grid-form"><label class="field">Tipo<select name="tipo">${['Especificação', 'Foto', 'Comprovante', 'Proposta', 'Outro'].map((t) => `<option>${t}</option>`).join('')}</select></label>
    <label class="field">Grupo (opcional)<select name="grupo"><option value="">Pedido inteiro</option>${gs.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label></div>
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
  async supArqAbrir(d) {
    const url = await urlTemporaria(d.path, 300);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) info('Abrir anexo', `<p><a href="${esc(url)}" target="_blank" rel="noopener">Clique para abrir ${esc(d.nome)}</a> (link válido por 5 minutos).</p>`);
  },
  supLimparFiltros() { const foco = obraEmFoco(); if (foco) delete (ui.supFObra || {})[foco]; else ui.supF = null; queueRender(); },
  async supAtualizar() { await carregarSuprimentos(true); },
};
export const mudancasSuprimentos = {
  supFiltro(d, el) {
    const f = filtrosQuadro();
    f[d.k] = el.type === 'checkbox' ? el.checked : el.value;
    if (d.k === 'obra') f.fase = '';
    queueRender();
  },
};
export const entradasSuprimentos = { supBusca(el) { filtrosQuadro().busca = el.value; queueRender(); } };
