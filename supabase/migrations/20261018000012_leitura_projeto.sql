-- GEPLAN · 0012 · Leitura de projeto com IA: registro de cada leitura (PDFs enviados, situação, resultado sugerido,
-- consumo) e limite mensal por empresa. Somente acréscimos.
--   • A IA só SUGERE etapas e subetapas da EAP; nada entra na obra sem a revisão de quem monta a EAP.
--   • Permissão e limite são conferidos no banco (funções abaixo); a chave da IA fica só na Edge Function (segredo do
--     Supabase), nunca no site.
--   • Limite mensal: plans.features.leituras_ia_mes (padrão 20 por empresa). Leituras com erro não contam.

create table if not exists public.project_ai_reads (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  project_id     uuid not null references public.projects (id) on delete restrict,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_label  text not null default '',
  files          jsonb not null default '[]'::jsonb,       -- [{ path, name, size }]
  status         text not null default 'processando' check (status in ('processando', 'concluida', 'erro', 'aplicada')),
  model          text not null default '',
  result         jsonb,
  error          text not null default '',
  input_tokens   integer,
  output_tokens  integer,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz,
  applied_at     timestamptz
);
create index if not exists project_ai_reads_project_idx on public.project_ai_reads (project_id, created_at desc);
create index if not exists project_ai_reads_org_idx on public.project_ai_reads (org_id, created_at);
create trigger trg_project_ai_reads_audit after insert or update or delete on public.project_ai_reads
  for each row execute function public.audit_row();

alter table public.project_ai_reads enable row level security;
create policy project_ai_reads_select on public.project_ai_reads for select to authenticated
  using (public.can_read_project(project_id));
-- Sem políticas de escrita: só pelas funções abaixo.

create or replace function public.ia_limite_mensal(p_org uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(pl.features ->> 'leituras_ia_mes', '')::int
                     from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.org_id = p_org), 20)
$$;

create or replace function public.ia_uso_mes(p_org uuid) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.project_ai_reads
   where org_id = p_org and status <> 'erro' and created_at >= date_trunc('month', now())
$$;

-- Reserva uma leitura (confere permissão, arquivos da própria obra e limite do mês). Devolve o id.
create or replace function public.ia_iniciar_leitura(p_project uuid, p_files jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid; f jsonb; v_lim int; v_uso int;
begin
  if not public.can_write_project(p_project, 'planejamento') then
    raise exception 'Seu usuário não monta a EAP desta obra.' using errcode = '42501';
  end if;
  select org_id into v_org from public.projects where id = p_project and deleted_at is null;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 or jsonb_array_length(p_files) > 10 then
    raise exception 'Envie de 1 a 10 arquivos PDF.' using errcode = '22023';
  end if;
  for f in select * from jsonb_array_elements(p_files) loop
    if coalesce(f ->> 'path', '') not like v_org::text || '/obras/' || p_project::text || '/%' or lower(f ->> 'path') not like '%.pdf' then
      raise exception 'Arquivo fora da pasta desta obra ou que não é PDF.' using errcode = '22023';
    end if;
  end loop;
  v_lim := public.ia_limite_mensal(v_org);
  v_uso := public.ia_uso_mes(v_org);
  if v_uso >= v_lim then
    raise exception 'Limite de % leituras de projeto por mês atingido pela empresa.', v_lim using errcode = '22023';
  end if;
  insert into public.project_ai_reads (org_id, project_id, created_label, files)
  values (v_org, p_project, public.rotulo_usuario(), p_files) returning id into v_id;
  return v_id;
end $$;

-- Grava o resultado (só quem iniciou, e só enquanto está processando).
create or replace function public.ia_concluir_leitura(p_id uuid, p_status text, p_result jsonb, p_error text,
                                                      p_model text, p_input integer, p_output integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('concluida', 'erro') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  update public.project_ai_reads
     set status = p_status, result = case when p_status = 'concluida' then p_result end, error = left(coalesce(p_error, ''), 2000),
         model = coalesce(p_model, ''), input_tokens = p_input, output_tokens = p_output, finished_at = now()
   where id = p_id and created_by = auth.uid() and status = 'processando';
  if not found then raise exception 'Leitura não encontrada ou já concluída.' using errcode = '22023'; end if;
end $$;

-- Marca a sugestão como aplicada à EAP (quem monta a EAP da obra).
create or replace function public.ia_marcar_aplicada(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.project_ai_reads;
begin
  select * into r from public.project_ai_reads where id = p_id;
  if not found or not public.can_write_project(r.project_id, 'planejamento') then
    raise exception 'Seu usuário não monta a EAP desta obra.' using errcode = '42501';
  end if;
  update public.project_ai_reads set status = 'aplicada', applied_at = now() where id = p_id and status = 'concluida';
end $$;

-- Uso do mês para mostrar na tela (só para quem vê a obra).
create or replace function public.ia_uso_obra(p_project uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.can_read_project(p_project)
    then jsonb_build_object('uso', public.ia_uso_mes(public.project_org(p_project)), 'limite', public.ia_limite_mensal(public.project_org(p_project)))
  end
$$;

revoke all on public.project_ai_reads from anon;
grant select on public.project_ai_reads to authenticated;
revoke all on function public.ia_limite_mensal(uuid), public.ia_uso_mes(uuid) from public, anon, authenticated;
revoke all on function public.ia_iniciar_leitura(uuid, jsonb), public.ia_concluir_leitura(uuid, text, jsonb, text, text, integer, integer),
  public.ia_marcar_aplicada(uuid), public.ia_uso_obra(uuid) from public, anon;
grant execute on function public.ia_iniciar_leitura(uuid, jsonb), public.ia_concluir_leitura(uuid, text, jsonb, text, text, integer, integer),
  public.ia_marcar_aplicada(uuid), public.ia_uso_obra(uuid) to authenticated;
