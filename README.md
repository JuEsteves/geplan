# GEPLAN – Gestão e Planejamento de Obras

Site (e app de celular) para montar o orçamento de quantitativos de uma obra e gerar o cronograma automaticamente
a partir das **composições de tempo de execução** (horas por unidade).

## Como funciona

1. **Etapas** – biblioteca de etapas da construção (Fundação, Impermeabilização do baldrame, Alvenaria…). Etapas antigas podem ser arquivadas.
2. **Composições** – cada serviço tem unidade e coeficiente em **h/unidade** para 1 equipe. Ex.: Alvenaria = 0,8 h/m².
3. **Obra › Orçamento** – adicione as etapas e, dentro delas, os serviços com quantidade, nº de equipes e predecessoras.
4. **Cronograma** – calculado sozinho:
   `duração (dias úteis) = arredondar para cima( quantidade × coeficiente ÷ (equipes × jornada) )`
   Ex.: 135 m² × 0,8 h/m² = 108 h ÷ (1 × 8 h) = 13,5 → **14 dias úteis**.
5. **Gantt** com setas de dependência, caminho crítico, linha de base e dias não úteis.
6. **Acompanhamento** – % executado por serviço, datas reais, medições e **Curva S** (planejado × real).
7. **Exportação** para Excel e PDF.

### Predecessoras
| Digite | Significado |
|---|---|
| `1.2` | começa depois que o serviço 1.2 termina |
| `3` | começa depois que **toda a etapa 3** termina |
| `2.1+2` | começa 2 dias úteis após o término de 2.1 |
| `2.1-3` | começa 3 dias úteis antes do término de 2.1 (sobreposição) |
| `1.2; 2.1` | depende dos dois |

Ao criar um serviço, ele já vem ligado ao serviço anterior da mesma etapa (ou à etapa anterior). Basta editar.

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
js/app.js               telas e interações
js/schedule.js          cálculo do cronograma, calendário, caminho crítico, curva S
js/store.js             armazenamento no aparelho
js/drive.js             login Google e sincronização com o Drive
js/export.js            exportação Excel/PDF
js/config.js            Client ID do Google
sw.js, manifest.webmanifest, icons/   app instalável e offline
tools/serve.ps1         servidor local para testes
```
