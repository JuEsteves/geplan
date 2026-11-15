-- GEPLAN · 0016 · Medição por contrato de mão de obra (planilha de avanço físico-financeiro). Somente acréscimos
-- (nenhum dado existente é alterado ou apagado; os boletins antigos continuam no banco).
--   • Contrato "por medição" ganha: forma de medição (por PERCENTUAL — etapas com peso % do contrato — ou por AMBIENTE —
--     itens com unidade, quantidade e preço; começa em percentual e pode ser trocada até a 1ª medição), retenção
--     (padrão 5%, devolvida com o último pagamento) e o ENGENHEIRO RESPONSÁVEL (o único que lança medições e pagamentos).
--   • Planilha do contrato (labor_contract_items): itens de serviço (mudam até a 1ª medição fechada), ADITIVOS (+) e
--     GLOSAS (−). Aditivo e glosa entram no Financeiro como aditivo do compromisso (contract_amendments, ±).
--   • Medições numeradas e datadas (labor_measurements) com o ACUMULADO executado de cada item (% ou quantidade).
--     Ao fechar, o banco calcula o valor do período (acumulado − anterior), a retenção e o líquido.
--   • Pagamentos (labor_payments) são independentes da medição (pode haver "pago além do executado"); cada pagamento
--     vira, no Financeiro, uma despesa do contrato já paga (abate do comprometido, sem contar duas vezes).
--   • Chave PIX (worker_bank_info): só o administrador vê e grava; ele libera a visualização por pessoa (org_pix_access).

-- ---------------------------------------------------------------------------------------------
-- 1. Contrato: forma de medição, retenção e engenheiro responsável
-- ---------------------------------------------------------------------------------------------
alter table public.labor_contracts
  add column if not exists measure_mode      text not null default 'percentual' check (measure_mode in ('percentual', 'ambiente')),
  add column if not exists retention_pct     numeric(5, 2) not null default 5 check (retention_pct >= 0 and retention_pct <= 30),
  add column if not exists responsible_id    uuid references auth.users (id) on delete set null,
  add column if not exists responsible_label text not null default '';

-- Só o engenheiro responsável pelo contrato (perfil admin ou engenheiro na obra) lança medições e pagamentos.
create or replace function public.eh_responsavel_contrato(p_contract uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select k.responsible_id = auth.uid() and public.project_role(k.project_id) in ('admin', 'engenheiro')
                          and public.org_subscription_ok(k.org_id)
                     from public.labor_contracts k where k.id = p_contract and k.deleted_at is null), false)
$$;

-- Medições e itens só existem depois desta migração; a função do contrato consulta as medições pelo nome da tabela.
create table if not exists public.labor_contract_items (
  id             uuid primary key default gen_random_uuid(),
  contract_id    uuid not null,
  project_id     uuid not null,
  kind           text not null default 'servico' check (kind in ('servico', 'aditivo', 'glosa')),
  position       integer not null default 0,
  group_name     text not null default '' check (length(group_name) <= 160),          -- fase (percentual) ou ambiente
  description    text not null check (length(trim(description)) between 1 and 300),
  weight_pct     numeric(9, 4) check (weight_pct is null or (weight_pct > 0 and weight_pct <= 100)),
  unit           text not null default '' check (length(unit) <= 20),
  quantity       numeric(16, 4) check (quantity is null or quantity > 0),
  unit_price     numeric(16, 2) check (unit_price is null or unit_price >= 0),
  amount         numeric(16, 2) check (amount is null or amount >= 0),               -- ambiente: qtd × preço; aditivo/glosa: valor
  item_date      date,
  amendment_id   uuid,
  cancel_reason  text not null default '',
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  unique (id, project_id),
  foreign key (contract_id, project_id) references public.labor_contracts (id, project_id) on delete restrict
);
create index if not exists labor_items_contract_idx on public.labor_contract_items (contract_id, position) where deleted_at is null;
create trigger trg_labor_items_updated before update on public.labor_contract_items for each row execute function public.set_updated_at();
create trigger trg_labor_items_audit after insert or update or delete on public.labor_contract_items for each row execute function public.audit_row();

create table if not exists public.labor_measurements (
  id             uuid primary key default gen_random_uuid(),
  contract_id    uuid not null,
  project_id     uuid not null,
  number         integer not null default 0,
  measure_date   date not null,
  status         text not null default 'rascunho' check (status in ('rascunho', 'fechada')),
  gross          numeric(16, 2),
  retention_pct  numeric(5, 2),
  retention      numeric(16, 2),
  net            numeric(16, 2),
  notes          text not null default '',
  reopen_reason  text not null default '',
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_label  text not null default '',
  closed_at      timestamptz,
  closed_label   text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  unique (id, project_id),
  foreign key (contract_id, project_id) references public.labor_contracts (id, project_id) on delete restrict
);
create index if not exists labor_measurements_contract_idx on public.labor_measurements (contract_id, number) where deleted_at is null;
create unique index if not exists labor_measurements_numero on public.labor_measurements (contract_id, number) where deleted_at is null;
create unique index if not exists labor_measurements_um_rascunho on public.labor_measurements (contract_id) where status = 'rascunho' and deleted_at is null;
create trigger trg_labor_measurements_updated before update on public.labor_measurements for each row execute function public.set_updated_at();
create trigger trg_labor_measurements_audit after insert or update or delete on public.labor_measurements for each row execute function public.audit_row();

create table if not exists public.labor_measurement_lines (
  id              uuid primary key default gen_random_uuid(),
  measurement_id  uuid not null,
  project_id      uuid not null,
  item_id         uuid not null,
  pct_acum        numeric(9, 4) check (pct_acum is null or (pct_acum >= 0 and pct_acum <= 100)),
  qty_acum        numeric(16, 4) check (qty_acum is null or qty_acum >= 0),
  created_at      timestamptz not null default now(),
  unique (measurement_id, item_id),
  check (pct_acum is not null or qty_acum is not null),
  foreign key (measurement_id, project_id) references public.labor_measurements (id, project_id) on delete cascade,
  foreign key (item_id, project_id) references public.labor_contract_items (id, project_id) on delete restrict
);
create trigger trg_labor_lines_audit after insert or update or delete on public.labor_measurement_lines for each row execute function public.audit_row();

create table if not exists public.labor_payments (
  id             uuid primary key default gen_random_uuid(),
  contract_id    uuid not null,
  project_id     uuid not null,
  number         integer not null,
  pay_date       date not null,
  amount         numeric(16, 2) not null check (amount > 0),
  kind           text not null default 'pagamento' check (kind in ('pagamento', 'retencao')),
  method         text not null default '' check (length(method) <= 40),
  notes          text not null default '' check (length(notes) <= 500),
  expense_id     uuid,
  payment_id     uuid,
  cancel_reason  text not null default '',
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_label  text not null default '',
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  unique (contract_id, number),
  foreign key (contract_id, project_id) references public.labor_contracts (id, project_id) on delete restrict,
  foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict
);
create index if not exists labor_payments_contract_idx on public.labor_payments (contract_id, pay_date) where deleted_at is null;
create trigger trg_labor_payments_audit after insert or update or delete on public.labor_payments for each row execute function public.audit_row();

-- Contrato: responsável (engenheiro ou administrador da empresa); forma de medição e retenção só até a 1ª medição;
-- trocar o responsável de um contrato vigente é só do administrador.
create or replace function public.labor_contract_medicao_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role public.member_role;
begin
  if tg_op = 'INSERT' then
    if new.responsible_id is null and public.org_role(new.org_id) in ('admin', 'engenheiro') then new.responsible_id := auth.uid(); end if;
  elsif not public.eh_sistema() then
    if (new.measure_mode is distinct from old.measure_mode or new.retention_pct is distinct from old.retention_pct)
       and exists (select 1 from public.labor_measurements m where m.contract_id = new.id and m.deleted_at is null) then
      raise exception 'A forma de medição e a retenção não mudam depois da primeira medição.' using errcode = '42501';
    end if;
    if new.responsible_id is distinct from old.responsible_id and old.status <> 'rascunho' and not public.is_org_admin(new.org_id) then
      raise exception 'Só o administrador troca o engenheiro responsável de um contrato vigente.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' or new.responsible_id is distinct from old.responsible_id then
    if new.responsible_id is null then
      new.responsible_label := '';
    else
      select m.role into v_role from public.organization_members m where m.org_id = new.org_id and m.user_id = new.responsible_id;
      if v_role is null or v_role not in ('admin', 'engenheiro') then
        raise exception 'O responsável pelo contrato precisa ser engenheiro ou administrador da empresa.' using errcode = '22023';
      end if;
      new.responsible_label := coalesce((select coalesce(nullif(full_name, ''), email) from public.user_profiles where id = new.responsible_id), '');
    end if;
  end if;
  return new;
end $$;
create trigger trg_labor_contracts_medicao before insert or update on public.labor_contracts
  for each row execute function public.labor_contract_medicao_before();

-- ---------------------------------------------------------------------------------------------
-- 2. Planilha do contrato
-- ---------------------------------------------------------------------------------------------
create or replace function public.labor_item_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare k public.labor_contracts;
begin
  select * into k from public.labor_contracts where id = new.contract_id;
  if tg_op = 'UPDATE' and (new.contract_id is distinct from old.contract_id or new.project_id is distinct from old.project_id
                           or new.kind is distinct from old.kind or new.amendment_id is distinct from old.amendment_id) then
    raise exception 'Contrato, tipo e aditivo do item não mudam.' using errcode = '42501';
  end if;
  if new.quantity is not null and new.unit_price is not null then
    new.amount := round(new.quantity * new.unit_price, 2);
  elsif new.kind = 'servico' then
    new.amount := null;
  end if;
  if public.eh_sistema() then return new; end if;
  if new.kind <> 'servico' then
    raise exception 'Aditivos e glosas são lançados pelo botão próprio (entram no Financeiro).' using errcode = '42501';
  end if;
  if k.payment_mode <> 'medicao' then raise exception 'A planilha de medição é só para contrato por medição.' using errcode = '22023'; end if;
  if k.status in ('concluido', 'rescindido') then raise exception 'Contrato encerrado: a planilha não muda.' using errcode = '42501'; end if;
  if exists (select 1 from public.labor_measurements m where m.contract_id = k.id and m.status = 'fechada' and m.deleted_at is null) then
    raise exception 'Depois da primeira medição fechada a planilha não muda. Use aditivo ou glosa.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_labor_items_before before insert or update on public.labor_contract_items
  for each row execute function public.labor_item_before();

-- ---------------------------------------------------------------------------------------------
-- 3. Medições
-- ---------------------------------------------------------------------------------------------
create or replace function public.pode_lancar_medicao_mo(p_measurement uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.status = 'rascunho' and public.eh_responsavel_contrato(m.contract_id)
                     from public.labor_measurements m where m.id = p_measurement and m.deleted_at is null), false)
$$;

create or replace function public.labor_measurement_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare k public.labor_contracts; v_ult date;
begin
  if tg_op = 'INSERT' then
    select * into k from public.labor_contracts where id = new.contract_id;
    if k.payment_mode <> 'medicao' then raise exception 'Só contrato por medição é medido.' using errcode = '22023'; end if;
    if k.status <> 'vigente' then raise exception 'Só contrato vigente é medido.' using errcode = '22023'; end if;
    if not public.eh_sistema() and new.status <> 'rascunho' then raise exception 'A medição começa como rascunho.' using errcode = '22023'; end if;
    if exists (select 1 from public.labor_measurements m where m.contract_id = k.id and m.status = 'rascunho' and m.deleted_at is null) then
      raise exception 'Já existe uma medição em rascunho neste contrato. Feche ou descarte antes de abrir outra.' using errcode = '22023';
    end if;
    select max(measure_date) into v_ult from public.labor_measurements m where m.contract_id = k.id and m.status = 'fechada' and m.deleted_at is null;
    if v_ult is not null and new.measure_date < v_ult then
      raise exception 'A data da medição é anterior à da última medição fechada (%).', to_char(v_ult, 'DD/MM/YYYY') using errcode = '22023';
    end if;
    new.number := coalesce((select max(number) from public.labor_measurements where contract_id = k.id), 0) + 1;
    new.created_label := public.rotulo_usuario();
    new.gross := null; new.retention := null; new.net := null; new.retention_pct := null;
    return new;
  end if;
  if new.contract_id is distinct from old.contract_id or new.project_id is distinct from old.project_id or new.number is distinct from old.number then
    raise exception 'Contrato e número da medição não mudam.' using errcode = '42501';
  end if;
  if public.eh_sistema() then return new; end if;
  if old.status <> 'rascunho' then raise exception 'Medição fechada não muda. Para corrigir, reabra a medição.' using errcode = '42501'; end if;
  if new.status is distinct from old.status or new.gross is distinct from old.gross or new.retention is distinct from old.retention
     or new.net is distinct from old.net or new.retention_pct is distinct from old.retention_pct then
    raise exception 'Use "Fechar medição" para calcular e fechar.' using errcode = '42501';
  end if;
  select max(measure_date) into v_ult from public.labor_measurements m where m.contract_id = new.contract_id and m.status = 'fechada' and m.deleted_at is null;
  if v_ult is not null and new.measure_date < v_ult then
    raise exception 'A data da medição é anterior à da última medição fechada (%).', to_char(v_ult, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  return new;
end $$;
create trigger trg_labor_measurements_before before insert or update on public.labor_measurements
  for each row execute function public.labor_measurement_before();

-- Linha da medição: item do mesmo contrato (não glosa), % até 100 e quantidade até a do item.
create or replace function public.labor_line_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare i public.labor_contract_items; m public.labor_measurements;
begin
  if tg_op = 'DELETE' then
    select * into m from public.labor_measurements where id = old.measurement_id;
    if m.status <> 'rascunho' and not public.eh_sistema() then raise exception 'Medição fechada não muda.' using errcode = '42501'; end if;
    return old;
  end if;
  select * into m from public.labor_measurements where id = new.measurement_id;
  select * into i from public.labor_contract_items where id = new.item_id;
  if m.status <> 'rascunho' and not public.eh_sistema() then raise exception 'Medição fechada não muda.' using errcode = '42501'; end if;
  if i.contract_id is distinct from m.contract_id or i.deleted_at is not null then
    raise exception 'O item não é da planilha deste contrato.' using errcode = '22023';
  end if;
  if i.kind = 'glosa' then raise exception 'Glosa não é medida.' using errcode = '22023'; end if;
  if new.qty_acum is not null then
    if i.quantity is null then raise exception 'O item "%" não tem quantidade; informe o %%.', i.description using errcode = '22023'; end if;
    if new.qty_acum > i.quantity + 0.00001 then
      raise exception 'O acumulado de "%" (%) passa da quantidade contratada (%).', i.description, public.fmt_num(new.qty_acum), public.fmt_num(i.quantity) using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger trg_labor_lines_before before insert or update or delete on public.labor_measurement_lines
  for each row execute function public.labor_line_before();

-- Valor executado acumulado até a medição (ela inclusive): para cada item, o último acumulado informado nas medições
-- fechadas anteriores ou nesta. Valor do item: percentual = peso × valor do contrato; ambiente/aditivo = valor do item.
-- Cada linha é arredondada a centavos (a tela usa a mesma regra em js/medicaoRegras.js).
create or replace function public.mo_acumulado(p_measurement uuid) returns numeric
language sql stable security definer set search_path = public as $$
  with m as (select * from public.labor_measurements where id = p_measurement),
  k as (select lc.* from public.labor_contracts lc join m on lc.id = m.contract_id),
  ult as (
    select distinct on (l.item_id) l.item_id, l.pct_acum, l.qty_acum
      from public.labor_measurement_lines l
      join public.labor_measurements x on x.id = l.measurement_id and x.deleted_at is null
      join m on x.contract_id = m.contract_id and (x.id = m.id or (x.status = 'fechada' and x.number < m.number))
     order by l.item_id, x.number desc
  )
  select coalesce(sum(round(
           (case when u.qty_acum is not null and coalesce(i.quantity, 0) > 0 then least(u.qty_acum / i.quantity, 1)
                 else coalesce(u.pct_acum, 0) / 100 end)
         * (case when i.kind = 'servico' and k.measure_mode = 'percentual' then round(coalesce(i.weight_pct, 0) / 100 * coalesce(k.amount, 0), 2)
                 else coalesce(i.amount, 0) end), 2)), 0)
    from ult u
    join public.labor_contract_items i on i.id = u.item_id and i.deleted_at is null and i.kind <> 'glosa'
   cross join k
$$;

-- Fechar: confere a planilha (pesos = 100% ou total dos ambientes = valor do contrato), o acumulado não diminui,
-- calcula o valor do período, a retenção e o líquido.
create or replace function public.medicao_mo_fechar(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.labor_measurements; k public.labor_contracts; v_soma numeric; v_falta int; v_prev numeric; v_acum numeric; v_bruto numeric; v_ret numeric;
begin
  select * into m from public.labor_measurements where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Medição não encontrada.' using errcode = '22023'; end if;
  select * into k from public.labor_contracts where id = m.contract_id for update;
  if not public.eh_responsavel_contrato(k.id) then raise exception 'Só o engenheiro responsável pelo contrato lança medições.' using errcode = '42501'; end if;
  if m.status <> 'rascunho' then raise exception 'A medição já está fechada.' using errcode = '22023'; end if;
  if k.status <> 'vigente' then raise exception 'Só contrato vigente é medido.' using errcode = '22023'; end if;
  if not exists (select 1 from public.labor_measurement_lines l where l.measurement_id = m.id) then
    raise exception 'Informe o executado de pelo menos um item.' using errcode = '22023';
  end if;
  if k.measure_mode = 'percentual' then
    select coalesce(sum(weight_pct), 0), count(*) filter (where weight_pct is null) into v_soma, v_falta
      from public.labor_contract_items where contract_id = k.id and kind = 'servico' and deleted_at is null;
    if v_falta > 0 then raise exception 'Há % item(ns) da planilha sem peso (%%).', v_falta using errcode = '22023'; end if;
    if abs(v_soma - 100) > 0.01 then
      raise exception 'Os pesos da planilha somam % (devem somar 100%%).', public.fmt_num(round(v_soma, 2)) || '%' using errcode = '23514';
    end if;
  else
    select coalesce(sum(amount), 0), count(*) filter (where quantity is null or unit_price is null) into v_soma, v_falta
      from public.labor_contract_items where contract_id = k.id and kind = 'servico' and deleted_at is null;
    if v_falta > 0 then raise exception 'Há % item(ns) da planilha sem quantidade ou preço.', v_falta using errcode = '22023'; end if;
    if abs(v_soma - coalesce(k.amount, 0)) > 0.01 then
      raise exception 'O total da planilha (%) é diferente do valor do contrato (%).', public.fmt_brl(v_soma), public.fmt_brl(coalesce(k.amount, 0)) using errcode = '23514';
    end if;
  end if;
  if exists (
    select 1 from public.labor_measurement_lines l
     cross join lateral (
       select l2.pct_acum, l2.qty_acum from public.labor_measurement_lines l2
         join public.labor_measurements x on x.id = l2.measurement_id
        where l2.item_id = l.item_id and x.status = 'fechada' and x.deleted_at is null and x.number < m.number
        order by x.number desc limit 1) p
     where l.measurement_id = m.id
       and (coalesce(l.qty_acum, 0) < coalesce(p.qty_acum, 0) - 0.00001 or coalesce(l.pct_acum, 0) < coalesce(p.pct_acum, 0) - 0.00001)) then
    raise exception 'O acumulado de um item não pode ser menor que o da medição anterior. Para corrigir, reabra a medição anterior.' using errcode = '23514';
  end if;
  select coalesce(sum(gross), 0) into v_prev from public.labor_measurements
   where contract_id = k.id and status = 'fechada' and deleted_at is null;
  v_acum := public.mo_acumulado(m.id);
  v_bruto := v_acum - v_prev;
  v_ret := round(v_bruto * k.retention_pct / 100, 2);
  perform set_config('geplan.sistema', '1', true);
  update public.labor_measurements set status = 'fechada', gross = v_bruto, retention_pct = k.retention_pct, retention = v_ret,
         net = v_bruto - v_ret, closed_at = now(), closed_label = public.rotulo_usuario()
   where id = m.id;
end $$;

-- Reabrir: só a última medição fechada, sem outra em rascunho, com motivo (fica registrado).
create or replace function public.medicao_mo_reabrir(p_id uuid, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.labor_measurements;
begin
  select * into m from public.labor_measurements where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Medição não encontrada.' using errcode = '22023'; end if;
  if not public.eh_responsavel_contrato(m.contract_id) then raise exception 'Só o engenheiro responsável pelo contrato lança medições.' using errcode = '42501'; end if;
  if m.status <> 'fechada' then raise exception 'A medição não está fechada.' using errcode = '22023'; end if;
  if exists (select 1 from public.labor_measurements x where x.contract_id = m.contract_id and x.deleted_at is null and x.number > m.number) then
    raise exception 'Só a última medição pode ser reaberta.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Informe o motivo.' using errcode = '22023'; end if;
  perform set_config('geplan.sistema', '1', true);
  update public.labor_measurements set status = 'rascunho', gross = null, retention = null, net = null, retention_pct = null,
         closed_at = null, closed_label = '',
         reopen_reason = trim(both from reopen_reason || case when reopen_reason = '' then '' else E'\n' end
                         || to_char(now(), 'DD/MM/YYYY') || ' — ' || public.rotulo_usuario() || ': ' || trim(p_motivo))
   where id = m.id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Aditivos e glosas (entram no Financeiro como aditivo do compromisso)
-- ---------------------------------------------------------------------------------------------
create or replace function public.medicao_mo_ajuste(p_contract uuid, p_kind text, p_group text, p_description text, p_amount numeric,
  p_unit text default '', p_quantity numeric default null, p_unit_price numeric default null, p_date date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare k public.labor_contracts; v numeric; v_am uuid; v_id uuid;
begin
  select * into k from public.labor_contracts where id = p_contract and deleted_at is null for update;
  if not found then raise exception 'Contrato não encontrado.' using errcode = '22023'; end if;
  if not public.eh_responsavel_contrato(k.id) then raise exception 'Só o engenheiro responsável pelo contrato lança aditivos e glosas.' using errcode = '42501'; end if;
  if k.status <> 'vigente' then raise exception 'Só contrato vigente recebe aditivo ou glosa.' using errcode = '22023'; end if;
  if k.payment_mode <> 'medicao' then raise exception 'Aditivo e glosa da medição são só para contrato por medição.' using errcode = '22023'; end if;
  if p_kind not in ('aditivo', 'glosa') then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_description, ''))) < 2 then raise exception 'Descreva o %.', p_kind using errcode = '22023'; end if;
  if k.contract_id is null then raise exception 'O contrato não tem compromisso no Financeiro.' using errcode = '22023'; end if;
  v := case when p_quantity is not null and p_unit_price is not null then round(p_quantity * p_unit_price, 2) else round(p_amount, 2) end;
  if v is null or v <= 0 then raise exception 'Informe o valor.' using errcode = '22023'; end if;
  if p_kind = 'glosa' and p_quantity is not null then raise exception 'Glosa é só valor.' using errcode = '22023'; end if;
  perform set_config('geplan.sistema', '1', true);
  insert into public.contract_amendments (contract_id, project_id, amend_date, amount, description)
  values (k.contract_id, k.project_id, coalesce(p_date, current_date), case when p_kind = 'glosa' then -v else v end,
          left(case when p_kind = 'glosa' then 'Glosa' else 'Aditivo' end || ' (medição) — ' || trim(p_description), 500))
  returning id into v_am;
  insert into public.labor_contract_items (contract_id, project_id, kind, position, group_name, description, unit, quantity, unit_price, amount, item_date, amendment_id)
  values (k.id, k.project_id, p_kind, coalesce((select max(position) from public.labor_contract_items where contract_id = k.id), 0) + 1,
          left(trim(coalesce(p_group, '')), 160), left(trim(p_description), 300), left(trim(coalesce(p_unit, '')), 20),
          case when p_kind = 'aditivo' then p_quantity end, case when p_kind = 'aditivo' then p_unit_price end, v, coalesce(p_date, current_date), v_am)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.medicao_mo_ajuste_remover(p_item uuid, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare i public.labor_contract_items;
begin
  select * into i from public.labor_contract_items where id = p_item and deleted_at is null for update;
  if not found then raise exception 'Item não encontrado.' using errcode = '22023'; end if;
  if i.kind not in ('aditivo', 'glosa') then raise exception 'Só aditivo ou glosa sai por aqui.' using errcode = '22023'; end if;
  if not public.eh_responsavel_contrato(i.contract_id) then raise exception 'Só o engenheiro responsável pelo contrato lança aditivos e glosas.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Informe o motivo.' using errcode = '22023'; end if;
  if exists (select 1 from public.labor_measurement_lines l join public.labor_measurements m on m.id = l.measurement_id
              where l.item_id = i.id and m.status = 'fechada' and m.deleted_at is null and (coalesce(l.pct_acum, 0) > 0 or coalesce(l.qty_acum, 0) > 0)) then
    raise exception 'Este aditivo já foi medido; não pode ser removido.' using errcode = '22023';
  end if;
  perform set_config('geplan.sistema', '1', true);
  delete from public.labor_measurement_lines l using public.labor_measurements m where l.item_id = i.id and m.id = l.measurement_id and m.status = 'rascunho';
  update public.labor_contract_items set deleted_at = now(), cancel_reason = trim(p_motivo) where id = i.id;
  if i.amendment_id is not null then update public.contract_amendments set deleted_at = now() where id = i.amendment_id; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Pagamentos (independentes da medição) → despesa paga do contrato no Financeiro
-- ---------------------------------------------------------------------------------------------
create or replace function public.medicao_mo_pagar(p_contract uuid, p_date date, p_amount numeric, p_kind text default 'pagamento',
  p_method text default '', p_notes text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare k public.labor_contracts; v_nome text; v_sup uuid; v_n int; v_exp uuid; v_pg uuid; v_id uuid;
        v_retido numeric; v_lib numeric; v_exec numeric; v_base numeric;
begin
  select * into k from public.labor_contracts where id = p_contract and deleted_at is null for update;
  if not found then raise exception 'Contrato não encontrado.' using errcode = '22023'; end if;
  if not public.eh_responsavel_contrato(k.id) then raise exception 'Só o engenheiro responsável pelo contrato lança pagamentos.' using errcode = '42501'; end if;
  if k.payment_mode <> 'medicao' then raise exception 'Pagamento por medição só em contrato por medição.' using errcode = '22023'; end if;
  if k.status = 'rascunho' then raise exception 'Ative o contrato antes de pagar.' using errcode = '22023'; end if;
  if k.contract_id is null then raise exception 'O contrato não tem compromisso no Financeiro.' using errcode = '22023'; end if;
  if p_kind not in ('pagamento', 'retencao') then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
  if p_date is null then raise exception 'Informe a data do pagamento.' using errcode = '22023'; end if;
  if p_amount is null or round(p_amount, 2) <= 0 then raise exception 'Informe o valor.' using errcode = '22023'; end if;
  if p_kind = 'retencao' then
    select coalesce(sum(retention), 0), coalesce(sum(gross), 0) into v_retido, v_exec
      from public.labor_measurements where contract_id = k.id and status = 'fechada' and deleted_at is null;
    select coalesce(sum(amount), 0) into v_lib from public.labor_payments where contract_id = k.id and kind = 'retencao' and deleted_at is null;
    if round(p_amount, 2) > v_retido - v_lib + 0.005 then
      raise exception 'Retenção disponível para liberar: %.', public.fmt_brl(v_retido - v_lib) using errcode = '23514';
    end if;
    select coalesce(k.amount, 0) + coalesce(sum(amount), 0) into v_base from public.labor_contract_items
     where contract_id = k.id and kind = 'aditivo' and deleted_at is null;
    if k.status <> 'concluido' and v_exec < v_base - 0.01 then
      raise exception 'A retenção é devolvida com o último pagamento: o contrato ainda não está 100%% medido (% de %).', public.fmt_brl(v_exec), public.fmt_brl(v_base) using errcode = '22023';
    end if;
  end if;
  select w.name, w.supplier_id into v_nome, v_sup from public.workers w where w.id = k.worker_id;
  v_n := coalesce((select max(number) from public.labor_payments where contract_id = k.id), 0) + 1;
  perform set_config('geplan.sistema', '1', true);
  insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, contract_id, amount, due_date, phase_id)
  values (k.project_id, p_date, 'PAG-' || lpad(k.number::text, 4, '0') || '/' || v_n, v_nome, v_sup,
          left(k.title || ' — ' || case when p_kind = 'retencao' then 'devolução da retenção' else 'pagamento ' || v_n end
               || coalesce(' — ' || nullif(trim(p_notes), ''), ''), 500),
          'Mão de obra', k.contract_id, round(p_amount, 2), p_date, case when cardinality(k.phase_ids) = 1 then k.phase_ids[1] end)
  returning id into v_exp;
  insert into public.payments (expense_id, project_id, pay_date, amount) values (v_exp, k.project_id, p_date, round(p_amount, 2)) returning id into v_pg;
  insert into public.labor_payments (contract_id, project_id, number, pay_date, amount, kind, method, notes, expense_id, payment_id, created_label)
  values (k.id, k.project_id, v_n, p_date, round(p_amount, 2), p_kind, left(trim(coalesce(p_method, '')), 40), left(trim(coalesce(p_notes, '')), 500),
          v_exp, v_pg, public.rotulo_usuario())
  returning id into v_id;
  return v_id;
end $$;

-- Estornar: o pagamento e a despesa dele no Financeiro saem dos totais (exclusão lógica, com motivo; nada é apagado).
create or replace function public.medicao_mo_estornar(p_payment uuid, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare p public.labor_payments;
begin
  select * into p from public.labor_payments where id = p_payment and deleted_at is null for update;
  if not found then raise exception 'Pagamento não encontrado.' using errcode = '22023'; end if;
  if not public.eh_responsavel_contrato(p.contract_id) then raise exception 'Só o engenheiro responsável pelo contrato lança pagamentos.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Informe o motivo.' using errcode = '22023'; end if;
  perform set_config('geplan.sistema', '1', true);
  update public.labor_payments set deleted_at = now(), cancel_reason = trim(p_motivo) where id = p.id;
  if p.payment_id is not null then update public.payments set deleted_at = now() where id = p.payment_id; end if;
  if p.expense_id is not null then update public.expenses set deleted_at = now() where id = p.expense_id; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Chave PIX: só o administrador vê e grava; ele libera a visualização por pessoa
-- ---------------------------------------------------------------------------------------------
create table if not exists public.org_pix_access (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  granted_by  uuid default auth.uid() references auth.users (id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create trigger trg_org_pix_access_audit after insert or update or delete on public.org_pix_access for each row execute function public.audit_row();

-- Sem gatilho de auditoria com a linha inteira (a auditoria guardaria cópias da chave); fica quem alterou e quando.
create table if not exists public.worker_bank_info (
  worker_id   uuid primary key,
  org_id      uuid not null,
  pix_type    text not null default '' check (pix_type in ('', 'cpf', 'cnpj', 'email', 'telefone', 'aleatoria')),
  pix_key     text not null default '' check (length(pix_key) <= 140),
  bank        text not null default '' check (length(bank) <= 120),
  holder      text not null default '' check (length(holder) <= 160),
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  foreign key (worker_id, org_id) references public.workers (id, org_id) on delete restrict
);
create trigger trg_worker_bank_updated before update on public.worker_bank_info for each row execute function public.set_updated_at();

create or replace function public.ve_pix(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.is_org_admin(p_org)
    or (public.is_org_member(p_org) and exists (select 1 from public.org_pix_access a where a.org_id = p_org and a.user_id = auth.uid())), false)
$$;

create or replace function public.worker_bank_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.worker_id is distinct from old.worker_id or new.org_id is distinct from old.org_id) then
    raise exception 'Profissional e empresa não mudam.' using errcode = '42501';
  end if;
  new.updated_by := auth.uid();
  new.pix_key := trim(new.pix_key);
  return new;
end $$;
create trigger trg_worker_bank_before before insert or update on public.worker_bank_info
  for each row execute function public.worker_bank_before();

-- ---------------------------------------------------------------------------------------------
-- 7. RLS e acessos
-- ---------------------------------------------------------------------------------------------
alter table public.labor_contract_items enable row level security;
alter table public.labor_measurements enable row level security;
alter table public.labor_measurement_lines enable row level security;
alter table public.labor_payments enable row level security;
alter table public.org_pix_access enable row level security;
alter table public.worker_bank_info enable row level security;

create policy labor_items_select on public.labor_contract_items for select to authenticated using (public.ve_valores_mo(project_id));
create policy labor_items_insert on public.labor_contract_items for insert to authenticated
  with check (kind = 'servico' and deleted_at is null and (public.pode_contratar(project_id) or public.eh_responsavel_contrato(contract_id)));
create policy labor_items_update on public.labor_contract_items for update to authenticated
  using (kind = 'servico' and (public.pode_contratar(project_id) or public.eh_responsavel_contrato(contract_id)))
  with check (kind = 'servico' and (public.pode_contratar(project_id) or public.eh_responsavel_contrato(contract_id)));

create policy labor_measurements_select on public.labor_measurements for select to authenticated using (public.ve_valores_mo(project_id));
create policy labor_measurements_insert on public.labor_measurements for insert to authenticated
  with check (public.eh_responsavel_contrato(contract_id) and status = 'rascunho' and deleted_at is null);
create policy labor_measurements_update on public.labor_measurements for update to authenticated
  using (status = 'rascunho' and public.eh_responsavel_contrato(contract_id)) with check (public.eh_responsavel_contrato(contract_id));

create policy labor_lines_select on public.labor_measurement_lines for select to authenticated using (public.ve_valores_mo(project_id));
create policy labor_lines_insert on public.labor_measurement_lines for insert to authenticated with check (public.pode_lancar_medicao_mo(measurement_id));
create policy labor_lines_update on public.labor_measurement_lines for update to authenticated
  using (public.pode_lancar_medicao_mo(measurement_id)) with check (public.pode_lancar_medicao_mo(measurement_id));
create policy labor_lines_delete on public.labor_measurement_lines for delete to authenticated using (public.pode_lancar_medicao_mo(measurement_id));

create policy labor_payments_select on public.labor_payments for select to authenticated using (public.ve_valores_mo(project_id));

create policy org_pix_access_select on public.org_pix_access for select to authenticated
  using (public.is_org_admin(org_id) or user_id = auth.uid());
create policy org_pix_access_insert on public.org_pix_access for insert to authenticated
  with check (public.is_org_admin(org_id) and public.org_subscription_ok(org_id)
              and exists (select 1 from public.organization_members m where m.org_id = org_pix_access.org_id and m.user_id = org_pix_access.user_id and m.role <> 'cliente'));
create policy org_pix_access_delete on public.org_pix_access for delete to authenticated using (public.is_org_admin(org_id));

create policy worker_bank_select on public.worker_bank_info for select to authenticated using (public.ve_pix(org_id));
create policy worker_bank_insert on public.worker_bank_info for insert to authenticated
  with check (public.is_org_admin(org_id) and public.org_subscription_ok(org_id));
create policy worker_bank_update on public.worker_bank_info for update to authenticated
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id) and public.org_subscription_ok(org_id));

revoke all on public.labor_contract_items, public.labor_measurements, public.labor_measurement_lines, public.labor_payments,
  public.org_pix_access, public.worker_bank_info from anon, authenticated;
grant select, insert, update on public.labor_contract_items, public.labor_measurements to authenticated;
grant select, insert, update, delete on public.labor_measurement_lines to authenticated;
grant select on public.labor_payments to authenticated;
grant select, insert, delete on public.org_pix_access to authenticated;
grant select, insert, update on public.worker_bank_info to authenticated;

revoke all on function public.eh_responsavel_contrato(uuid), public.pode_lancar_medicao_mo(uuid), public.mo_acumulado(uuid), public.ve_pix(uuid),
  public.medicao_mo_fechar(uuid), public.medicao_mo_reabrir(uuid, text),
  public.medicao_mo_ajuste(uuid, text, text, text, numeric, text, numeric, numeric, date), public.medicao_mo_ajuste_remover(uuid, text),
  public.medicao_mo_pagar(uuid, date, numeric, text, text, text), public.medicao_mo_estornar(uuid, text) from public, anon;
-- as funções usadas nas políticas precisam de EXECUTE para quem consulta (respondem falso para quem não tem acesso)
grant execute on function public.eh_responsavel_contrato(uuid), public.pode_lancar_medicao_mo(uuid), public.ve_pix(uuid),
  public.medicao_mo_fechar(uuid), public.medicao_mo_reabrir(uuid, text),
  public.medicao_mo_ajuste(uuid, text, text, text, numeric, text, numeric, numeric, date), public.medicao_mo_ajuste_remover(uuid, text),
  public.medicao_mo_pagar(uuid, date, numeric, text, text, text), public.medicao_mo_estornar(uuid, text) to authenticated;
