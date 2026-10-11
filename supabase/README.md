# Banco de dados do GEPLAN (Supabase / PostgreSQL)

Este diretório tem tudo o que o banco precisa: **migrações versionadas** (`migrations/`), **planos iniciais**
(`seed.sql`) e o simulador usado nos testes locais (`tests/`).

Enquanto `SUPABASE_URL` e `SUPABASE_ANON_KEY` estiverem vazios em `js/config.js`, o GEPLAN continua no modo
antigo (dados no aparelho + Google Drive). Preenchidos, passa a usar o banco.

## O que as migrações criam

| Arquivo | Conteúdo |
|---|---|
| `…0001_base_organizacoes.sql` | perfis de usuário, empresas, membros e perfis de acesso, convites, planos, assinaturas, eventos da assinatura, auditoria, funções de autorização e RPCs (`create_organization`, `accept_invitation`, `my_organizations`) |
| `…0002_obras_biblioteca.sql` | clientes, obras, equipe da obra, feriados, histórico, composições + itens (mão de obra), modelos de EAP, limite de obras do plano |
| `…0003_orcamento_planejamento.sql` | itens do orçamento (total calculado pelo banco), revisões, EAP/atividades, dependências FS/SS/FF/SF, vínculos orçamento × EAP (soma ≤ 100%), linhas de base |
| `…0004_execucao_financeiro.sql` | medições (uma por atividade/data, ≤ 100%, % da atividade recalculado no servidor), diário (equipe, serviços, ocorrências), contratos/pedidos, aditivos, despesas, pagamentos (≤ valor da despesa) |
| `…0005_indicadores.sql` | `bdi_tcu()`, views de orçamento, vínculos, contratos, custos (comprometido/incorrido/pago/a incorrer) e uso do plano |

Todas as tabelas têm **RLS ligado**. Valores em dinheiro e quantidades usam `NUMERIC` (sem erro de ponto flutuante).
Registros financeiros e históricos não são apagados pelo app: exclusão **lógica** (`deleted_at`) e trilha em `audit_log`.

## Passo a passo para ativar (uma vez, ~20 min)

1. **Criar o projeto** em <https://supabase.com> → *New project*. Região: **South America (São Paulo)**.
   Guarde a senha do banco num gerenciador de senhas.
2. **Rodar as migrações**: *SQL Editor* → *New query* → cole e execute, **nesta ordem**, cada arquivo de
   `supabase/migrations/` e por fim `supabase/seed.sql`. (Ou, com a Supabase CLI: `supabase link` e `supabase db push`.)
   Não rode `supabase/tests/shim_supabase.sql` no projeto — ele é só para testes locais.
3. **Endereços permitidos**: *Authentication → URL Configuration*
   - *Site URL*: o endereço principal do site (ex.: `https://juesteves.github.io/geplan/`)
   - *Redirect URLs*: o mesmo endereço, o da Vercel e `http://localhost:8080/` (testes).
4. **Login por e-mail**: *Authentication → Providers → Email* ligado. Recomendado: *Confirm email* ligado.
   Para produção, configure um SMTP próprio (*Authentication → Emails → SMTP*): o envio padrão do Supabase tem
   limite baixo de mensagens por hora.
5. **Login com Google** (opcional): *Authentication → Providers → Google*. No Google Cloud, no mesmo cliente OAuth
   já usado pelo GEPLAN, adicione em *URIs de redirecionamento autorizados*:
   `https://SEU-PROJETO.supabase.co/auth/v1/callback`, e copie *Client ID* e *Client secret* para o Supabase.
   (O *Client secret* fica só no Supabase — nunca no código.)
6. **Conectar o site**: *Project Settings → API* → copie **Project URL** e a chave **anon/publishable** para
   `js/config.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). Essas duas são públicas por natureza; a proteção é o RLS.
   **Nunca** use a chave `service_role` no site.
7. **Primeiro acesso**: abra o site → *Criar conta* → *Criar empresa*. Na tela **Empresa**, use
   *Enviar para a empresa* para subir as obras que estavam no aparelho (modo Google Drive).
8. (Opcional) **Administrador da plataforma** (painel administrativo, fase 7): no *SQL Editor*
   `update public.user_profiles set is_platform_admin = true where email = 'seu-email';`

### Conferir a instalação
No *SQL Editor*, estas consultas devem voltar **vazias**:
```sql
-- tabelas sem RLS
select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
-- colunas de dinheiro/quantidade em ponto flutuante
select table_name, column_name from information_schema.columns
where table_schema = 'public' and data_type in ('real', 'double precision');
```

## Perfis de acesso (verificados no banco)

| Perfil | Vê | Altera |
|---|---|---|
| Administrador da empresa | todas as obras | tudo + pessoas, convites, arquivar obra |
| Engenheiro responsável | todas as obras | cadastro, orçamento, EAP, cronograma, medições, diário, financeiro, biblioteca |
| Supervisor de obra | obras em que foi incluído (sem despesas/pagamentos) | medições e diário |
| Financeiro | obras em que foi incluído | despesas, pagamentos, contratos/pedidos |
| Compras | obras em que foi incluído | contratos/pedidos |
| Cliente | obras em que foi incluído, sem custos internos | nada (somente leitura) |

Além do perfil, gravações exigem assinatura **ativa ou em avaliação**; o banco aplica os limites de obras e
usuários do plano (`plans`). Nenhuma empresa enxerga dados de outra.

## Testes

- `tests/db.html` (servidor local: `tools\serve.ps1`, depois <http://localhost:8080/tests/db.html>): aplica as
  migrações num **PostgreSQL 16 real (PGlite)** com RLS e executa ~60 testes, inclusive tentativas reais de acesso
  entre empresas, limites do plano, integridade (vínculos, ciclos, pagamentos, medições) e a ida e volta completa
  da obra da planilha (enviar → baixar → linhas idênticas, mesmo cronograma e custos).
- `tests/nuvem.html?banco=teste&zerar=1`: o **app real** em modo nuvem contra um emulador local do Supabase
  (auth + REST sobre o PGlite). Serve para testar login, empresa, convites, sincronização e persistência após
  recarregar. O emulador não valida tokens (não há segredo) — ele testa o app, não o Supabase.
- O que **não** dá para testar sem o projeto real: o serviço de autenticação do Supabase em si (e-mails de
  confirmação, login com Google) e o desempenho na rede.

## Reverter

As migrações só **criam** objetos. Para desfazer num projeto **sem dados que importem**, apague o projeto no painel
do Supabase e crie outro. Num projeto com dados, **não** apague tabelas: faça backup (abaixo) e crie uma migração
nova que corrija o problema. Comandos destrutivos (`drop table`, `truncate`) só com backup e autorização.

## Backups e restauração

- Verifique no plano contratado do Supabase a política de backups automáticos e a recuperação até um ponto no
  tempo (*Point in Time Recovery*) — elas variam por plano.
- Backup próprio recomendado (semanal, guardado fora do Supabase):
  `supabase db dump --db-url "$SUPABASE_DB_URL" -f backup-AAAA-MM-DD.sql` (estrutura) e
  `supabase db dump --db-url "$SUPABASE_DB_URL" --data-only -f dados-AAAA-MM-DD.sql` (dados).
- Restauração: num projeto novo, rode o arquivo de estrutura e depois o de dados (`psql "$SUPABASE_DB_URL" -f …`).
- Cada usuário também pode baixar um backup JSON das obras pela tela **Empresa/Google Drive** do app.

## LGPD — cuidados (não é parecer jurídico)

O GEPLAN guarda dados pessoais (nome e e-mail de usuários; nome, telefone e e-mail de clientes; responsáveis em
medições e diários). Antes de vender:
- Política de privacidade e termos de uso; definir papéis (a empresa cliente é **controladora** dos dados das
  obras; o GEPLAN atua como **operador**) e um contrato de tratamento com os clientes.
- Avaliar o contrato de tratamento de dados (DPA) do Supabase e manter os dados na região de São Paulo.
- Procedimentos para o titular: acesso, correção, exportação e exclusão (a exclusão de registros financeiros pode
  ter prazo legal de guarda — definir com o contador/jurídico).
- Logs: o banco audita alterações, mas **não** registra senhas nem tokens. Definir prazo de retenção do `audit_log`.
- Implementar estas medidas **não** garante conformidade legal por si só.
