// Diário de obra (RDO): lista de obras em cards, painel de cada obra (visão geral, lista de tarefas, relatórios, filtro
// de busca, editar obra), cadastro do relatório em seções, visualização para impressão, PDF (relatório, período ou fase),
// fotos/vídeos/anexos, comentários, revisão e aprovação com assinatura, histórico e visualizações.
// O relatório em si fica no documento da obra (funciona sem internet e sincroniza); mídias, comentários, histórico,
// aprovação e assinaturas usam o banco e o armazenamento privado (modo nuvem, migração 0008). Atividades e fases são
// as da EAP da obra — não há cadastro paralelo.
import * as store from './store.js';
import { esc, I, ui, toast, ask, info, formDialog, commit, queueRender, parseNum, fmtIn } from './ui.js';
import { isoBR, todayISO, fmtNum } from './schedule.js';
import { STATUS_OBRA, TIPOS_OCORRENCIA, registrar } from './model.js';
import {
  STATUS_RDO, SITUACOES_ATIVIDADE, periodoRdo, diasDaSemanaRdo, badgeRdo, novoDiario, salvarDiario, filtrarDiario, prazosObra,
  avancoAte, idsDaFase, fimRdo, pendenciasAbertas,
} from './execucao.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import {
  enviarArquivo, enviarBlob, urlsTemporarias, urlEmCache, urlTemporaria, ACCEPT, TIPOS_ACEITOS, TIPOS_VIDEO, TIPOS_IMAGEM,
  TAMANHO_MAX_OBRA, TAMANHO_MAX_VIDEO, tamanhoLegivel, validarArquivo,
} from './nuvem/arquivos.js';
import { pode, liberado } from './permissoes.js';
import { obraEmFoco, ir, rota } from './escopo.js';
import { savedUser } from './drive.js';
import { LIBS, loadScript } from './libs.js';

const CLIMAS = ['Bom', 'Nublado', 'Chuva fraca', 'Chuva forte', 'Impraticável'];
const SECOES = [['geral', 'Visão geral', 'inicio'], ['tarefas', 'Lista de tarefas', 'tarefas'], ['relatorios', 'Relatórios', 'diario'], ['busca', 'Filtro de busca', 'fisico'], ['editar', 'Editar obra', 'config']];
const X = { midias: new Map(), comentarios: new Map(), detalhes: new Map(), carregado: false, carregando: false, erro: '', logo: null, vistos: new Set() };

const nuvemOn = () => nuvemConfigurada() && nuvem.ativo();
const ctx = () => nuvem.contexto();
const quem = () => ctx()?.email || savedUser()?.emailAddress || '';
const podePreencher = () => pode('execucao');
const podeAprovar = () => (nuvemOn() ? liberado('aprovar_rdo') : true);
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const folhas = (o) => (o.eap || []).filter((a) => !(o.eap || []).some((x) => x.parentId === a.id));
const fases = (o) => (o.eap || []).filter((a) => a.nivel <= 2 && (o.eap || []).some((x) => x.parentId === a.id));
const ativ = (o, id) => (o.eap || []).find((a) => a.id === id);
const raiz = (o, id) => { let a = ativ(o, id); while (a?.parentId) a = ativ(o, a.parentId); return a; };
const qtd = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 }));
const ICO = {
  rel: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/></svg>',
  foto: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  video: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  com: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  lista: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/></svg>',
};

/* ---------- dados da nuvem (mídias, comentários, histórico, visualizações, logo) ---------- */
export async function carregarDiarioNuvem(forcar = false) {
  if (!nuvemOn() || X.carregando || (X.carregado && !forcar)) return;
  X.carregando = true; X.erro = '';
  try {
    const ids = store.obras().map((o) => o.id);
    const c = await sb();
    const [mid, com, org] = await Promise.all([
      ids.length ? c.from('rdo_media').select('*').in('project_id', ids).is('deleted_at', null).order('created_at', { ascending: false }) : { data: [] },
      ids.length ? c.from('rdo_comments').select('*').in('project_id', ids).is('deleted_at', null).order('created_at') : { data: [] },
      c.from('organizations').select('logo_path').eq('id', ctx().orgId).maybeSingle(),
    ]);
    X.midias = agrupar(ok(mid, 'mídias') || [], 'project_id');
    X.comentarios = agrupar(ok(com, 'comentários') || [], 'report_id');
    X.logo = ok(org, 'empresa')?.logo_path || '';
    X.carregado = true;
  } catch (e) { X.erro = e.message; }
  X.carregando = false;
  queueRender();
}
async function carregarDetalhe(rid) {
  const c = await sb();
  const [ev, vw] = await Promise.all([
    c.from('rdo_events').select('*').eq('report_id', rid).order('id'),
    c.from('rdo_views').select('*').eq('report_id', rid).order('last_at', { ascending: false }),
  ]);
  X.detalhes.set(rid, { eventos: ok(ev, 'histórico') || [], vistas: ok(vw, 'visualizações') || [] });
  queueRender();
}
function agrupar(linhas, campo) {
  const m = new Map();
  for (const l of linhas) { if (!m.has(l[campo])) m.set(l[campo], []); m.get(l[campo]).push(l); }
  return m;
}
export function limparDiario() { Object.assign(X, { midias: new Map(), comentarios: new Map(), detalhes: new Map(), carregado: false, carregando: false, erro: '', logo: null, vistos: new Set() }); }
const midiasObra = (pid) => X.midias.get(pid) || [];
const midiasRdo = (o, rid) => midiasObra(o.id).filter((m) => m.report_id === rid).sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
const contar = (o) => {
  const ms = midiasObra(o.id);
  return { rel: (o.diario || []).length, fotos: ms.filter((m) => m.kind === 'foto').length, videos: ms.filter((m) => m.kind === 'video' || m.kind === 'link').length,
    com: (o.diario || []).reduce((a, d) => a + (X.comentarios.get(d.id) || []).length, 0) };
};

/** Imagens do armazenamento privado: a tela marca <img data-path> e, depois de desenhada, recebe os links temporários. */
export async function depoisDiario() {
  ligarFormRdo();
  const els = [...document.querySelectorAll('#view [data-path]:not([data-ok]), #dlg [data-path]:not([data-ok])')];
  const caminhos = els.map((e) => e.dataset.path).filter((p) => p && !p.startsWith('data:'));
  for (const e of els) if (e.dataset.path.startsWith('data:')) { e.src = e.dataset.path; e.dataset.ok = '1'; }
  if (!caminhos.length || !nuvemOn()) return;
  try {
    const urls = await urlsTemporarias(caminhos);
    for (const e of els) { const u = urls.get(e.dataset.path); if (u) { if (e.tagName === 'A') e.href = u; else e.src = u; e.dataset.ok = '1'; } }
    for (const e of document.querySelectorAll('#view img[data-path]:not([data-ok])')) e.classList.add('img-indisponivel');
  } catch { /* sem internet: imagens ficam com o espaço reservado */ }
}
const img = (caminho, cls = '', alt = '') => (caminho ? `<img class="${cls}" data-path="${esc(caminho)}" ${urlEmCache(caminho) ? `src="${esc(urlEmCache(caminho))}" data-ok="1"` : ''} alt="${esc(alt)}" loading="lazy">` : '');

/* ---------- telas ---------- */
export function viewDiario(route) {
  if (nuvemOn() && !X.carregado && !X.carregando) setTimeout(() => carregarDiarioNuvem());
  if (!route.obra) return viewObras();
  const o = store.obra(route.obra);
  if (!o) return '<div class="card empty"><p>Obra não encontrada (ou sem acesso).</p><a class="btn" href="#/diario">Voltar</a></div>';
  if (route.secao === 'rdo') return route.modo === 'editar' ? viewRdoEditar(o, route.id) : viewRdo(o, route.id);
  return viewPainelObra(o, route.secao || 'geral');
}

function viewObras() {
  const f = ui.diarioObras ||= { busca: '', status: '' };
  const t = f.busca.trim().toLowerCase();
  const lista = store.obras().filter((o) => (!f.status || (o.status || 'Planejamento') === f.status)
    && (!t || `${o.nome} ${o.codigo} ${o.cidade} ${o.cliente?.nome || ''}`.toLowerCase().includes(t)));
  return `<div class="page-head"><div><h1>Diário de obra</h1><div class="muted">Relatórios diários (RDO), fotos, vídeos e acompanhamento de cada obra.</div></div></div>
  <div class="row filtros-obras">
    <input data-inp="diarioObrasBusca" data-key="diarioObrasBusca" value="${esc(f.busca)}" placeholder="Pesquisar obra…" style="flex:1;min-width:200px">
    <select data-chg="diarioObrasStatus" style="width:auto"><option value="">Todos os status</option>${STATUS_OBRA.map((s) => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <span class="muted small">${lista.length} obra(s)</span>
  </div>
  ${lista.length ? `<div class="diario-cards">${lista.map((o) => {
    const n = contar(o);
    return `<a class="card diario-card" href="#/diario/${o.id}">
      <div class="diario-capa">${o.capa ? img(o.capa, '', o.nome) : `<span class="diario-capa-vazia">${esc((o.nome || '?').trim()[0] || '?')}</span>`}<span class="badge info diario-selo">${esc(o.status || 'Planejamento')}</span></div>
      <div class="diario-card-corpo"><div class="diario-contadores muted small"><span title="Relatórios">${ICO.rel} ${n.rel}</span>${nuvemOn() ? `<span title="Fotos">${ICO.foto} ${n.fotos}</span><span title="Vídeos">${ICO.video} ${n.videos}</span>` : ''}</div>
      <div class="diario-card-nome">${esc(o.nome)}</div></div></a>`;
  }).join('')}</div>` : '<div class="card empty"><p>Nenhuma obra encontrada.</p></div>'}`;
}

function viewPainelObra(o, secao) {
  const n = contar(o);
  const nav = SECOES.map(([k, rot]) => {
    if (k === 'editar' && !pode('cadastro')) return '';
    const cont = k === 'tarefas' ? folhas(o).length : k === 'relatorios' ? n.rel : '';
    return `<a href="#/diario/${o.id}/${k}" class="${k === secao ? 'active' : ''}" ${k === secao ? 'aria-current="page"' : ''}><span>${esc(rot)}</span>${cont !== '' ? `<span class="badge">${cont}</span>` : ''}</a>`;
  }).join('');
  const corpo = { geral: secaoGeral, tarefas: secaoTarefas, relatorios: secaoRelatorios, busca: secaoBusca, editar: secaoEditar }[secao] || secaoGeral;
  // dentro da página da obra, o nome e o "voltar" já estão no cabeçalho da obra
  return `<div class="page-head"><div>${obraEmFoco() ? '<h1>Diário de obra</h1>' : `<a class="muted small" href="#/diario">← Diário de obra</a><h1>${esc(o.nome)}</h1>`}</div>
    ${podePreencher() ? `<a class="btn primary" href="#/diario/${o.id}/rdo/novo/editar">${I.plus} Novo relatório</a>` : ''}</div>
  <div class="diario-layout">
    <aside class="diario-lado card">${o.capa ? img(o.capa, 'diario-lado-capa', o.nome) : `<div class="diario-lado-capa diario-capa-vazia">${esc((o.nome || '?')[0])}</div>`}<nav class="diario-nav">${nav}</nav></aside>
    <div class="stack" style="min-width:0">${X.erro ? `<div class="alert err small">${esc(X.erro)}</div>` : ''}${corpo(o, n)}</div>
  </div>`;
}

function infoObra(o) {
  const pz = prazosObra(o, todayISO());
  const campo = (rot, v) => `<div><span class="muted small">${rot}</span><div>${v || '—'}</div></div>`;
  return `<div class="card card-pad stack"><div class="row between"><h2>Informações da obra</h2>${pode('cadastro') ? `<a class="small" href="#/diario/${o.id}/editar">Editar</a>` : ''}</div>
    <div class="ficha-campos">
      ${campo('Status', `<span class="badge info">${esc(o.status || 'Planejamento')}</span>`)}${campo('Nº do contrato', esc(o.numeroContrato || ''))}
      ${campo('Endereço', esc([o.endereco, o.cidade].filter(Boolean).join(' — ')))}${campo('Responsável', esc(o.engenheiro || ''))}${campo('Contratante', esc(o.cliente?.nome || ''))}
      ${campo('Data de início', isoBR(o.inicioReal || o.inicio))}${campo('Previsão de término', o.terminoPlanejado ? isoBR(o.terminoPlanejado) : '')}
      ${pz ? `${campo('Prazo contratual', `${pz.contratual} dias`)}${campo('Prazo decorrido', `${pz.decorrido} dias`)}${campo('Prazo a vencer', pz.vencido ? '<span class="badge crit">vencido</span>' : `${pz.aVencer} dias`)}` : ''}
    </div>
    ${pz ? `<div><div class="muted small">Prazo decorrido</div><div class="barra barra-alta"><span style="width:${pz.pct}%"></span></div><div class="small">${pz.pct}%</div></div>`
      : '<div class="muted small">Informe início e previsão de término para calcular os prazos.</div>'}
    <div class="muted small">Prazos em dias corridos, do início (real, se houver) até a previsão de término.</div></div>`;
}

function secaoGeral(o, n) {
  const recentes = [...(o.diario || [])].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 7);
  const fotos = midiasObra(o.id).filter((m) => m.kind === 'foto').slice(0, 12);
  const kpi = (v, rot, ico) => `<div class="card kpi kpi-diario"><div class="k-value">${v}</div><div class="row between"><span class="k-label">${rot}</span>${ico}</div></div>`;
  return `<div class="kpis kpis-5">${kpi(n.rel, 'Relatórios', ICO.rel)}${kpi(folhas(o).length, 'Atividades', ICO.lista)}${kpi(nuvemOn() ? n.com : '—', 'Comentários', ICO.com)}${kpi(nuvemOn() ? n.fotos : '—', 'Fotos', ICO.foto)}${kpi(nuvemOn() ? n.videos : '—', 'Vídeos', ICO.video)}</div>
    <div class="grid-2">
      <div class="card card-pad stack"><div class="row between"><h2>Relatórios recentes</h2><a class="small" href="#/diario/${o.id}/relatorios">Ver tudo</a></div>
        ${recentes.length ? tabelaRelatorios(o, recentes) : '<div class="muted small">Nenhum relatório ainda.</div>'}</div>
      <div class="card card-pad stack"><div class="row between"><h2>Fotos recentes</h2><a class="small" href="#/diario/${o.id}/busca">Ver tudo</a></div>
        ${!nuvemOn() ? '<div class="muted small">Fotos e vídeos funcionam no modo nuvem.</div>' : fotos.length ? galeria(o, fotos) : '<div class="muted small">Nenhuma foto ainda.</div>'}</div>
    </div>
    ${infoObra(o)}
    ${pendenciasAbertas(o).length ? `<div class="card card-pad stack"><h2>Pendências em aberto no diário</h2><ul class="lista">${pendenciasAbertas(o).slice(0, 8).map((p) => `<li><b>${esc(p.tipo)}</b> ${esc(p.descricao)} <span class="muted small">${isoBR(p.data)}</span></li>`).join('')}</ul></div>` : ''}`;
}

function tabelaRelatorios(o, lista) {
  return `<div class="table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Período</th><th>Nº</th><th>Situação</th><th>Responsável</th><th class="num">Mídias</th></tr></thead><tbody>
    ${lista.map((d) => { const ms = midiasRdo(o, d.id); const f = ms.filter((m) => m.kind === 'foto').length, v = ms.filter((m) => m.kind !== 'foto' && m.kind !== 'anexo').length;
      return `<tr data-act="rdoAbrir" data-obra="${o.id}" data-id="${d.id}" tabindex="0"><td class="nowrap">${periodoRdo(d)}</td><td>${d.numero || '—'}</td><td>${badgeRdo(d.status)}</td><td class="small">${esc(d.responsavel || '')}</td>
        <td class="num small nowrap">${f ? `${ICO.foto} ${f}` : ''} ${v ? `${ICO.video} ${v}` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function galeria(o, fotos, { legendas = false } = {}) {
  return `<div class="galeria">${fotos.map((m) => `<button type="button" class="galeria-item" data-act="rdoFoto" data-obra="${o.id}" data-id="${m.id}" title="${esc(m.caption || m.name)}">${img(m.storage_path, '', m.caption || m.name)}${legendas && m.caption ? `<span class="galeria-legenda">${esc(m.caption)}</span>` : ''}</button>`).join('')}</div>`;
}

function situacaoTarefa(o, a, hoje) {
  const p = Number(a.pct) || 0;
  if (p >= 100) return ['Concluída', 'good'];
  if (p > 0) return ['Em andamento', 'info'];
  return ['Não iniciada', ''];
}
function secaoTarefas(o) {
  const t = (ui.diarioTarefas || '').trim().toLowerCase();
  const filhos = new Map();
  for (const a of o.eap || []) { const k = a.parentId || ''; if (!filhos.has(k)) filhos.set(k, []); filhos.get(k).push(a); }
  const linhas = [];
  const visita = (pai, nivel) => { for (const a of filhos.get(pai) || []) { linhas.push([a, nivel]); visita(a.id, nivel + 1); } };
  visita('', 0);
  const hoje = todayISO();
  const vis = t ? linhas.filter(([a]) => `${a.codigo} ${a.descricao}`.toLowerCase().includes(t)) : linhas;
  return `<div class="card card-pad stack"><div class="row between" style="flex-wrap:wrap;gap:8px"><h2>Lista de tarefas</h2>
      <input data-inp="diarioTarefas" data-key="diarioTarefas" value="${esc(ui.diarioTarefas || '')}" placeholder="Buscar atividade…" style="width:min(320px,100%)"></div>
    <div class="muted small">As atividades são as da EAP da obra (mesmas do cronograma). O avanço vem das Medições.</div>
    ${vis.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Código</th><th>Atividade</th><th class="num">Avanço</th><th>Situação</th></tr></thead><tbody>
      ${vis.map(([a, nv]) => { const folha = !filhos.has(a.id); const s = situacaoTarefa(o, a, hoje);
        return `<tr class="${folha ? '' : 'lvl1'}"><td class="nowrap">${esc(a.codigo)}</td><td style="padding-left:${8 + nv * 14}px">${folha ? '' : '<b>'}${esc(a.descricao)}${folha ? '' : '</b>'}</td>
          <td class="num">${folha ? `${fmtNum(Number(a.pct) || 0, 0)}%` : ''}</td><td>${folha ? `<span class="badge ${s[1]}">${s[0]}</span>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="muted small">A obra ainda não tem EAP.</div>'}</div>`;
}

function filtroRel() { return ui.diarioF ||= { de: '', ate: '', status: '', responsavel: '', faseId: '', texto: '' }; }
function secaoRelatorios(o) {
  const f = filtroRel();
  const lista = filtrarDiario(o, f).sort((a, b) => b.data.localeCompare(a.data));
  const resp = [...new Set((o.diario || []).map((d) => d.responsavel).filter(Boolean))];
  return `<div class="card card-pad stack"><h2>Relatórios</h2>
    <div class="grid-form">
      <label class="field">De<input type="date" data-chg="diarioF" data-f="de" value="${esc(f.de)}"></label>
      <label class="field">Até<input type="date" data-chg="diarioF" data-f="ate" value="${esc(f.ate)}"></label>
      <label class="field">Situação<select data-chg="diarioF" data-f="status"><option value="">Todas</option>${Object.entries(STATUS_RDO).map(([k, v]) => `<option value="${k}" ${k === f.status ? 'selected' : ''}>${v.rotulo}</option>`).join('')}</select></label>
      <label class="field">Responsável<select data-chg="diarioF" data-f="responsavel"><option value="">Todos</option>${resp.map((r) => `<option ${r === f.responsavel ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
      <label class="field">Fase<select data-chg="diarioF" data-f="faseId"><option value="">Todas</option>${fases(o).map((a) => `<option value="${a.id}" ${a.id === f.faseId ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}</select></label>
      <label class="field">Texto<input data-inp="diarioTexto" data-key="diarioTexto" value="${esc(f.texto)}" placeholder="serviço, ocorrência…"></label>
    </div>
    <div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn sm" data-act="rdoPdfLista" data-obra="${o.id}" ${lista.length ? '' : 'disabled'}>PDF dos ${lista.length} relatório(s) filtrados</button>
      ${f.faseId ? `<button class="btn sm" data-act="rdoPdfFase" data-obra="${o.id}">PDF da fase selecionada</button>` : ''}<button class="btn sm" data-act="rdoLimparFiltro">Limpar filtros</button></div>
    ${lista.length ? tabelaRelatorios(o, lista) : `<div class="muted small">${(o.diario || []).length ? 'Nenhum relatório com esses filtros.' : 'Nenhum relatório ainda.'}</div>`}
  </div>`;
}

function secaoBusca(o) {
  const f = ui.diarioBusca ||= { faseId: '', de: '', ate: '' };
  const daFase = f.faseId ? idsDaFase(o, f.faseId) : null;
  const rels = filtrarDiario(o, { de: f.de, ate: f.ate });
  const relIds = new Set(rels.map((d) => d.id));
  const fotos = midiasObra(o.id).filter((m) => m.kind === 'foto' && relIds.has(m.report_id) && (!daFase || daFase.has(m.phase_id) || daFase.has(m.activity_id)));
  const atividades = rels.flatMap((d) => (d.servicos || []).filter((s) => !daFase || (s.atividadeId && daFase.has(s.atividadeId))).map((s) => ({ d, s })));
  const ocorrencias = rels.filter((d) => !daFase || (d.servicos || []).some((s) => s.atividadeId && daFase.has(s.atividadeId))).flatMap((d) => (d.ocorrencias || []).map((x) => ({ d, x })));
  return `<div class="card card-pad stack"><h2>Filtro de busca</h2>
    <div class="grid-form">
      <label class="field">Fase<select data-chg="diarioBusca" data-f="faseId"><option value="">Todas as fases</option>${fases(o).map((a) => `<option value="${a.id}" ${a.id === f.faseId ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}</select></label>
      <label class="field">De<input type="date" data-chg="diarioBusca" data-f="de" value="${esc(f.de)}"></label>
      <label class="field">Até<input type="date" data-chg="diarioBusca" data-f="ate" value="${esc(f.ate)}"></label>
    </div>
    ${f.faseId ? `<div><button class="btn sm" data-act="rdoPdfFase" data-obra="${o.id}" data-fonte="busca">PDF desta fase</button></div>` : ''}</div>
  <div class="card card-pad stack"><h2>Fotos (${fotos.length})</h2>${!nuvemOn() ? '<div class="muted small">Fotos funcionam no modo nuvem.</div>' : fotos.length ? galeria(o, fotos, { legendas: true }) : '<div class="muted small">Nenhuma foto com esse filtro.</div>'}</div>
  <div class="card card-pad stack"><h2>Atividades registradas (${atividades.length})</h2>
    ${atividades.length ? `<div class="table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Relatório</th><th>Atividade</th><th class="num">Quantidade</th><th>Situação</th></tr></thead><tbody>
      ${atividades.map(({ d, s }) => { const a = ativ(o, s.atividadeId); return `<tr data-act="rdoAbrir" data-obra="${o.id}" data-id="${d.id}" tabindex="0"><td class="nowrap small">nº ${d.numero || '—'} · ${periodoRdo(d)}</td><td>${a ? `<b>${esc(a.codigo)}</b> ${esc(a.descricao)}` : ''}${s.descricao ? `<div class="muted small">${esc(s.descricao)}</div>` : ''}</td><td class="num">${s.qtd != null ? `${qtd(s.qtd)} ${esc(s.unidade || '')}` : ''}</td><td class="small">${esc(SITUACOES_ATIVIDADE[s.situacao] || '')}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="muted small">Nenhuma atividade com esse filtro.</div>'}</div>
  <div class="card card-pad stack"><h2>Ocorrências (${ocorrencias.length})</h2>
    ${ocorrencias.length ? `<ul class="lista">${ocorrencias.map(({ d, x }) => `<li><b>${esc(x.tipo)}</b>${x.hora ? ` ${esc(x.hora)}` : ''} — ${esc(x.descricao)}${x.resolvida ? ' <span class="badge good">resolvida</span>' : ''} <span class="muted small">nº ${d.numero || '—'} · ${periodoRdo(d)}</span></li>`).join('')}</ul>` : '<div class="muted small">Nenhuma ocorrência com esse filtro.</div>'}</div>`;
}

function secaoEditar(o) {
  if (!pode('cadastro')) return '<div class="card empty"><p>Seu perfil não altera o cadastro da obra.</p></div>';
  return `<div class="card card-pad stack"><h2>Editar obra</h2>
    <form class="stack" id="formObraDiario" data-obra="${o.id}" onsubmit="return false">
      <div class="grid-form">
        <label class="field">Nome<input name="nome" value="${esc(o.nome)}" required></label>
        <label class="field">Status<select name="status">${STATUS_OBRA.map((s) => `<option ${s === (o.status || 'Planejamento') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="field">Código<input name="codigo" value="${esc(o.codigo || '')}"></label>
        <label class="field">Nº do contrato<input name="numeroContrato" value="${esc(o.numeroContrato || '')}"></label>
        <label class="field">Endereço<input name="endereco" value="${esc(o.endereco || '')}"></label>
        <label class="field">Cidade<input name="cidade" value="${esc(o.cidade || '')}"></label>
        <label class="field">Responsável técnico<input name="engenheiro" value="${esc(o.engenheiro || '')}"></label>
        <label class="field">Contratante<input name="contratante" value="${esc(o.cliente?.nome || '')}"></label>
        <label class="field">Data de início<input type="date" name="inicio" value="${esc(o.inicio || '')}"></label>
        <label class="field">Início real<input type="date" name="inicioReal" value="${esc(o.inicioReal || '')}"></label>
        <label class="field">Previsão de término<input type="date" name="terminoPlanejado" value="${esc(o.terminoPlanejado || '')}"></label>
      </div>
      <div class="row"><button class="btn primary" data-act="obraDiarioSalvar" data-obra="${o.id}">Salvar</button></div>
    </form>
    <div class="muted small">Os mesmos dados do cadastro da obra (aba Cadastro): não há cadastro duplicado. Mudar a data de início altera o cronograma.</div></div>
  <div class="card card-pad stack"><h2>Foto de capa</h2>
    ${o.capa ? img(o.capa, 'capa-previa', o.nome) : '<div class="muted small">Sem foto de capa.</div>'}
    ${nuvemOn() ? `<div class="row"><label class="btn">${I.upload} ${o.capa ? 'Trocar foto' : 'Enviar foto'}<input type="file" accept="image/jpeg,image/png,image/webp" data-chg="obraCapa" data-obra="${o.id}" hidden></label>${o.capa ? `<button class="btn" data-act="obraCapaRemover" data-obra="${o.id}">Remover</button>` : ''}</div>
      <div class="muted small">JPG, PNG ou WEBP até 10 MB. Guardada em armazenamento privado da empresa.</div>` : '<div class="muted small">A foto de capa funciona no modo nuvem.</div>'}</div>`;
}

/* ----- Visualização do relatório ----- */
function vizinhos(o, d) {
  const l = [...(o.diario || [])].sort((a, b) => a.data.localeCompare(b.data));
  const i = l.findIndex((x) => x.id === d.id);
  return { ant: l[i - 1] || null, prox: l[i + 1] || null };
}
const tabela = (cab, linhas, vazioTxt = '') => (linhas.length ? `<table class="rdo-tab"><thead><tr>${cab.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${linhas.map((l) => `<tr>${l.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table>` : (vazioTxt ? `<div class="muted small rdo-vazio">${vazioTxt}</div>` : ''));
const secaoRdo = (titulo, n, corpo) => `<section class="rdo-secao"><h3>${titulo}${n != null ? ` (${n})` : ''}</h3>${corpo}</section>`;

function situacaoServico(o, d, s) {
  if (s.situacao) return SITUACOES_ATIVIDADE[s.situacao] || s.situacao;
  if (!s.atividadeId) return '';
  const p = avancoAte(o, s.atividadeId, fimRdo(d));
  return p == null ? '' : p >= 100 ? '100% concluída' : `${fmtNum(p, 0)}% medido`;
}

function viewRdo(o, id) {
  const d = (o.diario || []).find((x) => x.id === id);
  if (!d) return `<div class="card empty"><p>Relatório não encontrado.</p><a class="btn" href="#/diario/${o.id}/relatorios">Voltar</a></div>`;
  if (nuvemOn()) {
    if (!X.detalhes.has(d.id)) { X.detalhes.set(d.id, null); setTimeout(() => carregarDetalhe(d.id).catch(() => {})); }
    if (!X.vistos.has(d.id)) { X.vistos.add(d.id); sb().then((c) => c.rpc('rdo_visualizar', { p_report: d.id })).then(() => carregarDetalhe(d.id)).catch(() => {}); }
  }
  const pz = prazosObra(o, fimRdo(d));
  const ms = midiasRdo(o, d.id);
  const fotos = ms.filter((m) => m.kind === 'foto'), videos = ms.filter((m) => m.kind === 'video' || m.kind === 'link'), anexos = ms.filter((m) => m.kind === 'anexo');
  const coms = X.comentarios.get(d.id) || [];
  const det = X.detalhes.get(d.id);
  const { ant, prox } = vizinhos(o, d);
  const st = d.status || 'preenchendo';
  const preenche = podePreencher(), aprova = podeAprovar();
  const acoes = [
    preenche && st !== 'aprovado' ? `<a class="btn" href="#/diario/${o.id}/rdo/${d.id}/editar">Editar</a>` : '',
    preenche && ['preenchendo', 'devolvido'].includes(st) ? `<button class="btn" data-act="rdoEnviar" data-obra="${o.id}" data-id="${d.id}">Enviar para revisão</button>` : '',
    aprova && ['preenchendo', 'revisao', 'devolvido'].includes(st) ? `<button class="btn primary" data-act="rdoAprovar" data-obra="${o.id}" data-id="${d.id}">Aprovar e assinar</button>` : '',
    aprova && st === 'revisao' ? `<button class="btn" data-act="rdoDevolver" data-obra="${o.id}" data-id="${d.id}">Devolver</button>` : '',
    aprova && st === 'aprovado' ? `<button class="btn" data-act="rdoReabrir" data-obra="${o.id}" data-id="${d.id}">Reabrir</button>` : '',
  ].join('');
  const assin = (caminho, nome, rot, quando) => `<div class="rdo-assinatura">${caminho ? img(caminho, 'rdo-assinatura-img', `Assinatura — ${nome}`) : '<div class="rdo-assinatura-img"></div>'}<div class="rdo-assinatura-linha"></div><div>${esc(nome || '—')}</div><div class="muted small">${rot}${quando ? ` · ${new Date(quando).toLocaleString('pt-BR')}` : ''}</div></div>`;
  const criado = det?.eventos?.find((e) => e.kind === 'criacao');
  const ultima = det?.eventos ? [...det.eventos].reverse().find((e) => ['edicao', 'criacao'].includes(e.kind)) : null;
  return `<div class="page-head no-print"><div><a class="muted small" href="#/diario/${o.id}/relatorios">← Relatórios — ${esc(o.nome)}</a><h1>Relatório: ${periodoRdo(d)} nº ${d.numero || '—'}</h1></div>
    <div class="row" style="gap:6px;flex-wrap:wrap">${acoes}<button class="btn" data-act="rdoImprimir">Imprimir</button><button class="btn" data-act="rdoPdf" data-obra="${o.id}" data-id="${d.id}">PDF</button>
      ${preenche && st !== 'aprovado' && !d.assinaturaResponsavel && nuvemOn() ? `<button class="btn" data-act="rdoAssinar" data-obra="${o.id}" data-id="${d.id}">Assinar como responsável</button>` : ''}</div></div>
  ${st === 'devolvido' && d.notaRevisao ? `<div class="alert err small no-print">Devolvido para correção: ${esc(d.notaRevisao)}</div>` : ''}
  ${st === 'preenchendo' && d.notaRevisao ? `<div class="alert info small no-print">Reaberto: ${esc(d.notaRevisao)}</div>` : ''}
  <article class="card rdo-folha">
    <div class="row between rdo-topo">${badgeRdo(st)}${nuvemOn() && nuvem.pendente() ? '<span class="muted small no-print">alterações ainda não enviadas</span>' : ''}</div>
    <table class="rdo-cab"><tbody>
      <tr><td rowspan="3" colspan="2" class="rdo-cab-logo">${X.logo ? img(X.logo, 'rdo-logo', 'Logo da empresa') : ''}${o.capa ? img(o.capa, 'rdo-capa', o.nome) : ''}</td><th>Relatório nº</th><td>${d.numero || '—'}</td></tr>
      <tr><th>Data</th><td>${periodoRdo(d)}</td></tr>
      <tr><th>Dia da semana</th><td>${diasDaSemanaRdo(d)}</td></tr>
      <tr><td colspan="2" class="rdo-cab-titulo">Relatório Diário de Obra (RDO)</td><th>Nº do contrato</th><td>${esc(o.numeroContrato || '')}</td></tr>
      <tr><th>Obra</th><td>${esc(o.nome)}</td><th>Prazo contratual</th><td>${pz ? `${pz.contratual} dias` : '—'}</td></tr>
      <tr><th>Endereço</th><td>${esc([o.endereco, o.cidade].filter(Boolean).join(' — '))}</td><th>Prazo decorrido</th><td>${pz ? `${pz.decorrido} dias` : '—'}</td></tr>
      <tr><th>Contratante</th><td>${esc(o.cliente?.nome || '')}<span class="rdo-resp"><b>Responsável:</b> ${esc(o.engenheiro || d.responsavel || '')}</span></td><th>Prazo a vencer</th><td>${pz ? `${pz.aVencer} dias` : '—'}</td></tr>
    </tbody></table>
    ${secaoRdo('Condições de trabalho', null, `<div class="rdo-grid"><div><b>Clima — manhã:</b> ${esc(d.clima?.manha || '')}</div><div><b>Clima — tarde:</b> ${esc(d.clima?.tarde || '')}</div><div><b>Dia praticável:</b> ${d.praticavel === false ? 'Não' : 'Sim'}</div></div>
      ${d.condicoes ? `<div><b>Condições de execução:</b> ${esc(d.condicoes)}</div>` : ''}${d.justificativa ? `<div><b>Justificativa de paralisação:</b> ${esc(d.justificativa)}</div>` : ''}`)}
    ${secaoRdo('Atividades', (d.servicos || []).length, tabela(['Atividade', 'Descrição', 'Quantidade', 'Situação'], (d.servicos || []).map((s) => { const a = ativ(o, s.atividadeId); const f = a ? raiz(o, a.id) : null;
      return [a ? `<b>${esc(a.codigo)}</b> ${esc(a.descricao)}${f && f.id !== a.id ? `<div class="muted small">${esc(f.descricao)}</div>` : ''}` : '—', esc(s.descricao || ''), s.qtd != null ? `${qtd(s.qtd)} ${esc(s.unidade || '')}` : '', esc(situacaoServico(o, d, s))]; }), 'Nenhuma atividade registrada.'))}
    ${secaoRdo('Mão de obra', (d.equipe || []).reduce((a, e) => a + (Number(e.qtd) || 0), 0), tabela(['Função', 'Tipo', 'Empresa', 'Quantidade'], (d.equipe || []).map((e) => [esc(e.funcao), e.tipo === 'terceirizada' ? 'Terceirizada' : 'Própria', esc(e.empresa || ''), qtd(e.qtd)]), 'Não informada.'))}
    ${(d.equipamentosLista || []).length || d.equipamentos ? secaoRdo('Equipamentos', (d.equipamentosLista || []).length, tabela(['Equipamento', 'Quantidade', 'Horas'], (d.equipamentosLista || []).map((e) => [esc(e.nome), qtd(e.qtd), qtd(e.horas)])) + (d.equipamentos ? `<div class="small">${esc(d.equipamentos)}</div>` : '')) : ''}
    ${secaoRdo('Ocorrências', (d.ocorrencias || []).length, tabela(['Horário', 'Tipo', 'Descrição', 'Providências', 'Responsável', ''], (d.ocorrencias || []).map((x) => [esc(x.hora || ''), esc(x.tipo), esc(x.descricao), esc(x.providencias || ''), esc(x.responsavel || ''), x.resolvida ? 'Resolvida' : 'Em aberto']), 'Nenhuma ocorrência.'))}
    ${(d.materiaisLista || []).length || d.materiais ? secaoRdo('Materiais', (d.materiaisLista || []).length, tabela(['Material', 'Quantidade', 'Fornecedor', 'Divergência'], (d.materiaisLista || []).map((m) => [esc(m.descricao), `${qtd(m.qtd)} ${esc(m.unidade || '')}`, esc(m.fornecedor || ''), esc(m.divergencia || '')])) + (d.materiais ? `<div class="small">${esc(d.materiais)}</div>` : '')) : ''}
    ${d.visitas || d.reunioes || d.observacoes ? secaoRdo('Observações', null, `${d.visitas ? `<div><b>Visitas:</b> ${esc(d.visitas)}</div>` : ''}${d.reunioes ? `<div><b>Reuniões:</b> ${esc(d.reunioes)}</div>` : ''}${d.observacoes ? `<div>${esc(d.observacoes)}</div>` : ''}`) : ''}
    ${nuvemOn() ? secaoRdo('Comentários', coms.length, `${coms.map((c) => `<div class="rdo-comentario"><b>${esc(c.author_label)}</b> <span class="muted small">${new Date(c.created_at).toLocaleString('pt-BR')}</span><div>${esc(c.body)}</div></div>`).join('') || '<div class="muted small rdo-vazio">Nenhum comentário.</div>'}
      ${ctx()?.papel && ctx().papel !== 'cliente' ? `<div class="row no-print" style="gap:6px;margin-top:6px"><input id="rdoComentario" placeholder="Escreva um comentário…" style="flex:1;min-width:200px" maxlength="2000"><button class="btn sm" data-act="rdoComentar" data-obra="${o.id}" data-id="${d.id}">Comentar</button></div>` : ''}`) : ''}
    ${nuvemOn() ? secaoRdo('Fotos', fotos.length, fotos.length ? `<div class="rdo-fotos">${fotos.map((m) => `<figure><button type="button" class="galeria-item" data-act="rdoFoto" data-obra="${o.id}" data-id="${m.id}">${img(m.storage_path, '', m.caption || m.name)}</button><figcaption>${esc(m.caption || '')}${m.activity_id || m.phase_id ? `<span class="muted"> · ${esc((ativ(o, m.activity_id) || ativ(o, m.phase_id))?.descricao || '')}</span>` : ''}</figcaption></figure>`).join('')}</div>` : '<div class="muted small rdo-vazio">Nenhuma foto.</div>') : ''}
    ${nuvemOn() ? secaoRdo('Vídeos', videos.length, videos.map((m) => m.kind === 'link' ? `<div><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name || m.url)}</a>${m.caption ? ` — ${esc(m.caption)}` : ''}</div>` : `<div class="rdo-video"><video controls preload="none" data-path="${esc(m.storage_path)}"></video><div class="small">${esc(m.caption || m.name)}</div></div>`).join('') || '<div class="muted small rdo-vazio">Nenhum vídeo.</div>') : ''}
    ${nuvemOn() ? secaoRdo('Anexos', anexos.length, anexos.map((m) => `<div><a href="#" data-act="rdoAnexo" data-path="${esc(m.storage_path)}" data-nome="${esc(m.name)}">${esc(m.name)}</a> <span class="muted small">${m.size_bytes ? tamanhoLegivel(m.size_bytes) : ''}</span></div>`).join('') || '<div class="muted small rdo-vazio">Nenhum anexo.</div>') : ''}
    <div class="rdo-assinaturas">${assin(d.assinaturaResponsavel, d.assinadoPor || d.responsavel, 'Responsável pelo preenchimento', d.assinadoEm)}${assin(d.assinaturaAprovador, d.aprovadoPor, d.aprovadoPor ? 'Aprovado' : 'Aprovação', d.aprovadoEm)}</div>
    <div class="row between rdo-nav no-print">${ant ? `<a href="#/diario/${o.id}/rdo/${ant.id}">← Anterior<div class="small">${periodoRdo(ant)}</div></a>` : '<span></span>'}${prox ? `<a href="#/diario/${o.id}/rdo/${prox.id}" style="text-align:right">Próximo →<div class="small">${periodoRdo(prox)}</div></a>` : '<span></span>'}</div>
  </article>
  <div class="row between small no-print" style="flex-wrap:wrap;gap:8px;margin-top:8px">
    <div>${criado ? `<div><b>Criado por:</b> ${esc(criado.author_label)} (${new Date(criado.created_at).toLocaleString('pt-BR')})</div>` : d.criadoEm ? `<div><b>Criado em:</b> ${new Date(d.criadoEm).toLocaleString('pt-BR')}</div>` : ''}${ultima ? `<div><b>Última modificação:</b> ${esc(ultima.author_label)} (${new Date(ultima.created_at).toLocaleString('pt-BR')})</div>` : ''}</div>
    ${nuvemOn() ? `<div class="row" style="gap:12px"><a href="#" data-act="rdoLog" data-id="${d.id}">Log de edições (${det?.eventos?.length ?? '…'})</a><a href="#" data-act="rdoVistas" data-id="${d.id}">Visualizações (${det?.vistas?.length ?? '…'})</a></div>` : ''}
  </div>`;
}

/* ----- Cadastro do relatório (página com seções) ----- */
const opcoesAtiv = (o, sel) => {
  const fs = folhas(o);
  return `<option value="">— livre (sem atividade da EAP) —</option>${fs.map((a) => { const f = raiz(o, a.id); return `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}${f && f.id !== a.id ? ` (${esc(f.descricao)})` : ''}</option>`; }).join('')}`;
};
const linhas = {
  eq: (e = {}) => `<div class="row lin" data-id="${esc(e.id || '')}"><input name="eqFuncao" placeholder="Função (ex.: Pedreiro)" value="${esc(e.funcao || '')}" style="flex:2;min-width:130px"><select name="eqTipo" style="width:auto"><option value="propria">Própria</option><option value="terceirizada" ${e.tipo === 'terceirizada' ? 'selected' : ''}>Terceirizada</option></select><input name="eqEmpresa" placeholder="Empresa (terceirizada)" value="${esc(e.empresa || '')}" style="flex:1;min-width:120px"><input name="eqQtd" inputmode="numeric" placeholder="Qtd" value="${esc(e.qtd ?? '')}" style="width:70px"><button type="button" class="icon-btn danger rm" title="Remover">${I.trash}</button></div>`,
  eqp: (e = {}) => `<div class="row lin"><input name="epNome" placeholder="Equipamento (ex.: Betoneira 400 L)" value="${esc(e.nome || '')}" style="flex:2;min-width:160px"><input name="epQtd" inputmode="decimal" placeholder="Qtd" value="${e.qtd != null ? fmtIn(e.qtd, 2) : ''}" style="width:70px"><input name="epHoras" inputmode="decimal" placeholder="Horas" value="${e.horas != null ? fmtIn(e.horas, 2) : ''}" style="width:80px"><button type="button" class="icon-btn danger rm" title="Remover">${I.trash}</button></div>`,
  sv: (o) => (s = {}) => `<div class="lin rdo-lin-ativ" data-id="${esc(s.id || '')}"><select name="svAtiv">${opcoesAtiv(o, s.atividadeId)}</select><input name="svDesc" placeholder="Descrição / local" value="${esc(s.descricao || '')}"><input name="svQtd" inputmode="decimal" placeholder="Qtd" value="${s.qtd != null ? fmtIn(s.qtd, 4) : ''}"><input name="svUn" placeholder="Unid." value="${esc(s.unidade || '')}"><select name="svSit"><option value="">Situação…</option>${Object.entries(SITUACOES_ATIVIDADE).map(([k, v]) => `<option value="${k}" ${k === s.situacao ? 'selected' : ''}>${v}</option>`).join('')}</select><input name="svObs" placeholder="Observação" value="${esc(s.obs || '')}"><button type="button" class="icon-btn danger rm" title="Remover">${I.trash}</button></div>`,
  oc: (x = {}) => `<div class="lin rdo-lin-oc" data-id="${esc(x.id || '')}"><select name="ocTipo">${TIPOS_OCORRENCIA.map((t) => `<option ${t === x.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select><input name="ocHora" type="time" value="${esc(x.hora || '')}"><input name="ocDesc" placeholder="Descrição" value="${esc(x.descricao || '')}"><input name="ocProv" placeholder="Providências" value="${esc(x.providencias || '')}"><input name="ocResp" placeholder="Responsável" value="${esc(x.responsavel || '')}"><label class="check small"><input type="checkbox" name="ocRes" ${x.resolvida ? 'checked' : ''}> resolvida</label><button type="button" class="icon-btn danger rm" title="Remover">${I.trash}</button></div>`,
  mat: (m = {}) => `<div class="row lin"><input name="mtDesc" placeholder="Material" value="${esc(m.descricao || '')}" style="flex:2;min-width:140px"><input name="mtQtd" inputmode="decimal" placeholder="Qtd" value="${m.qtd != null ? fmtIn(m.qtd, 4) : ''}" style="width:70px"><input name="mtUn" placeholder="Unid." value="${esc(m.unidade || '')}" style="width:70px"><input name="mtForn" placeholder="Fornecedor" value="${esc(m.fornecedor || '')}" style="flex:1;min-width:120px"><input name="mtDiv" placeholder="Divergência (se houver)" value="${esc(m.divergencia || '')}" style="flex:1;min-width:140px"><button type="button" class="icon-btn danger rm" title="Remover">${I.trash}</button></div>`,
};

function rascunho(o, id) {
  ui.rdoRascunho ||= {};
  if (id === 'novo') {
    const k = `novo:${o.id}`;
    if (!ui.rdoRascunho[k]) {
      const ult = [...(o.diario || [])].sort((a, b) => fimRdo(b).localeCompare(fimRdo(a)))[0];
      const ini = ult && fimRdo(ult) >= todayISO() ? new Date(new Date(`${fimRdo(ult)}T12:00:00`).getTime() + 86400000).toISOString().slice(0, 10) : todayISO();
      ui.rdoRascunho[k] = novoDiario(ini, quem(), o);
    }
    return ui.rdoRascunho[k];
  }
  const d = (o.diario || []).find((x) => x.id === id);
  return d ? JSON.parse(JSON.stringify(d)) : null;
}

function viewRdoEditar(o, id) {
  if (!podePreencher()) return `<div class="card empty"><p>Seu perfil não preenche o diário desta obra.</p><a class="btn" href="#/diario/${o.id}">Voltar</a></div>`;
  const d = rascunho(o, id);
  if (!d) return `<div class="card empty"><p>Relatório não encontrado.</p><a class="btn" href="#/diario/${o.id}/relatorios">Voltar</a></div>`;
  if (d.status === 'aprovado') return `<div class="card empty"><p>O relatório nº ${d.numero} está aprovado. Para alterar, quem aprova precisa reabri-lo.</p><a class="btn" href="#/diario/${o.id}/rdo/${d.id}">Ver relatório</a></div>`;
  const novo = id === 'novo';
  const ms = novo ? [] : midiasRdo(o, d.id);
  const sec = (n, titulo, corpo, aberto = true) => `<details class="card card-pad rdo-form-secao" ${aberto ? 'open' : ''}><summary><span class="rdo-num">${n}</span> ${titulo}</summary><div class="stack" style="margin-top:10px">${corpo}</div></details>`;
  const lista = (k, itens, fn, rotulo) => `<div data-lista="${k}" class="stack">${(itens.length ? itens : [{}]).map(fn).join('')}</div><div><button type="button" class="btn sm" data-add="${k}">${I.plus} ${rotulo}</button></div>`;
  return `<div class="page-head"><div><a class="muted small" href="${novo ? `#/diario/${o.id}/relatorios` : `#/diario/${o.id}/rdo/${d.id}`}">← ${novo ? 'Relatórios' : 'Voltar ao relatório'}</a>
      <h1>${novo ? 'Novo relatório' : `Editar relatório nº ${d.numero || '—'}`} — ${esc(o.nome)}</h1><div class="row" style="gap:6px">${badgeRdo(d.status)}${d.notaRevisao ? `<span class="small">${esc(d.notaRevisao)}</span>` : ''}</div></div></div>
  <form id="rdoForm" class="stack rdo-form" data-obra="${o.id}" data-id="${d.id}" data-novo="${novo ? 1 : ''}" onsubmit="return false" novalidate>
    ${sec(1, 'Identificação', `<div class="grid-form">
      <label class="field">Data inicial *<input type="date" name="data" value="${esc(d.data)}" required></label>
      <label class="field">Data final <span class="muted small" style="font-weight:400">(igual à inicial = um dia)</span><input type="date" name="dataFim" value="${esc(d.dataFim || d.data)}"></label>
      <label class="field">Responsável<input name="responsavel" value="${esc(d.responsavel || quem())}"></label>
      <label class="field">Nº do relatório<input value="${d.numero || '—'}" disabled title="Dado pelo sistema"></label></div>`)}
    ${sec(2, 'Condições de trabalho', `<div class="grid-form">
      <label class="field">Clima — manhã<select name="climaM">${CLIMAS.map((x) => `<option ${x === d.clima?.manha ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field">Clima — tarde<select name="climaT">${CLIMAS.map((x) => `<option ${x === d.clima?.tarde ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="check" style="align-self:end"><input type="checkbox" name="praticavel" ${d.praticavel !== false ? 'checked' : ''}> Dia(s) praticável(is)</label></div>
      <label class="field">Condições de execução<input name="condicoes" value="${esc(d.condicoes || '')}" placeholder="ex.: execução normal, terreno encharcado…"></label>
      <label class="field">Justificativa de paralisação<input name="justificativa" value="${esc(d.justificativa || '')}"></label>`)}
    ${sec(3, 'Equipe (mão de obra)', lista('eq', d.equipe || [], linhas.eq, 'Função'))}
    ${sec(4, 'Equipamentos', lista('eqp', d.equipamentosLista || [], linhas.eqp, 'Equipamento') + (d.equipamentos ? `<label class="field">Anotações antigas<textarea name="equipamentos" rows="2">${esc(d.equipamentos)}</textarea></label>` : ''), (d.equipamentosLista || []).length > 0 || !!d.equipamentos)}
    ${sec(5, 'Atividades executadas (EAP)', `<div class="muted small">Escolha a atividade da EAP (a fase vem junto). A situação é a do período; o avanço oficial continua nas Medições.</div>${lista('sv', d.servicos || [], linhas.sv(o), 'Atividade')}`)}
    ${sec(6, 'Ocorrências', lista('oc', d.ocorrencias || [], linhas.oc, 'Ocorrência'), (d.ocorrencias || []).length > 0)}
    ${sec(7, 'Materiais recebidos ou utilizados', lista('mat', d.materiaisLista || [], linhas.mat, 'Material') + (d.materiais ? `<label class="field">Anotações antigas<textarea name="materiais" rows="2">${esc(d.materiais)}</textarea></label>` : ''), (d.materiaisLista || []).length > 0 || !!d.materiais)}
    ${sec(8, 'Visitas, reuniões e observações', `<div class="grid-form"><label class="field">Visitas<textarea name="visitas" rows="2">${esc(d.visitas || '')}</textarea></label><label class="field">Reuniões<textarea name="reunioes" rows="2">${esc(d.reunioes || '')}</textarea></label></div>
      <label class="field">Observações técnicas<textarea name="observacoes" rows="3">${esc(d.observacoes || '')}</textarea></label>`, !!(d.visitas || d.reunioes || d.observacoes))}
    ${sec(9, 'Fotos, vídeos e anexos', !nuvemOn() ? '<div class="muted small">Fotos, vídeos e anexos funcionam no modo nuvem.</div>'
      : novo ? '<div class="muted small">Salve o relatório primeiro; depois as fotos e vídeos podem ser incluídos aqui.</div>'
      : `${ms.length ? `<div class="rdo-midias-edit">${ms.map((m) => `<div class="rdo-midia-edit">${m.kind === 'foto' ? img(m.storage_path, '', m.name) : `<div class="rdo-midia-ico">${m.kind === 'anexo' ? ICO.rel : ICO.video}</div>`}
          <div class="small" style="flex:1;min-width:0"><b>${esc(m.name || m.url || '')}</b><div class="muted">${esc(m.caption || 'sem legenda')}${m.activity_id ? ` · ${esc(ativ(o, m.activity_id)?.descricao || '')}` : m.phase_id ? ` · ${esc(ativ(o, m.phase_id)?.descricao || '')}` : ''}</div></div>
          <button type="button" class="btn sm" data-act="rdoMidiaEditar" data-obra="${o.id}" data-id="${m.id}">Legenda</button><button type="button" class="icon-btn danger" data-act="rdoMidiaRemover" data-obra="${o.id}" data-id="${m.id}" title="Remover">${I.trash}</button></div>`).join('')}</div>` : ''}
        <div class="row" style="gap:6px;flex-wrap:wrap"><button type="button" class="btn sm primary" data-act="rdoMidiaEnviar" data-obra="${o.id}" data-id="${d.id}">${I.upload} Fotos, vídeos ou anexos</button><button type="button" class="btn sm" data-act="rdoLink" data-obra="${o.id}" data-id="${d.id}">${I.link} Link de vídeo</button></div>
        <div class="muted small">Fotos até 10 MB, vídeos curtos até 50 MB (MP4, MOV, WEBM), anexos até 10 MB. No plano gratuito do Supabase o espaço total é de 1 GB — para vídeos longos, prefira o link (YouTube, Google Drive). Espaço usado pelo diário desta obra: ${tamanhoLegivel(midiasObra(o.id).reduce((a, m) => a + (Number(m.size_bytes) || 0), 0) || 1)}.</div>`, true)}
    <div class="row rdo-form-acoes"><button type="button" class="btn primary" data-act="rdoSalvar" data-obra="${o.id}" data-id="${d.id}">Salvar</button><button type="button" class="btn" data-act="rdoSalvar" data-obra="${o.id}" data-id="${d.id}" data-ver="1">Salvar e visualizar</button>
      <a class="btn" href="${novo ? `#/diario/${o.id}/relatorios` : `#/diario/${o.id}/rdo/${d.id}`}" data-act="rdoDescartar" data-obra="${o.id}">Cancelar</a></div>
  </form>`;
}

function lerFormulario(form, base) {
  const fd = new FormData(form);
  const lins = (k) => [...form.querySelectorAll(`[data-lista="${k}"] .lin`)];
  const val = (l, n) => l.querySelector(`[name=${n}]`)?.value.trim() ?? '';
  const numero = (v) => (v === '' ? null : parseNum(v));
  const comId = (l, obj) => (l.dataset.id ? { id: l.dataset.id, ...obj } : obj);   // mantém a mesma linha no banco
  return {
    ...base, data: fd.get('data'), dataFim: fd.get('dataFim') || fd.get('data'), responsavel: (fd.get('responsavel') || '').trim(),
    clima: { manha: fd.get('climaM'), tarde: fd.get('climaT') }, praticavel: fd.has('praticavel'),
    condicoes: (fd.get('condicoes') || '').trim(), justificativa: (fd.get('justificativa') || '').trim(),
    equipe: lins('eq').map((l) => comId(l, { funcao: val(l, 'eqFuncao'), tipo: val(l, 'eqTipo'), empresa: val(l, 'eqEmpresa'), qtd: Math.max(0, Math.round(parseNum(val(l, 'eqQtd')) || 0)) })).filter((e) => e.funcao),
    equipamentosLista: lins('eqp').map((l) => ({ nome: val(l, 'epNome'), qtd: numero(val(l, 'epQtd')), horas: numero(val(l, 'epHoras')) })).filter((e) => e.nome),
    servicos: lins('sv').map((l) => comId(l, { atividadeId: val(l, 'svAtiv') || null, descricao: val(l, 'svDesc'), qtd: numero(val(l, 'svQtd')), unidade: val(l, 'svUn'), situacao: val(l, 'svSit'), obs: val(l, 'svObs') })).filter((s) => s.atividadeId || s.descricao),
    ocorrencias: lins('oc').map((l) => comId(l, { tipo: val(l, 'ocTipo'), hora: val(l, 'ocHora'), descricao: val(l, 'ocDesc'), providencias: val(l, 'ocProv'), responsavel: val(l, 'ocResp'), resolvida: l.querySelector('[name=ocRes]').checked })).filter((x) => x.descricao),
    materiaisLista: lins('mat').map((l) => ({ descricao: val(l, 'mtDesc'), qtd: numero(val(l, 'mtQtd')), unidade: val(l, 'mtUn'), fornecedor: val(l, 'mtForn'), divergencia: val(l, 'mtDiv') })).filter((m) => m.descricao),
    materiais: fd.has('materiais') ? fd.get('materiais') : base.materiais || '', equipamentos: fd.has('equipamentos') ? fd.get('equipamentos') : base.equipamentos || '',
    visitas: fd.get('visitas') || '', reunioes: fd.get('reunioes') || '', observacoes: fd.get('observacoes') || '',
  };
}
/** Liga os botões "+" e lixeira das listas do formulário (uma vez por página). */
export function ligarFormRdo() {
  const form = document.getElementById('rdoForm');
  if (!form || form.dataset.ligado) return;
  form.dataset.ligado = '1';
  // com alterações não salvas, a tela não é redesenhada pela sincronização automática (ver formRdoSujo)
  const sujar = () => { form.dataset.sujo = '1'; };
  form.addEventListener('input', sujar); form.addEventListener('change', sujar);
  const o = store.obra(form.dataset.obra);
  const novos = { eq: linhas.eq, eqp: linhas.eqp, sv: linhas.sv(o), oc: linhas.oc, mat: linhas.mat };
  form.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { form.querySelector(`[data-lista="${add.dataset.add}"]`).insertAdjacentHTML('beforeend', novos[add.dataset.add]()); sujar(); return; }
    const rm = e.target.closest('.rm'); if (rm) { rm.closest('.lin').remove(); sujar(); }
  });
}
/** O formulário do RDO na tela tem alterações não salvas? (o app não redesenha por cima delas) */
export const formRdoSujo = () => document.getElementById('rdoForm')?.dataset.sujo === '1';

/* ---------- ações do relatório na nuvem ---------- */
/** Garante que o relatório (e a obra) já estão no banco antes de anexar mídias ou executar ações. */
async function noBanco() {
  if (!nuvemOn()) return;
  await nuvem.enviar().catch(() => {});
  if (nuvem.pendente()) throw new Error('Sem conexão com o servidor: o relatório ainda não foi enviado. Tente de novo quando estiver online.');
}
async function acaoNuvem(d, acao, extra = {}) {
  await noBanco();
  const c = await sb();
  ok(await c.rpc('rdo_acao', { p_report: d.id, p_acao: acao, p_comment: extra.comentario || '', p_signature: extra.assinatura || '' }), 'relatório');
  await nuvem.baixar().catch(() => {});
  await carregarDetalhe(d.id).catch(() => {});
}

/** Janela de assinatura: desenhar na tela (dedo/mouse) ou enviar imagem. Resolve com Blob (PNG) ou null. */
function capturarAssinatura(titulo) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide"><h2>${esc(titulo)}</h2>
    <p class="muted small" style="margin:6px 0">Assine no quadro abaixo (dedo ou mouse) ou envie a imagem da assinatura.</p>
    <canvas class="assinatura-canvas" width="600" height="200" aria-label="Quadro para assinar"></canvas>
    <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn sm" data-limpar>Limpar</button><label class="btn sm">Enviar imagem<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-arquivo></label><span class="small muted" data-nome></span></div>
    <div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Confirmar assinatura</button></div></form>`;
  const cv = dlg.querySelector('canvas'), g = cv.getContext('2d');
  g.lineWidth = 2.5; g.lineCap = 'round'; g.strokeStyle = '#14305a';
  let desenhou = false, arquivo = null, ativo = false;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / (r.width || cv.width)), (e.clientY - r.top) * (cv.height / (r.height || cv.height))]; };
  cv.onpointerdown = (e) => { ativo = true; try { cv.setPointerCapture(e.pointerId); } catch { /* alguns aparelhos */ } g.beginPath(); g.moveTo(...pos(e)); };
  cv.onpointermove = (e) => { if (!ativo) return; g.lineTo(...pos(e)); g.stroke(); desenhou = true; };
  cv.onpointerup = () => { ativo = false; };
  dlg.querySelector('[data-limpar]').onclick = () => { g.clearRect(0, 0, cv.width, cv.height); desenhou = false; arquivo = null; dlg.querySelector('[data-nome]').textContent = ''; };
  dlg.querySelector('[data-arquivo]').onchange = (e) => { arquivo = e.target.files[0] || null; dlg.querySelector('[data-nome]').textContent = arquivo ? arquivo.name : ''; };
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    dlg.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const erro = dlg.querySelector('.form-erro');
      if (arquivo) {
        try { validarArquivo(arquivo, 2 * 1024 * 1024, TIPOS_IMAGEM); } catch (err) { erro.textContent = err.message; erro.hidden = false; return; }
        return finish(arquivo);
      }
      // confere se há traço de verdade no quadro (não aceita assinatura em branco)
      const px = g.getImageData(0, 0, cv.width, cv.height).data;
      let tinta = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) tinta++;
      if (!desenhou || tinta < 30) { erro.textContent = 'Assine no quadro ou envie a imagem.'; erro.hidden = false; return; }
      cv.toBlob((b) => finish(b), 'image/png');
    };
    dlg.showModal();
  });
}
async function assinaturaParaBanco(o, d, titulo) {
  const b = await capturarAssinatura(titulo);
  if (!b) return null;
  if (!nuvemOn()) return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  await noBanco();
  return enviarBlob(ctx().orgId, 'obras', `${o.id}/rdo/${d.id}`, b, `assinatura-${Date.now()}.png`, 2 * 1024 * 1024);
}

function janelaMidias(o, d) {
  const corpo = `<label class="field">Arquivos (fotos, vídeos ou anexos)<input type="file" name="arquivos" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,${ACCEPT}"></label>
    <div class="grid-form">
      <label class="field">Fase<select name="fase"><option value="">—</option>${fases(o).map((a) => `<option value="${a.id}">${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}</select></label>
      <label class="field">Atividade<select name="atividade">${opcoesAtiv(o, '').replace('— livre (sem atividade da EAP) —', '—')}</select></label>
      <label class="field">Data<input type="date" name="data" value="${esc(d.data)}"></label>
    </div>
    <label class="field">Legenda (vale para todos os arquivos enviados agora)<input name="legenda" maxlength="500"></label>
    <div class="muted small">Fotos até 10 MB · vídeos até 50 MB · anexos até 10 MB.</div>`;
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>Incluir mídias — RDO nº ${d.numero || '—'}</h2><div class="stack" style="margin-top:12px">${corpo}</div>
    <div class="form-erro alert err small" hidden></div><div class="progresso small muted"></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Enviar</button></div></form>`;
  const form = dlg.querySelector('form');
  const erro = (m) => { const e = form.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; };
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const arquivos = [...form.arquivos.files];
      if (!arquivos.length) return erro('Escolha pelo menos um arquivo.');
      const tipoDe = (f) => (TIPOS_IMAGEM[f.type] ? 'foto' : TIPOS_VIDEO[f.type] ? 'video' : 'anexo');
      try {
        for (const f of arquivos) {
          const k = tipoDe(f);
          validarArquivo(f, k === 'video' ? TAMANHO_MAX_VIDEO : TAMANHO_MAX_OBRA, k === 'video' ? TIPOS_VIDEO : k === 'foto' ? TIPOS_IMAGEM : TIPOS_ACEITOS);
        }
      } catch (err) { return erro(err.message); }
      const btn = form.querySelector('[value=ok]'); btn.disabled = true; erro('');
      try {
        await noBanco();
        const c = await sb();
        const base = midiasRdo(o, d.id).length;
        for (const [i, f] of arquivos.entries()) {
          form.querySelector('.progresso').textContent = `Enviando ${i + 1} de ${arquivos.length}: ${f.name}…`;
          const k = tipoDe(f);
          const caminho = await enviarArquivo(ctx().orgId, 'obras', `${o.id}/rdo/${d.id}`, f, k === 'video' ? TAMANHO_MAX_VIDEO : TAMANHO_MAX_OBRA, k === 'video' ? TIPOS_VIDEO : k === 'foto' ? TIPOS_IMAGEM : TIPOS_ACEITOS);
          const atv = form.atividade.value || null;
          ok(await c.from('rdo_media').insert({ report_id: d.id, project_id: o.id, kind: k, storage_path: caminho, name: f.name, caption: form.legenda.value.trim(),
            taken_on: form.data.value || null, phase_id: form.fase.value || (atv ? raiz(o, atv)?.id : null) || null, activity_id: atv, mime_type: f.type, size_bytes: f.size, position: base + i }), 'mídia');
        }
        await carregarDiarioNuvem(true);
        toast(`${arquivos.length} arquivo(s) incluído(s).`);
        finish(true);
      } catch (err) { btn.disabled = false; erro(err.message); }
    };
    dlg.showModal();
  });
}

/* ---------- PDF ---------- */
async function imagemParaPdf(caminho, maxLado = 1400) {
  if (!caminho) return null;
  try {
    const url = caminho.startsWith('data:') ? caminho : (await urlsTemporarias([caminho])).get(caminho);
    if (!url) return null;
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const esc_ = Math.min(1, maxLado / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * esc_); cv.height = Math.round(bmp.height * esc_);
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height);
    return { data: cv.toDataURL('image/jpeg', 0.82), w: cv.width, h: cv.height };
  } catch { return null; }
}

/** PDF de um ou mais relatórios. `faseId` limita atividades e fotos à fase (e tudo abaixo dela). */
async function gerarPdf(o, relatorios, { titulo, faseId = '' } = {}) {
  if (!relatorios.length) return toast('Nenhum relatório para o PDF.');
  toast('Gerando PDF…');
  await loadScript(LIBS.jspdf); await loadScript(LIBS.autotable);
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 12;
  const daFase = faseId ? idsDaFase(o, faseId) : null;
  const [logo, capa] = await Promise.all([imagemParaPdf(X.logo, 600), imagemParaPdf(o.capa, 800)]);
  const encaixe = (im, maxW, maxH) => { const r = Math.min(maxW / im.w, maxH / im.h); return [im.w * r, im.h * r]; };
  const azul = [20, 48, 90];
  const lista = [...relatorios].sort((a, b) => a.data.localeCompare(b.data));
  for (const [ri, d] of lista.entries()) {
    if (ri) doc.addPage();
    let y = M;
    if (logo) { const [w, h] = encaixe(logo, 45, 18); doc.addImage(logo.data, 'JPEG', M, y, w, h); }
    if (capa) { const [w, h] = encaixe(capa, 40, 22); doc.addImage(capa.data, 'JPEG', W / 2 - w / 2, y, w, h); }
    doc.setFontSize(9); doc.setTextColor(...azul);
    doc.text([`Relatório nº ${d.numero || '—'}`, periodoRdo(d), diasDaSemanaRdo(d), (STATUS_RDO[d.status || 'preenchendo']?.rotulo || '')], W - M, y + 4, { align: 'right' });
    y += 26;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(titulo || 'Relatório Diário de Obra (RDO)', W / 2, y, { align: 'center' }); doc.setFont('helvetica', 'normal');
    y += 3;
    const pz = prazosObra(o, fimRdo(d));
    doc.autoTable({ startY: y, theme: 'grid', styles: { fontSize: 8, cellPadding: 1.4 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 28 }, 2: { fontStyle: 'bold', cellWidth: 30 } }, margin: { left: M, right: M },
      body: [['Obra', o.nome, 'Nº do contrato', o.numeroContrato || ''], ['Endereço', [o.endereco, o.cidade].filter(Boolean).join(' — '), 'Prazo contratual', pz ? `${pz.contratual} dias` : '—'],
        ['Contratante', o.cliente?.nome || '', 'Prazo decorrido', pz ? `${pz.decorrido} dias` : '—'], ['Responsável', o.engenheiro || d.responsavel || '', 'Prazo a vencer', pz ? `${pz.aVencer} dias` : '—'],
        ...(faseId ? [['Fase', `${ativ(o, faseId)?.codigo || ''} ${ativ(o, faseId)?.descricao || ''}`, '', '']] : [])] });
    y = doc.lastAutoTable.finalY + 3;
    const bloco = (tit, head, body) => {
      if (!body.length) return;
      doc.autoTable({ startY: y, head: [[{ content: tit, colSpan: head.length, styles: { fillColor: [240, 236, 232], textColor: azul, fontStyle: 'bold' } }], head], body,
        theme: 'grid', styles: { fontSize: 7.8, cellPadding: 1.3, valign: 'top' }, headStyles: { fillColor: azul }, margin: { left: M, right: M } });
      y = doc.lastAutoTable.finalY + 3;
    };
    bloco('Condições de trabalho', ['Clima manhã', 'Clima tarde', 'Praticável', 'Condições / justificativa'], [[d.clima?.manha || '', d.clima?.tarde || '', d.praticavel === false ? 'Não' : 'Sim', [d.condicoes, d.justificativa].filter(Boolean).join(' — ')]]);
    const servs = (d.servicos || []).filter((s) => !daFase || (s.atividadeId && daFase.has(s.atividadeId)));
    bloco(`Atividades (${servs.length})`, ['Atividade', 'Descrição', 'Quantidade', 'Situação'], servs.map((s) => { const a = ativ(o, s.atividadeId); return [a ? `${a.codigo} ${a.descricao}` : '—', s.descricao || '', s.qtd != null ? `${qtd(s.qtd)} ${s.unidade || ''}` : '', situacaoServico(o, d, s)]; }));
    if (!daFase) {
      bloco('Mão de obra', ['Função', 'Tipo', 'Empresa', 'Qtd.'], (d.equipe || []).map((e) => [e.funcao, e.tipo === 'terceirizada' ? 'Terceirizada' : 'Própria', e.empresa || '', String(e.qtd ?? '')]));
      bloco('Equipamentos', ['Equipamento', 'Qtd.', 'Horas'], (d.equipamentosLista || []).map((e) => [e.nome, qtd(e.qtd), qtd(e.horas)]));
      bloco('Ocorrências', ['Horário', 'Tipo', 'Descrição', 'Providências', 'Situação'], (d.ocorrencias || []).map((x) => [x.hora || '', x.tipo, x.descricao, x.providencias || '', x.resolvida ? 'Resolvida' : 'Em aberto']));
      bloco('Materiais', ['Material', 'Quantidade', 'Fornecedor', 'Divergência'], (d.materiaisLista || []).map((m) => [m.descricao, `${qtd(m.qtd)} ${m.unidade || ''}`, m.fornecedor || '', m.divergencia || '']));
      const obs = [d.visitas && `Visitas: ${d.visitas}`, d.reunioes && `Reuniões: ${d.reunioes}`, d.observacoes, d.materiais && `Materiais: ${d.materiais}`, d.equipamentos && `Equipamentos: ${d.equipamentos}`].filter(Boolean);
      bloco('Observações', ['Texto'], obs.map((t) => [t]));
      bloco('Comentários', ['Autor', 'Data', 'Comentário'], (X.comentarios.get(d.id) || []).map((c) => [c.author_label, new Date(c.created_at).toLocaleString('pt-BR'), c.body]));
    }
    const ms = midiasRdo(o, d.id);
    const fotos = ms.filter((m) => m.kind === 'foto' && (!daFase || daFase.has(m.phase_id) || daFase.has(m.activity_id)));
    if (fotos.length) {
      if (y > 250) { doc.addPage(); y = M; }
      doc.setFontSize(10); doc.setTextColor(...azul); doc.setFont('helvetica', 'bold'); doc.text(`Fotos (${fotos.length})`, M, y + 4); doc.setFont('helvetica', 'normal'); y += 7;
      const cw = (W - 2 * M - 6) / 2, ch = 62;
      for (const [i, m] of fotos.entries()) {
        const col = i % 2;
        if (col === 0 && y + ch + 10 > 287) { doc.addPage(); y = M; }
        const im = await imagemParaPdf(m.storage_path);
        const x = M + col * (cw + 6);
        if (im) { const [w, h] = encaixe(im, cw, ch); doc.addImage(im.data, 'JPEG', x + (cw - w) / 2, y + (ch - h) / 2, w, h); }
        else { doc.setDrawColor(200); doc.rect(x, y, cw, ch); doc.setFontSize(7); doc.text('(imagem indisponível)', x + 2, y + 5); }
        doc.setFontSize(7.5); doc.setTextColor(60); doc.text(doc.splitTextToSize(m.caption || m.name || '', cw), x, y + ch + 3.5);
        if (col === 1 || i === fotos.length - 1) y += ch + 10;
      }
    }
    const vids = ms.filter((m) => (m.kind === 'video' || m.kind === 'link') && !daFase);
    if (vids.length) bloco(`Vídeos (${vids.length})`, ['Vídeo', 'Legenda'], vids.map((m) => [m.kind === 'link' ? m.url : `${m.name} (arquivo no GEPLAN)`, m.caption || '']));
    const anexos = ms.filter((m) => m.kind === 'anexo' && !daFase);
    if (anexos.length) bloco(`Anexos (${anexos.length})`, ['Arquivo'], anexos.map((m) => [m.name]));
    // assinaturas
    if (y > 245) { doc.addPage(); y = M; }
    y += 6;
    const [sr, sa] = await Promise.all([imagemParaPdf(d.assinaturaResponsavel, 600), imagemParaPdf(d.assinaturaAprovador, 600)]);
    const aw = 75;
    for (const [i, [im, nome, rot]] of [[sr, d.assinadoPor || d.responsavel || '', 'Responsável pelo preenchimento'], [sa, d.aprovadoPor || '', d.aprovadoPor ? `Aprovado em ${new Date(d.aprovadoEm).toLocaleDateString('pt-BR')}` : 'Aprovação']].entries()) {
      const x = M + 8 + i * (aw + 20);
      if (im) { const [w, h] = encaixe(im, aw, 22); doc.addImage(im.data, 'JPEG', x + (aw - w) / 2, y, w, h); }
      doc.setDrawColor(120); doc.line(x, y + 24, x + aw, y + 24);
      doc.setFontSize(8); doc.setTextColor(60); doc.text(nome || '—', x + aw / 2, y + 28, { align: 'center' }); doc.text(rot, x + aw / 2, y + 32, { align: 'center' });
    }
  }
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p); doc.setFontSize(7); doc.setTextColor(130);
    doc.text(`${o.nome} · gerado pelo GEPLAN em ${new Date().toLocaleString('pt-BR')}`, M, 292);
    doc.text(`Página ${p} de ${total}`, W - M, 292, { align: 'right' });
  }
  const nome = lista.length === 1 ? `RDO ${lista[0].numero || ''} - ${o.nome}` : `RDOs ${periodoRdo({ data: lista[0].data, dataFim: fimRdo(lista[lista.length - 1]) })} - ${o.nome}`;
  doc.save(`${nome.replace(/[\\/:*?"<>|]/g, '-')}${faseId ? ' - fase' : ''}.pdf`);
}

/* ---------- ações ---------- */
const obraDe = (d) => store.obra(d.obra);
const rdoDe = (o, id) => (o.diario || []).find((x) => x.id === id);
export const acoesDiario = {
  rdoAbrir(d) { ir(`#/diario/${d.obra}/rdo/${d.id}`); },
  rdoLimparFiltro() { ui.diarioF = null; queueRender(); },
  rdoImprimir() { window.print(); },
  async rdoSalvar(dd) {
    const o = obraDe(dd); const form = document.getElementById('rdoForm');
    const novo = !!form.dataset.novo;
    const base = novo ? rascunho(o, 'novo') : rdoDe(o, dd.id);
    const d = lerFormulario(form, JSON.parse(JSON.stringify(base)));
    if (!d.data) return toast('Informe a data inicial.');
    try { salvarDiario(o, d, quem()); } catch (e) { return toast(e.message, 6000); }
    form.dataset.sujo = '';
    commit(o);
    if (novo) delete ui.rdoRascunho[`novo:${o.id}`];
    toast(novo ? `Relatório nº ${d.numero} criado.` : 'Relatório salvo.');
    ir(dd.ver || novo ? `#/diario/${o.id}/rdo/${d.id}${dd.ver ? '' : '/editar'}` : location.hash);
    if (!dd.ver && !novo) queueRender();
  },
  rdoDescartar(d) { delete (ui.rdoRascunho || {})[`novo:${d.obra}`]; },
  async rdoEnviar(dd) {
    const o = obraDe(dd); const d = rdoDe(o, dd.id);
    const v = await formDialog({ title: `Enviar o relatório nº ${d.numero} para revisão`, ok: 'Enviar', fields: [{ name: 'c', label: 'Comentário (opcional)' }, { name: 'assinar', label: 'Assinar agora como responsável pelo preenchimento', type: 'checkbox', value: !d.assinaturaResponsavel }] });
    if (!v) return;
    const assinatura = v.assinar ? await assinaturaParaBanco(o, d, 'Assinatura do responsável pelo preenchimento') : '';
    if (v.assinar && !assinatura) return;
    if (nuvemOn()) await acaoNuvem(d, 'enviar', { comentario: v.c, assinatura });
    else { Object.assign(d, { status: 'revisao', ...(assinatura ? { assinaturaResponsavel: assinatura, assinadoPor: quem(), assinadoEm: new Date().toISOString() } : {}) }); registrar(o, 'RDO enviado para revisão', `nº ${d.numero}`, quem()); commit(o); }
    toast('Relatório enviado para revisão.');
  },
  async rdoAssinar(dd) {
    const o = obraDe(dd); const d = rdoDe(o, dd.id);
    const assinatura = await assinaturaParaBanco(o, d, 'Assinatura do responsável pelo preenchimento');
    if (!assinatura) return;
    if (nuvemOn()) await acaoNuvem(d, 'assinar', { assinatura });
    else { Object.assign(d, { assinaturaResponsavel: assinatura, assinadoPor: quem(), assinadoEm: new Date().toISOString() }); commit(o); }
    toast('Assinatura registrada.');
  },
  async rdoAprovar(dd) {
    const o = obraDe(dd); const d = rdoDe(o, dd.id);
    if (!(await ask(`Aprovar o relatório nº ${d.numero} (${periodoRdo(d)})? Depois de aprovado ele não é mais editado, a menos que seja reaberto.`, 'Continuar'))) return;
    const assinatura = await assinaturaParaBanco(o, d, 'Assinatura de quem aprova');
    if (!assinatura) return;
    if (nuvemOn()) await acaoNuvem(d, 'aprovar', { assinatura });
    else { Object.assign(d, { status: 'aprovado', aprovadoPor: quem(), aprovadoEm: new Date().toISOString(), assinaturaAprovador: assinatura, notaRevisao: '' }); registrar(o, 'RDO aprovado', `nº ${d.numero}`, quem()); commit(o); }
    toast('Relatório aprovado.');
  },
  async rdoDevolver(dd) {
    const o = obraDe(dd); const d = rdoDe(o, dd.id);
    const v = await formDialog({ title: `Devolver o relatório nº ${d.numero}`, ok: 'Devolver', fields: [{ name: 'c', label: 'O que precisa ser corrigido (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    if (nuvemOn()) await acaoNuvem(d, 'devolver', { comentario: v.c });
    else { Object.assign(d, { status: 'devolvido', notaRevisao: v.c }); commit(o); }
    toast('Relatório devolvido para correção.');
  },
  async rdoReabrir(dd) {
    const o = obraDe(dd); const d = rdoDe(o, dd.id);
    const v = await formDialog({ title: `Reabrir o relatório nº ${d.numero}`, ok: 'Reabrir', text: 'A aprovação e a assinatura de quem aprovou são desfeitas (ficam no histórico).', fields: [{ name: 'c', label: 'Motivo (obrigatório)', type: 'textarea', required: true }] });
    if (!v) return;
    if (nuvemOn()) await acaoNuvem(d, 'reabrir', { comentario: v.c });
    else { Object.assign(d, { status: 'preenchendo', notaRevisao: v.c, aprovadoPor: '', aprovadoEm: '', assinaturaAprovador: '' }); commit(o); }
    toast('Relatório reaberto.');
  },
  async rdoComentar(dd) {
    const el = document.getElementById('rdoComentario'); const txt = el.value.trim();
    if (!txt) return toast('Escreva o comentário.');
    const o = obraDe(dd);
    await noBanco();
    ok(await (await sb()).from('rdo_comments').insert({ report_id: dd.id, project_id: o.id, body: txt }), 'comentário');
    el.value = '';
    await carregarDiarioNuvem(true);
  },
  async rdoMidiaEnviar(dd) { const o = obraDe(dd); await janelaMidias(o, rdoDe(o, dd.id)); },
  async rdoLink(dd) {
    const o = obraDe(dd);
    const v = await formDialog({ title: 'Link de vídeo', ok: 'Incluir', text: 'Endereço do vídeo no YouTube, Google Drive ou outro serviço (https).', fields: [{ name: 'url', label: 'Endereço (https://…)', required: true }, { name: 'nome', label: 'Título' }, { name: 'legenda', label: 'Legenda' }] });
    if (!v) return;
    if (!/^https:\/\/\S+$/.test(v.url.trim())) return toast('Use um endereço começando com https://');
    await noBanco();
    ok(await (await sb()).from('rdo_media').insert({ report_id: dd.id, project_id: o.id, kind: 'link', url: v.url.trim(), name: v.nome.trim() || 'Vídeo', caption: v.legenda.trim(), position: midiasRdo(o, dd.id).length }), 'link');
    await carregarDiarioNuvem(true);
  },
  async rdoMidiaEditar(dd) {
    const o = obraDe(dd); const m = midiasObra(o.id).find((x) => x.id === dd.id);
    const v = await formDialog({ title: 'Legenda e vínculo', ok: 'Salvar', fields: [{ name: 'legenda', label: 'Legenda', value: m.caption },
      { name: 'atividade', label: 'Atividade da EAP', type: 'select', value: m.activity_id || '', options: [{ value: '', label: '—' }, ...folhas(o).map((a) => ({ value: a.id, label: `${a.codigo} ${a.descricao}` }))] }] });
    if (!v) return;
    ok(await (await sb()).from('rdo_media').update({ caption: v.legenda.trim(), activity_id: v.atividade || null, phase_id: v.atividade ? raiz(o, v.atividade)?.id : m.phase_id }).eq('id', m.id), 'mídia');
    await carregarDiarioNuvem(true);
  },
  async rdoMidiaRemover(dd) {
    if (!(await ask('Remover este arquivo do relatório? (A remoção fica no histórico.)', 'Remover'))) return;
    ok(await (await sb()).from('rdo_media').update({ deleted_at: new Date().toISOString() }).eq('id', dd.id), 'mídia');
    await carregarDiarioNuvem(true);
  },
  rdoFoto(dd) {
    const o = obraDe(dd); const m = midiasObra(o.id).find((x) => x.id === dd.id);
    if (!m) return;
    const d = rdoDe(o, m.report_id); const a = ativ(o, m.activity_id) || ativ(o, m.phase_id);
    info(m.caption || m.name || 'Foto', `<img class="foto-ampliada" data-path="${esc(m.storage_path)}" alt="${esc(m.caption || m.name)}">
      <div class="small muted" style="margin-top:6px">${d ? `RDO nº ${d.numero} · ${periodoRdo(d)}` : ''}${a ? ` · ${esc(a.codigo)} ${esc(a.descricao)}` : ''} · ${esc(m.author_label || '')}${m.taken_on ? ` · ${isoBR(m.taken_on)}` : ''}</div>
      ${d ? `<div style="margin-top:6px"><a href="${rota(`#/diario/${o.id}/rdo/${d.id}`)}" onclick="document.getElementById('dlg').close()">Abrir o relatório</a></div>` : ''}`);
    depoisDiario();
  },
  async rdoAnexo(dd) {
    const url = await urlTemporaria(dd.path, 300);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) info('Abrir anexo', `<p><a href="${esc(url)}" target="_blank" rel="noopener">Abrir ${esc(dd.nome)}</a> (link válido por 5 minutos).</p>`);
  },
  rdoLog(dd) {
    const ev = X.detalhes.get(dd.id)?.eventos || [];
    info('Log de edições', ev.length ? `<ul class="lista">${[...ev].reverse().map((e) => `<li><div class="small"><b>${esc(e.author_label || '—')}</b> <span class="muted">${new Date(e.created_at).toLocaleString('pt-BR')}</span></div>${esc(e.body)}</li>`).join('')}</ul><p class="muted small">Registrado pelo banco; não é editado nem apagado.</p>` : '<p class="muted">Sem registros.</p>');
  },
  rdoVistas(dd) {
    const vs = X.detalhes.get(dd.id)?.vistas || [];
    info('Visualizações', vs.length ? `<table class="data"><thead><tr><th>Pessoa</th><th>Última vez</th><th class="num">Vezes</th></tr></thead><tbody>${vs.map((v) => `<tr><td>${esc(v.user_label)}</td><td class="small">${new Date(v.last_at).toLocaleString('pt-BR')}</td><td class="num">${v.views}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Ninguém abriu ainda.</p>');
  },
  async rdoPdf(dd) { const o = obraDe(dd); try { await gerarPdf(o, [rdoDe(o, dd.id)]); } catch (e) { toast(`Não foi possível gerar o PDF: ${e.message}`, 6000); } },
  async rdoPdfLista(dd) { const o = obraDe(dd); try { await gerarPdf(o, filtrarDiario(o, filtroRel())); } catch (e) { toast(`Não foi possível gerar o PDF: ${e.message}`, 6000); } },
  async rdoPdfFase(dd) {
    const o = obraDe(dd);
    const faseId = dd.fonte === 'busca' ? ui.diarioBusca?.faseId : filtroRel().faseId;
    const f = dd.fonte === 'busca' ? ui.diarioBusca : filtroRel();
    const lista = filtrarDiario(o, { de: f.de, ate: f.ate, faseId });
    try { await gerarPdf(o, lista, { titulo: `RDO — fase ${ativ(o, faseId)?.descricao || ''}`, faseId }); } catch (e) { toast(`Não foi possível gerar o PDF: ${e.message}`, 6000); }
  },
  obraDiarioSalvar(dd) {
    const o = obraDe(dd); const f = document.getElementById('formObraDiario');
    const v = Object.fromEntries(new FormData(f));
    if (!v.nome.trim()) return toast('Informe o nome da obra.');
    if (v.terminoPlanejado && v.inicio && v.terminoPlanejado < v.inicio) return toast('A previsão de término é antes do início.');
    Object.assign(o, { nome: v.nome.trim(), status: v.status, codigo: v.codigo.trim(), numeroContrato: v.numeroContrato.trim(), endereco: v.endereco.trim(), cidade: v.cidade.trim(),
      engenheiro: v.engenheiro.trim(), inicio: v.inicio || o.inicio, inicioReal: v.inicioReal || '', terminoPlanejado: v.terminoPlanejado || '' });
    o.cliente = { ...(o.cliente || {}), nome: v.contratante.trim() };
    registrar(o, 'Cadastro da obra alterado', 'pelo Diário de obra', quem());
    commit(o); toast('Obra atualizada.');
  },
  async obraCapaRemover(dd) {
    const o = obraDe(dd);
    if (!(await ask('Remover a foto de capa? (O arquivo continua guardado.)', 'Remover'))) return;
    delete o.capa; commit(o);
  },
};
export const mudancasDiario = {
  diarioObrasStatus(d, el) { (ui.diarioObras ||= { busca: '', status: '' }).status = el.value; queueRender(); },
  diarioF(d, el) { filtroRel()[d.f] = el.value; queueRender(); },
  diarioBusca(d, el) { (ui.diarioBusca ||= {})[d.f] = el.value; queueRender(); },
  async obraCapa(dd, el) {
    const o = obraDe(dd); const f = el.files[0];
    if (!f) return;
    try {
      validarArquivo(f, TAMANHO_MAX_OBRA, TIPOS_IMAGEM);
      await noBanco();
      o.capa = await enviarArquivo(ctx().orgId, 'obras', `${o.id}/capa`, f, TAMANHO_MAX_OBRA, TIPOS_IMAGEM);
      commit(o); toast('Foto de capa atualizada.');
    } catch (e) { toast(e.message, 6000); el.value = ''; }
  },
};
export const entradasDiario = {
  diarioObrasBusca(el) { (ui.diarioObras ||= { busca: '', status: '' }).busca = el.value; queueRender(); },
  diarioTarefas(el) { ui.diarioTarefas = el.value; queueRender(); },
  diarioTexto(el) { filtroRel().texto = el.value; queueRender(); },
};
