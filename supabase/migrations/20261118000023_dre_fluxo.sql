-- GEPLAN · 0023 · DRE e fluxo de caixa: o financeiro da empresa precisa dos custos e pagamentos de TODAS as obras, mesmo
-- de obras em que a pessoa do financeiro (ou o contador) não está na equipe. Esta função devolve só totais por obra, dia e
-- categoria (sem fornecedor, documento ou descrição) para quem vê o financeiro da empresa.
-- tipo: 'custo' (despesa pela data — competência) · 'pagamento' (pagamento pela data — caixa realizado) ·
--       'previsto' (saldo em aberto pelo vencimento — caixa previsto; inclui os vencidos). Transferências de sobra entram só
--       como custo (não são dinheiro). client_funds = obra por administração (custo com recursos do cliente, fora da DRE).

create or replace function public.fin_obras_movimentos(p_org uuid, p_de date, p_ate date)
returns table (project_id uuid, tipo text, categoria text, dia date, valor numeric, client_funds boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ve_fin_empresa(p_org) then
    raise exception 'Seu perfil não acessa o financeiro da empresa.' using errcode = '42501';
  end if;
  return query
  with obras as (
    select p.id, coalesce(c.client_funds, false) as cf from public.projects p
      left join public.fin_cost_centers c on c.project_id = p.id
     where p.org_id = p_org and p.deleted_at is null
  ), desp as (
    select e.* from public.expenses e join obras o on o.id = e.project_id where e.deleted_at is null
  ), pagos as (
    select p.expense_id, sum(p.amount) as total from public.payments p join desp d on d.id = p.expense_id where p.deleted_at is null group by p.expense_id
  )
  select d.project_id, 'custo'::text, d.category, d.expense_date, round(sum(d.amount), 2), o.cf
    from desp d join obras o on o.id = d.project_id
   where d.expense_date between p_de and p_ate
   group by d.project_id, d.category, d.expense_date, o.cf
  union all
  select d.project_id, 'pagamento'::text, d.category, p.pay_date, round(sum(p.amount), 2), o.cf
    from public.payments p join desp d on d.id = p.expense_id join obras o on o.id = d.project_id
   where p.deleted_at is null and d.transfer_id is null and p.pay_date between p_de and p_ate
   group by d.project_id, d.category, p.pay_date, o.cf
  union all
  select d.project_id, 'previsto'::text, d.category, coalesce(d.due_date, d.expense_date), round(sum(d.amount - coalesce(pg.total, 0)), 2), o.cf
    from desp d join obras o on o.id = d.project_id left join pagos pg on pg.expense_id = d.id
   where d.transfer_id is null and d.amount - coalesce(pg.total, 0) > 0.005 and coalesce(d.due_date, d.expense_date) <= p_ate
   group by d.project_id, d.category, coalesce(d.due_date, d.expense_date), o.cf;
end $$;

revoke all on function public.fin_obras_movimentos(uuid, date, date) from public, anon;
grant execute on function public.fin_obras_movimentos(uuid, date, date) to authenticated;
