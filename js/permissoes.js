// Permissões na interface (só para mostrar/esconder controles). A verificação que vale é a do banco (RLS);
// no modo Google Drive (sem banco) tudo é permitido, como antes.
import * as nuvem from './nuvem/nuvem.js';

const AREAS = {
  admin: ['cadastro', 'planejamento', 'execucao', 'compras', 'financeiro', 'biblioteca', 'empresa'],
  engenheiro: ['cadastro', 'planejamento', 'execucao', 'compras', 'financeiro', 'biblioteca'],
  supervisor: ['execucao'],
  financeiro: ['financeiro', 'compras'],
  compras: ['compras'],
  cliente: [],
};
const O_QUE_PODE = {
  supervisor: 'lançar medições e o diário de obra',
  financeiro: 'lançar contratos, pedidos, despesas e pagamentos',
  compras: 'lançar contratos e pedidos de compra',
  cliente: 'consultar (somente leitura)',
};

export const papel = () => nuvem.contexto()?.papel || null;
/** O perfil atual pode alterar esta área? */
export const pode = (area) => !papel() || (AREAS[papel()] || []).includes(area);

/** O perfil vê custos internos? (cliente não vê — o banco também não envia esses dados a ele) */
export const veCustos = () => papel() !== 'cliente';

/** Aviso exibido na obra para perfis com permissão parcial. */
export function avisoDoPerfil() {
  const p = papel();
  if (!p || !O_QUE_PODE[p]) return '';
  return `<div class="alert info small" style="margin-bottom:12px">Seu perfil nesta empresa permite <b>${O_QUE_PODE[p]}</b>. Outras alterações não são gravadas.</div>`;
}
