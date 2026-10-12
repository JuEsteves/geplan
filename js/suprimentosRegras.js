// Regras de Suprimentos sem acesso a banco ou tela (testadas em tests/index.html). Quem decide a situação gravada é o
// banco (migração 0007, funções recalc_grupo/recalc_pedido); aqui ficam os mesmos critérios para a tela explicar e
// filtrar — os testes conferem que as duas versões dão o mesmo resultado.
//
//  • Etapa (coluna) de cada grupo: 1 aguardando análise · 2 em cotação/aguardando aprovação ·
//    3 compra realizada, aguardando entrega, disponível para retirada, entrega parcial · 4 encerrado
//    (entregue e conferido, pendência resolvida com motivo, cancelado com motivo).
//  • Pedido: sem grupos → Pedido de compra; todos cancelados → Cancelado; todos encerrados → Entregue / concluído;
//    senão fica na coluna do grupo MENOS adiantado e, se os grupos abertos estão em etapas diferentes (ou parte
//    já encerrou), a situação é "Em andamento". Nunca é marcado como concluído à mão.
//  • Grupo entregue = todos os itens obrigatórios recebidos por completo (soma das entregas ≥ quantidade pedida).
//  • Atrasos: pedido com data necessária anterior a hoje e ainda aberto; grupo comprado com previsão anterior a hoje
//    e ainda não entregue.
//  • Comparação de cotações: total = materiais + frete; "menor valor" e "menor prazo" só ordenam os números.
//  • Indicadores de entrega do fornecedor: "no prazo" = entrega até a data necessária do pedido (ou, sem ela, até a
//    previsão do grupo); "quantidade conforme" = entregas marcadas como conferidas sem divergência.

export const STATUS_GRUPO = {
  analise: { rotulo: 'Aguardando análise', etapa: 1, cls: '' },
  cotacao: { rotulo: 'Em cotação', etapa: 2, cls: 'info' },
  aprovacao: { rotulo: 'Aguardando aprovação', etapa: 2, cls: 'info' },
  comprado: { rotulo: 'Compra realizada', etapa: 3, cls: 'warn' },
  aguardando_entrega: { rotulo: 'Aguardando entrega', etapa: 3, cls: 'warn' },
  retirada: { rotulo: 'Disponível para retirada', etapa: 3, cls: 'warn' },
  entrega_parcial: { rotulo: 'Entrega parcial', etapa: 3, cls: 'crit' },
  entregue: { rotulo: 'Entregue e conferido', etapa: 4, cls: 'good' },
  cancelado: { rotulo: 'Cancelado', etapa: 4, cls: '' },
  resolvido: { rotulo: 'Pendência resolvida', etapa: 4, cls: 'good' },
};
export const STATUS_PEDIDO = {
  pedido: 'Pedido de compra', em_cotacao: 'Em cotação', em_andamento: 'Em andamento',
  aguardando_entrega: 'Compra realizada / aguardando entrega', concluido: 'Entregue / concluído', cancelado: 'Cancelado',
};
export const COLUNAS = [
  { etapa: 1, titulo: 'Pedido de compra', texto: 'Criado ou aguardando análise' },
  { etapa: 2, titulo: 'Em cotação', texto: 'Comprador pedindo e comparando propostas' },
  { etapa: 3, titulo: 'Compra realizada / aguardando entrega', texto: 'Comprado, aguardando entrega ou retirada' },
  { etapa: 4, titulo: 'Entregue / concluído', texto: 'Todos os grupos entregues e conferidos (ou resolvidos)' },
];
/** Passagens manuais (as demais têm ação própria: registrar compra, entregas, cancelar, resolver). */
export const PASSAGENS_MANUAIS = {
  analise: ['cotacao'], cotacao: ['analise'], aprovacao: ['analise', 'cotacao'],
  comprado: ['aguardando_entrega', 'retirada'], aguardando_entrega: ['comprado', 'retirada'], retirada: ['aguardando_entrega', 'comprado'],
  entrega_parcial: ['aguardando_entrega', 'retirada'],
};
export const OCORRENCIAS = {
  nenhuma: 'Sem ocorrência', falta: 'Falta de material', avaria: 'Avaria', produto_diferente: 'Produto diferente do pedido', outro: 'Outra ocorrência',
};

export const etapaGrupo = (st) => STATUS_GRUPO[st]?.etapa ?? 4;
export const numeroPedido = (n) => `PED-${String(n).padStart(4, '0')}`;

/** Mesma regra do banco (recalc_pedido). `grupos` = grupos não excluídos do pedido. */
export function situacaoPedido(grupos) {
  const g = (grupos || []).filter((x) => !x.deleted_at);
  if (!g.length) return { status: 'pedido', etapa: 1 };
  if (g.every((x) => x.status === 'cancelado')) return { status: 'cancelado', etapa: 4 };
  const abertos = g.filter((x) => etapaGrupo(x.status) < 4).map((x) => etapaGrupo(x.status));
  if (!abertos.length) return { status: 'concluido', etapa: 4 };
  const min = Math.min(...abertos), max = Math.max(...abertos);
  const status = min !== max || abertos.length < g.length ? 'em_andamento' : ['pedido', 'em_cotacao', 'aguardando_entrega'][min - 1];
  return { status, etapa: min };
}

/** Quantidade recebida por item (entregas não desfeitas). */
export function recebidoPorItem(entregas, itensEntrega) {
  const validas = new Set((entregas || []).filter((e) => !e.deleted_at).map((e) => e.id));
  const m = new Map();
  for (const di of itensEntrega || []) if (validas.has(di.delivery_id)) m.set(di.item_id, (m.get(di.item_id) || 0) + Number(di.quantity));
  return m;
}

/** Situação dos itens de um grupo: pedido, recebido e pendente (nunca negativo). */
export function itensComSaldo(itens, recebido) {
  return (itens || []).map((i) => {
    const rec = recebido.get(i.id) || 0;
    return { ...i, recebido: rec, pendente: Math.max(0, Number(i.quantity) - rec), excedente: Math.max(0, rec - Number(i.quantity)) };
  });
}

/** O que impede o pedido de ser concluído (mesmo texto da função pendencias_pedido do banco). */
export function pendenciasPedido(grupos, itensPorGrupo, recebido) {
  const fmt = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4, useGrouping: false });
  return (grupos || []).filter((g) => !g.deleted_at && etapaGrupo(g.status) < 4).sort((a, b) => a.position - b.position).map((g) => {
    let txt = etapaGrupo(g.status) <= 2 ? `ainda não comprado (${STATUS_GRUPO[g.status].rotulo})`
      : g.status === 'entrega_parcial' ? 'entrega parcial' : 'aguardando entrega';
    if (g.status === 'entrega_parcial') {
      const faltam = itensComSaldo(itensPorGrupo.get(g.id) || [], recebido).filter((i) => i.required !== false && i.pendente > 0)
        .sort((a, b) => a.position - b.position).map((i) => `${fmt(i.pendente)}${i.unit ? ` ${i.unit}` : ''} ${i.description}`);
      if (faltam.length) txt += ` — faltam: ${faltam.join('; ')}`;
    }
    return { grupo: g.name, pendencia: txt };
  });
}

/** Resumo para o cartão: grupos encerrados / total e atrasos. */
export function resumoPedido(p, grupos, hoje) {
  const g = (grupos || []).filter((x) => !x.deleted_at);
  const encerrados = g.filter((x) => etapaGrupo(x.status) === 4).length;
  const aberto = !['concluido', 'cancelado'].includes(p.status);
  const gruposAtrasados = g.filter((x) => etapaGrupo(x.status) === 3 && x.expected_date && x.expected_date < hoje);
  const previsoes = g.filter((x) => etapaGrupo(x.status) === 3 && x.expected_date).map((x) => x.expected_date).sort();
  return {
    total: g.length, encerrados, pct: g.length ? Math.round((encerrados / g.length) * 100) : 0,
    atrasado: aberto && ((p.needed_date && p.needed_date < hoje) || gruposAtrasados.length > 0),
    gruposAtrasados, proximaPrevisao: previsoes[0] || null,
  };
}

/** Filtros do quadro. `aux.fornecedoresDoPedido(p)` → nomes de fornecedores dos grupos. */
export function filtrarPedidos(pedidos, f = {}, aux = {}) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const t = norm(f.busca).trim();
  return (pedidos || []).filter((p) => {
    if (!f.cancelados && p.status === 'cancelado') return false;
    if (f.obra && p.project_id !== f.obra) return false;
    if (f.fase && p.phase_id !== f.fase) return false;
    if (f.prioridade && p.priority !== f.prioridade) return false;
    if (f.solicitante && norm(p.requester_label) !== norm(f.solicitante)) return false;
    if (f.comprador && norm(p.buyer_label) !== norm(f.comprador)) return false;
    if (f.fornecedor && !(aux.fornecedoresDoPedido?.(p) || []).some((n) => norm(n) === norm(f.fornecedor))) return false;
    const criado = String(p.created_at || '').slice(0, 10);
    if (f.de && criado < f.de) return false;
    if (f.ate && criado > f.ate) return false;
    if (!t) return true;
    return norm(`${numeroPedido(p.number)} ${p.number} ${p.title}`).includes(t);
  });
}

/** Cotações válidas em ordem de total, com diferença para o menor e marcas de menor valor/prazo. */
export function comparativoCotacoes(cotacoes) {
  const lista = (cotacoes || []).filter((c) => !c.deleted_at).map((c) => ({ ...c, total: Math.round(((Number(c.total_amount) || 0) + (Number(c.freight_amount) || 0)) * 100) / 100 }));
  lista.sort((a, b) => a.total - b.total || (a.lead_days ?? 1e9) - (b.lead_days ?? 1e9));
  const consideradas = lista.filter((c) => c.status !== 'descartada');
  const menor = consideradas.length ? Math.min(...consideradas.map((c) => c.total)) : null;
  const prazos = consideradas.map((c) => c.lead_days).filter((x) => x != null);
  const menorPrazo = prazos.length ? Math.min(...prazos) : null;
  return lista.map((c) => ({
    ...c,
    menorValor: c.status !== 'descartada' && menor != null && c.total === menor,
    menorPrazo: c.status !== 'descartada' && menorPrazo != null && c.lead_days === menorPrazo,
    acimaDoMenor: menor != null && c.status !== 'descartada' ? Math.round((c.total - menor) * 100) / 100 : null,
    acimaPct: menor ? Math.round(((c.total - menor) / menor) * 1000) / 10 : null,
  }));
}

/** Indicadores das entregas de um fornecedor. `limites` = Map(id do grupo → data limite "AAAA-MM-DD" ou ''). */
export function indicadoresEntrega(entregas, limites) {
  const validas = (entregas || []).filter((e) => !e.deleted_at && limites.has(e.group_id));
  const comData = validas.filter((e) => limites.get(e.group_id));
  const noPrazo = comData.filter((e) => e.delivery_date <= limites.get(e.group_id)).length;
  const conformes = validas.filter((e) => e.quantity_ok && e.issue === 'nenhuma').length;
  const ocorrencias = {};
  for (const e of validas) if (e.issue && e.issue !== 'nenhuma') ocorrencias[e.issue] = (ocorrencias[e.issue] || 0) + 1;
  return {
    entregas: validas.length, comDataNecessaria: comData.length, noPrazo,
    pctNoPrazo: comData.length ? Math.round((noPrazo / comData.length) * 1000) / 10 : null,
    conformes, pctConformes: validas.length ? Math.round((conformes / validas.length) * 1000) / 10 : null,
    ocorrencias, totalOcorrencias: Object.values(ocorrencias).reduce((a, b) => a + b, 0),
  };
}

/** Itens digitados no formulário → itens válidos ou erro. Linhas vazias são ignoradas. */
export function validarItens(itens, { exigirUm = true } = {}) {
  const ok = [];
  for (const [i, it] of (itens || []).entries()) {
    const desc = String(it.description || '').trim();
    if (!desc && (it.quantity === '' || it.quantity == null)) continue;
    if (!desc) return { erro: `Item ${i + 1}: informe a descrição.` };
    const q = Number(it.quantity);
    if (!(q > 0)) return { erro: `Item ${i + 1} (${desc}): a quantidade precisa ser maior que zero.` };
    if (String(it.unit || '').length > 20) return { erro: `Item ${i + 1}: unidade muito longa.` };
    ok.push({ description: desc, quantity: q, unit: String(it.unit || '').trim(), spec: String(it.spec || '').trim(), notes: String(it.notes || '').trim() });
  }
  if (exigirUm && !ok.length) return { erro: 'Inclua pelo menos um item.' };
  return { itens: ok };
}
