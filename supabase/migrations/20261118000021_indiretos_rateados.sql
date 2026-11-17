-- GEPLAN · 0021 · Indiretos rateados: a parte dos lançamentos da EMPRESA rateada para uma obra (ex.: salário do
-- engenheiro supervisor dividido entre Matriz e obras) aparece nos custos da obra só como TOTAL por tipo de conta, sem
-- nome, conta ou valor individual — quem vê os custos da obra (engenharia) não vê salários nem o financeiro da empresa.

create or replace function public.indiretos_rateados(p_project uuid)
returns table (kind text, total numeric, pago numeric, lancamentos integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_read_costs(p_project) then
    raise exception 'Seu perfil não vê os custos desta obra.' using errcode = '42501';
  end if;
  return query
    with r as (
      select a.kind, e.id, e.amount * s.pct / 100 as parte,
             coalesce((select sum(b.amount) from public.fin_settlements b where b.entry_id = e.id and b.deleted_at is null), 0) / e.amount * (e.amount * s.pct / 100) as parte_paga
        from public.fin_entries e
        join public.fin_entry_splits s on s.entry_id = e.id
        join public.fin_cost_centers c on c.id = s.cost_center_id and c.project_id = p_project
        join public.fin_accounts a on a.id = e.account_id
       where e.kind = 'pagar' and e.status <> 'cancelado'
    )
    select r.kind, round(sum(r.parte), 2), round(sum(r.parte_paga), 2), count(distinct r.id)::int from r group by r.kind;
end $$;

revoke all on function public.indiretos_rateados(uuid) from public, anon;
grant execute on function public.indiretos_rateados(uuid) to authenticated;
