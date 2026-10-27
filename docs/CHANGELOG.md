# Histórico de versões do GEPLAN

## Bases de referência e SINAPI automático — Etapa C (out/2026)
- Composições › **Bases de referência**: SINAPI no banco (todas as UF, desonerado e não desonerado), pesquisa, custo
  na UF/regime escolhidos (padrão da empresa), analítico com preços, comparação entre estados e entre meses, e
  "Adicionar à biblioteca" (cópia Própria; a base nunca muda). Ver `docs/BASES.md`.
- Robô mensal (GitHub Actions) que importa o SINAPI novo da Caixa sozinho; importação manual pela tela como reserva.
- Migração `0014` (tabelas de referência, permissões, padrão de UF/regime da empresa). Testes: +4 unitários, +7 de banco.

## Painel de pedidos por obra — Etapa B (out/2026)
- "Entregas e recebimentos" virou painel de acompanhamento: totais (pedidos em aberto, grupos em compra, aguardando
  entrega, atrasados, entregas registradas), um cartão por obra (as com atraso primeiro; clique abre a obra), lista do
  que aguarda entrega/retirada com filtro por obra e situação (atrasadas, aguardando, retirada, parcial) e as entregas
  recebidas recentemente. Dentro da obra, o mesmo painel só com a obra. Regra em `painelPorObra` (+1 teste).

## Tudo dentro da obra — Etapa A (out/2026)
- A página da obra reúne todos os módulos, na ordem do trabalho: Painel, EAP, Orçamento, Vínculos, Cronograma,
  Físico-financeiro, Medições, Diário de obra, Compras, Entregas, Custos e Cadastro. Compras, entregas, medições
  (boletins + avanço físico) e diário abrem dentro da obra, só com os dados dela; os links internos (pedido, boletim,
  relatório) continuam na obra (`js/escopo.js`). Os menus gerais seguem como visão de todas as obras.
- Obra sem EAP: aviso no card da obra e no "Novo pedido" (com atalho para montar a EAP).
- Obra de exemplo: corrigido erro ao salvar quando a sincronização trocava a biblioteca com o diálogo aberto.

## EAP primeiro e leitura de projeto com IA (out/2026)
- Nova obra sem planilha: ler o projeto (PDF) com IA, escolher etapas do modelo, EAP em branco ou cópia; abre na EAP.
- Modelo de etapas do GEPLAN embutido (16 etapas, 87 subetapas, 453 atividades), igual para todas as empresas;
  "Duplicar para personalizar" cria o modelo da empresa.
- EAP: "Mover para…" leva atividades/subetapas para outra etapa mantendo vínculos, predecessoras e medições.
- Leitura de projeto: PDFs na pasta privada da obra, Edge Function `ler-projeto` (IA Claude Opus 5.5, chave só no
  servidor), revisão antes de montar, registro de cada leitura e limite mensal por empresa (migração `0012`).
- **Segurança (`0013`)**: funções de permissão devolviam nulo para quem não tinha vínculo com a obra, o que deixava passar
  ações dentro de funções do banco (ex.: lançar medição de outra empresa no Financeiro conhecendo o id). Agora devolvem
  falso; teste de varredura em todas as funções de permissão.
- Testes: +5 unitários, +7 de banco, fluxo pela tela no emulador (resposta de demonstração).

## Etapa de Testes (out/2026)
- Auditoria de segurança do banco real (somente leitura): RLS e políticas em todas as tabelas, nenhum acesso anônimo a
  tabelas, funções SECURITY DEFINER com search_path fixo, views com security_invoker, Storage privado.
- Encontrado e corrigido (migração `0011`): função que cria as categorias padrão de fornecedores podia ser chamada sem
  login para qualquer empresa. Teste novo impede que uma função que grava volte a ficar aberta para anônimos.
- Testes: 98 unitários, 147 de banco; consistência entre módulos nos dados de demonstração; telas no ar sem erros.

## Integração de custos (out/2026)
- Custos por fase da EAP: orçado, valor agregado, comprometido, incorrido, pago, a pagar e medições a lançar, com barra
  físico × financeiro, data de corte, filtro de categoria e linha "Sem fase" com aviso.
- Regras sem duplicidade: contrato/pedido cancelado ou encerrado conta só o incorrido; medição aprovada entra como
  "a lançar" até virar despesa; empreitada só quando medida.
- Fase (opcional) na despesa e no contrato; medição lançada gera uma despesa por profissional e fase, já com a fase.
- Banco: migração `0010` (acréscimos). Testes: +3 unitários, +8 de banco, conferência pela tela.

## Medições por atividade e profissional (out/2026)
- Cadastro central de profissionais (sem dados bancários) e vínculos de remuneração com vigência (por unidade, valor
  fixo por serviço, diária, hora, outro); valor usado em medição aprovada não muda.
- Boletins de medição: atividades da EAP, executado no período, produção por profissional (≤ executado), conferência
  com ajuste da quantidade aprovada, aprovação (liberação "Aprovar medição"), avanço físico gravado pelo boletim,
  valores congelados, lançamento das despesas no Financeiro; "Pago" só com pagamento registrado.
- Resumos por profissional, por atividade e fase; ficha do profissional. Supervisor vê só quantidades.
- Banco: migração `0009` (acréscimos). Testes: +6 unitários, +14 de banco/segurança, fluxo completo pela tela.

## Diário de obra (RDO) — layout e cadastro (out/2026)
- Lista de obras em cards com capa e contadores; painel da obra (visão geral, lista de tarefas, relatórios, filtro de
  busca, editar obra) com prazos contratual/decorrido/a vencer.
- RDO por período (ou um dia), número por obra, cadastro em 9 seções (equipe própria/terceirizada, equipamentos,
  atividades da EAP com quantidade e situação, ocorrências com horário e providências, materiais com divergência).
- Fotos, vídeos curtos e links, anexos, ligados à fase e à atividade; comentários; log de edições; visualizações.
- Revisão e aprovação (liberação "Aprovar RDO"), devolução e reabertura com motivo; assinaturas desenhadas na tela ou
  por imagem; relatório aprovado travado pelo banco.
- Visualização para impressão e PDF (relatório, período ou fase) com logo da empresa, capa, fotos e assinaturas.
- Correção: a sincronização não detectava alterações feitas só dentro de campos aninhados (ex.: campos extras da obra,
  modelos de EAP); agora compara todos os níveis.
- Banco: migração `0008` (acréscimos). Testes: +5 unitários, +16 de banco/segurança, fluxo completo pela tela.

## Suprimentos — pedido principal com grupos e quadro de compras (out/2026)
Substitui a primeira versão de Suprimentos (solicitação → um pedido), que não chegou a ser publicada.
- Quadro em 4 colunas; pedido principal com vários grupos de materiais, cada um com fornecedor, cotação, compra,
  previsão (estimada/confirmada) e entregas próprios; situação do pedido calculada pelo banco (conclui sozinho quando
  todos os grupos terminam; cancelar/resolver só com motivo).
- Pedido em uma página com abas (resumo, grupos, cotações e compras, entregas, histórico e comentários); anexos.
- Fase da EAP no pedido e nos compromissos do Financeiro (custos por fase preparados).
- Liberações por pessoa (solicitar, comprar, receber, fornecedores) na tela Empresa, conferidas pelo banco; o padrão
  de cada perfil mantém as regras anteriores.
- Ficha do fornecedor: cotações e indicadores de entrega (no prazo, quantidade conforme, ocorrências).
- Correções: downloads simultâneos da nuvem compartilham o mesmo; cotação/compra sempre liga o fornecedor cadastrado.
- Banco: migração `0007` (acréscimos). Testes: +9 unitários, +27 de banco/segurança, fluxo completo pela tela.

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
