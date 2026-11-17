-- GEPLAN · 0019 · Financeiro da EMPRESA (separado dos custos de cada obra, que ficam com a engenharia).
-- Base: regime tributário da empresa, plano de contas em árvore com "De/Para" contábil, centros de custo (Matriz +
-- um por obra, criados sozinhos), contas bancárias. Lançamentos: contas a pagar e a receber da empresa, com RATEIO
-- entre centros de custo (soma 100%) e BAIXAS (pagamento/recebimento) com conta bancária, forma e quem pagou.
-- Quem vê: administrador, financeiro e contador. Quem grava: administrador e financeiro. Engenheiro NÃO vê
-- (decisão da empresa, nov/2026). Somente acréscimos; RLS e auditoria em todas as tabelas novas.

-- ---------------------------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------------------------
create or replace function public.ve_fin_empresa(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org)::text in ('admin', 'financeiro', 'contador'), false)
$$;
create or replace function public.grava_fin_empresa(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org)::text in ('admin', 'financeiro') and public.org_subscription_ok(p_org), false)
$$;

-- ---------------------------------------------------------------------------------------------
-- Regime tributário da empresa (Simples Nacional, Lucro Presumido ou Real)
-- ---------------------------------------------------------------------------------------------
alter table public.organizations add column if not exists tax_regime text not null default ''
  check (tax_regime in ('', 'simples', 'presumido', 'real'));

create or replace function public.definir_regime_tributario(p_org uuid, p_regime text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_admin(p_org) then raise exception 'Só o administrador define o regime tributário.' using errcode = '42501'; end if;
  if p_regime not in ('', 'simples', 'presumido', 'real') then raise exception 'Regime inválido.' using errcode = '22023'; end if;
  update public.organizations set tax_regime = p_regime where id = p_org;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Plano de contas gerencial (árvore) com De/Para contábil
-- kind: receita · deducao · custo_obra · despesa_adm · despesa_financeira · imposto_lucro (entram na DRE)
--       recursos_cliente (obras por administração) · nao_operacional (transferências, empréstimos, investimentos,
--       retiradas) — ficam FORA da DRE e entram no fluxo de caixa.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.fin_accounts (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  parent_id        uuid,
  code             text not null check (code ~ '^[0-9]+(\.[0-9]+)*$'),
  name             text not null check (length(trim(name)) between 2 and 120),
  kind             text not null check (kind in ('receita', 'deducao', 'custo_obra', 'despesa_adm', 'despesa_financeira', 'imposto_lucro',
                                                 'recursos_cliente', 'nao_operacional')),
  accounting_code  text not null default '' check (length(accounting_code) <= 40),    -- De/Para: conta contábil / código reduzido
  accounting_name  text not null default '' check (length(accounting_name) <= 160),
  obra_category    text check (obra_category in ('Material', 'Mão de obra', 'Equipamento', 'Serviço terceirizado', 'Indireto', 'Outro')),
  is_system        boolean not null default false,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, code),
  foreign key (parent_id, org_id) references public.fin_accounts (id, org_id) on delete restrict
);
create unique index if not exists fin_accounts_obra_cat_uq on public.fin_accounts (org_id, obra_category) where obra_category is not null;
create trigger trg_fin_accounts_updated before update on public.fin_accounts for each row execute function public.set_updated_at();
create trigger trg_fin_accounts_audit after insert or update or delete on public.fin_accounts for each row execute function public.audit_row();

-- conta do sistema: código, tipo e vínculo com a categoria de obra não mudam (o nome e o De/Para sim)
create or replace function public.fin_account_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_pai public.fin_accounts;
begin
  if tg_op = 'UPDATE' and old.is_system and (new.code is distinct from old.code or new.kind is distinct from old.kind
     or new.obra_category is distinct from old.obra_category or new.parent_id is distinct from old.parent_id) then
    raise exception 'Conta padrão: código, tipo e grupo não mudam (renomeie ou informe o De/Para contábil).' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.is_system is distinct from old.is_system then
    raise exception 'Não é possível mudar se a conta é padrão.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and current_setting('geplan.sistema', true) is distinct from '1' then new.is_system := false; end if;
  if new.parent_id is not null then
    select * into v_pai from public.fin_accounts where id = new.parent_id;
    if v_pai.kind <> new.kind then raise exception 'A conta precisa ser do mesmo tipo do grupo (%).', v_pai.name using errcode = '22023'; end if;
    if new.code not like v_pai.code || '.%' then raise exception 'O código precisa começar com o do grupo (%).', v_pai.code using errcode = '22023'; end if;
  end if;
  return new;
end $$;
create trigger trg_fin_accounts_before before insert or update on public.fin_accounts for each row execute function public.fin_account_before();

create or replace function public.default_fin_accounts(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record; v_pai uuid;
begin
  perform set_config('geplan.sistema', '1', true);
  for r in select * from (values
    ('1', 'Receitas', 'receita', null),
    ('1.1', 'Receita de obras por empreitada', 'receita', null),
    ('1.2', 'Taxa de administração de obras', 'receita', null),
    ('1.3', 'Resultado de serviços com teto (obras por administração)', 'receita', null),
    ('1.4', 'Receitas financeiras', 'receita', null),
    ('1.5', 'Outras receitas', 'receita', null),
    ('2', 'Deduções da receita (impostos sobre faturamento)', 'deducao', null),
    ('2.1', 'Simples Nacional (DAS)', 'deducao', null),
    ('2.2', 'ISS', 'deducao', null),
    ('2.3', 'PIS', 'deducao', null),
    ('2.4', 'COFINS', 'deducao', null),
    ('2.5', 'INSS sobre a receita (CPRB)', 'deducao', null),
    ('3', 'Custos das obras', 'custo_obra', null),
    ('3.1', 'Materiais', 'custo_obra', 'Material'),
    ('3.2', 'Mão de obra (empreiteiros e prestadores)', 'custo_obra', 'Mão de obra'),
    ('3.3', 'Equipamentos e locações', 'custo_obra', 'Equipamento'),
    ('3.4', 'Serviços terceirizados', 'custo_obra', 'Serviço terceirizado'),
    ('3.5', 'Custos indiretos da obra', 'custo_obra', 'Indireto'),
    ('3.6', 'Outros custos da obra', 'custo_obra', 'Outro'),
    ('3.7', 'Encargos da mão de obra própria (INSS da obra / CNO)', 'custo_obra', null),
    ('4', 'Despesas administrativas', 'despesa_adm', null),
    ('4.1', 'Salários e pró-labore', 'despesa_adm', null),
    ('4.2', 'Encargos sociais e benefícios', 'despesa_adm', null),
    ('4.3', 'Aluguel e condomínio', 'despesa_adm', null),
    ('4.4', 'Água, energia, internet e telefone', 'despesa_adm', null),
    ('4.5', 'Contabilidade e serviços profissionais', 'despesa_adm', null),
    ('4.6', 'Sistemas e assinaturas', 'despesa_adm', null),
    ('4.7', 'Veículos e combustível', 'despesa_adm', null),
    ('4.8', 'Marketing e comercial', 'despesa_adm', null),
    ('4.9', 'Outras despesas administrativas', 'despesa_adm', null),
    ('5', 'Despesas financeiras', 'despesa_financeira', null),
    ('5.1', 'Tarifas bancárias', 'despesa_financeira', null),
    ('5.2', 'Juros e multas', 'despesa_financeira', null),
    ('6', 'Impostos sobre o lucro', 'imposto_lucro', null),
    ('6.1', 'IRPJ', 'imposto_lucro', null),
    ('6.2', 'CSLL', 'imposto_lucro', null),
    ('7', 'Recursos de clientes (obras por administração)', 'recursos_cliente', null),
    ('7.1', 'Aportes recebidos de clientes', 'recursos_cliente', null),
    ('7.2', 'Custos pagos com recursos de clientes', 'recursos_cliente', null),
    ('8', 'Movimentações fora do resultado', 'nao_operacional', null),
    ('8.1', 'Transferências entre contas', 'nao_operacional', null),
    ('8.2', 'Empréstimos e financiamentos', 'nao_operacional', null),
    ('8.3', 'Investimentos (máquinas, veículos, equipamentos)', 'nao_operacional', null),
    ('8.4', 'Retirada de sócios e distribuição de lucros', 'nao_operacional', null)
  ) as t(code, name, kind, cat) order by string_to_array(code, '.')::int[] loop
    select id into v_pai from public.fin_accounts where org_id = p_org and code = regexp_replace(r.code, '\.[0-9]+$', '') and r.code like '%.%';
    insert into public.fin_accounts (org_id, parent_id, code, name, kind, obra_category, is_system)
    values (p_org, case when r.code like '%.%' then v_pai end, r.code, r.name, r.kind, r.cat, true)
    on conflict (org_id, code) do nothing;
  end loop;
  perform set_config('geplan.sistema', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Centros de custo: "Administrativo / Matriz" e um por obra (criados e renomeados sozinhos)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.fin_cost_centers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete restrict,
  project_id    uuid unique,
  kind          text not null check (kind in ('matriz', 'obra', 'outro')),
  code          text not null default '' check (length(code) <= 30),
  name          text not null check (length(trim(name)) between 2 and 200),
  client_funds  boolean not null default false,          -- obra por administração: custos pagos com recursos do cliente
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete restrict,
  check ((kind = 'obra') = (project_id is not null))
);
create unique index if not exists fin_cost_centers_matriz_uq on public.fin_cost_centers (org_id) where kind = 'matriz';
create trigger trg_fin_cost_centers_updated before update on public.fin_cost_centers for each row execute function public.set_updated_at();
create trigger trg_fin_cost_centers_audit after insert or update or delete on public.fin_cost_centers for each row execute function public.audit_row();

create or replace function public.fin_cost_center_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('geplan.sistema', true) = '1' then return new; end if;
  if tg_op = 'INSERT' and new.kind <> 'outro' then
    raise exception 'A Matriz e os centros das obras são criados pelo sistema.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.kind is distinct from old.kind or new.project_id is distinct from old.project_id) then
    raise exception 'O tipo do centro de custo não muda.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.kind = 'obra' and new.name is distinct from old.name then
    raise exception 'O nome do centro de custo da obra acompanha o nome da obra.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.client_funds and new.kind <> 'obra' then
    raise exception 'Só obra pode ser "por administração".' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger trg_fin_cost_centers_before before insert or update on public.fin_cost_centers for each row execute function public.fin_cost_center_before();

create or replace function public.org_fin_padrao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.default_fin_accounts(new.id);
  perform set_config('geplan.sistema', '1', true);
  insert into public.fin_cost_centers (org_id, kind, code, name) values (new.id, 'matriz', 'ADM', 'Administrativo / Matriz') on conflict do nothing;
  perform set_config('geplan.sistema', '', true);
  return new;
end $$;
drop trigger if exists trg_organizations_fin_padrao on public.organizations;
create trigger trg_organizations_fin_padrao after insert on public.organizations for each row execute function public.org_fin_padrao();

create or replace function public.project_centro_custo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('geplan.sistema', '1', true);
  if tg_op = 'INSERT' then
    insert into public.fin_cost_centers (org_id, project_id, kind, code, name)
    values (new.org_id, new.id, 'obra', left(coalesce(new.code, ''), 30), left(new.name, 200)) on conflict (project_id) do nothing;
  elsif new.name is distinct from old.name or new.code is distinct from old.code or new.deleted_at is distinct from old.deleted_at then
    update public.fin_cost_centers set name = left(new.name, 200), code = left(coalesce(new.code, ''), 30), active = new.deleted_at is null
     where project_id = new.id;
  end if;
  perform set_config('geplan.sistema', '', true);
  return new;
end $$;
drop trigger if exists trg_projects_centro_custo on public.projects;
create trigger trg_projects_centro_custo after insert or update on public.projects for each row execute function public.project_centro_custo();

-- empresas e obras que já existem
select public.default_fin_accounts(id) from public.organizations;
do $$ begin
  perform set_config('geplan.sistema', '1', true);
  insert into public.fin_cost_centers (org_id, kind, code, name)
    select id, 'matriz', 'ADM', 'Administrativo / Matriz' from public.organizations o
     where not exists (select 1 from public.fin_cost_centers c where c.org_id = o.id and c.kind = 'matriz');
  insert into public.fin_cost_centers (org_id, project_id, kind, code, name, active)
    select org_id, id, 'obra', left(code, 30), left(name, 200), deleted_at is null from public.projects p
     where not exists (select 1 from public.fin_cost_centers c where c.project_id = p.id);
  perform set_config('geplan.sistema', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Contas bancárias (e caixa)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.fin_bank_accounts (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  name             text not null check (length(trim(name)) between 2 and 120),
  kind             text not null default 'corrente' check (kind in ('corrente', 'poupanca', 'aplicacao', 'caixa')),
  bank             text not null default '' check (length(bank) <= 80),
  agency           text not null default '' check (length(agency) <= 20),
  account_number   text not null default '' check (length(account_number) <= 30),
  cost_center_id   uuid,                                    -- conta específica de uma obra (patrimônio de afetação)
  accounting_code  text not null default '' check (length(accounting_code) <= 40),
  opening_balance  numeric(16, 2) not null default 0,
  opening_date     date not null default current_date,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (cost_center_id, org_id) references public.fin_cost_centers (id, org_id) on delete restrict
);
create trigger trg_fin_bank_accounts_updated before update on public.fin_bank_accounts for each row execute function public.set_updated_at();
create trigger trg_fin_bank_accounts_audit after insert or update or delete on public.fin_bank_accounts for each row execute function public.audit_row();

-- toda empresa começa com um "Caixa" (dinheiro em espécie) para as baixas
create or replace function public.org_caixa_padrao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.fin_bank_accounts (org_id, name, kind) values (new.id, 'Caixa da empresa', 'caixa');
  return new;
end $$;
drop trigger if exists trg_organizations_caixa on public.organizations;
create trigger trg_organizations_caixa after insert on public.organizations for each row execute function public.org_caixa_padrao();
insert into public.fin_bank_accounts (org_id, name, kind)
  select id, 'Caixa da empresa', 'caixa' from public.organizations o where not exists (select 1 from public.fin_bank_accounts b where b.org_id = o.id);

-- ---------------------------------------------------------------------------------------------
-- Lançamentos: contas a pagar e a receber da empresa
-- ---------------------------------------------------------------------------------------------
create table if not exists public.fin_entries (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  kind           text not null check (kind in ('pagar', 'receber')),
  description    text not null check (length(trim(description)) between 2 and 200),
  party_name     text not null default '' check (length(party_name) <= 160),     -- fornecedor, cliente, funcionário…
  supplier_id    uuid,
  document       text not null default '' check (length(document) <= 60),
  account_id     uuid not null,
  competence     date not null,                                                   -- mês de competência (DRE)
  due_date       date not null,
  amount         numeric(16, 2) not null check (amount > 0),
  status         text not null default 'aberto' check (status in ('aberto', 'parcial', 'quitado', 'cancelado')),
  notes          text not null default '' check (length(notes) <= 1000),
  cancel_reason  text not null default '',
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_label  text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  foreign key (account_id, org_id) references public.fin_accounts (id, org_id) on delete restrict,
  foreign key (supplier_id, org_id) references public.suppliers (id, org_id) on delete restrict
);
create index if not exists fin_entries_org_due_idx on public.fin_entries (org_id, due_date) where status <> 'cancelado';
create trigger trg_fin_entries_updated before update on public.fin_entries for each row execute function public.set_updated_at();
create trigger trg_fin_entries_audit after insert or update or delete on public.fin_entries for each row execute function public.audit_row();

-- Rateio entre centros de custo (percentual; a soma precisa dar 100% — conferido no fim da transação)
create table if not exists public.fin_entry_splits (
  entry_id        uuid not null,
  org_id          uuid not null,
  cost_center_id  uuid not null,
  pct             numeric(7, 4) not null check (pct > 0 and pct <= 100),
  primary key (entry_id, cost_center_id),
  foreign key (entry_id, org_id) references public.fin_entries (id, org_id) on delete cascade,
  foreign key (cost_center_id, org_id) references public.fin_cost_centers (id, org_id) on delete restrict
);
create trigger trg_fin_entry_splits_audit after insert or update or delete on public.fin_entry_splits for each row execute function public.audit_row();

-- Baixas (pagamentos e recebimentos); estorno = deleted_at com motivo
create table if not exists public.fin_settlements (
  id               uuid primary key default gen_random_uuid(),
  entry_id         uuid not null,
  org_id           uuid not null,
  pay_date         date not null,
  amount           numeric(16, 2) not null check (amount > 0),
  bank_account_id  uuid,
  method           text not null default 'pix' check (method in ('pix', 'boleto', 'transferencia', 'cartao', 'dinheiro', 'cheque', 'debito_automatico', 'outro')),
  paid_by          text not null default 'empresa' check (paid_by in ('empresa', 'cliente')),   -- cliente pagou direto (obra por administração)
  notes            text not null default '' check (length(notes) <= 500),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_label    text not null default '',
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  undo_reason      text not null default '',
  foreign key (entry_id, org_id) references public.fin_entries (id, org_id) on delete restrict,
  foreign key (bank_account_id, org_id) references public.fin_bank_accounts (id, org_id) on delete restrict,
  check (paid_by = 'cliente' or bank_account_id is not null)
);
create index if not exists fin_settlements_entry_idx on public.fin_settlements (entry_id) where deleted_at is null;
create trigger trg_fin_settlements_audit after insert or update or delete on public.fin_settlements for each row execute function public.audit_row();

-- regras do lançamento: conta analítica (sem subcontas) e ativa; quitado/cancelado não muda valor; status só pelo sistema
create or replace function public.fin_entry_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare a public.fin_accounts;
begin
  if tg_op = 'INSERT' then
    new.created_label := public.rotulo_usuario(); new.created_by := auth.uid(); new.status := 'aberto'; new.cancel_reason := '';
  elsif current_setting('geplan.sistema', true) is distinct from '1' then
    if new.status is distinct from old.status then raise exception 'A situação do lançamento é calculada pelas baixas (ou use "Cancelar").' using errcode = '42501'; end if;
    if old.status in ('quitado', 'cancelado') and (new.amount, new.account_id, new.kind) is distinct from (old.amount, old.account_id, old.kind) then
      raise exception 'Lançamento % não muda valor nem conta.', case old.status when 'quitado' then 'quitado' else 'cancelado' end using errcode = '42501';
    end if;
    if new.kind is distinct from old.kind then raise exception 'A pagar/a receber não muda depois de lançado.' using errcode = '42501'; end if;
  end if;
  select * into a from public.fin_accounts where id = new.account_id;
  if not a.active then raise exception 'A conta "%" está inativa.', a.name using errcode = '22023'; end if;
  if exists (select 1 from public.fin_accounts c where c.parent_id = a.id) then
    raise exception 'Escolha uma conta do último nível (não o grupo "%").', a.name using errcode = '22023';
  end if;
  if new.kind = 'receber' and a.kind not in ('receita', 'recursos_cliente', 'nao_operacional') then
    raise exception 'Conta a receber precisa de uma conta de receita, de recursos de clientes ou fora do resultado.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger trg_fin_entries_before before insert or update on public.fin_entries for each row execute function public.fin_entry_before();

create or replace function public.fin_checar_rateio() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_entry uuid; v_soma numeric; v_n int; e public.fin_entries;
begin
  -- (IF, não CASE: o registro de cada tabela tem campos diferentes)
  if tg_table_name = 'fin_entries' then v_entry := new.id;
  elsif tg_op = 'DELETE' then v_entry := old.entry_id;
  else v_entry := new.entry_id; end if;
  select * into e from public.fin_entries where id = v_entry;
  if not found or e.status = 'cancelado' then return null; end if;
  select coalesce(sum(pct), 0), count(*) into v_soma, v_n from public.fin_entry_splits where entry_id = v_entry;
  if v_n = 0 then raise exception 'Informe o centro de custo do lançamento "%".', e.description using errcode = '23514'; end if;
  if abs(v_soma - 100) > 0.0001 then
    raise exception 'O rateio de "%" soma % por cento; precisa dar 100.', e.description, trim_scale(v_soma) using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger trg_fin_entries_rateio after insert or update on public.fin_entries deferrable initially deferred
  for each row execute function public.fin_checar_rateio();
create constraint trigger trg_fin_entry_splits_rateio after insert or update or delete on public.fin_entry_splits deferrable initially deferred
  for each row execute function public.fin_checar_rateio();

-- baixas: não passam do valor; recalculam a situação do lançamento
create or replace function public.fin_settlement_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare e public.fin_entries; b public.fin_bank_accounts;
begin
  select * into e from public.fin_entries where id = new.entry_id;
  if tg_op = 'INSERT' then
    if e.status = 'cancelado' then raise exception 'Lançamento cancelado não recebe baixa.' using errcode = '22023'; end if;
    if new.pay_date > current_date then raise exception 'A data da baixa não pode ser futura.' using errcode = '22023'; end if;
    new.created_label := public.rotulo_usuario(); new.created_by := auth.uid(); new.deleted_at := null; new.undo_reason := '';
    if new.paid_by = 'cliente' and e.kind <> 'pagar' then raise exception '"Cliente pagou direto" vale só para contas a pagar.' using errcode = '22023'; end if;
    if new.bank_account_id is not null then
      select * into b from public.fin_bank_accounts where id = new.bank_account_id;
      if not b.active then raise exception 'A conta bancária "%" está inativa.', b.name using errcode = '22023'; end if;
    end if;
  else
    if (new.amount, new.pay_date, new.bank_account_id, new.method, new.paid_by, new.entry_id) is distinct from
       (old.amount, old.pay_date, old.bank_account_id, old.method, old.paid_by, old.entry_id) then
      raise exception 'Baixa lançada não muda: estorne (com motivo) e lance de novo.' using errcode = '42501';
    end if;
    if old.deleted_at is not null then raise exception 'Baixa já estornada.' using errcode = '42501'; end if;
    if new.deleted_at is not null and length(trim(new.undo_reason)) < 5 then
      raise exception 'Informe o motivo do estorno (mínimo 5 caracteres).' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger trg_fin_settlements_before before insert or update on public.fin_settlements for each row execute function public.fin_settlement_before();

create or replace function public.fin_settlement_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare e public.fin_entries; v_pago numeric; v_st text;
begin
  select * into e from public.fin_entries where id = coalesce(new.entry_id, old.entry_id) for update;
  select coalesce(sum(amount), 0) into v_pago from public.fin_settlements where entry_id = e.id and deleted_at is null;
  if v_pago > e.amount + 0.005 then
    raise exception 'As baixas (%) passam do valor do lançamento (%).', public.fmt_brl(v_pago), public.fmt_brl(e.amount) using errcode = '23514';
  end if;
  v_st := case when e.status = 'cancelado' then 'cancelado' when v_pago >= e.amount - 0.005 then 'quitado' when v_pago > 0 then 'parcial' else 'aberto' end;
  if v_st <> e.status then
    perform set_config('geplan.sistema', '1', true);
    update public.fin_entries set status = v_st where id = e.id;
    perform set_config('geplan.sistema', '', true);
  end if;
  return null;
end $$;
create trigger trg_fin_settlements_after after insert or update on public.fin_settlements for each row execute function public.fin_settlement_after();

-- Lança (ou edita) o lançamento com o rateio de uma vez. p_rateio = [{"cost_center_id": "...", "pct": 50}, ...]
create or replace function public.fin_salvar_lancamento(
  p_org uuid, p_kind text, p_description text, p_account uuid, p_competence date, p_due date, p_amount numeric, p_rateio jsonb,
  p_party text default '', p_supplier uuid default null, p_document text default '', p_notes text default '', p_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; r jsonb;
begin
  if not public.grava_fin_empresa(p_org) then raise exception 'Seu perfil não lança no financeiro da empresa.' using errcode = '42501'; end if;
  if jsonb_typeof(p_rateio) <> 'array' or jsonb_array_length(p_rateio) = 0 then raise exception 'Informe o centro de custo.' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.fin_entries (org_id, kind, description, party_name, supplier_id, document, account_id, competence, due_date, amount, notes)
    values (p_org, p_kind, trim(p_description), trim(coalesce(p_party, '')), p_supplier, trim(coalesce(p_document, '')), p_account,
            date_trunc('month', p_competence)::date, p_due, p_amount, coalesce(p_notes, ''))
    returning id into v_id;
  else
    if not exists (select 1 from public.fin_entries where id = v_id and org_id = p_org) then raise exception 'Lançamento não encontrado.' using errcode = '22023'; end if;
    update public.fin_entries set description = trim(p_description), party_name = trim(coalesce(p_party, '')), supplier_id = p_supplier,
           document = trim(coalesce(p_document, '')), account_id = p_account, competence = date_trunc('month', p_competence)::date,
           due_date = p_due, amount = p_amount, notes = coalesce(p_notes, '')
     where id = v_id;
    delete from public.fin_entry_splits where entry_id = v_id;
  end if;
  for r in select * from jsonb_array_elements(p_rateio) loop
    insert into public.fin_entry_splits (entry_id, org_id, cost_center_id, pct)
    values (v_id, p_org, (r ->> 'cost_center_id')::uuid, (r ->> 'pct')::numeric);
  end loop;
  -- valor menor que o já baixado: o recálculo recusa
  perform 1 from public.fin_settlements where entry_id = v_id and deleted_at is null having sum(amount) > p_amount + 0.005;
  if found then raise exception 'O valor ficou menor que o já pago/recebido.' using errcode = '23514'; end if;
  return v_id;
end $$;

create or replace function public.fin_cancelar_lancamento(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.fin_entries;
begin
  select * into e from public.fin_entries where id = p_id for update;
  if not found then raise exception 'Lançamento não encontrado.' using errcode = '22023'; end if;
  if not public.grava_fin_empresa(e.org_id) then raise exception 'Seu perfil não lança no financeiro da empresa.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  if exists (select 1 from public.fin_settlements where entry_id = e.id and deleted_at is null) then
    raise exception 'O lançamento tem baixa: estorne as baixas antes de cancelar.' using errcode = '22023';
  end if;
  perform set_config('geplan.sistema', '1', true);
  update public.fin_entries set status = 'cancelado', cancel_reason = trim(p_reason) where id = e.id;
  perform set_config('geplan.sistema', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Acesso
-- ---------------------------------------------------------------------------------------------
alter table public.fin_accounts      enable row level security;
alter table public.fin_cost_centers  enable row level security;
alter table public.fin_bank_accounts enable row level security;
alter table public.fin_entries       enable row level security;
alter table public.fin_entry_splits  enable row level security;
alter table public.fin_settlements   enable row level security;

create policy fin_accounts_select on public.fin_accounts for select to authenticated using (public.ve_fin_empresa(org_id));
create policy fin_accounts_insert on public.fin_accounts for insert to authenticated with check (public.grava_fin_empresa(org_id));
create policy fin_accounts_update on public.fin_accounts for update to authenticated using (public.grava_fin_empresa(org_id)) with check (public.grava_fin_empresa(org_id));

create policy fin_cost_centers_select on public.fin_cost_centers for select to authenticated using (public.ve_fin_empresa(org_id));
create policy fin_cost_centers_insert on public.fin_cost_centers for insert to authenticated with check (public.grava_fin_empresa(org_id));
create policy fin_cost_centers_update on public.fin_cost_centers for update to authenticated using (public.grava_fin_empresa(org_id)) with check (public.grava_fin_empresa(org_id));

create policy fin_bank_accounts_select on public.fin_bank_accounts for select to authenticated using (public.ve_fin_empresa(org_id));
create policy fin_bank_accounts_insert on public.fin_bank_accounts for insert to authenticated with check (public.grava_fin_empresa(org_id));
create policy fin_bank_accounts_update on public.fin_bank_accounts for update to authenticated using (public.grava_fin_empresa(org_id)) with check (public.grava_fin_empresa(org_id));

-- lançamentos e rateio: leitura pela API; gravação pelas funções fin_salvar_lancamento / fin_cancelar_lancamento
create policy fin_entries_select on public.fin_entries for select to authenticated using (public.ve_fin_empresa(org_id));
create policy fin_entry_splits_select on public.fin_entry_splits for select to authenticated using (public.ve_fin_empresa(org_id));

create policy fin_settlements_select on public.fin_settlements for select to authenticated using (public.ve_fin_empresa(org_id));
create policy fin_settlements_insert on public.fin_settlements for insert to authenticated with check (public.grava_fin_empresa(org_id));
create policy fin_settlements_update on public.fin_settlements for update to authenticated using (public.grava_fin_empresa(org_id)) with check (public.grava_fin_empresa(org_id));

revoke all on public.fin_accounts, public.fin_cost_centers, public.fin_bank_accounts, public.fin_entries, public.fin_entry_splits,
  public.fin_settlements from anon;
grant select, insert, update on public.fin_accounts, public.fin_cost_centers, public.fin_bank_accounts to authenticated;
grant select on public.fin_entries, public.fin_entry_splits to authenticated;
grant select, insert on public.fin_settlements to authenticated;
grant update (deleted_at, undo_reason) on public.fin_settlements to authenticated;

revoke all on function public.default_fin_accounts(uuid), public.org_fin_padrao(), public.org_caixa_padrao(), public.project_centro_custo(),
  public.fin_account_before(), public.fin_cost_center_before(), public.fin_entry_before(), public.fin_checar_rateio(),
  public.fin_settlement_before(), public.fin_settlement_after() from public, anon, authenticated;
revoke all on function public.definir_regime_tributario(uuid, text),
  public.fin_salvar_lancamento(uuid, text, text, uuid, date, date, numeric, jsonb, text, uuid, text, text, uuid),
  public.fin_cancelar_lancamento(uuid, text) from public, anon;
grant execute on function public.definir_regime_tributario(uuid, text),
  public.fin_salvar_lancamento(uuid, text, text, uuid, date, date, numeric, jsonb, text, uuid, text, text, uuid),
  public.fin_cancelar_lancamento(uuid, text) to authenticated;
