# Bases de referência de composições (SINAPI automático e bases da empresa)

## O que é
**Composições › Bases de referência** (modo nuvem): pesquisa no SINAPI e nas bases da empresa, com custo por **UF** e
**regime** (não desonerado ou desonerado — cada empresa escolhe o seu padrão; cada pessoa pode trocar na tela), itens e
coeficientes (analítico), **comparação entre estados** e **entre meses/bases** (variação do custo e aviso quando os
coeficientes mudaram) e **Adicionar à biblioteca**.

- A base de referência **nunca é editada**. "Adicionar à biblioteca" **copia** a composição para a biblioteca da empresa
  (Própria), com as funções de mão de obra (itens em horas) e a líder sugerida; a observação guarda a origem
  (ex.: "SINAPI 09/2026 · SP · não desonerado · custo R$ 93,42"). Ajustes são feitos na cópia.
- Cada mês (ou retificação) é uma **versão** nova; as anteriores ficam para comparação e para editais que exigem a
  tabela de um mês específico.

## SINAPI automático (robô mensal)
- A Caixa publica, desde 2025, um ZIP mensal "formato-xlsx" com **uma planilha para as 27 UF**
  (`SINAPI_Referência_AAAA_MM.xlsx`): custos das composições (abas CSD/CCD), preços dos insumos (ISD/ICD) e o
  analítico (itens e coeficientes). Endereço: `caixa.gov.br/Downloads/sinapi-relatorios-mensais/SINAPI-AAAA-MM-formato-xlsx.zip`
  (às vezes `_Retificacao01`).
- O robô (`tools/sinapi/robo.mjs`, agendado em `.github/workflows/sinapi-mensal.yml`) roda **todo dia às 09:00** e só
  baixa quando sai mês novo ou retificação. Usa o mesmo leitor do site (`js/basesRefDados.js`).
- Detalhes da planilha tratados: o código da composição vem como hiperlink com valor 0 (lido da fórmula); custo zerado
  (hífen) = a Caixa não publicou o custo naquela UF.
- Se a Caixa mudar o formato ou o endereço, o robô para com erro — o GitHub manda e-mail — e o administrador da
  plataforma pode importar a planilha pela tela (Bases de referência › Administração da plataforma).

### Ativar o robô (uma vez, pela dona da plataforma)
1. No Supabase de cada projeto (testes e produção): *Project Settings › API* → copiar a **Project URL** e a chave
   **service_role** (secreta — nunca no site, nunca em mensagens).
2. No GitHub: repositório › *Settings › Secrets and variables › Actions › New repository secret*:
   `SUPABASE_URL_TESTE`, `SUPABASE_SERVICE_ROLE_KEY_TESTE` (e, quando for para produção, `SUPABASE_URL_PRODUCAO`,
   `SUPABASE_SERVICE_ROLE_KEY_PRODUCAO`). Ambiente sem segredos é pulado.
3. Primeira execução: *Actions › SINAPI mensal › Run workflow* (vazio = mês mais recente; ou `AAAA-MM`).
O agendamento do GitHub só funciona com o arquivo do robô no ramo principal (`main`).

## Espaço no banco
Cada mês do SINAPI ocupa algo como 30 a 45 MB (≈ 10,6 mil composições, 57 mil itens e 4,9 mil insumos, com as 27 UF e
os dois regimes). O plano gratuito do Supabase tem 500 MB: cabem poucos meses junto com os dados das obras. No plano Pro
(8 GB) cabem anos. Versões antigas podem ser retiradas pela tela (administração da plataforma).

## Segurança (migração `0014_bases_referencia`)
- Base pública (SINAPI): todos os usuários leem; só o robô (chave de serviço) ou o administrador da plataforma gravam.
- Base da empresa (próxima etapa, C3: TCPO, bases estaduais, planilha própria): só a empresa lê; admin/engenheiro gravam.
- Enquanto importa, a versão fica invisível para as empresas; publicada, não muda mais (nem itens novos).
- Padrão de UF/regime da empresa: só o administrador define.
- Testes: `tests/index.html` grupo 22 (leitor) e `tests/db.html` grupo 18 (permissões, robô).
