// Modelo de dados do GEPLAN (formato v2) e migração do formato v1.
//
// Biblioteca (compartilhada): composicoes (com funções de mão de obra), feriadosGlobais, modelosEAP.
// Obra: orcamento, eap (atividades em árvore), dependencias, vinculos (orçamento × EAP), medicoes, rdo.
// As "tabelas" do sistema são coleções dentro destes documentos JSON (salvos no aparelho e no Google Drive).

export const SCHEMA = 2;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const TIPOS = ['Execução', 'Fornecedor/Compra', 'Espera técnica', 'Inspeção', 'Administrativo'];
export const DURACAO_PADRAO = { 'Execução': 1, 'Fornecedor/Compra': 5, 'Espera técnica': 3, 'Inspeção': 1, 'Administrativo': 2 };
export const FONTES = ['Obra própria', 'SINAPI', 'TCPO', 'Outra'];

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
    id: uid(), codigo: '', descricao: '', unidade: 'm²', fonte: 'Obra própria', versao: 1, ativa: true, obs: '',
    maoObra: [{ id: uid(), funcao: 'Pedreiro', coef: 0, lider: true }],
    ...p,
  };
}

export function novaObra({ nome, inicio }) {
  return {
    id: uid(), kind: 'obra', schemaVersion: SCHEMA, nome, inicio,
    jornada: 8.8, eficiencia: 0.85,
    calendario: { dias: [1, 2, 3, 4, 5], feriados: [] },
    duracaoPadrao: { ...DURACAO_PADRAO },
    orcamento: [], eap: [], dependencias: [], vinculos: [],
    linhaBase: null, medicoes: [], rdo: [], updatedAt: 0,
  };
}

export function novaAtividade(p = {}) {
  return {
    id: uid(), codigo: '', nivel: 1, parentId: null, etapa: '', subetapa: '', descricao: '',
    tipo: 'Execução', equipe: null, duracaoManual: null, inicioFixado: '', inicioReal: '', fimReal: '',
    pct: 0, status: '', obs: '', predTexto: '',
    ...p,
  };
}

export function novoItem(p = {}) {
  return { id: uid(), codigo: '', etapa: '', subetapa: '', composicaoId: '', descricao: '', quantidade: 0, custoUnit: 0, ...p };
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
    return lib;
  }
  const comps = (lib.composicoes || []).map((c, i) => ({
    id: c.id,
    codigo: c.codigo || `ANT-${String(i + 1).padStart(2, '0')}`, // prefixo próprio: não colide com códigos de planilhas

    descricao: c.nome || c.descricao || '',
    unidade: c.unidade || 'un',
    fonte: 'Obra própria', versao: 1, ativa: true, obs: c.obs || '',
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
    o.calendario ||= { dias: [1, 2, 3, 4, 5], feriados: [] };
    return o;
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
  return renumerar(n);
}
