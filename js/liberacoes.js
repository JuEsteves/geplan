// Liberações por pessoa (modo nuvem). O administrador marca o que cada pessoa pode fazer; quando não marca nada,
// valem as liberações padrão do perfil. A verificação que vale é a do banco (função tem_liberacao, migração 0007);
// esta tabela precisa ser igual à função liberacoes_padrao() do banco (conferido em tests/db.html).
export const LIBERACOES = [
  { id: 'solicitar', rotulo: 'Solicitar materiais', texto: 'Cria solicitações de materiais para as obras que vê.' },
  { id: 'comprar', rotulo: 'Cotar e emitir pedidos', texto: 'Registra cotações, gera pedidos de compra e lança contratos e pedidos no Financeiro.' },
  { id: 'receber', rotulo: 'Registrar entregas', texto: 'Registra entregas e recebimentos de material na obra.' },
  { id: 'fornecedores', rotulo: 'Gerenciar fornecedores', texto: 'Cadastra, edita e inativa fornecedores.' },
  { id: 'aprovar_rdo', rotulo: 'Aprovar RDO', texto: 'Aprova, devolve e reabre relatórios diários de obra, com assinatura.' },
  { id: 'aprovar_medicao', rotulo: 'Aprovar medição', texto: 'Confere, ajusta a quantidade aprovada e aprova ou devolve boletins de medição.' },
];
export const IDS_LIBERACOES = LIBERACOES.map((l) => l.id);

export const LIBERACOES_PADRAO = {
  admin: ['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo', 'aprovar_medicao'],
  engenheiro: ['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo', 'aprovar_medicao'],
  compras: ['solicitar', 'comprar', 'receber', 'fornecedores'],
  financeiro: ['solicitar', 'comprar', 'fornecedores'],
  supervisor: ['solicitar', 'receber'],
  cliente: [],
};

/** Liberações efetivas de um membro (mesma regra do banco): admin tem todas; cliente, nenhuma. */
export function liberacoesDe(papel, permissoes = null) {
  if (papel === 'admin') return [...IDS_LIBERACOES];
  if (!papel || papel === 'cliente') return [];
  return [...(permissoes ?? LIBERACOES_PADRAO[papel] ?? [])];
}
