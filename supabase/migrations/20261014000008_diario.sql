-- GEPLAN · 0008 · Diário de obra (RDO): relatório por período (ou um dia), número por obra, situação com revisão e
-- aprovação (assinaturas em imagem), atividades da EAP com quantidade e situação, equipe própria/terceirizada,
-- equipamentos e materiais estruturados, ocorrências com horário e providências; fotos, vídeos, links e anexos
-- ligados à fase e à atividade; comentários; histórico de edições; visualizações; logo da empresa.
-- Somente acréscimos. O diário continua sincronizado com o documento da obra (funciona sem internet); número,
-- situação, aprovação e assinaturas são gravados só pelo banco (funções rdo_*), nunca pelo envio do aparelho.

-- ---------------------------------------------------------------------------------------------
-- Liberação nova: aprovar RDO (padrão: administrador e engenheiro)
-- ---------------------------------------------------------------------------------------------
alter table public.organization_members drop constraint if exists organization_members_permissions_validas;
alter table public.organization_members add constraint organization_members_permissions_validas
  check (permissions is null or permissions <@ array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo']);

create or replace function public.liberacoes_padrao(p_role public.member_role) returns text[]
language sql immutable as $$
  select case p_role
    when 'admin'      then array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo']
    when 'engenheiro' then array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo']
    when 'compras'    then array['solicitar', 'comprar', 'receber', 'fornecedores']
    when 'financeiro' then array['solicitar', 'comprar', 'fornecedores']
    when 'supervisor' then array['solicitar', 'receber']
    else array[]::text[]
  end
$$;
create or replace function public.minhas_liberacoes(p_org uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(k order by k), array[]::text[])
  from unnest(array['solicitar', 'comprar', 'receber', 'fornecedores', 'aprovar_rdo']) k
  where public.tem_liberacao(p_org, k)
$$;
create or replace function public.pode_aprovar_rdo(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_read_costs(p_project) and public.tem_liberacao(public.project_org(p_project), 'aprovar_rdo')
         and public.org_subscription_ok(public.project_org(p_project))
$$;

-- ---------------------------------------------------------------------------------------------
-- Logo da empresa (Storage: <empresa>/empresa/<arquivo>)
-- ---------------------------------------------------------------------------------------------
alter table public.organizations add column if not exists logo_path text not null default '';
do $$ begin
  alter table public.organizations add constraint organizations_logo_path check (logo_path = '' or logo_path like id::text || '/empresa/%');
exception when duplicate_object then null; end $$;
grant update (logo_path) on public.organizations to authenticated;   -- política organizations_update: só o administrador

-- ---------------------------------------------------------------------------------------------
-- Relatório: período, número, situação, aprovação e campos estruturados
-- ---------------------------------------------------------------------------------------------
alter table public.daily_reports
  add column if not exists period_end            date,
  add column if not exists number                integer not null default 0,
  add column if not exists status                text not null default 'preenchendo',
  add column if not exists work_conditions       text not null default '',
  add column if not exists stoppage_reason       text not null default '',
  add column if not exists equipment_list        jsonb not null default '[]'::jsonb,   -- [{nome, qtd, horas}]
  add column if not exists materials_list        jsonb not null default '[]'::jsonb,   -- [{descricao, qtd, unidade, fornecedor, divergencia}]
  add column if not exists updated_by            uuid references auth.users (id) on delete set null,
  add column if not exists review_note           text not null default '',
  add column if not exists filled_signature_path text not null default '',
  add column if not exists filled_signed_label   text not null default '',
  add column if not exists filled_signed_at      timestamptz,
  add column if not exists approved_by           uuid references auth.users (id) on delete set null,
  add column if not exists approved_label        text not null default '',
  add column if not exists approved_at           timestamptz,
  add column if not exists approved_signature_path text not null default '';
do $$ begin
  alter table public.daily_reports add constraint daily_reports_status check (status in ('preenchendo', 'revisao', 'devolvido', 'aprovado'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.daily_reports add constraint daily_reports_periodo check (period_end is null or period_end >= report_date);
exception when duplicate_object then null; end $$;

-- relatórios que já existiam: período de um dia e número pela ordem das datas (situação: preenchendo — nenhuma
-- aprovação é inventada)
update public.daily_reports d set number = n.rn
  from (select id, row_number() over (partition by project_id order by report_date, created_at) rn from public.daily_reports) n
 where n.id = d.id and d.number = 0;

alter table public.daily_report_crew
  add column if not exists kind     text not null default 'propria',
  add column if not exists company  text not null default '';
do $$ begin
  alter table public.daily_report_crew add constraint daily_report_crew_kind check (kind in ('propria', 'terceirizada'));
exception when duplicate_object then null; end $$;

alter table public.daily_report_activities
  add column if not exists quantity   numeric(18, 4) check (quantity is null or quantity >= 0),
  add column if not exists unit       text not null default '',
  add column if not exists situation  text not null default '',
  add column if not exists notes      text not null default '';

alter table public.site_occurrences
  add column if not exists occurred_at  text not null default '',     -- horário informado (HH:MM)
  add column if not exists actions      text not null default '',     -- providências
  add column if not exists responsible  text not null default '';

-- Número sequencial por obra (dado pelo banco); períodos da mesma obra não se sobrepõem.
create or replace function public.daily_report_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.period_end is not null and new.period_end < new.report_date then
    raise exception 'O fim do período (%) é antes do início (%).', to_char(new.period_end, 'DD/MM/YYYY'), to_char(new.report_date, 'DD/MM/YYYY') using errcode = '23514';
  end if;
  if exists (select 1 from public.daily_reports r where r.project_id = new.project_id and r.id <> new.id and r.deleted_at is null
             and new.deleted_at is null
             and daterange(r.report_date, coalesce(r.period_end, r.report_date), '[]') && daterange(new.report_date, coalesce(new.period_end, new.report_date), '[]')) then
    raise exception 'Já existe relatório da obra que cobre parte desse período.' using errcode = '23P01';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtext('daily_reports:' || new.project_id::text));
    select coalesce(max(number), 0) + 1 into new.number from public.daily_reports where project_id = new.project_id;
    if not public.eh_sistema() then
      new.status := 'preenchendo'; new.approved_by := null; new.approved_label := ''; new.approved_at := null;
      new.approved_signature_path := ''; new.filled_signature_path := ''; new.filled_signed_label := ''; new.filled_signed_at := null;
      new.review_note := '';
    end if;
    return new;
  end if;
  new.updated_by := auth.uid();
  if public.eh_sistema() then return new; end if;
  if new.number is distinct from old.number or new.status is distinct from old.status or new.project_id is distinct from old.project_id
     or new.approved_by is distinct from old.approved_by or new.approved_label is distinct from old.approved_label
     or new.approved_at is distinct from old.approved_at or new.approved_signature_path is distinct from old.approved_signature_path
     or new.filled_signature_path is distinct from old.filled_signature_path or new.filled_signed_label is distinct from old.filled_signed_label
     or new.filled_signed_at is distinct from old.filled_signed_at or new.review_note is distinct from old.review_note then
    raise exception 'Número, situação, aprovação e assinaturas do relatório são gravados pelas ações do relatório.' using errcode = '42501';
  end if;
  if old.status = 'aprovado' then
    raise exception 'O relatório nº % está aprovado: para alterar, ele precisa ser reaberto por quem aprova.', old.number using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_daily_reports_before on public.daily_reports;
create trigger trg_daily_reports_before before insert or update on public.daily_reports
  for each row execute function public.daily_report_before();

-- Partes do relatório (equipe, atividades, ocorrências) não mudam com o relatório aprovado.
create or replace function public.daily_report_part_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_st text; v_num int;
begin
  select status, number into v_st, v_num from public.daily_reports where id = coalesce(new.daily_report_id, old.daily_report_id);
  if v_st = 'aprovado' and not public.eh_sistema() then
    raise exception 'O relatório nº % está aprovado: para alterar, ele precisa ser reaberto por quem aprova.', v_num using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_daily_report_crew_lock on public.daily_report_crew;
create trigger trg_daily_report_crew_lock before insert or update or delete on public.daily_report_crew for each row execute function public.daily_report_part_before();
drop trigger if exists trg_daily_report_activities_lock on public.daily_report_activities;
create trigger trg_daily_report_activities_lock before insert or update or delete on public.daily_report_activities for each row execute function public.daily_report_part_before();
drop trigger if exists trg_site_occurrences_lock on public.site_occurrences;
create trigger trg_site_occurrences_lock before insert or update or delete on public.site_occurrences for each row execute function public.daily_report_part_before();

-- ---------------------------------------------------------------------------------------------
-- Histórico (edições, envio, aprovação, devolução, reabertura), comentários e visualizações
-- ---------------------------------------------------------------------------------------------
create table if not exists public.rdo_events (
  id            bigint generated always as identity primary key,
  report_id     uuid not null,
  project_id    uuid not null,
  kind          text not null check (kind in ('criacao', 'edicao', 'envio', 'aprovacao', 'devolucao', 'reabertura', 'assinatura', 'midia', 'exclusao')),
  body          text not null check (length(trim(body)) between 1 and 2000),
  author_id     uuid default auth.uid() references auth.users (id) on delete set null,
  author_label  text not null default '',
  created_at    timestamptz not null default now(),
  foreign key (report_id, project_id) references public.daily_reports (id, project_id) on delete restrict
);
create index if not exists rdo_events_report_idx on public.rdo_events (report_id, created_at);

create or replace function public.evento_rdo(p_report uuid, p_project uuid, p_kind text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into public.rdo_events (report_id, project_id, kind, body, author_id, author_label)
  values (p_report, p_project, p_kind, left(p_body, 2000), auth.uid(), public.rotulo_usuario())
$$;
-- Uma "edição" por pessoa a cada 2 minutos (o envio do aparelho grava relatório e partes em requisições separadas).
create or replace function public.evento_edicao_rdo(p_report uuid, p_project uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.rdo_events where report_id = p_report and kind in ('edicao', 'criacao')
                 and author_id is not distinct from auth.uid() and created_at > now() - interval '2 minutes') then
    perform public.evento_rdo(p_report, p_project, 'edicao', 'Relatório editado.');
  end if;
end $$;

create or replace function public.daily_report_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.eh_sistema() then return null; end if;
  if tg_op = 'INSERT' then
    perform public.evento_rdo(new.id, new.project_id, 'criacao', 'Relatório nº ' || new.number || ' criado ('
      || to_char(new.report_date, 'DD/MM/YYYY') || coalesce(' a ' || to_char(nullif(new.period_end, new.report_date), 'DD/MM/YYYY'), '') || ').');
  elsif new.deleted_at is not null and old.deleted_at is null then
    perform public.evento_rdo(new.id, new.project_id, 'exclusao', 'Relatório excluído.');
  else
    perform public.evento_edicao_rdo(new.id, new.project_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_daily_reports_after on public.daily_reports;
create trigger trg_daily_reports_after after insert or update on public.daily_reports
  for each row execute function public.daily_report_after();

create or replace function public.daily_report_part_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_proj uuid;
begin
  if public.eh_sistema() then return null; end if;
  select project_id into v_proj from public.daily_reports where id = coalesce(new.daily_report_id, old.daily_report_id);
  if v_proj is not null then perform public.evento_edicao_rdo(coalesce(new.daily_report_id, old.daily_report_id), v_proj); end if;
  return null;
end $$;
drop trigger if exists trg_daily_report_crew_ev on public.daily_report_crew;
create trigger trg_daily_report_crew_ev after insert or update or delete on public.daily_report_crew for each row execute function public.daily_report_part_after();
drop trigger if exists trg_daily_report_activities_ev on public.daily_report_activities;
create trigger trg_daily_report_activities_ev after insert or update or delete on public.daily_report_activities for each row execute function public.daily_report_part_after();
drop trigger if exists trg_site_occurrences_ev on public.site_occurrences;
create trigger trg_site_occurrences_ev after insert or update or delete on public.site_occurrences for each row execute function public.daily_report_part_after();

create table if not exists public.rdo_comments (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null,
  project_id    uuid not null,
  body          text not null check (length(trim(body)) between 1 and 2000),
  author_id     uuid default auth.uid() references auth.users (id) on delete set null,
  author_label  text not null default '',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (report_id, project_id) references public.daily_reports (id, project_id) on delete restrict
);
create index if not exists rdo_comments_report_idx on public.rdo_comments (report_id, created_at);
create trigger trg_rdo_comments_audit after insert or update or delete on public.rdo_comments for each row execute function public.audit_row();
create or replace function public.rdo_comment_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.author_id := auth.uid(); new.author_label := public.rotulo_usuario(); new.created_at := now();
  elsif new.body is distinct from old.body or new.author_id is distinct from old.author_id then
    raise exception 'Comentário não é editado; exclua e escreva de novo.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_rdo_comments_before before insert or update on public.rdo_comments for each row execute function public.rdo_comment_before();

create table if not exists public.rdo_views (
  report_id   uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  project_id  uuid not null,
  user_label  text not null default '',
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  views       integer not null default 1,
  primary key (report_id, user_id),
  foreign key (report_id, project_id) references public.daily_reports (id, project_id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Fotos, vídeos, links e anexos (Storage: <empresa>/obras/<obra>/rdo/<relatório>/<arquivo>)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.rdo_media (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null,
  project_id    uuid not null,
  kind          text not null check (kind in ('foto', 'video', 'link', 'anexo')),
  storage_path  text unique,
  url           text,
  name          text not null default '' check (length(name) <= 200),
  caption       text not null default '' check (length(caption) <= 500),
  taken_on      date,
  phase_id      uuid,
  activity_id   uuid,
  mime_type     text not null default '',
  size_bytes    bigint check (size_bytes is null or size_bytes between 1 and 52428800),
  position      integer not null default 0,
  uploaded_by   uuid default auth.uid() references auth.users (id) on delete set null,
  author_label  text not null default '',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (report_id, project_id) references public.daily_reports (id, project_id) on delete restrict,
  foreign key (phase_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict,
  foreign key (activity_id, project_id) references public.wbs_nodes (id, project_id) on delete restrict,
  check ((kind = 'link' and storage_path is null and url ~ '^https://[^\s]+$') or (kind <> 'link' and storage_path is not null and url is null))
);
create index if not exists rdo_media_report_idx on public.rdo_media (report_id, position) where deleted_at is null;
create index if not exists rdo_media_project_idx on public.rdo_media (project_id, kind) where deleted_at is null;
create index if not exists rdo_media_phase_idx on public.rdo_media (phase_id) where phase_id is not null;
create trigger trg_rdo_media_audit after insert or update or delete on public.rdo_media for each row execute function public.audit_row();

create or replace function public.rdo_media_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_st text; v_num int; v_org uuid;
begin
  select r.status, r.number, p.org_id into v_st, v_num, v_org from public.daily_reports r join public.projects p on p.id = r.project_id where r.id = new.report_id;
  if v_st = 'aprovado' and not public.eh_sistema() then
    raise exception 'O relatório nº % está aprovado: para incluir ou alterar mídias, ele precisa ser reaberto.', v_num using errcode = '42501';
  end if;
  if new.storage_path is not null and new.storage_path not like v_org::text || '/obras/' || new.project_id::text || '/rdo/' || new.report_id::text || '/%' then
    raise exception 'Caminho do arquivo não corresponde ao relatório.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then new.uploaded_by := auth.uid(); new.author_label := public.rotulo_usuario(); new.created_at := now();
  elsif new.storage_path is distinct from old.storage_path or new.kind is distinct from old.kind or new.report_id is distinct from old.report_id then
    raise exception 'O arquivo da mídia não é trocado; exclua e envie de novo.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_rdo_media_before before insert or update on public.rdo_media for each row execute function public.rdo_media_before();

create or replace function public.rdo_media_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.evento_rdo(new.report_id, new.project_id, 'midia', case new.kind when 'foto' then 'Foto incluída' when 'video' then 'Vídeo incluído'
      when 'link' then 'Link de vídeo incluído' else 'Anexo incluído' end || coalesce(': ' || nullif(new.name, ''), '') || '.');
  elsif new.deleted_at is not null and old.deleted_at is null then
    perform public.evento_rdo(new.report_id, new.project_id, 'midia', case new.kind when 'foto' then 'Foto removida' when 'video' then 'Vídeo removido'
      when 'link' then 'Link de vídeo removido' else 'Anexo removido' end || coalesce(': ' || nullif(new.name, ''), '') || '.');
  end if;
  return null;
end $$;
create trigger trg_rdo_media_after after insert or update on public.rdo_media for each row execute function public.rdo_media_after();

-- ---------------------------------------------------------------------------------------------
-- Ações do relatório: enviar para revisão, aprovar, devolver, reabrir, assinar (responsável)
-- ---------------------------------------------------------------------------------------------
create or replace function public.rdo_acao(p_report uuid, p_acao text, p_comment text default '', p_signature text default '') returns void
language plpgsql security definer set search_path = public as $$
declare r public.daily_reports; v_org uuid; v_txt text := trim(coalesce(p_comment, '')); v_sig text := trim(coalesce(p_signature, ''));
begin
  select * into r from public.daily_reports where id = p_report and deleted_at is null for update;
  if not found then raise exception 'Relatório não encontrado.' using errcode = '22023'; end if;
  select org_id into v_org from public.projects where id = r.project_id;
  if v_sig <> '' and v_sig not like v_org::text || '/obras/' || r.project_id::text || '/rdo/' || r.id::text || '/%' then
    raise exception 'Assinatura fora da pasta do relatório.' using errcode = '23514';
  end if;
  perform set_config('geplan.sistema', '1', true);
  if p_acao in ('enviar', 'assinar') then
    if not public.can_write_project(r.project_id, 'execucao') then
      raise exception 'Seu usuário não pode preencher o diário desta obra.' using errcode = '42501';
    end if;
    if r.status = 'aprovado' then raise exception 'Relatório já aprovado.' using errcode = '22023'; end if;
    if p_acao = 'enviar' and r.status not in ('preenchendo', 'devolvido') then
      raise exception 'O relatório já está em revisão.' using errcode = '22023';
    end if;
    if p_acao = 'assinar' and v_sig = '' then raise exception 'Envie a assinatura.' using errcode = '22023'; end if;
    update public.daily_reports set
      status = case when p_acao = 'enviar' then 'revisao' else status end,
      filled_signature_path = case when v_sig <> '' then v_sig else filled_signature_path end,
      filled_signed_label = case when v_sig <> '' then public.rotulo_usuario() else filled_signed_label end,
      filled_signed_at = case when v_sig <> '' then now() else filled_signed_at end
     where id = r.id;
    if v_sig <> '' then perform public.evento_rdo(r.id, r.project_id, 'assinatura', 'Assinado pelo responsável pelo preenchimento.'); end if;
    if p_acao = 'enviar' then perform public.evento_rdo(r.id, r.project_id, 'envio', 'Enviado para revisão' || coalesce(': ' || nullif(v_txt, ''), '.')); end if;
  elsif p_acao in ('aprovar', 'devolver', 'reabrir') then
    if not public.pode_aprovar_rdo(r.project_id) then
      raise exception 'Seu usuário não tem a liberação para aprovar relatórios desta obra.' using errcode = '42501';
    end if;
    if p_acao = 'aprovar' then
      if r.status = 'aprovado' then raise exception 'Relatório já aprovado.' using errcode = '22023'; end if;
      update public.daily_reports set status = 'aprovado', approved_by = auth.uid(), approved_label = public.rotulo_usuario(), approved_at = now(),
             approved_signature_path = v_sig, review_note = '' where id = r.id;
      perform public.evento_rdo(r.id, r.project_id, 'aprovacao', 'Relatório aprovado' || case when v_sig <> '' then ' e assinado' else '' end
        || coalesce(': ' || nullif(v_txt, ''), '.'));
    else
      if length(v_txt) < 5 then raise exception 'Informe o motivo (mínimo 5 caracteres).' using errcode = '22023'; end if;
      if p_acao = 'devolver' and r.status <> 'revisao' then raise exception 'Só relatório em revisão é devolvido.' using errcode = '22023'; end if;
      if p_acao = 'reabrir' and r.status <> 'aprovado' then raise exception 'Só relatório aprovado é reaberto.' using errcode = '22023'; end if;
      update public.daily_reports set status = case when p_acao = 'devolver' then 'devolvido' else 'preenchendo' end, review_note = v_txt,
             approved_by = null, approved_label = '', approved_at = null, approved_signature_path = '' where id = r.id;
      perform public.evento_rdo(r.id, r.project_id, case when p_acao = 'devolver' then 'devolucao' else 'reabertura' end,
        case when p_acao = 'devolver' then 'Devolvido para correção: ' else 'Reaberto (aprovação anterior desfeita): ' end || v_txt);
    end if;
  else
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
end $$;

create or replace function public.rdo_visualizar(p_report uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_proj uuid;
begin
  select project_id into v_proj from public.daily_reports where id = p_report and deleted_at is null;
  if v_proj is null or not public.can_read_project(v_proj) then return; end if;
  insert into public.rdo_views (report_id, user_id, project_id, user_label) values (p_report, auth.uid(), v_proj, public.rotulo_usuario())
  on conflict (report_id, user_id) do update set last_at = now(), views = public.rdo_views.views + 1;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Arquivos: novas áreas no Storage — 'obras' (capa da obra e mídias do diário) e 'empresa' (logo)
-- ---------------------------------------------------------------------------------------------
update storage.buckets set allowed_mime_types = (select array(select distinct unnest(allowed_mime_types || array['video/mp4', 'video/quicktime', 'video/webm'])))
 where id = 'documentos';

create or replace function public.obra_do_caminho(p_name text) returns uuid
language sql stable security definer set search_path = public as $$
  select p.id from public.projects p where p.id::text = split_part(p_name, '/', 3) and p.org_id = public.arquivo_org(p_name)
$$;
create or replace function public.pode_ler_arquivo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'fornecedores' then public.pode_ver_fornecedor(public.arquivo_org(p_name))
    when 'suprimentos' then exists (select 1 from public.purchase_orders po where po.id::text = split_part(p_name, '/', 3)
                                    and po.org_id = public.arquivo_org(p_name) and public.can_read_costs(po.project_id))
    when 'obras' then coalesce(public.can_read_project(public.obra_do_caminho(p_name)), false)
    when 'empresa' then public.is_org_member(public.arquivo_org(p_name))
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
    else false end
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.rdo_events   enable row level security;
alter table public.rdo_comments enable row level security;
alter table public.rdo_views    enable row level security;
alter table public.rdo_media    enable row level security;

-- Histórico: quem vê a obra lê; ninguém grava pela API (só funções e gatilhos).
create policy rdo_events_select on public.rdo_events for select to authenticated using (public.can_read_project(project_id));
-- Comentários: equipe da obra (não o cliente) comenta; o autor ou quem aprova remove (exclusão lógica).
create policy rdo_comments_select on public.rdo_comments for select to authenticated using (public.can_read_project(project_id));
create policy rdo_comments_insert on public.rdo_comments for insert to authenticated
  with check (public.can_read_costs(project_id) and public.org_subscription_ok(public.project_org(project_id)) and deleted_at is null);
create policy rdo_comments_update on public.rdo_comments for update to authenticated
  using (author_id = auth.uid() or public.pode_aprovar_rdo(project_id)) with check (author_id = auth.uid() or public.pode_aprovar_rdo(project_id));
-- Visualizações: quem vê a obra lê; gravação pela função rdo_visualizar.
create policy rdo_views_select on public.rdo_views for select to authenticated using (public.can_read_project(project_id));
-- Mídias: quem vê a obra (inclusive o cliente) vê; quem preenche o diário inclui, legenda e remove (exclusão lógica).
create policy rdo_media_select on public.rdo_media for select to authenticated using (public.can_read_project(project_id));
create policy rdo_media_insert on public.rdo_media for insert to authenticated
  with check (public.can_write_project(project_id, 'execucao') and deleted_at is null);
create policy rdo_media_update on public.rdo_media for update to authenticated
  using (public.can_write_project(project_id, 'execucao')) with check (public.can_write_project(project_id, 'execucao'));

revoke all on public.rdo_events, public.rdo_comments, public.rdo_views, public.rdo_media from anon;
grant select on public.rdo_events, public.rdo_views to authenticated;
grant select, insert on public.rdo_comments, public.rdo_media to authenticated;
grant update (deleted_at) on public.rdo_comments to authenticated;
grant update (caption, taken_on, phase_id, activity_id, position, name, deleted_at) on public.rdo_media to authenticated;

revoke all on function public.evento_rdo(uuid, uuid, text, text), public.evento_edicao_rdo(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rdo_acao(uuid, text, text, text), public.rdo_visualizar(uuid) from public, anon;
grant execute on function public.rdo_acao(uuid, text, text, text), public.rdo_visualizar(uuid) to authenticated;
