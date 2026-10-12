-- GEPLAN · 0010 · Integração de custos: orçado × comprometido × incorrido × pago por fase da EAP, sem duplicidade.
-- Somente acréscimos e substituição de views/funções (nenhum dado é alterado). Regras da empresa (decisões da Etapa 4):
--   • contrato/pedido "Cancelado" ou "Encerrado" conta no comprometido só o que já foi incorrido nele;
--   • medição aprovada e ainda não lançada no Financeiro entra no comprometido (linha "a lançar"); ao ser lançada vira
--     despesa e sai dessa linha (measurement_pay.expense_id), sem contar duas vezes;
--   • valor contratado de empreitada só entra quando medido (o vínculo de remuneração não é compromisso);
--   • fase na despesa é opcional; sem fase, o valor aparece na linha "Sem fase" (nada é distribuído por estimativa);
--   • Suprimentos acompanha o pedido; nota fiscal e custo ficam no Financeiro.
-- Fase de um valor (nesta ordem): fase informada → item do orçamento (repartido pelos vínculos com a EAP; o que faltar
-- para 100% fica em "Sem fase") → contrato/pedido da despesa → "Sem fase". "Fase" = etapa raiz da EAP.

-- ---------------------------------------------------------------------------------------------
-- Fase na despesa (opcional)
-- ---------------------------------------------------------------------------------------------
alter table public.expenses add column if not exists phase_id uuid;
do $$ begin
  alter table public.expenses add constraint expenses_phase_fk foreign key (phase_id, project_id)
    references public.wbs_nodes (id, project_id) on delete restrict;
exception when duplicate_object then null; end $$;
create index if not exists expenses_phase_idx on public.expenses (phase_id) where phase_id is not null;

-- Etapa raiz (fase) de um nó da EAP. Respeita o RLS de quem consulta.
create or replace function public.fase_raiz(p_node uuid) returns uuid
language sql stable set search_path = public as $$
  with recursive sobe as (
    select id, parent_id, 1 as n from public.wbs_nodes where id = p_node
    union all
    select w.id, w.parent_id, s.n + 1 from public.wbs_nodes w join sobe s on w.id = s.parent_id where s.n < 20
  )
  select id from sobe where parent_id is null limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Contratos: valor que conta no comprometido (cancelado/encerrado = só o incorrido)
-- ---------------------------------------------------------------------------------------------
create or replace view public.v_contract_totals with (security_invoker = true) as
select c.id as contract_id, c.project_id, c.kind, c.number, c.supplier_name,
       t.total as total_amount,
       i.incurred,
       c.status,
       case when c.status in ('Cancelado', 'Encerrado') then i.incurred else t.total end as committed_amount
from public.contracts c
cross join lateral (select c.amount + coalesce(sum(a.amount), 0) as total from public.contract_amendments a
                     where a.contract_id = c.id and a.deleted_at is null) t
cross join lateral (select coalesce(sum(e.amount), 0) as incurred from public.expenses e
                     where e.contract_id = c.id and e.deleted_at is null) i
where c.deleted_at is null;

-- Valores de medições aprovadas ainda não lançados no Financeiro (só admin/engenheiro/financeiro leem, pelo RLS).
create or replace view public.v_medicao_a_lancar with (security_invoker = true) as
select p.id as pay_id, p.project_id, p.sheet_id, s.number as sheet_number, s.period_end, i.activity_id,
       public.fase_raiz(i.activity_id) as phase_id, p.worker_id, p.amount
from public.measurement_pay p
join public.measurement_sheets s on s.id = p.sheet_id and s.deleted_at is null and s.status = 'aprovado'
join public.measurement_workers w on w.id = p.worker_line_id
join public.measurement_items i on i.id = w.item_id
where p.expense_id is null and coalesce(p.amount, 0) > 0;

-- Custos da obra sem duplicidade:
--   comprometido = Σ contratos/pedidos (cancelado/encerrado: só o incorrido) + Σ despesas sem contrato + Σ medições a lançar
--   incorrido    = Σ despesas · pago = Σ pagamentos · a incorrer = Σ max(0, comprometido do contrato − incorrido) + a lançar
create or replace view public.v_project_costs with (security_invoker = true) as
select p.id as project_id,
       coalesce((select sum(t.committed_amount) from public.v_contract_totals t where t.project_id = p.id), 0)
         + coalesce((select sum(e.amount) from public.expenses e
                     where e.project_id = p.id and e.deleted_at is null and e.contract_id is null), 0)
         + coalesce((select sum(m.amount) from public.v_medicao_a_lancar m where m.project_id = p.id), 0) as committed,
       coalesce((select sum(e.amount) from public.expenses e where e.project_id = p.id and e.deleted_at is null), 0) as incurred,
       coalesce((select sum(pg.amount) from public.payments pg join public.expenses e on e.id = pg.expense_id and e.deleted_at is null
                 where pg.project_id = p.id and pg.deleted_at is null), 0) as paid,
       coalesce((select sum(greatest(0, t.committed_amount - t.incurred)) from public.v_contract_totals t where t.project_id = p.id), 0)
         + coalesce((select sum(m.amount) from public.v_medicao_a_lancar m where m.project_id = p.id), 0) as to_incur,
       coalesce((select sum(m.amount) from public.v_medicao_a_lancar m where m.project_id = p.id), 0) as to_launch
from public.projects p
where p.deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Custos por fase (mesmas regras de js/financeiro.js → custosPorFase). p_ate = data de corte (opcional):
-- contrato pela data do contrato, aditivo pela data do aditivo, despesa pela data, pagamento pela data do pagamento,
-- medição a lançar pelo fim do período. Linha com phase_id nulo = "Sem fase".
-- ---------------------------------------------------------------------------------------------
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
    select m.phase_id, 0, m.amount, 0, 0, m.amount
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

-- ---------------------------------------------------------------------------------------------
-- Lançar medição no Financeiro: uma despesa por profissional e por fase, já com a fase (custos por fase sem estimativa)
-- ---------------------------------------------------------------------------------------------
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
  for w in select p.worker_id, k.name, k.supplier_id, public.fase_raiz(i.activity_id) as fase, sum(p.amount) total, array_agg(p.id) ids
             from public.measurement_pay p
             join public.workers k on k.id = p.worker_id
             join public.measurement_workers mw on mw.id = p.worker_line_id
             join public.measurement_items i on i.id = mw.item_id
            where p.sheet_id = s.id and p.expense_id is null and coalesce(p.amount, 0) > 0
            group by p.worker_id, k.name, k.supplier_id, public.fase_raiz(i.activity_id) loop
    insert into public.expenses (project_id, expense_date, document, supplier_name, supplier_id, description, category, amount, due_date, phase_id)
    values (s.project_id, s.period_end, 'MED-' || lpad(s.number::text, 4, '0'), w.name, w.supplier_id,
            'Medição nº ' || s.number || ' (' || to_char(s.period_start, 'DD/MM') || ' a ' || to_char(s.period_end, 'DD/MM/YYYY') || ') — produção'
              || coalesce(' — ' || nullif((select f.description from public.wbs_nodes f where f.id = w.fase), ''), ''),
            'Mão de obra', w.total, p_due, w.fase)
    returning id into v_exp;
    update public.measurement_pay set expense_id = v_exp where id = any(w.ids);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then perform public.evento_medicao(s.id, s.project_id, 'financeiro', v_n || ' despesa(s) de mão de obra lançada(s) no Financeiro.'); end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Acessos
-- ---------------------------------------------------------------------------------------------
revoke all on public.v_contract_totals, public.v_project_costs, public.v_medicao_a_lancar from anon;
grant select on public.v_contract_totals, public.v_project_costs, public.v_medicao_a_lancar to authenticated;
revoke all on function public.fase_raiz(uuid), public.custos_por_fase(uuid, date) from public, anon;
grant execute on function public.fase_raiz(uuid), public.custos_por_fase(uuid, date) to authenticated;
revoke all on function public.medicao_lancar_despesas(uuid, date) from public, anon;
grant execute on function public.medicao_lancar_despesas(uuid, date) to authenticated;
