-- GEPLAN · 0025 · Conciliação bancária: importa o extrato do banco (arquivo OFX, lido no navegador) e liga cada linha a
-- uma baixa da empresa (pagamento/recebimento com aquela conta) ou a um pagamento de despesa de obra. Linha repetida
-- (mesmo identificador do banco, FITID) não entra duas vezes. Baixa conciliada não é estornada e o lançamento dela não é
-- editado — para mudar, desconcilie antes (com motivo). Tarifa e outras linhas sem lançamento viram um lançamento novo
-- já conciliado. Quem concilia: administrador e financeiro; contador consulta. RLS e auditoria.

create table if not exists public.fin_bank_statements (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  bank_account_id  uuid not null,
  file_name        text not null default '' check (length(file_name) <= 200),
  date_start       date,
  date_end         date,
  ledger_balance   numeric(16, 2),
  ledger_date      date,
  lines_total      integer not null default 0,
  lines_new        integer not null default 0,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_label    text not null default '',
  created_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (bank_account_id, org_id) references public.fin_bank_accounts (id, org_id) on delete restrict
);
create trigger trg_fin_bank_statements_audit after insert or update or delete on public.fin_bank_statements for each row execute function public.audit_row();

create table if not exists public.fin_bank_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  statement_id     uuid not null,
  bank_account_id  uuid not null,
  fitid            text not null check (length(trim(fitid)) between 1 and 120),
  posted_date      date not null,
  amount           numeric(16, 2) not null check (amount <> 0),       -- + entrada, − saída
  memo             text not null default '' check (length(memo) <= 300),
  status           text not null default 'pendente' check (status in ('pendente', 'conciliado', 'ignorado')),
  settlement_id    uuid unique references public.fin_settlements (id) on delete restrict,
  payment_id       uuid unique references public.payments (id) on delete restrict,
  note             text not null default '' check (length(note) <= 300),
  matched_label    text not null default '',
  matched_at       timestamptz,
  unique (id, org_id),
  unique (bank_account_id, fitid),
  foreign key (statement_id, org_id) references public.fin_bank_statements (id, org_id) on delete restrict,
  foreign key (bank_account_id, org_id) references public.fin_bank_accounts (id, org_id) on delete restrict,
  check ((status = 'conciliado') = (settlement_id is not null or payment_id is not null)),
  check (settlement_id is null or payment_id is null)
);
create index if not exists fin_bank_lines_conta_idx on public.fin_bank_lines (bank_account_id, posted_date);
create trigger trg_fin_bank_lines_audit after insert or update or delete on public.fin_bank_lines for each row execute function public.audit_row();

-- baixa conciliada não é estornada; pagamento de obra conciliado também não
create or replace function public.baixa_conciliada_trava() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if (tg_table_name = 'fin_settlements' and exists (select 1 from public.fin_bank_lines where settlement_id = old.id))
       or (tg_table_name = 'payments' and exists (select 1 from public.fin_bank_lines where payment_id = old.id)) then
      raise exception 'Este pagamento está conciliado com o extrato do banco: desconcilie antes de estornar.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_settlements_conciliada on public.fin_settlements;
create trigger trg_fin_settlements_conciliada before update on public.fin_settlements for each row execute function public.baixa_conciliada_trava();
drop trigger if exists trg_payments_conciliada on public.payments;
create trigger trg_payments_conciliada before update on public.payments for each row execute function public.baixa_conciliada_trava();

-- lançamento com baixa conciliada não é editado (valor, conta, data…)
create or replace function public.lancamento_conciliado_trava() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('geplan.sistema', true) = '1' then return new; end if;
  if (new.amount, new.account_id, new.competence, new.due_date, new.kind) is distinct from (old.amount, old.account_id, old.competence, old.due_date, old.kind)
     and exists (select 1 from public.fin_settlements s join public.fin_bank_lines l on l.settlement_id = s.id where s.entry_id = old.id) then
    raise exception 'Lançamento conciliado com o extrato do banco: desconcilie antes de alterar.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_entries_conciliado on public.fin_entries;
create trigger trg_fin_entries_conciliado before update on public.fin_entries for each row execute function public.lancamento_conciliado_trava();

-- Importa o extrato: p_linhas = [{"fitid":"…","data":"2026-11-10","valor":-150.5,"memo":"TARIFA"}]. Repetidas ficam fora.
create or replace function public.importar_extrato(p_bank_account uuid, p_file_name text, p_linhas jsonb,
  p_saldo numeric default null, p_saldo_data date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.fin_bank_accounts; v_st uuid; v_novas int; v_total int; v_ini date; v_fim date;
begin
  select * into b from public.fin_bank_accounts where id = p_bank_account;
  if not found or not public.grava_fin_empresa(b.org_id) then raise exception 'Seu perfil não importa extratos.' using errcode = '42501'; end if;
  if jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then raise exception 'O arquivo não tem lançamentos.' using errcode = '22023'; end if;
  select count(*), min((x ->> 'data')::date), max((x ->> 'data')::date) into v_total, v_ini, v_fim from jsonb_array_elements(p_linhas) x;
  insert into public.fin_bank_statements (org_id, bank_account_id, file_name, date_start, date_end, ledger_balance, ledger_date, lines_total, created_label)
  values (b.org_id, b.id, left(coalesce(p_file_name, ''), 200), v_ini, v_fim, p_saldo, p_saldo_data, v_total, public.rotulo_usuario())
  returning id into v_st;
  insert into public.fin_bank_lines (org_id, statement_id, bank_account_id, fitid, posted_date, amount, memo)
  select b.org_id, v_st, b.id, left(trim(x ->> 'fitid'), 120), (x ->> 'data')::date, round((x ->> 'valor')::numeric, 2), left(coalesce(x ->> 'memo', ''), 300)
    from jsonb_array_elements(p_linhas) x where round((x ->> 'valor')::numeric, 2) <> 0
  on conflict (bank_account_id, fitid) do nothing;
  get diagnostics v_novas = row_count;
  update public.fin_bank_statements set lines_new = v_novas where id = v_st;
  return jsonb_build_object('extrato', v_st, 'linhas', v_total, 'novas', v_novas, 'repetidas', v_total - v_novas);
end $$;

-- Concilia uma linha com uma baixa da empresa (mesma conta) ou com um pagamento de despesa de obra.
create or replace function public.conciliar_linha(p_line uuid, p_settlement uuid default null, p_payment uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare l public.fin_bank_lines; s public.fin_settlements; e public.fin_entries; p public.payments; v_valor numeric;
begin
  select * into l from public.fin_bank_lines where id = p_line for update;
  if not found or not public.grava_fin_empresa(l.org_id) then raise exception 'Seu perfil não concilia extratos.' using errcode = '42501'; end if;
  if l.status <> 'pendente' then raise exception 'A linha do extrato já foi conciliada ou ignorada.' using errcode = '22023'; end if;
  if (p_settlement is null) = (p_payment is null) then raise exception 'Escolha uma baixa ou um pagamento de obra.' using errcode = '22023'; end if;
  if p_settlement is not null then
    select * into s from public.fin_settlements where id = p_settlement and org_id = l.org_id and deleted_at is null;
    if not found then raise exception 'Baixa não encontrada.' using errcode = '22023'; end if;
    if s.bank_account_id is distinct from l.bank_account_id then raise exception 'A baixa é de outra conta bancária.' using errcode = '22023'; end if;
    select * into e from public.fin_entries where id = s.entry_id;
    v_valor := case when e.kind = 'receber' then s.amount else -s.amount end;
  else
    select * into p from public.payments where id = p_payment and deleted_at is null;
    if not found or public.project_org(p.project_id) is distinct from l.org_id then raise exception 'Pagamento não encontrado.' using errcode = '22023'; end if;
    v_valor := -p.amount;
  end if;
  if abs(v_valor - l.amount) > 0.005 then
    raise exception 'O valor não bate: extrato % e sistema %.', public.fmt_brl(l.amount), public.fmt_brl(v_valor) using errcode = '22023';
  end if;
  update public.fin_bank_lines set status = 'conciliado', settlement_id = p_settlement, payment_id = p_payment, matched_label = public.rotulo_usuario(), matched_at = now()
   where id = l.id;
end $$;

-- Linha sem lançamento (tarifa, juros, rendimento…): cria o lançamento, a baixa nesta conta e já concilia.
create or replace function public.lancar_linha_extrato(p_line uuid, p_account uuid, p_cost_center uuid, p_description text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare l public.fin_bank_lines; v_entry uuid; v_set uuid; v_kind text;
begin
  select * into l from public.fin_bank_lines where id = p_line for update;
  if not found or not public.grava_fin_empresa(l.org_id) then raise exception 'Seu perfil não concilia extratos.' using errcode = '42501'; end if;
  if l.status <> 'pendente' then raise exception 'A linha do extrato já foi conciliada ou ignorada.' using errcode = '22023'; end if;
  v_kind := case when l.amount > 0 then 'receber' else 'pagar' end;
  insert into public.fin_entries (org_id, kind, description, document, account_id, competence, due_date, amount, notes)
  values (l.org_id, v_kind, left(coalesce(nullif(trim(p_description), ''), nullif(l.memo, ''), 'Lançamento do extrato'), 200), left('Extrato ' || l.fitid, 60),
          p_account, date_trunc('month', l.posted_date)::date, l.posted_date, abs(l.amount), 'Criado pela conciliação bancária')
  returning id into v_entry;
  insert into public.fin_entry_splits (entry_id, org_id, cost_center_id, pct) values (v_entry, l.org_id, p_cost_center, 100);
  insert into public.fin_settlements (entry_id, org_id, pay_date, amount, bank_account_id, method, notes)
  values (v_entry, l.org_id, least(l.posted_date, current_date), abs(l.amount), l.bank_account_id, 'debito_automatico', 'Conciliação bancária')
  returning id into v_set;
  update public.fin_bank_lines set status = 'conciliado', settlement_id = v_set, matched_label = public.rotulo_usuario(), matched_at = now() where id = l.id;
  return v_entry;
end $$;

create or replace function public.desconciliar_linha(p_line uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.fin_bank_lines;
begin
  select * into l from public.fin_bank_lines where id = p_line for update;
  if not found or not public.grava_fin_empresa(l.org_id) then raise exception 'Seu perfil não concilia extratos.' using errcode = '42501'; end if;
  if l.status = 'pendente' then raise exception 'A linha não está conciliada nem ignorada.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  update public.fin_bank_lines set status = 'pendente', settlement_id = null, payment_id = null, note = left('Desfeito: ' || trim(p_reason), 300),
         matched_label = public.rotulo_usuario(), matched_at = now() where id = l.id;
end $$;

create or replace function public.ignorar_linha(p_line uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.fin_bank_lines;
begin
  select * into l from public.fin_bank_lines where id = p_line for update;
  if not found or not public.grava_fin_empresa(l.org_id) then raise exception 'Seu perfil não concilia extratos.' using errcode = '42501'; end if;
  if l.status <> 'pendente' then raise exception 'A linha já foi conciliada ou ignorada.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  update public.fin_bank_lines set status = 'ignorado', note = left(trim(p_reason), 300), matched_label = public.rotulo_usuario(), matched_at = now() where id = l.id;
end $$;

alter table public.fin_bank_statements enable row level security;
alter table public.fin_bank_lines      enable row level security;
create policy fin_bank_statements_select on public.fin_bank_statements for select to authenticated using (public.ve_fin_empresa(org_id));
create policy fin_bank_lines_select on public.fin_bank_lines for select to authenticated using (public.ve_fin_empresa(org_id));
revoke all on public.fin_bank_statements, public.fin_bank_lines from anon;
grant select on public.fin_bank_statements, public.fin_bank_lines to authenticated;

revoke all on function public.baixa_conciliada_trava(), public.lancamento_conciliado_trava() from public, anon, authenticated;
revoke all on function public.importar_extrato(uuid, text, jsonb, numeric, date), public.conciliar_linha(uuid, uuid, uuid),
  public.lancar_linha_extrato(uuid, uuid, uuid, text), public.desconciliar_linha(uuid, text), public.ignorar_linha(uuid, text) from public, anon;
grant execute on function public.importar_extrato(uuid, text, jsonb, numeric, date), public.conciliar_linha(uuid, uuid, uuid),
  public.lancar_linha_extrato(uuid, uuid, uuid, text), public.desconciliar_linha(uuid, text), public.ignorar_linha(uuid, text) to authenticated;
