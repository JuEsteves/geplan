// Modelo de dados do GEPLAN (formato v2) e migração do formato v1.
//
// Biblioteca (compartilhada): composicoes (com funções de mão de obra), feriadosGlobais, modelosEAP.
// Obra: orcamento, eap (atividades em árvore), dependencias, vinculos (orçamento × EAP), medicoes, rdo.
// As "tabelas" do sistema são coleções dentro destes documentos JSON (salvos no aparelho e no Google Drive).

export const SCHEMA = 2;
// UUID: o mesmo formato das chaves do banco (Supabase), para o registro ter um id só do aparelho à nuvem.
export const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

export const TIPOS = ['Execução', 'Fornecedor/Compra', 'Espera técnica', 'Inspeção', 'Administrativo'];
export const DURACAO_PADRAO = { 'Execução': 1, 'Fornecedor/Compra': 5, 'Espera técnica': 3, 'Inspeção': 1, 'Administrativo': 2 };
// Prioridade de uso: Própria validada (RDO) > SINAPI > SINAPI (família) > Própria (sugerida)
export const FONTES = ['Própria (validada)', 'SINAPI', 'SINAPI (família)', 'Própria (sugerida)', 'TCPO', 'Outra'];

/** Converte o texto de fonte da planilha para uma das FONTES. */
export function normalizaFonte(t) {
  const s = String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!s) return 'Própria (validada)';
  if (s.startsWith('sinapi')) return s.includes('famil') ? 'SINAPI (família)' : 'SINAPI';
  if (s.startsWith('tcpo')) return 'TCPO';
  if (s.startsWith('propria') || s.startsWith('obra') || s.startsWith('rdo')) return s.includes('suger') ? 'Própria (sugerida)' : 'Própria (validada)';
  return 'Outra';
}

/** Converte os textos de tipo da planilha ("Inspeção/Conferência", "Espera técnica (cura/teste)"…) para os 5 tipos. */
export function normalizaTipo(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('insp') || s.includes('confer')) return 'Inspeção';
  if (s.includes('forn') || s.includes('compra')) return 'Fornecedor/Compra';
  if (s.includes('espera') || s.includes('cura') || s.includes('teste')) return 'Espera técnica';
  if (s.includes('admin') || s.includes('document')) return 'Administrativo';
  return 'Execução';
}

export function emptyLib() {
  return {
    id: 'biblioteca', kind: 'biblioteca', schemaVersion: SCHEMA, updatedAt: 0,
    composicoes: [], feriadosGlobais: [], modelosEAP: [],
  };
}

export function novaComposicao(p = {}) {
  return {
    id: uid(), codigo: '', descricao: '', unidade: 'm²', fonte: 'Própria (validada)', refSinapi: '', etapaEap: '', versao: 1, ativa: true, obs: '',
    maoObra: [{ id: uid(), funcao: 'Pedreiro', coef: 0, lider: true }],
    ...p,
  };
}

export const STATUS_OBRA = ['Orçamento', 'Planejamento', 'Em execução', 'Paralisada', 'Concluída', 'Cancelada'];
export const CATEGORIAS_CUSTO = ['Material', 'Mão de obra', 'Equipamento', 'Serviço terceirizado', 'Indireto', 'Outro'];
export const PERFIS_DISTRIBUICAO = { linear: 'Linear (uniforme)', inicio: 'Concentrado no início', fim: 'Concentrado no fim', sino: 'Curva em sino (lento-rápido-lento)' };
export const PESOS_FISICOS = { hh: 'Horas-homem (HH)', custo: 'Custo alocado', duracao: 'Duração', manual: 'Peso manual por atividade' };
export const TIPOS_OCORRENCIA = ['Ocorrência', 'Interferência', 'Impedimento', 'Acidente/segurança', 'Visita técnica'];

/** Campos que toda obra deve ter (cadastro, financeiro, execução). Usado na criação e na migração. */
export function garantirCamposObra(o) {
  o.codigo ??= ''; o.cliente ||= { nome: '', contato: '', telefone: '', email: '' };
  o.endereco ??= ''; o.cidade ??= ''; o.tipoEmpreendimento ??= 'Residencial unifamiliar';
  o.engenheiro ??= ''; o.crea ??= ''; o.terminoPlanejado ??= ''; o.inicioReal ??= '';
  o.valorContratado ??= null; o.status ??= 'Planejamento';
  o.bdi ||= { ac: 0, s: 0, r: 0, g: 0, df: 0, l: 0, i: 0 };
  o.distribuicaoPadrao ??= 'linear'; o.pesoFisico ??= 'hh';
  o.calendario ||= { dias: [1, 2, 3, 4, 5], feriados: [] }; o.calendario.tipo ??= 'uteis';
  for (const k of ['historico', 'revisoesOrcamento', 'medicoesAtiv', 'diario', 'compromissos', 'despesas', 'medicoes', 'rdo']) o[k] ||= [];
  // diário antigo (um registro por dia) → RDO de um dia, com número pela ordem das datas e situação "preenchendo"
  let n = Math.max(0, ...o.diario.map((d) => Number(d.numero) || 0));
  for (const d of [...o.diario].sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
    d.dataFim ||= d.data; d.status ||= 'preenchendo'; if (!d.numero) d.numero = ++n;
    for (const k of ['equipe', 'servicos', 'ocorrencias', 'equipamentosLista', 'materiaisLista']) d[k] ||= [];
  }
  return o;
}

export function novaObra({ nome, inicio }) {
  return garantirCamposObra({
    id: uid(), kind: 'obra', schemaVersion: SCHEMA, nome, inicio,
    jornada: 8.8, eficiencia: 0.85,
    calendario: { dias: [1, 2, 3, 4, 5], feriados: [], tipo: 'uteis' },
    duracaoPadrao: { ...DURACAO_PADRAO },
    orcamento: [], eap: [], dependencias: [], vinculos: [],
    linhaBase: null, medicoes: [], rdo: [], updatedAt: 0,
  });
}

/** Histórico de alterações importantes da obra (quem, quando, o quê). */
export function registrar(o, acao, detalhe = '', usuario = '') {
  o.historico ||= [];
  o.historico.unshift({ id: uid(), em: new Date().toISOString(), usuario, acao, detalhe });
  if (o.historico.length > 800) o.historico.length = 800;
}

export function novaAtividade(p = {}) {
  return {
    id: uid(), codigo: '', nivel: 1, parentId: null, etapa: '', subetapa: '', descricao: '',
    tipo: 'Execução', equipe: null, duracaoManual: null, inicioFixado: '', inicioReal: '', fimReal: '',
    pct: 0, status: '', obs: '', predTexto: '', varianteDe: null,
    ...p,
  };
}

export function novoItem(p = {}) {
  return { id: uid(), codigo: '', etapa: '', subetapa: '', composicaoId: '', descricao: '', unidade: '', quantidade: 0, custoUnit: 0, ...p };
}

/* ---------- árvore da EAP ---------- */

/** Filhos por atividade, na ordem do array. */
export function filhosDe(obra) {
  const map = new Map();
  for (const a of obra.eap) {
    const k = a.parentId || null;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  }
  return map;
}

/** Ids de um nó e de todos os seus descendentes. */
export function subarvore(obra, id) {
  const ids = new Set([id]);
  let mudou = true;
  while (mudou) { mudou = false; for (const x of obra.eap) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) { ids.add(x.id); mudou = true; } }
  return ids;
}

/**
 * Move um item da EAP (com os descendentes) para dentro de outro (ou para o nível 1 com `novoPaiId` nulo), como último
 * filho. Vínculos, predecessoras e medições ficam como estão (são ligados por id). Atualiza etapa/subetapa e renumera.
 */
export function moverNo(obra, id, novoPaiId) {
  const a = obra.eap.find((x) => x.id === id);
  if (!a) throw new Error('Item não encontrado.');
  if (novoPaiId && subarvore(obra, id).has(novoPaiId)) throw new Error('Não dá para mover um item para dentro dele mesmo.');
  a.parentId = novoPaiId || null;
  obra.eap.splice(obra.eap.indexOf(a), 1);
  obra.eap.push(a);
  renumerar(obra);
  const porId = new Map(obra.eap.map((x) => [x.id, x]));
  for (const x of obra.eap) {
    const cadeia = [];
    for (let y = x; y; y = y.parentId ? porId.get(y.parentId) : null) cadeia.unshift(y);
    x.etapa = cadeia[0].descricao;
    x.subetapa = cadeia.length >= 2 ? cadeia[1].descricao : '';
  }
  return a;
}

/** Reordena obra.eap em ordem de árvore (pré-ordem) e renumera os códigos (1, 1.1, 1.1.1…). */
export function renumerar(obra) {
  const filhos = filhosDe(obra);
  const out = [];
  const visit = (parentId, prefix, nivel) => {
    (filhos.get(parentId) || []).forEach((a, i) => {
      a.codigo = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      a.nivel = nivel;
      out.push(a);
      visit(a.id, a.codigo, nivel + 1);
    });
  };
  // Etapas alternativas (variantes, só em modelos) usam o número da etapa base + letra: 11, 11B, 11C…
  const raizes = filhos.get(null) || [];
  const variantes = raizes.filter((a) => a.varianteDe && raizes.some((b) => b.id === a.varianteDe));
  if (variantes.length) {
    const normais = raizes.filter((a) => !variantes.includes(a));
    normais.forEach((a, i) => { a.codigo = String(i + 1); a.nivel = 1; });
    const letras = new Map();
    for (const v of variantes) {
      const base = raizes.find((b) => b.id === v.varianteDe);
      const n = (letras.get(base.id) || 0) + 1; letras.set(base.id, n);
      v.codigo = base.codigo + String.fromCharCode(65 + n); v.nivel = 1;
    }
    for (const a of normais) {
      out.push(a); visit(a.id, a.codigo, 2);
      for (const v of variantes.filter((x) => x.varianteDe === a.id)) { out.push(v); visit(v.id, v.codigo, 2); }
    }
    for (const a of obra.eap) if (!out.includes(a)) { a.parentId = null; out.push(a); }
    obra.eap = out;
    return obra;
  }
  visit(null, '', 1);
  // atividades órfãs (pai removido) vão para a raiz
  for (const a of obra.eap) if (!out.includes(a)) { a.parentId = null; out.push(a); }
  obra.eap = out;
  return obra;
}

/* ---------- migração v1 → v2 ---------- */

export function migrateLib(lib) {
  if (!lib) return emptyLib();
  if ((lib.schemaVersion || 1) >= SCHEMA) {
    lib.feriadosGlobais ||= []; lib.modelosEAP ||= []; lib.composicoes ||= [];
    for (const c of lib.composicoes) if (!FONTES.includes(c.fonte)) c.fonte = normalizaFonte(c.fonte);
    return lib;
  }
  const comps = (lib.composicoes || []).map((c, i) => ({
    id: c.id,
    codigo: c.codigo || `ANT-${String(i + 1).padStart(2, '0')}`, // prefixo próprio: não colide com códigos de planilhas

    descricao: c.nome || c.descricao || '',
    unidade: c.unidade || 'un',
    fonte: 'Própria (validada)', refSinapi: '', etapaEap: '', versao: 1, ativa: true, obs: c.obs || '',
    maoObra: [{ id: uid(), funcao: 'Profissional', coef: Number(c.coef) || 0, lider: true }],
  }));
  return {
    id: 'biblioteca', kind: 'biblioteca', schemaVersion: SCHEMA, updatedAt: lib.updatedAt || 0,
    composicoes: comps, feriadosGlobais: [], modelosEAP: [],
    etapasV1: lib.etapas || [], // guardado só para migrar obras antigas
  };
}

/**
 * Obra v1 (etapas → serviços com 1 composição) vira: etapa = atividade nível 1; serviço = atividade folha +
 * item de orçamento + vínculo de 100%. Jornada mantida e eficiência 1, para preservar as durações antigas.
 */
export function migrateObra(o, lib) {
  if ((o.schemaVersion || 1) >= SCHEMA) {
    o.orcamento ||= []; o.eap ||= []; o.dependencias ||= []; o.vinculos ||= []; o.medicoes ||= []; o.rdo ||= [];
    o.duracaoPadrao ||= { ...DURACAO_PADRAO };
    return garantirCamposObra(o);
  }
  const etapasLib = lib.etapasV1 || lib.etapas || [];
  const comps = new Map((lib.composicoes || []).map((c) => [c.id, c]));
  const eap = [], orcamento = [], vinculos = [], dependencias = [];
  (o.etapas || []).forEach((e, ei) => {
    const nomeEtapa = etapasLib.find((x) => x.id === e.etapaId)?.nome || `Etapa ${ei + 1}`;
    eap.push(novaAtividade({ id: e.id, nivel: 1, etapa: nomeEtapa, descricao: nomeEtapa }));
    (e.servicos || []).forEach((s, si) => {
      const c = comps.get(s.composicaoId);
      const desc = (s.descricao || '').trim() || c?.descricao || '(sem composição)';
      const fixa = s.duracaoFixa !== '' && s.duracaoFixa != null && !isNaN(Number(s.duracaoFixa));
      eap.push(novaAtividade({
        id: s.id, nivel: 2, parentId: e.id, etapa: nomeEtapa, subetapa: desc, descricao: desc, tipo: 'Execução',
        equipe: Math.max(1, Number(s.equipes) || 1), duracaoManual: fixa ? Number(s.duracaoFixa) : null,
        inicioReal: s.inicioReal || '', fimReal: s.fimReal || '', pct: Number(s.pct) || 0,
      }));
      if (s.composicaoId || Number(s.quantidade)) {
        const it = novoItem({
          codigo: `O-${ei + 1}.${String(si + 1).padStart(2, '0')}`, etapa: nomeEtapa, subetapa: desc,
          composicaoId: s.composicaoId || '', quantidade: Number(s.quantidade) || 0, custoUnit: 0,
        });
        orcamento.push(it);
        vinculos.push({ id: uid(), itemId: it.id, atividadeId: s.id, pct: 1 });
      }
      for (const p of s.preds || []) dependencias.push({ id: uid(), atividadeId: s.id, predecessoraId: p.ref, tipo: 'FS', lag: Number(p.lag) || 0 });
    });
  });
  const n = {
    id: o.id, kind: 'obra', schemaVersion: SCHEMA, nome: o.nome, inicio: o.inicio,
    jornada: Number(o.calendario?.jornada) || 8, eficiencia: 1,
    calendario: { dias: o.calendario?.dias || [1, 2, 3, 4, 5], feriados: o.calendario?.feriados || [] },
    duracaoPadrao: { ...DURACAO_PADRAO },
    orcamento, eap, dependencias, vinculos,
    linhaBase: o.linhaBase || null,
    medicoes: (o.medicoes || []).map((m) => ({ data: m.data, fisico: m.real, fisicoPlan: m.plan, financeiro: null, financeiroPlan: null })),
    rdo: [], updatedAt: o.updatedAt || 0,
  };
  return garantirCamposObra(renumerar(n));
}
