-- GEPLAN · 0001 · Base: organizações (empresas), usuários, permissões, planos e assinaturas, auditoria.
-- Compatível com Supabase (PostgreSQL 15+). Não apaga nada: só cria objetos.
-- Reversão: ver supabase/README.md (seção "Reverter").

-- ---------------------------------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Perfis de acesso dentro de uma empresa.
--   admin       administrador da empresa (tudo, inclusive usuários e assinatura)
--   engenheiro  engenheiro responsável (tudo nas obras, sem gestão de usuários/assinatura)
--   supervisor  supervisor de obra (medições e diário; leitura do resto, sem custos internos)
--   financeiro  financeiro (despesas, pagamentos, contratos; leitura do resto)
--   compras     compras (contratos e pedidos; leitura do resto)
--   cliente     cliente da obra (somente leitura, sem custos internos)
do $$ begin
  create type public.member_role as enum ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras', 'cliente');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'expired');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------------------------
-- Perfis de usuário (1:1 com auth.users)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.user_profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             text not null,
  full_name         text not null default '',
  is_platform_admin boolean not null default false,   -- só alterável pelo banco (service role), nunca pelo app
  last_org_id       uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger trg_user_profiles_updated before update on public.user_profiles
  for each row execute function public.set_updated_at();

-- Cria o perfil quando o usuário se cadastra (Supabase Auth).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- Planos comerciais (valores de referência, configuráveis aqui — nunca fixos no código)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.plans (
  id              text primary key,                    -- 'individual', 'profissional', 'empresas'
  name            text not null,
  price           numeric(12, 2) not null check (price >= 0),
  billing_period  text not null default 'mensal' check (billing_period in ('mensal', 'anual')),
  max_projects    integer check (max_projects is null or max_projects >= 0),   -- null = sem limite
  max_users       integer check (max_users is null or max_users >= 1),
  max_storage_mb  integer check (max_storage_mb is null or max_storage_mb >= 0),
  features        jsonb not null default '{}'::jsonb,
  trial_days      integer not null default 14 check (trial_days >= 0),
  is_available    boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger trg_plans_updated before update on public.plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Organizações (empresas / espaços de trabalho)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 160),
  tax_id      text not null default '',                -- CNPJ/CPF (opcional)
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create trigger trg_organizations_updated before update on public.organizations
  for each row execute function public.set_updated_at();

create table if not exists public.organization_members (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.member_role not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists organization_members_user_idx on public.organization_members (user_id);

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  email        text not null check (position('@' in email) > 1),
  role         public.member_role not null,
  token        text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz
);
create index if not exists invitations_org_idx on public.invitations (org_id);
create index if not exists invitations_email_idx on public.invitations (lower(email));

-- ---------------------------------------------------------------------------------------------
-- Assinaturas (estado comercial da empresa no GEPLAN — não confundir com contratos de obra)
-- Escrita apenas pelo backend (service role / webhooks do provedor de pagamento). O app só lê.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null unique references public.organizations (id) on delete restrict,
  plan_id                   text not null references public.plans (id) on delete restrict,
  status                    public.subscription_status not null default 'trialing',
  started_at                timestamptz not null default now(),
  trial_ends_at             timestamptz,              -- null = período de avaliação sem data (fase piloto, antes da cobrança)
  current_period_end        timestamptz,
  canceled_at               timestamptz,
  provider                  text,                     -- ex.: 'mercadopago' (fase 8)
  provider_customer_id      text,
  provider_subscription_id  text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create trigger trg_subscriptions_updated before update on public.subscriptions
  for each row execute function public.set_updated_at();

create table if not exists public.subscription_events (
  id               bigint generated always as identity primary key,
  subscription_id  uuid not null references public.subscriptions (id) on delete restrict,
  event_type       text not null,
  from_status      public.subscription_status,
  to_status        public.subscription_status,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists subscription_events_sub_idx on public.subscription_events (subscription_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Auditoria (gravada só por gatilhos; ninguém insere ou altera pelo app)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid,
  project_id  uuid,
  table_name  text not null,
  row_id      text not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  old_data    jsonb,
  new_data    jsonb
);
create index if not exists audit_log_project_idx on public.audit_log (project_id, changed_at desc);
create index if not exists audit_log_org_idx on public.audit_log (org_id, changed_at desc);

-- ---------------------------------------------------------------------------------------------
-- Funções de autorização (usadas pelas políticas RLS). SECURITY DEFINER para ler as tabelas de
-- vínculo sem recursão de RLS; sempre baseadas em auth.uid() — nunca em ids vindos do navegador.
-- ---------------------------------------------------------------------------------------------
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_platform_admin from public.user_profiles where id = auth.uid()), false)
$$;

create or replace function public.org_role(p_org uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select m.role from public.organization_members m
  join public.organizations o on o.id = m.org_id and o.deleted_at is null
  where m.org_id = p_org and m.user_id = auth.uid()
$$;

create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) is not null
$$;

create or replace function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) = 'admin'
$$;

-- Empresas do usuário logado (para a tela de seleção).
create or replace function public.my_organizations()
returns table (org_id uuid, name text, role public.member_role, plan_id text, status public.subscription_status)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, m.role, s.plan_id, s.status
  from public.organization_members m
  join public.organizations o on o.id = m.org_id and o.deleted_at is null
  left join public.subscriptions s on s.org_id = o.id
  where m.user_id = auth.uid()
  order by o.name
$$;

-- ---------------------------------------------------------------------------------------------
-- Operações de backend (RPC). Validam o usuário logado e as regras do plano no servidor.
-- ---------------------------------------------------------------------------------------------

-- Cria a empresa, coloca o usuário como admin e abre a assinatura em avaliação.
create or replace function public.create_organization(p_name text, p_plan text default 'profissional')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_plan public.plans;
begin
  if v_uid is null then raise exception 'Faça login para criar uma empresa.' using errcode = '42501'; end if;
  select * into v_plan from public.plans where id = p_plan and is_available;
  if not found then raise exception 'Plano indisponível: %', p_plan using errcode = '22023'; end if;
  insert into public.organizations (name, created_by) values (trim(p_name), v_uid) returning id into v_org;
  insert into public.organization_members (org_id, user_id, role) values (v_org, v_uid, 'admin');
  -- Fase piloto: avaliação sem data de término até a cobrança ser ativada (ver docs da Fase 8).
  insert into public.subscriptions (org_id, plan_id, status, trial_ends_at) values (v_org, v_plan.id, 'trialing', null);
  update public.user_profiles set last_org_id = v_org where id = v_uid;
  return v_org;
end $$;

-- Assinatura que permite uso (avaliação vigente ou ativa).
create or replace function public.org_subscription_ok(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.org_id = p_org
      and (s.status = 'active' or (s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now())))
  )
$$;

-- Limite de usuários do plano.
create or replace function public.check_member_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max integer; v_count integer;
begin
  select p.max_users into v_max from public.subscriptions s join public.plans p on p.id = s.plan_id where s.org_id = new.org_id;
  if v_max is not null then
    select count(*) into v_count from public.organization_members where org_id = new.org_id;
    if v_count >= v_max then
      raise exception 'Limite de usuários do plano atingido (%).', v_max using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger trg_members_limit before insert on public.organization_members
  for each row execute function public.check_member_limit();

-- Impede remover ou rebaixar o último administrador da empresa.
create or replace function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (select 1 from public.organization_members
                   where org_id = old.org_id and role = 'admin' and user_id <> old.user_id) then
      raise exception 'A empresa precisa de pelo menos um administrador.' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_members_keep_admin before update or delete on public.organization_members
  for each row execute function public.keep_one_admin();

-- Aceita um convite (o e-mail do convite precisa ser o do usuário logado).
create or replace function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.invitations;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then raise exception 'Faça login para aceitar o convite.' using errcode = '42501'; end if;
  select * into v_inv from public.invitations where token = p_token for update;
  if not found or v_inv.revoked_at is not null then raise exception 'Convite inválido.' using errcode = '22023'; end if;
  if v_inv.accepted_at is not null then raise exception 'Este convite já foi usado.' using errcode = '22023'; end if;
  if v_inv.expires_at < now() then raise exception 'Convite expirado.' using errcode = '22023'; end if;
  if lower(v_inv.email) <> v_email then raise exception 'Este convite foi enviado para outro e-mail.' using errcode = '42501'; end if;
  insert into public.organization_members (org_id, user_id, role) values (v_inv.org_id, auth.uid(), v_inv.role)
    on conflict (org_id, user_id) do nothing;
  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
  update public.user_profiles set last_org_id = v_inv.org_id where id = auth.uid();
  return v_inv.org_id;
end $$;

-- Gatilho genérico de auditoria (usado nas tabelas de obra nas migrações seguintes).
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_project uuid := nullif(v_row ->> 'project_id', '')::uuid;
  v_org uuid := nullif(v_row ->> 'org_id', '')::uuid;
begin
  if tg_table_name = 'projects' then v_project := (v_row ->> 'id')::uuid; end if;
  if v_org is null and v_project is not null then
    select org_id into v_org from public.projects where id = v_project;
  end if;
  insert into public.audit_log (org_id, project_id, table_name, row_id, action, changed_by, old_data, new_data)
  values (v_org, v_project, tg_table_name, coalesce(v_row ->> 'id', ''), tg_op, auth.uid(),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.user_profiles        enable row level security;
alter table public.plans                enable row level security;
alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.invitations          enable row level security;
alter table public.subscriptions        enable row level security;
alter table public.subscription_events  enable row level security;
alter table public.audit_log            enable row level security;

-- Perfis: cada um vê o próprio e os colegas das suas empresas; só altera o próprio nome.
create policy user_profiles_select on public.user_profiles for select to authenticated
  using (id = auth.uid() or public.is_platform_admin() or exists (
    select 1 from public.organization_members a join public.organization_members b on a.org_id = b.org_id
    where a.user_id = auth.uid() and b.user_id = user_profiles.id));
create policy user_profiles_update on public.user_profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Planos: catálogo público de leitura para usuários logados.
create policy plans_select on public.plans for select to authenticated using (is_available or public.is_platform_admin());

-- Empresas: membros leem; só admin altera; criação apenas pela função create_organization.
create policy organizations_select on public.organizations for select to authenticated
  using (public.is_org_member(id) or public.is_platform_admin());
create policy organizations_update on public.organizations for update to authenticated
  using (public.is_org_admin(id)) with check (public.is_org_admin(id));

-- Membros: membros leem a lista; admin altera papéis e remove (exceto o último admin, via gatilho).
create policy members_select on public.organization_members for select to authenticated
  using (public.is_org_member(org_id) or public.is_platform_admin());
create policy members_update on public.organization_members for update to authenticated
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
create policy members_delete on public.organization_members for delete to authenticated
  using (public.is_org_admin(org_id) or user_id = auth.uid());

-- Convites: só admin da empresa cria, vê e revoga.
create policy invitations_select on public.invitations for select to authenticated using (public.is_org_admin(org_id));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (public.is_org_admin(org_id) and invited_by = auth.uid() and accepted_at is null);
create policy invitations_update on public.invitations for update to authenticated
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- Assinatura: admin da empresa lê; escrita só pelo backend (sem política de escrita).
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (public.is_org_admin(org_id) or public.is_platform_admin());
create policy subscription_events_select on public.subscription_events for select to authenticated
  using (public.is_platform_admin() or exists (select 1 from public.subscriptions s
         where s.id = subscription_id and public.is_org_admin(s.org_id)));

-- Auditoria: admin da empresa lê; ninguém escreve pelo app.
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_platform_admin() or (org_id is not null and public.is_org_admin(org_id)));

-- Privilégios: anon não acessa nada; authenticated só o que as políticas permitem.
revoke all on public.user_profiles, public.plans, public.organizations, public.organization_members,
  public.invitations, public.subscriptions, public.subscription_events, public.audit_log from anon;
grant select on public.user_profiles, public.plans, public.organizations, public.organization_members,
  public.invitations, public.subscriptions, public.subscription_events, public.audit_log to authenticated;
revoke insert, update, delete on public.user_profiles, public.plans, public.organizations, public.organization_members,
  public.invitations, public.subscriptions, public.subscription_events, public.audit_log from authenticated;
grant update (full_name, last_org_id) on public.user_profiles to authenticated;
grant update (name, tax_id) on public.organizations to authenticated;
grant update (role) on public.organization_members to authenticated;
grant delete on public.organization_members to authenticated;
grant insert (org_id, email, role, invited_by, expires_at) on public.invitations to authenticated;
grant update (revoked_at) on public.invitations to authenticated;

revoke all on function public.create_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;
revoke all on function public.my_organizations() from public, anon;
grant execute on function public.my_organizations() to authenticated;
