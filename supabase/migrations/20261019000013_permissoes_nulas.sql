-- GEPLAN · 0013 · Correção de segurança: funções de permissão devolviam NULO (em vez de FALSO) para quem não tem
-- vínculo nenhum com a obra/empresa. Nas políticas RLS nulo já equivale a "negado", mas dentro das funções que gravam
-- (ex.: `if not can_write_project(...) then raise ...`), "not nulo" é nulo e o IF não dispara — a checagem era pulada.
-- Ex.: pessoa sem empresa, conhecendo o id de um boletim de outra empresa, conseguia lançar a medição no Financeiro.
-- Correção: as funções passam a devolver sempre verdadeiro ou falso (coalesce). Mesmas regras de antes; só o caso
-- "sem vínculo" muda de nulo para falso. Nenhum dado é alterado.

create or replace function public.can_read_project(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.project_role(p_project) is not null, false)
$$;

create or replace function public.can_read_costs(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras'), false)
$$;

create or replace function public.can_write_project(p_project uuid, p_area text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case p_area
    when 'cadastro'      then public.project_role(p_project) in ('admin', 'engenheiro')
    when 'planejamento'  then public.project_role(p_project) in ('admin', 'engenheiro')
    when 'execucao'      then public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor')
    when 'financeiro'    then public.project_role(p_project) in ('admin', 'engenheiro', 'financeiro')
    when 'compras'       then public.project_role(p_project) in ('admin', 'engenheiro', 'supervisor', 'financeiro', 'compras')
                              and public.tem_liberacao(public.project_org(p_project), 'comprar')
    else false
  end and public.org_subscription_ok(public.project_org(p_project)), false)
$$;

create or replace function public.ve_valores_mo(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.project_role(p_project) in ('admin', 'engenheiro', 'financeiro'), false)
$$;

create or replace function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org) = 'admin', false)
$$;

create or replace function public.grava_profissional(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org) in ('admin', 'engenheiro', 'supervisor', 'financeiro') and public.org_subscription_ok(p_org), false)
$$;

create or replace function public.ve_valores_mo_org(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org) in ('admin', 'engenheiro', 'financeiro'), false)
$$;
