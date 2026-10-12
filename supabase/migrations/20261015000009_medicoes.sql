-- GEPLAN · 0009 · Medições por atividade e por profissional: cadastro central de profissionais, vínculos de
-- remuneração (por unidade, valor fixo por serviço, diária, hora, outro) com vigência, boletins de medição com itens
-- por atividade da EAP e produção por profissional, conferência e aprovação, valores congelados na aprovação,
-- avanço físico registrado pelo boletim aprovado e lançamento da despesa no Financeiro.
-- Somente acréscimos. Regras da empresa (decisões da Etapa 3):
--   • a produção dos profissionais numa atividade não passa do executado no período (o banco recusa);
--   • o boletim aprovado registra a medição de avanço (novo acumulado = anterior + período), sem contar duas vezes;
--   • aprovação pela liberação "aprovar_medicao" (padrão administrador e engenheiro);
--   • supervisor vê só quantidades — valores ficam com administrador, engenheiro e financeiro;
--   • nenhum dado bancário é guardado.

-- ---------------------------------------------------------------------------------------------
-- Liberação nova: aprovar medição (padrão: administrador e engenheiro)
-- ---------------------------------------------------------------------------------------------
alter table public.organization_members drop constraint if exists organization_members_permissions_validas;
alter table public.organization_members add constraint organization_members_permissions_validas
  check (permissions is null or permissions <@ array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo', 'aprovar_medicao']);

create or replace function public.liberacoes_padrao(p_role public.member_role) returns text[]
language sql immutable as $$
  select case p_role
    when 'admin'      then array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo', 'aprovar_medicao']
    when 'engenheiro' then array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo', 'aprovar_medicao']
    when 'compras'    then array['solicitar', 'comprar', 'receber', 'fornecedores']
    when 'financeiro' then array['solicitar', 'comprar', 'fornecedores']
    when 'supervisor' then array['solicitar', 'receber']
    else array[]::text[]
  end
$$;
create or replace function public.minhas_liberacoes(p_org uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(k order by k), array[]::text[])
  from unnest(array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo', 'aprovar_medicao']) k
  where public.tem_liberacao(p_org, k)
$$;
create or replace function public.pode_aprovar_medicao(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_read_costs(p_project) and public.tem_liberacao(public.project_org(p_project), 'aprovar_medicao')
         and public.org_subscription_ok(public.project_org(p_project))
$$;
-- Valores de mão de obra (vínculos e valores a pagar): administrador, engenheiro e financeiro. Supervisor não.
create or replace function public.ve_valores_mo(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.project_role(p_project) in ('admin', 'engenheiro', 'financeiro')
$$;
create or replace function public.ve_valores_mo_org(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) in ('admin', 'engenheiro', 'financeiro')
$$;
create or replace function public.grava_profissional(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) in ('admin', 'engenheiro', 'supervisor', 'financeiro') and public.org_subscription_ok(p_org)
$$;

-- ---------------------------------------------------------------------------------------------
-- Profissionais (cadastro central da empresa). Sem dados bancários.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.workers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  kind         text not null default 'pessoa' check (kind in ('pessoa', 'empresa', 'equipe')),
  name         text not null check (length(trim(name)) between 2 and 160),
  doc_number   text not null default '' check (doc_number ~ '^(\d{11}|\d{14})?$' and public.doc_valido(doc_number)),
  specialties  text not null default '',
  phone        text not null default '',
  email        text not null default '' check (email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  supplier_id  uuid,
  notes        text not null default '',
  status       text not null default 'ativo' check (status in ('ativo', 'inativo')),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers (id, org_id) on delete restrict
);
create unique index if not exists workers_doc_unico on public.workers (org_id, doc_number) where doc_number <> '' and deleted_at is null;
create index if not exists workers_org_idx on public.workers (org_id, lower(name)) where deleted_at is null;
create trigger trg_workers_updated before update on public.workers for each row execute function public.set_updated_at();
create trigger trg_workers_audit after insert or update or delete on public.workers for each row execute function public.audit_row();
create trigger trg_workers_lock_org before update on public.workers for each row execute function public.lock_org_id();

-- ---------------------------------------------------------------------------------------------
-- Vínculos de remuneração (com vigência; valor usado em medição aprovada não é alterado — cria-se outro vínculo)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.worker_agreements (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  worker_id        uuid not null,
  project_id       uuid not null references public.projects (id) on delete restrict,
  pay_type         text not null check (pay_type in ('unidade', 'empreitada', 'diaria', 'hora', 'outro')),
  role_name        text not null default '',                     -- especialidade/função neste vínculo
  unit             text not null default '' check (length(unit) <= 20),
  unit_price       numeric(16, 4) check (unit_price is null or unit_price >= 0),     -- unidade, diária, hora
  contract_amount  numeric(16, 2) check (contract_amount is null or contract_amount >= 0),  -- valor fixo do serviço
  activity_ids     uuid[] not null default '{}',                  -- atividades abrangidas (vazio = todas da obra)
  valid_from       date not null,
  valid_to         date,
  conditions       text not null default '',
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  foreign key (worker_id, org_id) references public.workers (id, org_id) on delete restrict,
  check (valid_to is null or valid_to >= valid_from),
  check (pay_type <> 'unidade' or (unit_price is not null and unit <> '')),
  check (pay_type not in ('diaria', 'hora') or unit_price is not null),
  check (pay_type <> 'empreitada' or contract_amount is not null)
);
create index if not exists worker_agreements_worker_idx on public.worker_agreements (worker_id, project_id) where deleted_at is null;
create trigger trg_worker_agreements_updated before update on public.worker_agreements for each row execute function public.set_updated_at();
create trigger trg_worker_agreements_audit after insert or update or delete on public.worker_agreements for each row execute function public.audit_row();

create or replace function public.worker_agreement_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_usado boolean;
begin
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'Obra de outra empresa.' using errcode = '42501';
  end if;
  if new.deleted_at is null and exists (select 1 from public.worker_agreements a where a.worker_id = new.worker_id and a.project_id = new.project_id
       and a.id <> new.id and a.deleted_at is null
       and daterange(a.valid_from, a.valid_to, '[]') && daterange(new.valid_from, new.valid_to, '[]')
       and (cardinality(a.activity_ids) = 0 or cardinality(new.activity_ids) = 0 or a.activity_ids && new.activity_ids)) then
    raise exception 'Já existe vínculo deste profissional nesta obra com vigência e atividades que se cruzam. Encerre o anterior (data final) antes de criar outro.' using errcode = '23P01';
  end if;
  if tg_op = 'UPDATE' then
    select exists (select 1 from public.measurement_pay m where m.agreement_id = old.id) into v_usado;
    if v_usado and (new.pay_type is distinct from old.pay_type or new.unit is distinct from old.unit or new.unit_price is distinct from old.unit_price
        or new.contract_amount is distinct from old.contract_amount or new.valid_from is distinct from old.valid_from
        or new.activity_ids is distinct from old.activity_ids or new.worker_id is distinct from old.worker_id or new.project_id is distinct from old.project_id
        or new.deleted_at is not null) then
      raise exception 'Este vínculo já foi usado em medição aprovada: valores e condições não mudam. Encerre a vigência e crie um vínculo novo.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Boletim de medição, itens por atividade e produção por profissional
-- ---------------------------------------------------------------------------------------------
create table if not exists public.measurement_sheets (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete restrict,
  number           integer not null default 0,
  phase_id         uuid,
  period_start     date not null,
  period_end       date not null,
  status           text not null default 'rascunho' check (status in ('rascunho', 'conferencia', 'aprovado', 'devolvido')),
  notes            text not null default '',
  review_note      text not null default '',
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_label    text not null default '',
  submitted_label  text not null default '',
  submitted_at     timestamptz,
  approved_by      uuid references auth.users (id) on delete set null,
  approved_label   text not null default '',
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (id, project_id),
  foreign key (phase_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict,
  check (period_end >= period_start)
);
create unique index if not exists measurement_sheets_numero on public.measurement_sheets (project_id, number);
create trigger trg_measurement_sheets_updated before update on public.measurement_sheets for each row execute function public.set_updated_at();
create trigger trg_measurement_sheets_audit after insert or update or delete on public.measurement_sheets for each row execute function public.audit_row();

create table if not exists public.measurement_items (
  id            uuid primary key default gen_random_uuid(),
  sheet_id      uuid not null,
  project_id    uuid not null,
  activity_id   uuid not null,
  position      integer not null default 0,
  description   text not null default '',
  unit          text not null default '' check (length(unit) <= 20),
  criterion     text not null default '',              -- critério de medição
  planned_qty   numeric(18, 4) check (planned_qty is null or planned_qty >= 0),   -- prevista (orçamento)
  period_qty    numeric(18, 4) check (period_qty is null or period_qty >= 0),     -- executada no período
  period_pct    numeric(10, 4) check (period_pct is null or period_pct between 0 and 100),  -- sem quantidade prevista
  previous_qty  numeric(18, 4),                        -- acumulado anterior (gravado na aprovação)
  previous_pct  numeric(10, 6),
  accum_qty     numeric(18, 4),                        -- novo acumulado (gravado na aprovação)
  accum_pct     numeric(10, 6),
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  unique (id, project_id),
  foreign key (sheet_id, project_id) references public.measurement_sheets (id, project_id) on delete cascade,
  foreign key (activity_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict
);
create index if not exists measurement_items_sheet_idx on public.measurement_items (sheet_id, position);
create index if not exists measurement_items_activity_idx on public.measurement_items (activity_id);
create trigger trg_measurement_items_audit after insert or update or delete on public.measurement_items for each row execute function public.audit_row();

create table if not exists public.measurement_workers (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null,
  sheet_id      uuid not null,
  project_id    uuid not null,
  worker_id     uuid not null references public.workers (id) on delete restrict,
  measure       text not null default 'qtd' check (measure in ('qtd', 'dias', 'horas', 'percentual')),
  produced_qty  numeric(18, 4) not null check (produced_qty >= 0),   -- informado por quem mede
  approved_qty  numeric(18, 4) check (approved_qty is null or approved_qty >= 0),  -- ajustado na conferência
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  unique (id, project_id),
  foreign key (item_id, project_id) references public.measurement_items (id, project_id) on delete cascade,
  check (measure <> 'percentual' or produced_qty <= 100)
);
create index if not exists measurement_workers_item_idx on public.measurement_workers (item_id);
create index if not exists measurement_workers_worker_idx on public.measurement_workers (worker_id);
create trigger trg_measurement_workers_audit after insert or update or delete on public.measurement_workers for each row execute function public.audit_row();

-- Valores a pagar (congelados na aprovação; só admin/engenheiro/financeiro leem)
create table if not exists public.measurement_pay (
  id              uuid primary key default gen_random_uuid(),
  worker_line_id  uuid not null unique,
  sheet_id        uuid not null,
  project_id      uuid not null,
  worker_id       uuid not null references public.workers (id) on delete restrict,
  agreement_id    uuid references public.worker_agreements (id) on delete restrict,
  pay_type        text not null check (pay_type in ('unidade', 'empreitada', 'diaria', 'hora', 'outro', 'sem_vinculo')),
  unit            text not null default '',
  unit_price      numeric(16, 4),
  quantity        numeric(18, 4),
  amount          numeric(16, 2),          -- null = sem cálculo automático (outro / sem vínculo)
  expense_id      uuid,                    -- despesa lançada no Financeiro
  created_at      timestamptz not null default now(),
  foreign key (sheet_id, project_id) references public.measurement_sheets (id, project_id) on delete restrict,
  foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict
);
create index if not exists measurement_pay_worker_idx on public.measurement_pay (worker_id);
create trigger trg_worker_agreements_before before insert or update on public.worker_agreements
  for each row execute function public.worker_agreement_before();
create trigger trg_measurement_pay_audit after insert or update or delete on public.measurement_pay for each row execute function public.audit_row();

create table if not exists public.measurement_events (
  id            bigint generated always as identity primary key,
  sheet_id      uuid not null,
  project_id    uuid not null,
  kind          text not null,
  body          text not null,
  author_id     uuid default auth.uid() references auth.users (id) on delete set null,
  author_label  text not null default '',
  created_at    timestamptz not null default now(),
  foreign key (sheet_id, project_id) references public.measurement_sheets (id, project_id) on delete restrict
);
create index if not exists measurement_events_sheet_idx on public.measurement_events (sheet_id, id);
create or replace function public.evento_medicao(p_sheet uuid, p_project uuid, p_kind text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into public.measurement_events (sheet_id, project_id, kind, body, author_id, author_label)
  values (p_sheet, p_project, p_kind, left(p_body, 2000), auth.uid(), public.rotulo_usuario())
$$;

-- Boletim: número por obra; situação só pelas ações; aprovado não muda; só rascunho é excluído.
create or replace function public.measurement_sheet_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtext('measurement_sheets:' || new.project_id::text));
    select coalesce(max(number), 0) + 1 into new.number from public.measurement_sheets where project_id = new.project_id;
    new.status := 'rascunho'; new.created_label := public.rotulo_usuario(); new.approved_by := null; new.approved_label := '';
    new.approved_at := null; new.submitted_label := ''; new.submitted_at := null; new.review_note := '';
    return new;
  end if;
  if public.eh_sistema() then return new; end if;
  if new.number is distinct from old.number or new.project_id is distinct from old.project_id or new.status is distinct from old.status
     or new.approved_by is distinct from old.approved_by or new.approved_label is distinct from old.approved_label or new.approved_at is distinct from old.approved_at
     or new.submitted_label is distinct from old.submitted_label or new.submitted_at is distinct from old.submitted_at or new.review_note is distinct from old.review_note then
    raise exception 'Número, situação e aprovação do boletim são gravados pelas ações do boletim.' using errcode = '42501';
  end if;
  if old.status in ('aprovado', 'conferencia') then
    raise exception 'O boletim nº % está %: não é alterado.', old.number, case old.status when 'aprovado' then 'aprovado' else 'em conferência' end using errcode = '42501';
  end if;
  if new.deleted_at is not null and old.status <> 'rascunho' then
    raise exception 'Só boletim em rascunho é excluído.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_measurement_sheets_before before insert or update on public.measurement_sheets
  for each row execute function public.measurement_sheet_before();

-- Itens e produção só mudam com o boletim em rascunho ou devolvido (em conferência, só quem aprova ajusta a
-- quantidade aprovada). Item: atividade do último nível, sem repetir em outro boletim de período que se cruza.
create or replace function public.measurement_part_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.measurement_sheets; v_sheet uuid; v_act uuid;
begin
  v_sheet := case when tg_op = 'DELETE' then old.sheet_id else new.sheet_id end;
  select * into s from public.measurement_sheets where id = v_sheet;
  if public.eh_sistema() then return case when tg_op = 'DELETE' then old else new end; end if;
  -- conferência: quem aprova ajusta só a quantidade aprovada (condições aninhadas: as tabelas têm campos diferentes)
  if s.status = 'conferencia' and tg_table_name = 'measurement_workers' and tg_op = 'UPDATE' then
    if public.pode_aprovar_medicao(s.project_id) then
      if new.produced_qty = old.produced_qty and new.worker_id = old.worker_id and new.measure = old.measure and new.item_id = old.item_id then
        return new;
      end if;
    end if;
  end if;
  if s.status not in ('rascunho', 'devolvido') or s.deleted_at is not null then
    raise exception 'O boletim nº % não está em edição (situação: %).', s.number, s.status using errcode = '42501';
  end if;
  if tg_table_name = 'measurement_items' and tg_op <> 'DELETE' then
    if exists (select 1 from public.wbs_nodes c where c.parent_id = new.activity_id and c.deleted_at is null) then
      raise exception 'Meça as atividades do último nível (não etapas/subetapas).' using errcode = '23514';
    end if;
    if exists (select 1 from public.measurement_items i join public.measurement_sheets o on o.id = i.sheet_id
               where i.activity_id = new.activity_id and i.id <> new.id and o.id <> s.id and o.deleted_at is null
               and daterange(o.period_start, o.period_end, '[]') && daterange(s.period_start, s.period_end, '[]')) then
      raise exception 'Esta atividade já está em outro boletim de período que se cruza com este (evita medir duas vezes).' using errcode = '23P01';
    end if;
  end if;
  if tg_table_name = 'measurement_workers' and tg_op <> 'DELETE' then
    if not exists (select 1 from public.workers w join public.projects p on p.org_id = w.org_id where w.id = new.worker_id and p.id = new.project_id) then
      raise exception 'Profissional de outra empresa.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.approved_qty is distinct from old.approved_qty then
      raise exception 'A quantidade aprovada é ajustada na conferência, por quem aprova.' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' then new.approved_qty := null; end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger trg_measurement_items_before before insert or update or delete on public.measurement_items
  for each row execute function public.measurement_part_before();
create trigger trg_measurement_workers_before before insert or update or delete on public.measurement_workers
  for each row execute function public.measurement_part_before();

-- Regra (decisão 1): soma da produção em quantidade não passa do executado no período (checada no fim da transação).
create or replace function public.check_producao_item(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i public.measurement_items; v_soma numeric; v_ap numeric; v_nome text;
begin
  select * into i from public.measurement_items where id = p_item;
  if not found then return; end if;
  select coalesce(sum(produced_qty), 0), coalesce(sum(coalesce(approved_qty, produced_qty)), 0) into v_soma, v_ap
    from public.measurement_workers where item_id = p_item and measure = 'qtd';
  if v_soma > coalesce(i.period_qty, 0) + 0.00005 or v_ap > coalesce(i.period_qty, 0) + 0.00005 then
    select code || ' ' || description into v_nome from public.wbs_nodes where id = i.activity_id;
    raise exception 'A produção dos profissionais em % (% %) passa do executado no período (% %).', v_nome,
      public.fmt_num(greatest(v_soma, v_ap)), i.unit, public.fmt_num(coalesce(i.period_qty, 0)), i.unit using errcode = '23514';
  end if;
end $$;
create or replace function public.trg_check_producao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'measurement_items' then perform public.check_producao_item(new.id);
  else perform public.check_producao_item(new.item_id); end if;
  return null;
end $$;
create constraint trigger trg_measurement_workers_producao after insert or update on public.measurement_workers
  deferrable initially deferred for each row execute function public.trg_check_producao();
create constraint trigger trg_measurement_items_producao after update of period_qty on public.measurement_items
  deferrable initially deferred for each row execute function public.trg_check_producao();

-- ---------------------------------------------------------------------------------------------
-- Ações do boletim
-- ---------------------------------------------------------------------------------------------
-- Vínculo vigente do profissional para a atividade na data (o mais específico: com a atividade listada).
create or replace function public.vinculo_vigente(p_worker uuid, p_project uuid, p_activity uuid, p_data date) returns uuid
language sql stable security definer set search_path = public as $$
  select a.id from public.worker_agreements a
   where a.worker_id = p_worker and a.project_id = p_project and a.deleted_at is null
     and a.valid_from <= p_data and (a.valid_to is null or a.valid_to >= p_data)
     and (cardinality(a.activity_ids) = 0 or p_activity = any(a.activity_ids))
   order by cardinality(a.activity_ids) = 0, a.valid_from desc limit 1
$$;

create or replace function public.medicao_acao(p_sheet uuid, p_acao text, p_comment text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  s public.measurement_sheets; it record; w record; ag public.worker_agreements;
  v_txt text := trim(coalesce(p_comment, '')); v_prev_qty numeric; v_prev_pct numeric; v_acc_qty numeric; v_acc_pct numeric;
  v_ult_pct numeric; v_ult_qty numeric; v_qtd numeric; v_valor numeric; v_tipo text; v_pct_usado numeric;
begin
  select * into s from public.measurement_sheets where id = p_sheet and deleted_at is null for update;
  if not found then raise exception 'Boletim não encontrado.' using errcode = '22023'; end if;
  perform set_config('geplan.sistema', '1', true);
  if p_acao = 'enviar' then
    if not public.can_write_project(s.project_id, 'execucao') then raise exception 'Seu usuário não lança medições nesta obra.' using errcode = '42501'; end if;
    if s.status not in ('rascunho', 'devolvido') then raise exception 'O boletim já foi enviado.' using errcode = '22023'; end if;
    if not exists (select 1 from public.measurement_items where sheet_id = s.id) then raise exception 'Inclua pelo menos uma atividade.' using errcode = '22023'; end if;
    if exists (select 1 from public.measurement_items where sheet_id = s.id and period_qty is null and period_pct is null) then
      raise exception 'Informe o executado no período em todas as atividades.' using errcode = '22023';
    end if;
    if exists (select 1 from public.measurement_items where sheet_id = s.id and coalesce(planned_qty, 0) > 0 and period_qty is null) then
      raise exception 'Atividade com quantidade prevista: informe o executado no período em quantidade.' using errcode = '22023';
    end if;
    update public.measurement_sheets set status = 'conferencia', submitted_label = public.rotulo_usuario(), submitted_at = now() where id = s.id;
    perform public.evento_medicao(s.id, s.project_id, 'envio', 'Enviado para conferência' || coalesce(': ' || nullif(v_txt, ''), '.'));
  elsif p_acao = 'devolver' then
    if not public.pode_aprovar_medicao(s.project_id) then raise exception 'Seu usuário não tem a liberação para aprovar medições desta obra.' using errcode = '42501'; end if;
    if s.status <> 'conferencia' then raise exception 'Só boletim em conferência é devolvido.' using errcode = '22023'; end if;
    if length(v_txt) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
    update public.measurement_sheets set status = 'devolvido', review_note = v_txt where id = s.id;
    perform public.evento_medicao(s.id, s.project_id, 'devolucao', 'Devolvido para correção: ' || v_txt);
  elsif p_acao = 'aprovar' then
    if not public.pode_aprovar_medicao(s.project_id) then raise exception 'Seu usuário não tem a liberação para aprovar medições desta obra.' using errcode = '42501'; end if;
    if s.status <> 'conferencia' then raise exception 'Só boletim em conferência é aprovado.' using errcode = '22023'; end if;
    for it in select * from public.measurement_items where sheet_id = s.id order by position loop
      -- acumulado anterior: última medição de avanço antes do início do período
      v_ult_pct := null; v_ult_qty := null;
      select pct, qty_accum into v_ult_pct, v_ult_qty from public.activity_measurements
       where activity_id = it.activity_id and deleted_at is null and status = 'aprovada' and ref_date < s.period_start
       order by ref_date desc limit 1;
      v_prev_pct := coalesce(v_ult_pct, 0);
      if coalesce(it.planned_qty, 0) > 0 then
        v_prev_qty := round(coalesce(v_ult_qty, v_prev_pct / 100 * it.planned_qty), 4);   -- escala da coluna
        v_acc_qty := v_prev_qty + coalesce(it.period_qty, 0);
        v_acc_pct := least(100, v_acc_qty / it.planned_qty * 100);
      elsif it.period_pct is not null then
        v_prev_qty := null; v_acc_qty := null;
        v_acc_pct := least(100, v_prev_pct + it.period_pct);
      else
        -- sem quantidade prevista e sem % informado: registra a produção, mas o avanço físico não é calculável
        v_prev_qty := null; v_acc_qty := null; v_acc_pct := null;
      end if;
      update public.measurement_items set previous_qty = v_prev_qty, previous_pct = v_prev_pct, accum_qty = v_acc_qty, accum_pct = v_acc_pct where id = it.id;
      -- avanço físico (decisão 2): medição acumulada na data final do período (substitui a da mesma data)
      if v_acc_pct is not null then
        update public.activity_measurements set deleted_at = now() where activity_id = it.activity_id and ref_date = s.period_end and deleted_at is null;
        insert into public.activity_measurements (project_id, activity_id, ref_date, method, qty_accum, unit, planned_qty, pct, notes, responsible_label, status)
        values (s.project_id, it.activity_id, s.period_end, case when v_acc_qty is not null then 'quantidade' else 'percentual' end, v_acc_qty, it.unit,
                it.planned_qty, v_acc_pct, 'Boletim de medição nº ' || s.number, public.rotulo_usuario(), 'aprovada');
      end if;
      -- valores por profissional, com o vínculo vigente no fim do período (congelados)
      for w in select * from public.measurement_workers where item_id = it.id loop
        v_qtd := coalesce(w.approved_qty, w.produced_qty);
        update public.measurement_workers set approved_qty = v_qtd where id = w.id;
        select * into ag from public.worker_agreements where id = public.vinculo_vigente(w.worker_id, s.project_id, it.activity_id, s.period_end);
        if ag.id is null then
          v_tipo := 'sem_vinculo'; v_valor := null;
        else
          v_tipo := ag.pay_type;
          if (ag.pay_type = 'unidade' and w.measure <> 'qtd') or (ag.pay_type = 'diaria' and w.measure <> 'dias')
             or (ag.pay_type = 'hora' and w.measure <> 'horas') or (ag.pay_type = 'empreitada' and w.measure <> 'percentual') then
            raise exception 'O vínculo de % é "%", mas a produção foi informada em "%". Corrija antes de aprovar.',
              (select name from public.workers where id = w.worker_id), ag.pay_type, w.measure using errcode = '22023';
          end if;
          if ag.pay_type = 'empreitada' then
            select coalesce(sum(p.quantity), 0) into v_pct_usado from public.measurement_pay p where p.agreement_id = ag.id;
            if v_pct_usado + v_qtd > 100.0001 then
              raise exception 'O serviço contratado de % passaria de 100%% (já aprovado: % %%).', (select name from public.workers where id = w.worker_id), public.fmt_num(v_pct_usado) using errcode = '23514';
            end if;
            v_valor := round(ag.contract_amount * v_qtd / 100, 2);
          elsif ag.pay_type = 'outro' then v_valor := null;
          else v_valor := round(ag.unit_price * v_qtd, 2);
          end if;
        end if;
        insert into public.measurement_pay (worker_line_id, sheet_id, project_id, worker_id, agreement_id, pay_type, unit, unit_price, quantity, amount)
        values (w.id, s.id, s.project_id, w.worker_id, ag.id, v_tipo, coalesce(ag.unit, ''), case when v_tipo in ('unidade', 'diaria', 'hora') then ag.unit_price end, v_qtd, v_valor);
      end loop;
    end loop;
    update public.measurement_sheets set status = 'aprovado', approved_by = auth.uid(), approved_label = public.rotulo_usuario(), approved_at = now(), review_note = '' where id = s.id;
    perform public.evento_medicao(s.id, s.project_id, 'aprovacao', 'Boletim aprovado' || coalesce(': ' || nullif(v_txt, ''), '.') || ' Avanço físico e valores registrados.');
  else
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
end $$;

-- Lança no Financeiro uma despesa (Mão de obra) por profissional com valor a pagar ainda não lançado.
create or replace function public.medicao_lancar_despesas(p_sheet uuid, p_due date default null) returns integer
language plpgsql security definer set search_path = public as $$
declare s public.measurement_sheets; w record; v_exp uuid; v_n int := 0;
begin
  select * into s from public.measurement_sheets where id = p_sheet and deleted_at is null;
  if not found then raise exception 'Boletim não encontrado.' using errcode = '22023'; end if;
  if not public.can_write_project(s.project_id, 'financeiro') then
    raise exception 'Seu usuário não lança despesas nesta obra.' using errcode = '42501';
  end if;
  if s.status <> 'aprovado' then raise exception 'Só boletim aprovado gera despesa.' using errcode = '22023'; end if;
  for w in select p.worker_id, k.name, k.supplier_id, sum(p.amount) total, array_agg(p.id) ids
             from public.measurement_pay p join public.workers k on k.id = p.worker_id
            where p.sheet_id = s.id and p.expense_id is null and coalesce(p.amount, 0) > 0
            group by p.worker_id, k.name, k.supplier_id loop
    insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, amount, due_date)
    values (s.project_id, s.period_end, 'MED-' || lpad(s.number::text, 4, '0'), w.name, w.supplier_id,
            'Medição nº ' || s.number || ' (' || to_char(s.period_start, 'DD/MM') || ' a ' || to_char(s.period_end, 'DD/MM/YYYY') || ') — produção', 'Mão de obra', w.total, p_due)
    returning id into v_exp;
    update public.measurement_pay set expense_id = v_exp where id = any(w.ids);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then perform public.evento_medicao(s.id, s.project_id, 'financeiro', v_n || ' despesa(s) de mão de obra lançada(s) no Financeiro.'); end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.workers             enable row level security;
alter table public.worker_agreements   enable row level security;
alter table public.measurement_sheets  enable row level security;
alter table public.measurement_items   enable row level security;
alter table public.measurement_workers enable row level security;
alter table public.measurement_pay     enable row level security;
alter table public.measurement_events  enable row level security;

create policy workers_select on public.workers for select to authenticated using (public.pode_ver_fornecedor(org_id));
create policy workers_insert on public.workers for insert to authenticated with check (public.grava_profissional(org_id) and deleted_at is null);
create policy workers_update on public.workers for update to authenticated
  using (public.grava_profissional(org_id)) with check (public.grava_profissional(org_id) and (deleted_at is null or public.org_role(org_id) = 'admin'));

create policy worker_agreements_select on public.worker_agreements for select to authenticated using (public.ve_valores_mo(project_id));
create policy worker_agreements_insert on public.worker_agreements for insert to authenticated
  with check (public.ve_valores_mo(project_id) and public.org_subscription_ok(org_id) and deleted_at is null);
create policy worker_agreements_update on public.worker_agreements for update to authenticated
  using (public.ve_valores_mo(project_id)) with check (public.ve_valores_mo(project_id));

create policy measurement_sheets_select on public.measurement_sheets for select to authenticated using (public.can_read_costs(project_id));
create policy measurement_sheets_insert on public.measurement_sheets for insert to authenticated
  with check (public.can_write_project(project_id, 'execucao') and deleted_at is null);
create policy measurement_sheets_update on public.measurement_sheets for update to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));

create policy measurement_items_select on public.measurement_items for select to authenticated using (public.can_read_costs(project_id));
create policy measurement_items_write on public.measurement_items for all to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));
create policy measurement_workers_select on public.measurement_workers for select to authenticated using (public.can_read_costs(project_id));
create policy measurement_workers_write on public.measurement_workers for all to authenticated
  using (public.can_write_project(project_id, 'execucao') or public.pode_aprovar_medicao(project_id))
  with check (public.can_write_project(project_id, 'execucao') or public.pode_aprovar_medicao(project_id));

create policy measurement_pay_select on public.measurement_pay for select to authenticated using (public.ve_valores_mo(project_id));
create policy measurement_events_select on public.measurement_events for select to authenticated using (public.can_read_costs(project_id));

revoke all on public.workers, public.worker_agreements, public.measurement_sheets, public.measurement_items, public.measurement_workers,
  public.measurement_pay, public.measurement_events from anon;
grant select, insert, update on public.workers, public.worker_agreements, public.measurement_sheets to authenticated;
grant select, insert, update, delete on public.measurement_items, public.measurement_workers to authenticated;
grant select on public.measurement_pay, public.measurement_events to authenticated;

revoke all on function public.evento_medicao(uuid, uuid, text, text), public.check_producao_item(uuid) from public, anon, authenticated;
revoke all on function public.medicao_acao(uuid, text, text), public.medicao_lancar_despesas(uuid, date), public.vinculo_vigente(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.medicao_acao(uuid, text, text), public.medicao_lancar_despesas(uuid, date) to authenticated;
