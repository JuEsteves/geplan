// Emulador do Supabase SOMENTE PARA TESTES: intercepta o fetch da biblioteca oficial supabase-js e responde
// às rotas de autenticação (/auth/v1) e da API REST (/rest/v1, subconjunto do PostgREST usado pelo GEPLAN)
// executando no PGlite (Postgres real) com as mesmas migrações e políticas RLS do projeto.
// Não é usado pelo app publicado. Não valida assinatura de token (não há segredo): serve para testar o app,
// não para testar o próprio Supabase.
import { PARSERS } from './banco_pglite.js';

const PGLITE = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js';
const MIGRACOES = ['20261011000001_base_organizacoes.sql', '20261011000002_obras_biblioteca.sql',
  '20261011000003_orcamento_planejamento.sql', '20261011000004_execucao_financeiro.sql', '20261011000005_indicadores.sql', '20261012000006_fornecedores.sql',
  '20261013000007_suprimentos.sql', '20261014000008_diario.sql', '20261015000009_medicoes.sql', '20261016000010_integracao_custos.sql', '20261017000011_seguranca_categorias.sql', '20261018000012_leitura_projeto.sql', '20261019000013_permissoes_nulas.sql', '20261027000014_bases_referencia.sql'];

const b64url = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const desb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error(`nome inválido: ${s}`), { code: 'PGRST100' }); return s; };
const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function criarEmulador({ url = 'http://emulado.supabase.co', anonKey = 'anon-emulado', base = '/', persistir = null } = {}) {
  const { PGlite } = await import(PGLITE);
  // persistir = nome do banco no IndexedDB: o estado sobrevive a recarregar a página (teste de persistência)
  const db = new PGlite(persistir ? `idb://${persistir}` : undefined, { parsers: PARSERS });
  const texto = (u) => fetch(u).then((r) => r.text());
  const pronto = (await db.query(`select to_regclass('public.projects') is not null as ok`)).rows[0].ok;
  if (!pronto) {
    await db.exec(await texto(`${base}supabase/tests/shim_supabase.sql`));
    for (const m of MIGRACOES) await db.exec(await texto(`${base}supabase/migrations/${m}`));
    await db.exec(await texto(`${base}supabase/seed.sql`));
    await db.exec(`create table if not exists auth.emul_senhas (email text primary key, senha text not null);
      create table if not exists auth.emul_refresh (token text primary key, user_id uuid not null);`);
  } else {
    // banco de teste criado antes de uma migração nova: aplica só as que faltam (como o "db push" faria)
    const NOVAS = { '20261013000007_suprimentos.sql': 'public.purchase_orders', '20261014000008_diario.sql': 'public.rdo_media',
      '20261015000009_medicoes.sql': 'public.measurement_sheets', '20261016000010_integracao_custos.sql': 'public.v_medicao_a_lancar', '20261018000012_leitura_projeto.sql': 'public.project_ai_reads', '20261027000014_bases_referencia.sql': 'public.ref_bases' };
    for (const [m, marca] of Object.entries(NOVAS)) {
      if (!(await db.query('select to_regclass($1) is not null as ok', [marca])).rows[0].ok) await db.exec(await texto(`${base}supabase/migrations/${m}`));
    }
    // só permissões (idempotente): aplica sempre
    await db.exec(await texto(`${base}supabase/migrations/20261017000011_seguranca_categorias.sql`));
    await db.exec(await texto(`${base}supabase/migrations/20261019000013_permissoes_nulas.sql`));
  }

  const usuarios = new Map();    // id → { id, email, nome }
  for (const u of (await db.query(`select id, email, raw_user_meta_data ->> 'full_name' nome from auth.users`)).rows) usuarios.set(u.id, { id: u.id, email: u.email, nome: u.nome || '' });
  const senha = async (email) => (await db.query('select senha from auth.emul_senhas where email = $1', [email])).rows[0]?.senha;
  const log = [];
  const controle = { falharGravacoes: false };

  const usuarioObj = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(),
    user_metadata: { full_name: u.nome }, app_metadata: { provider: 'email', providers: ['email'] }, created_at: new Date().toISOString() });
  function sessao(u) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp })}.emulado`;
    const rt = crypto.randomUUID();
    db.query('insert into auth.emul_refresh (token, user_id) values ($1, $2)', [rt, u.id]);
    return { access_token: access, refresh_token: rt, expires_in: 3600, expires_at: exp, token_type: 'bearer', user: usuarioObj(u) };
  }
  const usuarioDoToken = (auth) => {
    const t = (auth || '').replace(/^Bearer /i, '');
    if (!t || t === anonKey) return null;
    try { const p = desb64(t.split('.')[1]); return usuarios.get(p.sub) || null; } catch { return null; }
  };

  async function criarUsuario(email, senha, nome) {
    const id = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ full_name: nome || '' })])).rows[0].id;
    const u = { id, email, nome: nome || '' };
    usuarios.set(id, u);
    await db.query('insert into auth.emul_senhas (email, senha) values ($1, $2) on conflict (email) do update set senha = excluded.senha', [email, senha]);
    return u;
  }

  async function comoUsuario(u, fn) {
    return db.transaction(async (tx) => {
      if (u) {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
          [u.id, JSON.stringify({ sub: u.id, email: u.email, role: 'authenticated' })]);
        await tx.exec('set local role authenticated');
      } else await tx.exec('set local role anon');
      return fn(tx);
    });
  }

  /* ---------- autenticação ---------- */
  async function auth(path, q, opt, body) {
    const m = (opt.method || 'GET').toUpperCase();
    if (path === 'signup' && m === 'POST') {
      const email = String(body.email).toLowerCase();
      if (await senha(email)) return json(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      const u = await criarUsuario(email, body.password, body.data?.full_name);
      return json(200, sessao(u));
    }
    if (path === 'token' && q.get('grant_type') === 'password') {
      const email = String(body.email).toLowerCase();
      const u = [...usuarios.values()].find((x) => x.email === email);
      if (!u || (await senha(email)) !== body.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(200, sessao(u));
    }
    if (path === 'token' && q.get('grant_type') === 'refresh_token') {
      const id = (await db.query('select user_id from auth.emul_refresh where token = $1', [body.refresh_token])).rows[0]?.user_id;
      if (!id) return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token', msg: 'Invalid Refresh Token' });
      return json(200, sessao(usuarios.get(id)));
    }
    const u = usuarioDoToken(new Headers(opt.headers).get('authorization'));
    if (path === 'user' && m === 'GET') return u ? json(200, usuarioObj(u)) : json(401, { code: 401, msg: 'invalid JWT' });
    if (path === 'user' && m === 'PUT') { if (!u) return json(401, { msg: 'invalid JWT' }); if (body.password) await db.query('update auth.emul_senhas set senha = $2 where email = $1', [u.email, body.password]); return json(200, usuarioObj(u)); }
    if (path === 'logout') return new Response(null, { status: 204 });
    if (path === 'recover') return json(200, {});
    return json(404, { msg: `rota de auth não emulada: ${path}` });
  }

  /* ---------- REST (subconjunto do PostgREST) ---------- */
  const RESERVADOS = new Set(['select', 'order', 'offset', 'limit', 'on_conflict', 'columns']);
  function filtros(q, p) {
    const w = [];
    for (const [k, v] of q) {
      if (RESERVADOS.has(k)) continue;
      const c = ident(k);
      const i = v.indexOf('.');
      const op = v.slice(0, i), val = v.slice(i + 1);
      if (op === 'is') w.push(`${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`);
      else if (op === 'in') {
        const itens = val.replace(/^\(|\)$/g, '').match(/("([^"\\]|\\.)*"|[^,]+)/g)?.map((s) => s.replace(/^"|"$/g, '')) || [];
        p.push(itens); w.push(`${c}::text = any($${p.length}::text[])`);
      } else {
        const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
        if (!ops[op]) throw Object.assign(new Error(`operador não emulado: ${op}`), { code: 'PGRST100' });
        p.push(val); w.push(`${c}::text ${ops[op]} $${p.length}::text`);
      }
    }
    return w.length ? ` where ${w.join(' and ')}` : '';
  }
  const colunas = (q) => { const s = q.get('select') || '*'; return s === '*' ? '*' : s.split(',').map((x) => ident(x.trim())).join(', '); };

  async function rest(tabela, q, opt, body, u) {
    const m = (opt.method || 'GET').toUpperCase();
    // modo de teste: servidor recusando gravações (para verificar o indicador "Salvo na nuvem")
    if (controle.falharGravacoes && m !== 'GET') return json(503, { code: 'EMUL503', message: 'Falha simulada do servidor' });
    const h = new Headers(opt.headers);
    const prefer = h.get('prefer') || '';
    const umObjeto = (h.get('accept') || '').includes('vnd.pgrst.object');
    const representacao = prefer.includes('return=representation');
    const t = ident(tabela);
    const responder = (rows) => {
      if (umObjeto) {
        if (rows.length !== 1) return json(406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned`, details: `The result contains ${rows.length} rows` });
        return json(200, rows[0]);
      }
      return json(200, rows);
    };
    return comoUsuario(u, async (tx) => {
      const p = [];
      if (m === 'GET') {
        let sql = `select ${colunas(q)} from public.${t}${filtros(q, p)}`;
        if (q.get('order')) sql += ` order by ${q.get('order').split(',').map((o) => { const [c, d] = o.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}`;
        if (q.get('limit')) sql += ` limit ${Number(q.get('limit'))}`;
        if (q.get('offset')) sql += ` offset ${Number(q.get('offset'))}`;
        return responder((await tx.query(sql, p)).rows);
      }
      if (m === 'POST') {
        const linhas = Array.isArray(body) ? body : [body];
        const conflito = q.get('on_conflict');
        const merge = prefer.includes('resolution=merge-duplicates');
        const grupos = new Map();
        for (const l of linhas) { const k = Object.keys(l).sort().join(','); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(l); }
        const saida = [];
        for (const g of grupos.values()) {
          const cols = Object.keys(g[0]).map(ident);
          let sql = `insert into public.${t} (${cols.join(', ')}) select ${cols.join(', ')} from jsonb_populate_recordset(null::public.${t}, $1::jsonb)`;
          if (merge && conflito) {
            const chave = conflito.split(',').map(ident);
            const set = cols.filter((c) => !chave.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
            sql += ` on conflict (${chave.join(', ')}) do ${set ? `update set ${set}` : 'nothing'}`;
          }
          if (representacao) sql += ` returning ${colunas(q)}`;
          saida.push(...(await tx.query(sql, [JSON.stringify(g)])).rows);
        }
        return representacao ? responder(saida) : new Response(null, { status: 201 });
      }
      if (m === 'PATCH') {
        p.push(JSON.stringify(body));
        const set = Object.keys(body).map(ident).map((c) => `${c} = (jsonb_populate_record(null::public.${t}, $1::jsonb)).${c}`).join(', ');
        const r = await tx.query(`update public.${t} set ${set}${filtros(q, p)}${representacao ? ` returning ${colunas(q)}` : ''}`, p);
        return representacao ? responder(r.rows) : new Response(null, { status: 204 });
      }
      if (m === 'DELETE') {
        await tx.query(`delete from public.${t}${filtros(q, p)}`, p);
        return new Response(null, { status: 204 });
      }
      return json(405, { message: 'método não emulado' });
    });
  }

  /* ---------- Storage (subconjunto: upload, URL assinada, download) ---------- */
  const conteudos = new Map();   // "bucket/nome" → Blob
  const assinaturas = new Map(); // token → { bucket, nome, expira }
  async function armazenamento(caminho, q, opt, u) {
    const m = (opt.method || 'GET').toUpperCase();
    const erroSt = (status, msg) => json(400, { statusCode: String(status), error: status === 403 ? 'Unauthorized' : 'Error', message: msg });
    if (caminho.startsWith('object/sign/') && !caminho.slice(12).includes('/') && m === 'POST') {
      // vários links de uma vez (createSignedUrls)
      const bucket = caminho.slice(12);
      const body = typeof opt.body === 'string' ? JSON.parse(opt.body) : {};
      const saida = [];
      for (const nome of body.paths || []) {
        const existe = await comoUsuario(u, async (tx) => (await tx.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, nome])).rows.length);
        if (!existe) { saida.push({ path: nome, signedURL: null, error: 'Object not found' }); continue; }
        const token = crypto.randomUUID();
        assinaturas.set(token, { bucket, nome, expira: Date.now() + (Number(body.expiresIn) || 60) * 1000 });
        saida.push({ path: nome, signedURL: `/object/sign/${bucket}/${nome.split('/').map(encodeURIComponent).join('/')}?token=${token}`, error: null });
      }
      return json(200, saida);
    }
    if (caminho.startsWith('object/sign/')) {
      const [bucket, ...resto] = caminho.slice(12).split('/');
      const nome = decodeURIComponent(resto.join('/'));
      if (m === 'GET') {
        const a = assinaturas.get(q.get('token'));
        if (!a || a.bucket !== bucket || a.nome !== nome || a.expira < Date.now()) return erroSt(400, 'Invalid or expired signature');
        const blob = conteudos.get(`${bucket}/${nome}`);
        return blob ? new Response(blob, { status: 200, headers: { 'content-type': blob.type || 'application/octet-stream' } }) : erroSt(404, 'Object not found');
      }
      const existe = await comoUsuario(u, async (tx) => (await tx.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, nome])).rows.length);
      if (!existe) return erroSt(404, 'Object not found');
      const token = crypto.randomUUID();
      const body = typeof opt.body === 'string' ? JSON.parse(opt.body) : {};
      assinaturas.set(token, { bucket, nome, expira: Date.now() + (Number(body.expiresIn) || 60) * 1000 });
      return json(200, { signedURL: `/object/sign/${bucket}/${resto.join('/')}?token=${token}` });
    }
    if (caminho.startsWith('object/') && m === 'POST') {
      const [bucket, ...resto] = caminho.slice(7).split('/');
      const nome = decodeURIComponent(resto.join('/'));
      let arquivo = opt.body;
      if (arquivo instanceof FormData) arquivo = [...arquivo.values()].find((x) => x instanceof Blob);
      if (!(arquivo instanceof Blob)) return erroSt(400, 'Arquivo ausente');
      const b = (await db.query('select * from storage.buckets where id = $1', [bucket])).rows[0];
      if (!b) return erroSt(404, 'Bucket not found');
      if (b.file_size_limit && arquivo.size > b.file_size_limit) return erroSt(413, 'The object exceeded the maximum allowed size');
      if (b.allowed_mime_types?.length && !b.allowed_mime_types.includes(arquivo.type)) return erroSt(415, `mime type ${arquivo.type} is not supported`);
      try {
        const id = await comoUsuario(u, async (tx) => (await tx.query('insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3::jsonb) returning id',
          [bucket, nome, JSON.stringify({ size: arquivo.size, mimetype: arquivo.type })])).rows[0].id);
        conteudos.set(`${bucket}/${nome}`, arquivo);
        return json(200, { Key: `${bucket}/${nome}`, Id: id });
      } catch (e) {
        return erroSt(/row-level security/.test(e.message) ? 403 : 400, e.message);
      }
    }
    return erroSt(404, `rota de storage não emulada: ${m} ${caminho}`);
  }

  async function rpc(nome, body, u) {
    const fn = ident(nome);
    const ret = (await db.query(`select proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = $1`, [fn])).rows[0];
    if (!ret) return json(404, { code: 'PGRST202', message: `função ${fn} não existe` });
    const ks = Object.keys(body || {});
    const args = ks.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ');
    // objetos e listas chegam ao Postgres como JSON (como o PostgREST faz com parâmetros jsonb)
    const vals = ks.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
    return comoUsuario(u, async (tx) => {
      if (ret.proretset) return json(200, (await tx.query(`select * from public.${fn}(${args})`, vals)).rows);
      const r = (await tx.query(`select public.${fn}(${args}) as r`, vals)).rows[0];
      return json(200, r.r);
    });
  }

  // Edge Function "ler-projeto" SIMULADA (sem IA): mesmas regras do banco (permissão, limite, pasta da obra) e uma
  // resposta de DEMONSTRAÇÃO montada a partir do modelo enviado, para testar a tela de ponta a ponta.
  async function lerProjetoDemo(body, u) {
    if (!u) return json(401, { erro: 'Entre no GEPLAN para usar a leitura de projeto.' });
    let id;
    try {
      id = await comoUsuario(u, async (tx) => (await tx.query('select public.ia_iniciar_leitura($1, $2::jsonb) as id', [body.projectId, JSON.stringify(body.files || [])])).rows[0].id);
    } catch (e) { return json(e.code === '42501' ? 403 : 400, { erro: e.message }); }
    const demo = /piscina|fotovolt|poço/i;
    const resultado = {
      resumo: 'DEMONSTRAÇÃO — resposta simulada pelo emulador local (sem IA). Na versão real, a IA lê os PDFs enviados.',
      dados_obra: { tipo: 'Residência unifamiliar (demonstração)', area_construida_m2: null, area_terreno_m2: null, pavimentos: null, sistema_construtivo: '', fundacao: '', cobertura: '', itens_especiais: [] },
      etapas: (body.etapas || []).map((e) => ({ codigo: e.codigo, incluir: !demo.test(e.nome), motivo: demo.test(e.nome) ? 'Não aparece no projeto (demonstração)' : 'Item usual (demonstração)', paginas: '',
        subetapas: (e.subetapas || []).map((s) => ({ codigo: s.codigo, incluir: !demo.test(e.nome) && !demo.test(s.nome), motivo: 'demonstração', paginas: '' })) })),
      novas: [{ etapa_codigo: (body.etapas || [])[1]?.codigo || '', etapa_nova: '', nome: 'Muro de arrimo (demonstração)', motivo: 'Sugestão simulada', paginas: 'p. 1' }],
      alertas: ['Resposta de demonstração: nenhum PDF foi lido.'],
    };
    setTimeout(() => comoUsuario(u, (tx) => tx.query(`select public.ia_concluir_leitura($1, 'concluida', $2::jsonb, '', 'emulador-demo', 0, 0)`, [id, JSON.stringify(resultado)])).catch(() => {}), 2500);
    return json(202, { leituraId: id });
  }

  const original = window.fetch.bind(window);
  window.fetch = async (entrada, opt = {}) => {
    const alvo = typeof entrada === 'string' ? entrada : entrada.url;
    if (!alvo.startsWith(url)) return original(entrada, opt);
    const U = new URL(alvo);
    const body = typeof opt.body === 'string' && opt.body ? JSON.parse(opt.body) : {};
    log.push({ metodo: opt.method || 'GET', rota: U.pathname + U.search });
    try {
      if (U.pathname.startsWith('/auth/v1/')) return await auth(U.pathname.slice(9), U.searchParams, opt, body);
      const u = usuarioDoToken(new Headers(opt.headers).get('authorization'));
      if (U.pathname.startsWith('/storage/v1/')) return await armazenamento(U.pathname.slice(12), U.searchParams, opt, u);
      if (U.pathname.startsWith('/rest/v1/rpc/')) return await rpc(U.pathname.slice(13), body, u);
      if (U.pathname.startsWith('/rest/v1/')) return await rest(U.pathname.slice(9), U.searchParams, opt, body, u);
      if (U.pathname === '/functions/v1/ler-projeto') return await lerProjetoDemo(body, u);
      return json(404, { message: 'rota não emulada' });
    } catch (e) {
      const code = e.code || '';
      const status = code === '42501' ? (new Headers(opt.headers).get('authorization')?.includes(anonKey) ? 401 : 403) : code.startsWith('PGRST') ? 400 : 400;
      return json(status, { code, message: e.message, details: e.detail || null, hint: e.hint || null });
    }
  };

  // <img>/<video> não passam pelo fetch interceptado: troca o link do emulador pelo conteúdo local (só nos testes)
  const trocar = async (el) => {
    const s = el.getAttribute('src');
    if (!s || !s.startsWith(url)) return;
    const r = await window.fetch(s);
    if (r.ok) el.src = URL.createObjectURL(await r.blob());
  };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes' && m.target.matches?.('img,video')) trocar(m.target);
      for (const n of m.addedNodes || []) if (n.querySelectorAll) { if (n.matches('img,video')) trocar(n); n.querySelectorAll('img[src],video[src]').forEach(trocar); }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

  return { db, url, anonKey, log, criarUsuario, usuarios, controle };
}
