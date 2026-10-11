// Visão geral (página inicial) e Tarefas e pendências: consolidam as obras usando os mesmos cálculos das
// telas de cada obra (contexto → indicadores.js). Nenhum dado de demonstração: sem dados, mostra estado vazio.
import * as store from './store.js';
import { esc, I } from './ui.js';
import { fmtBR, isoBR, fmtNum, fmtBRL, todayDay } from './schedule.js';
import { contexto } from './obra.js';
import { resumoObra, consolidado } from './indicadores.js';
import { pode } from './permissoes.js';
import { ICONES } from './navegacao.js';

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
const card = (titulo, valor, sub, cor = '') => `<div class="card kpi"><div class="k-label">${titulo}</div><div class="k-value"${cor ? ` style="color:${cor}"` : ''}>${valor}</div><div class="k-sub">${sub}</div></div>`;
const lista = (itens, vazio) => (itens.length ? `<ul class="lista">${itens.join('')}</ul>` : `<div class="muted small" style="padding:6px 0">${vazio}</div>`);
const barra = (plan, real) => `<div class="progress duo" title="planejado ${fmtNum(plan, 0)}% · realizado ${fmtNum(real, 0)}%"><div class="p" style="width:${Math.min(100, plan)}%"></div><div class="r" style="width:${Math.min(100, real)}%"></div></div>`;

function cardObra(r) {
  const o = r.o;
  return `<a class="card obra-card" href="#/obra/${o.id}/painel">
    <div class="row between" style="gap:8px"><b>${esc(o.nome)}</b><span class="badge ${SITUACAO[r.situacao] ?? ''}">${esc(r.situacao)}</span></div>
    <div class="muted small" style="margin-top:2px">${esc(o.status || 'Planejamento')}${o.codigo ? ` · ${esc(o.codigo)}` : ''}</div>
    <div class="meta">
      <div>Início<b>${o.inicio ? isoBR(o.inicio) : '—'}</b></div>
      <div>Previsão de término<b>${r.termino ? fmtBR(r.termino) : o.terminoPlanejado ? isoBR(o.terminoPlanejado) : '—'}</b></div>
    </div>
    ${r.temAvanco ? `<div style="margin-top:10px"><div class="row between small"><span>Avanço físico</span><b>${fmtNum(r.av.fisicoReal, 1)}%</b></div>${barra(r.av.fisicoPlan, r.av.fisicoReal)}<div class="muted small">planejado para hoje: ${fmtNum(r.av.fisicoPlan, 1)}%</div></div>`
      : `<div class="muted small" style="margin-top:10px">${r.temEap ? 'Avanço físico sem peso definido (vincule o orçamento ou escolha outro critério de peso).' : 'Sem atividades: monte a EAP para acompanhar o avanço.'}</div>`}
  </a>`;
}

/** Listas de pendências (usadas na Visão geral, resumidas, e em Tarefas e pendências, completas). */
function secoesPendencias(rs, limite) {
  const ativas = rs.filter((x) => x.ativa);
  const corta = (arr) => (limite ? arr.slice(0, limite) : arr);
  const atrasadas = ativas.flatMap((r) => r.atrasadas.map((n) => ({ r, n })));
  const proximas = ativas.flatMap((r) => r.proximas.map((n) => ({ r, n }))).sort((a, b) => a.n.inicio - b.n.inicio);
  const atencao = ativas.filter((r) => ['Atrasada', 'Atenção'].includes(r.situacao) || r.pend.length || r.custos.alertas.length);
  const planejamento = ativas.filter((r) => r.planejamento.length);
  const pend = ativas.flatMap((r) => r.pend.map((p) => ({ r, p })));
  const nomeObra = (r) => `<span class="muted small">· ${esc(r.o.nome)}</span>`;
  const mais = (total) => (limite && total > limite ? `<a class="small" href="#/pendencias">Ver todas (${total}) →</a>` : '');
  return {
    atrasadas: `<div class="card card-pad"><h2>Atividades atrasadas (${atrasadas.length})</h2>${lista(corta(atrasadas).map(({ r, n }) => `<li><a href="#/obra/${r.o.id}/medicoes"><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)}</a> ${nomeObra(r)}</li>`),
      ativas.some((r) => r.temEap) ? 'Nenhuma atividade atrasada pelas medições registradas.' : 'Sem atividades cadastradas.')}${mais(atrasadas.length)}</div>`,
    proximas: `<div class="card card-pad"><h2>Próximas atividades (14 dias)</h2>${lista(corta(proximas).map(({ r, n }) => `<li><a href="#/obra/${r.o.id}/gantt"><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)}</a> <span class="badge">${fmtBR(n.inicio)}</span> ${nomeObra(r)}</li>`),
      'Nenhuma atividade prevista para começar nos próximos 14 dias.')}${mais(proximas.length)}</div>`,
    atencao: `<div class="card card-pad"><h2>Obras que exigem atenção (${atencao.length})</h2>${lista(corta(atencao).map((r) => `<li><a href="#/obra/${r.o.id}/painel"><b>${esc(r.o.nome)}</b></a> ${[
      ['Atrasada', 'Atenção'].includes(r.situacao) ? `<span class="badge ${SITUACAO[r.situacao]}">${r.situacao}: ${fmtNum(r.av.fisicoReal, 0)}% de ${fmtNum(r.av.fisicoPlan, 0)}%</span>` : '',
      r.pend.length ? `<span class="badge warn">${r.pend.length} pendência(s) no diário</span>` : '',
      r.custos.alertas.length ? '<span class="badge crit">despesas acima do contratado</span>' : ''].join(' ')}</li>`),
      'Nenhuma obra com atraso, pendência ou alerta de custo.')}</div>`,
    planejamento: `<div class="card card-pad"><h2>Pendências de planejamento</h2>${lista(corta(planejamento).map((r) => `<li><a href="#/obra/${r.o.id}/atividades"><b>${esc(r.o.nome)}</b></a><div class="muted small">${r.planejamento.map(esc).join(' · ')}</div></li>`),
      'Nenhuma pendência de planejamento nas obras ativas.')}</div>`,
    diario: `<div class="card card-pad"><h2>Pendências do diário (${pend.length})</h2>${lista(corta(pend).map(({ r, p }) => `<li><span class="badge warn">${esc(p.tipo)}</span> <a href="#/obra/${r.o.id}/diario">${esc(p.descricao)}</a> <span class="muted small">${isoBR(p.data)}</span> ${nomeObra(r)}</li>`),
      'Nenhum impedimento ou interferência em aberto.')}${mais(pend.length)}</div>`,
  };
}

export function viewInicio() {
  const rs = resumos();
  const k = consolidado(rs);
  const criar = pode('cadastro');
  const cabecalho = `<div class="page-head"><div><h1>Visão geral</h1><div class="muted">Acompanhe suas obras, planejamento e desempenho.</div></div>
    ${criar ? `<div class="row"><a class="btn" href="#/importar">${I.upload} Importar planilha</a><button class="btn primary" data-act="newObra">${I.plus} Nova obra</button></div>` : ''}</div>`;
  if (!rs.length) {
    return `${cabecalho}<div class="card empty inicio-vazio">
      <div class="inicio-vazio-ico">${ICONES.obras}</div>
      <h2>Nenhuma obra cadastrada</h2>
      <p class="muted">${criar ? 'Cadastre a primeira obra para acompanhar orçamento, cronograma, Curva S, medições e diário. Se você já tem a planilha modelo, importe-a: ela vira o modelo de fases das próximas obras.'
        : 'Nenhuma obra foi liberada para o seu perfil ainda. Peça ao administrador da empresa para incluir você na equipe de uma obra.'}</p>
      ${criar ? `<div class="row" style="justify-content:center"><button class="btn primary" data-act="newObra">${I.plus} Cadastrar a primeira obra</button><a class="btn" href="#/importar">${I.upload} Importar planilha</a></div>` : ''}
    </div>`;
  }
  const s = secoesPendencias(rs, 5);
  const ordem = [...rs].sort((a, b) => (b.ativa - a.ativa) || ({ Atrasada: 0, 'Atenção': 1 }[a.situacao] ?? 2) - ({ Atrasada: 0, 'Atenção': 1 }[b.situacao] ?? 2) || a.o.nome.localeCompare(b.o.nome, 'pt-BR'));
  const atalhos = [
    criar ? `<button class="atalho" data-act="newObra">${ICONES.obras}<span>Nova obra</span></button>` : '',
    `<a class="atalho" href="#/modulo/orcamento">${ICONES.orcamento}<span>Orçamento</span></a>`,
    `<a class="atalho" href="#/fases">${ICONES.fases}<span>EAP e fases</span></a>`,
    `<a class="atalho" href="#/modulo/gantt">${ICONES.gantt}<span>Cronograma</span></a>`,
    `<a class="atalho" href="#/modulo/curva">${ICONES.curva}<span>Curva S</span></a>`,
    `<a class="atalho" href="#/modulo/diario">${ICONES.diario}<span>Diário de obra</span></a>`,
  ].join('');
  return `${cabecalho}
  <div class="stack">
    <div class="kpis">
      ${card('Obras ativas', k.ativas, `de ${k.total} cadastrada(s) · exclui concluídas e canceladas`)}
      ${card('Avanço físico médio', k.avancoMedio == null ? '—' : `${fmtNum(k.avancoMedio, 1)}%`, k.avancoMedio == null ? 'nenhuma obra ativa com avanço calculável' : `média simples de ${k.obrasNoAvanco} obra(s) ativa(s)`)}
      ${card('Atividades atrasadas', k.atrasadas, `${k.pendencias} pendência(s) em aberto no diário`, k.atrasadas ? 'var(--crit)' : '')}
      ${card('Custo realizado', k.custoRealizado == null ? '—' : fmtBRL(k.custoRealizado), k.custoRealizado == null ? 'nenhuma despesa lançada' : `despesas lançadas em ${k.obrasComDespesas} obra(s)`)}
    </div>
    <div class="row between"><h2 style="margin:6px 0 0">Minhas obras</h2><a class="btn sm" href="#/obras">Ver todas as obras</a></div>
    <div class="obras-grid">${ordem.slice(0, 6).map(cardObra).join('')}</div>
    <h2 style="margin:6px 0 0">Acesso rápido</h2>
    <div class="atalhos">${atalhos}</div>
    <div class="grid-2">${s.atrasadas}${s.proximas}${s.atencao}${s.planejamento}</div>
    <div class="muted small">Indicadores calculados hoje (${fmtBR(todayDay())}) com os dados salvos das obras, pelas mesmas regras do painel de cada obra. Critérios: <code class="k">js/indicadores.js</code>.</div>
  </div>`;
}

export function viewPendencias() {
  const rs = resumos();
  const s = secoesPendencias(rs, 0);
  return `<div class="page-head"><div><h1>Tarefas e pendências</h1><div class="muted">Atrasos, próximas atividades, pendências do diário e do planejamento de todas as obras ativas.</div></div></div>
    ${rs.length ? `<div class="grid-2">${s.atrasadas}${s.diario}${s.proximas}${s.atencao}${s.planejamento}</div>
    <p class="muted small">Ainda não existe cadastro de tarefas livres (atribuídas a pessoas): esta página reúne as pendências que o GEPLAN já registra.</p>`
      : '<div class="card empty"><p>Nenhuma obra cadastrada.</p><a class="btn" href="#/inicio">Ir para a visão geral</a></div>'}`;
}
