-- GEPLAN · 0002 · Obras, clientes, equipe da obra, calendário, histórico e biblioteca da empresa
-- (composições com mão de obra, feriados gerais, modelos de EAP).

-- ---------------------------------------------------------------------------------------------
-- Clientes (cadastro único por empresa, reaproveitado entre obras)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  name        text not null default '',
  contact     text not null default '',
  phone       text not null default '',
  email       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id)
);
create index if not exists clients_org_idx on public.clients (org_id);
create trigger trg_clients_updated before update on public.clients for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Obras
-- ---------------------------------------------------------------------------------------------
create table if not exists public.projects (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations (id) on delete restrict,
  client_id              uuid,
  code                   text not null default '',
  name                   text not null check (length(trim(name)) between 1 and 200),
  status                 text not null default 'Planejamento'
                         check (status in ('Orçamento', 'Planejamento', 'Em execução', 'Paralisada', 'Concluída', 'Cancelada')),
  project_type           text not null default '',
  address                text not null default '',
  city                   text not null default '',
  technical_lead         text not null default '',
  technical_registration text not null default '',      -- CREA/CAU
  planned_start          date not null,
  planned_finish         date,
  actual_start           date,
  contract_value         numeric(16, 2) check (contract_value is null or contract_value >= 0),
  work_hours             numeric(5, 2) not null default 8.8 check (work_hours > 0 and work_hours <= 24),
  efficiency             numeric(5, 4) not null default 0.85 check (efficiency > 0 and efficiency <= 1.5),
  calendar_type          text not null default 'uteis' check (calendar_type in ('uteis', 'corridos')),
  work_days              smallint[] not null default '{1,2,3,4,5}',
  default_durations      jsonb not null default '{}'::jsonb,  -- duração padrão por tipo de atividade
  -- BDI pela fórmula do TCU, componentes em % (ex.: 4.0 = 4%)
  bdi_ac  numeric(7, 4) not null default 0 check (bdi_ac >= 0),
  bdi_s   numeric(7, 4) not null default 0 check (bdi_s >= 0),
  bdi_r   numeric(7, 4) not null default 0 check (bdi_r >= 0),
  bdi_g   numeric(7, 4) not null default 0 check (bdi_g >= 0),
  bdi_df  numeric(7, 4) not null default 0 check (bdi_df >= 0),
  bdi_l   numeric(7, 4) not null default 0 check (bdi_l >= 0),
  bdi_i   numeric(7, 4) not null default 0 check (bdi_i >= 0 and bdi_i < 100),
  distribution_profile   text not null default 'linear' check (distribution_profile in ('linear', 'inicio', 'fim', 'sino')),
  physical_weight        text not null default 'hh' check (physical_weight in ('hh', 'custo', 'duracao', 'manual')),
  extra                  jsonb not null default '{}'::jsonb,  -- dados legados do formato antigo (preservados)
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,                   -- exclusão lógica (dados financeiros e histórico preservados)
  unique (id, org_id),
  foreign key (client_id, org_id) references public.clients (id, org_id) on delete restrict
);
create index if not exists projects_org_idx on public.projects (org_id) where deleted_at is null;
create trigger trg_projects_updated before update on public.projects for each row execute function public.set_updated_at();
create trigger trg_projects_audit after insert or update or delete on public.projects for each row execute function public.audit_row();

-- Equipe da obra: dá acesso à obra a supervisores, financeiro, compras e clientes
-- (admin e engenheiro da empresa já veem todas as obras).
create table if not exists public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.member_role,                       -- papel nesta obra (null = papel na empresa)
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user_idx on public.project_members (user_id);

-- ---------------------------------------------------------------------------------------------
-- Autorização por obra
-- ---------------------------------------------------------------------------------------------
create or replace function public.project_org(p_project uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.projects where id = p_project
$$;

-- Papel efetivo do usuário logado numa obra (null = sem acesso).
create or replace function public.project_role(p_project uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  with p as (select id, org_id from public.projects where id = p_project and deleted_at is null),
       o as (select public.org_role(p.org_id) as r from p)
  select case
    when (select r from o) in ('admin', 'engenheiro') then (select r from o)
    when (select r from o) is null then null
    else (select coalesce(pm.role, (select r from o)) from public.project_members pm
          where pm.project_id = p_project and pm.user_id = auth.uid())
  end
$$;

create or replace function public.is_project_member(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.project_members where project_id = p_project and user_id = auth.uid())
$$;

create or replace function public.can_read_project(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.project_role(p_project) is not null
$$;

-- Leitura de custos internos (cliente não vê).
create or replace function public.can_read_costs(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras')
$$;

-- Escrita por área do sistema.
create or replace function public.can_write_project(p_project uuid, p_area text) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_area
    when 'cadastro'      then public.project_role(p_project) in ('admin', 'engenheiro')
    when 'planejamento'  then public.project_role(p_project) in ('admin', 'engenheiro')
    when 'execucao'      then public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor')
    when 'financeiro'    then public.project_role(p_project) in ('admin', 'engenheiro', 'financeiro')
    when 'compras'       then public.project_role(p_project) in ('admin', 'engenheiro', 'compras', 'financeiro')
    else false
  end and public.org_subscription_ok(public.project_org(p_project))
$$;

-- Limite de obras do plano e assinatura válida, verificados no servidor ao criar a obra.
create or replace function public.check_project_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max integer; v_count integer;
begin
  if not public.org_subscription_ok(new.org_id) then
    raise exception 'A assinatura da empresa não está ativa.' using errcode = 'P0001';
  end if;
  select p.max_projects into v_max from public.subscriptions s join public.plans p on p.id = s.plan_id where s.org_id = new.org_id;
  if v_max is not null then
    select count(*) into v_count from public.projects where org_id = new.org_id and deleted_at is null;
    if v_count >= v_max then
      raise exception 'Limite de obras do plano atingido (%).', v_max using errcode = 'P0001';
    end if;
  end if;
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end $$;
create trigger trg_projects_limit before insert on public.projects for each row execute function public.check_project_limit();

-- Quem cria a obra entra na equipe dela.
create or replace function public.add_project_creator() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    insert into public.project_members (project_id, user_id) values (new.id, auth.uid()) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger trg_projects_creator after insert on public.projects for each row execute function public.add_project_creator();

-- Uma obra nunca muda de empresa.
create or replace function public.lock_org_id() returns trigger
language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'Não é permitido mudar o registro de empresa.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_projects_lock_org before update on public.projects for each row execute function public.lock_org_id();

-- ---------------------------------------------------------------------------------------------
-- Calendário e histórico
-- ---------------------------------------------------------------------------------------------
create table if not exists public.project_holidays (
  project_id   uuid not null references public.projects (id) on delete cascade,
  holiday_date date not null,
  description  text not null default '',
  primary key (project_id, holiday_date)
);

create table if not exists public.org_holidays (
  org_id       uuid not null references public.organizations (id) on delete cascade,
  holiday_date date not null,
  description  text not null default '',
  primary key (org_id, holiday_date)
);

-- Histórico legível de alterações (o que o usuário fez). Somente inclusão.
create table if not exists public.project_history (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete restrict,
  at          timestamptz not null default now(),
  user_id     uuid default auth.uid() references auth.users (id) on delete set null,
  user_label  text not null default '',
  action      text not null,
  detail      text not null default ''
);
create index if not exists project_history_project_idx on public.project_history (project_id, at desc);

-- ---------------------------------------------------------------------------------------------
-- Biblioteca da empresa: composições de custo (mão de obra com coeficientes h/unid)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.cost_compositions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  code         text not null default '',
  description  text not null default '',
  unit         text not null default '',
  source       text not null default 'Própria (validada)',  -- origem do coeficiente/preço (rastreabilidade)
  sinapi_ref   text not null default '',
  wbs_stage    text not null default '',
  version      integer not null default 1 check (version >= 1),
  active       boolean not null default true,
  notes        text not null default '',
  extra        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, org_id)
);
create index if not exists cost_compositions_org_idx on public.cost_compositions (org_id, code);
create trigger trg_cost_compositions_updated before update on public.cost_compositions for each row execute function public.set_updated_at();

create table if not exists public.composition_items (
  id              uuid primary key default gen_random_uuid(),
  composition_id  uuid not null,
  org_id          uuid not null,
  kind            text not null default 'mao_obra' check (kind in ('mao_obra', 'material', 'equipamento')),
  description     text not null default '',           -- função (mão de obra) ou insumo
  unit            text not null default 'h',
  coefficient     numeric(16, 6) not null default 0 check (coefficient >= 0),
  is_leader       boolean not null default false,     -- função líder: define o prazo da atividade
  unit_price      numeric(16, 4) check (unit_price is null or unit_price >= 0),
  position        integer not null default 0,
  foreign key (composition_id, org_id) references public.cost_compositions (id, org_id) on delete cascade
);
create index if not exists composition_items_comp_idx on public.composition_items (composition_id);
-- No máximo uma função líder por composição.
create unique index if not exists composition_items_one_leader on public.composition_items (composition_id) where is_leader;

-- Modelos de EAP (bibliotecas de fases). Guardados como documento: são moldes, não registros de obra.
create table if not exists public.wbs_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text not null default '',
  is_default  boolean not null default false,
  content     jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists wbs_templates_org_idx on public.wbs_templates (org_id);
create trigger trg_wbs_templates_updated before update on public.wbs_templates for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.clients            enable row level security;
alter table public.projects           enable row level security;
alter table public.project_members    enable row level security;
alter table public.project_holidays   enable row level security;
alter table public.org_holidays       enable row level security;
alter table public.project_history    enable row level security;
alter table public.cost_compositions  enable row level security;
alter table public.composition_items  enable row level security;
alter table public.wbs_templates      enable row level security;

-- Clientes: membros da empresa leem; admin/engenheiro gravam.
create policy clients_select on public.clients for select to authenticated using (public.is_org_member(org_id));
create policy clients_write on public.clients for all to authenticated
  using (public.org_role(org_id) in ('admin', 'engenheiro'))
  with check (public.org_role(org_id) in ('admin', 'engenheiro'));

-- Obras: leitura conforme o papel; criação por admin/engenheiro; alteração do cadastro idem;
-- sem DELETE (exclusão é lógica, via deleted_at, só admin).
-- (usa as colunas da própria linha, para valer também no INSERT … RETURNING da obra recém-criada)
create policy projects_select on public.projects for select to authenticated
  using ((public.org_role(org_id) in ('admin', 'engenheiro')
         or (public.org_role(org_id) is not null and public.is_project_member(id))));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.org_role(org_id) in ('admin', 'engenheiro') and deleted_at is null);
create policy projects_update on public.projects for update to authenticated
  using (public.can_write_project(id, 'cadastro'))
  with check (public.org_role(org_id) in ('admin', 'engenheiro')
              and (deleted_at is null or public.org_role(org_id) = 'admin'));

create policy project_members_select on public.project_members for select to authenticated
  using (public.can_read_project(project_id));
create policy project_members_write on public.project_members for all to authenticated
  using (public.org_role(public.project_org(project_id)) in ('admin', 'engenheiro'))
  with check (public.org_role(public.project_org(project_id)) in ('admin', 'engenheiro')
              and exists (select 1 from public.organization_members m
                          where m.org_id = public.project_org(project_id) and m.user_id = project_members.user_id));

create policy project_holidays_select on public.project_holidays for select to authenticated
  using (public.can_read_project(project_id));
create policy project_holidays_write on public.project_holidays for all to authenticated
  using (public.can_write_project(project_id, 'planejamento')) with check (public.can_write_project(project_id, 'planejamento'));

create policy org_holidays_select on public.org_holidays for select to authenticated using (public.is_org_member(org_id));
create policy org_holidays_write on public.org_holidays for all to authenticated
  using (public.org_role(org_id) in ('admin', 'engenheiro')) with check (public.org_role(org_id) in ('admin', 'engenheiro'));

-- Histórico: quem lê a obra lê o histórico; quem escreve em alguma área registra; ninguém altera/apaga.
create policy project_history_select on public.project_history for select to authenticated
  using (public.can_read_project(project_id));
create policy project_history_insert on public.project_history for insert to authenticated
  with check (user_id = auth.uid() and public.project_role(project_id) in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras'));

-- Biblioteca: membros (exceto cliente) leem; admin/engenheiro gravam.
create policy cost_compositions_select on public.cost_compositions for select to authenticated
  using (public.org_role(org_id) is not null and public.org_role(org_id) <> 'cliente');
create policy cost_compositions_write on public.cost_compositions for all to authenticated
  using (public.org_role(org_id) in ('admin', 'engenheiro')) with check (public.org_role(org_id) in ('admin', 'engenheiro'));
create policy composition_items_select on public.composition_items for select to authenticated
  using (public.org_role(org_id) is not null and public.org_role(org_id) <> 'cliente');
create policy composition_items_write on public.composition_items for all to authenticated
  using (public.org_role(org_id) in ('admin', 'engenheiro')) with check (public.org_role(org_id) in ('admin', 'engenheiro'));
create policy wbs_templates_select on public.wbs_templates for select to authenticated
  using (public.org_role(org_id) is not null and public.org_role(org_id) <> 'cliente');
create policy wbs_templates_write on public.wbs_templates for all to authenticated
  using (public.org_role(org_id) in ('admin', 'engenheiro')) with check (public.org_role(org_id) in ('admin', 'engenheiro'));

revoke all on public.clients, public.projects, public.project_members, public.project_holidays, public.org_holidays,
  public.project_history, public.cost_compositions, public.composition_items, public.wbs_templates from anon;
grant select, insert, update, delete on public.clients, public.project_members, public.project_holidays, public.org_holidays,
  public.cost_compositions, public.composition_items, public.wbs_templates to authenticated;
grant select, insert, update on public.projects to authenticated;
revoke delete on public.projects from authenticated;
grant select, insert on public.project_history to authenticated;
revoke update, delete on public.project_history from authenticated;
