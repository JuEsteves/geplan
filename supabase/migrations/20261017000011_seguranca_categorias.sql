-- GEPLAN · 0011 · Correção de segurança encontrada na etapa de Testes (auditoria do banco real).
-- `default_supplier_categories(p_org)` (0006) é SECURITY DEFINER e estava executável por qualquer papel (inclusive sem
-- login): permitia recriar as categorias padrão de fornecedores em QUALQUER empresa (sem leitura de dados, mas alterando
-- dados de outra empresa). Ela só precisa ser chamada pelo gatilho de nova empresa, que roda como dono da função.
-- Somente permissões; nenhum dado é alterado.
revoke all on function public.default_supplier_categories(uuid) from public, anon, authenticated;
revoke all on function public.org_default_categories() from public, anon, authenticated;
