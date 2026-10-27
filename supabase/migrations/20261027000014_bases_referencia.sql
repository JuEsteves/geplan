-- GEPLAN · 0014 · Bases de referência de composições: SINAPI (pública, atualizada todo mês pelo robô da plataforma)
-- e bases próprias de cada empresa (TCPO, bases estaduais, planilha própria). Somente acréscimos.
--   • Base pública (org_id nulo): todos os usuários leem; só a plataforma grava (robô com a chave de serviço, ou
--     administrador da plataforma pela tela, como alternativa manual).
--   • Base da empresa (org_id preenchido): só os membros da empresa leem; administrador/engenheiro gravam.
--   • Base publicada não muda: uma nova planilha (outro mês ou retificação) entra como outra versão. Enquanto a
--     importação não termina (status 'importando'), só quem importa enxerga a base.
--   • Composições usadas na obra são COPIADAS para a biblioteca da empresa ("Própria"); a base nunca é editada.

create table if not exists public.ref_bases (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.organizations (id) on delete cascade,   -- nulo = base pública da plataforma
  fonte         text not null check (length(trim(fonte)) between 2 and 40),   -- 'SINAPI', 'TCPO', 'ORSE'…
  nome          text not null check (length(trim(nome)) between 2 and 120),   -- 'SINAPI 09/2026'
  mes           date,                                                          -- mês de referência (dia 1)
  arquivo       text not null default '',
  status        text not null default 'importando' check (status in ('importando', 'publicada')),
  ufs           text[] not null default '{}',
  regimes       text[] not null default '{}',                                 -- 'nao_desonerado', 'desonerado'
  totais        jsonb not null default '{}'::jsonb,
  criado_por    uuid default auth.uid() references auth.users (id) on delete set null,
  criado_em     timestamptz not null default now(),
  publicado_em  timestamptz
);
create unique index if not exists ref_bases_nome_uq
  on public.ref_bases (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), fonte, nome);
create index if not exists ref_bases_org_idx on public.ref_bases (org_id, fonte, mes desc);

-- Composições: custo por regime e UF, ex.: {"nao_desonerado": {"SP": 123.45, …}, "desonerado": {…}}.
create table if not exists public.ref_composicoes (
  base_id    uuid not null references public.ref_bases (id) on delete cascade,
  codigo     text not null,
  grupo      text not null default '',
  descricao  text not null,
  unidade    text not null default '',
  situacao   text not null default '',
  custos     jsonb not null default '{}'::jsonb,
  busca      text not null default '',          -- código + descrição sem acento e em minúsculas (pesquisa)
  primary key (base_id, codigo)
);

-- Itens de cada composição (analítico): insumos e composições auxiliares com o coeficiente.
create table if not exists public.ref_itens (
  base_id      uuid not null references public.ref_bases (id) on delete cascade,
  composicao   text not null,
  posicao      integer not null,
  tipo         char(1) not null check (tipo in ('C', 'I')),
  codigo       text not null default '',
  descricao    text not null default '',
  unidade      text not null default '',
  coeficiente  numeric(20, 7) not null default 0,
  situacao     text not null default '',
  primary key (base_id, composicao, posicao)
);

-- Insumos: preço por regime e UF (mesmo formato de custos).
create table if not exists public.ref_insumos (
  base_id        uuid not null references public.ref_bases (id) on delete cascade,
  codigo         text not null,
  classificacao  text not null default '',
  descricao      text not null,
  unidade        text not null default '',
  origem         text not null default '',
  precos         jsonb not null default '{}'::jsonb,
  primary key (base_id, codigo)
);

-- Preferência da empresa: UF e regime usados por padrão ao consultar as bases.
alter table public.organizations add column if not exists ref_uf text not null default ''
  check (ref_uf = '' or ref_uf ~ '^[A-Z]{2}$');
alter table public.organizations add column if not exists ref_regime text not null default 'nao_desonerado'
  check (ref_regime in ('nao_desonerado', 'desonerado'));

-- ---------------------------------------------------------------------------------------------
-- Permissões (sempre verdadeiro/falso — nunca nulo)
-- ---------------------------------------------------------------------------------------------
create or replace function public.pode_ler_base(p_base uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case
      when b.org_id is null then b.status = 'publicada' or public.is_platform_admin()
      else public.is_org_member(b.org_id) and (b.status = 'publicada' or public.org_role(b.org_id) in ('admin', 'engenheiro'))
    end from public.ref_bases b where b.id = p_base), false)
$$;

-- Robô mensal da plataforma: chamada com a chave de serviço (papel service_role no token assinado pelo Supabase —
-- o navegador não consegue se passar por ele).
create or replace function public.eh_servico() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                  nullif(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role'
$$;

create or replace function public.pode_gravar_base_org(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case when p_org is null then public.is_platform_admin() or public.eh_servico()
                       else public.org_role(p_org) in ('admin', 'engenheiro') end, false)
$$;

-- Itens só entram enquanto a base está sendo importada (base publicada é imutável).
create or replace function public.pode_gravar_base(p_base uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select b.status = 'importando' and public.pode_gravar_base_org(b.org_id)
                     from public.ref_bases b where b.id = p_base), false)
$$;

-- Publicar: confere que a base tem conteúdo e grava as contagens.
create or replace function public.ref_publicar_base(p_base uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.pode_gravar_base(p_base) then
    raise exception 'Sem permissão para publicar esta base (ou ela já foi publicada).' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'composicoes', (select count(*) from public.ref_composicoes where base_id = p_base),
    'itens', (select count(*) from public.ref_itens where base_id = p_base),
    'insumos', (select count(*) from public.ref_insumos where base_id = p_base)) into v;
  if (v ->> 'composicoes')::int = 0 then
    raise exception 'A base não tem composições: confira a planilha.' using errcode = '22023';
  end if;
  update public.ref_bases set status = 'publicada', publicado_em = now(), totais = v where id = p_base;
  return v;
end $$;

-- Pesquisa por código ou palavras (todas precisam aparecer), na ordem do código.
create or replace function public.ref_buscar(p_base uuid, p_termo text, p_limite integer default 60)
returns setof public.ref_composicoes
language sql stable security definer set search_path = public as $$
  select c.* from public.ref_composicoes c
   where public.pode_ler_base(p_base) and c.base_id = p_base
     and (coalesce(trim(p_termo), '') = '' or not exists (
           select 1 from unnest(string_to_array(lower(trim(p_termo)), ' ')) w
            where w <> '' and position(w in c.busca) = 0))
   order by length(c.codigo), c.codigo
   limit least(greatest(coalesce(p_limite, 60), 1), 200)
$$;

-- Preferência de UF/regime da empresa (só o administrador).
create or replace function public.definir_referencia_org(p_org uuid, p_uf text, p_regime text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_admin(p_org) then
    raise exception 'Só o administrador da empresa define a referência padrão.' using errcode = '42501';
  end if;
  update public.organizations set ref_uf = upper(coalesce(p_uf, '')), ref_regime = p_regime where id = p_org;
end $$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table public.ref_bases       enable row level security;
alter table public.ref_composicoes enable row level security;
alter table public.ref_itens       enable row level security;
alter table public.ref_insumos     enable row level security;

-- (usa as colunas da própria linha, para valer também no INSERT … RETURNING da base recém-criada)
create policy ref_bases_select on public.ref_bases for select to authenticated using (coalesce(case
  when org_id is null then status = 'publicada' or public.is_platform_admin()
  else public.is_org_member(org_id) and (status = 'publicada' or public.org_role(org_id) in ('admin', 'engenheiro')) end, false));
create policy ref_bases_insert on public.ref_bases for insert to authenticated
  with check (status = 'importando' and public.pode_gravar_base_org(org_id));
-- apagar: descartar uma importação com erro ou retirar uma base da empresa (a pública só a plataforma)
create policy ref_bases_delete on public.ref_bases for delete to authenticated using (public.pode_gravar_base_org(org_id));

create policy ref_composicoes_select on public.ref_composicoes for select to authenticated using (public.pode_ler_base(base_id));
create policy ref_composicoes_insert on public.ref_composicoes for insert to authenticated with check (public.pode_gravar_base(base_id));
create policy ref_itens_select on public.ref_itens for select to authenticated using (public.pode_ler_base(base_id));
create policy ref_itens_insert on public.ref_itens for insert to authenticated with check (public.pode_gravar_base(base_id));
create policy ref_insumos_select on public.ref_insumos for select to authenticated using (public.pode_ler_base(base_id));
create policy ref_insumos_insert on public.ref_insumos for insert to authenticated with check (public.pode_gravar_base(base_id));

revoke all on public.ref_bases, public.ref_composicoes, public.ref_itens, public.ref_insumos from anon, authenticated;
grant select, insert, delete on public.ref_bases to authenticated;
grant select, insert on public.ref_composicoes, public.ref_itens, public.ref_insumos to authenticated;
grant update (ref_uf, ref_regime) on public.organizations to authenticated;   -- política organizations_update: só o administrador

revoke all on function public.pode_ler_base(uuid), public.pode_gravar_base_org(uuid), public.pode_gravar_base(uuid) from public, anon;
revoke all on function public.ref_publicar_base(uuid), public.ref_buscar(uuid, text, integer), public.definir_referencia_org(uuid, text, text) from public, anon;
grant execute on function public.pode_ler_base(uuid), public.pode_gravar_base_org(uuid), public.pode_gravar_base(uuid) to authenticated;
grant execute on function public.ref_publicar_base(uuid), public.ref_buscar(uuid, text, integer), public.definir_referencia_org(uuid, text, text) to authenticated;
-- robô (chave de serviço): grava as tabelas sem RLS e publica a versão
grant select, insert, delete on public.ref_bases, public.ref_composicoes, public.ref_itens, public.ref_insumos to service_role;
grant execute on function public.ref_publicar_base(uuid), public.pode_gravar_base(uuid), public.pode_gravar_base_org(uuid), public.eh_servico() to service_role;
