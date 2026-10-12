// Permissões na interface (só para mostrar/esconder controles). A verificação que vale é a do banco (RLS);
// no modo Google Drive (sem banco) tudo é permitido, como antes.
import * as nuvem from './nuvem/nuvem.js';
import { liberacoesDe } from './liberacoes.js';

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

/** A pessoa tem esta liberação (solicitar, comprar, receber, fornecedores)? No modo Drive, sim. */
export function liberado(chave) {
  const ctx = nuvem.contexto();
  if (!ctx) return true;
  return (ctx.liberacoes || liberacoesDe(ctx.papel)).includes(chave);
}

/** O perfil atual pode alterar esta área? (compras segue a liberação "comprar") */
export const pode = (area) => {
  if (!papel()) return true;
  if (area === 'compras') return papel() !== 'cliente' && liberado('comprar');
  return (AREAS[papel()] || []).includes(area);
};

/** O perfil vê custos internos? (cliente não vê — o banco também não envia esses dados a ele) */
export const veCustos = () => papel() !== 'cliente';

/** Aviso exibido na obra para perfis com permissão parcial. */
export function avisoDoPerfil() {
  const p = papel();
  if (!p || !O_QUE_PODE[p]) return '';
  let texto = O_QUE_PODE[p];
  if (p === 'supervisor' && liberado('comprar')) texto += ', e lançar contratos e pedidos de compra';
  if (['financeiro', 'compras'].includes(p) && !liberado('comprar')) texto = p === 'financeiro' ? 'lançar despesas e pagamentos' : 'consultar (sem liberação de compras)';
  return `<div class="alert info small" style="margin-bottom:12px">Seu perfil nesta empresa permite <b>${texto}</b>. Outras alterações não são gravadas.</div>`;
}
