# Histórico de versões do GEPLAN

## Etapa 2 — Fornecedores (out/2026)
- Cadastro central de fornecedores (modo nuvem): identificação, contato, atendimento, condições comerciais, categorias
  principal e secundárias, produtos; busca e filtros; ficha individual.
- Categorias configuráveis por empresa (14 padrão), em Administração › Configurações.
- Avaliações manuais (1 a 5) por critério; documentos em armazenamento privado com link temporário.
- Histórico comercial a partir dos contratos/pedidos e despesas das obras; Financeiro sugere fornecedores cadastrados e
  grava o vínculo.
- Banco: migração `0006` (somente acréscimos) com validação de CPF/CNPJ, RLS e Storage privado.
- Testes: +3 unitários, +13 de banco/segurança, fluxo completo pela tela.

## Etapa 1 — Visão geral (out/2026)
- Página inicial com 6 indicadores clicáveis, Minhas obras com busca e filtros, painel de atenção, atalhos agrupados e
  apresentação para quem ainda não tem obras. Página Configurações. Indicador de salvamento com hora da confirmação.

## Modo nuvem (out/2026)
- Supabase (PostgreSQL + Auth + RLS): empresas, usuários, perfis, convites, planos, auditoria; sincronização das obras.
- Login por e-mail/senha e Google.

## Gestão da obra (out/2026)
- Painel, medições, diário, financeiro, BDI, revisões e importação de orçamento por Excel.
