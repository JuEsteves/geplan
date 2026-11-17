-- GEPLAN · 0022 · Contrato com o CLIENTE da obra (financeiro da empresa): regime (administração ou empreitada), taxa de
-- administração (percentual sobre os custos, valor fixo mensal, percentual do orçamento em parcelas ou nenhuma) e
-- VERBAS COM TETO (esquadrias, iluminação, revestimento…): acima do teto o cliente paga; abaixo, a diferença volta para
-- ele. A verba mede o gasto pelas etapas da obra ligadas a ela e pelos pagamentos que o cliente fez direto (lançamento da
-- empresa ligado à verba). Recebimentos do cliente = contas a receber da empresa com o centro de custo da obra.
-- Quem vê e grava: o mesmo do financeiro da empresa (administrador e financeiro gravam; contador lê). RLS e auditoria.

create table if not exists public.client_contracts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete restrict,
  project_id        uuid not null unique,
  client_name       text not null default '' check (length(client_name) <= 160),
  regime            text not null default 'administracao' check (regime in ('administracao', 'empreitada')),
  contract_value    numeric(16, 2) check (contract_value is null or contract_value >= 0),
  fee_kind          text not null default 'nenhuma' check (fee_kind in ('nenhuma', 'percentual_custos', 'fixo_mensal', 'percentual_orcamento')),
  fee_value         numeric(16, 4) not null default 0 check (fee_value >= 0),
  fee_installments  integer check (fee_installments is null or fee_installments between 1 and 120),
  start_month       date not null default date_trunc('month', current_date)::date,
  notes             text not null default '' check (length(notes) <= 2000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete restrict,
  check (fee_kind <> 'percentual_orcamento' or fee_installments is not null),
  check (fee_kind not in ('percentual_custos', 'percentual_orcamento') or fee_value <= 100)
);
create trigger trg_client_contracts_updated before update on public.client_contracts for each row execute function public.set_updated_at();
create trigger trg_client_contracts_audit after insert or update or delete on public.client_contracts for each row execute function public.audit_row();

-- o regime acompanha o centro de custo da obra ("por administração" = recursos do cliente, fora da DRE)
create or replace function public.client_contract_regime() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.start_month := date_trunc('month', new.start_month)::date;
  update public.fin_cost_centers set client_funds = (new.regime = 'administracao') where project_id = new.project_id;
  return new;
end $$;
create trigger trg_client_contracts_regime before insert or update on public.client_contracts for each row execute function public.client_contract_regime();

create table if not exists public.contract_allowances (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null,
  org_id       uuid not null,
  name         text not null check (length(trim(name)) between 2 and 120),
  cap          numeric(16, 2) not null check (cap >= 0),
  phase_ids    uuid[] not null default '{}',          -- etapas da EAP (nível 1) cujo gasto entra na verba
  position     integer not null default 0,
  active       boolean not null default true,
  notes        text not null default '' check (length(notes) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, org_id),
  foreign key (contract_id, org_id) references public.client_contracts (id, org_id) on delete restrict
);
create trigger trg_contract_allowances_updated before update on public.contract_allowances for each row execute function public.set_updated_at();
create trigger trg_contract_allowances_audit after insert or update or delete on public.contract_allowances for each row execute function public.audit_row();

-- pagamento que o cliente fez direto (ou outro lançamento da empresa) pode entrar numa verba com teto
alter table public.fin_entries add column if not exists allowance_id uuid;
do $$ begin
  alter table public.fin_entries add constraint fin_entries_allowance_fk foreign key (allowance_id, org_id) references public.contract_allowances (id, org_id) on delete restrict;
exception when duplicate_object then null; end $$;

-- fin_salvar_lancamento ganha a verba (parâmetro novo no fim, opcional)
drop function if exists public.fin_salvar_lancamento(uuid, text, text, uuid, date, date, numeric, jsonb, text, uuid, text, text, uuid);
create or replace function public.fin_salvar_lancamento(
  p_org uuid, p_kind text, p_description text, p_account uuid, p_competence date, p_due date, p_amount numeric, p_rateio jsonb,
  p_party text default '', p_supplier uuid default null, p_document text default '', p_notes text default '', p_id uuid default null,
  p_allowance uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; r jsonb;
begin
  if not public.grava_fin_empresa(p_org) then raise exception 'Seu perfil não lança no financeiro da empresa.' using errcode = '42501'; end if;
  if jsonb_typeof(p_rateio) <> 'array' or jsonb_array_length(p_rateio) = 0 then raise exception 'Informe o centro de custo.' using errcode = '22023'; end if;
  if p_allowance is not null and p_kind <> 'pagar' then raise exception 'Só conta a pagar entra numa verba com teto.' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.fin_entries (org_id, kind, description, party_name, supplier_id, document, account_id, competence, due_date, amount, notes, allowance_id)
    values (p_org, p_kind, trim(p_description), trim(coalesce(p_party, '')), p_supplier, trim(coalesce(p_document, '')), p_account,
            date_trunc('month', p_competence)::date, p_due, p_amount, coalesce(p_notes, ''), p_allowance)
    returning id into v_id;
  else
    if not exists (select 1 from public.fin_entries where id = v_id and org_id = p_org) then raise exception 'Lançamento não encontrado.' using errcode = '22023'; end if;
    update public.fin_entries set description = trim(p_description), party_name = trim(coalesce(p_party, '')), supplier_id = p_supplier,
           document = trim(coalesce(p_document, '')), account_id = p_account, competence = date_trunc('month', p_competence)::date,
           due_date = p_due, amount = p_amount, notes = coalesce(p_notes, ''), allowance_id = p_allowance
     where id = v_id;
    delete from public.fin_entry_splits where entry_id = v_id;
  end if;
  for r in select * from jsonb_array_elements(p_rateio) loop
    insert into public.fin_entry_splits (entry_id, org_id, cost_center_id, pct)
    values (v_id, p_org, (r ->> 'cost_center_id')::uuid, (r ->> 'pct')::numeric);
  end loop;
  perform 1 from public.fin_settlements where entry_id = v_id and deleted_at is null having sum(amount) > p_amount + 0.005;
  if found then raise exception 'O valor ficou menor que o já pago/recebido.' using errcode = '23514'; end if;
  return v_id;
end $$;

alter table public.client_contracts    enable row level security;
alter table public.contract_allowances enable row level security;
create policy client_contracts_select on public.client_contracts for select to authenticated using (public.ve_fin_empresa(org_id));
create policy client_contracts_insert on public.client_contracts for insert to authenticated with check (public.grava_fin_empresa(org_id));
create policy client_contracts_update on public.client_contracts for update to authenticated using (public.grava_fin_empresa(org_id)) with check (public.grava_fin_empresa(org_id));
create policy contract_allowances_select on public.contract_allowances for select to authenticated using (public.ve_fin_empresa(org_id));
create policy contract_allowances_insert on public.contract_allowances for insert to authenticated with check (public.grava_fin_empresa(org_id));
create policy contract_allowances_update on public.contract_allowances for update to authenticated using (public.grava_fin_empresa(org_id)) with check (public.grava_fin_empresa(org_id));

revoke all on public.client_contracts, public.contract_allowances from anon;
grant select, insert, update on public.client_contracts, public.contract_allowances to authenticated;
revoke all on function public.client_contract_regime() from public, anon, authenticated;
revoke all on function public.fin_salvar_lancamento(uuid, text, text, uuid, date, date, numeric, jsonb, text, uuid, text, text, uuid, uuid) from public, anon;
grant execute on function public.fin_salvar_lancamento(uuid, text, text, uuid, date, date, numeric, jsonb, text, uuid, text, text, uuid, uuid) to authenticated;
