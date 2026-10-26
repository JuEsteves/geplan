// Obra de exemplo (DEMONSTRAÇÃO) para conhecer o GEPLAN: EAP completa do modelo de etapas do GEPLAN + orçamento,
// composições, vínculos orçamento × EAP e equipes da planilha-modelo da dona do sistema ("ETAPAS DETALHADAS").
// Os valores são ILUSTRATIVOS (premissas) — a obra e as composições levam "(demonstração)" no nome para não serem
// confundidas com dados reais. Pode ser excluída a qualquer momento.
import { uid, novaObra, registrar } from './model.js';
import { aplicarComposicoes, modeloBase, instanciarModelo, selecaoPadrao } from './importador.js';

const FONTE = 'Premissa ilustrativa — substituir (Obra 21/SINAPI/TCPO)';
const MO = (...f) => f.map(([funcao, coef, lider]) => ({ funcao, coef, lider: !!lider }));
const COMPOSICOES = [
  ['C001', 'Forma de madeira para viga baldrame', 'm²', MO(['Carpinteiro', 1.1, 1], ['Ajudante de carpinteiro', 0.4])],
  ['C002', 'Armação aço CA-50 (corte, dobra e montagem)', 'kg', MO(['Armador', 0.1, 1], ['Ajudante de armador', 0.06])],
  ['C003', 'Concreto — lançamento e adensamento', 'm³', MO(['Pedreiro', 1.2, 1], ['Servente', 2.4])],
  ['C004', 'Alvenaria de bloco cerâmico 14 cm', 'm²', MO(['Pedreiro', 0.85, 1], ['Servente', 0.45])],
  ['C005', 'Chapisco', 'm²', MO(['Pedreiro', 0.1, 1], ['Servente', 0.05])],
  ['C006', 'Reboco massa única 2 cm', 'm²', MO(['Pedreiro', 0.7, 1], ['Servente', 0.55])],
  ['C007', 'Contrapiso 4 cm', 'm²', MO(['Pedreiro', 0.35, 1], ['Servente', 0.3])],
  ['C008', 'Piso porcelanato', 'm²', MO(['Azulejista', 0.55, 1], ['Servente', 0.25])],
  ['C009', 'Massa corrida PVA — 2 demãos', 'm²', MO(['Pintor', 0.3, 1], ['Ajudante de pintor', 0.08])],
  ['C010', 'Pintura látex acrílico — 2 demãos', 'm²', MO(['Pintor', 0.25, 1], ['Ajudante de pintor', 0.05])],
].map(([codigo, descricao, unidade, maoObra]) => ({ codigo: `EX-${codigo}`, descricao: `${descricao} (demonstração)`, unidade, fonte: FONTE, refSinapi: '', etapaEap: '', obs: 'Composição de demonstração — códigos EX- não se misturam com os da empresa', maoObra }));

// [código, etapa, subetapa, composição, quantidade, custo unitário]
const ORCAMENTO = [
  ['O-2.01', 'Fundação', 'Vigas baldrame', 'C001', 203, 95], ['O-2.02', 'Fundação', 'Vigas baldrame', 'C002', 850, 14.5],
  ['O-2.03', 'Fundação', 'Vigas baldrame', 'C003', 10.3, 720], ['O-3.01', 'Alvenaria e Pilares', 'Elevação da alvenaria', 'C004', 520, 78],
  ['O-7.01', 'Reboco e Impermeabilizações', 'Chapisco interno', 'C005', 1040, 8], ['O-7.02', 'Reboco e Impermeabilizações', 'Reboco interno', 'C006', 1040, 42],
  ['O-8.01', 'Contrapiso', 'Contrapiso interno', 'C007', 240, 48], ['O-11.01', 'Revestimentos', 'Piso interno porcelanato', 'C008', 240, 165],
  ['O-13.01', 'Pintura', 'Massa corrida interna', 'C009', 1040, 22], ['O-13.02', 'Pintura', 'Pintura interna', 'C010', 1040, 18],
];
// [item, atividade do modelo, fração]
const VINCULOS = [
  ['O-2.01', '2.4.4', 1], ['O-2.02', '2.4.3', 0.6], ['O-2.02', '2.4.5', 0.4], ['O-2.03', '2.4.8', 1], ['O-3.01', '3.2.2', 0.5],
  ['O-3.01', '3.2.4', 0.5], ['O-7.01', '7.1.2', 1], ['O-7.02', '7.2.2', 1], ['O-8.01', '8.1.4', 1], ['O-11.01', '11.1.3', 1],
  ['O-13.01', '13.1.3', 0.5], ['O-13.01', '13.1.4', 0.5], ['O-13.02', '13.1.6', 0.5], ['O-13.02', '13.1.7', 0.5],
];
// equipe (nº de profissionais da função líder) e duração manual (dias úteis)
const EQUIPES = { '2.4.3': 2, '2.4.4': 3, '2.4.5': 2, '2.4.8': 4, '3.2.2': 3, '3.2.4': 3, '7.1.2': 3, '7.2.2': 4, '8.1.4': 2, '11.1.3': 2, '13.1.3': 2, '13.1.4': 2, '13.1.6': 2, '13.1.7': 2 };
const MANUAIS = { '2.4.9': 3, '7.1.5': 3, '7.2.5': 7, '8.1.5': 3, '11.1.4': 2 };

/** Cria a obra de exemplo (altera `lib`: acrescenta as composições de demonstração, sem mexer nas existentes). */
export function criarObraExemplo(lib, { nome = 'Residência modelo (demonstração)', inicio, usuario = '' } = {}) {
  aplicarComposicoes({ composicoes: COMPOSICOES }, lib);
  const M = modeloBase();
  const itens = ORCAMENTO.map(([codigo, etapa, subetapa, comp, quantidade, custoUnit]) => ({ id: uid(), codigo, etapa, subetapa, comp: `EX-${comp}`, quantidade, custoUnit }));
  const idItem = new Map(itens.map((i) => [i.codigo, i.id]));
  const M2 = { ...M, orcamento: itens, vinculos: VINCULOS.map(([item, atv, pct]) => ({ id: uid(), itemId: idItem.get(item), atividadeId: `gb-${atv}`, pct })) };
  const o = novaObra({ nome, inicio });
  o.jornada = 8.8; o.eficiencia = 0.85;
  o.observacoes = 'Obra de DEMONSTRAÇÃO para conhecer o GEPLAN: valores ilustrativos (não são dados de uma obra real). Pode ser excluída.';
  const r = instanciarModelo(o, M2, selecaoPadrao(M2), { orcamento: true, quantidades: true }, lib);
  for (const a of o.eap) {
    if (EQUIPES[a.codigo] != null) a.equipe = EQUIPES[a.codigo];
    if (MANUAIS[a.codigo] != null) a.duracaoManual = MANUAIS[a.codigo];
  }
  registrar(o, 'Obra de demonstração criada', 'EAP do modelo GEPLAN + orçamento, composições e vínculos ilustrativos', usuario);
  return { obra: o, avisos: r.avisos };
}
