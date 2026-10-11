-- GEPLAN · Planos comerciais iniciais.
-- Preços e limites são HIPÓTESES de referência (não definitivos). Ajuste aqui ou no painel do Supabase;
-- o app lê os planos desta tabela — nada fica fixo no código.
insert into public.plans (id, name, price, billing_period, max_projects, max_users, max_storage_mb, features, trial_days, sort_order)
values
  ('individual',   'GEPLAN Individual',   59.90,  'mensal', 3,    1,    1024,
   '{"exportacao": true, "diario": true, "financeiro": true, "suprimentos": false, "multiusuario": false}', 14, 1),
  ('profissional', 'GEPLAN Profissional', 149.90, 'mensal', 15,   5,    10240,
   '{"exportacao": true, "diario": true, "financeiro": true, "suprimentos": true, "multiusuario": true}', 14, 2),
  ('empresas',     'GEPLAN Empresas',     399.90, 'mensal', null, 25,   51200,
   '{"exportacao": true, "diario": true, "financeiro": true, "suprimentos": true, "multiusuario": true, "relatorios_avancados": true}', 14, 3)
on conflict (id) do nothing;
