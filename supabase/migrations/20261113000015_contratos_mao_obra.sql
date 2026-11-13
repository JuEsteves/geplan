-- GEPLAN · 0015 · Contratos de mão de obra (empreiteiros e prestadores) por obra. Somente acréscimos e substituição de
-- funções (nenhum dado existente é alterado).
--   • Contrato = profissional (cadastro de Medições) + obra + escopo (fases da EAP) + valor + forma de pagamento + prazo.
--   • Formas de pagamento: por medição (boletins; % do serviço contratado), mensal ou em parcelas (cronograma de parcelas),
--     ou avulso (pagamentos lançados à mão no Financeiro).
--   • Ao ativar (rascunho → vigente), o contrato com valor vira compromisso "Contrato · Mão de obra" no Financeiro
--     (entra no comprometido). Parcelas e medições lançadas viram despesas DESSE contrato → abatem do comprometido, sem
--     contar duas vezes. Contrato por medição também cria o vínculo de remuneração (empreitada) usado nos boletins.
--   • Depois de vigente, valor, profissional e condições não mudam (aditivo/novo contrato); só observações e arquivo.
--   • Valores: só quem vê valores de mão de obra (admin, engenheiro, financeiro). Grava: quem tem a liberação de compras.

create or replace function public.pode_contratar(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.ve_valores_mo(p_project) and public.can_write_project(p_project, 'compras'), false)
$$;

create table if not exists public.labor_contracts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  project_id          uuid not null references public.projects (id) on delete restrict,
  worker_id           uuid not null,
  number              integer not null default 0,
  title               text not null check (length(trim(title)) between 2 and 160),
  scope               text not null default '',
  phase_ids           uuid[] not null default '{}',
  amount              numeric(16, 2) check (amount is null or amount >= 0),
  payment_mode        text not null default 'medicao' check (payment_mode in ('medicao', 'mensal', 'parcelas', 'avulso')),
  start_date          date,
  end_date            date,
  status              text not null default 'rascunho' check (status in ('rascunho', 'vigente', 'concluido', 'rescindido')),
  notes               text not null default '',
  close_reason        text not null default '',
  file_path           text not null default '',
  file_name           text not null default '',
  contract_id         uuid,
  agreement_id        uuid references public.worker_agreements (id) on delete restrict,
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_label       text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (id, project_id),
  foreign key (worker_id, org_id) references public.workers (id, org_id) on delete restrict,
  foreign key (contract_id, project_id) references public.contracts (id, project_id) on delete restrict,
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists labor_contracts_project_idx on public.labor_contracts (project_id, number) where deleted_at is null;
create index if not exists labor_contracts_worker_idx on public.labor_contracts (worker_id);
create trigger trg_labor_contracts_updated before update on public.labor_contracts for each row execute function public.set_updated_at();
create trigger trg_labor_contracts_audit after insert or update or delete on public.labor_contracts for each row execute function public.audit_row();

create table if not exists public.labor_contract_installments (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null,
  project_id   uuid not null,
  number       integer not null check (number between 1 and 240),
  due_date     date not null,
  amount       numeric(16, 2) not null check (amount > 0),
  description  text not null default '',
  expense_id   uuid,
  created_at   timestamptz not null default now(),
  unique (contract_id, number),
  foreign key (contract_id, project_id) references public.labor_contracts (id, project_id) on delete cascade,
  foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict
);
create trigger trg_labor_installments_audit after insert or update or delete on public.labor_contract_installments for each row execute function public.audit_row();

-- Regras do contrato: mesma empresa da obra, número sequencial por obra, imutável depois de vigente.
create or replace function public.labor_contract_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'Obra de outra empresa.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.number := coalesce((select max(number) from public.labor_contracts where project_id = new.project_id), 0) + 1;
    new.created_label := public.rotulo_usuario();
    if new.status <> 'rascunho' and not public.eh_sistema() then
      raise exception 'O contrato começa como rascunho; use "Ativar" para torná-lo vigente.' using errcode = '22023';
    end if;
    return new;
  end if;
  if new.project_id is distinct from old.project_id or new.org_id is distinct from old.org_id or new.number is distinct from old.number then
    raise exception 'Obra e número do contrato não mudam.' using errcode = '42501';
  end if;
  if public.eh_sistema() then return new; end if;
  if old.status <> 'rascunho' then
    if new.worker_id is distinct from old.worker_id or new.title is distinct from old.title or new.scope is distinct from old.scope
       or new.phase_ids is distinct from old.phase_ids or new.amount is distinct from old.amount or new.payment_mode is distinct from old.payment_mode
       or new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date or new.status is distinct from old.status
       or new.contract_id is distinct from old.contract_id or new.agreement_id is distinct from old.agreement_id
       or new.deleted_at is distinct from old.deleted_at or new.close_reason is distinct from old.close_reason then
      raise exception 'Contrato vigente/encerrado: valor e condições não mudam (só observações e arquivo). Para mudar, faça um aditivo no Financeiro ou um novo contrato.' using errcode = '42501';
    end if;
  elsif new.status <> 'rascunho' or new.contract_id is not null or new.agreement_id is not null then
    raise exception 'Use "Ativar" para tornar o contrato vigente.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger trg_labor_contracts_before before insert or update on public.labor_contracts
  for each row execute function public.labor_contract_before();

-- Parcelas: só mudam enquanto o contrato é rascunho (depois, só o lançamento no Financeiro, pela função).
create or replace function public.labor_installment_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.labor_contracts where id = coalesce(new.contract_id, old.contract_id);
  if v_status <> 'rascunho' and not public.eh_sistema() then
    raise exception 'As parcelas de um contrato vigente não mudam.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_labor_installments_before before insert or update or delete on public.labor_contract_installments
  for each row execute function public.labor_installment_before();

-- Atividades abrangidas pelas fases (todas as descendentes), para o vínculo de remuneração.
create or replace function public.atividades_das_fases(p_project uuid, p_fases uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  with recursive desce as (
    select w.id from public.wbs_nodes w where w.project_id = p_project and w.id = any(p_fases) and w.deleted_at is null
    union all
    select w.id from public.wbs_nodes w join desce d on w.parent_id = d.id where w.deleted_at is null
  )
  select coalesce(array_agg(distinct id), '{}') from desce
$$;

-- Ativar: confere o contrato e cria o compromisso no Financeiro e, se for por medição, o vínculo de remuneração.
create or replace function public.contrato_mo_ativar(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k public.labor_contracts; w public.workers; v_soma numeric; v_n int; v_ctr uuid; v_ag uuid;
begin
  select * into k from public.labor_contracts where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Contrato não encontrado.' using errcode = '22023'; end if;
  if not public.pode_contratar(k.project_id) then raise exception 'Seu usuário não contrata nesta obra.' using errcode = '42501'; end if;
  if k.status <> 'rascunho' then raise exception 'O contrato já está %.', k.status using errcode = '22023'; end if;
  select * into w from public.workers where id = k.worker_id;
  if w.status <> 'ativo' or w.deleted_at is not null then raise exception 'O profissional está inativo.' using errcode = '22023'; end if;
  if k.payment_mode <> 'avulso' and k.amount is null then
    raise exception 'Informe o valor do contrato.' using errcode = '22023';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_soma from public.labor_contract_installments where contract_id = k.id;
  if k.payment_mode in ('mensal', 'parcelas') then
    if v_n = 0 then raise exception 'Gere as parcelas antes de ativar.' using errcode = '22023'; end if;
    if abs(v_soma - k.amount) > 0.01 then
      raise exception 'A soma das parcelas (%) é diferente do valor do contrato (%).', public.fmt_brl(v_soma), public.fmt_brl(k.amount) using errcode = '23514';
    end if;
  end if;
  if k.payment_mode = 'medicao' and k.start_date is null then
    raise exception 'Informe a data de início (vigência do contrato nas medições).' using errcode = '22023';
  end if;
  perform set_config('geplan.sistema', '1', true);
  if k.amount is not null then
    insert into public.contracts (project_id, kind, number, supplier_name, supplier_id, category, amount, status, contract_date, scope, phase_id)
    values (k.project_id, 'Contrato', left('CTR-' || lpad(k.number::text, 4, '0') || ' · ' || k.title, 120), w.name, w.supplier_id, 'Mão de obra',
            k.amount, 'Aprovado', coalesce(k.start_date, current_date), left(coalesce(nullif(k.scope, ''), k.title), 2000),
            case when cardinality(k.phase_ids) = 1 then k.phase_ids[1] end)
    returning id into v_ctr;
  end if;
  if k.payment_mode = 'medicao' then
    insert into public.worker_agreements (org_id, worker_id, project_id, pay_type, role_name, contract_amount, activity_ids, valid_from, valid_to, conditions)
    values (k.org_id, k.worker_id, k.project_id, 'empreitada', left(k.title, 120), k.amount,
            case when cardinality(k.phase_ids) = 0 then '{}' else public.atividades_das_fases(k.project_id, k.phase_ids) end,
            k.start_date, k.end_date, 'Contrato CTR-' || lpad(k.number::text, 4, '0'))
    returning id into v_ag;
  end if;
  update public.labor_contracts set status = 'vigente', contract_id = v_ctr, agreement_id = v_ag where id = k.id;
end $$;

-- Lançar uma parcela no Financeiro (despesa do contrato: abate do comprometido).
create or replace function public.contrato_mo_lancar_parcela(p_installment uuid, p_date date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare i public.labor_contract_installments; k public.labor_contracts; v_exp uuid;
begin
  select * into i from public.labor_contract_installments where id = p_installment for update;
  if not found then raise exception 'Parcela não encontrada.' using errcode = '22023'; end if;
  select * into k from public.labor_contracts where id = i.contract_id;
  if not public.can_write_project(k.project_id, 'financeiro') or not public.ve_valores_mo(k.project_id) then
    raise exception 'Seu usuário não lança despesas nesta obra.' using errcode = '42501';
  end if;
  if k.status <> 'vigente' then raise exception 'Só contrato vigente lança parcelas.' using errcode = '22023'; end if;
  if i.expense_id is not null then raise exception 'Esta parcela já foi lançada.' using errcode = '22023'; end if;
  insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, contract_id, amount, due_date, phase_id)
  select k.project_id, coalesce(p_date, current_date), 'CTR-' || lpad(k.number::text, 4, '0') || '/' || i.number, w.name, w.supplier_id,
         k.title || ' — parcela ' || i.number || '/' || (select count(*) from public.labor_contract_installments where contract_id = k.id)
           || coalesce(' — ' || nullif(i.description, ''), ''),
         'Mão de obra', k.contract_id, i.amount, i.due_date, case when cardinality(k.phase_ids) = 1 then k.phase_ids[1] end
    from public.workers w where w.id = k.worker_id
  returning id into v_exp;
  perform set_config('geplan.sistema', '1', true);
  update public.labor_contract_installments set expense_id = v_exp where id = i.id;
  return v_exp;
end $$;

-- Encerrar: concluído ou rescindido (com motivo). O compromisso passa a contar só o que já foi lançado (Encerrado) e o
-- vínculo de medição deixa de valer a partir de hoje.
create or replace function public.contrato_mo_encerrar(p_id uuid, p_status text, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare k public.labor_contracts;
begin
  select * into k from public.labor_contracts where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Contrato não encontrado.' using errcode = '22023'; end if;
  if not public.pode_contratar(k.project_id) then raise exception 'Seu usuário não contrata nesta obra.' using errcode = '42501'; end if;
  if k.status <> 'vigente' then raise exception 'Só contrato vigente pode ser encerrado.' using errcode = '22023'; end if;
  if p_status not in ('concluido', 'rescindido') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Informe o motivo.' using errcode = '22023'; end if;
  perform set_config('geplan.sistema', '1', true);
  update public.labor_contracts set status = p_status, close_reason = trim(p_motivo) where id = k.id;
  if k.contract_id is not null then update public.contracts set status = 'Encerrado' where id = k.contract_id; end if;
  if k.agreement_id is not null then
    update public.worker_agreements set valid_to = greatest(valid_from, current_date) where id = k.agreement_id and (valid_to is null or valid_to > current_date);
  end if;
end $$;

-- Medição lançada no Financeiro: quando o vínculo é de um contrato, a despesa fica ligada ao contrato (abate do
-- comprometido em vez de somar de novo). Mesma assinatura e regras da 0010.
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
  for w in select p.worker_id, k.name, k.supplier_id, public.fase_raiz(i.activity_id) as fase, lc.contract_id, sum(p.amount) total, array_agg(p.id) ids
             from public.measurement_pay p
             join public.workers k on k.id = p.worker_id
             join public.measurement_workers mw on mw.id = p.worker_line_id
             join public.measurement_items i on i.id = mw.item_id
             left join public.labor_contracts lc on lc.agreement_id = p.agreement_id and lc.agreement_id is not null and lc.deleted_at is null
            where p.sheet_id = s.id and p.expense_id is null and coalesce(p.amount, 0) > 0
            group by p.worker_id, k.name, k.supplier_id, public.fase_raiz(i.activity_id), lc.contract_id loop
    insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, contract_id, amount, due_date, phase_id)
    values (s.project_id, s.period_end, 'MED-' || lpad(s.number::text, 4, '0'), w.name, w.supplier_id,
            'Medição nº ' || s.number || ' (' || to_char(s.period_start, 'DD/MM') || ' a ' || to_char(s.period_end, 'DD/MM/YYYY') || ') — produção'
              || coalesce(' — ' || nullif((select f.description from public.wbs_nodes f where f.id = w.fase), ''), ''),
            'Mão de obra', w.contract_id, w.total, p_due, w.fase)
    returning id into v_exp;
    update public.measurement_pay set expense_id = v_exp where id = any(w.ids);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then perform public.evento_medicao(s.id, s.project_id, 'financeiro', v_n || ' despesa(s) de mão de obra lançada(s) no Financeiro.'); end if;
  return v_n;
end $$;

-- Medição a lançar de um contrato já está no comprometido (valor do contrato): ela continua aparecendo como "a lançar",
-- mas só soma no comprometido quando NÃO é de contrato (mesma regra da 0010 para o resto).
create or replace view public.v_medicao_a_lancar with (security_invoker = true) as
select p.id as pay_id, p.project_id, p.sheet_id, s.number as sheet_number, s.period_end, i.activity_id,
       public.fase_raiz(i.activity_id) as phase_id, p.worker_id, p.amount,
       (select lc.contract_id from public.labor_contracts lc where lc.agreement_id = p.agreement_id and lc.deleted_at is null limit 1) as contract_id
from public.measurement_pay p
join public.measurement_sheets s on s.id = p.sheet_id and s.deleted_at is null and s.status = 'aprovado'
join public.measurement_workers w on w.id = p.worker_line_id
join public.measurement_items i on i.id = w.item_id
where p.expense_id is null and coalesce(p.amount, 0) > 0;

create or replace view public.v_project_costs with (security_invoker = true) as
select p.id as project_id,
       coalesce((select sum(t.committed_amount) from public.v_contract_totals t where t.project_id = p.id), 0)
         + coalesce((select sum(e.amount) from public.expenses e
                     where e.project_id = p.id and e.deleted_at is null and e.contract_id is null), 0)
         + coalesce((select sum(m.amount) from public.v_medicao_a_lancar m where m.project_id = p.id and m.contract_id is null), 0) as committed,
       coalesce((select sum(e.amount) from public.expenses e where e.project_id = p.id and e.deleted_at is null), 0) as incurred,
       coalesce((select sum(pg.amount) from public.payments pg join public.expenses e on e.id = pg.expense_id and e.deleted_at is null
                 where pg.project_id = p.id and pg.deleted_at is null), 0) as paid,
       coalesce((select sum(greatest(0, t.committed_amount - t.incurred)) from public.v_contract_totals t where t.project_id = p.id), 0)
         + coalesce((select sum(m.amount) from public.v_medicao_a_lancar m where m.project_id = p.id and m.contract_id is null), 0) as to_incur,
       coalesce((select sum(m.amount) from public.v_medicao_a_lancar m where m.project_id = p.id), 0) as to_launch
from public.projects p
where p.deleted_at is null;

create or replace function public.custos_por_fase(p_project uuid, p_ate date default null)
returns table (phase_id uuid, code text, description text, budget numeric, committed numeric, incurred numeric,
               paid numeric, to_launch numeric)
language sql stable set search_path = public as $$
  with
  fases as (
    select w.id, w.code, w.description, w.position from public.wbs_nodes w
     where w.project_id = p_project and w.parent_id is null and w.deleted_at is null
  ),
  itens as (select b.id, b.total_cost from public.budget_items b where b.project_id = p_project and b.deleted_at is null),
  aloc_item as (
    select a.budget_item_id as item_id, public.fase_raiz(a.activity_id) as phase_id, sum(a.share) as share
      from public.budget_allocations a join itens b on b.id = a.budget_item_id
     group by 1, 2
    union all
    select b.id, null::uuid, 1 - coalesce((select sum(a.share) from public.budget_allocations a where a.budget_item_id = b.id), 0)
      from itens b
     where 1 - coalesce((select sum(a.share) from public.budget_allocations a where a.budget_item_id = b.id), 0) > 0.000001
  ),
  aloc_contrato as (
    select c.id as contract_id, x.phase_id, x.share
      from public.contracts c
     cross join lateral (
       select public.fase_raiz(c.phase_id), 1::numeric where c.phase_id is not null
       union all
       select ai.phase_id, ai.share from aloc_item ai where c.phase_id is null and ai.item_id = c.budget_item_id
       union all
       select null::uuid, 1::numeric where c.phase_id is null and (c.budget_item_id is null or not exists (select 1 from itens b where b.id = c.budget_item_id))
     ) x(phase_id, share)
     where c.project_id = p_project and c.deleted_at is null
  ),
  contratos as (
    select c.id, case when c.status in ('Cancelado', 'Encerrado') then inc.v else tot.v end as compromisso
      from public.contracts c
     cross join lateral (select c.amount + coalesce(sum(a.amount), 0) as v from public.contract_amendments a
                          where a.contract_id = c.id and a.deleted_at is null and (p_ate is null or a.amend_date is null or a.amend_date <= p_ate)) tot
     cross join lateral (select coalesce(sum(e.amount), 0) as v from public.expenses e
                          where e.contract_id = c.id and e.deleted_at is null and (p_ate is null or e.expense_date <= p_ate)) inc
     where c.project_id = p_project and c.deleted_at is null and (p_ate is null or c.contract_date is null or c.contract_date <= p_ate)
  ),
  despesas as (
    select e.id, e.amount, e.phase_id, e.budget_item_id, e.contract_id,
           (e.contract_id is null or not exists (select 1 from contratos k where k.id = e.contract_id)) as avulsa
      from public.expenses e
     where e.project_id = p_project and e.deleted_at is null and (p_ate is null or e.expense_date <= p_ate)
  ),
  aloc_despesa as (
    select d.id as expense_id, x.phase_id, x.share
      from despesas d
     cross join lateral (
       select public.fase_raiz(d.phase_id), 1::numeric where d.phase_id is not null
       union all
       select ai.phase_id, ai.share from aloc_item ai
        where d.phase_id is null and ai.item_id = d.budget_item_id
       union all
       select ac.phase_id, ac.share from aloc_contrato ac
        where d.phase_id is null and (d.budget_item_id is null or not exists (select 1 from itens b where b.id = d.budget_item_id))
          and ac.contract_id = d.contract_id
       union all
       select null::uuid, 1::numeric
        where d.phase_id is null and (d.budget_item_id is null or not exists (select 1 from itens b where b.id = d.budget_item_id))
          and (d.contract_id is null or not exists (select 1 from aloc_contrato ac where ac.contract_id = d.contract_id))
     ) x(phase_id, share)
  ),
  linhas as (
    select ai.phase_id, b.total_cost * ai.share as budget, 0::numeric as committed, 0::numeric as incurred, 0::numeric as paid, 0::numeric as to_launch
      from itens b join aloc_item ai on ai.item_id = b.id
    union all
    select ac.phase_id, 0, k.compromisso * ac.share, 0, 0, 0
      from contratos k join aloc_contrato ac on ac.contract_id = k.id
    union all
    select ad.phase_id, 0, case when d.avulsa then d.amount * ad.share else 0 end, d.amount * ad.share, 0, 0
      from despesas d join aloc_despesa ad on ad.expense_id = d.id
    union all
    select ad.phase_id, 0, 0, 0, pg.amount * ad.share, 0
      from public.payments pg join despesas d on d.id = pg.expense_id join aloc_despesa ad on ad.expense_id = d.id
     where pg.deleted_at is null and (p_ate is null or pg.pay_date <= p_ate)
    union all
    select m.phase_id, 0, case when m.contract_id is null then m.amount else 0 end, 0, 0, m.amount
      from public.v_medicao_a_lancar m
     where m.project_id = p_project and (p_ate is null or m.period_end <= p_ate)
  ),
  somas as (
    select l.phase_id, sum(l.budget) as budget, sum(l.committed) as committed, sum(l.incurred) as incurred,
           sum(l.paid) as paid, sum(l.to_launch) as to_launch
      from linhas l group by l.phase_id
  )
  select coalesce(f.id, s.phase_id), f.code, coalesce(f.description, 'Sem fase'),
         round(coalesce(s.budget, 0), 2), round(coalesce(s.committed, 0), 2), round(coalesce(s.incurred, 0), 2),
         round(coalesce(s.paid, 0), 2), round(coalesce(s.to_launch, 0), 2)
    from fases f full join somas s on s.phase_id = f.id
   order by f.position nulls last, f.code nulls last
$$;

-- Arquivo do contrato (PDF/Word assinado): pasta <empresa>/contratos/<contrato>/… — só quem vê valores lê; quem contrata grava.
create or replace function public.pode_ler_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_ver_fornecedor(public.arquivo_org(p_name))
    when 'suprimentos' then exists (select 1 from public.purchase_orders po where po.id::text = split_part(p_name, '/', 3)
                                    and po.org_id = public.arquivo_org(p_name) and public.can_read_costs(po.project_id))
    when 'obras' then coalesce(public.can_read_project(public.obra_do_caminho(p_name)), false)
    when 'empresa' then public.is_org_member(public.arquivo_org(p_name))
    when 'contratos' then exists (select 1 from public.labor_contracts lc where lc.id::text = split_part(p_name, '/', 3)
                                  and lc.org_id = public.arquivo_org(p_name) and public.ve_valores_mo(lc.project_id))
    else false end
$$;
create or replace function public.pode_gravar_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_gravar_fornecedor(public.arquivo_org(p_name))
    when 'suprimentos' then exists (select 1 from public.purchase_orders po where po.id::text = split_part(p_name, '/', 3)
                                    and po.org_id = public.arquivo_org(p_name)
                                    and (public.pode_solicitar(po.project_id) or public.pode_comprar(po.project_id) or public.pode_receber(po.project_id)))
    when 'obras' then coalesce(public.can_write_project(public.obra_do_caminho(p_name), 'execucao')
                               or public.can_write_project(public.obra_do_caminho(p_name), 'cadastro')
                               or public.pode_aprovar_rdo(public.obra_do_caminho(p_name)), false)
    when 'empresa' then public.is_org_admin(public.arquivo_org(p_name)) and public.org_subscription_ok(public.arquivo_org(p_name))
    when 'contratos' then exists (select 1 from public.labor_contracts lc where lc.id::text = split_part(p_name, '/', 3)
                                  and lc.org_id = public.arquivo_org(p_name) and public.pode_contratar(lc.project_id))
    else false end
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS e acessos
-- ---------------------------------------------------------------------------------------------
alter table public.labor_contracts enable row level security;
alter table public.labor_contract_installments enable row level security;

create policy labor_contracts_select on public.labor_contracts for select to authenticated using (public.ve_valores_mo(project_id));
create policy labor_contracts_insert on public.labor_contracts for insert to authenticated
  with check (public.pode_contratar(project_id) and public.org_subscription_ok(org_id) and deleted_at is null);
create policy labor_contracts_update on public.labor_contracts for update to authenticated
  using (public.pode_contratar(project_id)) with check (public.pode_contratar(project_id));

create policy labor_installments_select on public.labor_contract_installments for select to authenticated using (public.ve_valores_mo(project_id));
create policy labor_installments_insert on public.labor_contract_installments for insert to authenticated
  with check (public.pode_contratar(project_id) and expense_id is null);
create policy labor_installments_update on public.labor_contract_installments for update to authenticated
  using (public.pode_contratar(project_id)) with check (public.pode_contratar(project_id) and expense_id is null);
create policy labor_installments_delete on public.labor_contract_installments for delete to authenticated using (public.pode_contratar(project_id));

revoke all on public.labor_contracts, public.labor_contract_installments from anon, authenticated;
grant select, insert, update on public.labor_contracts to authenticated;
grant select, insert, update, delete on public.labor_contract_installments to authenticated;

revoke all on function public.pode_contratar(uuid), public.atividades_das_fases(uuid, uuid[]),
  public.contrato_mo_ativar(uuid), public.contrato_mo_lancar_parcela(uuid, date), public.contrato_mo_encerrar(uuid, text, text) from public, anon;
grant execute on function public.pode_contratar(uuid), public.contrato_mo_ativar(uuid), public.contrato_mo_lancar_parcela(uuid, date),
  public.contrato_mo_encerrar(uuid, text, text) to authenticated;
revoke all on function public.atividades_das_fases(uuid, uuid[]) from authenticated;
