-- GEPLAN · 0020 · Sobras de material: transferência entre obras e estoque da empresa.
-- Quando sobra material de uma obra, ele vai para outra obra ou para o estoque da empresa e o CUSTO VAI JUNTO, pelo
-- preço da compra: a obra de origem recebe um crédito (despesa negativa, ligada à transferência) e a de destino um custo
-- (despesa positiva). Para a empresa nada muda (o dinheiro saiu uma vez, na compra). No estoque o material é saldo (vale
-- dinheiro, não é custo) com CUSTO MÉDIO, e só vira custo quando sai para uma obra. Despesa de transferência não é conta a
-- pagar e não recebe pagamento. Cancelar desfaz tudo (com motivo). Somente acréscimos; RLS e auditoria.

-- ---------------------------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------------------------
-- quem movimenta material de/para uma obra: quem compra ou quem lança o financeiro da obra
create or replace function public.pode_movimentar_material(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.pode_comprar(p_project) or public.can_write_project(p_project, 'financeiro'), false)
$$;
-- estoque da empresa: vê quem trabalha com obra e compras (e o contador); movimenta quem tem a liberação de compras
create or replace function public.ve_estoque(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org)::text in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras', 'contador'), false)
$$;
create or replace function public.movimenta_estoque(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org)::text in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras')
                  and public.tem_liberacao(p_org, 'comprar') and public.org_subscription_ok(p_org), false)
$$;

-- ---------------------------------------------------------------------------------------------
-- Estoque da empresa
-- ---------------------------------------------------------------------------------------------
create table if not exists public.stock_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  description  text not null check (length(trim(description)) between 1 and 300),
  unit         text not null default '' check (length(unit) <= 20),
  quantity     numeric(18, 4) not null default 0 check (quantity >= 0),
  avg_cost     numeric(16, 4) not null default 0 check (avg_cost >= 0),
  location     text not null default '' check (length(location) <= 120),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, org_id)
);
create unique index if not exists stock_items_uq on public.stock_items (org_id, lower(trim(description)), lower(trim(unit)));
create trigger trg_stock_items_updated before update on public.stock_items for each row execute function public.set_updated_at();
create trigger trg_stock_items_audit after insert or update or delete on public.stock_items for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------------------------
-- Transferências de material (numeradas por empresa: TRF-0001)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.material_transfers (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete restrict,
  number            integer not null,
  transfer_date     date not null,
  description       text not null check (length(trim(description)) between 1 and 300),
  unit              text not null default '' check (length(unit) <= 20),
  quantity          numeric(18, 4) not null check (quantity > 0),
  unit_cost         numeric(16, 4) not null check (unit_cost >= 0),
  total             numeric(16, 2) not null check (total >= 0),
  from_project_id   uuid,
  from_phase_id     uuid,
  to_project_id     uuid,
  to_phase_id       uuid,
  purchase_item_id  uuid,                            -- item do pedido de compra de onde saiu a sobra (opcional)
  stock_item_id     uuid,
  from_client_funds boolean not null default false,  -- origem era obra por administração (material pago pelo cliente)
  notes             text not null default '' check (length(notes) <= 500),
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_label     text not null default '',
  created_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  cancel_reason     text not null default '',
  unique (id, org_id),
  unique (org_id, number),
  foreign key (from_project_id, org_id) references public.projects (id, org_id) on delete restrict,
  foreign key (to_project_id, org_id) references public.projects (id, org_id) on delete restrict,
  foreign key (stock_item_id, org_id) references public.stock_items (id, org_id) on delete restrict,
  check (from_project_id is not null or to_project_id is not null),
  check (from_project_id is distinct from to_project_id)
);
create index if not exists material_transfers_org_idx on public.material_transfers (org_id, transfer_date desc);
create trigger trg_material_transfers_audit after insert or update or delete on public.material_transfers for each row execute function public.audit_row();

create table if not exists public.stock_moves (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  stock_item_id  uuid not null,
  kind           text not null check (kind in ('entrada', 'saida', 'estorno')),
  quantity       numeric(18, 4) not null,           -- + entrada, − saída
  unit_cost      numeric(16, 4) not null,
  transfer_id    uuid,
  move_date      date not null,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (stock_item_id, org_id) references public.stock_items (id, org_id) on delete restrict,
  foreign key (transfer_id, org_id) references public.material_transfers (id, org_id) on delete restrict
);
create index if not exists stock_moves_item_idx on public.stock_moves (stock_item_id, created_at);
create trigger trg_stock_moves_audit after insert or update or delete on public.stock_moves for each row execute function public.audit_row();

-- despesas de transferência: podem ser negativas (crédito da obra de origem), não recebem pagamento e só mudam pelo sistema
alter table public.expenses add column if not exists transfer_id uuid;
alter table public.expenses drop constraint if exists expenses_amount_check;
alter table public.expenses add constraint expenses_amount_check check (amount >= 0 or transfer_id is not null);
create index if not exists expenses_transfer_idx on public.expenses (transfer_id) where transfer_id is not null;

create or replace function public.expense_transferencia_protegida() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('geplan.sistema', true) = '1' then return coalesce(new, old); end if;
  if tg_op = 'INSERT' and new.transfer_id is not null then
    raise exception 'Despesa de transferência é criada pela transferência de material.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.transfer_id is not null or new.transfer_id is not null)
     and (new.amount, new.project_id, new.transfer_id, new.deleted_at, new.expense_date, new.category, new.phase_id)
         is distinct from (old.amount, old.project_id, old.transfer_id, old.deleted_at, old.expense_date, old.category, old.phase_id) then
    raise exception 'Despesa de transferência de material: para desfazer, cancele a transferência (Estoque e sobras).' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_expenses_transferencia on public.expenses;
create trigger trg_expenses_transferencia before insert or update on public.expenses for each row execute function public.expense_transferencia_protegida();

create or replace function public.payment_sem_transferencia() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.expenses where id = new.expense_id and transfer_id is not null) then
    raise exception 'Transferência de material não é conta a pagar.' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_payments_sem_transferencia on public.payments;
create trigger trg_payments_sem_transferencia before insert on public.payments for each row execute function public.payment_sem_transferencia();

-- ---------------------------------------------------------------------------------------------
-- Registrar a transferência. Origem: uma obra (p_from_project) OU o estoque (p_stock_item). Destino: uma obra
-- (p_to_project) OU o estoque (p_to_stock). Custo: do estoque = custo médio; de obra = p_unit_cost (o app sugere o preço
-- do item da compra). Saindo de um item de pedido, não passa do que foi recebido menos o já transferido.
-- ---------------------------------------------------------------------------------------------
create or replace function public.registrar_transferencia(
  p_org uuid, p_date date, p_description text, p_unit text, p_quantity numeric, p_unit_cost numeric default null,
  p_from_project uuid default null, p_from_phase uuid default null, p_stock_item uuid default null,
  p_to_project uuid default null, p_to_phase uuid default null, p_to_stock boolean default false,
  p_purchase_item uuid default null, p_notes text default ''
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_num int; v_custo numeric; v_total numeric; s public.stock_items; v_rec numeric; v_ja numeric; v_cli boolean := false;
  v_desc text := trim(coalesce(p_description, '')); v_un text := trim(coalesce(p_unit, '')); v_dest_nome text; v_orig_nome text;
begin
  if p_quantity is null or p_quantity <= 0 then raise exception 'Informe a quantidade.' using errcode = '22023'; end if;
  if p_date is null or p_date > current_date then raise exception 'Informe a data (não pode ser futura).' using errcode = '22023'; end if;
  if (p_from_project is null) = (p_stock_item is null) then raise exception 'Escolha a origem: uma obra ou o estoque.' using errcode = '22023'; end if;
  if (p_to_project is null) = (not p_to_stock) then raise exception 'Escolha o destino: outra obra ou o estoque.' using errcode = '22023'; end if;
  if p_stock_item is not null and p_to_stock then raise exception 'Do estoque para o estoque não é transferência.' using errcode = '22023'; end if;
  if p_from_project is not null and p_from_project = p_to_project then raise exception 'Origem e destino são a mesma obra.' using errcode = '22023'; end if;
  -- obras da empresa e permissão de cada lado
  if p_from_project is not null then
    if public.project_org(p_from_project) is distinct from p_org then raise exception 'Obra de origem de outra empresa.' using errcode = '42501'; end if;
    if not public.pode_movimentar_material(p_from_project) then raise exception 'Seu usuário não movimenta material da obra de origem.' using errcode = '42501'; end if;
  end if;
  if p_to_project is not null then
    if public.project_org(p_to_project) is distinct from p_org then raise exception 'Obra de destino de outra empresa.' using errcode = '42501'; end if;
    if not public.pode_movimentar_material(p_to_project) then raise exception 'Seu usuário não movimenta material para a obra de destino.' using errcode = '42501'; end if;
  end if;
  if (p_stock_item is not null or p_to_stock) and not public.movimenta_estoque(p_org) then
    raise exception 'Seu usuário não movimenta o estoque da empresa.' using errcode = '42501';
  end if;
  -- origem: estoque
  if p_stock_item is not null then
    select * into s from public.stock_items where id = p_stock_item and org_id = p_org for update;
    if not found then raise exception 'Material do estoque não encontrado.' using errcode = '22023'; end if;
    if s.quantity < p_quantity - 0.00005 then
      raise exception 'O estoque tem só % % de %.', public.fmt_num(s.quantity), s.unit, s.description using errcode = '22023';
    end if;
    v_custo := s.avg_cost; v_desc := s.description; v_un := s.unit;
  else
    if length(v_desc) = 0 then raise exception 'Informe o material.' using errcode = '22023'; end if;
    v_custo := p_unit_cost;
    if v_custo is null or v_custo < 0 then raise exception 'Informe o custo unitário (o preço da compra).' using errcode = '22023'; end if;
    v_cli := coalesce((select client_funds from public.fin_cost_centers where project_id = p_from_project), false);
  end if;
  -- saindo de um item de pedido: até o recebido menos o já transferido
  if p_purchase_item is not null then
    if p_from_project is null or not exists (select 1 from public.purchase_items where id = p_purchase_item and project_id = p_from_project) then
      raise exception 'O item do pedido não é da obra de origem.' using errcode = '22023';
    end if;
    select coalesce(sum(di.quantity), 0) into v_rec from public.purchase_delivery_items di
      join public.purchase_deliveries d on d.id = di.delivery_id and d.deleted_at is null where di.item_id = p_purchase_item;
    select coalesce(sum(quantity), 0) into v_ja from public.material_transfers where purchase_item_id = p_purchase_item and cancelled_at is null;
    if p_quantity > v_rec - v_ja + 0.00005 then
      raise exception 'Do item foram recebidos % e já transferidos %: dá para transferir no máximo %.', public.fmt_num(v_rec), public.fmt_num(v_ja), public.fmt_num(v_rec - v_ja) using errcode = '22023';
    end if;
  end if;
  v_total := round(p_quantity * v_custo, 2);
  select coalesce(max(number), 0) + 1 into v_num from public.material_transfers where org_id = p_org;
  insert into public.material_transfers (org_id, number, transfer_date, description, unit, quantity, unit_cost, total, from_project_id, from_phase_id,
                                         to_project_id, to_phase_id, purchase_item_id, stock_item_id, from_client_funds, notes, created_label)
  values (p_org, v_num, p_date, v_desc, v_un, p_quantity, v_custo, v_total, p_from_project, p_from_phase, p_to_project, p_to_phase,
          p_purchase_item, p_stock_item, v_cli, coalesce(p_notes, ''), public.rotulo_usuario())
  returning id into v_id;
  select name into v_orig_nome from public.projects where id = p_from_project;
  select name into v_dest_nome from public.projects where id = p_to_project;
  perform set_config('geplan.sistema', '1', true);
  -- crédito na obra de origem
  if p_from_project is not null then
    insert into public.expenses (project_id, expense_date, document, description, category, amount, phase_id, transfer_id)
    values (p_from_project, p_date, 'TRF-' || lpad(v_num::text, 4, '0'), left('Sobra transferida para ' || coalesce(v_dest_nome, 'o estoque da empresa') || ': '
            || public.fmt_num(p_quantity) || coalesce(' ' || nullif(v_un, ''), '') || ' ' || v_desc, 300), 'Material', -v_total, p_from_phase, v_id);
  end if;
  -- custo na obra de destino
  if p_to_project is not null then
    insert into public.expenses (project_id, expense_date, document, description, category, amount, phase_id, transfer_id)
    values (p_to_project, p_date, 'TRF-' || lpad(v_num::text, 4, '0'), left('Material recebido ' || coalesce('da obra ' || v_orig_nome, 'do estoque da empresa') || ': '
            || public.fmt_num(p_quantity) || coalesce(' ' || nullif(v_un, ''), '') || ' ' || v_desc, 300), 'Material', v_total, p_to_phase, v_id);
  end if;
  -- estoque: entrada (custo médio) ou saída
  if p_to_stock then
    insert into public.stock_items (org_id, description, unit) values (p_org, v_desc, v_un)
      on conflict (org_id, lower(trim(description)), lower(trim(unit))) do nothing;
    select * into s from public.stock_items where org_id = p_org and lower(trim(description)) = lower(v_desc) and lower(trim(unit)) = lower(v_un) for update;
    update public.stock_items set avg_cost = case when s.quantity + p_quantity > 0 then (s.quantity * s.avg_cost + p_quantity * v_custo) / (s.quantity + p_quantity) else v_custo end,
           quantity = s.quantity + p_quantity where id = s.id;
    update public.material_transfers set stock_item_id = s.id where id = v_id;
    insert into public.stock_moves (org_id, stock_item_id, kind, quantity, unit_cost, transfer_id, move_date) values (p_org, s.id, 'entrada', p_quantity, v_custo, v_id, p_date);
  elsif p_stock_item is not null then
    update public.stock_items set quantity = quantity - p_quantity where id = p_stock_item;
    insert into public.stock_moves (org_id, stock_item_id, kind, quantity, unit_cost, transfer_id, move_date) values (p_org, p_stock_item, 'saida', -p_quantity, v_custo, v_id, p_date);
  end if;
  perform set_config('geplan.sistema', '', true);
  return v_id;
end $$;

-- Cancelar (com motivo): as duas despesas saem e o estoque volta (se ainda houver saldo do que entrou)
create or replace function public.cancelar_transferencia(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.material_transfers; s public.stock_items;
begin
  select * into t from public.material_transfers where id = p_id for update;
  if not found or t.cancelled_at is not null then raise exception 'Transferência não encontrada ou já cancelada.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  if (t.from_project_id is not null and not public.pode_movimentar_material(t.from_project_id))
     or (t.to_project_id is not null and not public.pode_movimentar_material(t.to_project_id))
     or (t.stock_item_id is not null and not public.movimenta_estoque(t.org_id)) then
    raise exception 'Seu usuário não pode cancelar esta transferência.' using errcode = '42501';
  end if;
  perform set_config('geplan.sistema', '1', true);
  if t.stock_item_id is not null then
    select * into s from public.stock_items where id = t.stock_item_id for update;
    if t.to_project_id is null then   -- tinha entrado no estoque: sai de novo
      if s.quantity < t.quantity - 0.00005 then
        raise exception 'O material já saiu do estoque (restam % %): cancele antes as transferências que usaram este saldo.', public.fmt_num(s.quantity), s.unit using errcode = '22023';
      end if;
      update public.stock_items set quantity = quantity - t.quantity where id = s.id;
      insert into public.stock_moves (org_id, stock_item_id, kind, quantity, unit_cost, transfer_id, move_date) values (t.org_id, s.id, 'estorno', -t.quantity, t.unit_cost, t.id, current_date);
    else                              -- tinha saído do estoque: volta pelo mesmo custo
      update public.stock_items set avg_cost = (quantity * avg_cost + t.quantity * t.unit_cost) / (quantity + t.quantity), quantity = quantity + t.quantity where id = s.id;
      insert into public.stock_moves (org_id, stock_item_id, kind, quantity, unit_cost, transfer_id, move_date) values (t.org_id, s.id, 'estorno', t.quantity, t.unit_cost, t.id, current_date);
    end if;
  end if;
  update public.expenses set deleted_at = now() where transfer_id = t.id and deleted_at is null;
  update public.material_transfers set cancelled_at = now(), cancel_reason = trim(p_reason) where id = t.id;
  perform set_config('geplan.sistema', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Acesso: leitura pela API; gravação só pelas funções
-- ---------------------------------------------------------------------------------------------
alter table public.stock_items        enable row level security;
alter table public.material_transfers enable row level security;
alter table public.stock_moves        enable row level security;
create policy stock_items_select on public.stock_items for select to authenticated using (public.ve_estoque(org_id));
create policy stock_items_update on public.stock_items for update to authenticated using (public.movimenta_estoque(org_id)) with check (public.movimenta_estoque(org_id));
create policy stock_moves_select on public.stock_moves for select to authenticated using (public.ve_estoque(org_id));
-- transferência: vê quem vê o estoque ou alguma das obras envolvidas
create policy material_transfers_select on public.material_transfers for select to authenticated
  using (public.ve_estoque(org_id) or (from_project_id is not null and public.can_read_costs(from_project_id))
         or (to_project_id is not null and public.can_read_costs(to_project_id)));

revoke all on public.stock_items, public.material_transfers, public.stock_moves from anon;
grant select on public.stock_items, public.material_transfers, public.stock_moves to authenticated;
grant update (location) on public.stock_items to authenticated;

revoke all on function public.expense_transferencia_protegida(), public.payment_sem_transferencia() from public, anon, authenticated;
revoke all on function public.registrar_transferencia(uuid, date, text, text, numeric, numeric, uuid, uuid, uuid, uuid, uuid, boolean, uuid, text),
  public.cancelar_transferencia(uuid, text) from public, anon;
grant execute on function public.registrar_transferencia(uuid, date, text, text, numeric, numeric, uuid, uuid, uuid, uuid, uuid, boolean, uuid, text),
  public.cancelar_transferencia(uuid, text) to authenticated;
