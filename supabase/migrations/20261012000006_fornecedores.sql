-- GEPLAN · 0006 · Fornecedores: cadastro central por empresa, categorias configuráveis, categorias secundárias,
-- avaliações manuais, documentos (Supabase Storage privado) e vínculo opcional de contratos/despesas ao fornecedor.
-- Somente acréscimos: nenhuma tabela ou coluna existente é removida ou alterada de forma destrutiva.

-- ---------------------------------------------------------------------------------------------
-- Validação de CPF/CNPJ (dígitos verificadores). Vazio é aceito (documento opcional).
-- ---------------------------------------------------------------------------------------------
create or replace function public.doc_valido(p text) returns boolean
language plpgsql immutable as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  w1 int[] := array[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  w2 int[] := array[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  s int; r int; i int;
begin
  if d = '' then return true; end if;
  if length(d) = 11 then
    if d ~ '^(\d)\1{10}$' then return false; end if;
    s := 0; for i in 1..9 loop s := s + substr(d, i, 1)::int * (11 - i); end loop;
    r := (s * 10) % 11; if r = 10 then r := 0; end if;
    if r <> substr(d, 10, 1)::int then return false; end if;
    s := 0; for i in 1..10 loop s := s + substr(d, i, 1)::int * (12 - i); end loop;
    r := (s * 10) % 11; if r = 10 then r := 0; end if;
    return r = substr(d, 11, 1)::int;
  elsif length(d) = 14 then
    if d ~ '^(\d)\1{13}$' then return false; end if;
    s := 0; for i in 1..12 loop s := s + substr(d, i, 1)::int * w1[i]; end loop;
    r := s % 11; r := case when r < 2 then 0 else 11 - r end;
    if r <> substr(d, 13, 1)::int then return false; end if;
    s := 0; for i in 1..13 loop s := s + substr(d, i, 1)::int * w2[i]; end loop;
    r := s % 11; r := case when r < 2 then 0 else 11 - r end;
    return r = substr(d, 14, 1)::int;
  end if;
  return false;
end $$;

-- Quem pode gravar fornecedores (compras e financeiro também, além de admin e engenheiro).
create or replace function public.pode_gravar_fornecedor(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) in ('admin', 'engenheiro', 'compras', 'financeiro') and public.org_subscription_ok(p_org)
$$;
-- Quem pode ver fornecedores (todos os membros, exceto o perfil cliente).
create or replace function public.pode_ver_fornecedor(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) is not null and public.org_role(p_org) <> 'cliente'
$$;

-- ---------------------------------------------------------------------------------------------
-- Categorias (configuráveis por empresa, sem alterar código)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.supplier_categories (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text not null check (length(trim(name)) between 2 and 80),
  active      boolean not null default true,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (id, org_id)
);
create unique index if not exists supplier_categories_nome on public.supplier_categories (org_id, lower(trim(name)));

create or replace function public.default_supplier_categories(p_org uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.supplier_categories (org_id, name, position)
  select p_org, n, i::int from unnest(array[
    'Madeira e formas', 'Cimento e argamassa', 'Concreto e agregados', 'Aço e estruturas', 'Elétrica', 'Hidráulica',
    'Impermeabilização', 'Cobertura', 'Esquadrias', 'Acabamentos', 'Ferramentas e equipamentos', 'Locação de máquinas',
    'Transporte e frete', 'Outros']) with ordinality as t(n, i)
  on conflict (org_id, lower(trim(name))) do nothing
$$;

-- Empresas novas já nascem com as categorias padrão; as existentes recebem agora.
create or replace function public.org_default_categories() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.default_supplier_categories(new.id);
  return new;
end $$;
drop trigger if exists trg_organizations_supplier_categories on public.organizations;
create trigger trg_organizations_supplier_categories after insert on public.organizations
  for each row execute function public.org_default_categories();
select public.default_supplier_categories(id) from public.organizations;

-- ---------------------------------------------------------------------------------------------
-- Fornecedores
-- ---------------------------------------------------------------------------------------------
create table if not exists public.suppliers (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete restrict,
  -- identificação
  trade_name        text not null check (length(trim(trade_name)) between 2 and 160),   -- nome comercial
  legal_name        text not null default '',                                            -- razão social
  doc_number        text not null default '' check (doc_number ~ '^(\d{11}|\d{14})?$' and public.doc_valido(doc_number)),
  main_category_id  uuid,
  status            text not null default 'ativo' check (status in ('ativo', 'inativo')),
  -- contato
  representative    text not null default '',
  phone             text not null default '',
  whatsapp          text not null default '',
  email             text not null default '' check (email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address           text not null default '',
  city              text not null default '',
  state             text not null default '' check (state = '' or state ~ '^[A-Z]{2}$'),
  contact_notes     text not null default '',
  -- área de atendimento
  service_regions   text not null default '',
  delivers_on_site  boolean,
  allows_pickup     boolean,
  -- condições comerciais (informadas pelo fornecedor; não são calculadas)
  payment_terms     text not null default '',
  freight_rule      text not null default '',
  min_order         numeric(16, 2) check (min_order is null or min_order >= 0),
  avg_lead_days     integer check (avg_lead_days is null or avg_lead_days between 0 and 3650),
  commercial_notes  text not null default '',
  products          text not null default '',    -- materiais/produtos fornecidos (para busca)
  notes             text not null default '',
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  inactivated_at    timestamptz,
  deleted_at        timestamptz,
  unique (id, org_id),
  foreign key (main_category_id, org_id) references public.supplier_categories (id, org_id) on delete restrict
);
create index if not exists suppliers_org_idx on public.suppliers (org_id, lower(trade_name)) where deleted_at is null;
-- O mesmo CPF/CNPJ não aparece duas vezes na mesma empresa.
create unique index if not exists suppliers_doc_unico on public.suppliers (org_id, doc_number) where doc_number <> '' and deleted_at is null;
create trigger trg_suppliers_updated before update on public.suppliers for each row execute function public.set_updated_at();
create trigger trg_suppliers_audit after insert or update or delete on public.suppliers for each row execute function public.audit_row();
create trigger trg_suppliers_lock_org before update on public.suppliers for each row execute function public.lock_org_id();

-- Data de inativação registrada pelo servidor (inativar não apaga histórico).
create or replace function public.supplier_status_date() returns trigger
language plpgsql as $$
begin
  if new.status = 'inativo' and (tg_op = 'INSERT' or old.status <> 'inativo') then new.inactivated_at := now();
  elsif new.status = 'ativo' then new.inactivated_at := null; end if;
  return new;
end $$;
create trigger trg_suppliers_status before insert or update of status on public.suppliers
  for each row execute function public.supplier_status_date();

create table if not exists public.supplier_secondary_categories (
  supplier_id  uuid not null,
  category_id  uuid not null,
  org_id       uuid not null,
  primary key (supplier_id, category_id),
  foreign key (supplier_id, org_id) references public.suppliers (id, org_id) on delete cascade,
  foreign key (category_id, org_id) references public.supplier_categories (id, org_id) on delete cascade
);

-- Avaliações manuais (notas de 1 a 5). Indicadores automáticos virão das entregas (Suprimentos).
create table if not exists public.supplier_evaluations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  supplier_id       uuid not null,
  project_id        uuid references public.projects (id) on delete set null,
  punctuality       smallint check (punctuality between 1 and 5),
  quantity_ok       smallint check (quantity_ok between 1 and 5),
  quality           smallint check (quality between 1 and 5),
  service           smallint check (service between 1 and 5),
  issue_resolution  smallint check (issue_resolution between 1 and 5),
  comment           text not null default '',
  evaluated_by      uuid default auth.uid() references auth.users (id) on delete set null,
  evaluator_label   text not null default '',
  created_at        timestamptz not null default now(),
  check (coalesce(punctuality, quantity_ok, quality, service, issue_resolution) is not null),
  foreign key (supplier_id, org_id) references public.suppliers (id, org_id) on delete restrict
);
create index if not exists supplier_evaluations_supplier_idx on public.supplier_evaluations (supplier_id, created_at desc);
create trigger trg_supplier_evaluations_audit after insert or update or delete on public.supplier_evaluations for each row execute function public.audit_row();

-- A obra avaliada precisa ser da mesma empresa.
create or replace function public.check_evaluation_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and org_id = new.org_id) then
    raise exception 'Obra de outra empresa.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_supplier_evaluations_project before insert or update on public.supplier_evaluations
  for each row execute function public.check_evaluation_project();

-- Documentos (propostas, catálogos, cadastrais). O arquivo fica no Storage privado; aqui ficam os metadados.
create table if not exists public.supplier_documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  supplier_id   uuid not null,
  kind          text not null default 'Outro' check (kind in ('Proposta', 'Catálogo', 'Documento cadastral', 'Outro')),
  name          text not null check (length(trim(name)) between 1 and 200),
  storage_path  text not null unique,
  mime_type     text not null default '',
  size_bytes    bigint not null check (size_bytes between 1 and 52428800),
  uploaded_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (supplier_id, org_id) references public.suppliers (id, org_id) on delete restrict,
  check (storage_path like org_id::text || '/fornecedores/' || supplier_id::text || '/%')
);
create index if not exists supplier_documents_supplier_idx on public.supplier_documents (supplier_id) where deleted_at is null;
create trigger trg_supplier_documents_audit after insert or update or delete on public.supplier_documents for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------------------------
-- Vínculo opcional de contratos/pedidos e despesas ao fornecedor cadastrado (o nome em texto continua)
-- ---------------------------------------------------------------------------------------------
alter table public.contracts add column if not exists supplier_id uuid references public.suppliers (id) on delete restrict;
alter table public.expenses  add column if not exists supplier_id uuid references public.suppliers (id) on delete restrict;
create index if not exists contracts_supplier_idx on public.contracts (supplier_id) where supplier_id is not null;
create index if not exists expenses_supplier_idx on public.expenses (supplier_id) where supplier_id is not null;

create or replace function public.check_supplier_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.supplier_id is not null and not exists (
      select 1 from public.suppliers s join public.projects p on p.org_id = s.org_id
      where s.id = new.supplier_id and p.id = new.project_id) then
    raise exception 'Fornecedor de outra empresa.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_contracts_supplier_org before insert or update of supplier_id on public.contracts
  for each row execute function public.check_supplier_org();
create trigger trg_expenses_supplier_org before insert or update of supplier_id on public.expenses
  for each row execute function public.check_supplier_org();

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.supplier_categories           enable row level security;
alter table public.suppliers                     enable row level security;
alter table public.supplier_secondary_categories enable row level security;
alter table public.supplier_evaluations          enable row level security;
alter table public.supplier_documents            enable row level security;

create policy supplier_categories_select on public.supplier_categories for select to authenticated using (public.pode_ver_fornecedor(org_id));
create policy supplier_categories_insert on public.supplier_categories for insert to authenticated
  with check (public.org_role(org_id) in ('admin', 'engenheiro', 'compras') and public.org_subscription_ok(org_id));
create policy supplier_categories_update on public.supplier_categories for update to authenticated
  using (public.org_role(org_id) in ('admin', 'engenheiro', 'compras')) with check (public.org_role(org_id) in ('admin', 'engenheiro', 'compras'));

-- Fornecedores: sem DELETE (inativação ou exclusão lógica, que preservam o histórico).
create policy suppliers_select on public.suppliers for select to authenticated using (public.pode_ver_fornecedor(org_id));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (public.pode_gravar_fornecedor(org_id) and deleted_at is null);
create policy suppliers_update on public.suppliers for update to authenticated
  using (public.pode_gravar_fornecedor(org_id))
  with check (public.pode_gravar_fornecedor(org_id) and (deleted_at is null or public.org_role(org_id) = 'admin'));

create policy supplier_secondary_categories_select on public.supplier_secondary_categories for select to authenticated using (public.pode_ver_fornecedor(org_id));
create policy supplier_secondary_categories_write on public.supplier_secondary_categories for all to authenticated
  using (public.pode_gravar_fornecedor(org_id)) with check (public.pode_gravar_fornecedor(org_id));

-- Avaliações: quem recebe material (supervisor) também avalia; registro imutável (sem UPDATE/DELETE).
create policy supplier_evaluations_select on public.supplier_evaluations for select to authenticated using (public.pode_ver_fornecedor(org_id));
create policy supplier_evaluations_insert on public.supplier_evaluations for insert to authenticated
  with check (evaluated_by = auth.uid() and public.org_subscription_ok(org_id)
              and public.org_role(org_id) in ('admin', 'engenheiro', 'compras', 'financeiro', 'supervisor'));

create policy supplier_documents_select on public.supplier_documents for select to authenticated using (public.pode_ver_fornecedor(org_id));
create policy supplier_documents_insert on public.supplier_documents for insert to authenticated
  with check (public.pode_gravar_fornecedor(org_id) and uploaded_by = auth.uid() and deleted_at is null);
create policy supplier_documents_update on public.supplier_documents for update to authenticated
  using (public.pode_gravar_fornecedor(org_id)) with check (public.pode_gravar_fornecedor(org_id));

revoke all on public.supplier_categories, public.suppliers, public.supplier_secondary_categories,
  public.supplier_evaluations, public.supplier_documents from anon;
grant select, insert, update on public.supplier_categories, public.suppliers to authenticated;
grant select, insert, delete on public.supplier_secondary_categories to authenticated;
grant select, insert on public.supplier_evaluations to authenticated;
-- documento: só nome, tipo e exclusão lógica podem mudar (o arquivo e o autor ficam fixos)
grant select, insert on public.supplier_documents to authenticated;
revoke update on public.supplier_documents from authenticated;
grant update (name, kind, deleted_at) on public.supplier_documents to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Armazenamento de arquivos (Supabase Storage): bucket PRIVADO, caminho <empresa>/<área>/<registro>/<arquivo>.
-- Acesso só por URL assinada temporária, gerada para quem passa nas políticas abaixo.
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos', 'documentos', false, 52428800, array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'])
on conflict (id) do nothing;

-- Empresa e área a partir do caminho do arquivo.
create or replace function public.arquivo_org(p_name text) returns uuid
language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;
create or replace function public.pode_ler_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_ver_fornecedor(public.arquivo_org(p_name))
    else false end
$$;
create or replace function public.pode_gravar_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_gravar_fornecedor(public.arquivo_org(p_name))
    else false end
$$;

drop policy if exists documentos_select on storage.objects;
create policy documentos_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and public.pode_ler_arquivo(name));
drop policy if exists documentos_insert on storage.objects;
create policy documentos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and public.pode_gravar_arquivo(name));
-- Sem políticas de UPDATE/DELETE: arquivos enviados não são sobrescritos nem apagados pelo app
-- (a "exclusão" do documento é lógica, na tabela supplier_documents).
