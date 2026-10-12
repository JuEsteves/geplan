-- GEPLAN · 0007 · Suprimentos: liberações por pessoa e pedido de compra principal com grupos de materiais.
-- Um pedido (PED-0001) reúne vários grupos (madeira, tijolos, cimento…); cada grupo tem itens, cotações, fornecedor,
-- compra, previsão e entregas próprios. A situação do pedido é CALCULADA pelo banco a partir dos grupos: ninguém marca
-- o pedido como concluído à mão. Compra sem etapa de aprovação (decisão da empresa; a etapa existe, desligada na tela).
-- Somente acréscimos. Funções existentes que passam a considerar as liberações: pode_gravar_fornecedor, o ramo
-- 'compras' de can_write_project e pode_ler_arquivo/pode_gravar_arquivo (nova área 'suprimentos'); as liberações
-- padrão reproduzem exatamente as regras anteriores de cada perfil.

-- ---------------------------------------------------------------------------------------------
-- Liberações por pessoa (o administrador marca o que cada pessoa pode fazer)
--   solicitar     criar pedidos de materiais para as obras que a pessoa vê
--   comprar       cotar, registrar compras, conduzir grupos; contratos e pedidos no Financeiro
--   receber       registrar entregas e recebimentos na obra
--   fornecedores  cadastrar e editar fornecedores
-- permissions = null → usa o padrão do perfil. Administrador tem todas; cliente, nenhuma (sempre).
-- ---------------------------------------------------------------------------------------------
alter table public.organization_members add column if not exists permissions text[];
do $$ begin
  alter table public.organization_members add constraint organization_members_permissions_validas
    check (permissions is null or permissions <@ array['solicitar', 'comprar', 'receber', 'fornecedores']);
exception when duplicate_object then null; end $$;

create or replace function public.liberacoes_padrao(p_role public.member_role) returns text[]
language sql immutable as $$
  select case p_role
    when 'admin'      then array['solicitar', 'comprar', 'receber', 'fornecedores']
    when 'engenheiro' then array['solicitar', 'comprar', 'receber', 'fornecedores']
    when 'compras'    then array['solicitar', 'comprar', 'receber', 'fornecedores']
    when 'financeiro' then array['solicitar', 'comprar', 'fornecedores']
    when 'supervisor' then array['solicitar', 'receber']
    else array[]::text[]
  end
$$;

-- O usuário logado tem a liberação nesta empresa?
create or replace function public.tem_liberacao(p_org uuid, p_chave text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when m.role = 'admin' then true
      when m.role = 'cliente' then false
      else p_chave = any(coalesce(m.permissions, public.liberacoes_padrao(m.role)))
    end
    from public.organization_members m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
    where m.org_id = p_org and m.user_id = auth.uid()), false)
$$;

-- Liberações efetivas do usuário logado (para a interface; quem decide é o banco).
create or replace function public.minhas_liberacoes(p_org uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(k order by k), array[]::text[])
  from unnest(array['solicitar', 'comprar', 'receber', 'fornecedores']) k
  where public.tem_liberacao(p_org, k)
$$;

-- Só o administrador altera liberações (política members_update já existente); a coluna passa a ser gravável.
grant update (permissions) on public.organization_members to authenticated;

-- Fornecedores: gravação passa a seguir a liberação "fornecedores" (padrão = admin, engenheiro, compras, financeiro).
create or replace function public.pode_gravar_fornecedor(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tem_liberacao(p_org, 'fornecedores') and public.org_subscription_ok(p_org)
$$;

-- Escrita por área: 'compras' passa a seguir a liberação "comprar" (padrão = admin, engenheiro, compras, financeiro),
-- sempre para quem vê a obra e não é cliente. As demais áreas não mudam.
create or replace function public.can_write_project(p_project uuid, p_area text) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_area
    when 'cadastro'      then public.project_role(p_project) in ('admin', 'engenheiro')
    when 'planejamento'  then public.project_role(p_project) in ('admin', 'engenheiro')
    when 'execucao'      then public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor')
    when 'financeiro'    then public.project_role(p_project) in ('admin', 'engenheiro', 'financeiro')
    when 'compras'       then public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras')
                              and public.tem_liberacao(public.project_org(p_project), 'comprar')
    else false
  end and public.org_subscription_ok(public.project_org(p_project))
$$;

create or replace function public.pode_solicitar(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_read_costs(p_project) and public.tem_liberacao(public.project_org(p_project), 'solicitar')
         and public.org_subscription_ok(public.project_org(p_project))
$$;
create or replace function public.pode_comprar(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_write_project(p_project, 'compras')
$$;
create or replace function public.pode_receber(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_read_costs(p_project) and public.tem_liberacao(public.project_org(p_project), 'receber')
         and public.org_subscription_ok(public.project_org(p_project))
$$;

-- ---------------------------------------------------------------------------------------------
-- Utilitários de texto (histórico legível) e marca de "operação do sistema"
-- As funções de negócio (security definer) ligam geplan.sistema = '1' na transação para poder gravar os campos que
-- o usuário não altera diretamente (situação, compra, entregas). set_config não é exposto pela API.
-- ---------------------------------------------------------------------------------------------
create or replace function public.eh_sistema() returns boolean
language sql stable as $$ select coalesce(current_setting('geplan.sistema', true), '') = '1' $$;

create or replace function public.rotulo_usuario() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(full_name, ''), email) from public.user_profiles where id = auth.uid()), '')
$$;

create or replace function public.fmt_num(p numeric) returns text
language sql immutable as $$ select replace(trim_scale(p)::text, '.', ',') $$;
-- R$ 1.234,50 (sem to_char, que arredonda diferente entre versões)
create or replace function public.fmt_brl(p numeric) returns text
language sql immutable as $$
  select 'R$ ' || case when round(p, 2) < 0 then '-' else '' end
    || regexp_replace(trunc(abs(round(p, 2)))::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
    || ',' || lpad(((abs(round(p, 2)) - trunc(abs(round(p, 2)))) * 100)::int::text, 2, '0')
$$;

create or replace function public.rotulo_grupo_status(p text) returns text
language sql immutable as $$
  select case p
    when 'analise' then 'Aguardando análise' when 'cotacao' then 'Em cotação' when 'aprovacao' then 'Aguardando aprovação'
    when 'comprado' then 'Compra realizada' when 'aguardando_entrega' then 'Aguardando entrega'
    when 'retirada' then 'Disponível para retirada' when 'entrega_parcial' then 'Entrega parcial'
    when 'entregue' then 'Entregue e conferido' when 'cancelado' then 'Cancelado' when 'resolvido' then 'Pendência resolvida'
    else p end
$$;
create or replace function public.rotulo_pedido_status(p text) returns text
language sql immutable as $$
  select case p
    when 'pedido' then 'Pedido de compra' when 'em_cotacao' then 'Em cotação' when 'em_andamento' then 'Em andamento'
    when 'aguardando_entrega' then 'Compra realizada / aguardando entrega' when 'concluido' then 'Entregue / concluído'
    when 'cancelado' then 'Cancelado' else p end
$$;

-- ---------------------------------------------------------------------------------------------
-- Fase da obra no pedido de compra do Financeiro (custos por fase)
-- ---------------------------------------------------------------------------------------------
alter table public.contracts add column if not exists phase_id uuid;
do $$ begin
  alter table public.contracts add constraint contracts_phase_fk foreign key (phase_id, project_id)
    references public.wbs_nodes (id, project_id) on delete restrict;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------------------------
-- Pedido principal
-- ---------------------------------------------------------------------------------------------
create table if not exists public.purchase_orders (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,   -- definido pelo banco
  project_id         uuid not null references public.projects (id) on delete restrict,
  number             integer not null default 0,                                              -- PED-0001 (por empresa)
  title              text not null check (length(trim(title)) between 2 and 160),
  phase_id           uuid,
  priority           text not null default 'normal' check (priority in ('normal', 'urgente')),
  needed_date        date,
  delivery_location  text not null default '',
  notes              text not null default '',
  buyer_label        text not null default '',                                                -- comprador responsável
  status             text not null default 'pedido'
                     check (status in ('pedido', 'em_cotacao', 'em_andamento', 'aguardando_entrega', 'concluido', 'cancelado')),
  stage              smallint not null default 1 check (stage between 1 and 4),               -- coluna do quadro
  requested_by       uuid default auth.uid() references auth.users (id) on delete set null,
  requester_label    text not null default '',
  concluded_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (id, project_id),
  foreign key (phase_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict
);
create unique index if not exists purchase_orders_numero on public.purchase_orders (org_id, number);
create index if not exists purchase_orders_project_idx on public.purchase_orders (project_id, stage) where deleted_at is null;
create trigger trg_purchase_orders_updated before update on public.purchase_orders for each row execute function public.set_updated_at();
create trigger trg_purchase_orders_audit after insert or update or delete on public.purchase_orders for each row execute function public.audit_row();

create or replace function public.purchase_order_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select org_id into new.org_id from public.projects where id = new.project_id;
    perform pg_advisory_xact_lock(hashtext('purchase_orders:' || new.org_id::text));
    select coalesce(max(number), 0) + 1 into new.number from public.purchase_orders where org_id = new.org_id;
    new.status := 'pedido'; new.stage := 1; new.concluded_at := null;
    if new.requester_label = '' then new.requester_label := public.rotulo_usuario(); end if;
    return new;
  end if;
  if new.project_id is distinct from old.project_id or new.org_id is distinct from old.org_id or new.number is distinct from old.number
     or new.requested_by is distinct from old.requested_by or new.created_at is distinct from old.created_at then
    raise exception 'Obra, número e autor do pedido não podem ser alterados.' using errcode = '42501';
  end if;
  if not public.eh_sistema() and (new.status is distinct from old.status or new.stage is distinct from old.stage
     or new.concluded_at is distinct from old.concluded_at or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'A situação do pedido é calculada a partir dos grupos e não pode ser alterada diretamente.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_purchase_orders_before before insert or update on public.purchase_orders
  for each row execute function public.purchase_order_before();

-- ---------------------------------------------------------------------------------------------
-- Grupos de materiais (cada um com fluxo próprio)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.purchase_groups (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null,
  project_id           uuid not null,
  position             integer not null default 0,
  name                 text not null check (length(trim(name)) between 1 and 80),
  category_id          uuid references public.supplier_categories (id) on delete restrict,
  description          text not null default '',
  notes                text not null default '',
  status               text not null default 'analise' check (status in ('analise', 'cotacao', 'aprovacao', 'comprado',
                         'aguardando_entrega', 'retirada', 'entrega_parcial', 'entregue', 'cancelado', 'resolvido')),
  -- compra (gravada pela função registrar_compra_grupo)
  supplier_id          uuid references public.suppliers (id) on delete restrict,
  supplier_name        text not null default '',
  quote_id             uuid,
  quoted_amount        numeric(16, 2) check (quoted_amount is null or quoted_amount >= 0),   -- total da cotação escolhida
  amount               numeric(16, 2) check (amount is null or amount >= 0),                 -- valor comprado (materiais)
  freight              numeric(16, 2) check (freight is null or freight >= 0),
  payment_terms        text not null default '',
  purchase_date        date,
  contract_id          uuid,                                                                   -- compromisso no Financeiro
  -- previsão e retirada (editáveis por compras)
  expected_date        date,
  expected_kind        text not null default 'estimada' check (expected_kind in ('estimada', 'confirmada')),
  pickup_address       text not null default '',
  pickup_instructions  text not null default '',
  -- encerramento formal
  resolution_reason    text not null default '',
  resolved_label       text not null default '',
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (id, project_id),
  foreign key (order_id, project_id) references public.purchase_orders (id, project_id) on delete restrict,
  foreign key (contract_id, project_id) references public.contracts (id, project_id) on delete restrict
);
create index if not exists purchase_groups_order_idx on public.purchase_groups (order_id, position) where deleted_at is null;
create index if not exists purchase_groups_supplier_idx on public.purchase_groups (supplier_id) where supplier_id is not null;
create trigger trg_purchase_groups_updated before update on public.purchase_groups for each row execute function public.set_updated_at();
create trigger trg_purchase_groups_audit after insert or update or delete on public.purchase_groups for each row execute function public.audit_row();
create trigger trg_purchase_groups_supplier_org before insert or update of supplier_id on public.purchase_groups
  for each row execute function public.check_supplier_org();

create or replace function public.purchase_group_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ped text;
begin
  if new.category_id is not null and not exists (select 1 from public.supplier_categories c join public.projects p on p.org_id = c.org_id
                                                  where c.id = new.category_id and p.id = new.project_id) then
    raise exception 'Categoria de outra empresa.' using errcode = '42501';
  end if;
  if public.eh_sistema() then return new; end if;
  if tg_op = 'INSERT' then
    select status into v_ped from public.purchase_orders where id = new.order_id;
    if v_ped in ('concluido', 'cancelado') then
      raise exception 'O pedido já está %; abra um novo pedido.', public.rotulo_pedido_status(v_ped) using errcode = '42501';
    end if;
    new.status := 'analise'; new.supplier_id := null; new.supplier_name := ''; new.quote_id := null; new.quoted_amount := null;
    new.amount := null; new.freight := null; new.payment_terms := ''; new.purchase_date := null; new.contract_id := null;
    new.resolution_reason := ''; new.resolved_label := ''; new.resolved_at := null; new.deleted_at := null;
    return new;
  end if;
  if new.order_id is distinct from old.order_id or new.project_id is distinct from old.project_id then
    raise exception 'O grupo não muda de pedido.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'Use as ações do grupo para mudar a etapa (o banco confere cada passagem).' using errcode = '42501';
  end if;
  if new.supplier_id is distinct from old.supplier_id or new.supplier_name is distinct from old.supplier_name
     or new.quote_id is distinct from old.quote_id or new.quoted_amount is distinct from old.quoted_amount
     or new.amount is distinct from old.amount or new.freight is distinct from old.freight
     or new.payment_terms is distinct from old.payment_terms or new.purchase_date is distinct from old.purchase_date
     or new.contract_id is distinct from old.contract_id or new.resolution_reason is distinct from old.resolution_reason
     or new.resolved_label is distinct from old.resolved_label or new.resolved_at is distinct from old.resolved_at then
    raise exception 'Dados da compra são gravados pela ação "Registrar compra".' using errcode = '42501';
  end if;
  if new.deleted_at is not null and old.deleted_at is null and old.status <> 'analise' then
    raise exception 'Só grupo ainda em análise pode ser excluído; depois disso, cancele com o motivo.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_purchase_groups_before before insert or update on public.purchase_groups
  for each row execute function public.purchase_group_before();

-- Itens do grupo
create table if not exists public.purchase_items (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null,
  project_id   uuid not null,
  position     integer not null default 0,
  description  text not null check (length(trim(description)) between 1 and 300),
  quantity     numeric(18, 4) not null check (quantity > 0),
  unit         text not null default '' check (length(unit) <= 20),
  spec         text not null default '',                 -- especificação técnica
  notes        text not null default '',
  required     boolean not null default true,            -- obrigatório para concluir o grupo
  created_at   timestamptz not null default now(),
  unique (id, project_id),
  foreign key (group_id, project_id) references public.purchase_groups (id, project_id) on delete cascade
);
create index if not exists purchase_items_group_idx on public.purchase_items (group_id, position);
create trigger trg_purchase_items_audit after insert or update or delete on public.purchase_items for each row execute function public.audit_row();

-- Cotações (por grupo)
create table if not exists public.purchase_quotes (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null,
  project_id      uuid not null,
  supplier_id     uuid references public.suppliers (id) on delete restrict,
  supplier_name   text not null check (length(trim(supplier_name)) between 2 and 160),
  total_amount    numeric(16, 2) not null check (total_amount >= 0),
  freight_amount  numeric(16, 2) check (freight_amount is null or freight_amount >= 0),
  lead_days       integer check (lead_days is null or lead_days between 0 and 3650),
  payment_terms   text not null default '',
  valid_until     date,
  notes           text not null default '',
  status          text not null default 'recebida' check (status in ('recebida', 'escolhida', 'descartada')),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  foreign key (group_id, project_id) references public.purchase_groups (id, project_id) on delete restrict
);
create index if not exists purchase_quotes_group_idx on public.purchase_quotes (group_id) where deleted_at is null;
create index if not exists purchase_quotes_supplier_idx on public.purchase_quotes (supplier_id) where supplier_id is not null;
create trigger trg_purchase_quotes_updated before update on public.purchase_quotes for each row execute function public.set_updated_at();
create trigger trg_purchase_quotes_audit after insert or update or delete on public.purchase_quotes for each row execute function public.audit_row();
create trigger trg_purchase_quotes_supplier_org before insert or update of supplier_id on public.purchase_quotes
  for each row execute function public.check_supplier_org();

-- Entregas (registradas pela função registrar_entrega) e quantidades por item
create table if not exists public.purchase_deliveries (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null,
  project_id      uuid not null,
  delivery_date   date not null,
  kind            text not null default 'entrega' check (kind in ('entrega', 'retirada')),
  quantity_ok     boolean not null default true,
  issue           text not null default 'nenhuma' check (issue in ('nenhuma', 'falta', 'avaria', 'produto_diferente', 'outro')),
  invoice         text not null default '',
  notes           text not null default '',
  received_by     uuid default auth.uid() references auth.users (id) on delete set null,
  receiver_label  text not null default '',
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  undo_reason     text not null default '',
  unique (id, project_id),
  foreign key (group_id, project_id) references public.purchase_groups (id, project_id) on delete restrict
);
create index if not exists purchase_deliveries_group_idx on public.purchase_deliveries (group_id) where deleted_at is null;
create trigger trg_purchase_deliveries_audit after insert or update or delete on public.purchase_deliveries for each row execute function public.audit_row();

create table if not exists public.purchase_delivery_items (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null,
  item_id      uuid not null,
  project_id   uuid not null,
  quantity     numeric(18, 4) not null check (quantity > 0),
  foreign key (delivery_id, project_id) references public.purchase_deliveries (id, project_id) on delete restrict,
  foreign key (item_id, project_id) references public.purchase_items (id, project_id) on delete restrict
);
create index if not exists purchase_delivery_items_item_idx on public.purchase_delivery_items (item_id);
create trigger trg_purchase_delivery_items_audit after insert or update or delete on public.purchase_delivery_items for each row execute function public.audit_row();

-- Histórico e comentários do pedido (o sistema registra as mudanças; usuários comentam)
create table if not exists public.purchase_events (
  id            bigint generated always as identity primary key,
  order_id      uuid not null,
  project_id    uuid not null,
  group_id      uuid,
  kind          text not null check (kind in ('comentario', 'pedido', 'grupo', 'status', 'quantidade', 'fornecedor', 'cotacao',
                                              'compra', 'previsao', 'entrega', 'cancelamento', 'resolucao', 'anexo')),
  body          text not null check (length(trim(body)) between 1 and 2000),
  author_id     uuid default auth.uid() references auth.users (id) on delete set null,
  author_label  text not null default '',
  created_at    timestamptz not null default now(),
  foreign key (order_id, project_id) references public.purchase_orders (id, project_id) on delete restrict
);
create index if not exists purchase_events_order_idx on public.purchase_events (order_id, created_at);

create or replace function public.purchase_event_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author_id := auth.uid();
  new.author_label := public.rotulo_usuario();
  new.created_at := now();
  return new;
end $$;
create trigger trg_purchase_events_before before insert on public.purchase_events
  for each row execute function public.purchase_event_before();

create or replace function public.evento_compra(p_order uuid, p_project uuid, p_group uuid, p_kind text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into public.purchase_events (order_id, project_id, group_id, kind, body) values (p_order, p_project, p_group, p_kind, left(p_body, 2000))
$$;

-- Anexos (fotos, especificações, comprovantes) no Storage privado: <empresa>/suprimentos/<pedido>/<arquivo>
create table if not exists public.purchase_files (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null,
  project_id    uuid not null,
  group_id      uuid,
  delivery_id   uuid,
  kind          text not null default 'Outro' check (kind in ('Especificação', 'Foto', 'Comprovante', 'Proposta', 'Outro')),
  name          text not null check (length(trim(name)) between 1 and 200),
  storage_path  text not null unique,
  mime_type     text not null default '',
  size_bytes    bigint not null check (size_bytes between 1 and 52428800),
  uploaded_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (order_id, project_id) references public.purchase_orders (id, project_id) on delete restrict,
  foreign key (group_id, project_id) references public.purchase_groups (id, project_id) on delete restrict,
  foreign key (delivery_id, project_id) references public.purchase_deliveries (id, project_id) on delete restrict
);
create index if not exists purchase_files_order_idx on public.purchase_files (order_id) where deleted_at is null;
create trigger trg_purchase_files_audit after insert or update or delete on public.purchase_files for each row execute function public.audit_row();

create or replace function public.purchase_file_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.purchase_orders where id = new.order_id;
  if new.storage_path not like v_org::text || '/suprimentos/' || new.order_id::text || '/%' then
    raise exception 'Caminho do arquivo não corresponde ao pedido.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then new.uploaded_by := auth.uid(); end if;
  return new;
end $$;
create trigger trg_purchase_files_before before insert or update of storage_path on public.purchase_files
  for each row execute function public.purchase_file_before();

-- ---------------------------------------------------------------------------------------------
-- Cálculo da situação (grupo e pedido)
-- Etapa (coluna do quadro) de cada grupo: 1 análise · 2 cotação/aprovação · 3 comprado até entrega parcial ·
-- 4 encerrado (entregue e conferido, pendência resolvida ou cancelado).
-- Pedido: sem grupos → Pedido de compra; todos cancelados → Cancelado; todos encerrados → Entregue / concluído;
-- senão fica na coluna do grupo MENOS adiantado; se os grupos abertos estão em etapas diferentes (ou parte já
-- encerrou), a situação é "Em andamento".
-- ---------------------------------------------------------------------------------------------
create or replace function public.etapa_grupo(p text) returns smallint
language sql immutable as $$
  select case when p = 'analise' then 1 when p in ('cotacao', 'aprovacao') then 2
              when p in ('comprado', 'aguardando_entrega', 'retirada', 'entrega_parcial') then 3 else 4 end::smallint
$$;

create or replace function public.recalc_pedido(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  o public.purchase_orders;
  v_total int; v_cancel int; v_fech int; v_min int; v_max int; v_status text; v_stage int;
begin
  select * into o from public.purchase_orders where id = p_order;
  select count(*), count(*) filter (where status = 'cancelado'), count(*) filter (where public.etapa_grupo(status) = 4),
         min(public.etapa_grupo(status)) filter (where public.etapa_grupo(status) < 4),
         max(public.etapa_grupo(status)) filter (where public.etapa_grupo(status) < 4)
    into v_total, v_cancel, v_fech, v_min, v_max
    from public.purchase_groups where order_id = p_order and deleted_at is null;
  if v_total = 0 then v_status := 'pedido'; v_stage := 1;
  elsif v_cancel = v_total then v_status := 'cancelado'; v_stage := 4;
  elsif v_fech = v_total then v_status := 'concluido'; v_stage := 4;
  else
    v_stage := v_min;
    v_status := case when v_min <> v_max or v_fech > 0 then 'em_andamento'
                     when v_min = 1 then 'pedido' when v_min = 2 then 'em_cotacao' else 'aguardando_entrega' end;
  end if;
  if v_status is distinct from o.status or v_stage is distinct from o.stage then
    perform set_config('geplan.sistema', '1', true);
    update public.purchase_orders set status = v_status, stage = v_stage,
           concluded_at = case when v_status = 'concluido' then coalesce(o.concluded_at, now()) else null end
     where id = p_order;
    perform public.evento_compra(p_order, o.project_id, null, 'status', case
      when v_status is distinct from o.status then 'Situação do pedido: ' || public.rotulo_pedido_status(o.status) || ' → ' || public.rotulo_pedido_status(v_status)
      else 'Pedido passou para a coluna "' || (array['Pedido de compra', 'Em cotação', 'Compra realizada / aguardando entrega', 'Entregue / concluído'])[v_stage]
           || '" (' || public.rotulo_pedido_status(v_status) || ')' end);
  end if;
end $$;

-- Recalcula o grupo a partir das entregas: todos os itens obrigatórios recebidos por completo → Entregue e conferido;
-- alguma entrega → Entrega parcial; nenhuma → volta para Aguardando entrega. O compromisso no Financeiro acompanha.
create or replace function public.recalc_grupo(p_group uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups; v_n int; v_completo boolean; v_status text;
begin
  select * into g from public.purchase_groups where id = p_group;
  if g.status not in ('cancelado', 'resolvido') and g.contract_id is not null then
    select count(*) into v_n from public.purchase_deliveries where group_id = g.id and deleted_at is null;
    select coalesce(bool_and(coalesce(r.qtd, 0) >= i.quantity), true) into v_completo
      from public.purchase_items i
      left join (select di.item_id, sum(di.quantity) qtd from public.purchase_delivery_items di
                 join public.purchase_deliveries d on d.id = di.delivery_id and d.deleted_at is null group by di.item_id) r on r.item_id = i.id
     where i.group_id = g.id and i.required;
    v_status := case when v_n = 0 then case when g.status in ('entregue', 'entrega_parcial') then 'aguardando_entrega' else g.status end
                     when v_completo then 'entregue' else 'entrega_parcial' end;
    perform set_config('geplan.sistema', '1', true);
    if v_status <> g.status then update public.purchase_groups set status = v_status where id = g.id; end if;
    update public.contracts set status = case v_status when 'entregue' then 'Entregue' when 'entrega_parcial' then 'Entregue parcialmente' else 'Aprovado' end
     where id = g.contract_id and status not in ('Cancelado', 'Encerrado');
  end if;
  perform public.recalc_pedido(g.order_id);
end $$;

-- Histórico automático dos grupos e itens.
create or replace function public.purchase_group_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.evento_compra(new.order_id, new.project_id, new.id, 'grupo', 'Grupo "' || new.name || '" incluído.');
  else
    if new.status is distinct from old.status then
      perform public.evento_compra(new.order_id, new.project_id, new.id, 'status',
        new.name || ': ' || public.rotulo_grupo_status(old.status) || ' → ' || public.rotulo_grupo_status(new.status));
    end if;
    if new.supplier_name is distinct from old.supplier_name and old.supplier_name <> '' then
      perform public.evento_compra(new.order_id, new.project_id, new.id, 'fornecedor',
        new.name || ': fornecedor ' || old.supplier_name || ' → ' || new.supplier_name);
    end if;
    if new.expected_date is distinct from old.expected_date or new.expected_kind is distinct from old.expected_kind then
      perform public.evento_compra(new.order_id, new.project_id, new.id, 'previsao',
        new.name || ': previsão de entrega ' || coalesce(to_char(new.expected_date, 'DD/MM/YYYY') || ' (' || new.expected_kind || ')', 'removida')
        || coalesce(' — antes ' || to_char(old.expected_date, 'DD/MM/YYYY'), ''));
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      perform public.evento_compra(new.order_id, new.project_id, new.id, 'grupo', 'Grupo "' || new.name || '" excluído (estava em análise).');
    end if;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at then
    perform public.recalc_pedido(new.order_id);
  end if;
  return null;
end $$;
create trigger trg_purchase_groups_after after insert or update on public.purchase_groups
  for each row execute function public.purchase_group_after();

-- Itens só mudam enquanto o grupo não foi comprado; mudança de quantidade fica no histórico.
create or replace function public.purchase_item_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups;
begin
  select * into g from public.purchase_groups where id = coalesce(new.group_id, old.group_id);
  if not public.eh_sistema() and public.etapa_grupo(g.status) > 2 then
    raise exception 'O grupo "%" já está em "%": os itens não mudam mais.', g.name, public.rotulo_grupo_status(g.status) using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.group_id is distinct from old.group_id then
    raise exception 'O item não muda de grupo.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.quantity is distinct from old.quantity then
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'quantidade',
      g.name || ': ' || new.description || ' ' || public.fmt_num(old.quantity) || ' → ' || public.fmt_num(new.quantity) || coalesce(' ' || nullif(new.unit, ''), ''));
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_purchase_items_before before insert or update or delete on public.purchase_items
  for each row execute function public.purchase_item_before();

-- Cotação: só em grupo antes da compra; a primeira põe o grupo "Em cotação". Escolhida não muda mais.
create or replace function public.purchase_quote_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups;
begin
  select * into g from public.purchase_groups where id = new.group_id;
  if public.eh_sistema() then return new; end if;
  if tg_op = 'INSERT' then
    if public.etapa_grupo(g.status) > 2 then
      raise exception 'O grupo "%" já está em "%" e não recebe cotações.', g.name, public.rotulo_grupo_status(g.status) using errcode = '42501';
    end if;
    new.status := 'recebida';
    return new;
  end if;
  if new.status is distinct from old.status then
    raise exception 'A cotação é escolhida pela ação "Registrar compra".' using errcode = '42501';
  end if;
  if old.status = 'escolhida' then
    raise exception 'A cotação escolhida já gerou a compra e não pode ser alterada.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_purchase_quotes_before before insert or update on public.purchase_quotes
  for each row execute function public.purchase_quote_before();

create or replace function public.purchase_quote_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups;
begin
  select * into g from public.purchase_groups where id = new.group_id;
  if tg_op = 'INSERT' then
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'cotacao', g.name || ': cotação de ' || new.supplier_name || ' — '
      || public.fmt_brl(new.total_amount + coalesce(new.freight_amount, 0)) || coalesce(', prazo ' || new.lead_days || ' dia(s)', ''));
    if g.status = 'analise' then
      perform set_config('geplan.sistema', '1', true);
      update public.purchase_groups set status = 'cotacao' where id = g.id;
    end if;
  elsif new.deleted_at is not null and old.deleted_at is null then
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'cotacao', g.name || ': cotação de ' || new.supplier_name || ' excluída.');
  end if;
  return null;
end $$;
create trigger trg_purchase_quotes_after after insert or update on public.purchase_quotes
  for each row execute function public.purchase_quote_after();

create or replace function public.purchase_order_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.evento_compra(new.id, new.project_id, null, 'pedido', 'Pedido PED-' || lpad(new.number::text, 4, '0') || ' criado: ' || new.title);
  elsif new.needed_date is distinct from old.needed_date then
    perform public.evento_compra(new.id, new.project_id, null, 'previsao', 'Data necessária: '
      || coalesce(to_char(old.needed_date, 'DD/MM/YYYY'), '—') || ' → ' || coalesce(to_char(new.needed_date, 'DD/MM/YYYY'), '—'));
  end if;
  return null;
end $$;
create trigger trg_purchase_orders_after after insert or update on public.purchase_orders
  for each row execute function public.purchase_order_after();

-- ---------------------------------------------------------------------------------------------
-- Ações (funções chamadas pelo app). Todas conferem a liberação de quem chama.
-- ---------------------------------------------------------------------------------------------

-- Passagens manuais de etapa: entre análise/cotação/aprovação (antes da compra) e entre compra realizada/aguardando
-- entrega/disponível para retirada (depois da compra). Entregue, cancelado e resolvido têm ações próprias.
create or replace function public.mudar_etapa_grupo(p_group uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups;
begin
  select * into g from public.purchase_groups where id = p_group and deleted_at is null for update;
  if not found then raise exception 'Grupo não encontrado.' using errcode = '22023'; end if;
  if not public.pode_comprar(g.project_id) then
    raise exception 'Seu usuário não tem a liberação de compras nesta obra.' using errcode = '42501';
  end if;
  if g.status = p_status then return; end if;
  if not ((g.status in ('analise', 'cotacao', 'aprovacao') and p_status in ('analise', 'cotacao', 'aprovacao'))
       or (g.status in ('comprado', 'aguardando_entrega', 'retirada', 'entrega_parcial') and p_status in ('comprado', 'aguardando_entrega', 'retirada')
           and not (g.status = 'entrega_parcial' and p_status = 'comprado'))) then
    raise exception 'De "%" para "%" não é uma passagem manual: %', public.rotulo_grupo_status(g.status), public.rotulo_grupo_status(p_status),
      case when p_status in ('comprado', 'aguardando_entrega', 'retirada') then 'registre a compra primeiro.'
           when p_status in ('entrega_parcial', 'entregue') then 'registre as entregas (o banco calcula).'
           when p_status in ('cancelado', 'resolvido') then 'use "Cancelar grupo" ou "Resolver pendência", com o motivo.'
           else 'o grupo já foi comprado.' end using errcode = '22023';
  end if;
  perform set_config('geplan.sistema', '1', true);
  update public.purchase_groups set status = p_status where id = g.id;
end $$;

-- Registra a compra do grupo (a partir de uma cotação ou direta) e cria o compromisso no Financeiro da obra.
create or replace function public.registrar_compra_grupo(
  p_group uuid, p_quote uuid default null, p_supplier_id uuid default null, p_supplier_name text default '',
  p_amount numeric default null, p_freight numeric default null, p_payment_terms text default '',
  p_purchase_date date default null, p_expected_date date default null, p_expected_kind text default 'estimada'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  g public.purchase_groups; o public.purchase_orders; q public.purchase_quotes;
  v_sup uuid := p_supplier_id; v_nome text := trim(coalesce(p_supplier_name, '')); v_valor numeric := p_amount; v_frete numeric := p_freight;
  v_termos text := coalesce(p_payment_terms, ''); v_cotado numeric; v_itens text; v_id uuid;
begin
  select * into g from public.purchase_groups where id = p_group and deleted_at is null for update;
  if not found then raise exception 'Grupo não encontrado.' using errcode = '22023'; end if;
  if not public.pode_comprar(g.project_id) then
    raise exception 'Seu usuário não tem a liberação de compras nesta obra.' using errcode = '42501';
  end if;
  if public.etapa_grupo(g.status) > 2 then
    raise exception 'O grupo "%" já está em "%".', g.name, public.rotulo_grupo_status(g.status) using errcode = '22023';
  end if;
  select * into o from public.purchase_orders where id = g.order_id;
  if p_quote is not null then
    select * into q from public.purchase_quotes where id = p_quote and group_id = g.id and deleted_at is null;
    if not found then raise exception 'Cotação não encontrada neste grupo.' using errcode = '22023'; end if;
    v_sup := q.supplier_id; v_nome := q.supplier_name; v_valor := q.total_amount; v_frete := q.freight_amount;
    v_termos := coalesce(nullif(v_termos, ''), q.payment_terms); v_cotado := q.total_amount + coalesce(q.freight_amount, 0);
  end if;
  if length(v_nome) < 2 then raise exception 'Informe o fornecedor da compra.' using errcode = '22023'; end if;
  if v_valor is null or v_valor < 0 then raise exception 'Informe o valor da compra.' using errcode = '22023'; end if;
  if v_frete is not null and v_frete < 0 then raise exception 'Frete inválido.' using errcode = '22023'; end if;
  if p_expected_kind not in ('estimada', 'confirmada') then raise exception 'Previsão deve ser estimada ou confirmada.' using errcode = '22023'; end if;
  if v_sup is not null and exists (select 1 from public.suppliers where id = v_sup and status <> 'ativo') then
    raise exception 'O fornecedor está inativo.' using errcode = '22023';
  end if;
  select string_agg(public.fmt_num(quantity) || coalesce(' ' || nullif(unit, ''), '') || ' ' || description, '; ' order by position)
    into v_itens from public.purchase_items where group_id = g.id;
  insert into public.contracts (project_id, kind, number, supplier_name, supplier_id, category, amount, status, contract_date,
                                scope, needed_date, phase_id)
  values (g.project_id, 'Pedido', left('PED-' || lpad(o.number::text, 4, '0') || ' · ' || g.name, 120), v_nome, v_sup, 'Material',
          v_valor + coalesce(v_frete, 0), 'Aprovado', coalesce(p_purchase_date, current_date),
          left(o.title || ' — ' || g.name || coalesce(': ' || v_itens, ''), 2000), coalesce(p_expected_date, o.needed_date), o.phase_id)
  returning id into v_id;
  perform set_config('geplan.sistema', '1', true);
  if p_quote is not null then
    update public.purchase_quotes set status = 'escolhida' where id = p_quote;
    update public.purchase_quotes set status = 'descartada' where group_id = g.id and id <> p_quote and status = 'recebida' and deleted_at is null;
  end if;
  update public.purchase_groups set supplier_id = v_sup, supplier_name = v_nome, quote_id = p_quote, quoted_amount = v_cotado,
         amount = v_valor, freight = v_frete, payment_terms = v_termos, purchase_date = coalesce(p_purchase_date, current_date),
         contract_id = v_id, expected_date = coalesce(p_expected_date, expected_date), expected_kind = p_expected_kind,
         status = case when p_expected_date is not null then 'aguardando_entrega' else 'comprado' end
   where id = g.id;
  perform public.evento_compra(g.order_id, g.project_id, g.id, 'compra', g.name || ': compra realizada com ' || v_nome || ' — '
    || public.fmt_brl(v_valor + coalesce(v_frete, 0)) || case when v_frete is not null then ' (frete ' || public.fmt_brl(v_frete) || ')' else '' end);
  return v_id;
end $$;

-- Registra uma entrega (ou retirada) do grupo, com a quantidade recebida de cada item.
-- p_itens = [{"item_id": "...", "quantity": 10}, ...]
create or replace function public.registrar_entrega(
  p_group uuid, p_date date, p_items jsonb, p_kind text default 'entrega', p_quantity_ok boolean default true,
  p_issue text default 'nenhuma', p_invoice text default '', p_notes text default ''
) returns uuid
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups; v_id uuid; v_it jsonb; v_item public.purchase_items; v_q numeric; v_n int := 0; v_txt text := '';
begin
  select * into g from public.purchase_groups where id = p_group and deleted_at is null for update;
  if not found then raise exception 'Grupo não encontrado.' using errcode = '22023'; end if;
  if not public.pode_receber(g.project_id) then
    raise exception 'Seu usuário não tem a liberação para registrar entregas nesta obra.' using errcode = '42501';
  end if;
  if g.status not in ('comprado', 'aguardando_entrega', 'retirada', 'entrega_parcial') then
    raise exception 'O grupo "%" está em "%": só grupos comprados e ainda não entregues recebem entregas.', g.name, public.rotulo_grupo_status(g.status) using errcode = '22023';
  end if;
  if p_date is null or p_date > current_date then raise exception 'A data do recebimento não pode ser futura.' using errcode = '22023'; end if;
  if p_kind not in ('entrega', 'retirada') then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
  insert into public.purchase_deliveries (group_id, project_id, delivery_date, kind, quantity_ok, issue, invoice, notes, received_by, receiver_label)
  values (g.id, g.project_id, p_date, p_kind, coalesce(p_quantity_ok, true), coalesce(p_issue, 'nenhuma'), coalesce(p_invoice, ''),
          coalesce(p_notes, ''), auth.uid(), public.rotulo_usuario())
  returning id into v_id;
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_q := nullif(v_it ->> 'quantity', '')::numeric;
    if v_q is null or v_q = 0 then continue; end if;
    if v_q < 0 then raise exception 'Quantidade recebida negativa.' using errcode = '22023'; end if;
    select * into v_item from public.purchase_items where id = (v_it ->> 'item_id')::uuid and group_id = g.id;
    if not found then raise exception 'Item não pertence a este grupo.' using errcode = '22023'; end if;
    insert into public.purchase_delivery_items (delivery_id, item_id, project_id, quantity) values (v_id, v_item.id, g.project_id, v_q);
    v_n := v_n + 1;
    v_txt := v_txt || case when v_txt = '' then '' else '; ' end || public.fmt_num(v_q) || coalesce(' ' || nullif(v_item.unit, ''), '') || ' ' || v_item.description;
  end loop;
  if v_n = 0 then raise exception 'Informe a quantidade recebida de pelo menos um item.' using errcode = '22023'; end if;
  perform public.evento_compra(g.order_id, g.project_id, g.id, 'entrega', g.name || ': ' || case when p_kind = 'retirada' then 'retirada' else 'entrega' end
    || ' em ' || to_char(p_date, 'DD/MM/YYYY') || ' — ' || v_txt
    || case when coalesce(p_issue, 'nenhuma') <> 'nenhuma' then ' · ocorrência: ' || p_issue else '' end
    || case when not coalesce(p_quantity_ok, true) then ' · quantidade divergente' else '' end);
  perform public.recalc_grupo(g.id);
  return v_id;
end $$;

-- Desfaz uma entrega lançada errada (exclusão lógica, com motivo); o grupo e o pedido são recalculados.
create or replace function public.desfazer_entrega(p_delivery uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.purchase_deliveries; g public.purchase_groups;
begin
  select * into d from public.purchase_deliveries where id = p_delivery and deleted_at is null for update;
  if not found then raise exception 'Entrega não encontrada.' using errcode = '22023'; end if;
  select * into g from public.purchase_groups where id = d.group_id;
  if not (public.pode_comprar(d.project_id) or (d.received_by = auth.uid() and public.pode_receber(d.project_id))) then
    raise exception 'Só quem registrou a entrega ou a equipe de compras pode desfazer.' using errcode = '42501';
  end if;
  if g.status in ('cancelado', 'resolvido') then raise exception 'O grupo já foi encerrado.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  update public.purchase_deliveries set deleted_at = now(), undo_reason = trim(p_reason) where id = d.id;
  perform public.evento_compra(g.order_id, g.project_id, g.id, 'entrega', g.name || ': registro de entrega de '
    || to_char(d.delivery_date, 'DD/MM/YYYY') || ' desfeito — ' || trim(p_reason));
  perform public.recalc_grupo(g.id);
end $$;

-- Encerramento formal do grupo, com motivo: cancelar (antes de receber qualquer entrega) ou resolver a pendência
-- (comprado, faltando parte; o que foi recebido continua registrado).
create or replace function public.encerrar_grupo(p_group uuid, p_acao text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups; v_ent int;
begin
  select * into g from public.purchase_groups where id = p_group and deleted_at is null for update;
  if not found then raise exception 'Grupo não encontrado.' using errcode = '22023'; end if;
  if not public.pode_comprar(g.project_id) then
    raise exception 'Seu usuário não tem a liberação de compras nesta obra.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  if g.status in ('entregue', 'cancelado', 'resolvido') then
    raise exception 'O grupo já está em "%".', public.rotulo_grupo_status(g.status) using errcode = '22023';
  end if;
  select count(*) into v_ent from public.purchase_deliveries where group_id = g.id and deleted_at is null;
  if p_acao = 'cancelar' then
    if v_ent > 0 then raise exception 'O grupo já recebeu entregas: use "Resolver pendência".' using errcode = '22023'; end if;
  elsif p_acao = 'resolver' then
    if g.contract_id is null then raise exception 'O grupo ainda não foi comprado: use "Cancelar grupo".' using errcode = '22023'; end if;
  else raise exception 'Ação inválida.' using errcode = '22023';
  end if;
  perform set_config('geplan.sistema', '1', true);
  update public.purchase_groups set status = case when p_acao = 'cancelar' then 'cancelado' else 'resolvido' end,
         resolution_reason = trim(p_reason), resolved_label = public.rotulo_usuario(), resolved_at = now()
   where id = g.id;
  update public.purchase_quotes set status = 'descartada' where group_id = g.id and status = 'recebida' and deleted_at is null;
  if g.contract_id is not null then
    update public.contracts set status = case when p_acao = 'cancelar' then 'Cancelado' else 'Encerrado' end where id = g.contract_id;
  end if;
  perform public.evento_compra(g.order_id, g.project_id, g.id, case when p_acao = 'cancelar' then 'cancelamento' else 'resolucao' end,
    g.name || ': ' || case when p_acao = 'cancelar' then 'grupo cancelado' else 'pendência resolvida' end || ' — ' || trim(p_reason));
end $$;

-- O que impede o pedido de ser concluído (lista legível, para a tela explicar).
create or replace function public.pendencias_pedido(p_order uuid) returns table (grupo text, pendencia text)
language sql stable security definer set search_path = public as $$
  select g.name, case
      when g.status in ('analise', 'cotacao', 'aprovacao') then 'ainda não comprado (' || public.rotulo_grupo_status(g.status) || ')'
      when g.status in ('comprado', 'aguardando_entrega', 'retirada') then 'aguardando entrega'
      else 'entrega parcial' end
    || coalesce(' — faltam: ' || (
      select string_agg(public.fmt_num(i.quantity - coalesce(r.qtd, 0)) || coalesce(' ' || nullif(i.unit, ''), '') || ' ' || i.description, '; ' order by i.position)
        from public.purchase_items i
        left join (select di.item_id, sum(di.quantity) qtd from public.purchase_delivery_items di
                   join public.purchase_deliveries d on d.id = di.delivery_id and d.deleted_at is null group by di.item_id) r on r.item_id = i.id
       where i.group_id = g.id and i.required and coalesce(r.qtd, 0) < i.quantity and g.status = 'entrega_parcial'), '')
  from public.purchase_groups g
  where g.order_id = p_order and g.deleted_at is null and public.etapa_grupo(g.status) < 4
    and public.can_read_costs(g.project_id)
  order by g.position
$$;

-- ---------------------------------------------------------------------------------------------
-- Arquivos: nova área 'suprimentos' no Storage (pasta do pedido)
-- ---------------------------------------------------------------------------------------------
create or replace function public.pode_ler_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_ver_fornecedor(public.arquivo_org(p_name))
    when 'suprimentos' then exists (select 1 from public.purchase_orders po where po.id::text = split_part(p_name, '/', 3)
                                    and po.org_id = public.arquivo_org(p_name) and public.can_read_costs(po.project_id))
    else false end
$$;
create or replace function public.pode_gravar_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_gravar_fornecedor(public.arquivo_org(p_name))
    when 'suprimentos' then exists (select 1 from public.purchase_orders po where po.id::text = split_part(p_name, '/', 3)
                                    and po.org_id = public.arquivo_org(p_name)
                                    and (public.pode_solicitar(po.project_id) or public.pode_comprar(po.project_id) or public.pode_receber(po.project_id)))
    else false end
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.purchase_orders          enable row level security;
alter table public.purchase_groups          enable row level security;
alter table public.purchase_items           enable row level security;
alter table public.purchase_quotes          enable row level security;
alter table public.purchase_deliveries      enable row level security;
alter table public.purchase_delivery_items  enable row level security;
alter table public.purchase_events          enable row level security;
alter table public.purchase_files           enable row level security;

-- Pedido: quem vê custos da obra acompanha; quem tem "solicitar" cria em nome próprio e edita enquanto ninguém
-- começou a comprar; quem tem "comprar" edita os dados gerais.
create policy purchase_orders_select on public.purchase_orders for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_orders_insert on public.purchase_orders for insert to authenticated
  with check (public.pode_solicitar(project_id) and requested_by = auth.uid() and deleted_at is null);
create policy purchase_orders_update on public.purchase_orders for update to authenticated
  using (public.pode_comprar(project_id) or (requested_by = auth.uid() and status = 'pedido' and public.pode_solicitar(project_id)))
  with check (public.pode_comprar(project_id) or (requested_by = auth.uid() and public.pode_solicitar(project_id)));

-- Grupos e itens: compras sempre; o solicitante no próprio pedido enquanto o grupo está em análise.
create or replace function public.pode_editar_grupo(p_order uuid, p_project uuid, p_status text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pode_comprar(p_project) or (coalesce(p_status, 'analise') = 'analise' and public.pode_solicitar(p_project)
         and exists (select 1 from public.purchase_orders where id = p_order and requested_by = auth.uid()))
$$;
create policy purchase_groups_select on public.purchase_groups for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_groups_insert on public.purchase_groups for insert to authenticated
  with check (public.pode_editar_grupo(order_id, project_id, 'analise'));
create policy purchase_groups_update on public.purchase_groups for update to authenticated
  using (public.pode_editar_grupo(order_id, project_id, status)) with check (public.pode_editar_grupo(order_id, project_id, 'analise') or public.pode_comprar(project_id));

create policy purchase_items_select on public.purchase_items for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_items_write on public.purchase_items for all to authenticated
  using (exists (select 1 from public.purchase_groups g where g.id = group_id and public.pode_editar_grupo(g.order_id, g.project_id, g.status)))
  with check (exists (select 1 from public.purchase_groups g where g.id = group_id and public.pode_editar_grupo(g.order_id, g.project_id, g.status)));

create policy purchase_quotes_select on public.purchase_quotes for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_quotes_insert on public.purchase_quotes for insert to authenticated
  with check (public.pode_comprar(project_id) and created_by = auth.uid() and deleted_at is null);
create policy purchase_quotes_update on public.purchase_quotes for update to authenticated
  using (public.pode_comprar(project_id)) with check (public.pode_comprar(project_id));

-- Entregas: só leitura pela API; gravação pelas funções registrar_entrega/desfazer_entrega.
create policy purchase_deliveries_select on public.purchase_deliveries for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_delivery_items_select on public.purchase_delivery_items for select to authenticated using (public.can_read_costs(project_id));

-- Histórico: leitura para quem vê o pedido; usuários só incluem comentários (o resto é do sistema). Nada é apagado.
create policy purchase_events_select on public.purchase_events for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_events_insert on public.purchase_events for insert to authenticated
  with check (kind = 'comentario' and public.can_read_costs(project_id) and public.org_subscription_ok(public.project_org(project_id)));

create policy purchase_files_select on public.purchase_files for select to authenticated using (public.can_read_costs(project_id));
create policy purchase_files_insert on public.purchase_files for insert to authenticated
  with check (deleted_at is null and (public.pode_solicitar(project_id) or public.pode_comprar(project_id) or public.pode_receber(project_id)));
create policy purchase_files_update on public.purchase_files for update to authenticated
  using (uploaded_by = auth.uid() or public.pode_comprar(project_id)) with check (uploaded_by = auth.uid() or public.pode_comprar(project_id));

revoke all on public.purchase_orders, public.purchase_groups, public.purchase_items, public.purchase_quotes, public.purchase_deliveries,
  public.purchase_delivery_items, public.purchase_events, public.purchase_files from anon;
grant select, insert, update on public.purchase_orders, public.purchase_groups, public.purchase_quotes to authenticated;
grant select, insert, update, delete on public.purchase_items to authenticated;
grant select on public.purchase_deliveries, public.purchase_delivery_items to authenticated;
grant select, insert on public.purchase_events to authenticated;
grant select, insert on public.purchase_files to authenticated;
grant update (name, kind, deleted_at) on public.purchase_files to authenticated;

-- Funções internas não são chamadas pela API; as ações sim (cada uma confere a liberação).
revoke all on function public.recalc_pedido(uuid), public.recalc_grupo(uuid),
  public.evento_compra(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.mudar_etapa_grupo(uuid, text), public.registrar_compra_grupo(uuid, uuid, uuid, text, numeric, numeric, text, date, date, text),
  public.registrar_entrega(uuid, date, jsonb, text, boolean, text, text, text), public.desfazer_entrega(uuid, text),
  public.encerrar_grupo(uuid, text, text), public.pendencias_pedido(uuid), public.minhas_liberacoes(uuid) from public, anon;
grant execute on function public.mudar_etapa_grupo(uuid, text), public.registrar_compra_grupo(uuid, uuid, uuid, text, numeric, numeric, text, date, date, text),
  public.registrar_entrega(uuid, date, jsonb, text, boolean, text, text, text), public.desfazer_entrega(uuid, text),
  public.encerrar_grupo(uuid, text, text), public.pendencias_pedido(uuid), public.minhas_liberacoes(uuid) to authenticated;
