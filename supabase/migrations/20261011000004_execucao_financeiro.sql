-- GEPLAN · 0004 · Execução (medições de avanço, diário de obra) e financeiro (contratos/pedidos, aditivos,
-- despesas, pagamentos). Registros financeiros e históricos não são apagados: exclusão lógica (deleted_at).

-- ---------------------------------------------------------------------------------------------
-- Medições de avanço físico (acumuladas; uma por atividade por data)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.activity_measurements (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null,
  activity_id        uuid not null,
  ref_date           date not null,
  method             text not null default 'percentual' check (method in ('percentual', 'quantidade')),
  qty_accum          numeric(18, 4) check (qty_accum is null or qty_accum >= 0),
  unit               text not null default '',
  planned_qty        numeric(18, 4),
  pct                numeric(10, 6) not null check (pct between 0 and 100),   -- acumulado, limitado a 100%
  notes              text not null default '',
  responsible_label  text not null default '',
  status             text not null default 'aprovada' check (status in ('rascunho', 'aprovada', 'rejeitada')),
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  foreign key (activity_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict,
  check (method <> 'quantidade' or qty_accum is not null)
);
-- Não duplica: a mesma atividade não tem duas medições válidas na mesma data.
create unique index if not exists activity_measurements_one_per_day
  on public.activity_measurements (activity_id, ref_date) where deleted_at is null;
create index if not exists activity_measurements_project_idx on public.activity_measurements (project_id, ref_date);
create trigger trg_activity_measurements_updated before update on public.activity_measurements for each row execute function public.set_updated_at();
create trigger trg_activity_measurements_audit after insert or update or delete on public.activity_measurements for each row execute function public.audit_row();

-- A medição só pode ser lançada em atividade do último nível (não em etapa/subetapa).
create or replace function public.check_measurement_leaf() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.wbs_nodes c where c.parent_id = new.activity_id and c.deleted_at is null) then
    raise exception 'Meça as atividades do último nível (não etapas/subetapas).' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger trg_activity_measurements_leaf before insert or update of activity_id on public.activity_measurements
  for each row execute function public.check_measurement_leaf();

-- Mantém % executado e datas reais da atividade coerentes com as medições aprovadas (feito no servidor,
-- então o supervisor mede sem precisar de permissão para alterar o planejamento).
-- Regra: % = última medição; início real = 1ª medição com avanço (ou a data manual, se anterior);
-- término real = 1ª medição com 100%.
create or replace function public.sync_activity_progress() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_act uuid := coalesce(new.activity_id, old.activity_id);
  v_pct numeric; v_ini date; v_fim date; v_count integer; v_manual date;
begin
  select count(*) into v_count from public.activity_measurements
   where activity_id = v_act and deleted_at is null and status = 'aprovada';
  if v_count = 0 then
    update public.wbs_nodes set pct = 0 where id = v_act;
    return null;
  end if;
  select pct into v_pct from public.activity_measurements
   where activity_id = v_act and deleted_at is null and status = 'aprovada' order by ref_date desc limit 1;
  select min(ref_date) filter (where pct > 0), min(ref_date) filter (where pct >= 100) into v_ini, v_fim
    from public.activity_measurements where activity_id = v_act and deleted_at is null and status = 'aprovada';
  select actual_start into v_manual from public.wbs_nodes where id = v_act;
  update public.wbs_nodes
     set pct = v_pct,
         actual_start = case when v_manual is not null and v_ini is not null and v_manual < v_ini and tg_op = 'INSERT' then v_manual else v_ini end,
         actual_finish = v_fim
   where id = v_act;
  return null;
end $$;
create trigger trg_activity_measurements_sync after insert or update or delete on public.activity_measurements
  for each row execute function public.sync_activity_progress();

-- ---------------------------------------------------------------------------------------------
-- Diário de obra (um registro por data) — não é medição contratual
-- ---------------------------------------------------------------------------------------------
create table if not exists public.daily_reports (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete restrict,
  report_date        date not null,
  weather_morning    text not null default 'Bom',
  weather_afternoon  text not null default 'Bom',
  workable           boolean not null default true,
  materials          text not null default '',
  equipment          text not null default '',
  visits             text not null default '',
  meetings           text not null default '',
  notes              text not null default '',
  responsible_label  text not null default '',
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (id, project_id)
);
create unique index if not exists daily_reports_one_per_day on public.daily_reports (project_id, report_date) where deleted_at is null;
create trigger trg_daily_reports_updated before update on public.daily_reports for each row execute function public.set_updated_at();
create trigger trg_daily_reports_audit after insert or update or delete on public.daily_reports for each row execute function public.audit_row();

create table if not exists public.daily_report_crew (
  id               uuid primary key default gen_random_uuid(),
  daily_report_id  uuid not null,
  project_id       uuid not null,
  role_name        text not null,
  qty              integer not null default 1 check (qty >= 0),
  position         integer not null default 0,
  foreign key (daily_report_id, project_id) references public.daily_reports (id, project_id) on delete cascade
);
create index if not exists daily_report_crew_report_idx on public.daily_report_crew (daily_report_id);

create table if not exists public.daily_report_activities (
  id               uuid primary key default gen_random_uuid(),
  daily_report_id  uuid not null,
  project_id       uuid not null,
  activity_id      uuid,
  description      text not null default '',
  position         integer not null default 0,
  foreign key (daily_report_id, project_id) references public.daily_reports (id, project_id) on delete cascade,
  foreign key (activity_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict
);
create index if not exists daily_report_activities_report_idx on public.daily_report_activities (daily_report_id);
create index if not exists daily_report_activities_activity_idx on public.daily_report_activities (activity_id);

create table if not exists public.site_occurrences (
  id               uuid primary key default gen_random_uuid(),
  daily_report_id  uuid not null,
  project_id       uuid not null,
  occurrence_type  text not null default 'Ocorrência'
                   check (occurrence_type in ('Ocorrência', 'Interferência', 'Impedimento', 'Acidente/segurança', 'Visita técnica')),
  description      text not null,
  resolved         boolean not null default false,
  position         integer not null default 0,
  foreign key (daily_report_id, project_id) references public.daily_reports (id, project_id) on delete cascade
);
create index if not exists site_occurrences_report_idx on public.site_occurrences (daily_report_id);
create index if not exists site_occurrences_open_idx on public.site_occurrences (project_id) where not resolved;

-- ---------------------------------------------------------------------------------------------
-- Financeiro: contratos/pedidos (comprometido), aditivos, despesas (incorrido), pagamentos (pago)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.contracts (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete restrict,
  kind               text not null check (kind in ('Contrato', 'Pedido')),
  number             text not null default '',
  supplier_name      text not null default '',
  category           text not null default 'Outro'
                     check (category in ('Material', 'Mão de obra', 'Equipamento', 'Serviço terceirizado', 'Indireto', 'Outro')),
  amount             numeric(16, 2) not null default 0 check (amount >= 0),
  status             text not null default '',
  contract_date      date,
  scope              text not null default '',
  budget_item_id     uuid,
  needed_date        date,
  quantity           numeric(18, 4) check (quantity is null or quantity >= 0),
  unit               text not null default '',
  quantity_received  numeric(18, 4) check (quantity_received is null or quantity_received >= 0),
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (id, project_id),
  foreign key (budget_item_id, project_id) references public.budget_items (id, project_id) on delete restrict
);
create index if not exists contracts_project_idx on public.contracts (project_id) where deleted_at is null;
create trigger trg_contracts_updated before update on public.contracts for each row execute function public.set_updated_at();
create trigger trg_contracts_audit after insert or update or delete on public.contracts for each row execute function public.audit_row();

create table if not exists public.contract_amendments (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null,
  project_id    uuid not null,
  amend_date    date,
  amount        numeric(16, 2) not null,             -- pode ser negativo (supressão)
  description   text not null default '',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (contract_id, project_id) references public.contracts (id, project_id) on delete restrict
);
create index if not exists contract_amendments_contract_idx on public.contract_amendments (contract_id);
create trigger trg_contract_amendments_audit after insert or update or delete on public.contract_amendments for each row execute function public.audit_row();

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete restrict,
  expense_date    date not null,
  document        text not null default '',
  supplier_name   text not null default '',
  description     text not null default '',
  category        text not null default 'Outro'
                  check (category in ('Material', 'Mão de obra', 'Equipamento', 'Serviço terceirizado', 'Indireto', 'Outro')),
  contract_id     uuid,                                -- despesa de contrato não soma de novo no comprometido
  budget_item_id  uuid,
  amount          numeric(16, 2) not null check (amount >= 0),
  due_date        date,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (id, project_id),
  foreign key (contract_id, project_id) references public.contracts (id, project_id) on delete restrict,
  foreign key (budget_item_id, project_id) references public.budget_items (id, project_id) on delete restrict
);
create index if not exists expenses_project_idx on public.expenses (project_id, expense_date) where deleted_at is null;
create index if not exists expenses_doc_idx on public.expenses (project_id, lower(document), lower(supplier_name)) where deleted_at is null;
create trigger trg_expenses_updated before update on public.expenses for each row execute function public.set_updated_at();
create trigger trg_expenses_audit after insert or update or delete on public.expenses for each row execute function public.audit_row();

create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null,
  project_id  uuid not null,
  pay_date    date not null,
  amount      numeric(16, 2) not null check (amount > 0),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict
);
create index if not exists payments_expense_idx on public.payments (expense_id);
create trigger trg_payments_audit after insert or update or delete on public.payments for each row execute function public.audit_row();

-- Pagamentos de uma despesa não passam do valor dela (verificado no fim da transação).
create or replace function public.check_payments_total() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_exp uuid; v_total numeric; v_amount numeric;
begin
  if tg_table_name = 'payments' then v_exp := coalesce(new.expense_id, old.expense_id); else v_exp := coalesce(new.id, old.id); end if;
  select amount into v_amount from public.expenses where id = v_exp and deleted_at is null;
  if v_amount is null then return null; end if;
  select coalesce(sum(amount), 0) into v_total from public.payments where expense_id = v_exp and deleted_at is null;
  if v_total > v_amount + 0.005 then
    raise exception 'Os pagamentos (%) passam do valor da despesa (%).', v_total, v_amount using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger trg_payments_total after insert or update on public.payments
  deferrable initially deferred for each row execute function public.check_payments_total();
create constraint trigger trg_expenses_payments_total after update of amount on public.expenses
  deferrable initially deferred for each row execute function public.check_payments_total();

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.activity_measurements    enable row level security;
alter table public.daily_reports            enable row level security;
alter table public.daily_report_crew        enable row level security;
alter table public.daily_report_activities  enable row level security;
alter table public.site_occurrences         enable row level security;
alter table public.contracts                enable row level security;
alter table public.contract_amendments      enable row level security;
alter table public.expenses                 enable row level security;
alter table public.payments                 enable row level security;

-- Execução: todos que leem a obra veem; admin/engenheiro/supervisor gravam. Sem DELETE (exclusão lógica).
create policy activity_measurements_select on public.activity_measurements for select to authenticated
  using (public.can_read_project(project_id));
create policy activity_measurements_insert on public.activity_measurements for insert to authenticated
  with check (public.can_write_project(project_id, 'execucao') and deleted_at is null);
create policy activity_measurements_update on public.activity_measurements for update to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));

create policy daily_reports_select on public.daily_reports for select to authenticated
  using (public.can_read_project(project_id));
create policy daily_reports_insert on public.daily_reports for insert to authenticated
  with check (public.can_write_project(project_id, 'execucao') and deleted_at is null);
create policy daily_reports_update on public.daily_reports for update to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));

create policy daily_report_crew_select on public.daily_report_crew for select to authenticated using (public.can_read_project(project_id));
create policy daily_report_crew_write on public.daily_report_crew for all to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));
create policy daily_report_activities_select on public.daily_report_activities for select to authenticated using (public.can_read_project(project_id));
create policy daily_report_activities_write on public.daily_report_activities for all to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));
create policy site_occurrences_select on public.site_occurrences for select to authenticated using (public.can_read_project(project_id));
create policy site_occurrences_write on public.site_occurrences for all to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));

-- Financeiro: contratos/pedidos são lidos por quem vê custos (o supervisor acompanha entregas);
-- despesas e pagamentos só por admin, engenheiro, financeiro e compras. Cliente não vê nenhum.
create policy contracts_select on public.contracts for select to authenticated
  using (public.can_read_costs(project_id));
create policy contracts_insert on public.contracts for insert to authenticated
  with check (public.can_write_project(project_id, 'compras') and deleted_at is null);
create policy contracts_update on public.contracts for update to authenticated
  using (public.can_write_project(project_id, 'compras')) with check (public.can_write_project(project_id, 'compras'));
create policy contract_amendments_select on public.contract_amendments for select to authenticated
  using (public.can_read_costs(project_id));
create policy contract_amendments_insert on public.contract_amendments for insert to authenticated
  with check (public.can_write_project(project_id, 'compras'));
create policy contract_amendments_update on public.contract_amendments for update to authenticated
  using (public.can_write_project(project_id, 'compras')) with check (public.can_write_project(project_id, 'compras'));

create policy expenses_select on public.expenses for select to authenticated
  using (public.project_role(project_id) in ('admin', 'engenheiro', 'financeiro', 'compras'));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (public.can_write_project(project_id, 'financeiro') and deleted_at is null);
create policy expenses_update on public.expenses for update to authenticated
  using (public.can_write_project(project_id, 'financeiro')) with check (public.can_write_project(project_id, 'financeiro'));
create policy payments_select on public.payments for select to authenticated
  using (public.project_role(project_id) in ('admin', 'engenheiro', 'financeiro', 'compras'));
create policy payments_insert on public.payments for insert to authenticated
  with check (public.can_write_project(project_id, 'financeiro') and deleted_at is null);
create policy payments_update on public.payments for update to authenticated
  using (public.can_write_project(project_id, 'financeiro')) with check (public.can_write_project(project_id, 'financeiro'));

revoke all on public.activity_measurements, public.daily_reports, public.daily_report_crew, public.daily_report_activities,
  public.site_occurrences, public.contracts, public.contract_amendments, public.expenses, public.payments from anon;
grant select, insert, update on public.activity_measurements, public.daily_reports, public.contracts,
  public.contract_amendments, public.expenses, public.payments to authenticated;
grant select, insert, update, delete on public.daily_report_crew, public.daily_report_activities, public.site_occurrences to authenticated;
