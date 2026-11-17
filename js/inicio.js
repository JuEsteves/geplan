// Visão geral (página inicial) e Tarefas e pendências: consolidam as obras usando os mesmos cálculos das
// telas de cada obra (contexto → indicadores.js). Nenhum dado de demonstração: sem dados, mostra estado vazio.
import * as store from './store.js';
import { esc, I, ui, queueRender, secao, ajuda } from './ui.js';
import { fmtBR, isoBR, fmtNum, fmtBRL, todayDay, todayISO } from './schedule.js';
import { contasAPagar } from './financeiro.js';
import { contexto } from './obra.js';
import { resumoObra, consolidado } from './indicadores.js';
import { pode, veCustos, veFinEmpresa } from './permissoes.js';
import { contasDaEmpresa } from './financeiroEmpresa.js';
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
const kpi = (titulo, valor, sub, href = '', cor = '', area = '', ico = '') => {
  const corpo = `<div class="k-topo">${ico ? `<span class="k-ico">${ICONES[ico]}</span>` : ''}<div class="k-label">${titulo}</div></div><div class="k-value"${cor ? ` style="color:${cor}"` : ''}>${valor}</div><div class="k-sub">${sub}</div>`;
  const attrs = `class="card kpi kpi-area${href ? ' kpi-link' : ''}"${area ? ` data-area="${area}"` : ''}`;
  return href ? `<a ${attrs} href="${href}">${corpo}</a>` : `<div ${attrs}>${corpo}</div>`;
};

/* ---------- módulos (atalhos e apresentação) ---------- */
// `href` = tela real; sem `href` = ainda em desenvolvimento (aparece desabilitado, sem simular funcionamento).
const MODULOS = [
  { grupo: 'Planejamento', area: 'plan', itens: [
    { r: 'Obras', ico: 'obras', href: '#/obras', d: 'Cadastro das obras, cliente, prazos, calendário e equipe.' },
    { r: 'EAP e fases', ico: 'fases', href: '#/fases', d: 'Biblioteca de fases (modelos de EAP) para montar obras.' },
    { r: 'Cronograma', ico: 'gantt', href: '#/modulo/gantt', d: 'Gantt, dependências, caminho crítico e linha de base.' },
    { r: 'Curva S', ico: 'curva', href: '#/modulo/curva', d: 'Planejado × realizado, físico e financeiro.' },
  ] },
  { grupo: 'Orçamentos e custos', area: 'orc', itens: [
    { r: 'Orçamentos', ico: 'orcamento', href: '#/modulo/orcamento', d: 'Itens, composições, BDI, revisões e importação do Excel.' },
    { r: 'Medições', ico: 'medicoes', href: '#/modulo/medicoes', d: nuvemConfigurada() ? 'Medição dos contratos: planilha por % ou por ambiente, retenção e pagamentos.' : 'Avanço físico acumulado de cada atividade.' },
    ...(nuvemConfigurada() ? [{ r: 'Pagamentos', ico: 'custos', href: '#/pagamentos', d: 'Pagamento da sexta-feira, por profissional, balanço das obras e PIX.' }] : []),
    { r: 'Custos', ico: 'custos', href: '#/modulo/financeiro', d: 'Quanto foi orçado, contratado, gasto e pago em cada obra.' },
  ] },
  { grupo: 'Execução e controle', area: 'exec', itens: [
    { r: 'Diário de obra', ico: 'diario', href: '#/diario', d: 'RDO por período, fotos e vídeos, aprovação com assinatura e PDF.' },
    ...(nuvemConfigurada() ? [{ r: 'Contratos', ico: 'tarefas', href: '#/modulo/contratos', d: 'Empreiteiros e prestadores: escopo, valor, parcelas e prazo.' }] : []),
    { r: 'Tarefas e pendências', ico: 'tarefas', href: '#/pendencias', d: 'Atrasos e pendências de todas as obras.' },
  ] },
  // modo nuvem: as compras ficam no Quadro (e aparecem nos Custos da obra); "Compras no Financeiro" só no modo local
  { grupo: 'Suprimentos', area: 'sup', itens: nuvemConfigurada() ? [
    { r: 'Quadro de compras', ico: 'compras', href: '#/suprimentos', d: 'Pedidos com grupos de materiais, cotações e compras, por etapa.' },
    { r: 'Entregas', ico: 'entregas', href: '#/suprimentos/entregas', d: 'Grupos comprados aguardando entrega ou retirada na obra.' },
    { r: 'Fornecedores', ico: 'fornecedores', href: '#/fornecedores', d: 'Cadastro central: contatos, condições, documentos e histórico.' },
  ] : [
    { r: 'Compras no Financeiro', ico: 'custos', href: '#/modulo/compras', d: 'Pedidos de compra registrados nos custos de cada obra.' },
  ] },
  // financeiro da empresa: separado dos custos de cada obra (que ficam com a engenharia)
  { grupo: 'Financeiro da empresa', area: 'fin', itens: [
    { r: 'Contas a pagar', ico: 'custos', href: '#/contas', d: 'O que vence nesta semana e no mês: obras e escritório.' },
    ...(nuvemConfigurada() ? [
      { r: 'Lançamentos da empresa', ico: 'custos', href: '#/fin/lancamentos', d: 'Contas a pagar e a receber com rateio por centro de custo.' },
      { r: 'Contratos com clientes', ico: 'orcamento', href: '#/fin/contratos', d: 'Taxa de administração, verbas com teto e prestação de contas.' },
      { r: 'DRE', ico: 'fisico', href: '#/fin/dre', d: 'A empresa dá lucro? Resultado por mês, da empresa ou de uma obra.' },
      { r: 'Fluxo de caixa', ico: 'curva', href: '#/fin/caixa', d: 'Vai faltar caixa? Previsto × realizado e saldo projetado.' },
      { r: 'Fiscal', ico: 'documentos', href: '#/fin/fiscal', d: 'Notas de serviço com retenções, notas de compra e INSS por obra.' },
      { r: 'Cadastros financeiros', ico: 'config', href: '#/fin/cadastros', d: 'Plano de contas, centros de custo, contas bancárias e regime.' },
    ] : []),
  ] },
];
function atalhos(comDescricao = false) {
  // financeiro da empresa só para quem tem acesso (engenheiro não vê)
  return MODULOS.filter((g) => g.area !== 'fin' || veFinEmpresa()).map((g) => `<div class="atalhos-grupo" data-area="${g.area}"><div class="atalhos-titulo">${esc(g.grupo)}</div><div class="atalhos">${g.itens.map((m) => {
    const corpo = `<span class="atalho-ico">${ICONES[m.ico]}</span><span><b>${esc(m.r)}</b>${comDescricao ? `<small>${esc(m.d)}</small>` : m.href ? '' : '<small>em desenvolvimento</small>'}</span>${m.href || !comDescricao ? '' : '<span class="badge">em desenvolvimento</span>'}`;
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
    atrasadas: card('Atividades atrasadas', atrasadas.length, corta(atrasadas).map(({ r, n }) => `<li><a href="#/obra/${r.o.id}/medicoes/avanco"><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)}</a> ${nomeObra(r)}</li>`),
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
    ${criar ? `<div class="row"><button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div>` : ''}</div>`;
}

function vazio() {
  const criar = pode('cadastro');
  const passos = [
    ['Crie a obra', 'pelo modelo de etapas do GEPLAN, por uma lista em branco ou pela obra de exemplo, que já vem preenchida', null],
    ['Ajuste as etapas', 'inclua, mova ou exclua etapas e atividades: nenhuma obra é igual', null],
    ['Monte o orçamento e ligue às atividades', 'as quantidades calculam a duração de cada serviço', null],
    ['Revise o cronograma', 'prazos, sequência dos serviços e curva de avanço planejada', null],
    ['Acompanhe a execução e os custos', 'diário de obra, medições, compras e despesas', null],
  ];
  return `<div class="stack">
    <div class="card card-pad inicio-intro">
      <div class="inicio-vazio-ico">${ICONES.obras}</div>
      <div style="flex:1;min-width:240px">
        <h2 style="margin:0 0 4px">${criar ? 'Boas-vindas ao GEPLAN' : 'Nenhuma obra liberada para você'}</h2>
        <p class="muted" style="margin:0">${criar ? 'Planejamento, orçamento, compras, diário, medições e custos das suas obras em um só lugar. Para conhecer, crie uma obra e escolha "Obra de exemplo": ela já vem com etapas, orçamento, cronograma e custos preenchidos.'
          : 'Peça ao administrador da empresa para incluir você na equipe de uma obra. Enquanto isso, conheça os módulos abaixo.'}</p>
      </div>
      ${criar ? `<div class="row"><button class="btn primary" data-act="newObra">${I.plus} Cadastrar a primeira obra</button></div>` : ''}
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
  const obrasCorpo = `<div class="row filtros-obras">
      <input data-inp="inicioBusca" data-key="inicioBusca" value="${esc(ui.inicioBusca || '')}" placeholder="Buscar por nome, código, cliente ou cidade…" style="flex:1;min-width:220px">
      <select data-chg="inicioStatus" style="width:auto;min-width:170px"><option value="">Todos os status</option>${STATUS_OBRA.map((x) => `<option ${x === ui.inicioStatus ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select data-chg="inicioSituacao" style="width:auto;min-width:180px"><option value="">Todas as situações</option>${Object.keys(SITUACAO).map((x) => `<option ${x === ui.inicioSituacao ? 'selected' : ''}>${x}</option>`).join('')}</select>
    </div>
    ${mostrar.length ? `<div class="obras-grid">${mostrar.map(cardObra).join('')}</div>${!filtrando && filtradas.length > 6 ? `<a class="small" href="#/obras">+ ${filtradas.length - 6} obra(s) — ver todas →</a>` : ''}`
      : '<div class="card empty"><p>Nenhuma obra encontrada com esses filtros.</p></div>'}`;
  // coluna da direita: resumo do que pede atenção (só dados reais; vazio = nada a mostrar)
  const lateral = `<aside class="lateral">
      <div class="lateral-titulo">Painel de atenção ${ajuda('Itens das obras ativas que pedem ação: atividades e entregas atrasadas, pedidos em cotação, pendências do diário e obras com alerta. Lista completa em Tarefas e pendências.')}</div>
      ${alertas.length ? alertas.map((x) => x.html).join('') : '<div class="card card-pad muted small">Nada exige atenção agora: sem atividades ou entregas atrasadas, pedidos em cotação ou pendências no diário.</div>'}
      <a class="btn sm" href="#/pendencias" style="width:100%">Ver todas as pendências</a>
    </aside>`;
  return `${cabecalho()}
  <div class="stack">
    <div class="kpis kpis-6">
      ${kpi('Obras ativas', k.ativas, `de ${k.total} cadastrada(s) · sem concluídas e canceladas`, '#/obras', '', 'visao', 'obras')}
      ${kpi('Avanço físico médio', k.avancoMedio == null ? '—' : `${fmtNum(k.avancoMedio, 1)}%`, k.avancoMedio == null ? 'nenhuma obra ativa com avanço calculável' : `média simples de ${k.obrasNoAvanco} obra(s) ativa(s)`, '#/modulo/painel', '', 'plan', 'fisico')}
      ${kpi('Atividades atrasadas', k.atrasadas, `${k.pendencias} pendência(s) em aberto no diário`, '#/pendencias', k.atrasadas ? 'var(--crit)' : '', 'exec', 'tarefas')}
      ${custos ? kpi('Custo realizado', k.custoRealizado == null ? '—' : fmtBRL(k.custoRealizado), k.custoRealizado == null ? 'nenhuma despesa lançada' : `soma das despesas de ${k.obrasComDespesas} obra(s)`, '#/modulo/financeiro', '', 'orc', 'custos') : ''}
      ${kpi('Pedidos em andamento', k.temPedidos ? k.pedidosEmAndamento : '—', k.temPedidos ? 'em cotação, aprovados ou entregues em parte' : 'nenhum pedido de compra registrado', '#/modulo/compras', '', 'sup', 'compras')}
      ${kpi('Entregas pendentes', k.temPedidos ? k.entregasPendentes : '—', k.temPedidos ? `${k.entregasAtrasadas} atrasada(s) pela data necessária` : 'nenhum pedido de compra registrado', '#/modulo/compras', k.entregasAtrasadas ? 'var(--crit)' : '', 'sup', 'entregas')}
    </div>
    <div class="com-lateral">
      <div class="stack">
        ${secao({ id: 'inicio:atalhos', titulo: 'Acesso rápido', corpo: `<div class="atalhos-areas">${atalhos(false)}</div>`, area: 'visao' })}
        ${secao({ id: 'inicio:obras', titulo: 'Minhas obras', n: filtradas.length, corpo: obrasCorpo, area: 'plan', acoes: '<a class="btn sm" href="#/obras">Ver todas as obras</a>' })}
        <div class="muted small">Indicadores calculados hoje (${fmtBR(todayDay())}) com os dados salvos das obras às quais você tem acesso, pelas mesmas regras do painel de cada obra. ${ajuda('Critérios em js/indicadores.js. Nenhum número desta página é estimado ou de demonstração: sem dados, aparece "—".')}</div>
      </div>
      ${lateral}
    </div>
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

/* ---------- Contas a pagar (todas as obras) ---------- */
const GRUPOS_CONTAS = [
  ['vencidas', 'Vencidas', 'crit'], ['semana', 'Vencem nos próximos 7 dias', 'warn'], ['mes', 'Vencem em até 30 dias', ''],
  ['depois', 'Vencem depois de 30 dias', ''], ['semData', 'Sem data de vencimento', ''],
];
export function viewContasAPagar() {
  const cab = `<div class="page-head"><div><h1>Contas a pagar</h1><div class="muted">O que a empresa tem a pagar — despesas das obras e contas do escritório — pela data de vencimento.</div></div></div>`;
  if (!veCustos() || !veFinEmpresa()) return `${cab}<div class="card empty"><p>Seu perfil não acessa o financeiro da empresa.</p></div>`;
  const obras = store.obras();
  const empresa = contasDaEmpresa();
  const { contas, totais } = contasAPagar(obras, todayISO(), empresa.lista);
  if (!contas.length) {
    return `${cab}<div class="card empty"><p>${empresa.pronto ? 'Nenhuma conta a pagar.' : 'Carregando…'}</p><p class="small muted">As contas aparecem aqui quando uma despesa é lançada em <b>Custos</b> da obra (ou um lançamento em <b>Lançamentos da empresa</b>) sem pagamento, ou com pagamento parcial.</p></div>`;
  }
  const cartao = (t, v, s, cor = '') => `<div class="card kpi"><div class="k-label">${t}</div><div class="k-value" style="font-size:19px${cor ? `;color:${cor}` : ''}">${fmtBRL(v)}</div><div class="k-sub">${s}</div></div>`;
  const tabela = (lista) => `<div class="card table-wrap"><table class="data"><thead><tr><th>Vencimento</th><th>Obra</th><th>Fornecedor / descrição</th><th>Documento</th><th class="num">Valor</th><th class="num">Já pago</th><th class="num">A pagar</th><th></th></tr></thead><tbody>
    ${lista.map((c) => `<tr><td class="nowrap">${c.vencimento ? isoBR(c.vencimento) : '<span class="muted">—</span>'}</td><td>${esc(c.obra)}</td>
      <td>${esc(c.fornecedor)}<div class="small muted">${esc(c.descricao)}</div></td><td>${esc(c.documento)}</td>
      <td class="num nowrap">${fmtBRL(c.valor)}</td><td class="num nowrap">${c.pago ? fmtBRL(c.pago) : '—'}</td><td class="num nowrap"><b>${fmtBRL(c.saldo)}</b></td>
      <td class="nowrap">${c.empresa ? '<a class="btn sm" href="#/fin/lancamentos">Abrir</a>' : `<a class="btn sm" href="#/obra/${c.obraId}/financeiro">Abrir na obra</a>`}</td></tr>`).join('')}
    </tbody><tfoot><tr><th colspan="6">Total</th><th class="num nowrap">${fmtBRL(lista.reduce((s, c) => s + c.saldo, 0))}</th><th></th></tr></tfoot></table></div>`;
  return `${cab}<div class="stack">
    <div class="kpis">
      ${cartao('Total a pagar', totais.total, `${contas.length} conta${contas.length > 1 ? 's' : ''}: ${new Set(contas.filter((c) => !c.empresa).map((c) => c.obraId)).size} obra(s)${contas.some((c) => c.empresa) ? ' e empresa' : ''}`)}
      ${cartao('Vencidas', totais.vencidas, 'antes de hoje', totais.vencidas ? 'var(--crit)' : '')}
      ${cartao('Próximos 7 dias', totais.semana, 'inclui as de hoje')}
      ${cartao('Até 30 dias', totais.mes, 'do 8º ao 30º dia')}
    </div>
    ${GRUPOS_CONTAS.map(([g, titulo, cor]) => {
      const l = contas.filter((c) => c.grupo === g);
      return l.length ? `<div class="row"><h2 style="flex:1;margin:0">${titulo} <span class="badge ${cor}">${l.length}</span></h2></div>${tabela(l)}` : '';
    }).join('')}
    <div class="muted small">Para registrar o pagamento: despesa de obra, abra em <b>Custos</b> da obra e inclua a data e o valor pagos; conta da empresa, use "Pagar" em <a href="#/fin/lancamentos">Lançamentos da empresa</a>. Despesa sem data de vencimento aparece no fim: informe o vencimento para ela entrar na semana certa. Os pagamentos de mão de obra por medição ficam em <a href="#/pagamentos">Pagamentos de mão de obra</a>.</div>
  </div>`;
}

/* ---------- eventos (busca e filtros de "Minhas obras") ---------- */
export const entradasInicio = { inicioBusca(el) { ui.inicioBusca = el.value; queueRender(); } };
export const mudancasInicio = {
  inicioStatus(d, el) { ui.inicioStatus = el.value; queueRender(); },
  inicioSituacao(d, el) { ui.inicioSituacao = el.value; queueRender(); },
};
