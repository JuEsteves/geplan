// Visão geral (página inicial) e Tarefas e pendências: consolidam as obras usando os mesmos cálculos das
// telas de cada obra (contexto → indicadores.js). Nenhum dado de demonstração: sem dados, mostra estado vazio.
import * as store from './store.js';
import { esc, I, ui, queueRender } from './ui.js';
import { fmtBR, isoBR, fmtNum, fmtBRL, todayDay } from './schedule.js';
import { contexto } from './obra.js';
import { resumoObra, consolidado } from './indicadores.js';
import { pode, veCustos } from './permissoes.js';
import { ICONES } from './navegacao.js';
import { STATUS_OBRA } from './model.js';
import { configurado as nuvemConfigurada } from './nuvem/supabase.js';

// Cache por versão da obra e da biblioteca (o cálculo do cronograma de várias obras não roda a cada clique).
const cache = new Map();
export function resumoDe(o) {
  const lib = store.lib();
  const chave = `${o.updatedAt}|${lib.updatedAt}|${todayDay()}`;
  const hit = cache.get(o.id);
  if (hit && hit.chave === chave && hit.o === o) return hit.r;
  const r = resumoObra(contexto(o));
  cache.set(o.id, { chave, o, r });
  return r;
}
const resumos = () => store.obras().map(resumoDe);

const SITUACAO = { 'Em dia': 'good', 'Atenção': 'warn', 'Atrasada': 'crit', 'Concluída': 'info', 'Não iniciada': '', 'Sem cronograma': '' };
const lista = (itens, vazio) => (itens.length ? `<ul class="lista">${itens.join('')}</ul>` : `<div class="muted small" style="padding:6px 0">${vazio}</div>`);
const barra = (plan, real) => `<div class="progress duo" title="planejado ${fmtNum(plan, 0)}% · realizado ${fmtNum(real, 0)}%"><div class="p" style="width:${Math.min(100, plan)}%"></div><div class="r" style="width:${Math.min(100, real)}%"></div></div>`;
/** Card de indicador; vira link quando há uma tela de destino. */
const kpi = (titulo, valor, sub, href = '', cor = '') => {
  const corpo = `<div class="k-label">${titulo}</div><div class="k-value"${cor ? ` style="color:${cor}"` : ''}>${valor}</div><div class="k-sub">${sub}</div>`;
  return href ? `<a class="card kpi kpi-link" href="${href}">${corpo}</a>` : `<div class="card kpi">${corpo}</div>`;
};

/* ---------- módulos (atalhos e apresentação) ---------- */
// `href` = tela real; sem `href` = ainda em desenvolvimento (aparece desabilitado, sem simular funcionamento).
const MODULOS = [
  { grupo: 'Planejamento', itens: [
    { r: 'Obras', ico: 'obras', href: '#/obras', d: 'Cadastro das obras, cliente, prazos, calendário e equipe.' },
    { r: 'EAP e fases', ico: 'fases', href: '#/fases', d: 'Biblioteca de fases (modelos de EAP) para montar obras.' },
    { r: 'Cronograma', ico: 'gantt', href: '#/modulo/gantt', d: 'Gantt, dependências, caminho crítico e linha de base.' },
    { r: 'Curva S', ico: 'curva', href: '#/modulo/curva', d: 'Planejado × realizado, físico e financeiro.' },
  ] },
  { grupo: 'Orçamento e custos', itens: [
    { r: 'Orçamentos', ico: 'orcamento', href: '#/modulo/orcamento', d: 'Itens, composições, BDI, revisões e importação do Excel.' },
    { r: 'Medições', ico: 'medicoes', href: nuvemConfigurada() ? '#/medicoes' : '#/modulo/medicoes', d: nuvemConfigurada() ? 'Boletins por atividade e profissional, aprovação e pagamento.' : 'Avanço físico acumulado de cada atividade.' },
    { r: 'Custos', ico: 'custos', href: '#/modulo/financeiro', d: 'Contratos, despesas e pagamentos sem duplicidade.' },
  ] },
  { grupo: 'Execução', itens: [
    { r: 'Diário de obra', ico: 'diario', href: '#/diario', d: 'RDO por período, fotos e vídeos, aprovação com assinatura e PDF.' },
    { r: 'Tarefas e pendências', ico: 'tarefas', href: '#/pendencias', d: 'Atrasos e pendências de todas as obras.' },
  ] },
  { grupo: 'Suprimentos e documentos', itens: [
    ...(nuvemConfigurada() ? [
      { r: 'Quadro de compras', ico: 'compras', href: '#/suprimentos', d: 'Pedidos com grupos de materiais, cotações e compras, por etapa.' },
      { r: 'Entregas', ico: 'entregas', href: '#/suprimentos/entregas', d: 'Grupos comprados aguardando entrega ou retirada na obra.' },
    ] : []),
    { r: 'Compras no Financeiro', ico: 'custos', href: '#/modulo/compras', d: 'Compromissos de compra registrados no Financeiro de cada obra.' },
    { r: 'Fornecedores', ico: 'fornecedores', d: 'Cadastro central: contatos, condições, documentos e histórico.', ...(nuvemConfigurada() ? { href: '#/fornecedores' } : {}) },
    { r: 'Documentos', ico: 'documentos', d: 'Documentos, fotos e anexos das obras.' },
  ] },
];
function atalhos(comDescricao = false) {
  return MODULOS.map((g) => `<div class="atalhos-grupo"><div class="nav-titulo">${esc(g.grupo)}</div><div class="atalhos">${g.itens.map((m) => {
    const corpo = `${ICONES[m.ico]}<span><b>${esc(m.r)}</b>${comDescricao ? `<small>${esc(m.d)}</small>` : ''}</span>${m.href ? '' : '<span class="badge">em desenvolvimento</span>'}`;
    return m.href ? `<a class="atalho${comDescricao ? ' atalho-desc' : ''}" href="${m.href}">${corpo}</a>`
      : `<span class="atalho atalho-off${comDescricao ? ' atalho-desc' : ''}" aria-disabled="true" title="Em desenvolvimento">${corpo}</span>`;
  }).join('')}</div></div>`).join('');
}

/* ---------- obras ---------- */
function cardObra(r) {
  const o = r.o;
  const alertas = [
    r.atrasadas.length ? `<span class="badge crit">${r.atrasadas.length} atrasada(s)</span>` : '',
    r.pend.length ? `<span class="badge warn">${r.pend.length} pendência(s) no diário</span>` : '',
    r.pedidos.entregasAtrasadas.length ? `<span class="badge crit">${r.pedidos.entregasAtrasadas.length} entrega(s) atrasada(s)</span>` : '',
  ].filter(Boolean).join(' ');
  return `<a class="card obra-card" href="#/obra/${o.id}/painel">
    <div class="obra-topo">
      <div class="obra-capa" aria-hidden="true">${esc((o.nome || '?').trim().charAt(0).toUpperCase())}</div>
      <div style="flex:1;min-width:0">
        <div class="row between" style="gap:8px"><b>${esc(o.nome)}</b><span class="badge ${SITUACAO[r.situacao] ?? ''}">${esc(r.situacao)}</span></div>
        <div class="muted small" style="margin-top:2px">${esc(o.status || 'Planejamento')}${o.codigo ? ` · ${esc(o.codigo)}` : ''}</div>
      </div>
    </div>
    <div class="meta">
      <div>Início<b>${o.inicio ? isoBR(o.inicio) : '—'}</b></div>
      <div>Previsão de término<b>${r.termino ? fmtBR(r.termino) : o.terminoPlanejado ? isoBR(o.terminoPlanejado) : '—'}</b></div>
    </div>
    ${r.temAvanco ? `<div style="margin-top:10px"><div class="row between small"><span>Avanço físico</span><b>${fmtNum(r.av.fisicoReal, 1)}%</b></div>${barra(r.av.fisicoPlan, r.av.fisicoReal)}<div class="muted small">planejado para hoje: ${fmtNum(r.av.fisicoPlan, 1)}%</div></div>`
      : `<div class="muted small" style="margin-top:10px">${r.temEap ? 'Avanço físico sem peso definido (vincule o orçamento ou escolha outro critério de peso).' : 'Sem atividades: monte a EAP para acompanhar o avanço.'}</div>`}
    ${alertas ? `<div class="row" style="gap:6px;margin-top:8px">${alertas}</div>` : ''}
  </a>`;
}

function filtrarObras(rs) {
  const t = (ui.inicioBusca || '').trim().toLowerCase();
  return rs.filter((r) => (!t || `${r.o.nome} ${r.o.codigo || ''} ${r.o.cliente?.nome || ''} ${r.o.cidade || ''}`.toLowerCase().includes(t))
    && (!ui.inicioStatus || r.o.status === ui.inicioStatus)
    && (!ui.inicioSituacao || r.situacao === ui.inicioSituacao));
}

/* ---------- atenção e pendências ---------- */
/** Seções de alertas (resumidas na Visão geral; completas em Tarefas e pendências). Só dados reais. */
function secoes(rs, limite) {
  const ativas = rs.filter((x) => x.ativa);
  const corta = (arr) => (limite ? arr.slice(0, limite) : arr);
  const mais = (total, href = '#/pendencias') => (limite && total > limite ? `<a class="small" href="${href}">Ver todas (${total}) →</a>` : '');
  const nomeObra = (r) => `<span class="muted small">· ${esc(r.o.nome)}</span>`;
  const atrasadas = ativas.flatMap((r) => r.atrasadas.map((n) => ({ r, n })));
  const proximas = ativas.flatMap((r) => r.proximas.map((n) => ({ r, n }))).sort((a, b) => a.n.inicio - b.n.inicio);
  const entregas = ativas.flatMap((r) => [...r.pedidos.entregasAtrasadas.map((k) => ({ r, k, atraso: true })), ...r.pedidos.entregasProximas.map((k) => ({ r, k, atraso: false }))]);
  const cotacao = ativas.flatMap((r) => r.pedidos.aguardandoCotacao.map((k) => ({ r, k })));
  const pend = ativas.flatMap((r) => r.pend.map((p) => ({ r, p })));
  const planejamento = ativas.filter((r) => r.planejamento.length);
  const atencao = ativas.filter((r) => ['Atrasada', 'Atenção'].includes(r.situacao) || r.pend.length || (veCustos() && r.custos.alertas.length));
  const pedido = (k) => esc(k.objeto || k.numero || k.fornecedor || 'Pedido');
  const card = (titulo, n, corpo, vazio, extra = '') => ({ n, html: `<div class="card card-pad"><h2>${titulo}${n != null ? ` (${n})` : ''}</h2>${lista(corpo, vazio)}${extra}</div>` });
  return {
    atrasadas: card('Atividades atrasadas', atrasadas.length, corta(atrasadas).map(({ r, n }) => `<li><a href="#/obra/${r.o.id}/medicoes"><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)}</a> ${nomeObra(r)}</li>`),
      ativas.some((r) => r.temEap) ? 'Nenhuma atividade atrasada pelas medições registradas.' : 'Sem atividades cadastradas.', mais(atrasadas.length)),
    entregas: card('Entregas atrasadas e próximas (7 dias)', entregas.length, corta(entregas).map(({ r, k, atraso }) => `<li><a href="#/obra/${r.o.id}/financeiro/compras">${pedido(k)}</a> <span class="badge ${atraso ? 'crit' : 'warn'}">${atraso ? 'atrasada desde' : 'prevista para'} ${isoBR(k.dataNecessaria)}</span> ${nomeObra(r)}</li>`),
      'Nenhuma entrega atrasada ou prevista para os próximos 7 dias.'),
    cotacao: card('Pedidos aguardando cotação', cotacao.length, corta(cotacao).map(({ r, k }) => `<li><a href="#/obra/${r.o.id}/financeiro/compras">${pedido(k)}</a>${k.dataNecessaria ? ` <span class="muted small">necessário em ${isoBR(k.dataNecessaria)}</span>` : ''} ${nomeObra(r)}</li>`),
      'Nenhum pedido em cotação.'),
    diario: card('Pendências do diário', pend.length, corta(pend).map(({ r, p }) => `<li><span class="badge warn">${esc(p.tipo)}</span> <a href="#/diario/${r.o.id}/rdo/${p.diarioId}">${esc(p.descricao)}</a> <span class="muted small">${isoBR(p.data)}</span> ${nomeObra(r)}</li>`),
      'Nenhum impedimento ou interferência em aberto.', mais(pend.length)),
    proximas: card('Próximas atividades (14 dias)', proximas.length, corta(proximas).map(({ r, n }) => `<li><a href="#/obra/${r.o.id}/gantt"><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)}</a> <span class="badge">${fmtBR(n.inicio)}</span> ${nomeObra(r)}</li>`),
      'Nenhuma atividade prevista para começar nos próximos 14 dias.', mais(proximas.length)),
    planejamento: card('Pendências de planejamento', planejamento.length, corta(planejamento).map((r) => `<li><a href="#/obra/${r.o.id}/atividades"><b>${esc(r.o.nome)}</b></a><div class="muted small">${r.planejamento.map(esc).join(' · ')}</div></li>`),
      'Nenhuma pendência de planejamento nas obras ativas.'),
    atencao: card('Obras que exigem atenção', atencao.length, corta(atencao).map((r) => `<li><a href="#/obra/${r.o.id}/painel"><b>${esc(r.o.nome)}</b></a> ${[
      ['Atrasada', 'Atenção'].includes(r.situacao) ? `<span class="badge ${SITUACAO[r.situacao]}">${r.situacao}: ${fmtNum(r.av.fisicoReal, 0)}% de ${fmtNum(r.av.fisicoPlan, 0)}%</span>` : '',
      r.pend.length ? `<span class="badge warn">${r.pend.length} pendência(s) no diário</span>` : '',
      veCustos() && r.custos.alertas.length ? '<span class="badge crit">despesas acima do contratado</span>' : ''].join(' ')}</li>`),
      'Nenhuma obra com atraso, pendência ou alerta de custo.'),
  };
}

/* ---------- páginas ---------- */
function cabecalho() {
  const criar = pode('cadastro');
  return `<div class="page-head"><div><h1>Visão geral</h1><div class="muted">Acompanhe suas obras, planejamento e desempenho.</div></div>
    ${criar ? `<div class="row"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div>` : ''}</div>`;
}

function vazio() {
  const criar = pode('cadastro');
  const passos = [
    ['Importe a planilha modelo', 'ela vira a biblioteca de fases (EAP) e de composições', '#/importar'],
    ['Cadastre a obra', 'escolhendo as fases do modelo que entram', null],
    ['Complete o orçamento e os vínculos', 'cada item distribuído 100% entre as atividades', null],
    ['Revise o cronograma e aprove a linha de base', 'Gantt, caminho crítico e Curva S planejada', null],
    ['Registre a execução', 'medições, diário de obra e despesas', null],
  ];
  return `<div class="stack">
    <div class="card card-pad inicio-intro">
      <div class="inicio-vazio-ico">${ICONES.obras}</div>
      <div style="flex:1;min-width:240px">
        <h2 style="margin:0 0 4px">${criar ? 'Boas-vindas ao GEPLAN' : 'Nenhuma obra liberada para você'}</h2>
        <p class="muted" style="margin:0">${criar ? 'Orçamento, planejamento, execução e custos das suas obras em um só lugar: do orçamento por composições ao cronograma, Curva S, medições e diário de obra.'
          : 'Peça ao administrador da empresa para incluir você na equipe de uma obra. Enquanto isso, conheça os módulos abaixo.'}</p>
      </div>
      ${criar ? `<div class="row"><button class="btn primary" data-act="newObra">${I.plus} Cadastrar a primeira obra</button><a class="btn" href="#/importar">${I.upload} Importar planilha</a></div>` : ''}
    </div>
    ${criar ? `<div class="card card-pad"><h2>Como começar</h2><ol class="passos">${passos.map(([t, d, h]) => `<li><b>${h ? `<a href="${h}">${t}</a>` : t}</b> <span class="muted small">— ${d}</span></li>`).join('')}</ol></div>` : ''}
    <h2 style="margin:6px 0 0">O que você pode fazer</h2>
    ${atalhos(true)}
  </div>`;
}

export function viewInicio() {
  const rs = resumos();
  if (!rs.length) return cabecalho() + vazio();
  const k = consolidado(rs);
  const custos = veCustos();
  const s = secoes(rs, 5);
  const ordem = [...rs].sort((a, b) => (b.ativa - a.ativa) || ({ Atrasada: 0, 'Atenção': 1 }[a.situacao] ?? 2) - ({ Atrasada: 0, 'Atenção': 1 }[b.situacao] ?? 2) || a.o.nome.localeCompare(b.o.nome, 'pt-BR'));
  const filtrando = (ui.inicioBusca || '').trim() || ui.inicioStatus || ui.inicioSituacao;
  const filtradas = filtrarObras(ordem);
  const mostrar = filtrando ? filtradas : filtradas.slice(0, 6);
  // painel de atenção: só os quadros com algo a mostrar
  const alertas = [s.atrasadas, s.entregas, s.cotacao, s.diario, s.atencao].filter((x) => x.n);
  return `${cabecalho()}
  <div class="stack">
    <div class="kpis kpis-6">
      ${kpi('Obras ativas', k.ativas, `de ${k.total} cadastrada(s) · sem concluídas e canceladas`, '#/obras')}
      ${kpi('Avanço físico médio', k.avancoMedio == null ? '—' : `${fmtNum(k.avancoMedio, 1)}%`, k.avancoMedio == null ? 'nenhuma obra ativa com avanço calculável' : `média simples de ${k.obrasNoAvanco} obra(s) ativa(s)`, '#/modulo/painel')}
      ${kpi('Atividades atrasadas', k.atrasadas, `${k.pendencias} pendência(s) em aberto no diário`, '#/pendencias', k.atrasadas ? 'var(--crit)' : '')}
      ${custos ? kpi('Custo realizado', k.custoRealizado == null ? '—' : fmtBRL(k.custoRealizado), k.custoRealizado == null ? 'nenhuma despesa lançada' : `soma das despesas de ${k.obrasComDespesas} obra(s)`, '#/modulo/financeiro') : ''}
      ${kpi('Pedidos em andamento', k.temPedidos ? k.pedidosEmAndamento : '—', k.temPedidos ? 'em cotação, aprovados ou entregues em parte' : 'nenhum pedido de compra registrado', '#/modulo/compras')}
      ${kpi('Entregas pendentes', k.temPedidos ? k.entregasPendentes : '—', k.temPedidos ? `${k.entregasAtrasadas} atrasada(s) pela data necessária` : 'nenhum pedido de compra registrado', '#/modulo/compras', k.entregasAtrasadas ? 'var(--crit)' : '')}
    </div>

    <div class="row between" style="flex-wrap:wrap;gap:8px"><h2 style="margin:6px 0 0">Minhas obras</h2><a class="btn sm" href="#/obras">Ver todas as obras</a></div>
    <div class="row filtros-obras">
      <input data-inp="inicioBusca" data-key="inicioBusca" value="${esc(ui.inicioBusca || '')}" placeholder="Buscar por nome, código, cliente ou cidade…" style="flex:1;min-width:200px">
      <select data-chg="inicioStatus" style="width:auto"><option value="">Todos os status</option>${STATUS_OBRA.map((x) => `<option ${x === ui.inicioStatus ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select data-chg="inicioSituacao" style="width:auto"><option value="">Todas as situações</option>${Object.keys(SITUACAO).map((x) => `<option ${x === ui.inicioSituacao ? 'selected' : ''}>${x}</option>`).join('')}</select>
    </div>
    ${mostrar.length ? `<div class="obras-grid">${mostrar.map(cardObra).join('')}</div>${!filtrando && filtradas.length > 6 ? `<a class="small" href="#/obras">+ ${filtradas.length - 6} obra(s) — ver todas →</a>` : ''}`
      : '<div class="card empty"><p>Nenhuma obra encontrada com esses filtros.</p></div>'}

    <h2 style="margin:6px 0 0">Painel de atenção</h2>
    ${alertas.length ? `<div class="grid-2">${alertas.map((x) => x.html).join('')}</div>` : '<div class="card card-pad muted">Nada exige atenção agora: sem atividades ou entregas atrasadas, pedidos em cotação ou pendências no diário.</div>'}

    <h2 style="margin:6px 0 0">Acesso rápido</h2>
    ${atalhos(false)}
    <div class="muted small">Indicadores calculados hoje (${fmtBR(todayDay())}) com os dados salvos das obras às quais você tem acesso, pelas mesmas regras do painel de cada obra. Critérios: <code class="k">js/indicadores.js</code>.</div>
  </div>`;
}

export function viewPendencias() {
  const rs = resumos();
  const s = secoes(rs, 0);
  return `<div class="page-head"><div><h1>Tarefas e pendências</h1><div class="muted">Atrasos, entregas, próximas atividades e pendências do diário e do planejamento de todas as obras ativas.</div></div></div>
    ${rs.length ? `<div class="grid-2">${[s.atrasadas, s.entregas, s.cotacao, s.diario, s.proximas, s.atencao, s.planejamento].map((x) => x.html).join('')}</div>
    <p class="muted small">Ainda não existe cadastro de tarefas livres (atribuídas a pessoas): esta página reúne as pendências que o GEPLAN já registra.</p>`
      : '<div class="card empty"><p>Nenhuma obra cadastrada.</p><a class="btn" href="#/inicio">Ir para a visão geral</a></div>'}`;
}

/* ---------- eventos (busca e filtros de "Minhas obras") ---------- */
export const entradasInicio = { inicioBusca(el) { ui.inicioBusca = el.value; queueRender(); } };
export const mudancasInicio = {
  inicioStatus(d, el) { ui.inicioStatus = el.value; queueRender(); },
  inicioSituacao(d, el) { ui.inicioSituacao = el.value; queueRender(); },
};
