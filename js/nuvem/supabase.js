// Conexão com o Supabase (biblioteca oficial supabase-js, carregada só no modo nuvem) e o adaptador de banco
// usado pelo motor de sincronização (mesma interface do adaptador de testes, tests/banco_pglite.js).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const PAGINA = 1000;   // limite padrão de linhas por requisição no Supabase
const LOTE = 500;      // linhas por envio

export const configurado = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let cliente = null;
/** Cliente do Supabase (sessão guardada no aparelho e renovada automaticamente). */
export async function sb() {
  if (!configurado()) throw new Error('Banco de dados não configurado (js/config.js).');
  if (!cliente) {
    const { createClient } = await import(LIB);
    cliente = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // PKCE: o retorno do login vem em ?code= (não no #, que é usado pelas rotas do app)
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'geplan-auth' },
    });
  }
  return cliente;
}

/** Mensagem de erro em português, sem expor detalhes internos desnecessários. */
export function erroBanco(error, onde = '') {
  const m = error?.message || String(error);
  const code = error?.code || '';
  let msg = m;
  if (code === '42501' || /row-level security|permission denied/i.test(m)) msg = 'Sem permissão para esta operação.';
  else if (/JWT expired|invalid JWT|refresh token/i.test(m)) msg = 'Sua sessão expirou. Entre novamente.';
  else if (/Failed to fetch|NetworkError|network/i.test(m)) msg = 'Sem conexão com o servidor.';
  const e = new Error(onde ? `${msg} (${onde})` : msg);
  e.code = code; e.original = m;
  return e;
}

const PK = {
  project_holidays: ['project_id', 'holiday_date'],
  org_holidays: ['org_id', 'holiday_date'],
  schedule_baseline_items: ['baseline_id', 'activity_id'],
};
const pk = (t) => PK[t] || ['id'];
const lotes = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };
/** Remove campos undefined: a coluna fica de fora e o banco usa o valor padrão. */
const limpar = (l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));

export function bancoSupabase(c) {
  const ok = ({ error }, t) => { if (error) throw erroBanco(error, t); };
  return {
    async selecionar(t, { eq = {}, in: em = {}, ativos = false } = {}) {
      const todos = [];
      const ordem = t.startsWith('v_') ? null : pk(t);
      for (let de = 0; ; de += PAGINA) {
        let q = c.from(t).select('*');
        for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
        for (const [k, v] of Object.entries(em)) q = q.in(k, v);
        if (ativos) q = q.is('deleted_at', null);
        if (ordem) for (const k of ordem) q = q.order(k);
        const { data, error } = await q.range(de, de + PAGINA - 1);
        if (error) throw erroBanco(error, t);
        todos.push(...data);
        if (data.length < PAGINA) break;
      }
      return todos;
    },
    async upsert(t, linhas) {
      for (const l of lotes(linhas.map(limpar), LOTE)) ok(await c.from(t).upsert(l, { onConflict: pk(t).join(','), defaultToNull: false }), t);
    },
    async inserir(t, linhas) {
      for (const l of lotes(linhas.map(limpar), LOTE)) ok(await c.from(t).insert(l, { defaultToNull: false }), t);
    },
    async atualizar(t, patch, linhas) {
      const chave = pk(t);
      if (chave.length === 1) {
        for (const l of lotes(linhas.map((x) => x[chave[0]]), 150)) ok(await c.from(t).update(patch).in(chave[0], l), t);
      } else {
        for (const x of linhas) ok(await c.from(t).update(patch).match(Object.fromEntries(chave.map((k) => [k, x[k]]))), t);
      }
    },
    async remover(t, linhas) {
      const chave = pk(t);
      if (chave.length === 1) {
        for (const l of lotes(linhas.map((x) => x[chave[0]]), 150)) ok(await c.from(t).delete().in(chave[0], l), t);
      } else {
        for (const x of linhas) ok(await c.from(t).delete().match(Object.fromEntries(chave.map((k) => [k, x[k]]))), t);
      }
    },
    async rpc(nome, args = {}) {
      const { data, error } = await c.rpc(nome, args);
      if (error) throw erroBanco(error, nome);
      return data;
    },
  };
}
