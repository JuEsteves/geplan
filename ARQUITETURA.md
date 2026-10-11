# GEPLAN — Arquitetura, diagnóstico e plano de evolução para SaaS

Documento vivo: descreve o estado **real** do código e o que falta. Atualize ao final de cada fase.

## 1. Diagnóstico do projeto (out/2026)

| Item | Situação encontrada |
|---|---|
| Frontend | Site estático, **JavaScript puro com ES modules**, sem framework e sem etapa de build; PWA (service worker, manifest) |
| Backend / APIs | **Nenhum** servidor próprio. Antes desta fase, dados só no `localStorage` do aparelho, sincronizados com o Google Drive do usuário (um JSON por obra) |
| Autenticação | Login Google (Google Identity Services) + lista de e-mails autorizados (hash) — controle **só na tela**, sem verificação em servidor |
| Deploy | GitHub (upload manual) → GitHub Pages e Vercel (`vercel.json` só com cabeçalhos de cache) |
| Telas funcionais | Obras, orçamento (BDI TCU, revisões, importação Excel), vínculos orçamento × EAP, atividades/EAP, CPM (FS/SS/FF/SF, defasagem, caminho crítico, linha de base), Gantt, físico-financeiro/Curva S, medições, diário, financeiro, cadastro, fases (modelos de EAP), composições, base SINAPI |
| Regras de negócio | Já centralizadas em módulos de domínio testáveis: `calculo.js`, `cpm.js`, `curvaS.js`, `financeiro.js`, `execucao.js`, `orcImport.js` |
| Dados simulados | Nenhum dado fictício no app. Testes usam a planilha real da usuária (`docs/`, fora do GitHub) |
| Testes | `tests/index.html` — 70 testes de cálculo, cronograma, curva, medições, BDI, custos, importação |
| Lacunas para SaaS | sem banco, sem multiempresa, sem permissões no servidor, sem assinatura |

**Decisão:** manter o frontend atual (não há ganho técnico em trocar de framework agora) e adicionar o
**Supabase** (PostgreSQL + Auth + RLS) como backend. A compatibilidade é total: a biblioteca oficial `supabase-js`
roda direto no navegador (carregada do CDN só no modo nuvem), sem build. As regras de acesso ficam **no banco**
(RLS + funções), que é o "backend" de verdade para um site estático. Lógica que precisa de segredo (webhooks de
pagamento) irá para *Supabase Edge Functions* na Fase 8.

## 2. Arquitetura

```
Navegador (PWA, JS puro)
 ├─ telas (obra.js, gestao.js, biblioteca.js, fases.js, …)
 ├─ domínio testável (calculo, cpm, curvaS, financeiro, execucao, orcImport)
 ├─ store.js  — cópia de trabalho no aparelho (abre rápido e funciona sem internet)
 ├─ modo Drive (drive.js)            → Google Drive do usuário (modo antigo, mantido)
 └─ modo nuvem (js/nuvem/*)          → Supabase
      ├─ mapa.js        documento do app ↔ linhas das tabelas (puro, sem perda: campos extras → jsonb `extra`)
      ├─ sincronizar.js envia só as diferenças, na ordem das chaves estrangeiras; baixa por empresa
      ├─ supabase.js    cliente oficial + adaptador (paginação, lotes, mensagens de erro)
      ├─ conta.js       login, cadastro, senha, empresas, convites, membros, plano
      ├─ nuvem.js       ciclo de vida: entrar na empresa, envio automático, atualização, dados anteriores
      └─ telaEmpresa.js tela Empresa (conta, pessoas, acesso às obras, plano e uso, exportação)

Supabase (PostgreSQL 15+)
 ├─ RLS em todas as tabelas · funções SECURITY DEFINER baseadas em auth.uid()
 ├─ gatilhos de integridade (ciclos, vínculos ≤ 100%, pagamentos ≤ despesa, medição só em folha,
 │   % da atividade a partir das medições, limites do plano, auditoria)
 └─ views de indicadores com security_invoker (custos e orçamento calculados em NUMERIC)
```

### Escolhas importantes
- **Uma base, várias empresas**: toda linha de negócio pertence a uma obra, e a obra a uma empresa. Tabelas filhas
  levam `project_id` com **chave estrangeira composta** `(id, project_id)` → é impossível ligar registros de obras
  diferentes, mesmo com ids forjados.
- **Ids UUID** gerados no aparelho (`crypto.randomUUID`), iguais do aparelho ao banco — permite trabalhar sem
  internet. Ids antigos são convertidos uma vez (`converterIds`) mantendo todas as referências.
- **Sem exclusão física** de obras, orçamento, EAP, medições, diário, contratos, despesas e pagamentos
  (`deleted_at`); histórico (`project_history`, revisões, linhas de base) só recebe inclusões.
- **Linha de base aprovada é imutável**: só a marca "atual" muda; nova aprovação preserva as anteriores.
- **Mesmas fórmulas no app e no banco** — conferidas por teste (BDI TCU, custos sem duplicidade).
- **Permissões**: o banco decide (RLS). O app só esconde o que o perfil não pode fazer e não envia o que seria
  recusado; o que o perfil tentou alterar sem permissão é desfeito com aviso.

## 3. Modelo de dados (fase atual)

Organização e acesso: `organizations`, `organization_members` (perfil), `user_profiles`, `invitations`,
`plans`, `subscriptions`, `subscription_events`, `audit_log`.
Obras: `clients`, `projects`, `project_members`, `project_holidays`, `org_holidays`, `project_history`.
Biblioteca: `cost_compositions`, `composition_items` (mão de obra hoje; materiais/equipamentos previstos), `wbs_templates`.
Orçamento e planejamento: `budget_items`, `budget_versions`, `wbs_nodes`, `activity_dependencies`,
`budget_allocations`, `schedule_baselines`, `schedule_baseline_items`.
Execução: `activity_measurements`, `daily_reports`, `daily_report_crew`, `daily_report_activities`, `site_occurrences`.
Financeiro: `contracts`, `contract_amendments`, `expenses`, `payments`.
Views: `v_project_budget`, `v_budget_item_allocation`, `v_contract_totals`, `v_project_costs`, `v_org_usage`.

Ainda **não** criadas (só quando a funcionalidade existir): insumos com preço (`cost_inputs`), fornecedores,
solicitações/cotações/pedidos detalhados de compra, documentos/anexos (Storage privado), inspeções de qualidade,
cobranças (`billing_records`, `webhook_events`).

## 4. Fórmulas

Ver o cabeçalho de `js/financeiro.js` (orçamento, BDI, custos, valor agregado), `js/curvaS.js` (distribuição,
pesos físicos, Curva S) e `js/cpm.js` (CPM). O banco repete as fórmulas de orçamento e custos em
`supabase/migrations/…0005_indicadores.sql`.

## 5. Status por fase

| Fase | Situação |
|---|---|
| 1 — Diagnóstico e estrutura | **Feita**: diagnóstico, arquitetura, migrações, RLS, `.env.example`, documentação |
| 2 — Autenticação e empresas | **Feita no código** (e-mail/senha, Google via Supabase, recuperação de senha, empresas, convites, perfis, acesso por obra). **Falta:** criar o projeto Supabase e validar com o serviço real |
| 3 — Obras e orçamento | Telas e cálculos prontos (fases anteriores) e **persistidos no banco** no modo nuvem. Falta: insumos com preço e composições de materiais/equipamentos |
| 4 — Planejamento | Pronto e persistido (EAP, dependências, CPM, linha de base). Datas do CPM ainda calculadas no aparelho (não gravadas no banco) |
| 5 — Físico-financeiro | Pronto e persistido (medições, diário, Curva S). Falta: fotos/anexos (Storage privado) e aprovação de medição em duas etapas |
| 6 — Financeiro e gerencial | Pronto e persistido (contratos, aditivos, despesas, pagamentos, painel). Falta: suprimentos completos (solicitação → cotação → pedido → recebimento), relatórios |
| 7 — Preparação comercial | Parcial: planos e limites no banco, área "Plano e uso". Falta: área do assinante completa e painel administrativo |
| 8 — Pagamentos | Não iniciada (de propósito: só depois de validar multiempresa e segurança com o projeto real) |

## 6. Testes

| Suíte | O que cobre | Resultado mais recente |
|---|---|---|
| `tests/index.html` | cálculo, CPM, curva, medições, BDI, custos, importações | 70/70 |
| `tests/db.html` | migrações em PostgreSQL real (PGlite), RLS entre empresas e perfis, integridade, limites do plano, auditoria, ida e volta da obra real da planilha pelo motor de sincronização | 62/62 |
| `tests/nuvem.html` | app real em modo nuvem contra emulador local do Supabase: cadastro, empresa, importar planilha, criar obra, editar orçamento, convite, perfil supervisor, medição, despesa, recarregar sem cópia local, bloqueio de outra empresa | verificado manualmente (roteiro em `supabase/README.md`) |

## 7. Limitações conhecidas e riscos

- **O banco real ainda não foi conectado**: falta criar o projeto Supabase e informar URL/chave. Nada no app
  afirma o contrário; sem configuração ele continua no modo Google Drive.
- Edição simultânea da mesma linha por duas pessoas: vence a última gravação (por linha, não por obra). Para
  edição colaborativa em tempo real, adicionar *Realtime* do Supabase.
- O cliente (perfil somente leitura) não vê orçamento/vínculos, então o cronograma dele usa só durações manuais
  e padrão. Próximo passo: gravar as datas calculadas do CPM em `wbs_nodes`.
- Telas ainda não escondem todos os controles por perfil (o banco bloqueia; o app desfaz e avisa).
- O service worker não registra no navegador embutido do app de desenvolvimento (funciona nos navegadores comuns).

## 8. Próximos passos recomendados

1. Criar o projeto Supabase (passo a passo em `supabase/README.md`), preencher `js/config.js`, rodar os testes
   de conferência e migrar as obras do aparelho pela tela **Empresa**.
2. Anexos privados (fotos do diário e evidências de medição) com Supabase Storage + políticas.
3. Gravar datas do CPM no banco; relatórios; controles por perfil em todas as telas.
4. Suprimentos completos; insumos e composições de materiais.
5. Área do assinante e painel administrativo; depois pagamentos (Mercado Pago) com webhooks validados no servidor.
