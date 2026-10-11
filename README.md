# GEPLAN – Gestão e Planejamento de Obras

Site (e app de celular) que **estima o cronograma a partir do orçamento**, usando composições de serviço com
coeficientes de produtividade (h/unid). Fluxo:

`Composições → Orçamento → Vínculos Orçamento × EAP → Duração das atividades → Predecessoras (CPM) → Gantt / Curva S`

## Como funciona

1. **Composições** – cada composição tem funções de mão de obra com coeficiente (h/unid); **exatamente uma é a função líder** (define o prazo). Têm fonte (Obra própria / SINAPI / TCPO) e versão.
2. **Orçamento** – itens por etapa/subetapa, com composição, quantidade e custo unitário (total = quantidade × custo unitário).
3. **Vínculos** – cada item é distribuído em % entre atividades da EAP (relação N:N). A soma deve dar 100% (senão aparece "Verificar").
4. **Atividades (EAP nível 1/2/3)** – para cada vínculo: `qtd alocada = quantidade × %`, `HH = qtd alocada × coef. da função líder`, `custo alocado = total × %`.
   `duração = ARRED.PARA.CIMA( HH ÷ (equipe × jornada × eficiência) )` — jornada 8,8 h e eficiência 0,85 por padrão (por obra).
   Duração manual tem prioridade. Atividades sem vínculo e sem duração manual (cura, fornecedor, documentação…) usam a **duração padrão do tipo** com alerta, até você preencher.
5. **Cronograma (CPM)** em dias úteis (feriados da obra + gerais), com folga total e caminho crítico. Prioridade do início: início real > início fixado > predecessoras; fim real substitui o fim calculado. Ciclos são bloqueados. Níveis 1 e 2 agregam as filhas.
6. **Gantt**, **Curva S** física (ponderada por HH) e financeira (custo alocado distribuído nos dias úteis), **Acompanhamento** (% executado, datas reais, medições) e **exportação** Excel/PDF.
7. **Importar planilha** – salva o .xlsx como **modelo de EAP** (abas EAP Detalhada, Composicoes, Orcamento, Vinculo_Orc_EAP e Duracao_Atividades), que pode ser o **modelo inicial (★)**. As composições entram na biblioteca (com fonte, ref. SINAPI, etapa e observação).
8. **Nova obra a partir do modelo** – escolha as etapas/subetapas que entram. Depois, na aba Atividades, **"+ Fases do modelo"** acrescenta outras fases: elas entram na posição do modelo e as predecessoras são religadas. Se uma fase ficar de fora, a atividade herda as predecessoras dela (em cadeia). Predecessora editada à mão não é alterada.
10. **Aba Fases** – biblioteca de modelos de EAP independente das obras: criar, renomear, reordenar e excluir etapas/subetapas/atividades, tipo, equipe, duração e predecessoras; marcar uma etapa como alternativa de outra. As obras guardam o vínculo por id (`modeloAtivId`), então editar o modelo não quebra obras existentes.
11. **Base SINAPI** (Composições › Base SINAPI) – a Caixa não tem API pública; importe a planilha analítica mensal (XLSX do ZIP por UF). A base fica no aparelho (IndexedDB), pesquisável; "Adicionar à biblioteca" cria a composição com as funções de mão de obra (itens em horas) e a líder sugerida. "Duplicar como própria" cria uma composição própria a partir de qualquer outra.
9. **Variantes de escopo** – etapas com letra (ex.: 11B Piscina de fibra, alternativa à 11). Só uma por etapa entra na obra; predecessoras externas são trocadas automaticamente (17.1.1: 11.9.5 → 11B.9.5).

## Navegação

O menu lateral é organizado por áreas: **Visão geral** (página inicial), **Planejamento** (Obras, EAP e fases,
Cronograma, Curva S), **Orçamento e custos** (Orçamentos, Composições, Medições, Custos previstos e realizados),
**Execução e controle** (Diário de obra, Acompanhamento físico, Tarefas e pendências), **Suprimentos e documentos**
(Compras e materiais; Fornecedores e Documentos aparecem como "em breve") e **Administração** (Google Drive e backup,
ou Empresa/usuários/plano no modo nuvem). Os módulos que existem dentro de cada obra abrem um seletor de obra
(ou vão direto, se houver uma só). No celular, o rodapé tem Início, Obras, Cronograma, Diário e **Menu** (todas as áreas).

A **Visão geral** mostra obras ativas, avanço físico médio, atividades atrasadas, pendências do diário, custo
realizado, as obras com situação do cronograma, atalhos e as pendências — tudo calculado com os dados salvos e pelas
mesmas regras do painel de cada obra. Critérios documentados em `js/indicadores.js`.

## Gestão da obra (abas da obra)

| Aba | O que faz |
|---|---|
| **Painel** | Indicadores com filtro por etapa: orçado, preço de venda (BDI), contratado, comprometido, incorrido, pago, físico planejado × realizado, SPI/CPI, previsão de custo final (EAC) e de término, atividades atrasadas e críticas, pendências do diário. |
| **Orçamento** | Itens por etapa/subetapa com subtotais, **BDI pela fórmula do TCU** `[(1+AC+S+R+G)(1+DF)(1+L)]/(1−I) − 1` (aplicado uma vez sobre o custo direto), preço de venda, **revisões** salvas (R0, R1…) e **comparação** entre revisões. **Importar Excel**: escolhe a aba e a linha do cabeçalho, associa as colunas (sugestão automática), mostra a pré-visualização com erros (obrigatórios, números, código repetido) e pergunta se só inclui os novos ou também **atualiza pelo código**; salva uma revisão antes e registra no histórico. Nada é gravado antes da confirmação. |
| **Atividades / Gantt** | EAP, predecessoras FS/SS/FF/SF com defasagem, caminho crítico, Gantt por dia/semana/mês. **Linha de base**: aprovar uma nova guarda a anterior (`linhasBase`), nunca apaga. Menu ⋯ da atividade: responsável, equipe executora, perfil de distribuição, método de medição, peso manual, datas reais. |
| **Físico-financeiro** | Curva S física e financeira planejada × real, por dia/semana/mês, com data de referência. Perfis de distribuição (linear, início, fim, sino; centavos sem perda — o resíduo vai no último dia) e **peso físico** configurável (HH, custo, duração ou manual). |
| **Medições** | Avanço **acumulado** por atividade (por % ou por quantidade, limitado a 100%). Uma medição por atividade e data: lançar de novo na mesma data **substitui**, não soma. A % da atividade, o início real (1ª medição > 0) e o fim real (1ª com 100%) saem das medições. |
| **Diário de obra** | Um registro por data: clima manhã/tarde, dia praticável, equipe por função, serviços (ligados às atividades), materiais, equipamentos, visitas, reuniões, ocorrências/impedimentos (com pendências em aberto), observações. Filtros e exportação PDF/Excel. |
| **Financeiro** | Contratos e pedidos (com aditivos e status), despesas (NF/recibo) com pagamentos. **Sem duplicidade**: despesa ligada a um contrato não soma de novo no comprometido; aviso de nota repetida (mesmo documento + fornecedor) e de despesas acima do contratado. Comprometido, incorrido, pago, a pagar e por etapa/categoria. |
| **Cadastro** | Código, status, cliente, endereço, responsável técnico, prazos, valor contratado, jornada/eficiência, calendário (**dias úteis** ou **dias corridos**), feriados e **histórico de alterações** (quem, quando, o quê). |

Indicadores: `EV = Σ custo × % executado`, `CPI = EV ÷ custo incorrido`, `SPI = EV ÷ PV`, `EAC = incorrido + (orçado − EV)`.
"Financeiro realizado" é custo incorrido — **não** é usado como avanço físico.

### Limitações conhecidas
- **Modo Google Drive** (sem banco configurado): os dados ficam no aparelho e no Drive de quem entra, sem várias pessoas
  na mesma obra nem perfis; a lista de e-mails em `js/config.js` só controla a tela de entrada — **não é segurança de
  servidor**. O **modo nuvem** (Supabase, abaixo) resolve isso com permissões verificadas no banco.
- Fotos e anexos no diário, cotações de compra e integração com a base SINAPI oficial (arquivo real da Caixa) ainda não foram feitos/validados.

### Predecessoras (mesma notação da planilha)
| Digite | Significado |
|---|---|
| `3.2` | término→início: começa no dia útil seguinte ao fim da 3.2 |
| `3.2 TI-10` | começa 10 dias úteis antes do fim da 3.2 (sobreposição) |
| `3.2+2` | começa 2 dias úteis após o fim da 3.2 |
| `3.1 II+5` | início→início: começa 5 dias úteis após o início da 3.1 |
| `6.1/6.2/6.4 TI-5` | várias predecessoras, mesmo tipo e lag (vale a mais tardia) |
| `1.2; 3.1 II` | grupos diferentes separados por `;` |
| `-` ou vazio | sem predecessora (começa na data de início da obra) |
| texto (ex. "Retomada") | vira observação; defina o **início fixado** da atividade |

### Testes
Abra `tests/index.html` pelo servidor local (`tools\serve.ps1`, ex. http://localhost:8080/tests/). Os testes usam os valores da
planilha modelo (2.4.4 = 223,3 HH → 10 dias; 7.2.2 = 728 HH → 25 dias; aço 60/40 → 4 e 3 dias; custo alocado = R$ 224.306,00;
datas com FS, TI negativo, SS com lag, FF/SF, várias predecessoras e feriado) e cobrem também dias corridos, perfis de distribuição
e centavos, peso físico, medições sem duplicar, BDI/revisões, custos sem duplicidade, valor agregado e importação de orçamento
por Excel. Se `docs/` tiver a planilha, testam também a importação do modelo.

> A pasta `docs/` (planilhas das obras) e `tests/` **não** precisam ir para o GitHub: o repositório é público.

## Armazenamento

- Tudo é salvo **no aparelho** na hora (funciona sem internet, na obra).
- Conectado ao **Google Drive**, o site cria `Meu Drive › GEPLAN - Planejamento de Obras` com
  `Biblioteca (etapas e composições).json` e um arquivo `Obra - <nome>.json` por obra, e sincroniza
  automaticamente (a versão mais recente vence). Use a mesma conta no PC e no celular.
- O site usa a permissão `drive.file`: ele **só enxerga os arquivos que ele mesmo criou** no seu Drive.

### Modo nuvem (banco de dados — Supabase)
Com `SUPABASE_URL` e `SUPABASE_ANON_KEY` preenchidos em `js/config.js`, o GEPLAN passa a usar um banco
PostgreSQL com várias empresas, pessoas, perfis de acesso (administrador, engenheiro, supervisor, financeiro,
compras, cliente), convites, planos e auditoria — com as permissões verificadas **no banco** (RLS).
Login por e-mail/senha ou Google. O aparelho guarda uma cópia de trabalho para funcionar sem internet.
Configuração passo a passo: [`supabase/README.md`](supabase/README.md). Arquitetura e status: [`ARQUITETURA.md`](ARQUITETURA.md).

---

## 1) Criar o Client ID do Google (uma vez, ~10 min)

1. Acesse https://console.cloud.google.com e crie um projeto chamado `GEPLAN`.
2. **APIs e serviços › Biblioteca** → procure **Google Drive API** → **Ativar**.
3. **APIs e serviços › Tela de consentimento OAuth** (ou "Google Auth Platform"):
   - Tipo de usuário: **Externo** → nome do app `GEPLAN`, seu e-mail de suporte e de contato.
   - Em **Público-alvo / Usuários de teste**, adicione o seu e-mail do Google.
4. **Credenciais › Criar credenciais › ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**
   - **Origens JavaScript autorizadas** (adicione todas que for usar):
     - `http://localhost:8080` (teste no PC)
     - `https://SEU-USUARIO.github.io` (GitHub Pages)
     - `https://SEU-PROJETO.vercel.app` (Vercel)
   - Não precisa de "URIs de redirecionamento".
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) e cole em `js/config.js`:
   ```js
   export const GOOGLE_CLIENT_ID = '0000000000-xxxx.apps.googleusercontent.com';
   ```
   (ou cole na tela **Google Drive** do próprio site).

> Enquanto o app estiver em modo "Teste" no Google, só os e-mails cadastrados como usuários de teste conseguem entrar
> — perfeito para uso pessoal. O Google pode mostrar o aviso "app não verificado": clique em **Continuar**.

## 2) Testar no PC (Windows)

```
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```
Abra http://localhost:8080.

## 3) Publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `geplan`) e envie todos os arquivos desta pasta
   (pelo site: **Add file › Upload files**, arraste o conteúdo da pasta).
2. **Settings › Pages** → Source: **Deploy from a branch** → Branch `main` / pasta `/ (root)` → Save.
3. Em ~1 minuto o site fica em `https://SEU-USUARIO.github.io/geplan/`.
4. Adicione `https://SEU-USUARIO.github.io` nas origens autorizadas do Client ID (passo 1.4).

## 4) Publicar na Vercel

1. Em https://vercel.com, entre com sua conta do GitHub → **Add New › Project** → importe o repositório `geplan`.
2. Framework: **Other**; sem comando de build; diretório de saída: raiz. → **Deploy**.
3. O site fica em `https://geplan-xxxx.vercel.app`. Adicione esse endereço nas origens autorizadas do Client ID.

Cada novo envio ao GitHub atualiza os dois sites automaticamente.

## 5) Instalar no celular

Abra o endereço no Chrome (Android) ou Safari (iPhone):
- Android: menu ⋮ › **Instalar app** (ou o botão "Instalar" na tela Google Drive do site).
- iPhone: Compartilhar › **Adicionar à Tela de Início**.

## Estrutura dos arquivos

```
index.html              página única do app
css/styles.css          visual (claro/escuro, computador/celular)
js/app.js               login, rotas, Google Drive, eventos
js/obra.js              telas da obra (Orçamento, Vínculos, Atividades, Gantt, Físico-financeiro, Cadastro)
js/gestao.js            telas Painel, Medições, Diário de obra e Financeiro
js/financeiro.js        BDI, revisões do orçamento, custos (comprometido/incorrido/pago), valor agregado
js/execucao.js          medições de avanço e diário de obra (regras)
js/orcImport.js         importação de orçamento por Excel (associação de colunas, validação)
js/fases.js, js/sinapi.js  biblioteca de fases (modelos de EAP) e base SINAPI
js/biblioteca.js        telas Obras, Composições e Importar planilha
js/model.js             modelo de dados (v2) e migração do formato antigo
js/calculo.js           HH, duração, custo alocado e validações (regras da planilha)
js/predecessoras.js     notação 3.2 / 3.2 TI-10 / 3.1 II+5 ↔ dependências
js/cpm.js               calendário de dias úteis e cronograma CPM (folga, caminho crítico)
js/curvaS.js            Curva S física e financeira, avanço planejado/real
js/importador.js        leitura do .xlsx modelo
js/schedule.js          datas e formatação pt-BR
js/store.js             armazenamento no aparelho
js/drive.js             login Google e sincronização com o Drive
js/export.js            exportação Excel/PDF
js/ui.js, js/libs.js    componentes de tela e bibliotecas externas
js/config.js            Client ID do Google, contas autorizadas e conexão do Supabase (URL + chave pública)
js/permissoes.js        o que cada perfil pode alterar (só interface; quem decide é o banco)
js/navegacao.js         menu por áreas (computador e celular) e seletor de obra dos módulos
js/inicio.js            Visão geral (página inicial) e Tarefas e pendências
js/indicadores.js       indicadores por obra e consolidados (critérios de avanço, atraso, custo)
js/nuvem/               modo nuvem: mapeamento app ↔ tabelas, sincronização, login, empresa
supabase/               migrações SQL, planos iniciais, guia de configuração e simulador de testes
sw.js, manifest.webmanifest, icons/   app instalável e offline
tests/                  testes automáticos (index.html: cálculos · db.html: banco/RLS · nuvem.html: app em modo nuvem)
tools/serve.ps1         servidor local para testes
```
