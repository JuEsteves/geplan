-- GEPLAN · 0003 · Orçamento, revisões, EAP/atividades, dependências, vínculos orçamento × EAP e linha de base.
-- Regras de integridade no banco: sem custo contado duas vezes (vínculos ≤ 100% por item), sem dependência
-- circular, sem misturar registros de obras diferentes (chaves compostas id + project_id).

-- ---------------------------------------------------------------------------------------------
-- Orçamento
-- ---------------------------------------------------------------------------------------------
create table if not exists public.budget_items (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete restrict,
  code            text not null default '',
  group_name      text not null default '',      -- etapa
  subgroup_name   text not null default '',      -- subetapa
  composition_id  uuid references public.cost_compositions (id) on delete set null,
  description     text not null default '',      -- usado quando não há composição
  unit            text not null default '',
  quantity        numeric(18, 4) not null default 0 check (quantity >= 0),
  unit_cost       numeric(16, 4) not null default 0 check (unit_cost >= 0),
  total_cost      numeric(18, 2) generated always as (round(quantity * unit_cost, 2)) stored,
  notes           text not null default '',
  position        integer not null default 0,
  extra           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (id, project_id)
);
create index if not exists budget_items_project_idx on public.budget_items (project_id, code) where deleted_at is null;
create trigger trg_budget_items_updated before update on public.budget_items for each row execute function public.set_updated_at();
create trigger trg_budget_items_audit after insert or update or delete on public.budget_items for each row execute function public.audit_row();

-- A composição usada precisa ser da mesma empresa da obra.
create or replace function public.check_item_composition_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.composition_id is not null and not exists (
      select 1 from public.cost_compositions c join public.projects p on p.org_id = c.org_id
      where c.id = new.composition_id and p.id = new.project_id) then
    raise exception 'Composição de outra empresa.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_budget_items_comp_org before insert or update of composition_id on public.budget_items
  for each row execute function public.check_item_composition_org();

-- Revisões do orçamento: fotografia imutável (itens, BDI e total na data).
create table if not exists public.budget_versions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete restrict,
  name        text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  bdi         jsonb not null default '{}'::jsonb,
  items       jsonb not null default '[]'::jsonb,
  total_cost  numeric(18, 2) not null default 0
);
create index if not exists budget_versions_project_idx on public.budget_versions (project_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- EAP (etapas, subetapas e atividades numa árvore)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.wbs_nodes (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete restrict,
  parent_id             uuid,
  position              integer not null default 0,
  code                  text not null default '',
  level                 smallint not null default 1 check (level between 1 and 9),
  stage                 text not null default '',
  substage              text not null default '',
  description           text not null default '',
  node_type             text not null default 'Execução'
                        check (node_type in ('Execução', 'Fornecedor/Compra', 'Espera técnica', 'Inspeção', 'Administrativo', 'Marco')),
  crew                  numeric(8, 2) check (crew is null or crew > 0),
  manual_duration       numeric(10, 2) check (manual_duration is null or manual_duration >= 0),
  fixed_start           date,
  actual_start          date,
  actual_finish         date,
  pct                   numeric(10, 6) not null default 0 check (pct between 0 and 100),
  status                text not null default '',
  notes                 text not null default '',
  responsible           text not null default '',
  crew_name             text not null default '',
  distribution_profile  text check (distribution_profile is null or distribution_profile in ('linear', 'inicio', 'fim', 'sino')),
  measurement_method    text check (measurement_method is null or measurement_method in ('percentual', 'quantidade')),
  manual_weight         numeric(12, 4) check (manual_weight is null or manual_weight >= 0),
  pred_text             text not null default '',
  pred_manual           boolean not null default false,
  template_id           text,
  template_node_id      text,
  template_order        numeric(12, 4),
  extra                 jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  unique (id, project_id),
  foreign key (parent_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict,
  check (actual_finish is null or actual_start is null or actual_finish >= actual_start)
);
create index if not exists wbs_nodes_project_idx on public.wbs_nodes (project_id, position) where deleted_at is null;
create index if not exists wbs_nodes_parent_idx on public.wbs_nodes (parent_id);
create trigger trg_wbs_nodes_updated before update on public.wbs_nodes for each row execute function public.set_updated_at();

-- Dependências entre atividades: FS (término→início), SS, FF, SF, com defasagem em dias.
create table if not exists public.activity_dependencies (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null,
  activity_id     uuid not null,
  predecessor_id  uuid not null,
  dep_type        text not null default 'FS' check (dep_type in ('FS', 'SS', 'FF', 'SF')),
  lag_days        integer not null default 0 check (lag_days between -3650 and 3650),
  created_at      timestamptz not null default now(),
  check (activity_id <> predecessor_id),
  unique (activity_id, predecessor_id, dep_type),
  foreign key (activity_id, project_id) references public.wbs_nodes (id, project_id) on delete cascade,
  foreign key (predecessor_id, project_id) references public.wbs_nodes (id, project_id) on delete cascade
);
create index if not exists activity_dependencies_project_idx on public.activity_dependencies (project_id);
create index if not exists activity_dependencies_pred_idx on public.activity_dependencies (predecessor_id);

-- Bloqueia dependência circular (A depende de B que depende de A…).
create or replace function public.check_dependency_cycle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    with recursive cadeia(id) as (
      select d.predecessor_id from public.activity_dependencies d where d.activity_id = new.predecessor_id
      union
      select d.predecessor_id from public.activity_dependencies d join cadeia c on d.activity_id = c.id
    )
    select 1 from cadeia where id = new.activity_id
  ) then
    raise exception 'Dependência circular entre atividades.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger trg_dependencies_cycle before insert or update on public.activity_dependencies
  for each row execute function public.check_dependency_cycle();

-- Vínculo orçamento × EAP: parcela (0–1) da quantidade/custo do item atribuída à atividade.
create table if not exists public.budget_allocations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null,
  budget_item_id  uuid not null,
  activity_id     uuid not null,
  share           numeric(9, 6) not null check (share >= 0 and share <= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (budget_item_id, activity_id),
  foreign key (budget_item_id, project_id) references public.budget_items (id, project_id) on delete cascade,
  foreign key (activity_id, project_id) references public.wbs_nodes (id, project_id) on delete cascade
);
create index if not exists budget_allocations_project_idx on public.budget_allocations (project_id);
create index if not exists budget_allocations_activity_idx on public.budget_allocations (activity_id);
create trigger trg_budget_allocations_updated before update on public.budget_allocations for each row execute function public.set_updated_at();

-- Soma das parcelas de um item ≤ 100%: o mesmo custo não pode ser contado duas vezes.
-- Verificada no fim da transação (permite trocar 50/50 por 70/30 num único envio).
create or replace function public.check_allocation_sum() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_item uuid := coalesce(new.budget_item_id, old.budget_item_id); v_sum numeric;
begin
  select coalesce(sum(share), 0) into v_sum from public.budget_allocations where budget_item_id = v_item;
  if v_sum > 1.000001 then
    raise exception 'Vínculos do item somam % (máximo 100%%): o custo seria contado mais de uma vez.', round(v_sum * 100, 2) || '%'
      using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger trg_budget_allocations_sum after insert or update on public.budget_allocations
  deferrable initially deferred for each row execute function public.check_allocation_sum();

-- ---------------------------------------------------------------------------------------------
-- Linha de base do cronograma (aprovada = preservada; nova aprovação guarda a anterior)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.schedule_baselines (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete restrict,
  revision           integer not null check (revision >= 0),
  approved_on        date not null default current_date,
  approved_by        uuid default auth.uid() references auth.users (id) on delete set null,
  finish_date        date,
  planned_cost       numeric(18, 2),
  is_current         boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (project_id, revision)
);
create unique index if not exists schedule_baselines_one_current on public.schedule_baselines (project_id) where is_current;

create table if not exists public.schedule_baseline_items (
  baseline_id  uuid not null references public.schedule_baselines (id) on delete cascade,
  project_id   uuid not null,
  activity_id  uuid not null,       -- sem FK: a linha de base é histórica e sobrevive à exclusão da atividade
  start_date   date,
  finish_date  date,
  primary key (baseline_id, activity_id)
);

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.budget_items             enable row level security;
alter table public.budget_versions          enable row level security;
alter table public.wbs_nodes                enable row level security;
alter table public.activity_dependencies    enable row level security;
alter table public.budget_allocations       enable row level security;
alter table public.schedule_baselines       enable row level security;
alter table public.schedule_baseline_items  enable row level security;

-- Orçamento: custos internos (cliente não vê). Escrita: planejamento. Sem DELETE (exclusão lógica).
create policy budget_items_select on public.budget_items for select to authenticated
  using (public.can_read_costs(project_id));
create policy budget_items_insert on public.budget_items for insert to authenticated
  with check (public.can_write_project(project_id, 'planejamento'));
create policy budget_items_update on public.budget_items for update to authenticated
  using (public.can_write_project(project_id, 'planejamento')) with check (public.can_write_project(project_id, 'planejamento'));

create policy budget_versions_select on public.budget_versions for select to authenticated
  using (public.can_read_costs(project_id));
create policy budget_versions_insert on public.budget_versions for insert to authenticated
  with check (public.can_write_project(project_id, 'planejamento'));

-- EAP: todos que leem a obra veem; planejamento grava. Medições atualizam % e datas reais pela
-- função de sincronização (execução), não por escrita direta do supervisor.
create policy wbs_nodes_select on public.wbs_nodes for select to authenticated using (public.can_read_project(project_id));
create policy wbs_nodes_insert on public.wbs_nodes for insert to authenticated
  with check (public.can_write_project(project_id, 'planejamento'));
create policy wbs_nodes_update on public.wbs_nodes for update to authenticated
  using (public.can_write_project(project_id, 'planejamento')) with check (public.can_write_project(project_id, 'planejamento'));

create policy activity_dependencies_select on public.activity_dependencies for select to authenticated
  using (public.can_read_project(project_id));
create policy activity_dependencies_write on public.activity_dependencies for all to authenticated
  using (public.can_write_project(project_id, 'planejamento')) with check (public.can_write_project(project_id, 'planejamento'));

create policy budget_allocations_select on public.budget_allocations for select to authenticated
  using (public.can_read_costs(project_id));
create policy budget_allocations_write on public.budget_allocations for all to authenticated
  using (public.can_write_project(project_id, 'planejamento')) with check (public.can_write_project(project_id, 'planejamento'));

-- Linha de base: leitura para quem lê a obra; inclusão por planejamento; só a marca "atual" pode mudar.
create policy schedule_baselines_select on public.schedule_baselines for select to authenticated
  using (public.can_read_project(project_id));
create policy schedule_baselines_insert on public.schedule_baselines for insert to authenticated
  with check (public.can_write_project(project_id, 'planejamento'));
create policy schedule_baselines_update on public.schedule_baselines for update to authenticated
  using (public.can_write_project(project_id, 'planejamento')) with check (public.can_write_project(project_id, 'planejamento'));
create policy schedule_baseline_items_select on public.schedule_baseline_items for select to authenticated
  using (public.can_read_project(project_id));
create policy schedule_baseline_items_insert on public.schedule_baseline_items for insert to authenticated
  with check (public.can_write_project(project_id, 'planejamento')
              and exists (select 1 from public.schedule_baselines b where b.id = baseline_id and b.project_id = schedule_baseline_items.project_id));

revoke all on public.budget_items, public.budget_versions, public.wbs_nodes, public.activity_dependencies,
  public.budget_allocations, public.schedule_baselines, public.schedule_baseline_items from anon;
grant select, insert, update on public.budget_items, public.wbs_nodes to authenticated;
grant select, insert on public.budget_versions, public.schedule_baselines, public.schedule_baseline_items to authenticated;
grant update (is_current) on public.schedule_baselines to authenticated;
grant select, insert, update, delete on public.activity_dependencies, public.budget_allocations to authenticated;
