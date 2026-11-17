-- GEPLAN · 0018 · Perfil "Contador" (contador externo): consulta o financeiro da empresa, os relatórios e os documentos
-- fiscais; não altera lançamentos e não vê as obras (a não ser que seja incluído na equipe de uma obra).
-- Fica sozinho neste arquivo porque um valor novo de enum só pode ser usado depois que a transação que o criou termina.
alter type public.member_role add value if not exists 'contador';
