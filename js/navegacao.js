// Navegação por áreas funcionais (menu lateral, menu do celular e seletor de obra dos módulos).
// Uma definição só (MENU) gera o menu do computador e do celular. Itens ainda não implementados aparecem como
// "em breve", sem link — não simulam funcionamento.
import * as store from './store.js';
import { esc } from './ui.js';
import { fmtBR, isoBR } from './schedule.js';
import { configurado as nuvemConfigurada } from './nuvem/supabase.js';

const svg = (p) => `<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICONES = {
  inicio: svg('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  obras: svg('<path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/>'),
  fases: svg('<path d="M4 6h10M4 12h16M4 18h12"/><circle cx="18" cy="6" r="2"/><circle cx="20" cy="18" r="1.5"/>'),
  gantt: svg('<path d="M3 4v16h18"/><path d="M7 8h6M9 12h8M11 16h6"/>'),
  curva: svg('<path d="M3 20h18M3 20C9 20 9 6 21 4"/>'),
  orcamento: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>'),
  composicoes: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  medicoes: svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'),
  custos: svg('<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  diario: svg('<path d="M5 3h12a2 2 0 0 1 2 2v16l-4-2-4 2-4-2-2 1V5a2 2 0 0 1 2-2z"/><path d="M9 8h6M9 12h6"/>'),
  fisico: svg('<path d="M12 20V10M18 20V4M6 20v-4"/>'),
  tarefas: svg('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  compras: svg('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l3 12h11l2-8H6"/>'),
  entregas: svg('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>'),
  fornecedores: svg('<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6"/>'),
  documentos: svg('<path d="M7 18a5 5 0 0 1-.9-9.9A6 6 0 0 1 17.7 7 4.5 4.5 0 0 1 17.5 18z"/>'),
  config: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
};

/** Módulos que funcionam dentro de cada obra: o menu leva a um seletor de obra (ou direto, se houver uma só). */
export const MODULOS = {
  gantt: { rotulo: 'Cronograma', aba: 'gantt', texto: 'Gantt, caminho crítico, dependências e linha de base.' },
  curva: { rotulo: 'Curva S', aba: 'curva', texto: 'Curvas física e financeira, planejado × realizado.' },
  orcamento: { rotulo: 'Orçamentos', aba: 'orcamento', texto: 'Itens, composições, BDI, revisões e importação do Excel.' },
  medicoes: { rotulo: 'Medições', aba: 'medicoes', texto: 'Avanço físico acumulado por atividade.' },
  financeiro: { rotulo: 'Custos previstos e realizados', aba: 'financeiro', texto: 'Orçado, comprometido, incorrido e pago.' },
  diario: { rotulo: 'Diário de obra', aba: 'diario', texto: 'Registro diário: clima, equipe, serviços e ocorrências.' },
  painel: { rotulo: 'Acompanhamento físico', aba: 'painel', texto: 'Painel da obra: físico planejado × realizado, atrasos e prazos.' },
  compras: { rotulo: 'Compras no Financeiro', aba: 'financeiro', secao: 'compras', texto: 'Pedidos de compra e contratos registrados no Financeiro de cada obra (inclui as compras do quadro).' },
};

function menu() {
  const nuvem = nuvemConfigurada();
  return [
    { grupo: 'Visão geral', itens: [{ id: 'inicio', rotulo: 'Visão geral', href: '#/inicio', ico: 'inicio' }] },
    { grupo: 'Planejamento', itens: [
      { id: 'obras', rotulo: 'Obras', href: '#/obras', ico: 'obras' },
      { id: 'fases', rotulo: 'EAP e fases', href: '#/fases', ico: 'fases' },
      { id: 'mod-gantt', rotulo: 'Cronograma', href: '#/modulo/gantt', ico: 'gantt' },
      { id: 'mod-curva', rotulo: 'Curva S', href: '#/modulo/curva', ico: 'curva' },
    ] },
    { grupo: 'Orçamento e custos', itens: [
      { id: 'mod-orcamento', rotulo: 'Orçamentos', href: '#/modulo/orcamento', ico: 'orcamento' },
      { id: 'composicoes', rotulo: 'Composições de custos', href: '#/composicoes', ico: 'composicoes' },
      // modo nuvem: boletins por atividade e profissional; modo local: avanço físico por obra
      { id: 'mod-medicoes', rotulo: 'Medições', href: nuvem ? '#/medicoes' : '#/modulo/medicoes', ico: 'medicoes' },
      { id: 'mod-financeiro', rotulo: 'Custos previstos e realizados', href: '#/modulo/financeiro', ico: 'custos' },
    ] },
    { grupo: 'Execução e controle', itens: [
      { id: 'mod-diario', rotulo: 'Diário de obra', href: '#/diario', ico: 'diario' },
      { id: 'mod-painel', rotulo: 'Acompanhamento físico', href: '#/modulo/painel', ico: 'fisico' },
      { id: 'pendencias', rotulo: 'Tarefas e pendências', href: '#/pendencias', ico: 'tarefas' },
    ] },
    { grupo: 'Suprimentos', itens: [
      // quadro de compras e entregas usam o banco da empresa (modo nuvem)
      ...[['quadro', 'Quadro de compras', 'compras', '#/suprimentos'], ['entregas', 'Entregas e recebimentos', 'entregas', '#/suprimentos/entregas']].map(([id, rotulo, ico, href]) => (nuvem
        ? { id: `sup-${id}`, rotulo, href, ico }
        : { id: `sup-${id}`, rotulo, ico, futuro: 'Funciona no modo nuvem (banco de dados da empresa). No modo local, use os pedidos de compra do Financeiro de cada obra.' })),
      // compromissos de compra registrados na aba Financeiro de cada obra (inclui os gerados pelo quadro)
      { id: 'mod-compras', rotulo: 'Compras no Financeiro', href: '#/modulo/compras', ico: 'custos' },
      nuvem ? { id: 'fornecedores', rotulo: 'Fornecedores', href: '#/fornecedores', ico: 'fornecedores' }
        : { id: 'fornecedores', rotulo: 'Fornecedores', ico: 'fornecedores', futuro: 'O cadastro de fornecedores funciona no modo nuvem (banco de dados da empresa).' },
    ] },
    { grupo: 'Documentos', itens: [
      { id: 'documentos', rotulo: 'Documentos da obra', ico: 'documentos', futuro: 'Em desenvolvimento: documentos, fotos e anexos das obras.' },
      nuvem
        ? { id: 'gdrive', rotulo: 'Google Drive', ico: 'documentos', futuro: 'No modo nuvem os dados ficam no banco da empresa; a integração com o Google Drive é usada só no modo local. Para uma cópia dos dados, use Administração › Configurações › Exportar.' }
        : { id: 'drive', rotulo: 'Google Drive e backup', href: '#/drive', ico: 'documentos' },
    ] },
    { grupo: 'Administração', itens: [
      ...(nuvem ? [{ id: 'drive', rotulo: 'Empresa, usuários e plano', href: '#/drive', ico: 'fornecedores' }] : []),
      { id: 'configuracoes', rotulo: 'Configurações', href: '#/configuracoes', ico: 'config' },
    ] },
  ];
}

/** Item do menu que corresponde à rota atual. */
export function itemAtivo(route) {
  if (route.name === 'obra') {
    if (route.sub === 'compras') return 'mod-compras';
    const porAba = { orcamento: 'mod-orcamento', vinculos: 'mod-orcamento', atividades: 'mod-gantt', gantt: 'mod-gantt', curva: 'mod-curva',
      medicoes: 'mod-medicoes', financeiro: 'mod-financeiro', diario: 'mod-diario', painel: 'mod-painel' };
    return porAba[route.tab] || 'obras';
  }
  if (route.name === 'modulo') return `mod-${route.modulo}`;
  if (route.name === 'importar') return 'obras';
  if (route.name === 'sinapi') return 'composicoes';
  if (route.name === 'fornecedor') return 'fornecedores';
  if (route.name === 'suprimentos') return route.secao === 'entregas' ? 'sup-entregas' : 'sup-quadro';
  if (route.name === 'diario') return 'mod-diario';
  if (route.name === 'medicoes') return 'mod-medicoes';
  return route.name;
}

export function renderMenu(route) {
  const ativo = itemAtivo(route);
  const html = menu().map((g) => `<div class="nav-grupo"><div class="nav-titulo">${esc(g.grupo)}</div>${g.itens.map((it) => it.futuro
    ? `<span class="nav-futuro" title="${esc(it.futuro)}" aria-disabled="true">${ICONES[it.ico]}<span>${esc(it.rotulo)}</span><span class="badge">em breve</span></span>`
    : `<a href="${it.href}" class="${it.id === ativo ? 'active' : ''}" ${it.id === ativo ? 'aria-current="page"' : ''}>${ICONES[it.ico]}<span>${esc(it.rotulo)}</span></a>`).join('')}</div>`).join('');
  document.getElementById('sidenav').innerHTML = html;
  // menu inferior do celular: atalhos principais + "Menu" (abre o menu completo)
  const atalhos = [['inicio', 'Início', '#/inicio', 'inicio'], ['obras', 'Obras', '#/obras', 'obras'], ['mod-gantt', 'Cronograma', '#/modulo/gantt', 'gantt'], ['mod-diario', 'Diário', '#/diario', 'diario']];
  document.getElementById('bottomnav').innerHTML = atalhos.map(([id, r, h, ic]) => `<a href="${h}" class="${id === ativo ? 'active' : ''}">${ICONES[ic]}${r}</a>`).join('')
    + `<a href="#" data-menu-celular>${ICONES.menu}Menu</a>`;
}

/* ---------- seletor de obra dos módulos ---------- */
/** Obra a abrir direto (só uma cadastrada), ou null para mostrar o seletor. */
export function obraUnica() {
  const os = store.obras();
  return os.length === 1 ? os[0] : null;
}
export const linkModulo = (o, m) => `#/obra/${o.id}/${m.aba}${m.secao ? `/${m.secao}` : ''}`;

export function viewModulo(route, resumoDe) {
  const m = MODULOS[route.modulo];
  if (!m) return `<div class="card empty"><p>Módulo não encontrado.</p><a class="btn" href="#/inicio">Voltar à visão geral</a></div>`;
  const obras = store.obras();
  let ultima = null;
  try { ultima = localStorage.getItem('planobras:ultimaObra'); } catch {}
  const ordem = [...obras].sort((a, b) => (b.id === ultima) - (a.id === ultima));
  return `<div class="page-head"><div><h1>${esc(m.rotulo)}</h1><div class="muted">${esc(m.texto)} Escolha a obra.</div></div></div>
    ${obras.length ? `<div class="obras-grid">${ordem.map((o) => {
      const r = resumoDe(o);
      return `<a class="card obra-card" href="${linkModulo(o, m)}">
        <div class="row between"><b>${esc(o.nome)}</b>${o.id === ultima ? '<span class="badge info">última aberta</span>' : ''}</div>
        <div class="muted small">${esc(o.status || 'Planejamento')} · início ${isoBR(o.inicio)}${r.termino ? ` · término ${fmtBR(r.termino)}` : ''}</div>
      </a>`;
    }).join('')}</div>` : `<div class="card empty"><p>Nenhuma obra cadastrada ainda.</p><div class="row" style="justify-content:center"><a class="btn primary" href="#/inicio">Ir para a visão geral</a></div></div>`}`;
}
