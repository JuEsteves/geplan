// Testes do banco de dados: executa as migrações em um PostgreSQL real (PGlite = Postgres 16 compilado para o
// navegador), com um simulador mínimo do Supabase (auth.uid() e papéis), e tenta acessos indevidos de verdade.
// Um teste de segurança só passa quando a tentativa é efetivamente bloqueada pelo banco.
import { resumoCustos, custosPorFase, bdiTCU } from '../js/financeiro.js';
import { toDay } from '../js/schedule.js';

const PGLITE = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js';
const MIGRACOES = [
  '20261011000001_base_organizacoes.sql',
  '20261011000002_obras_biblioteca.sql',
  '20261011000003_orcamento_planejamento.sql',
  '20261011000004_execucao_financeiro.sql',
  '20261011000005_indicadores.sql',
  '20261012000006_fornecedores.sql',
  '20261013000007_suprimentos.sql',
  '20261014000008_diario.sql',
  '20261015000009_medicoes.sql',
  '20261016000010_integracao_custos.sql',
  '20261017000011_seguranca_categorias.sql',
  '20261018000012_leitura_projeto.sql',
  '20261019000013_permissoes_nulas.sql',
  '20261027000014_bases_referencia.sql',
];

const out = document.getElementById('out');
let ok = 0, fail = 0;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const grupo = (t) => out.insertAdjacentHTML('beforeend', `<h2>${esc(t)}</h2>`);
async function teste(nome, fn) {
  try { await fn(); ok++; out.insertAdjacentHTML('beforeend', `<div class="t ok"><b>OK</b>${esc(nome)}</div>`); }
  catch (e) { fail++; out.insertAdjacentHTML('beforeend', `<div class="t err"><b>FALHA</b>${esc(nome)} — <span>${esc(e.message)}</span></div>`); }
}
const igual = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`); };
const verdade = (c, msg) => { if (!c) throw new Error(msg); };
const texto = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.text(); });

const { PGlite } = await import(PGLITE);
const { PARSERS } = await import('./banco_pglite.js');
const db = new PGlite({ parsers: PARSERS });
const q = async (s, p) => (await db.query(s, p)).rows;
const um = async (s, p) => (await q(s, p))[0];

/** Executa `fn` como o usuário (igual a uma requisição autenticada do Supabase). */
async function como(u, fn) {
  const claims = JSON.stringify({ sub: u.id, email: u.email, role: 'authenticated' }).replace(/'/g, "''");
  await db.exec(`select set_config('request.jwt.claim.sub', '${u.id}', false), set_config('request.jwt.claims', '${claims}', false); set role authenticated;`);
  try { return await fn(); }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false);`); }
}
async function anonimo(fn) {
  await db.exec('set role anon;');
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
/** Espera que o banco recuse (erro). `padrao` confere a mensagem. */
async function recusa(fn, padrao) {
  let erro = null;
  try { await fn(); } catch (e) { erro = e; }
  if (!erro) throw new Error('o banco ACEITOU a operação (deveria recusar)');
  if (padrao && !padrao.test(erro.message)) throw new Error(`recusou, mas com outro erro: ${erro.message}`);
}

try {
  /* ---------- estrutura ---------- */
  grupo('1. Migrações');
  await teste('Simulador do Supabase (auth.uid, papéis anon/authenticated)', async () => {
    await db.exec(await texto('../supabase/tests/shim_supabase.sql'));
  });
  for (const m of MIGRACOES) {
    await teste(`Aplica ${m}`, async () => { await db.exec(await texto(`../supabase/migrations/${m}`)); });
  }
  await teste('Aplica seed.sql (planos) e é reexecutável sem duplicar', async () => {
    const seed = await texto('../supabase/seed.sql');
    await db.exec(seed); await db.exec(seed);
    igual((await um('select count(*)::int n from public.plans')).n, 3);
  });
  await teste('RLS ligado em todas as tabelas do schema public', async () => {
    const sem = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    igual(sem.map((r) => r.relname).join(','), '', 'tabelas sem RLS:');
  });
  await teste('Valores em dinheiro usam NUMERIC (sem ponto flutuante)', async () => {
    const flt = await q(`select table_name, column_name from information_schema.columns
                         where table_schema = 'public' and data_type in ('real', 'double precision')`);
    igual(flt.map((r) => `${r.table_name}.${r.column_name}`).join(','), '');
  });

  /* ---------- usuários e empresas ---------- */
  const novoUsuario = async (email, nome) => um(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id, email`, [email, { full_name: nome }]);
  const alice = await novoUsuario('alice@a.com', 'Alice (admin A)');
  const bob = await novoUsuario('bob@b.com', 'Bob (admin B)');
  const carol = await novoUsuario('carol@a.com', 'Carol (supervisora A)');
  const dave = await novoUsuario('dave@cliente.com', 'Dave (cliente da obra A1)');
  const erin = await novoUsuario('erin@a.com', 'Erin (financeiro A, fora da obra)');
  const mallory = await novoUsuario('mallory@x.com', 'Mallory (sem empresa)');

  grupo('2. Cadastro, empresas e convites');
  await teste('Cadastro cria o perfil do usuário automaticamente', async () => {
    igual((await um('select full_name from public.user_profiles where id = $1', [alice.id])).full_name, 'Alice (admin A)');
  });
  let orgA, orgB;
  await teste('Usuário cria a própria empresa (vira admin, assinatura em avaliação)', async () => {
    orgA = (await como(alice, () => um(`select public.create_organization('Construtora A', 'profissional') id`))).id;
    orgB = (await como(bob, () => um(`select public.create_organization('Construtora B', 'profissional') id`))).id;
    igual((await um('select role from public.organization_members where org_id = $1 and user_id = $2', [orgA, alice.id])).role, 'admin');
    igual((await um('select status from public.subscriptions where org_id = $1', [orgA])).status, 'trialing');
  });
  await teste('Sem login não cria empresa', async () => {
    await recusa(() => anonimo(() => q(`select public.create_organization('X')`)), /permission denied|login/i);
  });
  await teste('Convite: admin convida; só o dono do e-mail aceita; convite não é reutilizável', async () => {
    const convite = async (email, role) => (await como(alice, () => um(
      `insert into public.invitations (org_id, email, role, invited_by) values ($1, $2, $3, $4) returning id`, [orgA, email, role, alice.id]))).id;
    const tok = async (id) => (await um('select token from public.invitations where id = $1', [id])).token;
    const tCarol = await tok(await convite('carol@a.com', 'supervisor'));
    await recusa(() => como(mallory, () => q('select public.accept_invitation($1)', [tCarol])), /outro e-mail/);
    await como(carol, () => q('select public.accept_invitation($1)', [tCarol]));
    await recusa(() => como(carol, () => q('select public.accept_invitation($1)', [tCarol])), /já foi usado/);
    const tDave = await tok(await convite('dave@cliente.com', 'cliente'));
    const tErin = await tok(await convite('erin@a.com', 'financeiro'));
    await como(dave, () => q('select public.accept_invitation($1)', [tDave]));
    await como(erin, () => q('select public.accept_invitation($1)', [tErin]));
    igual((await um('select role from public.organization_members where org_id = $1 and user_id = $2', [orgA, carol.id])).role, 'supervisor');
  });
  await teste('Não-admin não cria convites', async () => {
    await recusa(() => como(carol, () => q(`insert into public.invitations (org_id, email, role, invited_by) values ($1, 'x@x.com', 'admin', $2)`, [orgA, carol.id])), /row-level security/);
  });
  await teste('Usuário não se promove a administrador da plataforma', async () => {
    await recusa(() => como(bob, () => q('update public.user_profiles set is_platform_admin = true where id = $1', [bob.id])), /permission denied/);
  });
  await teste('Usuário não altera a própria assinatura (só o backend)', async () => {
    await recusa(() => como(alice, () => q(`update public.subscriptions set status = 'active' where org_id = $1`, [orgA])), /permission denied/);
  });
  await teste('Não é possível remover o último administrador', async () => {
    await recusa(() => como(alice, () => q('delete from public.organization_members where org_id = $1 and user_id = $2', [orgA, alice.id])), /pelo menos um administrador/);
  });

  /* ---------- dados da obra A1 (gravados pela Alice, como o app faria) ---------- */
  let A1, B1, itemA, itemA2, etapa, at1, at2, contrato, despesa;
  grupo('3. Obra, orçamento, EAP e vínculos (gravação pela própria empresa)');
  await teste('Admin cria obra, itens, EAP, dependências e vínculos', async () => {
    await como(alice, async () => {
      A1 = (await um(`insert into public.projects (org_id, name, planned_start) values ($1, 'Obra A1', '2026-10-05') returning id`, [orgA])).id;
      itemA = (await um(`insert into public.budget_items (project_id, code, description, unit, quantity, unit_cost)
                         values ($1, 'O-1', 'Forma', 'm²', 203, 95) returning id, total_cost`, [A1]));
      itemA2 = (await um(`insert into public.budget_items (project_id, code, description, unit, quantity, unit_cost)
                          values ($1, 'O-2', 'Concreto', 'm³', 10.5, 350.555) returning id, total_cost`, [A1]));
      etapa = (await um(`insert into public.wbs_nodes (project_id, code, level, description) values ($1, '1', 1, 'Fundação') returning id`, [A1])).id;
      at1 = (await um(`insert into public.wbs_nodes (project_id, parent_id, code, level, description) values ($1, $2, '1.1', 2, 'Formas') returning id`, [A1, etapa])).id;
      at2 = (await um(`insert into public.wbs_nodes (project_id, parent_id, code, level, description) values ($1, $2, '1.2', 2, 'Concretagem') returning id`, [A1, etapa])).id;
      await q(`insert into public.activity_dependencies (project_id, activity_id, predecessor_id, dep_type, lag_days) values ($1, $2, $3, 'FS', 0)`, [A1, at2, at1]);
      await q(`insert into public.budget_allocations (project_id, budget_item_id, activity_id, share) values ($1, $2, $3, 0.6), ($1, $2, $4, 0.4)`, [A1, itemA.id, at1, at2]);
      await q(`insert into public.budget_allocations (project_id, budget_item_id, activity_id, share) values ($1, $2, $3, 1)`, [A1, itemA2.id, at2]);
    });
    igual(Number(itemA.total_cost), 19285, 'custo total = quantidade × custo unitário');
    igual(Number(itemA2.total_cost), 3680.83, 'arredondamento a centavos (10,5 × 350,555)');
  });
  await teste('Criador da obra entra na equipe dela; supervisora e cliente são adicionados', async () => {
    await como(alice, () => q('insert into public.project_members (project_id, user_id) values ($1, $2), ($1, $3)', [A1, carol.id, dave.id]));
    igual((await um('select count(*)::int n from public.project_members where project_id = $1', [A1])).n, 3);
  });
  await teste('Bob cria a obra B1 na empresa dele', async () => {
    B1 = (await como(bob, () => um(`insert into public.projects (org_id, name, planned_start) values ($1, 'Obra B1', '2026-11-01') returning id`, [orgB]))).id;
  });

  grupo('4. Isolamento entre empresas (tentativas reais de acesso indevido)');
  await teste('Bob não vê a obra da empresa A', async () => {
    const r = await como(bob, () => q('select id, name from public.projects'));
    igual(r.map((x) => x.name).join(','), 'Obra B1');
  });
  await teste('Bob não lê orçamento, EAP, vínculos nem histórico da obra A1 mesmo sabendo o id', async () => {
    await como(bob, async () => {
      igual((await q('select * from public.budget_items where project_id = $1', [A1])).length, 0, 'itens:');
      igual((await q('select * from public.wbs_nodes where project_id = $1', [A1])).length, 0, 'EAP:');
      igual((await q('select * from public.budget_allocations where project_id = $1', [A1])).length, 0, 'vínculos:');
      igual((await q('select * from public.v_project_budget where project_id = $1', [A1])).length, 0, 'view:');
      igual((await q('select * from public.audit_log where project_id = $1', [A1])).length, 0, 'auditoria:');
    });
  });
  await teste('Bob não insere item no orçamento da obra A1', async () => {
    await recusa(() => como(bob, () => q(`insert into public.budget_items (project_id, code, quantity, unit_cost) values ($1, 'X', 1, 1)`, [A1])), /row-level security/);
  });
  await teste('Bob não altera a obra A1 (nenhuma linha afetada)', async () => {
    await como(bob, () => q(`update public.projects set name = 'invadido' where id = $1`, [A1]));
    await como(bob, () => q(`update public.budget_items set unit_cost = 0 where project_id = $1`, [A1]));
    igual((await um('select name from public.projects where id = $1', [A1])).name, 'Obra A1');
    igual(Number((await um('select unit_cost from public.budget_items where id = $1', [itemA.id])).unit_cost), 95);
  });
  await teste('Bob não cria obra dentro da empresa A', async () => {
    await recusa(() => como(bob, () => q(`insert into public.projects (org_id, name, planned_start) values ($1, 'intrusa', '2026-01-01')`, [orgA])), /row-level security/);
  });
  await teste('Bob não liga um item da obra dele a uma atividade da obra A1 (chave composta)', async () => {
    const itemB = (await como(bob, () => um(`insert into public.budget_items (project_id, code, quantity, unit_cost) values ($1, 'B-1', 1, 1) returning id`, [B1]))).id;
    await recusa(() => como(bob, () => q(`insert into public.budget_allocations (project_id, budget_item_id, activity_id, share) values ($1, $2, $3, 1)`, [B1, itemB, at1])), /foreign key|violates/);
  });
  await teste('Admin não move a obra para outra empresa', async () => {
    await recusa(() => como(alice, () => q('update public.projects set org_id = $1 where id = $2', [orgB, A1])), /mudar o registro de empresa|row-level security/);
  });
  await teste('Usuário anônimo não lê nada', async () => {
    await recusa(() => anonimo(() => q('select * from public.projects')), /permission denied/);
    await recusa(() => anonimo(() => q('select * from public.plans')), /permission denied/);
  });
  await teste('Usuário logado sem empresa não vê obras nem empresas', async () => {
    await como(mallory, async () => {
      igual((await q('select * from public.projects')).length, 0);
      igual((await q('select * from public.organizations')).length, 0);
    });
  });

  grupo('5. Perfis de acesso dentro da empresa');
  await teste('Financeiro fora da equipe da obra não vê a obra', async () => {
    igual((await como(erin, () => q('select * from public.projects where id = $1', [A1]))).length, 0);
  });
  await teste('Supervisora (na equipe) vê a obra e o orçamento, mas não altera o planejamento', async () => {
    await como(carol, async () => {
      igual((await q('select * from public.projects where id = $1', [A1])).length, 1);
      igual((await q('select * from public.budget_items where project_id = $1', [A1])).length, 2);
    });
    await recusa(() => como(carol, () => q(`insert into public.budget_items (project_id, code, quantity, unit_cost) values ($1, 'S', 1, 1)`, [A1])), /row-level security/);
    await como(carol, () => q(`update public.wbs_nodes set description = 'x' where id = $1`, [at1]));
    igual((await um('select description from public.wbs_nodes where id = $1', [at1])).description, 'Formas');
  });
  await teste('Cliente vê a obra e o cronograma, mas não vê custos e não lança medição', async () => {
    await como(dave, async () => {
      igual((await q('select * from public.projects where id = $1', [A1])).length, 1, 'obra:');
      igual((await q('select * from public.wbs_nodes where project_id = $1', [A1])).length, 3, 'EAP:');
      igual((await q('select * from public.budget_items where project_id = $1', [A1])).length, 0, 'orçamento:');
    });
    await recusa(() => como(dave, () => q(`insert into public.activity_measurements (project_id, activity_id, ref_date, pct) values ($1, $2, '2026-10-10', 10)`, [A1, at1])), /row-level security/);
  });
  await teste('Ninguém apaga obra pelo app (exclusão só lógica, pelo admin)', async () => {
    await recusa(() => como(alice, () => q('delete from public.projects where id = $1', [B1])), /permission denied/);
    await recusa(() => como(alice, () => q('delete from public.budget_items where id = $1', [itemA.id])), /permission denied/);
  });

  grupo('6. Medições (servidor mantém o % da atividade, sem duplicar)');
  await teste('Supervisora mede; o banco atualiza % e início real da atividade', async () => {
    await como(carol, () => q(`insert into public.activity_measurements (project_id, activity_id, ref_date, pct, responsible_label) values ($1, $2, '2026-10-06', 60, 'Carol')`, [A1, at1]));
    const a = await um('select pct, actual_start::text s, actual_finish::text f from public.wbs_nodes where id = $1', [at1]);
    igual(Number(a.pct), 60); igual(a.s, '2026-10-06'); igual(a.f, null);
  });
  await teste('Segunda medição na mesma data é recusada (não infla o %)', async () => {
    await recusa(() => como(carol, () => q(`insert into public.activity_measurements (project_id, activity_id, ref_date, pct) values ($1, $2, '2026-10-06', 30)`, [A1, at1])), /duplicate key|unique/);
  });
  await teste('Percentual acima de 100% é recusado', async () => {
    await recusa(() => como(carol, () => q(`insert into public.activity_measurements (project_id, activity_id, ref_date, pct) values ($1, $2, '2026-10-07', 120)`, [A1, at1])), /check constraint/);
  });
  await teste('Medição em etapa (não folha) é recusada', async () => {
    await recusa(() => como(carol, () => q(`insert into public.activity_measurements (project_id, activity_id, ref_date, pct) values ($1, $2, '2026-10-07', 10)`, [A1, etapa])), /último nível/);
  });
  await teste('100% define o término real; exclusão lógica recalcula', async () => {
    const m = await como(carol, () => um(`insert into public.activity_measurements (project_id, activity_id, ref_date, pct) values ($1, $2, '2026-10-08', 100) returning id`, [A1, at1]));
    igual((await um('select actual_finish::text f from public.wbs_nodes where id = $1', [at1])).f, '2026-10-08');
    await como(carol, () => q('update public.activity_measurements set deleted_at = now() where id = $1', [m.id]));
    const a = await um('select pct, actual_finish::text f from public.wbs_nodes where id = $1', [at1]);
    igual(Number(a.pct), 60); igual(a.f, null);
  });

  grupo('7. Integridade do planejamento');
  await teste('Vínculos de um item acima de 100% são recusados (custo contado duas vezes)', async () => {
    await recusa(() => como(alice, () => db.transaction(async (tx) => {
      await tx.query('update public.budget_allocations set share = 0.7 where budget_item_id = $1 and activity_id = $2', [itemA.id, at1]);
    })), /somam 110/);
  });
  await teste('Trocar 60/40 por 70/30 na mesma transação é aceito (verificação no fim)', async () => {
    await como(alice, () => db.transaction(async (tx) => {
      await tx.query('update public.budget_allocations set share = 0.7 where budget_item_id = $1 and activity_id = $2', [itemA.id, at1]);
      await tx.query('update public.budget_allocations set share = 0.3 where budget_item_id = $1 and activity_id = $2', [itemA.id, at2]);
    }));
    const r = await um(`select status, allocated_share from public.v_budget_item_allocation where budget_item_id = $1`, [itemA.id]);
    igual(r.status, 'OK');
  });
  await teste('Dependência circular é recusada', async () => {
    await recusa(() => como(alice, () => q(`insert into public.activity_dependencies (project_id, activity_id, predecessor_id) values ($1, $2, $3)`, [A1, at1, at2])), /circular/);
  });
  await teste('Linha de base: só uma atual por obra; a anterior é preservada', async () => {
    await como(alice, async () => {
      const b0 = (await um(`insert into public.schedule_baselines (project_id, revision, finish_date, planned_cost, is_current) values ($1, 0, '2026-12-01', 22965.83, true) returning id`, [A1])).id;
      await q(`insert into public.schedule_baseline_items (baseline_id, project_id, activity_id, start_date, finish_date) values ($1, $2, $3, '2026-10-05', '2026-10-09')`, [b0, A1, at1]);
      await recusa(() => q(`insert into public.schedule_baselines (project_id, revision, is_current) values ($1, 1, true)`, [A1]), /duplicate key|unique/);
      await db.transaction(async (tx) => {
        await tx.query('update public.schedule_baselines set is_current = false where id = $1', [b0]);
        await tx.query(`insert into public.schedule_baselines (project_id, revision, is_current) values ($1, 1, true)`, [A1]);
      });
      await recusa(() => q(`update public.schedule_baselines set finish_date = '2030-01-01' where id = $1`, [b0]), /permission denied/);
    });
    igual((await um('select count(*)::int n from public.schedule_baselines where project_id = $1', [A1])).n, 2);
  });

  grupo('8. Financeiro sem duplicidade (banco × regras do app)');
  await teste('Contrato + aditivo, despesa do contrato, despesa avulsa e pagamento', async () => {
    await como(alice, async () => {
      contrato = (await um(`insert into public.contracts (project_id, kind, number, supplier_name, category, amount) values ($1, 'Contrato', 'CT-1', 'Empreiteira', 'Serviço terceirizado', 10000) returning id`, [A1])).id;
      await q(`insert into public.contract_amendments (contract_id, project_id, amount, description) values ($1, $2, 2000, 'Aditivo 1')`, [contrato, A1]);
      despesa = (await um(`insert into public.expenses (project_id, expense_date, document, supplier_name, category, contract_id, amount) values ($1, '2026-10-10', 'NF 1', 'Empreiteira', 'Serviço terceirizado', $2, 4000) returning id`, [A1, contrato])).id;
      await q(`insert into public.expenses (project_id, expense_date, document, supplier_name, category, amount) values ($1, '2026-10-12', 'NF 2', 'Loja', 'Material', 500)`, [A1]);
      await q(`insert into public.payments (expense_id, project_id, pay_date, amount) values ($1, $2, '2026-10-15', 4000)`, [despesa, A1]);
    });
  });
  await teste('Totais do banco = totais calculados pelo app (financeiro.js)', async () => {
    const r = await como(alice, () => um('select * from public.v_project_costs where project_id = $1', [A1]));
    const obraApp = {
      compromissos: [{ id: 'k1', tipo: 'Contrato', valor: 10000, aditivos: [{ valor: 2000 }] }],
      despesas: [
        { id: 'd1', compromissoId: 'k1', data: '2026-10-10', valor: 4000, pagamentos: [{ data: '2026-10-15', valor: 4000 }] },
        { id: 'd2', compromissoId: null, data: '2026-10-12', valor: 500, pagamentos: [] },
      ],
    };
    const app = resumoCustos(obraApp);
    igual(Number(r.committed), app.comprometido, 'comprometido:');
    igual(Number(r.incurred), app.incorrido, 'incorrido:');
    igual(Number(r.paid), app.pago, 'pago:');
    igual(Number(r.to_incur), app.aIncorrer, 'a incorrer:');
  });
  await teste('Pagamentos acima do valor da despesa são recusados', async () => {
    await recusa(() => como(alice, () => q(`insert into public.payments (expense_id, project_id, pay_date, amount) values ($1, $2, '2026-10-16', 1)`, [despesa, A1])), /passam do valor/);
  });
  await teste('Despesa não é apagada; exclusão lógica tira dos totais e fica na auditoria', async () => {
    await recusa(() => como(alice, () => q('delete from public.expenses where id = $1', [despesa])), /permission denied/);
    await como(alice, async () => {
      const avulsa = (await um(`select id from public.expenses where project_id = $1 and document = 'NF 2'`, [A1])).id;
      await q('update public.expenses set deleted_at = now() where id = $1', [avulsa]);
      const r = await um('select * from public.v_project_costs where project_id = $1', [A1]);
      igual(Number(r.incurred), 4000); igual(Number(r.committed), 12000);
      igual((await q(`select 1 from public.audit_log where row_id = $1 and action = 'UPDATE'`, [avulsa])).length, 1, 'auditoria:');
    });
  });
  await teste('Só o admin arquiva (exclusão lógica) uma obra; engenheiro não', async () => {
    await db.query(`update public.organization_members set role = 'engenheiro' where org_id = $1 and user_id = $2`, [orgA, erin.id]);
    await recusa(() => como(erin, () => q('update public.projects set deleted_at = now() where id = $1', [A1])), /row-level security/);
    await db.query(`update public.organization_members set role = 'financeiro' where org_id = $1 and user_id = $2`, [orgA, erin.id]);
  });
  await teste('Supervisora não vê despesas nem pagamentos; cliente não vê contratos', async () => {
    igual((await como(carol, () => q('select * from public.expenses where project_id = $1', [A1]))).length, 0);
    igual((await como(carol, () => q('select * from public.payments where project_id = $1', [A1]))).length, 0);
    igual((await como(dave, () => q('select * from public.contracts where project_id = $1', [A1]))).length, 0);
  });
  await teste('BDI do banco = BDI do app (fórmula TCU)', async () => {
    const b = { ac: 4, s: 0.4, r: 1.27, g: 0.4, df: 1.23, l: 7.4, i: 8.65 };
    const r = await um('select public.bdi_tcu($1, $2, $3, $4, $5, $6, $7) v', [b.ac, b.s, b.r, b.g, b.df, b.l, b.i]);
    verdade(Math.abs(Number(r.v) - bdiTCU(b)) < 1e-12, `banco ${r.v} × app ${bdiTCU(b)}`);
  });

  grupo('9. Auditoria e limites do plano');
  await teste('Alterações financeiras ficam na auditoria com o autor; usuário não apaga a auditoria', async () => {
    const r = await como(alice, () => q(`select table_name, action, changed_by from public.audit_log where project_id = $1 and table_name = 'expenses'`, [A1]));
    verdade(r.length >= 2 && r.every((x) => x.changed_by === alice.id), 'auditoria incompleta');
    await recusa(() => como(alice, () => q('delete from public.audit_log')), /permission denied/);
  });
  await teste('Limite de obras do plano é aplicado pelo banco', async () => {
    await db.query(`update public.subscriptions set plan_id = 'individual' where org_id = $1`, [orgB]);  // como o backend faria
    await como(bob, async () => {
      await q(`insert into public.projects (org_id, name, planned_start) values ($1, 'B2', '2026-01-01'), ($1, 'B3', '2026-01-01')`, [orgB]);
      await recusa(() => q(`insert into public.projects (org_id, name, planned_start) values ($1, 'B4', '2026-01-01')`, [orgB]), /Limite de obras/);
    });
  });
  await teste('Assinatura vencida bloqueia novas gravações (leitura continua)', async () => {
    await db.query(`update public.subscriptions set trial_ends_at = now() - interval '1 day' where org_id = $1`, [orgB]);
    await como(bob, async () => {
      igual((await q('select * from public.projects where id = $1', [B1])).length, 1, 'leitura:');
      await recusa(() => q(`insert into public.budget_items (project_id, code, quantity, unit_cost) values ($1, 'Z', 1, 1)`, [B1]), /row-level security/);
    });
  });
  await teste('Limite de usuários do plano (Individual = 1 usuário)', async () => {
    const tok = (await como(bob, () => um(`insert into public.invitations (org_id, email, role, invited_by) values ($1, 'mallory@x.com', 'engenheiro', $2) returning token`, [orgB, bob.id]))).token;
    await recusa(() => como(mallory, () => q('select public.accept_invitation($1)', [tok])), /Limite de usuários/);
  });
  /* ---------- 11. Fornecedores ---------- */
  grupo('11. Fornecedores (cadastro, validação, isolamento, inativação, avaliações, documentos)');
  const beto = await novoUsuario('beto@outra.com', 'Beto (admin de outra empresa)');
  let orgX, supA, supX;
  const CNPJ = '11222333000181', CPF = '52998224725';
  await teste('Empresa existente recebeu as 14 categorias padrão; empresa nova já nasce com elas', async () => {
    igual((await um('select count(*)::int n from public.supplier_categories where org_id = $1', [orgA])).n, 14, 'empresa A:');
    orgX = (await como(beto, () => um(`select public.create_organization('Outra Construtora') id`))).id;
    igual((await um('select count(*)::int n from public.supplier_categories where org_id = $1', [orgX])).n, 14, 'empresa nova:');
  });
  await teste('Cadastro com CNPJ válido; CNPJ/CPF com dígito errado é recusado pelo banco', async () => {
    const cat = (await um(`select id from public.supplier_categories where org_id = $1 and name = 'Cimento e argamassa'`, [orgA])).id;
    supA = (await como(alice, () => um(`insert into public.suppliers (org_id, trade_name, doc_number, main_category_id, city, state, products)
      values ($1, 'Depósito Bom Preço', $2, $3, 'Campinas', 'SP', 'cimento, areia, cal') returning id`, [orgA, CNPJ, cat]))).id;
    await recusa(() => como(alice, () => q(`insert into public.suppliers (org_id, trade_name, doc_number) values ($1, 'X', '11222333000182')`, [orgA])), /check constraint/);
    await recusa(() => como(alice, () => q(`insert into public.suppliers (org_id, trade_name, doc_number) values ($1, 'Y', '52998224726')`, [orgA])), /check constraint/);
    await como(alice, () => q(`insert into public.suppliers (org_id, trade_name, doc_number) values ($1, 'Autônomo Silva', $2)`, [orgA, CPF]));
  });
  await teste('Mesmo CPF/CNPJ não se repete na empresa (mas pode existir em outra empresa)', async () => {
    await recusa(() => como(alice, () => q(`insert into public.suppliers (org_id, trade_name, doc_number) values ($1, 'Duplicado', $2)`, [orgA, CNPJ])), /duplicate key|unique/);
    supX = (await como(beto, () => um(`insert into public.suppliers (org_id, trade_name, doc_number) values ($1, 'Depósito Bom Preço (B)', $2) returning id`, [orgX, CNPJ]))).id;
  });
  await teste('Perfis: financeiro cadastra; supervisor só lê; cliente não vê fornecedores', async () => {
    await como(erin, () => q(`insert into public.suppliers (org_id, trade_name) values ($1, 'Locadora de Máquinas')`, [orgA]));
    igual((await como(carol, () => q('select id from public.suppliers where org_id = $1', [orgA]))).length, 3, 'supervisor lê:');
    await recusa(() => como(carol, () => q(`insert into public.suppliers (org_id, trade_name) values ($1, 'Pelo supervisor')`, [orgA])), /row-level security/);
    igual((await como(dave, () => q('select id from public.suppliers'))).length, 0, 'cliente:');
  });
  await teste('Outra empresa não vê, não cria e não altera fornecedores da empresa A', async () => {
    igual((await como(beto, () => q('select trade_name from public.suppliers'))).map((r) => r.trade_name).join(), 'Depósito Bom Preço (B)');
    await recusa(() => como(beto, () => q(`insert into public.suppliers (org_id, trade_name) values ($1, 'intruso')`, [orgA])), /row-level security/);
    await como(beto, () => q(`update public.suppliers set trade_name = 'invadido' where id = $1`, [supA]));
    igual((await um('select trade_name from public.suppliers where id = $1', [supA])).trade_name, 'Depósito Bom Preço');
  });
  await teste('Contrato da obra liga ao fornecedor da própria empresa; fornecedor de outra empresa é recusado', async () => {
    await como(alice, () => q('update public.contracts set supplier_id = $1 where id = $2', [supA, contrato]));
    await recusa(() => como(alice, () => q('update public.contracts set supplier_id = $1 where id = $2', [supX, contrato])), /outra empresa/);
  });
  await teste('Inativar preserva histórico (data registrada pelo banco); ninguém apaga fornecedor', async () => {
    await como(alice, () => q(`update public.suppliers set status = 'inativo' where id = $1`, [supA]));
    const s = await um('select status, inactivated_at is not null inat from public.suppliers where id = $1', [supA]);
    igual(s.status, 'inativo'); verdade(s.inat, 'data de inativação não registrada');
    igual((await um('select supplier_id from public.contracts where id = $1', [contrato])).supplier_id, supA, 'vínculo do contrato:');
    await recusa(() => como(alice, () => q('delete from public.suppliers where id = $1', [supA])), /permission denied/);
  });
  await teste('Avaliação manual: supervisor avalia (1 a 5); nota fora da escala, cliente e edição posterior são recusados', async () => {
    await como(carol, () => q(`insert into public.supplier_evaluations (org_id, supplier_id, project_id, punctuality, quality, comment, evaluated_by)
      values ($1, $2, $3, 4, 5, 'Entregou no prazo', $4)`, [orgA, supA, A1, carol.id]));
    await recusa(() => como(carol, () => q(`insert into public.supplier_evaluations (org_id, supplier_id, quality, evaluated_by) values ($1, $2, 6, $3)`, [orgA, supA, carol.id])), /check constraint/);
    await recusa(() => como(dave, () => q(`insert into public.supplier_evaluations (org_id, supplier_id, quality, evaluated_by) values ($1, $2, 3, $3)`, [orgA, supA, dave.id])), /row-level security/);
    await recusa(() => como(carol, () => q(`update public.supplier_evaluations set quality = 1 where supplier_id = $1`, [supA])), /permission denied/);
  });
  await teste('Categoria secundária de outra empresa não pode ser ligada (chave composta)', async () => {
    const catX = (await um(`select id from public.supplier_categories where org_id = $1 limit 1`, [orgX])).id;
    await recusa(() => como(alice, () => q('insert into public.supplier_secondary_categories (supplier_id, category_id, org_id) values ($1, $2, $3)', [supA, catX, orgA])), /foreign key|violates|row-level/);
  });
  await teste('Arquivos: só a empresa dona lê e grava na pasta dela; cliente e outra empresa são bloqueados', async () => {
    const caminho = `${orgA}/fornecedores/${supA}/proposta.pdf`;
    await como(alice, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [caminho]));
    igual((await como(carol, () => q('select name from storage.objects where name = $1', [caminho]))).length, 1, 'supervisor lê:');
    igual((await como(beto, () => q('select name from storage.objects where name = $1', [caminho]))).length, 0, 'outra empresa:');
    igual((await como(dave, () => q('select name from storage.objects where name = $1', [caminho]))).length, 0, 'cliente:');
    await recusa(() => como(beto, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${orgA}/fornecedores/${supA}/falso.pdf`])), /row-level security/);
    await recusa(() => como(carol, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${orgA}/fornecedores/${supA}/sup.pdf`])), /row-level security/);
    await recusa(() => como(alice, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${orgA}/obras/x/y.pdf`])), /row-level security/);
    await como(alice, () => q('delete from storage.objects where name = $1', [caminho]));   // sem política de DELETE: nada é apagado
    igual((await um('select count(*)::int n from storage.objects where name = $1', [caminho])).n, 1, 'arquivo continua guardado:');
  });
  await teste('Documento: caminho precisa ser da empresa e do fornecedor; só nome, tipo e exclusão lógica mudam', async () => {
    await como(alice, () => q(`insert into public.supplier_documents (org_id, supplier_id, kind, name, storage_path, mime_type, size_bytes, uploaded_by)
      values ($1, $2, 'Proposta', 'Proposta março', $3, 'application/pdf', 1000, $4)`, [orgA, supA, `${orgA}/fornecedores/${supA}/proposta.pdf`, alice.id]));
    await recusa(() => como(alice, () => q(`insert into public.supplier_documents (org_id, supplier_id, name, storage_path, size_bytes, uploaded_by)
      values ($1, $2, 'x', $3, 10, $4)`, [orgA, supA, `${orgX}/fornecedores/${supA}/x.pdf`, alice.id])), /check constraint/);
    await recusa(() => como(alice, () => q(`update public.supplier_documents set storage_path = 'outro' where supplier_id = $1`, [supA])), /permission denied/);
    await como(alice, () => q(`update public.supplier_documents set deleted_at = now() where supplier_id = $1`, [supA]));
  });
  await teste('Auditoria registra cadastro, inativação e avaliação de fornecedores', async () => {
    const r = await q(`select table_name, action from public.audit_log where table_name in ('suppliers', 'supplier_evaluations') and org_id = $1`, [orgA]);
    verdade(r.filter((x) => x.table_name === 'suppliers' && x.action === 'UPDATE').length >= 1 && r.some((x) => x.table_name === 'supplier_evaluations'), 'auditoria incompleta');
  });

  await testesSuprimentos({ alice, bob, carol, dave, erin, beto, orgA, orgB, orgX, A1, B1, contrato, supX, etapa });
  await testesDiario({ alice, carol, dave, erin, beto, orgA, orgX, A1, etapa, at1 });
  await testesMedicoes({ alice, carol, dave, erin, beto, orgA, A1, etapa, at1, at2 });
  await testesIntegracao({ alice, carol, erin, A1, etapa, at1 });
  await testesLeitura({ alice, bob, carol, dave, orgA, A1, B1 });
  await testesBases({ alice, bob, carol, dave, mallory, orgA, orgB });
  await testesSeguranca({ bob, orgA, mallory, A1 });
  await testesSincronizacao({ novoUsuario, bob });
} catch (e) {
  fail++;
  out.insertAdjacentHTML('beforeend', `<div class="t err"><b>ERRO</b><span>${esc(e.stack || e.message)}</span></div>`);
}

/* ---------- 12. Suprimentos (pedido com grupos) e liberações por pessoa ---------- */
async function testesSuprimentos({ alice, bob, carol, dave, erin, beto, orgA, orgB, orgX, A1, B1, contrato, supX, etapa }) {
  grupo('12. Suprimentos: pedido principal com grupos, situação calculada, entregas e liberações');
  const { LIBERACOES_PADRAO, liberacoesDe } = await import('../js/liberacoes.js');
  const libs = async (u, org = orgA) => (await como(u, () => um('select public.minhas_liberacoes($1) l', [org]))).l.join(',');
  const lib = (papel) => liberacoesDe(papel).sort().join(',');
  const silva = (await um(`select id from public.suppliers where org_id = $1 and trade_name = 'Autônomo Silva'`, [orgA])).id;
  const pedido = async (id) => um('select status, stage, number, concluded_at from public.purchase_orders where id = $1', [id]);
  const grupoSt = async (id) => (await um('select status from public.purchase_groups where id = $1', [id])).status;
  let ped, gMad, gCim, iTab, iSar, iCim, cotMad1, cotMad2, ctMad, ped2, g2, i2;

  await teste('Liberações padrão do banco = as da tela (js/liberacoes.js), para todos os perfis', async () => {
    for (const papel of Object.keys(LIBERACOES_PADRAO)) {
      const r = await um(`select array_to_string(array(select x from unnest(public.liberacoes_padrao($1::public.member_role)) x order by x), ',') l`, [papel]);
      igual(r.l, [...LIBERACOES_PADRAO[papel]].sort().join(','), `${papel}:`);
    }
  });
  await teste('Liberações efetivas: admin todas; supervisora solicita e recebe; cliente nenhuma; outra empresa nada', async () => {
    igual(await libs(alice), lib('admin'), 'admin:');
    igual(await libs(carol), lib('supervisor'), 'supervisora:');
    igual(await libs(erin), lib('financeiro'), 'financeiro:');
    igual(await libs(dave), '', 'cliente:');
    igual(await libs(beto), '', 'outra empresa:');
  });
  await teste('Supervisora abre PED-0001 com fase da EAP e dois grupos (madeira, cimento); número por empresa', async () => {
    await como(carol, async () => {
      ped = (await um(`insert into public.purchase_orders (project_id, title, phase_id, priority, needed_date, delivery_location)
        values ($1, 'Materiais para estrutura', $2, 'urgente', '2026-10-20', 'Portão 2') returning id`, [A1, etapa])).id;
      gMad = (await um(`insert into public.purchase_groups (order_id, project_id, name, position) values ($1, $2, 'Madeira', 0) returning id`, [ped, A1])).id;
      gCim = (await um(`insert into public.purchase_groups (order_id, project_id, name, position) values ($1, $2, 'Cimento', 1) returning id`, [ped, A1])).id;
      iTab = (await um(`insert into public.purchase_items (group_id, project_id, description, quantity, unit) values ($1, $2, 'Tábua 30 cm', 40, 'un') returning id`, [gMad, A1])).id;
      iSar = (await um(`insert into public.purchase_items (group_id, project_id, description, quantity, unit, position) values ($1, $2, 'Sarrafo', 3.5, 'dz', 1) returning id`, [gMad, A1])).id;
      iCim = (await um(`insert into public.purchase_items (group_id, project_id, description, quantity, unit) values ($1, $2, 'Cimento CP-II', 50, 'sc') returning id`, [gCim, A1])).id;
    });
    const p = await pedido(ped);
    igual(p.number, 1); igual(p.status, 'pedido'); igual(p.stage, 1);
    verdade((await q(`select 1 from public.purchase_events where order_id = $1 and kind = 'pedido'`, [ped])).length === 1, 'histórico de criação');
  });
  await teste('Cliente e outra empresa não veem nem criam pedidos; quantidade zero é recusada', async () => {
    igual((await como(dave, () => q('select id from public.purchase_orders'))).length, 0, 'cliente lê:');
    igual((await como(beto, () => q('select id from public.purchase_groups'))).length, 0, 'outra empresa lê:');
    await recusa(() => como(dave, () => q(`insert into public.purchase_orders (project_id, title) values ($1, 'Cliente')`, [A1])), /row-level security/);
    await recusa(() => como(beto, () => q(`insert into public.purchase_orders (project_id, title) values ($1, 'Intruso')`, [A1])), /row-level security/);
    await recusa(() => como(carol, () => q(`insert into public.purchase_items (group_id, project_id, description, quantity) values ($1, $2, 'x', 0)`, [gMad, A1])), /check constraint/);
  });
  await teste('Situação do pedido não é alterada à mão (nem pelo administrador); grupo não muda de etapa por UPDATE', async () => {
    await recusa(() => como(alice, () => q(`update public.purchase_orders set status = 'concluido', stage = 4 where id = $1`, [ped])), /calculada a partir dos grupos/);
    await recusa(() => como(alice, () => q(`update public.purchase_groups set status = 'entregue' where id = $1`, [gMad])), /ações do grupo/);
    await recusa(() => como(carol, () => q('update public.purchase_orders set number = 9 where id = $1', [ped])), /não podem ser alterados/);
  });
  await teste('Sem "comprar", a supervisora não cota nem muda etapa; com o financeiro na equipe, cotação põe o grupo em cotação', async () => {
    await como(alice, () => q('insert into public.project_members (project_id, user_id) values ($1, $2)', [A1, erin.id]));
    await recusa(() => como(carol, () => q(`insert into public.purchase_quotes (group_id, project_id, supplier_name, total_amount) values ($1, $2, 'X', 1)`, [gMad, A1])), /row-level security/);
    await recusa(() => como(carol, () => q(`select public.mudar_etapa_grupo($1, 'cotacao')`, [gMad])), /liberação de compras/);
    await como(erin, async () => {
      cotMad1 = (await um(`insert into public.purchase_quotes (group_id, project_id, supplier_id, supplier_name, total_amount, freight_amount, lead_days)
        values ($1, $2, $3, 'Autônomo Silva', 1890.5, 120, 3) returning id`, [gMad, A1, silva])).id;
      cotMad2 = (await um(`insert into public.purchase_quotes (group_id, project_id, supplier_name, total_amount) values ($1, $2, 'Madeireira Central', 2100) returning id`, [gMad, A1])).id;
    });
    igual(await grupoSt(gMad), 'cotacao');
    const p = await pedido(ped);
    igual(p.status, 'em_andamento', 'madeira em cotação, cimento em análise:'); igual(p.stage, 1, 'coluna do grupo menos adiantado:');
  });
  await teste('Todos os grupos em cotação → pedido "Em cotação" (coluna 2)', async () => {
    await como(erin, () => q(`select public.mudar_etapa_grupo($1, 'cotacao')`, [gCim]));
    const p = await pedido(ped); igual(p.status, 'em_cotacao'); igual(p.stage, 2);
  });
  await teste('Passagens inválidas são recusadas com explicação (entregue só por entregas; compra só pela ação)', async () => {
    await recusa(() => como(erin, () => q(`select public.mudar_etapa_grupo($1, 'entregue')`, [gMad])), /registre as entregas/);
    await recusa(() => como(erin, () => q(`select public.mudar_etapa_grupo($1, 'aguardando_entrega')`, [gMad])), /registre a compra/);
    await recusa(() => como(erin, () => q(`insert into public.purchase_quotes (group_id, project_id, supplier_id, supplier_name, total_amount) values ($1, $2, $3, 'Outra', 5)`, [gMad, A1, supX])), /outra empresa/);
  });
  await teste('Compra da madeira pela cotação: compromisso no Financeiro com a fase, cotação escolhida e a outra descartada', async () => {
    ctMad = (await como(erin, () => um(`select public.registrar_compra_grupo($1, $2, p_expected_date => '2026-10-18', p_expected_kind => 'confirmada') id`, [gMad, cotMad1]))).id;
    const k = await um('select * from public.contracts where id = $1', [ctMad]);
    igual(k.kind, 'Pedido'); igual(k.status, 'Aprovado'); igual(k.number, 'PED-0001 · Madeira');
    igual(Number(k.amount), 2010.5, 'materiais + frete:'); igual(k.phase_id, etapa, 'fase:'); igual(k.supplier_id, silva);
    igual(k.scope, 'Materiais para estrutura — Madeira: 40 un Tábua 30 cm; 3,5 dz Sarrafo');
    igual((await um('select status from public.purchase_quotes where id = $1', [cotMad1])).status, 'escolhida');
    igual((await um('select status from public.purchase_quotes where id = $1', [cotMad2])).status, 'descartada');
    const g = await um('select status, quoted_amount, amount, freight, expected_kind from public.purchase_groups where id = $1', [gMad]);
    igual(g.status, 'aguardando_entrega'); igual(Number(g.quoted_amount), 2010.5); igual(g.expected_kind, 'confirmada');
    const p = await pedido(ped); igual(p.status, 'em_andamento'); igual(p.stage, 2, 'cimento ainda em cotação:');
  });
  await teste('Depois da compra: itens e cotações do grupo travados; dados da compra só pela ação', async () => {
    await recusa(() => como(alice, () => q('update public.purchase_items set quantity = 1 where id = $1', [iTab])), /não mudam mais/);
    await recusa(() => como(erin, () => q(`insert into public.purchase_quotes (group_id, project_id, supplier_name, total_amount) values ($1, $2, 'Tarde', 1)`, [gMad, A1])), /não recebe cotações/);
    await recusa(() => como(alice, () => q('update public.purchase_groups set amount = 1 where id = $1', [gMad])), /Registrar compra/);
    await recusa(() => como(erin, () => q('update public.purchase_quotes set total_amount = 1 where id = $1', [cotMad1])), /escolhida/);
  });
  await teste('Compra direta do cimento (sem cotação) → pedido inteiro "Compra realizada / aguardando entrega" (coluna 3)', async () => {
    await como(erin, () => q(`select public.registrar_compra_grupo($1, p_supplier_name => 'Depósito do Bairro', p_amount => 1650)`, [gCim]));
    igual(await grupoSt(gCim), 'comprado');
    const p = await pedido(ped); igual(p.status, 'aguardando_entrega'); igual(p.stage, 3);
  });
  await teste('Entrega: cliente não registra; data futura e item de outro grupo são recusados', async () => {
    await recusa(() => como(dave, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [gMad, JSON.stringify([{ item_id: iTab, quantity: 1 }])])), /liberação/);
    await recusa(() => como(carol, () => q(`select public.registrar_entrega($1, current_date + 1, $2::jsonb)`, [gMad, JSON.stringify([{ item_id: iTab, quantity: 1 }])])), /futura/);
    await recusa(() => como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [gMad, JSON.stringify([{ item_id: iCim, quantity: 1 }])])), /não pertence/);
    await recusa(() => como(carol, () => q(`insert into public.purchase_deliveries (group_id, project_id, delivery_date) values ($1, $2, current_date)`, [gMad, A1])), /permission denied/);
  });
  await teste('Entrega parcial da madeira: grupo "Entrega parcial", Financeiro acompanha, pedido não conclui e lista o que falta', async () => {
    await como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb, p_issue => 'falta', p_quantity_ok => false, p_invoice => 'NF 10')`,
      [gMad, JSON.stringify([{ item_id: iTab, quantity: 30 }, { item_id: iSar, quantity: 3.5 }])]));
    igual(await grupoSt(gMad), 'entrega_parcial');
    igual((await um('select status from public.contracts where id = $1', [ctMad])).status, 'Entregue parcialmente');
    const p = await pedido(ped); igual(p.status, 'aguardando_entrega'); igual(p.concluded_at, null);
    const pend = await como(alice, () => q('select * from public.pendencias_pedido($1)', [ped]));
    igual(pend.map((x) => `${x.grupo}: ${x.pendencia}`).join(' | '), 'Madeira: entrega parcial — faltam: 10 un Tábua 30 cm | Cimento: aguardando entrega');
  });
  await teste('Entrega do restante → madeira "Entregue e conferido"; pedido "Em andamento" (cimento falta)', async () => {
    await como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [gMad, JSON.stringify([{ item_id: iTab, quantity: 10 }])]));
    igual(await grupoSt(gMad), 'entregue');
    igual((await um('select status from public.contracts where id = $1', [ctMad])).status, 'Entregue');
    const p = await pedido(ped); igual(p.status, 'em_andamento'); igual(p.stage, 3);
    await recusa(() => como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [gMad, JSON.stringify([{ item_id: iTab, quantity: 1 }])])), /só grupos comprados/);
  });
  await teste('Desfazer entrega exige motivo e recalcula (volta a "Entrega parcial"); depois é lançada de novo', async () => {
    const ult = (await um(`select d.id from public.purchase_deliveries d join public.purchase_delivery_items i on i.delivery_id = d.id where d.group_id = $1 and i.quantity = 10`, [gMad])).id;
    await recusa(() => como(carol, () => q(`select public.desfazer_entrega($1, 'x')`, [ult])), /motivo/);
    await recusa(() => como(dave, () => q(`select public.desfazer_entrega($1, 'lançada errada')`, [ult])), /Só quem registrou/);
    await como(carol, () => q(`select public.desfazer_entrega($1, 'lançada em duplicidade')`, [ult]));
    igual(await grupoSt(gMad), 'entrega_parcial');
    await como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [gMad, JSON.stringify([{ item_id: iTab, quantity: 10 }])]));
    igual(await grupoSt(gMad), 'entregue');
  });
  await teste('Cancelar grupo: sem "comprar" e sem motivo é recusado; com motivo, compromisso cancelado e pedido concluído', async () => {
    await recusa(() => como(carol, () => q(`select public.encerrar_grupo($1, 'cancelar', 'comprado no local')`, [gCim])), /liberação de compras/);
    await recusa(() => como(erin, () => q(`select public.encerrar_grupo($1, 'cancelar', 'ok')`, [gCim])), /motivo/);
    await como(erin, () => q(`select public.encerrar_grupo($1, 'cancelar', 'Obra comprou no depósito ao lado')`, [gCim]));
    const g = await um('select status, resolution_reason, resolved_label from public.purchase_groups where id = $1', [gCim]);
    igual(g.status, 'cancelado'); igual(g.resolution_reason, 'Obra comprou no depósito ao lado'); verdade(g.resolved_label, 'quem cancelou');
    const p = await pedido(ped); igual(p.status, 'concluido'); igual(p.stage, 4); verdade(p.concluded_at, 'data de conclusão');
    igual((await como(alice, () => q('select * from public.pendencias_pedido($1)', [ped]))).length, 0, 'sem pendências:');
  });
  await teste('Pedido concluído não recebe novos grupos; histórico preservado com autor', async () => {
    await recusa(() => como(alice, () => q(`insert into public.purchase_groups (order_id, project_id, name) values ($1, $2, 'Tarde')`, [ped, A1])), /abra um novo pedido/);
    const ev = await q('select kind, body, author_label from public.purchase_events where order_id = $1 order by id', [ped]);
    for (const k of ['pedido', 'grupo', 'cotacao', 'status', 'compra', 'entrega', 'cancelamento']) verdade(ev.some((e) => e.kind === k), `sem evento ${k}`);
    verdade(ev.every((e) => e.author_label), 'evento sem autor');
    verdade(ev.some((e) => e.body === 'Madeira: Em cotação → Aguardando entrega'), 'passagem de etapa legível');
    verdade(!ev.some((e) => /Situação do pedido: (.+) → \1$/.test(e.body)), 'evento sem mudança real');
    verdade(ev.some((e) => e.body === 'Madeira: compra realizada com Autônomo Silva — R$ 2.010,50 (frete R$ 120,00)'), 'valor em reais');
  });
  await teste('Resolver pendência: grupo com entrega parcial encerra com motivo (cancelar já não é permitido)', async () => {
    await como(carol, async () => {
      ped2 = (await um(`insert into public.purchase_orders (project_id, title) values ($1, 'Aço') returning id, number`, [A1]));
      g2 = (await um(`insert into public.purchase_groups (order_id, project_id, name) values ($1, $2, 'Aço CA-50') returning id`, [ped2.id, A1])).id;
      i2 = (await um(`insert into public.purchase_items (group_id, project_id, description, quantity, unit) values ($1, $2, 'Barra 10 mm', 24, 'br') returning id`, [g2, A1])).id;
    });
    igual(ped2.number, 2, 'número sequencial:');
    await como(erin, () => q(`select public.registrar_compra_grupo($1, p_supplier_name => 'Aço Forte', p_amount => 900)`, [g2]));
    await como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [g2, JSON.stringify([{ item_id: i2, quantity: 20 }])]));
    await recusa(() => como(erin, () => q(`select public.encerrar_grupo($1, 'cancelar', 'desistimos')`, [g2])), /Resolver pendência/);
    await como(erin, () => q(`select public.encerrar_grupo($1, 'resolver', 'Fornecedor não tem mais; 4 barras dispensadas')`, [g2]));
    igual(await grupoSt(g2), 'resolvido'); igual((await pedido(ped2.id)).status, 'concluido');
  });
  await teste('Comentários: quem vê o pedido comenta; ninguém grava evento do sistema, edita ou apaga histórico', async () => {
    await como(carol, () => q(`insert into public.purchase_events (order_id, project_id, kind, body) values ($1, $2, 'comentario', 'Chegou tudo no portão 2')`, [ped, A1]));
    await recusa(() => como(carol, () => q(`insert into public.purchase_events (order_id, project_id, kind, body) values ($1, $2, 'status', 'falso')`, [ped, A1])), /row-level security/);
    await recusa(() => como(dave, () => q(`insert into public.purchase_events (order_id, project_id, kind, body) values ($1, $2, 'comentario', 'oi')`, [ped, A1])), /row-level security/);
    await recusa(() => como(alice, () => q('delete from public.purchase_events where order_id = $1', [ped])), /permission denied/);
    await recusa(() => como(alice, () => q(`update public.purchase_events set body = 'x' where order_id = $1`, [ped])), /permission denied/);
    igual((await um(`select author_label from public.purchase_events where kind = 'comentario' and order_id = $1`, [ped])).author_label, 'Carol (supervisora A)');
  });
  await teste('Anexos do pedido: pasta do pedido no Storage privado; outra empresa e cliente bloqueados; caminho conferido', async () => {
    const caminho = `${orgA}/suprimentos/${ped}/foto.jpg`;
    await como(carol, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [caminho]));
    igual((await como(erin, () => q('select 1 from storage.objects where name = $1', [caminho]))).length, 1, 'equipe lê:');
    igual((await como(dave, () => q('select 1 from storage.objects where name = $1', [caminho]))).length, 0, 'cliente:');
    igual((await como(beto, () => q('select 1 from storage.objects where name = $1', [caminho]))).length, 0, 'outra empresa:');
    await recusa(() => como(beto, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${orgA}/suprimentos/${ped}/x.jpg`])), /row-level security/);
    await como(carol, () => q(`insert into public.purchase_files (order_id, project_id, group_id, kind, name, storage_path, size_bytes) values ($1, $2, $3, 'Foto', 'foto.jpg', $4, 100)`, [ped, A1, gMad, caminho]));
    await recusa(() => como(carol, () => q(`insert into public.purchase_files (order_id, project_id, name, storage_path, size_bytes) values ($1, $2, 'x', $3, 1)`, [ped, A1, `${orgX}/suprimentos/${ped}/x.jpg`])), /não corresponde/);
  });
  await teste('Administrador retira "receber" da supervisora: o banco recusa a entrega; ela não muda as próprias liberações', async () => {
    const ped3 = (await como(carol, () => um(`insert into public.purchase_orders (project_id, title) values ($1, 'Pregos') returning id`, [A1]))).id;
    const g3 = (await como(carol, () => um(`insert into public.purchase_groups (order_id, project_id, name) values ($1, $2, 'Pregos') returning id`, [ped3, A1]))).id;
    const i3 = (await como(carol, () => um(`insert into public.purchase_items (group_id, project_id, description, quantity) values ($1, $2, 'Prego 18x27', 5) returning id`, [g3, A1]))).id;
    await como(erin, () => q(`select public.registrar_compra_grupo($1, p_supplier_name => 'Loja', p_amount => 80)`, [g3]));
    await como(alice, () => q(`update public.organization_members set permissions = array['solicitar'] where org_id = $1 and user_id = $2`, [orgA, carol.id]));
    igual(await libs(carol), 'solicitar');
    await recusa(() => como(carol, () => q(`select public.registrar_entrega($1, current_date, $2::jsonb)`, [g3, JSON.stringify([{ item_id: i3, quantity: 5 }])])), /liberação para registrar entregas/);
    await como(carol, () => q(`update public.organization_members set permissions = null where org_id = $1 and user_id = $2`, [orgA, carol.id]));
    igual(await libs(carol), 'solicitar', 'continua restrita:');
    await recusa(() => como(alice, () => q(`update public.organization_members set permissions = array['voar'] where org_id = $1 and user_id = $2`, [orgA, carol.id])), /check constraint/);
    await como(alice, () => q(`update public.organization_members set permissions = null where org_id = $1 and user_id = $2`, [orgA, carol.id]));
  });
  await teste('Administrador libera "comprar" para a supervisora: ela passa a lançar pedido no Financeiro', async () => {
    await recusa(() => como(carol, () => q(`insert into public.contracts (project_id, kind, number, amount) values ($1, 'Pedido', 'SUP-1', 10)`, [A1])), /row-level security/);
    await como(alice, () => q(`update public.organization_members set permissions = array['solicitar', 'receber', 'comprar'] where org_id = $1 and user_id = $2`, [orgA, carol.id]));
    await como(carol, () => q(`insert into public.contracts (project_id, kind, number, amount) values ($1, 'Pedido', 'SUP-1', 10)`, [A1]));
    await como(alice, () => q(`update public.organization_members set permissions = null where org_id = $1 and user_id = $2`, [orgA, carol.id]));
    igual(await libs(carol), lib('supervisor'), 'volta ao padrão:');
  });
  await teste('Sem "fornecedores", o financeiro deixa de cadastrar fornecedor (regra antiga mantida no padrão)', async () => {
    await como(alice, () => q(`update public.organization_members set permissions = array['solicitar', 'comprar'] where org_id = $1 and user_id = $2`, [orgA, erin.id]));
    await recusa(() => como(erin, () => q(`insert into public.suppliers (org_id, trade_name) values ($1, 'Sem liberação')`, [orgA])), /row-level security/);
    await como(alice, () => q(`update public.organization_members set permissions = null where org_id = $1 and user_id = $2`, [orgA, erin.id]));
    await como(erin, () => q(`insert into public.suppliers (org_id, trade_name) values ($1, 'Com liberação padrão')`, [orgA]));
  });
  await teste('Outra empresa não compra, não recebe e não lê pendências de pedidos da empresa A', async () => {
    await recusa(() => como(beto, () => q(`select public.registrar_compra_grupo($1, p_supplier_name => 'X', p_amount => 1)`, [gCim])), /liberação|já está/);
    igual((await como(beto, () => q('select * from public.pendencias_pedido($1)', [ped2.id]))).length, 0);
    igual((await como(beto, () => q('select id from public.purchase_events'))).length, 0);
  });
  await teste('Assinatura vencida bloqueia novos pedidos', async () => {
    await recusa(() => como(bob, () => q(`insert into public.purchase_orders (project_id, title) values ($1, 'Vencida')`, [B1])), /row-level security/);
  });
  await teste('Auditoria registra pedido, grupos, itens, cotações, entregas e compromisso, com o autor', async () => {
    const r = await q(`select table_name, changed_by from public.audit_log where project_id = $1`, [A1]);
    for (const t of ['purchase_orders', 'purchase_groups', 'purchase_items', 'purchase_quotes', 'purchase_deliveries', 'contracts']) verdade(r.some((x) => x.table_name === t), `sem auditoria de ${t}`);
    verdade(r.some((x) => x.table_name === 'purchase_deliveries' && x.changed_by === carol.id), 'autor da entrega');
  });
  void orgB; void orgX;
}

/* ---------- 13. Diário de obra (RDO) ---------- */
async function testesDiario({ alice, carol, dave, erin, beto, orgA, orgX, A1, etapa, at1 }) {
  grupo('13. Diário de obra: RDO por período, número, aprovação com assinatura, mídias, comentários, histórico');
  const pasta = (r) => `${orgA}/obras/${A1}/rdo/${r}`;
  const rdo = async (id) => um('select number, status, approved_label, approved_signature_path, filled_signature_path, review_note from public.daily_reports where id = $1', [id]);
  let r1, r2;
  await teste('Liberação "aprovar RDO": padrão administrador e engenheiro (igual à tela)', async () => {
    const { LIBERACOES_PADRAO } = await import('../js/liberacoes.js');
    for (const papel of Object.keys(LIBERACOES_PADRAO)) {
      const r = await um(`select array_to_string(array(select x from unnest(public.liberacoes_padrao($1::public.member_role)) x order by x), ',') l`, [papel]);
      igual(r.l, [...LIBERACOES_PADRAO[papel]].sort().join(','), `${papel}:`);
    }
    igual((await como(alice, () => um('select public.minhas_liberacoes($1) l', [orgA]))).l.includes('aprovar_rdo'), true);
    igual((await como(carol, () => um('select public.minhas_liberacoes($1) l', [orgA]))).l.includes('aprovar_rdo'), false);
  });
  await teste('Supervisora cria RDO de período (01 a 03/11) e de um dia; o banco numera e ignora situação enviada pelo aparelho', async () => {
    await como(carol, async () => {
      r1 = (await um(`insert into public.daily_reports (project_id, report_date, period_end, work_conditions, status, approved_label, responsible_label)
        values ($1, '2026-11-01', '2026-11-03', 'Execução normal', 'aprovado', 'falso', 'Carol') returning id`, [A1])).id;
      r2 = (await um(`insert into public.daily_reports (project_id, report_date) values ($1, '2026-11-04') returning id`, [A1])).id;
    });
    const a = await rdo(r1), b = await rdo(r2);
    igual(a.number, 1); igual(b.number, 2); igual(a.status, 'preenchendo', 'situação forçada:'); igual(a.approved_label, '', 'aprovação forjada:');
  });
  await teste('Períodos da mesma obra não se sobrepõem; fim antes do início é recusado', async () => {
    await recusa(() => como(carol, () => q(`insert into public.daily_reports (project_id, report_date, period_end) values ($1, '2026-11-03', '2026-11-05')`, [A1])), /cobre parte desse período/);
    await recusa(() => como(carol, () => q(`insert into public.daily_reports (project_id, report_date, period_end) values ($1, '2026-11-10', '2026-11-09')`, [A1])), /antes do início/);
  });
  await teste('Partes estruturadas: equipe terceirizada, atividade da EAP com quantidade e situação, ocorrência com horário e providência', async () => {
    await como(carol, async () => {
      await q(`insert into public.daily_report_crew (daily_report_id, project_id, role_name, qty, kind, company) values ($1, $2, 'Pedreiro', 3, 'terceirizada', 'Empreiteira X')`, [r1, A1]);
      await q(`insert into public.daily_report_activities (daily_report_id, project_id, activity_id, description, quantity, unit, situation) values ($1, $2, $3, 'Formas do bloco B', 42.5, 'm²', 'em_andamento')`, [r1, A1, at1]);
      await q(`insert into public.site_occurrences (daily_report_id, project_id, occurrence_type, description, occurred_at, actions, responsible) values ($1, $2, 'Impedimento', 'Chuva forte', '14:30', 'Serviço suspenso', 'Carol')`, [r1, A1]);
      await q(`update public.daily_reports set equipment_list = $2::jsonb, materials_list = $3::jsonb where id = $1`, [r1,
        JSON.stringify([{ nome: 'Betoneira', qtd: 1, horas: 6 }]), JSON.stringify([{ descricao: 'Cimento', qtd: 20, unidade: 'sc', fornecedor: 'Depósito', divergencia: '' }])]);
    });
    igual(Number((await um('select quantity from public.daily_report_activities where daily_report_id = $1', [r1])).quantity), 42.5);
    await recusa(() => como(carol, () => q(`insert into public.daily_report_crew (daily_report_id, project_id, role_name, kind) values ($1, $2, 'X', 'outro')`, [r1, A1])), /check constraint/);
  });
  await teste('Ninguém muda número, situação ou aprovação por UPDATE (nem o administrador)', async () => {
    await recusa(() => como(alice, () => q(`update public.daily_reports set status = 'aprovado' where id = $1`, [r1])), /ações do relatório/);
    await recusa(() => como(carol, () => q(`update public.daily_reports set number = 99 where id = $1`, [r1])), /ações do relatório/);
  });
  await teste('Mídias: foto e vídeo na pasta do relatório, link https; caminho de outro relatório e link http são recusados; cliente vê e não envia', async () => {
    await como(carol, async () => {
      await q(`insert into public.rdo_media (report_id, project_id, kind, storage_path, name, caption, phase_id, activity_id, size_bytes) values ($1, $2, 'foto', $3, 'forma.jpg', 'Formas do bloco B', $4, $5, 1000)`, [r1, A1, `${pasta(r1)}/forma.jpg`, etapa, at1]);
      await q(`insert into public.rdo_media (report_id, project_id, kind, storage_path, name, size_bytes) values ($1, $2, 'video', $3, 'giro.mp4', 2000)`, [r1, A1, `${pasta(r1)}/giro.mp4`]);
      await q(`insert into public.rdo_media (report_id, project_id, kind, url, name) values ($1, $2, 'link', 'https://youtu.be/abc', 'Vídeo da concretagem')`, [r1, A1]);
    });
    await recusa(() => como(carol, () => q(`insert into public.rdo_media (report_id, project_id, kind, storage_path, size_bytes) values ($1, $2, 'foto', $3, 1)`, [r1, A1, `${pasta(r2)}/x.jpg`])), /não corresponde/);
    await recusa(() => como(carol, () => q(`insert into public.rdo_media (report_id, project_id, kind, url) values ($1, $2, 'link', 'http://x.com')`, [r1, A1])), /check constraint/);
    igual((await como(dave, () => q('select id from public.rdo_media where report_id = $1', [r1]))).length, 3, 'cliente vê:');
    await recusa(() => como(dave, () => q(`insert into public.rdo_media (report_id, project_id, kind, url) values ($1, $2, 'link', 'https://x.com')`, [r1, A1])), /row-level security/);
    igual((await como(beto, () => q('select id from public.rdo_media'))).length, 0, 'outra empresa:');
  });
  await teste('Arquivos no Storage: pasta da obra lida pela equipe e pelo cliente; outra empresa não; cliente não grava', async () => {
    const f = `${pasta(r1)}/forma.jpg`;
    await como(carol, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [f]));
    igual((await como(dave, () => q('select 1 from storage.objects where name = $1', [f]))).length, 1, 'cliente lê:');
    igual((await como(beto, () => q('select 1 from storage.objects where name = $1', [f]))).length, 0, 'outra empresa:');
    await recusa(() => como(dave, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${pasta(r1)}/cli.jpg`])), /row-level security/);
    await recusa(() => como(beto, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${orgA}/obras/${A1}/capa/x.jpg`])), /row-level security/);
  });
  await teste('Envio para revisão com assinatura do responsável; cliente não envia; assinatura fora da pasta é recusada', async () => {
    await recusa(() => como(dave, () => q(`select public.rdo_acao($1, 'enviar')`, [r1])), /não pode preencher/);
    await recusa(() => como(carol, () => q(`select public.rdo_acao($1, 'enviar', '', $2)`, [r1, `${orgX}/obras/x/assinatura.png`])), /fora da pasta/);
    await como(carol, () => q(`select public.rdo_acao($1, 'enviar', 'Pronto para conferência', $2)`, [r1, `${pasta(r1)}/assinatura-carol.png`]));
    const a = await rdo(r1);
    igual(a.status, 'revisao'); igual(a.filled_signature_path, `${pasta(r1)}/assinatura-carol.png`);
  });
  await teste('Aprovação: supervisora (sem liberação) e financeiro não aprovam; administrador aprova com assinatura', async () => {
    await recusa(() => como(carol, () => q(`select public.rdo_acao($1, 'aprovar')`, [r1])), /liberação para aprovar/);
    await recusa(() => como(erin, () => q(`select public.rdo_acao($1, 'aprovar')`, [r1])), /liberação para aprovar/);
    await como(alice, () => q(`select public.rdo_acao($1, 'aprovar', '', $2)`, [r1, `${pasta(r1)}/assinatura-alice.png`]));
    const a = await rdo(r1);
    igual(a.status, 'aprovado'); igual(a.approved_label, 'Alice (admin A)'); igual(a.approved_signature_path, `${pasta(r1)}/assinatura-alice.png`);
  });
  await teste('Relatório aprovado fica travado: texto, equipe, atividades e mídias não mudam (nem pelo administrador)', async () => {
    await recusa(() => como(alice, () => q(`update public.daily_reports set notes = 'x' where id = $1`, [r1])), /está aprovado/);
    await recusa(() => como(carol, () => q(`insert into public.daily_report_crew (daily_report_id, project_id, role_name) values ($1, $2, 'Servente')`, [r1, A1])), /está aprovado/);
    await recusa(() => como(carol, () => q(`delete from public.daily_report_crew where daily_report_id = $1`, [r1])), /está aprovado/);
    await recusa(() => como(carol, () => q(`insert into public.rdo_media (report_id, project_id, kind, url) values ($1, $2, 'link', 'https://y.com')`, [r1, A1])), /aprovado/);
  });
  await teste('Reabrir exige liberação e motivo; desfaz a aprovação (fica no histórico); devolver só em revisão', async () => {
    await recusa(() => como(alice, () => q(`select public.rdo_acao($1, 'reabrir', 'x')`, [r1])), /motivo/);
    await recusa(() => como(carol, () => q(`select public.rdo_acao($1, 'reabrir', 'corrigir equipe')`, [r1])), /liberação/);
    await como(alice, () => q(`select public.rdo_acao($1, 'reabrir', 'Corrigir quantidade de pedreiros')`, [r1]));
    const a = await rdo(r1);
    igual(a.status, 'preenchendo'); igual(a.approved_label, ''); igual(a.review_note, 'Corrigir quantidade de pedreiros');
    await recusa(() => como(alice, () => q(`select public.rdo_acao($1, 'devolver', 'faltou foto')`, [r2])), /em revisão/);
    await como(carol, () => q(`select public.rdo_acao($1, 'enviar')`, [r2]));
    await como(alice, () => q(`select public.rdo_acao($1, 'devolver', 'Faltou a foto da concretagem')`, [r2]));
    igual((await rdo(r2)).status, 'devolvido');
    await como(carol, () => q(`delete from public.daily_report_crew where daily_report_id = $1`, [r1]));   // reaberto: volta a editar
  });
  await teste('Comentários: equipe comenta (autor gravado pelo banco); cliente não; comentário não é reescrito', async () => {
    await como(carol, () => q(`insert into public.rdo_comments (report_id, project_id, body, author_label) values ($1, $2, 'Choveu à tarde', 'forjado')`, [r1, A1]));
    igual((await um('select author_label from public.rdo_comments where report_id = $1', [r1])).author_label, 'Carol (supervisora A)');
    await recusa(() => como(dave, () => q(`insert into public.rdo_comments (report_id, project_id, body) values ($1, $2, 'oi')`, [r1, A1])), /row-level security/);
    await recusa(() => como(carol, () => q(`update public.rdo_comments set body = 'outro' where report_id = $1`, [r1])), /permission denied|não é editado/);
  });
  await teste('Histórico: criação, edições (sem repetir), envio, aprovação, reabertura e mídias, com autor; ninguém grava pela API', async () => {
    // outra pessoa edita duas vezes seguidas: um registro só de "edição" (as da autora logo após criar contam na criação)
    await como(alice, () => q(`update public.daily_reports set notes = 'Conferido em campo' where id = $1`, [r1]));
    await como(alice, () => q(`update public.daily_reports set notes = 'Conferido em campo.' where id = $1`, [r1]));
    const ev = await q('select kind, body, author_label from public.rdo_events where report_id = $1 order by id', [r1]);
    for (const k of ['criacao', 'edicao', 'envio', 'assinatura', 'aprovacao', 'reabertura', 'midia']) verdade(ev.some((e) => e.kind === k), `sem evento ${k}`);
    igual(ev.filter((e) => e.kind === 'edicao' && e.author_label === 'Alice (admin A)').length, 1, 'edições seguidas da mesma pessoa:');
    verdade(ev.every((e) => e.author_label), 'evento sem autor');
    await recusa(() => como(alice, () => q(`insert into public.rdo_events (report_id, project_id, kind, body) values ($1, $2, 'aprovacao', 'falso')`, [r1, A1])), /permission denied/);
  });
  await teste('Visualizações: cada pessoa conta uma vez (com o total de aberturas); outra empresa não registra', async () => {
    await como(dave, () => q('select public.rdo_visualizar($1)', [r1]));
    await como(dave, () => q('select public.rdo_visualizar($1)', [r1]));
    await como(alice, () => q('select public.rdo_visualizar($1)', [r1]));
    await como(beto, () => q('select public.rdo_visualizar($1)', [r1]));
    const v = await q('select user_label, views from public.rdo_views where report_id = $1 order by user_label', [r1]);
    igual(v.map((x) => `${x.user_label}:${x.views}`).join(), 'Alice (admin A):1,Dave (cliente da obra A1):2');
  });
  await teste('Logo da empresa: só o administrador grava (na pasta da empresa); membros leem; outra empresa não', async () => {
    const logo = `${orgA}/empresa/logo.png`;
    await como(alice, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [logo]));
    await recusa(() => como(carol, () => q(`insert into storage.objects (bucket_id, name) values ('documentos', $1)`, [`${orgA}/empresa/outra.png`])), /row-level security/);
    igual((await como(carol, () => q('select 1 from storage.objects where name = $1', [logo]))).length, 1, 'membro lê:');
    igual((await como(beto, () => q('select 1 from storage.objects where name = $1', [logo]))).length, 0, 'outra empresa:');
    await como(alice, () => q('update public.organizations set logo_path = $2 where id = $1', [orgA, logo]));
    await recusa(() => como(alice, () => q('update public.organizations set logo_path = $2 where id = $1', [orgA, `${orgX}/empresa/x.png`])), /check constraint/);
    await como(carol, () => q(`update public.organizations set logo_path = '' where id = $1`, [orgA]));
    igual((await um('select logo_path from public.organizations where id = $1', [orgA])).logo_path, logo, 'não-admin não altera:');
  });
}

/* ---------- 14. Medições por atividade e profissional ---------- */
async function testesMedicoes({ alice, carol, dave, erin, beto, orgA, A1, etapa, at1, at2 }) {
  grupo('14. Medições: profissionais, vínculos, boletim, produção ≤ executado, aprovação, valores e Financeiro');
  const CPF1 = '52998224725', CPF2 = '11144477735';
  let wA, wB, wC, ag1, s1, s2, s3, it1, it2, lA, lB;
  const st = async (id) => (await um('select status from public.measurement_sheets where id = $1', [id])).status;
  await teste('Supervisora cadastra profissionais (CPF validado, sem dados bancários); cliente e outra empresa não', async () => {
    await como(carol, async () => {
      wA = (await um(`insert into public.workers (org_id, name, doc_number, specialties) values ($1, 'João Pedreiro', $2, 'Pedreiro') returning id`, [orgA, CPF1])).id;
      wB = (await um(`insert into public.workers (org_id, name) values ($1, 'Pedro Ajudante') returning id`, [orgA])).id;
      wC = (await um(`insert into public.workers (org_id, kind, name, doc_number) values ($1, 'empresa', 'Formas Rápidas Ltda', '11222333000181') returning id`, [orgA])).id;
    });
    await recusa(() => como(carol, () => q(`insert into public.workers (org_id, name, doc_number) values ($1, 'X', '52998224726')`, [orgA])), /check constraint/);
    await recusa(() => como(carol, () => q(`insert into public.workers (org_id, name, doc_number) values ($1, 'Repetido', $2)`, [orgA, CPF1])), /duplicate|unique/);
    await recusa(() => como(dave, () => q(`insert into public.workers (org_id, name) values ($1, 'Pelo cliente')`, [orgA])), /row-level security/);
    igual((await como(beto, () => q('select id from public.workers'))).length, 0, 'outra empresa:');
    igual((await um(`select count(*)::int n from information_schema.columns where table_name = 'workers' and column_name ~ 'pix|banco|agencia|conta'`)).n, 0, 'colunas bancárias:');
  });
  await teste('Vínculos de remuneração: financeiro cadastra; supervisora não vê nem cria; vigências que se cruzam são recusadas', async () => {
    ag1 = (await como(erin, () => um(`insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, unit, unit_price, activity_ids, valid_from)
      values ($1, $2, $3, 'unidade', 'm²', 25, array[$4]::uuid[], '2026-10-01') returning id`, [orgA, wA, A1, at1]))).id;
    await como(erin, () => q(`insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, contract_amount, activity_ids, valid_from)
      values ($1, $2, $3, 'empreitada', 10000, array[$4]::uuid[], '2026-10-01')`, [orgA, wC, A1, at2]));
    igual((await como(carol, () => q('select id from public.worker_agreements'))).length, 0, 'supervisora vê valores:');
    await recusa(() => como(carol, () => q(`insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, unit, unit_price, valid_from) values ($1, $2, $3, 'unidade', 'm²', 1, '2026-10-01')`, [orgA, wB, A1])), /row-level security/);
    await recusa(() => como(erin, () => q(`insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, unit, unit_price, valid_from) values ($1, $2, $3, 'unidade', 'm²', 30, '2026-11-01')`, [orgA, wA, A1])), /se cruzam/);
    await recusa(() => como(erin, () => q(`insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, valid_from) values ($1, $2, $3, 'unidade', '2026-10-01')`, [orgA, wB, A1])), /check constraint/);
  });
  await teste('Boletim: número por obra; atividade de etapa recusada; produção acima do executado é recusada (decisão 1)', async () => {
    await como(carol, async () => {
      s1 = (await um(`insert into public.measurement_sheets (project_id, period_start, period_end, phase_id, status) values ($1, '2026-10-07', '2026-10-13', $2, 'aprovado') returning id, number`, [A1, etapa]));
      it1 = (await um(`insert into public.measurement_items (sheet_id, project_id, activity_id, unit, planned_qty, period_qty, criterion) values ($1, $2, $3, 'm²', 203, 50, 'm² de forma montada') returning id`, [s1.id, A1, at1])).id;
    });
    igual(s1.number, 1); igual(await st(s1.id), 'rascunho', 'situação forçada:'); s1 = s1.id;
    await recusa(() => como(carol, () => q(`insert into public.measurement_items (sheet_id, project_id, activity_id, period_qty) values ($1, $2, $3, 1)`, [s1, A1, etapa])), /último nível/);
    await como(carol, () => q(`insert into public.measurement_workers (item_id, sheet_id, project_id, worker_id, produced_qty) values ($1, $2, $3, $4, 30)`, [it1, s1, A1, wA]));
    await recusa(() => como(carol, () => q(`insert into public.measurement_workers (item_id, sheet_id, project_id, worker_id, produced_qty) values ($1, $2, $3, $4, 25)`, [it1, s1, A1, wB])), /passa do executado/);
    await como(carol, () => q(`insert into public.measurement_workers (item_id, sheet_id, project_id, worker_id, produced_qty, notes) values ($1, $2, $3, $4, 20, 'ajudou na forma')`, [it1, s1, A1, wB]));
    await recusa(() => como(carol, () => q(`update public.measurement_items set period_qty = 40 where id = $1`, [it1])), /passa do executado/);
  });
  await teste('A mesma atividade não entra em dois boletins de período que se cruza (sem medir duas vezes)', async () => {
    s2 = (await como(carol, () => um(`insert into public.measurement_sheets (project_id, period_start, period_end) values ($1, '2026-10-10', '2026-10-16') returning id`, [A1]))).id;
    await recusa(() => como(carol, () => q(`insert into public.measurement_items (sheet_id, project_id, activity_id, period_qty) values ($1, $2, $3, 5)`, [s2, A1, at1])), /outro boletim/);
    it2 = (await como(carol, () => um(`insert into public.measurement_items (sheet_id, project_id, activity_id, period_pct) values ($1, $2, $3, 20) returning id`, [s2, A1, at2]))).id;
    await como(carol, () => q(`insert into public.measurement_workers (item_id, sheet_id, project_id, worker_id, measure, produced_qty) values ($1, $2, $3, $4, 'percentual', 60)`, [it2, s2, A1, wC]));
  });
  await teste('Situação só pelas ações; supervisora envia mas não aprova; em conferência nada é editado por ela', async () => {
    await recusa(() => como(alice, () => q(`update public.measurement_sheets set status = 'aprovado' where id = $1`, [s1])), /ações do boletim/);
    await como(carol, () => q(`select public.medicao_acao($1, 'enviar')`, [s1]));
    igual(await st(s1), 'conferencia');
    await recusa(() => como(carol, () => q(`select public.medicao_acao($1, 'aprovar')`, [s1])), /liberação para aprovar/);
    await recusa(() => como(carol, () => q(`update public.measurement_items set notes = 'x' where id = $1`, [it1])), /não está em edição/);
    lB = (await um('select id from public.measurement_workers where item_id = $1 and worker_id = $2', [it1, wB])).id;
    await recusa(() => como(carol, () => q('update public.measurement_workers set approved_qty = 1 where id = $1', [lB])), /não está em edição|por quem aprova/);
  });
  await teste('Conferência: quem aprova ajusta a quantidade aprovada (sem mudar a produzida); devolver exige motivo', async () => {
    await como(alice, () => q('update public.measurement_workers set approved_qty = 18 where id = $1', [lB]));
    await recusa(() => como(alice, () => q('update public.measurement_workers set produced_qty = 1 where id = $1', [lB])), /não está em edição/);
    await recusa(() => como(alice, () => q(`select public.medicao_acao($1, 'devolver', 'x')`, [s1])), /motivo/);
  });
  await teste('Aprovação: avanço físico gravado (acumulado anterior + período, sem duplicar) e valores congelados por vínculo', async () => {
    const ant = await um(`select pct, qty_accum from public.activity_measurements where activity_id = $1 and deleted_at is null and ref_date < '2026-10-07' order by ref_date desc limit 1`, [at1]);
    const antQtd = ant ? (ant.qty_accum ?? Number(ant.pct) / 100 * 203) : 0;
    await como(alice, () => q(`select public.medicao_acao($1, 'aprovar', 'Conferido em campo')`, [s1]));
    igual(await st(s1), 'aprovado');
    const m = await um(`select method, qty_accum, pct, notes from public.activity_measurements where activity_id = $1 and ref_date = '2026-10-13' and deleted_at is null`, [at1]);
    igual(m.method, 'quantidade'); igual(Number(m.qty_accum), Math.round((antQtd + 50) * 10000) / 10000, 'acumulado:');
    verdade(/Boletim de medição nº 1/.test(m.notes), 'origem da medição');
    const it = await um('select previous_qty, accum_qty from public.measurement_items where id = $1', [it1]);
    igual(Math.round((Number(it.accum_qty) - Number(it.previous_qty)) * 10000) / 10000, 50, 'período:');
    const p = await q('select worker_id, pay_type, unit_price, quantity, amount from public.measurement_pay where sheet_id = $1 order by amount nulls last', [s1]);
    igual(p.map((x) => `${x.pay_type}:${x.quantity}:${x.amount}`).join(), 'unidade:30:750,sem_vinculo:18:null', 'valores:');
  });
  await teste('Supervisora não lê valores (vínculos nem valores a pagar); financeiro lê; cliente não vê boletins', async () => {
    igual((await como(carol, () => q('select id from public.measurement_pay'))).length, 0, 'supervisora:');
    igual((await como(erin, () => q('select id from public.measurement_pay where sheet_id = $1', [s1]))).length, 2, 'financeiro:');
    igual((await como(dave, () => q('select id from public.measurement_sheets'))).length, 0, 'cliente:');
    igual((await como(beto, () => q('select id from public.measurement_items'))).length, 0, 'outra empresa:');
  });
  await teste('Boletim aprovado travado; vínculo usado não muda de valor (encerra e cria outro); medições antigas preservadas', async () => {
    await recusa(() => como(alice, () => q(`update public.measurement_sheets set notes = 'x' where id = $1`, [s1])), /aprovado/);
    await recusa(() => como(erin, () => q('update public.worker_agreements set unit_price = 30 where id = $1', [ag1])), /já foi usado/);
    await como(erin, () => q(`update public.worker_agreements set valid_to = '2026-10-31' where id = $1`, [ag1]));
    await como(erin, () => q(`insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, unit, unit_price, activity_ids, valid_from) values ($1, $2, $3, 'unidade', 'm²', 28, array[$4]::uuid[], '2026-11-01')`, [orgA, wA, A1, at1]));
    igual(Number((await um('select amount from public.measurement_pay where sheet_id = $1 and worker_id = $2', [s1, wA])).amount), 750, 'valor antigo:');
  });
  await teste('Valor fixo por serviço: 60% de R$ 10.000 = R$ 6.000; passar de 100% no total é recusado; tipo de medida diferente do vínculo é recusado', async () => {
    await como(carol, () => q(`select public.medicao_acao($1, 'enviar')`, [s2]));
    await como(alice, () => q(`select public.medicao_acao($1, 'aprovar')`, [s2]));
    igual(Number((await um('select amount from public.measurement_pay where sheet_id = $1', [s2])).amount), 6000);
    s3 = (await como(carol, () => um(`insert into public.measurement_sheets (project_id, period_start, period_end) values ($1, '2026-10-20', '2026-10-26') returning id`, [A1]))).id;
    const it3 = (await como(carol, () => um(`insert into public.measurement_items (sheet_id, project_id, activity_id, period_pct) values ($1, $2, $3, 30) returning id`, [s3, A1, at2]))).id;
    await como(carol, () => q(`insert into public.measurement_workers (item_id, sheet_id, project_id, worker_id, measure, produced_qty) values ($1, $2, $3, $4, 'percentual', 50)`, [it3, s3, A1, wC]));
    await como(carol, () => q(`select public.medicao_acao($1, 'enviar')`, [s3]));
    await recusa(() => como(alice, () => q(`select public.medicao_acao($1, 'aprovar')`, [s3])), /passaria de 100%/);
    await como(alice, () => q(`select public.medicao_acao($1, 'devolver', 'Revisar o percentual da empreitada')`, [s3]));
    const l = (await um('select id from public.measurement_workers where sheet_id = $1', [s3])).id;
    await como(carol, () => q(`update public.measurement_workers set measure = 'dias', produced_qty = 3 where id = $1`, [l]));
    await como(carol, () => q(`select public.medicao_acao($1, 'enviar')`, [s3]));
    await recusa(() => como(alice, () => q(`select public.medicao_acao($1, 'aprovar')`, [s3])), /informada em "dias"/);
  });
  await teste('Lançar no Financeiro: só quem lança despesas; uma despesa por profissional; não duplica; "sem vínculo" não gera valor', async () => {
    await recusa(() => como(carol, () => q(`select public.medicao_lancar_despesas($1)`, [s1])), /não lança despesas/);
    igual((await como(erin, () => um(`select public.medicao_lancar_despesas($1) n`, [s1]))).n, 1);
    igual((await como(erin, () => um(`select public.medicao_lancar_despesas($1) n`, [s1]))).n, 0, 'repetir:');
    const d = await um(`select e.amount, e.category, e.supplier_name, e.document from public.expenses e join public.measurement_pay p on p.expense_id = e.id where p.sheet_id = $1`, [s1]);
    igual(Number(d.amount), 750); igual(d.category, 'Mão de obra'); igual(d.supplier_name, 'João Pedreiro'); igual(d.document, 'MED-0001');
  });
  await teste('Atividade sem quantidade prevista e sem %: produção paga pelo vínculo novo (R$ 28), avanço físico não é inventado', async () => {
    const s4 = (await como(carol, () => um(`insert into public.measurement_sheets (project_id, period_start, period_end) values ($1, '2026-11-01', '2026-11-07') returning id`, [A1]))).id;
    const i4 = (await como(carol, () => um(`insert into public.measurement_items (sheet_id, project_id, activity_id, unit, period_qty) values ($1, $2, $3, 'm', 10) returning id`, [s4, A1, at1]))).id;
    await como(carol, () => q(`insert into public.measurement_workers (item_id, sheet_id, project_id, worker_id, produced_qty) values ($1, $2, $3, $4, 10)`, [i4, s4, A1, wA]));
    await como(carol, () => q(`select public.medicao_acao($1, 'enviar')`, [s4]));
    await como(alice, () => q(`select public.medicao_acao($1, 'aprovar')`, [s4]));
    igual(Number((await um('select amount from public.measurement_pay where sheet_id = $1', [s4])).amount), 280, 'valor pelo vínculo vigente em 07/11:');
    igual((await q(`select 1 from public.activity_measurements where activity_id = $1 and ref_date = '2026-11-07' and deleted_at is null`, [at1])).length, 0, 'avanço inventado:');
  });
  await teste('Histórico do boletim com autor (envio, devolução, aprovação, Financeiro); ninguém grava pela API', async () => {
    const ev = await q('select kind, author_label from public.measurement_events where sheet_id in ($1, $2) order by id', [s1, s3]);
    for (const k of ['envio', 'aprovacao', 'financeiro', 'devolucao']) verdade(ev.some((e) => e.kind === k), `sem evento ${k}`);
    verdade(ev.every((e) => e.author_label), 'sem autor');
    await recusa(() => como(alice, () => q(`insert into public.measurement_events (sheet_id, project_id, kind, body) values ($1, $2, 'aprovacao', 'x')`, [s1, A1])), /permission denied/);
  });
}

/* ---------- 15. Integração de custos (Etapa 4) ---------- */
async function testesIntegracao({ alice, carol, erin, A1, etapa, at1 }) {
  grupo('15. Integração de custos: por fase, sem duplicidade, cancelados, medições a lançar (banco × app)');
  let etapa2, at3, itemC, k1, k2;
  const custos = () => um('select * from public.v_project_costs where project_id = $1', [A1]);
  // a obra como o app a vê, montada a partir das linhas do banco (mesmos dados, regras do app)
  const obraDoBanco = async () => como(alice, async () => {
    const nos = await q('select id, parent_id, code, description from public.wbs_nodes where project_id = $1 and deleted_at is null order by position, code', [A1]);
    const itens = await q('select id, total_cost from public.budget_items where project_id = $1 and deleted_at is null', [A1]);
    const vinc = await q('select budget_item_id, activity_id, share from public.budget_allocations where project_id = $1', [A1]);
    const ks = await q('select * from public.contracts where project_id = $1 and deleted_at is null', [A1]);
    const ads = await q('select * from public.contract_amendments where project_id = $1 and deleted_at is null', [A1]);
    const ds = await q('select * from public.expenses where project_id = $1 and deleted_at is null', [A1]);
    const pgs = await q('select * from public.payments where project_id = $1 and deleted_at is null', [A1]);
    const al = await q('select phase_id, period_end, amount from public.v_medicao_a_lancar where project_id = $1', [A1]);
    const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    return {
      total: new Map(itens.map((i) => [i.id, Number(i.total_cost)])),
      aLancar: al.map((m) => ({ faseId: m.phase_id, data: iso(m.period_end), valor: Number(m.amount) })),
      obra: {
        eap: nos.map((n) => ({ id: n.id, parentId: n.parent_id, codigo: n.code, descricao: n.description })),
        orcamento: itens.map((i) => ({ id: i.id })),
        vinculos: vinc.map((v) => ({ itemId: v.budget_item_id, atividadeId: v.activity_id, pct: Number(v.share) })),
        compromissos: ks.map((k) => ({ id: k.id, tipo: k.kind, valor: Number(k.amount), status: k.status, data: iso(k.contract_date), categoria: k.category,
          itemId: k.budget_item_id, faseId: k.phase_id, aditivos: ads.filter((a) => a.contract_id === k.id).map((a) => ({ data: iso(a.amend_date), valor: Number(a.amount) })) })),
        despesas: ds.map((d) => ({ id: d.id, data: iso(d.expense_date), valor: Number(d.amount), categoria: d.category, compromissoId: d.contract_id, itemId: d.budget_item_id, faseId: d.phase_id,
          pagamentos: pgs.filter((p) => p.expense_id === d.id).map((p) => ({ data: iso(p.pay_date), valor: Number(p.amount) })) })),
      },
    };
  });
  const confere = async (ate) => {
    const sql = await como(alice, () => q('select * from public.custos_por_fase($1, $2)', [A1, ate]));
    const B = await obraDoBanco();
    const app = custosPorFase(B.obra, { totalItem: (id) => B.total.get(id) || 0, ateDia: ate ? toDay(ate) : null, aLancar: B.aLancar });
    const campos = [['budget', 'orcado'], ['committed', 'comprometido'], ['incurred', 'incorrido'], ['paid', 'pago'], ['to_launch', 'aLancar']];
    for (const s of sql) {
      const a = app.fases.find((f) => f.id === s.phase_id);
      const vazio = campos.every(([k]) => Number(s[k]) === 0);
      if (!a) { verdade(vazio, `fase ${s.description} só no banco`); continue; }
      for (const [k, j] of campos) verdade(Math.abs(Number(s[k]) - a[j]) < 0.011, `${s.description} ${j}: banco ${s[k]} × app ${a[j]}`);
    }
    for (const a of app.fases) verdade(sql.some((s) => s.phase_id === a.id), `fase ${a.descricao} só no app`);
    return { sql, app, B };
  };

  await teste('Cenário: 2ª etapa, item repartido entre fases (20% sem vínculo), contrato com fase, pedido cancelado, despesas com e sem fase', async () => {
    await como(alice, async () => {
      etapa2 = (await um(`insert into public.wbs_nodes (project_id, code, level, description, position) values ($1, '2', 1, 'Estrutura', 50) returning id`, [A1])).id;
      at3 = (await um(`insert into public.wbs_nodes (project_id, parent_id, code, level, description) values ($1, $2, '2.1', 2, 'Pilares') returning id`, [A1, etapa2])).id;
      itemC = (await um(`insert into public.budget_items (project_id, code, description, unit, quantity, unit_cost) values ($1, 'O-3', 'Aço', 'kg', 1, 1000) returning id`, [A1])).id;
      await q(`insert into public.budget_allocations (project_id, budget_item_id, activity_id, share) values ($1, $2, $3, 0.5), ($1, $2, $4, 0.3)`, [A1, itemC, at1, at3]);
      k1 = (await um(`insert into public.contracts (project_id, kind, number, supplier_name, category, amount, status, phase_id) values ($1, 'Contrato', 'CT-9', 'Armador', 'Serviço terceirizado', 5000, 'Aprovado', $2) returning id`, [A1, at3])).id;
      const d1 = (await um(`insert into public.expenses (project_id, expense_date, document, supplier_name, category, contract_id, amount) values ($1, '2026-10-20', 'NF 9', 'Armador', 'Serviço terceirizado', $2, 1200) returning id`, [A1, k1])).id;
      await q(`insert into public.payments (expense_id, project_id, pay_date, amount) values ($1, $2, '2026-10-25', 1000)`, [d1, A1]);
      k2 = (await um(`insert into public.contracts (project_id, kind, number, supplier_name, category, amount, status, budget_item_id) values ($1, 'Pedido', 'PC-9', 'Aços SA', 'Material', 2000, 'Cancelado', $2) returning id`, [A1, itemC])).id;
      await q(`insert into public.expenses (project_id, expense_date, document, supplier_name, category, contract_id, amount) values ($1, '2026-10-21', 'NF 10', 'Aços SA', 'Material', $2, 300)`, [A1, k2]);
      await q(`insert into public.expenses (project_id, expense_date, document, supplier_name, category, amount, phase_id) values ($1, '2026-12-01', 'NF 11', 'Locadora', 'Equipamento', 800, $2)`, [A1, etapa]);
      await q(`insert into public.expenses (project_id, expense_date, document, supplier_name, category, amount) values ($1, '2026-10-22', 'RC 1', 'Diversos', 'Indireto', 100)`, [A1]);
    });
  });
  await teste('Pedido cancelado conta no comprometido só o que já foi incorrido nele (decisão 1)', async () => {
    const t = await como(alice, () => um('select total_amount, incurred, committed_amount from public.v_contract_totals where contract_id = $1', [k2]));
    igual(Number(t.total_amount), 2000); igual(Number(t.incurred), 300); igual(Number(t.committed_amount), 300);
  });
  await teste('Medições aprovadas e não lançadas entram no comprometido como "a lançar" (decisão 2; empreitada só pelo medido)', async () => {
    const r = await como(alice, custos);
    igual(Number(r.to_launch), 6280, 'a lançar (6.000 da empreitada medida + 280):');
  });
  await teste('Custos por fase: banco = app (orçado, comprometido, incorrido, pago, a lançar), "Sem fase" sem estimativa', async () => {
    const { sql } = await confere(null);
    const f2 = sql.find((s) => s.phase_id === etapa2), sf = sql.find((s) => s.phase_id == null);
    igual(Number(f2.budget), 300, 'orçado da Estrutura (30% do aço):');
    igual(Number(f2.committed), 5000 + 90, 'comprometido da Estrutura (contrato pela fase + 30% do cancelado):');
    igual(Number(f2.incurred), 1200 + 90, 'incorrido da Estrutura:'); igual(Number(f2.paid), 1000, 'pago da Estrutura:');
    verdade(sf && Number(sf.budget) === 200 && Number(sf.incurred) >= 160, `Sem fase (20% do aço sem vínculo; RC 1 + 20% do cancelado): ${JSON.stringify(sf)}`);
  });
  await teste('Totais por fase = totais da obra (view) = resumo do app', async () => {
    const { sql, app, B } = await confere(null);
    const r = await como(alice, custos);
    const soma = (k) => sql.reduce((s, x) => s + Number(x[k]), 0);
    for (const k of ['committed', 'incurred', 'paid', 'to_launch']) verdade(Math.abs(soma(k) - Number(r[k])) < 0.05, `${k}: fases ${soma(k)} × obra ${r[k]}`);
    const res = resumoCustos(B.obra, { aLancar: B.aLancar });
    verdade(Math.abs(res.comprometido - Number(r.committed)) < 0.005, `comprometido app ${res.comprometido} × banco ${r.committed}`);
    verdade(Math.abs(res.aIncorrer - Number(r.to_incur)) < 0.005, `a incorrer app ${res.aIncorrer} × banco ${r.to_incur}`);
    igual(Math.round(app.totais.incorrido * 100) / 100, Number(r.incurred), 'incorrido:');
  });
  await teste('Data de corte: despesa posterior fica fora (banco = app)', async () => {
    const { sql } = await confere('2026-11-15');
    igual(Number(sql.find((s) => s.phase_id === etapa).incurred) < Number((await confere(null)).sql.find((s) => s.phase_id === etapa).incurred), true, 'corte não aplicado:');
  });
  await teste('Lançar a medição: despesa por profissional e fase, já com a fase; sai do "a lançar" sem mudar o comprometido', async () => {
    const antes = await como(alice, custos);
    const s2 = (await um(`select s.id from public.measurement_sheets s join public.measurement_items i on i.sheet_id = s.id where s.project_id = $1 and s.status = 'aprovado' and i.period_pct = 20`, [A1])).id;
    igual((await como(erin, () => um('select public.medicao_lancar_despesas($1) n', [s2]))).n, 1);
    const d = await um('select e.phase_id, e.amount, e.description from public.expenses e join public.measurement_pay p on p.expense_id = e.id where p.sheet_id = $1', [s2]);
    igual(d.phase_id, etapa, 'fase da despesa:'); igual(Number(d.amount), 6000); verdade(/Fundação/.test(d.description), d.description);
    const depois = await como(alice, custos);
    igual(Number(depois.to_launch), 280, 'a lançar:');
    igual(Number(depois.committed), Number(antes.committed), 'comprometido mudou:');
    igual(Number(depois.incurred), Number(antes.incurred) + 6000, 'incorrido:');
    await confere(null);
  });
  await teste('Supervisora não vê valores pelos custos por fase; fase de outra obra/inexistente na despesa é recusada', async () => {
    const r = await como(carol, () => q('select * from public.custos_por_fase($1)', [A1]));
    verdade(r.every((x) => Number(x.incurred) === 0 && Number(x.paid) === 0 && Number(x.to_launch) === 0), 'supervisora viu valores');
    await recusa(() => como(alice, () => q(`insert into public.expenses (project_id, expense_date, supplier_name, amount, phase_id) values ($1, '2026-10-30', 'X', 1, $2)`, [A1, crypto.randomUUID()])), /foreign key|violates/);
  });
}

/* ---------- 17. Leitura de projeto com IA (registro, permissão, pasta da obra, limite mensal) ---------- */
async function testesLeitura({ alice, bob, carol, dave, orgA, A1, B1 }) {
  grupo('17. Leitura de projeto com IA: só quem monta a EAP, só PDFs da pasta da obra, limite mensal, resultado só por quem iniciou');
  const pdf = (n = 'projeto.pdf', obra = A1, org = orgA) => ({ path: `${org}/obras/${obra}/${crypto.randomUUID()}-${n}`, name: n, size: 1000 });
  const iniciar = (u, files, obra = A1) => como(u, () => um('select public.ia_iniciar_leitura($1, $2::jsonb) id', [obra, JSON.stringify(files)]));
  let l1;
  await teste('Admin/engenheiro inicia; supervisora e cliente não; anônimo não executa', async () => {
    l1 = (await iniciar(alice, [pdf()])).id;
    verdade(!!l1, 'sem id');
    await recusa(() => iniciar(carol, [pdf()]), /não monta a EAP/);
    await recusa(() => iniciar(dave, [pdf()]), /não monta a EAP/);
    await recusa(() => anonimo(() => q('select public.ia_iniciar_leitura($1, $2::jsonb)', [A1, JSON.stringify([pdf()])])), /permission denied/);
  });
  await teste('Arquivos: só PDF, só da pasta desta obra, de 1 a 10', async () => {
    await recusa(() => iniciar(alice, [{ ...pdf(), path: `${orgA}/obras/${B1}/x.pdf` }]), /fora da pasta/);
    await recusa(() => iniciar(alice, [{ ...pdf(), path: pdf().path.replace('.pdf', '.dwg') }]), /fora da pasta|não é PDF/);
    await recusa(() => iniciar(alice, []), /1 a 10/);
    await recusa(() => iniciar(alice, Array.from({ length: 11 }, () => pdf())), /1 a 10/);
    await recusa(() => iniciar(bob, [pdf('x.pdf', B1, orgA)], B1), /fora da pasta|não monta a EAP/);
    await recusa(() => iniciar(bob, [pdf()]), /não monta a EAP/);   // outra empresa não usa a obra A1
  });
  await teste('Limite mensal por empresa (plano): ao atingir, recusa; leituras com erro não contam', async () => {
    const plano = (await um('select plan_id from public.subscriptions where org_id = $1', [orgA])).plan_id;
    const antes = (await um('select features from public.plans where id = $1', [plano])).features;
    try {
      await q(`update public.plans set features = features || '{"leituras_ia_mes": 2}'::jsonb where id = $1`, [plano]);
      const l2 = (await iniciar(alice, [pdf()])).id;
      await recusa(() => iniciar(alice, [pdf()]), /Limite de 2 leituras/);
      await como(alice, () => q(`select public.ia_concluir_leitura($1, 'erro', null, 'falhou', 'x', 0, 0)`, [l2]));
      verdade(!!(await iniciar(alice, [pdf()])).id, 'leitura com erro não deveria contar');
      const u = await como(alice, () => um('select public.ia_uso_obra($1) r', [A1]));
      igual(u.r.uso, 2); igual(u.r.limite, 2);
    } finally { await q('update public.plans set features = $2::jsonb where id = $1', [plano, JSON.stringify(antes)]); }
  });
  await teste('Resultado: só quem iniciou grava, uma vez; tabela sem escrita direta; outra empresa não vê', async () => {
    await recusa(() => como(bob, () => q(`select public.ia_concluir_leitura($1, 'concluida', '{}'::jsonb, '', 'x', 1, 1)`, [l1])), /não encontrada/);
    await como(alice, () => q(`select public.ia_concluir_leitura($1, 'concluida', $2::jsonb, '', 'claude-opus-5-5', 1000, 200)`, [l1, JSON.stringify({ resumo: 'ok', etapas: [] })]));
    await recusa(() => como(alice, () => q(`select public.ia_concluir_leitura($1, 'concluida', '{}'::jsonb, '', 'x', 1, 1)`, [l1])), /já concluída/);
    const r = await como(carol, () => um('select status, result, input_tokens from public.project_ai_reads where id = $1', [l1]));
    igual(r.status, 'concluida'); igual(r.result.resumo, 'ok'); igual(r.input_tokens, 1000);
    igual((await como(bob, () => q('select id from public.project_ai_reads'))).length, 0, 'outra empresa:');
    igual((await como(bob, () => um('select public.ia_uso_obra($1) r', [A1]))).r, null, 'uso de outra empresa:');
    await recusa(() => como(alice, () => q(`insert into public.project_ai_reads (org_id, project_id) values ($1, $2)`, [orgA, A1])), /permission denied|row-level security/);
    await recusa(() => como(alice, () => q(`update public.project_ai_reads set status = 'aplicada' where id = $1`, [l1])), /permission denied|row-level security/);
  });
  await teste('Marcar como aplicada: só quem monta a EAP; histórico na auditoria', async () => {
    await recusa(() => como(carol, () => q('select public.ia_marcar_aplicada($1)', [l1])), /não monta a EAP/);
    await como(alice, () => q('select public.ia_marcar_aplicada($1)', [l1]));
    igual((await um('select status from public.project_ai_reads where id = $1', [l1])).status, 'aplicada');
    verdade((await q(`select 1 from public.audit_log where table_name = 'project_ai_reads' and row_id = $1`, [l1])).length >= 3, 'auditoria');
  });
}

/* ---------- 18. Bases de referência (SINAPI pública e bases da empresa) ---------- */
async function testesBases({ alice, bob, carol, dave, mallory, orgA, orgB }) {
  grupo('18. Bases de referência: SINAPI só a plataforma grava; base da empresa só a empresa vê; publicada não muda');
  const zelia = (await um(`insert into auth.users (email, raw_user_meta_data) values ('zelia@geplan.test', '{"full_name":"Zélia (plataforma)"}') returning id, email`));
  await q('update public.user_profiles set is_platform_admin = true where id = $1', [zelia.id]);
  const custos = JSON.stringify({ nao_desonerado: { SP: 100, MG: 90 }, desonerado: { SP: 95 } });
  const novaBase = (u, org, nome) => como(u, () => um(`insert into public.ref_bases (org_id, fonte, nome, mes) values ($1, 'SINAPI', $2, '2026-09-01') returning id`, [org, nome]));
  const comp = (u, base, cod, desc) => como(u, () => q(`insert into public.ref_composicoes (base_id, codigo, descricao, unidade, custos, busca) values ($1, $2, $3, 'M2', $4::jsonb, lower($2 || ' ' || $3))`, [base, cod, desc, custos]));
  let pub, emp;
  await teste('Base pública: só o administrador da plataforma cria e importa; empresas e anônimo não', async () => {
    await recusa(() => novaBase(alice, null, 'SINAPI 09/2026'), /row-level security|permission denied/);
    await recusa(() => anonimo(() => q(`insert into public.ref_bases (fonte, nome) values ('SINAPI', 'X')`)), /permission denied/);
    pub = (await novaBase(zelia, null, 'SINAPI 09/2026')).id;
    await comp(zelia, pub, '87503', 'alvenaria de vedacao de blocos ceramicos');
    await comp(zelia, pub, '87529', 'massa unica para recebimento de pintura');
    await como(zelia, () => q(`insert into public.ref_itens (base_id, composicao, posicao, tipo, codigo, descricao, unidade, coeficiente) values ($1, '87503', 1, 'C', '88309', 'PEDREIRO', 'H', 0.85)`, [pub]));
    await recusa(() => comp(alice, pub, '1', 'x'), /row-level security|permission denied/);
  });
  await teste('Importando: invisível para as empresas; publicada: todos leem; pesquisa por palavras sem ordem', async () => {
    igual((await como(alice, () => q('select id from public.ref_bases where id = $1', [pub]))).length, 0, 'importando visível:');
    igual((await como(alice, () => q('select codigo from public.ref_buscar($1, $2)', [pub, 'alvenaria']))).length, 0, 'pesquisa antes de publicar:');
    await recusa(() => como(alice, () => q('select public.ref_publicar_base($1)', [pub])), /Sem permissão/);
    const t = (await como(zelia, () => um('select public.ref_publicar_base($1) t', [pub]))).t;
    igual(t.composicoes, 2); igual(t.itens, 1);
    for (const u of [alice, carol, dave, bob, mallory]) igual((await como(u, () => q('select id from public.ref_bases where id = $1', [pub]))).length, 1, `${u.email} não lê:`);
    igual((await como(dave, () => q('select codigo from public.ref_buscar($1, $2)', [pub, 'ceramicos vedacao']))).map((x) => x.codigo).join(), '87503');
    igual((await como(alice, () => q('select codigo from public.ref_buscar($1, $2)', [pub, '87529']))).map((x) => x.codigo).join(), '87529');
    igual((await como(alice, () => q(`select custos -> 'nao_desonerado' ->> 'MG' v from public.ref_composicoes where base_id = $1 and codigo = '87503'`, [pub])))[0].v, '90');
  });
  await teste('Publicada não muda: nem a plataforma inclui itens; ninguém altera linhas; nome repetido recusado', async () => {
    await recusa(() => comp(zelia, pub, '99999', 'nova'), /row-level security/);
    await recusa(() => como(alice, () => q(`update public.ref_composicoes set descricao = 'x' where base_id = $1`, [pub])), /permission denied/);
    await recusa(() => como(zelia, () => q(`update public.ref_bases set nome = 'x' where id = $1`, [pub])), /permission denied/);
    await recusa(() => novaBase(zelia, null, 'SINAPI 09/2026'), /duplicate key|unique/);
    await recusa(() => como(zelia, () => q('select public.ref_publicar_base($1)', [pub])), /já foi publicada|Sem permissão/);
  });
  await teste('Base da empresa: admin/engenheiro da empresa criam; só a própria empresa vê; supervisora não grava', async () => {
    emp = (await novaBase(alice, orgA, 'TCPO 15')).id;
    await comp(alice, emp, 'T-01', 'alvenaria tcpo');
    await recusa(() => comp(carol, emp, 'T-02', 'x'), /row-level security/);
    await recusa(() => novaBase(bob, orgA, 'Invasão'), /row-level security/);
    await como(alice, () => q('select public.ref_publicar_base($1)', [emp]));
    igual((await como(carol, () => q('select id from public.ref_bases where id = $1', [emp]))).length, 1, 'membro não lê:');
    for (const u of [bob, mallory]) {
      igual((await como(u, () => q('select id from public.ref_bases where id = $1', [emp]))).length, 0, `${u.email} vê base de outra empresa:`);
      igual((await como(u, () => q('select codigo from public.ref_composicoes where base_id = $1', [emp]))).length, 0, `${u.email} vê composições:`);
      igual((await como(u, () => q('select codigo from public.ref_buscar($1, $2)', [emp, 'alvenaria']))).length, 0, `${u.email} pesquisa:`);
    }
  });
  await teste('Retirar versão: a empresa retira a sua; não retira a pública nem a de outra empresa', async () => {
    await como(alice, () => q('delete from public.ref_bases where id = $1', [pub]));
    igual((await um('select count(*)::int n from public.ref_bases where id = $1', [pub])).n, 1, 'empresa apagou a base pública:');
    await como(bob, () => q('delete from public.ref_bases where id = $1', [emp]));
    igual((await um('select count(*)::int n from public.ref_bases where id = $1', [emp])).n, 1, 'outra empresa apagou:');
    await como(alice, () => q('delete from public.ref_bases where id = $1', [emp]));
    igual((await um('select count(*)::int n from public.ref_composicoes where base_id = $1', [emp])).n, 0, 'composições ficaram:');
  });
  await teste('Robô mensal (chave de serviço) cria, importa e publica a base pública; usuário comum não se passa por ele', async () => {
    await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false); set role service_role;`);
    let id;
    try {
      id = (await um(`insert into public.ref_bases (fonte, nome, mes) values ('SINAPI', 'SINAPI 10/2026', '2026-10-01') returning id`)).id;
      await q(`insert into public.ref_composicoes (base_id, codigo, descricao, busca) values ($1, '87503', 'alvenaria', '87503 alvenaria')`, [id]);
      igual((await um('select public.ref_publicar_base($1) t', [id])).t.composicoes, 1);
    } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`); }
    igual((await como(alice, () => q('select id from public.ref_bases where id = $1', [id]))).length, 1, 'empresa não vê a base do robô:');
    igual((await como(alice, () => um('select public.eh_servico() v'))).v, false, 'usuário passou por serviço:');
    await q('delete from public.ref_bases where id = $1', [id]);
  });
  await teste('Referência padrão da empresa (UF e regime): só o administrador define, com valores válidos', async () => {
    await como(alice, () => q(`select public.definir_referencia_org($1, 'mg', 'desonerado')`, [orgA]));
    const o = await um('select ref_uf, ref_regime from public.organizations where id = $1', [orgA]);
    igual(`${o.ref_uf}/${o.ref_regime}`, 'MG/desonerado');
    await recusa(() => como(carol, () => q(`select public.definir_referencia_org($1, 'SP', 'desonerado')`, [orgA])), /administrador/);
    await recusa(() => como(bob, () => q(`select public.definir_referencia_org($1, 'SP', 'desonerado')`, [orgA])), /administrador/);
    await recusa(() => como(alice, () => q(`select public.definir_referencia_org($1, 'SP', 'meio')`, [orgA])), /check|violates/);
  });
}

/* ---------- 16. Auditoria geral de segurança (as mesmas consultas rodadas no banco real) ---------- */
async function testesSeguranca({ bob, orgA, mallory, A1 }) {
  grupo('16. Auditoria geral de segurança do banco (todas as tabelas, views, funções e Storage)');
  await teste('Permissões de quem não tem vínculo com a obra são FALSO (não nulo) — nulo deixaria passar dentro das funções', async () => {
    const r = await como(mallory, () => um(`select
      public.can_read_project($1) r1, public.can_read_costs($1) r2, public.can_write_project($1, 'cadastro') w1, public.can_write_project($1, 'planejamento') w2,
      public.can_write_project($1, 'execucao') w3, public.can_write_project($1, 'financeiro') w4, public.can_write_project($1, 'compras') w5,
      public.pode_solicitar($1) p1, public.pode_comprar($1) p2, public.pode_receber($1) p3, public.pode_aprovar_rdo($1) p4,
      public.pode_aprovar_medicao($1) p5, public.ve_valores_mo($1) p6`, [A1]));
    const nulos = Object.entries(r).filter(([, v]) => v !== false).map(([k, v]) => `${k}=${v}`);
    // varredura: toda função booleana de um parâmetro uuid (obra ou empresa) responde falso para quem não é de lugar nenhum
    const fns = (await q(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'bool'::regtype
      and p.pronargs = 1 and p.proargtypes[0] = 'uuid'::regtype and p.proname <> 'org_subscription_ok' order by 1`)).map((x) => x.proname);   // assinatura da empresa não é permissão da pessoa
    const ruins = [];
    for (const f of fns) for (const arg of [A1, orgA]) {
      const v = (await como(mallory, () => um(`select public.${f}($1) v`, [arg]))).v;
      if (v !== false) ruins.push(`${f}(${arg === A1 ? 'obra' : 'empresa'})=${v}`);
    }
    igual([...nulos, ...ruins].join(', '), '', 'funções que não devolvem falso:');
    igual((await como(mallory, () => um(`select public.tem_liberacao($1, 'comprar') v`, [orgA]))).v, false, 'tem_liberacao:');
  });
  await teste('Pessoa sem empresa não lança medição no Financeiro nem inicia leitura de projeto da obra de outra empresa', async () => {
    const s = await um(`select s.id from public.measurement_sheets s where s.project_id = $1 and s.status = 'aprovado'
      and exists (select 1 from public.measurement_pay p where p.sheet_id = s.id and p.expense_id is null and coalesce(p.amount, 0) > 0) limit 1`, [A1]);
    verdade(!!s, 'cenário: falta boletim aprovado com valor a lançar');
    await recusa(() => como(mallory, () => q('select public.medicao_lancar_despesas($1)', [s.id])), /não lança despesas/);
    await recusa(() => como(mallory, () => q('select public.ia_iniciar_leitura($1, $2::jsonb)', [A1, JSON.stringify([{ path: `${orgA}/obras/${A1}/x.pdf`, name: 'x.pdf' }])])), /não monta a EAP/);
  });
  await teste('Toda tabela tem RLS e pelo menos uma política; anon não tem acesso a tabela/view nenhuma', async () => {
    igual((await um(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n, 0, 'sem RLS:');
    const semPol = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)`);
    igual(semPol.map((x) => x.relname).join(), '', 'sem política:');
    igual((await um(`select count(*)::int n from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`)).n, 0, 'anon:');
  });
  await teste('Views com security_invoker; funções SECURITY DEFINER com search_path fixo', async () => {
    igual((await q(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' and not coalesce(reloptions::text like '%security_invoker=true%', false)`)).map((x) => x.relname).join(), '', 'views:');
    igual((await q(`select proname from pg_proc p where pronamespace = 'public'::regnamespace and prosecdef and not exists (select 1 from unnest(coalesce(proconfig, '{}')) x where x like 'search_path=%')`)).map((x) => x.proname).join(), '', 'search_path:');
  });
  await teste('Nenhuma função que grava (SECURITY DEFINER volátil) pode ser chamada sem login', async () => {
    const r = await q(`select proname from pg_proc p where pronamespace = 'public'::regnamespace and prokind = 'f' and prorettype <> 'trigger'::regtype
      and prosecdef and provolatile = 'v' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
    igual(r.map((x) => x.proname).join(), '', 'executáveis por anon:');
  });
  await teste('Categorias padrão: outra empresa e anônimo não recriam categorias da empresa A; empresa nova continua recebendo as 14', async () => {
    await recusa(() => anonimo(() => q('select public.default_supplier_categories($1)', [orgA])), /permission denied/);
    await recusa(() => como(bob, () => q('select public.default_supplier_categories($1)', [orgA])), /permission denied/);
    const nova = (await como(bob, () => um(`select public.create_organization('Construtora Teste Categorias', 'profissional') id`))).id;
    igual((await um('select count(*)::int n from public.supplier_categories where org_id = $1', [nova])).n, 14);
  });
  await teste('Buckets do Storage são privados', async () => {
    const t = await um(`select to_regclass('storage.buckets') is not null ok`);
    if (!t.ok) return;
    igual((await um('select count(*)::int n from storage.buckets where public')).n, 0);
  });
}

/* ---------- 10. Sincronização app ↔ banco com a obra real da planilha ---------- */
async function testesSincronizacao({ novoUsuario, bob }) {
  grupo('10. Sincronização do app com o banco (obra real da planilha, ida e volta)');
  const { bancoPglite } = await import('./banco_pglite.js');
  const { enviarObra, enviarBiblioteca, baixarEmpresa } = await import('../js/nuvem/sincronizar.js');
  const { obraParaLinhas, bibliotecaParaLinhas, converterIds, TABELAS_OBRA } = await import('../js/nuvem/mapa.js');
  const { interpretar, criarObraImportada } = await import('../js/importador.js');
  const { emptyLib, registrar, uid } = await import('../js/model.js');
  const { calcular } = await import('../js/calculo.js');
  const { cronograma } = await import('../js/cpm.js');
  const { registrarMedicao, salvarDiario, novoDiario, quantidadePlanejada } = await import('../js/execucao.js');
  const { snapshotOrcamento } = await import('../js/financeiro.js');
  const { LIBS, loadScript } = await import('../js/libs.js');

  const ordenado = (r) => JSON.stringify(r, Object.keys(r).sort());
  /** Compara as linhas de duas versões, tabela a tabela (conjuntos, sem depender da ordem). */
  function mesmasLinhas(A, B, tabelas) {
    for (const t of tabelas) {
      const a = (A[t] || []).map(ordenado).sort(), b = (B[t] || []).map(ordenado).sort();
      if (a.length !== b.length) throw new Error(`${t}: ${a.length} linhas enviadas × ${b.length} no banco`);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${t}: linha diferente\n enviada ${a[i].slice(0, 400)}\n banco   ${b[i].slice(0, 400)}`);
    }
  }

  let buf = null;
  for (const n of ['../docs/modelo_orcamento_cronograma.xlsx', '../docs/modelo_orcamento_cronograma.xlsx.xlsx']) {
    try { const r = await fetch(n); if (r.ok) { buf = await r.arrayBuffer(); break; } } catch {}
  }
  if (!buf) { await teste('Planilha não encontrada em docs/ — grupo 10 não executado', () => { throw new Error('sem planilha'); }); return; }

  const ana = await novoUsuario('ana@c.com', 'Ana (admin C)');
  const sup = await novoUsuario('sergio@c.com', 'Sérgio (supervisor C)');
  const banco = bancoPglite(db, ana);
  let lib, obra, orgC, baixado;

  await teste('Monta a obra pela planilha + medições, diário, contrato, despesa, revisão, linha de base e feriado', async () => {
    await loadScript(LIBS.xlsx);
    const d = interpretar(window.XLSX.read(buf, { type: 'array' }));
    lib = emptyLib();
    obra = criarObraImportada(d, { nome: 'Obra da planilha', inicio: '2026-09-01' }, lib).obra;
    const calc = calcular(obra, lib);
    const folhas = obra.eap.filter((a) => !obra.eap.some((x) => x.parentId === a.id));
    const semQtd = folhas.find((a) => !quantidadePlanejada(calc, a.id)?.qtd);
    registrarMedicao(obra, calc, { atividadeId: semQtd.id, data: '2026-09-03', pct: 40, responsavel: 'teste' });
    registrarMedicao(obra, calc, { atividadeId: semQtd.id, data: '2026-09-05', pct: 100, responsavel: 'teste' });
    const comQtd = folhas.find((a) => quantidadePlanejada(calc, a.id)?.qtd);
    const plan = quantidadePlanejada(calc, comQtd.id);
    registrarMedicao(obra, calc, { atividadeId: comQtd.id, data: '2026-09-10', qtdAcum: plan.qtd / 3, responsavel: 'teste' });
    salvarDiario(obra, { ...novoDiario('2026-09-03', 'teste'), equipe: [{ funcao: 'Pedreiro', qtd: 3 }], servicos: [{ atividadeId: semQtd.id, descricao: 'serviço' }],
      ocorrencias: [{ id: uid(), tipo: 'Impedimento', descricao: 'Chuva forte', resolvida: false }], materiais: 'Cimento' });
    obra.compromissos.push({ id: uid(), tipo: 'Contrato', numero: 'CT-9', fornecedor: 'Fornecedor', categoria: 'Serviço terceirizado', valor: 5000,
      status: 'Aprovado', data: '2026-09-01', objeto: 'Terraplenagem', itemId: obra.orcamento[0].id, aditivos: [{ data: '2026-09-10', valor: 500, descricao: 'Aditivo' }] });
    obra.compromissos.push({ id: uid(), tipo: 'Pedido de compra', numero: 'PC-1', fornecedor: 'Loja', categoria: 'Material', valor: 800, status: 'Em cotação', data: '2026-09-02',
      objeto: 'Areia', itemId: null, aditivos: [], dataNecessaria: '2026-09-08', quantidade: 10, unidade: 'm³', quantidadeRecebida: 4 });
    obra.despesas.push({ id: uid(), data: '2026-09-15', documento: 'NF 10', fornecedor: 'Fornecedor', descricao: '1ª medição', categoria: 'Serviço terceirizado',
      compromissoId: obra.compromissos[0].id, itemId: null, valor: 2000, vencimento: '2026-09-30', pagamentos: [{ data: '2026-09-20', valor: 1500 }] });
    obra.despesas.push({ id: uid(), data: '2026-09-16', documento: 'R 1', fornecedor: 'Diarista', descricao: 'Limpeza', categoria: 'Mão de obra',
      compromissoId: null, itemId: null, valor: 350.5, vencimento: '', pagamentos: [] });
    obra.revisoesOrcamento.unshift(snapshotOrcamento(obra, lib, 'R0'));
    const cron = cronograma(obra, lib, calcular(obra, lib));
    obra.linhaBase = { data: '2026-09-01', itens: Object.fromEntries([...cron.nos.values()].map((n) => [n.id, { inicio: n.inicio, termino: n.termino }])), termino: cron.termino, custo: 224306, revisao: 0 };
    obra.calendario.feriados.push({ data: '2026-10-12', desc: 'Nossa Senhora Aparecida' });
    Object.assign(obra.cliente, { nome: 'Cliente teste', telefone: '(11) 0000-0000' });
    Object.assign(obra, { codigo: 'OB-9', status: 'Em execução', valorContratado: 300000, bdi: { ac: 4, s: 0.4, r: 1.27, g: 0.4, df: 1.23, l: 7.4, i: 8.65 } });
    registrar(obra, 'Obra montada para teste', 'grupo 10', 'teste');
    converterIds(lib, [obra]);
    verdade(obra.eap.length > 500 && lib.composicoes.length > 50, 'planilha incompleta');
  });

  await teste('Empresa nova envia a biblioteca e a obra inteira (primeira gravação)', async () => {
    orgC = await banco.rpc('create_organization', { p_name: 'Construtora C', p_plan: 'profissional' });
    const rb = await enviarBiblioteca(banco, lib, orgC, 'admin', null);
    const ro = await enviarObra(banco, obra, orgC, 'admin', null);
    verdade(rb.enviados > 100 && ro.enviados > 1000, `poucas linhas: ${rb.enviados} / ${ro.enviados}`);
    igual(ro.ignorados.length, 0, 'tabelas ignoradas:');
  });

  await teste('Baixa de volta: todas as linhas idênticas às enviadas (nada perdido)', async () => {
    baixado = await baixarEmpresa(banco, orgC, 'admin');
    igual(baixado.obras.length, 1, 'obras:');
    mesmasLinhas(bibliotecaParaLinhas(lib, orgC), bibliotecaParaLinhas(baixado.lib, orgC), ['cost_compositions', 'composition_items', 'org_holidays', 'wbs_templates']);
    mesmasLinhas(obraParaLinhas(obra, orgC), obraParaLinhas(baixado.obras[0], orgC), TABELAS_OBRA);
  });

  await teste('Cronograma, HH e custos recalculados a partir do banco = calculados no aparelho', async () => {
    const o2 = baixado.obras[0], l2 = baixado.lib;
    const c1 = calcular(obra, lib), c2 = calcular(o2, l2);
    const k1 = cronograma(obra, lib, c1), k2 = cronograma(o2, l2, c2);
    igual(k2.termino, k1.termino, 'término:'); igual(k2.durTotal, k1.durTotal, 'prazo:');
    igual(Math.round(c2.totalHH * 1000), Math.round(c1.totalHH * 1000), 'HH:');
    igual(Math.round(c2.totalOrcamento * 100), Math.round(c1.totalOrcamento * 100), 'orçamento:');
    igual(Math.round(c2.totalAlocado * 100), Math.round(c1.totalAlocado * 100), 'alocado:');
    const crit = (k) => [...k.nos.values()].filter((n) => n.critico).map((n) => n.id).sort().join();
    igual(crit(k2), crit(k1), 'caminho crítico:');
  });

  await teste('Totais calculados pelo banco (views) = totais do app', async () => {
    const o2 = baixado.obras[0];
    const vb = (await banco.selecionar('v_project_budget', { eq: { project_id: o2.id } }))[0];
    igual(Math.round(Number(vb.direct_cost) * 100), Math.round(calcular(o2, baixado.lib).totalOrcamento * 100), 'custo direto:');
    const vc = (await banco.selecionar('v_project_costs', { eq: { project_id: o2.id } }))[0];
    const app = resumoCustos(o2);
    igual(Number(vc.committed), app.comprometido, 'comprometido:'); igual(Number(vc.incurred), app.incorrido, 'incorrido:');
    igual(Number(vc.paid), app.pago, 'pago:'); igual(Number(vc.to_incur), app.aIncorrer, 'a incorrer:');
  });

  await teste('Sincronizar de novo sem mudanças não envia nada', async () => {
    const r = await enviarObra(banco, baixado.obras[0], orgC, 'admin', baixado.snaps[baixado.obras[0].id]);
    igual(r.enviados, 0);
  });

  await teste('Só as alterações são enviadas (item, dependência, despesa excluída, medição substituída)', async () => {
    const o2 = baixado.obras[0];
    o2.orcamento[0].quantidade += 1;
    o2.dependencias.splice(0, 1);
    o2.despesas = o2.despesas.filter((d) => d.documento !== 'R 1');
    const med = o2.medicoesAtiv.find((m) => m.data === '2026-09-05');
    registrarMedicao(o2, calcular(o2, baixado.lib), { atividadeId: med.atividadeId, data: '2026-09-05', pct: 90, responsavel: 'teste' });
    const r = await enviarObra(banco, o2, orgC, 'admin', baixado.snaps[o2.id]);
    verdade(r.enviados > 0 && r.enviados < 12, `enviou ${r.enviados} linhas`);
    const de = await baixarEmpresa(banco, orgC, 'admin');
    mesmasLinhas(obraParaLinhas(o2, orgC), obraParaLinhas(de.obras[0], orgC), TABELAS_OBRA);
    const ativ = de.obras[0].eap.find((a) => a.id === med.atividadeId);
    igual(ativ.pct, 90, '% sincronizado pelo servidor:'); igual(ativ.fimReal, '', 'término real removido:');
    baixado = de;
  });

  await teste('Supervisor: a medição é gravada; mudanças no planejamento não são enviadas (o servidor recusaria)', async () => {
    const inv = (await db.query(`insert into public.invitations (org_id, email, role, invited_by) values ($1, 'sergio@c.com', 'supervisor', $2) returning token`, [orgC, ana.id])).rows[0].token;
    const bSup = bancoPglite(db, sup);
    await bSup.rpc('accept_invitation', { p_token: inv });
    const o2 = baixado.obras[0];
    await banco.inserir('project_members', [{ project_id: o2.id, user_id: sup.id }]);
    const viaSup = await baixarEmpresa(bSup, orgC, 'supervisor');
    igual(viaSup.obras.length, 1, 'obra visível:');
    verdade(viaSup.lib.composicoes.length > 0, 'supervisor precisa das composições para calcular as durações');
    const o3 = viaSup.obras[0];
    o3.eap.find((a) => a.nivel === 1).descricao = 'Alterado pelo supervisor';
    const folha = o3.eap.find((a) => !o3.eap.some((x) => x.parentId === a.id) && !o3.medicoesAtiv.some((m) => m.atividadeId === a.id));
    o3.medicoesAtiv.push({ id: uid(), atividadeId: folha.id, data: '2026-09-20', metodo: 'percentual', qtdAcum: null, unidade: '', qtdPlanejada: null, pct: 25, obs: '', responsavel: 'Sérgio', criadoEm: new Date().toISOString() });
    const r = await enviarObra(bSup, o3, orgC, 'supervisor', viaSup.snaps[o3.id]);
    verdade(r.ignorados.includes('wbs_nodes'), 'deveria ignorar o planejamento');
    const de = await baixarEmpresa(banco, orgC, 'admin');
    verdade(de.obras[0].medicoesAtiv.some((m) => m.atividadeId === folha.id && m.pct === 25), 'medição do supervisor não gravada');
    igual(de.obras[0].eap.find((a) => a.id === folha.id).pct, 25, '% atualizado pelo servidor:');
    verdade(!de.obras[0].eap.some((a) => a.descricao === 'Alterado pelo supervisor'), 'planejamento alterado indevidamente');
  });

  await teste('Usuário de outra empresa não baixa nada desta empresa', async () => {
    const r = await baixarEmpresa(bancoPglite(db, bob), orgC, 'admin');
    igual(r.obras.length, 0, 'obras:'); igual(r.lib.composicoes.length, 0, 'composições:');
  });
}

const r = document.getElementById('resumo');
r.className = fail ? 'err' : 'ok';
r.textContent = `${ok} passaram · ${fail} falharam`;
window.__resultado = { ok, fail };
