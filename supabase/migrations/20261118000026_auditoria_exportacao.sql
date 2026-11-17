-- GEPLAN · 0026 · Auditoria visível ("quem fez o quê") e exportação contábil para o contador. Só funções (nada de tabela
-- nova; nada é apagado). A trilha já é gravada pelos gatilhos audit_row desde a migração 0001.
-- Quem vê a auditoria: administrador = tudo da empresa; financeiro e contador = só o financeiro da empresa (lançamentos,
-- baixas, contas, contratos com clientes, notas de serviço, conciliação). Os demais perfis não veem.
-- Exportação: pagamentos das despesas das obras um a um (fornecedor, documento, categoria) para quem vê o financeiro da
-- empresa, com a conta bancária quando o pagamento foi conciliado com o extrato.

create or replace function public.auditoria_tabelas_fin() returns text[]
language sql immutable as $$
  select array['fin_accounts', 'fin_cost_centers', 'fin_bank_accounts', 'fin_entries', 'fin_entry_splits', 'fin_settlements',
               'fin_bank_statements', 'fin_bank_lines', 'client_contracts', 'contract_allowances', 'service_invoices']
$$;

-- p_area: '' (tudo que o perfil vê) · 'financeiro' · 'obras' (registros ligados a uma obra) · 'compras' · 'cadastros'
create or replace function public.auditoria_listar(p_org uuid, p_de date, p_ate date, p_area text default '',
                                                   p_limite integer default 300)
returns table (id bigint, changed_at timestamptz, quem text, table_name text, action text, row_id text,
               project_id uuid, obra text, old_data jsonb, new_data jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_papel text := coalesce(public.org_role(p_org)::text, '');
  v_so_fin boolean;
begin
  if v_papel not in ('admin', 'financeiro', 'contador') then
    raise exception 'Seu perfil não acessa a auditoria (só administrador, financeiro e contador).' using errcode = '42501';
  end if;
  if coalesce(p_area, '') not in ('', 'financeiro', 'obras', 'compras', 'cadastros') then
    raise exception 'Área inválida.' using errcode = '22023';
  end if;
  if p_de is null or p_ate is null or p_ate < p_de then raise exception 'Período inválido.' using errcode = '22023'; end if;
  v_so_fin := v_papel <> 'admin';
  return query
  select a.id, a.changed_at,
         coalesce(nullif(u.full_name, ''), u.email, case when a.changed_by is null then 'sistema' else 'usuário removido' end),
         a.table_name, a.action, a.row_id, a.project_id, p.name, a.old_data, a.new_data
    from public.audit_log a
    left join public.user_profiles u on u.id = a.changed_by
    left join public.projects p on p.id = a.project_id
   where a.org_id = p_org
     and a.changed_at >= p_de::timestamptz and a.changed_at < (p_ate + 1)::timestamptz
     and (not v_so_fin or a.table_name = any (public.auditoria_tabelas_fin()))
     and (coalesce(p_area, '') = ''
          or (p_area = 'financeiro' and a.table_name = any (public.auditoria_tabelas_fin()))
          or (p_area = 'obras' and a.project_id is not null and not (a.table_name like 'purchase\_%'))
          or (p_area = 'compras' and (a.table_name like 'purchase\_%' or a.table_name in ('suppliers', 'supplier_evaluations', 'supplier_documents',
                                                                                        'stock_items', 'stock_moves', 'material_transfers')))
          or (p_area = 'cadastros' and a.table_name in ('projects', 'workers', 'worker_agreements', 'org_pix_access', 'suppliers')))
   order by a.changed_at desc, a.id desc
   limit greatest(1, least(coalesce(p_limite, 300), 1000));
end $$;

-- Pagamentos das obras (dinheiro que saiu) para a exportação contábil, um a um.
create or replace function public.contabil_pagamentos_obras(p_org uuid, p_de date, p_ate date)
returns table (payment_id uuid, pay_date date, amount numeric, project_id uuid, obra text, category text, supplier_name text,
               document text, description text, client_funds boolean, bank_account_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ve_fin_empresa(p_org) then
    raise exception 'Seu perfil não acessa o financeiro da empresa.' using errcode = '42501';
  end if;
  if p_de is null or p_ate is null or p_ate < p_de then raise exception 'Período inválido.' using errcode = '22023'; end if;
  return query
  select pg.id, pg.pay_date, pg.amount, pr.id, pr.name, e.category, e.supplier_name, e.document, e.description,
         coalesce(cc.client_funds, false),
         (select l.bank_account_id from public.fin_bank_lines l where l.payment_id = pg.id and l.status = 'conciliado' limit 1)
    from public.payments pg
    join public.expenses e on e.id = pg.expense_id and e.deleted_at is null and e.transfer_id is null
    join public.projects pr on pr.id = e.project_id and pr.org_id = p_org and pr.deleted_at is null
    left join public.fin_cost_centers cc on cc.project_id = pr.id
   where pg.deleted_at is null and pg.pay_date between p_de and p_ate
   order by pg.pay_date, pr.name;
end $$;

revoke all on function public.auditoria_tabelas_fin() from public, anon;
revoke all on function public.auditoria_listar(uuid, date, date, text, integer) from public, anon;
revoke all on function public.contabil_pagamentos_obras(uuid, date, date) from public, anon;
grant execute on function public.auditoria_tabelas_fin() to authenticated;
grant execute on function public.auditoria_listar(uuid, date, date, text, integer) to authenticated;
grant execute on function public.contabil_pagamentos_obras(uuid, date, date) to authenticated;
