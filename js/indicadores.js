// Indicadores por obra e consolidados (Visão geral, Tarefas e pendências, Painel da obra).
// Usa as mesmas regras do restante do app (curvaS, execucao, financeiro) — nada é calculado "à parte".
//
// CRITÉRIOS
//  • Obra ativa: status diferente de "Concluída" e "Cancelada".
//  • Avanço físico da obra: % físico realizado hoje (curvaS.avanco), ponderado pelo critério de peso físico
//    escolhido na obra (HH, custo, duração ou manual). Obras sem EAP ou sem peso físico não entram na média.
//  • Avanço físico médio: média simples entre as obras ativas que têm avanço calculável (cada obra conta igual).
//  • Atividade atrasada: atividade do último nível cujo % medido até hoje está mais de 0,5 ponto abaixo do %
//    planejado para hoje pelo cronograma atual (mesma regra do Painel da obra).
//  • Pendência: impedimento/interferência/ocorrência do diário ainda não marcada como resolvida.
//  • Situação do cronograma: Atrasada se o físico realizado está mais de 5 pontos abaixo do planejado;
//    Atenção se está entre 0,5 e 5 pontos abaixo; Em dia caso contrário; "Não iniciada" quando ainda não há
//    nada planejado nem medido até hoje; "Sem cronograma" sem EAP.
//  • Custo realizado: soma das despesas lançadas (custo incorrido), igual ao Financeiro da obra.
//  • Próximas atividades: atividades do último nível ainda sem avanço com início previsto nos próximos 14 dias.
//  • Pedidos de compra (aba Financeiro da obra, tipo "Pedido de compra"):
//      em andamento      = status "Em cotação", "Aprovado" ou "Entregue parcialmente" (cancelados e concluídos fora);
//      aguardando cotação = status "Em cotação";
//      entrega pendente   = compra aprovada ("Aprovado" ou "Entregue parcialmente") ainda não recebida por completo —
//                           só "Entregue"/"Encerrado" contam como entregue (confirmação registrada pelo usuário);
//      entrega atrasada   = entrega pendente com "data necessária" anterior a hoje;
//      entrega próxima    = entrega pendente com "data necessária" entre hoje e os próximos 7 dias.
import { avanco, fracPlanejada, pctRealAte } from './curvaS.js';
import { pendenciasAbertas } from './execucao.js';
import { resumoCustos } from './financeiro.js';
import { todayDay, toDay } from './schedule.js';

const EM_ANDAMENTO = ['Em cotação', 'Aprovado', 'Entregue parcialmente'];
const COMPRA_FEITA = ['Aprovado', 'Entregue parcialmente'];
/** Situação dos pedidos de compra de uma obra (regras no cabeçalho). */
export function pedidosDaObra(o, hoje = todayDay()) {
  const pedidos = (o.compromissos || []).filter((k) => String(k.tipo || '').startsWith('Pedido'));
  const pendentes = pedidos.filter((k) => COMPRA_FEITA.includes(k.status));
  const dia = (k) => (k.dataNecessaria ? toDay(k.dataNecessaria) : null);
  return {
    total: pedidos.length,
    emAndamento: pedidos.filter((k) => EM_ANDAMENTO.includes(k.status)),
    aguardandoCotacao: pedidos.filter((k) => k.status === 'Em cotação'),
    entregasPendentes: pendentes,
    entregasAtrasadas: pendentes.filter((k) => dia(k) != null && dia(k) < hoje),
    entregasProximas: pendentes.filter((k) => dia(k) != null && dia(k) >= hoje && dia(k) <= hoje + 7),
  };
}

export const STATUS_INATIVOS = ['Concluída', 'Cancelada'];
export const obraAtiva = (o) => !STATUS_INATIVOS.includes(o.status);

const folhas = (c) => [...c.cron.nos.values()].filter((n) => n.folha);

/** Atividades atrasadas na data (regra única, usada também pelo Painel da obra). */
export function atividadesAtrasadas(c, hoje = todayDay(), filtro = () => true) {
  return folhas(c).filter((n) => filtro(n) && pctRealAte(c.o, n.a, hoje) + 0.5 < fracPlanejada(n, c.cron.cal, hoje, c.o) * 100);
}

/** Resumo de uma obra a partir do seu contexto calculado (calc + cronograma). */
export function resumoObra(c, hoje = todayDay()) {
  const { o, calc, cron } = c;
  const temEap = o.eap.length > 0;
  const av = temEap ? avanco(o, calc, cron, hoje) : null;
  const temAvanco = !!av && !av.semPeso;
  const atrasadas = temEap ? atividadesAtrasadas(c, hoje) : [];
  const pend = pendenciasAbertas(o);
  const custos = resumoCustos(o);
  const temDespesas = (o.despesas || []).length > 0;
  const proximas = temEap ? folhas(c).filter((n) => pctRealAte(o, n.a, hoje) === 0 && n.inicio >= hoje && n.inicio <= hoje + 14)
    .sort((a, b) => a.inicio - b.inicio) : [];
  let situacao = 'Sem cronograma';
  if (o.status === 'Concluída') situacao = 'Concluída';
  else if (temAvanco) {
    const d = av.fisicoReal - av.fisicoPlan;
    situacao = av.fisicoPlan === 0 && av.fisicoReal === 0 ? 'Não iniciada' : d < -5 ? 'Atrasada' : d < -0.5 ? 'Atenção' : 'Em dia';
  }
  // pendências de planejamento: o que impede o cronograma de ser confiável
  const itensSemVinculo = [...calc.itens.values()].filter((x) => x.status !== 'OK').length;
  const ativComAlerta = [...calc.ativ.values()].filter((x) => x.folha && x.alertas.length).length;
  const planejamento = [];
  if (!temEap) planejamento.push('Sem atividades (EAP)');
  if (!o.orcamento.length) planejamento.push('Sem orçamento');
  if (itensSemVinculo) planejamento.push(`${itensSemVinculo} item(ns) do orçamento sem vínculo de 100% com a EAP`);
  if (ativComAlerta) planejamento.push(`${ativComAlerta} atividade(s) com alerta (ex.: duração provisória)`);
  if (cron.ciclo) planejamento.push('Dependência circular entre atividades');
  if (temEap && !o.linhaBase) planejamento.push('Linha de base não aprovada');
  return {
    o, ativa: obraAtiva(o), temEap, av, temAvanco, situacao, atrasadas, pend, proximas, planejamento,
    inicio: o.inicio, termino: temEap ? cron.termino : null, custos, temDespesas, pedidos: pedidosDaObra(o, hoje),
  };
}

/** Consolidado das obras (para a Visão geral). */
export function consolidado(resumos) {
  const ativas = resumos.filter((r) => r.ativa);
  const comAvanco = ativas.filter((r) => r.temAvanco);
  const comDespesas = resumos.filter((r) => r.temDespesas);
  return {
    total: resumos.length,
    ativas: ativas.length,
    avancoMedio: comAvanco.length ? comAvanco.reduce((s, r) => s + r.av.fisicoReal, 0) / comAvanco.length : null,
    obrasNoAvanco: comAvanco.length,
    atrasadas: ativas.reduce((s, r) => s + r.atrasadas.length, 0),
    pendencias: ativas.reduce((s, r) => s + r.pend.length, 0),
    custoRealizado: comDespesas.length ? comDespesas.reduce((s, r) => s + r.custos.incorrido, 0) : null,
    obrasComDespesas: comDespesas.length,
    temPedidos: resumos.some((r) => r.pedidos.total > 0),
    pedidosEmAndamento: ativas.reduce((s, r) => s + r.pedidos.emAndamento.length, 0),
    entregasPendentes: ativas.reduce((s, r) => s + r.pedidos.entregasPendentes.length, 0),
    entregasAtrasadas: ativas.reduce((s, r) => s + r.pedidos.entregasAtrasadas.length, 0),
  };
}
