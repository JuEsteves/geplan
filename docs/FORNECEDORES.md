# Fornecedores

Cadastro central de fornecedores da empresa (modo nuvem). Menu **Suprimentos › Fornecedores** (`#/fornecedores`).

## O que faz
- **Cadastro em seções:** identificação (nome comercial, razão social, CPF/CNPJ, categoria principal e outras,
  produtos fornecidos), contato (representante, telefone, WhatsApp, e-mail, endereço, cidade/UF), área de atendimento
  (regiões, entrega na obra, retirada) e condições comerciais (prazo de pagamento, frete, pedido mínimo, prazo médio).
- **Busca** sem acento por nome, razão social, CPF/CNPJ (com ou sem pontuação), cidade, produto, contato e nome de
  categoria; **filtros** por categoria (principal ou secundária), cidade e status (ativos, inativos, todos).
- **Ficha** com links de contato (telefone, WhatsApp, e-mail), histórico comercial, avaliações e documentos.
- **Categorias** configuráveis em Administração › Configurações (criar, renomear, desativar). Toda empresa começa com
  14 categorias padrão; desativar não altera fornecedores que já a usam.
- **Inativação** em vez de exclusão: o fornecedor some das buscas e escolhas, mas histórico, documentos e vínculos
  continuam. Ninguém apaga fornecedor pelo app.

## Histórico comercial
Calculado a partir dos **contratos/pedidos e despesas das obras que o usuário pode ver** (aba Financeiro de cada obra):
- Vínculo pelo cadastro (`fornecedorId` / `supplier_id`) — feito automaticamente quando o nome digitado no Financeiro é
  igual ao nome comercial de um fornecedor cadastrado (a lista de sugestões ajuda);
- Registros antigos, sem vínculo, entram **pelo nome** (nome comercial ou razão social, sem diferenciar acento/maiúscula)
  e aparecem marcados "pelo nome".
- Mostra obras atendidas, total de contratos/pedidos (com aditivos), total de despesas e materiais pedidos.
- Cotações, prazos efetivos e ocorrências de entrega entram com o módulo de Suprimentos.

## Avaliação
- **Manual**, notas de 1 a 5 por critério (pontualidade, conformidade da quantidade, qualidade, atendimento, resolução
  de ocorrências), com obra e comentário opcionais. A ficha mostra a média e a quantidade de notas de cada critério.
- Avaliações não são editadas nem apagadas depois de registradas (histórico).
- **Indicadores automáticos** (pontualidade e quantidade por entrega registrada) **ainda não existem**: dependem do
  módulo de Entregas. O sistema não classifica fornecedores como bons ou ruins.

## Documentos
- Propostas, catálogos, documentos cadastrais e outros: PDF, imagens (JPG/PNG/WEBP), planilhas, Word e texto, até 50 MB.
- Guardados no **Supabase Storage**, bucket **privado** `documentos`, caminho `<empresa>/fornecedores/<fornecedor>/<uuid>-<nome>`.
- Abertos por **link temporário** (5 minutos). Remover tira da ficha (exclusão lógica); o arquivo permanece guardado.

## Permissões (verificadas no banco)
| Perfil | Ver | Cadastrar/editar/inativar | Avaliar | Categorias |
|---|---|---|---|---|
| Administrador, Engenheiro | sim | sim | sim | sim |
| Compras | sim | sim | sim | sim |
| Financeiro | sim | sim | sim | não |
| Supervisor | sim | não | sim | não |
| Cliente | não | não | não | não |

Excluir logicamente (`deleted_at`) só o administrador. Outra empresa nunca vê nem altera os fornecedores, categorias,
avaliações ou arquivos da sua.

## Banco (migração `20261012000006_fornecedores.sql`)
`supplier_categories`, `suppliers`, `supplier_secondary_categories`, `supplier_evaluations`, `supplier_documents`;
colunas `supplier_id` em `contracts` e `expenses`; função `doc_valido()` (CPF/CNPJ); bucket `documentos` e políticas do
Storage. Validações no servidor: dígitos de CPF/CNPJ, CPF/CNPJ único por empresa, e-mail, UF, notas 1–5, obra e
fornecedor da mesma empresa, caminho do arquivo coerente com empresa e fornecedor.

## Testes
- `tests/index.html` grupo 16: CPF/CNPJ, busca, histórico.
- `tests/db.html` grupo 11: categorias padrão, validação de documento, unicidade, perfis, isolamento entre empresas,
  vínculo de contrato, inativação, avaliações, categorias de outra empresa, Storage e documentos, auditoria.
- `tests/nuvem.html`: fluxo completo pela tela (cadastro, CNPJ inválido, documento, link temporário, tipo de arquivo
  proibido, avaliação, pedido no Financeiro ligado ao fornecedor, histórico, busca, inativação, categorias, persistência
  após recarregar).
