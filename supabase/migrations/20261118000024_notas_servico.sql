-- GEPLAN · 0024 · Notas fiscais de SERVIÇO (saída) com retenções na fonte. O GEPLAN REGISTRA a nota emitida no portal da
-- prefeitura (não emite): valor bruto, retenções (INSS, ISS, IRRF, PIS, COFINS, CSLL) e valor líquido a receber.
-- A nota vira uma conta a receber pelo valor BRUTO (receita na DRE) e as retenções entram como baixa "retenção" (não é
-- dinheiro no caixa): o saldo a receber fica igual ao líquido. As alíquotas são sugestões editáveis — o contador confirma.
-- O CNO da obra fica no cadastro da obra (campo extra). Quem registra: administrador e financeiro; contador consulta.

-- baixa por retenção: sem conta bancária e fora do caixa
alter table public.fin_settlements drop constraint if exists fin_settlements_method_check;
alter table public.fin_settlements add constraint fin_settlements_method_check
  check (method in ('pix', 'boleto', 'transferencia', 'cartao', 'dinheiro', 'cheque', 'debito_automatico', 'retencao', 'outro'));
alter table public.fin_settlements drop constraint if exists fin_settlements_check;
alter table public.fin_settlements add constraint fin_settlements_check check (paid_by = 'cliente' or bank_account_id is not null or method = 'retencao');

create table if not exists public.service_invoices (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete restrict,
  project_id      uuid not null,
  number          text not null check (length(trim(number)) between 1 and 30),
  series          text not null default '' check (length(series) <= 10),
  issue_date      date not null,
  competence      date not null,
  cno             text not null default '' check (length(cno) <= 20),
  client_name     text not null default '' check (length(client_name) <= 160),
  client_doc      text not null default '' check (length(client_doc) <= 20),
  description     text not null default '' check (length(description) <= 1000),
  gross           numeric(16, 2) not null check (gross > 0),
  inss_base       numeric(16, 2) not null default 0 check (inss_base >= 0),
  inss_rate       numeric(7, 4) not null default 0 check (inss_rate between 0 and 100),
  inss_amount     numeric(16, 2) not null default 0 check (inss_amount >= 0),
  iss_rate        numeric(7, 4) not null default 0 check (iss_rate between 0 and 100),
  iss_amount      numeric(16, 2) not null default 0 check (iss_amount >= 0),
  iss_withheld    boolean not null default false,
  irrf_amount     numeric(16, 2) not null default 0 check (irrf_amount >= 0),
  pis_amount      numeric(16, 2) not null default 0 check (pis_amount >= 0),
  cofins_amount   numeric(16, 2) not null default 0 check (cofins_amount >= 0),
  csll_amount     numeric(16, 2) not null default 0 check (csll_amount >= 0),
  withheld_total  numeric(16, 2) not null default 0,
  net             numeric(16, 2) not null default 0,
  entry_id        uuid,
  status          text not null default 'emitida' check (status in ('emitida', 'cancelada')),
  cancel_reason   text not null default '',
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_label   text not null default '',
  created_at      timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete restrict,
  foreign key (entry_id, org_id) references public.fin_entries (id, org_id) on delete restrict
);
create unique index if not exists service_invoices_num_uq on public.service_invoices (org_id, number, series) where status = 'emitida';
create trigger trg_service_invoices_audit after insert or update or delete on public.service_invoices for each row execute function public.audit_row();

-- Registra a nota: confere as contas, cria a conta a receber (bruto) e a baixa por retenção.
create or replace function public.registrar_nfse(
  p_org uuid, p_project uuid, p_number text, p_issue_date date, p_gross numeric, p_account uuid, p_due date,
  p_series text default '', p_competence date default null, p_client_name text default '', p_client_doc text default '', p_description text default '',
  p_inss_base numeric default 0, p_inss_rate numeric default 0, p_iss_rate numeric default 0, p_iss_withheld boolean default false,
  p_irrf numeric default 0, p_pis numeric default 0, p_cofins numeric default 0, p_csll numeric default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_entry uuid; v_inss numeric; v_iss numeric; v_ret numeric; v_cc uuid; v_cno text; a public.fin_accounts;
begin
  if not public.grava_fin_empresa(p_org) then raise exception 'Seu perfil não registra notas fiscais.' using errcode = '42501'; end if;
  if public.project_org(p_project) is distinct from p_org then raise exception 'Obra de outra empresa.' using errcode = '42501'; end if;
  if p_gross is null or p_gross <= 0 then raise exception 'Informe o valor bruto da nota.' using errcode = '22023'; end if;
  if p_issue_date is null or p_issue_date > current_date then raise exception 'Informe a data de emissão (não pode ser futura).' using errcode = '22023'; end if;
  select * into a from public.fin_accounts where id = p_account and org_id = p_org;
  if not found or a.kind <> 'receita' then raise exception 'Escolha uma conta de receita para a nota.' using errcode = '22023'; end if;
  if p_inss_base < 0 or p_inss_base > p_gross then raise exception 'A base do INSS vai de zero ao valor bruto.' using errcode = '22023'; end if;
  v_inss := round(p_inss_base * p_inss_rate / 100, 2);
  v_iss := round(p_gross * p_iss_rate / 100, 2);
  v_ret := v_inss + case when p_iss_withheld then v_iss else 0 end + coalesce(p_irrf, 0) + coalesce(p_pis, 0) + coalesce(p_cofins, 0) + coalesce(p_csll, 0);
  if v_ret > p_gross then raise exception 'As retenções passam do valor bruto.' using errcode = '22023'; end if;
  select id into v_cc from public.fin_cost_centers where project_id = p_project;
  select coalesce(extra ->> 'cno', '') into v_cno from public.projects where id = p_project;
  insert into public.fin_entries (org_id, kind, description, party_name, document, account_id, competence, due_date, amount, notes)
  values (p_org, 'receber', left('NFS-e ' || trim(p_number) || coalesce(' — ' || nullif(trim(p_description), ''), ''), 200), trim(coalesce(p_client_name, '')),
          left('NFS-e ' || trim(p_number) || case when coalesce(p_series, '') <> '' then '/' || trim(p_series) else '' end, 60), p_account,
          date_trunc('month', coalesce(p_competence, p_issue_date))::date, coalesce(p_due, p_issue_date), p_gross,
          case when v_ret > 0 then 'Retenções: ' || public.fmt_brl(v_ret) || ' · líquido ' || public.fmt_brl(p_gross - v_ret) else '' end)
  returning id into v_entry;
  insert into public.fin_entry_splits (entry_id, org_id, cost_center_id, pct) values (v_entry, p_org, v_cc, 100);
  if v_ret > 0 then
    insert into public.fin_settlements (entry_id, org_id, pay_date, amount, method, notes)
    values (v_entry, p_org, p_issue_date, v_ret, 'retencao', 'Retido pelo tomador na nota ' || trim(p_number));
  end if;
  insert into public.service_invoices (org_id, project_id, number, series, issue_date, competence, cno, client_name, client_doc, description, gross,
    inss_base, inss_rate, inss_amount, iss_rate, iss_amount, iss_withheld, irrf_amount, pis_amount, cofins_amount, csll_amount, withheld_total, net, entry_id, created_label)
  values (p_org, p_project, trim(p_number), trim(coalesce(p_series, '')), p_issue_date, date_trunc('month', coalesce(p_competence, p_issue_date))::date, v_cno,
    trim(coalesce(p_client_name, '')), regexp_replace(coalesce(p_client_doc, ''), '\D', '', 'g'), coalesce(p_description, ''), p_gross,
    p_inss_base, p_inss_rate, v_inss, p_iss_rate, v_iss, p_iss_withheld, coalesce(p_irrf, 0), coalesce(p_pis, 0), coalesce(p_cofins, 0), coalesce(p_csll, 0),
    v_ret, p_gross - v_ret, v_entry, public.rotulo_usuario())
  returning id into v_id;
  return v_id;
end $$;

-- Cancela a nota (com motivo): só se nada foi recebido em dinheiro; a conta a receber é cancelada.
create or replace function public.cancelar_nfse(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare n public.service_invoices;
begin
  select * into n from public.service_invoices where id = p_id for update;
  if not found or n.status = 'cancelada' then raise exception 'Nota não encontrada ou já cancelada.' using errcode = '22023'; end if;
  if not public.grava_fin_empresa(n.org_id) then raise exception 'Seu perfil não cancela notas fiscais.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
  if exists (select 1 from public.fin_settlements where entry_id = n.entry_id and deleted_at is null and method <> 'retencao') then
    raise exception 'A nota já teve recebimento: estorne o recebimento antes de cancelar.' using errcode = '22023';
  end if;
  update public.fin_settlements set deleted_at = now(), undo_reason = 'Nota cancelada: ' || trim(p_reason) where entry_id = n.entry_id and deleted_at is null;
  perform set_config('geplan.sistema', '1', true);
  update public.fin_entries set status = 'cancelado', cancel_reason = 'Nota cancelada: ' || trim(p_reason) where id = n.entry_id;
  perform set_config('geplan.sistema', '', true);
  update public.service_invoices set status = 'cancelada', cancel_reason = trim(p_reason) where id = n.id;
end $$;

alter table public.service_invoices enable row level security;
create policy service_invoices_select on public.service_invoices for select to authenticated using (public.ve_fin_empresa(org_id));
revoke all on public.service_invoices from anon;
grant select on public.service_invoices to authenticated;
revoke all on function public.registrar_nfse(uuid, uuid, text, date, numeric, uuid, date, text, date, text, text, text, numeric, numeric, numeric, boolean, numeric, numeric, numeric, numeric),
  public.cancelar_nfse(uuid, text) from public, anon;
grant execute on function public.registrar_nfse(uuid, uuid, text, date, numeric, uuid, date, text, date, text, text, text, numeric, numeric, numeric, boolean, numeric, numeric, numeric, numeric),
  public.cancelar_nfse(uuid, text) to authenticated;
