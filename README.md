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
7. **Importar planilha** – cria uma obra a partir do .xlsx modelo (abas EAP Detalhada, Composicoes, Orcamento, Vinculo_Orc_EAP e Duracao_Atividades).

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
datas com FS, TI negativo, SS com lag, várias predecessoras e feriado) e, se `docs/` tiver a planilha, testam também a importação.

> A pasta `docs/` (planilhas das obras) e `tests/` **não** precisam ir para o GitHub: o repositório é público.

### Fase 2 (preparada)
Cada obra tem a coleção `rdo` (vazia) e as composições têm `versao`/`ativa`, para registrar quantidade executada e horas
reais por função e gravar o coeficiente real (`horas ÷ quantidade`) como nova versão "Obra própria".

## Armazenamento

- Tudo é salvo **no aparelho** na hora (funciona sem internet, na obra).
- Conectado ao **Google Drive**, o site cria `Meu Drive › GEPLAN - Planejamento de Obras` com
  `Biblioteca (etapas e composições).json` e um arquivo `Obra - <nome>.json` por obra, e sincroniza
  automaticamente (a versão mais recente vence). Use a mesma conta no PC e no celular.
- O site usa a permissão `drive.file`: ele **só enxerga os arquivos que ele mesmo criou** no seu Drive.

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
js/obra.js              telas da obra (Orçamento, Vínculos, Atividades, Gantt, Curva S, Acompanhamento, Configurações)
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
js/config.js            Client ID do Google e contas autorizadas
sw.js, manifest.webmanifest, icons/   app instalável e offline
tests/                  testes automáticos (abrir no navegador)
tools/serve.ps1         servidor local para testes
```
