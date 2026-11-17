-- GEPLAN · 0017 · Compras simplificadas: o pedido é uma lista simples; quem compra separa os itens em ORDENS DE COMPRA
-- (os "grupos" de antes, agora com letra fixa: PED-0012-A, PED-0012-B…), uma por fornecedor; preço de cada item na
-- compra; e os DOCUMENTOS do fornecedor (nota fiscal, pedido do fornecedor ou recibo) ligados à ordem de compra, cada
-- um virando a conta a pagar daquela compra no Financeiro da obra (sem contar duas vezes: a despesa abate o compromisso).
-- Somente acréscimos e regras novas; nada do que já existe é apagado. Tabelas e colunas novas com RLS e auditoria.

-- ---------------------------------------------------------------------------------------------
-- 1. Letra fixa da ordem de compra (não muda quando outra ordem é excluída)
-- ---------------------------------------------------------------------------------------------
create or replace function public.letra_oc(n integer) returns text
language sql immutable as $$
  select case when n < 26 then chr(65 + n) else chr(64 + n / 26) || chr(65 + n % 26) end
$$;

alter table public.purchase_groups add column if not exists letter text not null default '';
-- ordens que já existem: letra pela posição (e pela data de criação), contando as excluídas
update public.purchase_groups g set letter = x.l
  from (select id, public.letra_oc((row_number() over (partition by order_id order by position, created_at, id) - 1)::int) l
          from public.purchase_groups) x
 where x.id = g.id and g.letter = '';
create unique index if not exists purchase_groups_letter_uq on public.purchase_groups (order_id, letter);

create or replace function public.purchase_group_letra() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.letter := public.letra_oc((select count(*)::int from public.purchase_groups where order_id = new.order_id));
  return new;
end $$;
drop trigger if exists trg_purchase_groups_letra on public.purchase_groups;
create trigger trg_purchase_groups_letra before insert on public.purchase_groups
  for each row execute function public.purchase_group_letra();

-- a letra não é editada (é a referência da nota fiscal)
create or replace function public.purchase_group_letra_fixa() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.letter is distinct from old.letter then
    raise exception 'A letra da ordem de compra não muda.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_purchase_groups_letra_fixa on public.purchase_groups;
create trigger trg_purchase_groups_letra_fixa before update of letter on public.purchase_groups
  for each row execute function public.purchase_group_letra_fixa();

create or replace function public.codigo_oc(p_group uuid) returns text
language sql stable security definer set search_path = public as $$
  select 'PED-' || lpad(o.number::text, 4, '0') || '-' || g.letter
    from public.purchase_groups g join public.purchase_orders o on o.id = g.order_id where g.id = p_group
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Preço de cada item na compra
-- ---------------------------------------------------------------------------------------------
alter table public.purchase_items add column if not exists unit_price numeric(16, 4) check (unit_price is null or unit_price >= 0);

-- Itens: mudam só antes da compra; mudam de ordem de compra e recebem preço só pelas ações do banco.
create or replace function public.purchase_item_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups;
begin
  select * into g from public.purchase_groups where id = coalesce(new.group_id, old.group_id);
  if not public.eh_sistema() and public.etapa_grupo(g.status) > 2 then
    raise exception 'O grupo "%" já está em "%": os itens não mudam mais.', g.name, public.rotulo_grupo_status(g.status) using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.group_id is distinct from old.group_id and not public.eh_sistema() then
    raise exception 'O item não muda de grupo (use "Separar itens").' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.unit_price is distinct from old.unit_price and not public.eh_sistema() then
    raise exception 'O preço do item é informado na compra.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and not public.eh_sistema() then new.unit_price := null; end if;
  if tg_op = 'UPDATE' and new.quantity is distinct from old.quantity then
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'quantidade',
      g.name || ': ' || new.description || ' ' || public.fmt_num(old.quantity) || ' → ' || public.fmt_num(new.quantity) || coalesce(' ' || nullif(new.unit, ''), ''));
  end if;
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Separar itens em ordens de compra (antes da compra)
-- Move os itens escolhidos para uma ordem de compra existente do MESMO pedido ou para uma nova (p_nome). Ordem que
-- fica sem itens é excluída. Quem pode: compras; o solicitante, no próprio pedido, enquanto tudo está em análise.
-- ---------------------------------------------------------------------------------------------
-- p_itens = ["uuid", "uuid", ...] (JSON, como o app envia)
create or replace function public.separar_itens(p_itens jsonb, p_destino uuid default null, p_nome text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_order uuid; v_project uuid; v_dest public.purchase_groups; v_n int; v_pos int; r record; v_nome text := trim(coalesce(p_nome, ''));
  v_origens text := ''; p_items uuid[];
begin
  if jsonb_typeof(p_itens) <> 'array' then raise exception 'Escolha pelo menos um item.' using errcode = '22023'; end if;
  -- sem repetidos, na ordem em que vieram
  p_items := array(select t.x::uuid from jsonb_array_elements_text(p_itens) with ordinality t(x, n) group by t.x order by min(t.n));
  if p_items is null or cardinality(p_items) = 0 then raise exception 'Escolha pelo menos um item.' using errcode = '22023'; end if;
  select min(g.order_id::text)::uuid, min(g.project_id::text)::uuid, count(distinct g.order_id) into v_order, v_project, v_n
    from public.purchase_items i join public.purchase_groups g on g.id = i.group_id where i.id = any(p_items);
  if v_order is null then raise exception 'Itens não encontrados.' using errcode = '22023'; end if;
  if v_n > 1 then raise exception 'Os itens precisam ser do mesmo pedido.' using errcode = '22023'; end if;
  if (select count(*) from public.purchase_items where id = any(p_items)) <> cardinality(p_items) then
    raise exception 'Itens não encontrados.' using errcode = '22023';
  end if;
  for r in select distinct g.* from public.purchase_items i join public.purchase_groups g on g.id = i.group_id where i.id = any(p_items) loop
    if r.deleted_at is not null or public.etapa_grupo(r.status) > 2 then
      raise exception 'A ordem "%" já foi comprada ou encerrada: os itens dela não mudam mais.', r.name using errcode = '22023';
    end if;
    if not public.pode_editar_grupo(r.order_id, r.project_id, r.status) then
      raise exception 'Seu usuário não pode separar os itens deste pedido.' using errcode = '42501';
    end if;
  end loop;
  if p_destino is not null then
    select * into v_dest from public.purchase_groups where id = p_destino and deleted_at is null for update;
    if not found or v_dest.order_id <> v_order then raise exception 'A ordem de compra de destino não é deste pedido.' using errcode = '22023'; end if;
    if public.etapa_grupo(v_dest.status) > 2 then raise exception 'A ordem "%" já foi comprada.', v_dest.name using errcode = '22023'; end if;
    if not public.pode_editar_grupo(v_dest.order_id, v_dest.project_id, v_dest.status) then
      raise exception 'Seu usuário não pode alterar esta ordem de compra.' using errcode = '42501';
    end if;
  else
    if length(v_nome) not between 1 and 80 then raise exception 'Dê um nome à nova ordem de compra (ex.: Cimento e conexões).' using errcode = '22023'; end if;
    select coalesce(max(position), -1) + 1 into v_pos from public.purchase_groups where order_id = v_order;
    insert into public.purchase_groups (order_id, project_id, name, position) values (v_order, v_project, v_nome, v_pos)
      returning * into v_dest;
  end if;
  select string_agg(distinct g.name, ', ') into v_origens from public.purchase_items i join public.purchase_groups g on g.id = i.group_id
   where i.id = any(p_items) and g.id <> v_dest.id;
  perform set_config('geplan.sistema', '1', true);
  select coalesce(max(position), -1) into v_pos from public.purchase_items where group_id = v_dest.id;
  update public.purchase_items i set group_id = v_dest.id, position = v_pos + x.ord
    from (select id, row_number() over (order by array_position(p_items, id))::int ord from public.purchase_items where id = any(p_items)) x
   where x.id = i.id and i.group_id <> v_dest.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.evento_compra(v_order, v_project, v_dest.id, 'grupo', v_n || ' item(ns) de "' || coalesce(v_origens, '') || '" passaram para "' || v_dest.name || '"'
      || case when exists (select 1 from public.purchase_quotes q where q.group_id = v_dest.id and q.deleted_at is null) then ' — confira as cotações dela.' else '.' end);
  end if;
  -- ordens que ficaram sem itens saem do pedido
  update public.purchase_groups g set deleted_at = now()
   where g.order_id = v_order and g.deleted_at is null and g.id <> v_dest.id and public.etapa_grupo(g.status) <= 2
     and not exists (select 1 from public.purchase_items i where i.group_id = g.id);
  perform public.recalc_pedido(v_order);
  return v_dest.id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Preço de cada item (na compra ou depois, enquanto a ordem não foi cancelada)
-- p_precos = [{"item_id": "...", "unit_price": 12.5}, ...]  (vazio/nulo apaga o preço do item)
-- ---------------------------------------------------------------------------------------------
create or replace function public.definir_precos_itens(p_group uuid, p_precos jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare g public.purchase_groups; v_it jsonb; v_preco numeric; v_soma numeric;
begin
  select * into g from public.purchase_groups where id = p_group and deleted_at is null for update;
  if not found then raise exception 'Ordem de compra não encontrada.' using errcode = '22023'; end if;
  if not public.pode_comprar(g.project_id) then
    raise exception 'Seu usuário não tem a liberação de compras nesta obra.' using errcode = '42501';
  end if;
  if g.contract_id is null or g.status = 'cancelado' then
    raise exception 'O preço por item é informado depois de registrar a compra.' using errcode = '22023';
  end if;
  perform set_config('geplan.sistema', '1', true);
  for v_it in select * from jsonb_array_elements(coalesce(p_precos, '[]'::jsonb)) loop
    v_preco := nullif(v_it ->> 'unit_price', '')::numeric;
    if v_preco is not null and v_preco < 0 then raise exception 'Preço inválido.' using errcode = '22023'; end if;
    update public.purchase_items set unit_price = v_preco where id = (v_it ->> 'item_id')::uuid and group_id = g.id;
    if not found then raise exception 'O item não pertence a esta ordem de compra.' using errcode = '22023'; end if;
  end loop;
  select sum(quantity * unit_price) into v_soma from public.purchase_items where group_id = g.id and unit_price is not null;
  if v_soma is not null then
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'compra', g.name || ': preço por item informado (itens somam ' || public.fmt_brl(v_soma) || ').');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Documentos do fornecedor ligados à ordem de compra
-- ---------------------------------------------------------------------------------------------
alter table public.purchase_files drop constraint if exists purchase_files_kind_check;
alter table public.purchase_files add constraint purchase_files_kind_check
  check (kind in ('Especificação', 'Foto', 'Comprovante', 'Proposta', 'Nota fiscal', 'Pedido do fornecedor', 'Outro'));

create table if not exists public.purchase_documents (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null,
  order_id       uuid not null,
  project_id     uuid not null,
  kind           text not null check (kind in ('nota_fiscal', 'pedido_fornecedor', 'recibo')),
  number         text not null check (length(trim(number)) between 1 and 60),
  series         text not null default '' check (length(series) <= 10),
  issue_date     date not null,
  amount         numeric(16, 2) not null check (amount > 0),
  due_date       date,
  access_key     text not null default '' check (access_key = '' or access_key ~ '^[0-9]{44}$'),   -- chave da NF-e
  file_id        uuid references public.purchase_files (id) on delete set null,
  expense_id     uuid,
  notes          text not null default '' check (length(notes) <= 500),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_label  text not null default '',
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  cancel_reason  text not null default '',
  unique (id, project_id),
  foreign key (group_id, project_id) references public.purchase_groups (id, project_id) on delete restrict,
  foreign key (order_id, project_id) references public.purchase_orders (id, project_id) on delete restrict,
  foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict
);
create index if not exists purchase_documents_group_idx on public.purchase_documents (group_id) where deleted_at is null;
create unique index if not exists purchase_documents_chave_uq on public.purchase_documents (access_key) where access_key <> '' and deleted_at is null;
create trigger trg_purchase_documents_audit after insert or update or delete on public.purchase_documents for each row execute function public.audit_row();

create or replace function public.rotulo_documento_compra(p_kind text, p_number text, p_series text default '') returns text
language sql immutable as $$
  select case p_kind when 'nota_fiscal' then 'NF ' when 'pedido_fornecedor' then 'Pedido ' else 'Recibo ' end
    || p_number || case when coalesce(p_series, '') <> '' then '/' || p_series else '' end
$$;

-- Registra o documento e, se p_lancar, a conta a pagar (despesa ligada ao compromisso da compra: abate o saldo dele,
-- não soma de novo). p_substitui = um "pedido do fornecedor" desta ordem que a nota fiscal agora substitui (a mesma
-- despesa é atualizada, nada é contado duas vezes).
create or replace function public.registrar_documento_compra(
  p_group uuid, p_kind text, p_number text, p_issue_date date, p_amount numeric, p_due_date date default null,
  p_series text default '', p_access_key text default '', p_notes text default '', p_file uuid default null,
  p_lancar boolean default true, p_substitui uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  g public.purchase_groups; o public.purchase_orders; d public.purchase_documents; v_id uuid; v_exp uuid; v_rot text; v_pago numeric;
  v_chave text := regexp_replace(coalesce(p_access_key, ''), '\D', '', 'g'); v_docs numeric; v_compra numeric;
begin
  select * into g from public.purchase_groups where id = p_group and deleted_at is null for update;
  if not found then raise exception 'Ordem de compra não encontrada.' using errcode = '22023'; end if;
  if not (public.pode_comprar(g.project_id) or public.can_write_project(g.project_id, 'financeiro')) then
    raise exception 'Seu usuário não registra documentos de compra nesta obra.' using errcode = '42501';
  end if;
  if g.contract_id is null or g.status = 'cancelado' then
    raise exception 'Registre a compra antes da nota ou do pedido do fornecedor.' using errcode = '22023';
  end if;
  if p_kind not in ('nota_fiscal', 'pedido_fornecedor', 'recibo') then raise exception 'Tipo de documento inválido.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_number, ''))) = 0 then raise exception 'Informe o número do documento.' using errcode = '22023'; end if;
  if p_issue_date is null or p_issue_date > current_date then raise exception 'Informe a data do documento (não pode ser futura).' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Informe o valor do documento.' using errcode = '22023'; end if;
  if v_chave <> '' and length(v_chave) <> 44 then raise exception 'A chave da nota fiscal tem 44 números.' using errcode = '22023'; end if;
  if p_file is not null and not exists (select 1 from public.purchase_files where id = p_file and order_id = g.order_id and deleted_at is null) then
    raise exception 'O arquivo não é deste pedido.' using errcode = '22023';
  end if;
  select * into o from public.purchase_orders where id = g.order_id;
  v_rot := public.rotulo_documento_compra(p_kind, trim(p_number), trim(coalesce(p_series, '')));

  if p_substitui is not null then
    select * into d from public.purchase_documents where id = p_substitui and group_id = g.id and deleted_at is null for update;
    if not found then raise exception 'Documento a substituir não encontrado nesta ordem de compra.' using errcode = '22023'; end if;
    if d.kind <> 'pedido_fornecedor' then raise exception 'Só o pedido do fornecedor é substituído pela nota.' using errcode = '22023'; end if;
    if d.expense_id is not null then
      select coalesce(sum(amount), 0) into v_pago from public.payments where expense_id = d.expense_id and deleted_at is null;
      if v_pago > p_amount + 0.005 then raise exception 'Já foi pago % neste documento, mais que o valor novo.', public.fmt_brl(v_pago) using errcode = '22023'; end if;
      update public.expenses set document = v_rot, amount = p_amount, expense_date = p_issue_date, due_date = coalesce(p_due_date, due_date)
       where id = d.expense_id;
    elsif p_lancar then
      insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, contract_id, amount, due_date, phase_id)
      values (g.project_id, p_issue_date, v_rot, g.supplier_name, g.supplier_id, left(public.codigo_oc(g.id) || ' · ' || g.name, 300), 'Material',
              g.contract_id, p_amount, p_due_date, o.phase_id)
      returning id into v_exp;
    end if;
    update public.purchase_documents set kind = p_kind, number = trim(p_number), series = trim(coalesce(p_series, '')), issue_date = p_issue_date,
           amount = p_amount, due_date = p_due_date, access_key = v_chave, notes = coalesce(p_notes, ''), file_id = coalesce(p_file, file_id),
           expense_id = coalesce(expense_id, v_exp)
     where id = d.id;
    v_id := d.id;
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'anexo', g.name || ': ' || public.rotulo_documento_compra(d.kind, d.number, d.series)
      || ' substituído por ' || v_rot || ' — ' || public.fmt_brl(p_amount) || '.');
  else
    if exists (select 1 from public.purchase_documents where group_id = g.id and kind = p_kind and number = trim(p_number)
                and series = trim(coalesce(p_series, '')) and deleted_at is null) then
      raise exception '% já está registrado nesta ordem de compra.', v_rot using errcode = '23505';
    end if;
    if p_lancar then
      insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, contract_id, amount, due_date, phase_id)
      values (g.project_id, p_issue_date, v_rot, g.supplier_name, g.supplier_id, left(public.codigo_oc(g.id) || ' · ' || g.name, 300), 'Material',
              g.contract_id, p_amount, p_due_date, o.phase_id)
      returning id into v_exp;
    end if;
    insert into public.purchase_documents (group_id, order_id, project_id, kind, number, series, issue_date, amount, due_date, access_key,
                                           file_id, expense_id, notes, created_label)
    values (g.id, g.order_id, g.project_id, p_kind, trim(p_number), trim(coalesce(p_series, '')), p_issue_date, p_amount, p_due_date, v_chave,
            p_file, v_exp, coalesce(p_notes, ''), public.rotulo_usuario())
    returning id into v_id;
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'anexo', g.name || ': ' || v_rot || ' registrado — ' || public.fmt_brl(p_amount)
      || case when v_exp is not null then ' (conta a pagar lançada).' else '.' end);
  end if;

  -- divergência entre documentos e valor da compra (só avisa no histórico; a decisão é de quem confere)
  select coalesce(sum(amount), 0) into v_docs from public.purchase_documents where group_id = g.id and deleted_at is null;
  v_compra := coalesce(g.amount, 0) + coalesce(g.freight, 0);
  if v_docs > v_compra + 0.005 then
    perform public.evento_compra(g.order_id, g.project_id, g.id, 'anexo', g.name || ': documentos somam ' || public.fmt_brl(v_docs)
      || ', acima do valor da compra (' || public.fmt_brl(v_compra) || '). Confira.');
  end if;
  return v_id;
end $$;

-- Exclui (com motivo) um documento lançado errado; a conta a pagar dele sai junto, se ainda não teve pagamento.
create or replace function public.excluir_documento_compra(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.purchase_documents; g public.purchase_groups;
begin
  select * into d from public.purchase_documents where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Documento não encontrado.' using errcode = '22023'; end if;
  select * into g from public.purchase_groups where id = d.group_id;
  if not (public.pode_comprar(d.project_id) or public.can_write_project(d.project_id, 'financeiro')) then
    raise exception 'Seu usuário não exclui documentos de compra nesta obra.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  if d.expense_id is not null and exists (select 1 from public.payments where expense_id = d.expense_id and deleted_at is null) then
    raise exception 'A conta deste documento já tem pagamento lançado: exclua o pagamento no Financeiro antes.' using errcode = '22023';
  end if;
  if d.expense_id is not null then update public.expenses set deleted_at = now() where id = d.expense_id; end if;
  update public.purchase_documents set deleted_at = now(), cancel_reason = trim(p_reason) where id = d.id;
  perform public.evento_compra(d.order_id, d.project_id, d.group_id, 'anexo', g.name || ': ' || public.rotulo_documento_compra(d.kind, d.number, d.series)
    || ' excluído — ' || trim(p_reason));
end $$;

-- XML da nota fiscal eletrônica no armazenamento privado
update storage.buckets set allowed_mime_types = (select array(select distinct unnest(allowed_mime_types || array['application/xml', 'text/xml'])))
 where id = 'documentos' and allowed_mime_types is not null;

-- ---------------------------------------------------------------------------------------------
-- 6. Acesso
-- ---------------------------------------------------------------------------------------------
alter table public.purchase_documents enable row level security;
create policy purchase_documents_select on public.purchase_documents for select to authenticated using (public.can_read_costs(project_id));
revoke all on public.purchase_documents from anon;
grant select on public.purchase_documents to authenticated;

revoke all on function public.purchase_group_letra(), public.purchase_group_letra_fixa() from public, anon, authenticated;
revoke all on function public.separar_itens(jsonb, uuid, text), public.definir_precos_itens(uuid, jsonb),
  public.registrar_documento_compra(uuid, text, text, date, numeric, date, text, text, text, uuid, boolean, uuid),
  public.excluir_documento_compra(uuid, text), public.codigo_oc(uuid) from public, anon;
grant execute on function public.separar_itens(jsonb, uuid, text), public.definir_precos_itens(uuid, jsonb),
  public.registrar_documento_compra(uuid, text, text, date, numeric, date, text, text, text, uuid, boolean, uuid),
  public.excluir_documento_compra(uuid, text), public.codigo_oc(uuid) to authenticated;
