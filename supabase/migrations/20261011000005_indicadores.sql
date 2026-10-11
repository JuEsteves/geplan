-- GEPLAN · 0005 · Indicadores financeiros calculados no banco (NUMERIC exato), com as mesmas fórmulas de
-- js/financeiro.js. As views usam security_invoker: respeitam o RLS de quem consulta.

-- BDI pela fórmula do TCU (componentes em %): [(1+AC+S+R+G)(1+DF)(1+L)]/(1−I) − 1
create or replace function public.bdi_tcu(ac numeric, s numeric, r numeric, g numeric, df numeric, l numeric, i numeric)
returns numeric language sql immutable as $$
  select case when i >= 100 then null
    else ((1 + ac / 100 + s / 100 + r / 100 + g / 100) * (1 + df / 100) * (1 + l / 100)) / (1 - i / 100) - 1 end
$$;

-- Orçamento da obra: custo direto (Σ quantidade × custo unitário), BDI e preço de venda (BDI aplicado uma vez).
create or replace view public.v_project_budget with (security_invoker = true) as
select p.id as project_id,
       p.org_id,
       coalesce(sum(b.total_cost), 0)::numeric(18, 2) as direct_cost,
       public.bdi_tcu(p.bdi_ac, p.bdi_s, p.bdi_r, p.bdi_g, p.bdi_df, p.bdi_l, p.bdi_i) as bdi,
       round(coalesce(sum(b.total_cost), 0) * (1 + coalesce(public.bdi_tcu(p.bdi_ac, p.bdi_s, p.bdi_r, p.bdi_g, p.bdi_df, p.bdi_l, p.bdi_i), 0)), 2) as sale_price,
       count(b.id) as item_count,
       p.contract_value
from public.projects p
left join public.budget_items b on b.project_id = p.id and b.deleted_at is null
where p.deleted_at is null
group by p.id;

-- Situação de cada item: soma dos vínculos com a EAP (deve ser 100%).
create or replace view public.v_budget_item_allocation with (security_invoker = true) as
select b.id as budget_item_id, b.project_id, b.code, b.total_cost,
       coalesce(sum(a.share), 0) as allocated_share,
       round(b.total_cost * coalesce(sum(a.share), 0), 2) as allocated_cost,
       case when abs(coalesce(sum(a.share), 0) - 1) < 0.000001 then 'OK'
            when coalesce(sum(a.share), 0) = 0 then 'Sem vínculo' else 'Verificar' end as status
from public.budget_items b
left join public.budget_allocations a on a.budget_item_id = b.id
where b.deleted_at is null
group by b.id;

-- Total de cada contrato/pedido com aditivos e o quanto já foi consumido por despesas.
create or replace view public.v_contract_totals with (security_invoker = true) as
select c.id as contract_id, c.project_id, c.kind, c.number, c.supplier_name,
       c.amount + coalesce((select sum(a.amount) from public.contract_amendments a
                            where a.contract_id = c.id and a.deleted_at is null), 0) as total_amount,
       coalesce((select sum(e.amount) from public.expenses e
                 where e.contract_id = c.id and e.deleted_at is null), 0) as incurred
from public.contracts c
where c.deleted_at is null;

-- Custos da obra sem duplicidade:
--   comprometido = Σ contratos/pedidos (com aditivos) + Σ despesas sem contrato
--   incorrido    = Σ despesas · pago = Σ pagamentos · a pagar = incorrido − pago
--   a incorrer   = Σ max(0, total do contrato − despesas do contrato)
create or replace view public.v_project_costs with (security_invoker = true) as
select p.id as project_id,
       coalesce((select sum(t.total_amount) from public.v_contract_totals t where t.project_id = p.id), 0)
         + coalesce((select sum(e.amount) from public.expenses e
                     where e.project_id = p.id and e.deleted_at is null and e.contract_id is null), 0) as committed,
       coalesce((select sum(e.amount) from public.expenses e where e.project_id = p.id and e.deleted_at is null), 0) as incurred,
       coalesce((select sum(pg.amount) from public.payments pg join public.expenses e on e.id = pg.expense_id and e.deleted_at is null
                 where pg.project_id = p.id and pg.deleted_at is null), 0) as paid,
       coalesce((select sum(greatest(0, t.total_amount - t.incurred)) from public.v_contract_totals t where t.project_id = p.id), 0) as to_incur
from public.projects p
where p.deleted_at is null;

-- Uso do plano pela empresa (área do assinante).
create or replace view public.v_org_usage with (security_invoker = true) as
select o.id as org_id,
       s.plan_id, s.status, s.trial_ends_at, s.current_period_end,
       pl.max_projects, pl.max_users, pl.max_storage_mb,
       (select count(*) from public.projects p where p.org_id = o.id and p.deleted_at is null) as projects_used,
       (select count(*) from public.organization_members m where m.org_id = o.id) as users_used
from public.organizations o
left join public.subscriptions s on s.org_id = o.id
left join public.plans pl on pl.id = s.plan_id
where o.deleted_at is null;

revoke all on public.v_project_budget, public.v_budget_item_allocation, public.v_contract_totals,
  public.v_project_costs, public.v_org_usage from anon;
grant select on public.v_project_budget, public.v_budget_item_allocation, public.v_contract_totals,
  public.v_project_costs, public.v_org_usage to authenticated;
