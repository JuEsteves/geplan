# Contratos de mão de obra (empreiteiros e prestadores)

Aba **Contratos** da obra (modo nuvem) e menu **Execução e controle › Contratos de mão de obra**.
Fornecedores continuam sendo os de material; aqui ficam os profissionais (pessoa, empresa ou equipe do cadastro de
Medições › Profissionais) contratados para a obra — ex.: "Ricardo para tocar a obra", eletricista, gesseiro, pintor.

## O contrato
- Profissional, objeto (ex.: "Execução da obra — empreitada global"), escopo detalhado, **fases da EAP** abrangidas,
  **valor total**, **forma de pagamento**, início e término previsto, observações e o **arquivo do contrato assinado**
  (PDF/Word, pasta privada; só quem vê valores de mão de obra abre).
- Formas de pagamento:
  - **Por medição**: pago pelos boletins — em cada boletim informa-se o % do serviço executado; valor = % × valor do contrato.
  - **Mensal** ou **em parcelas**: "Gerar parcelas" divide o valor em parcelas iguais, uma por mês (datas e valores
    ajustáveis no rascunho; a soma precisa bater com o valor). Cada parcela é lançada no Financeiro quando for paga.
  - **Avulso**: pagamentos lançados à mão no Financeiro (o valor é opcional).
- Situação: **rascunho → vigente → concluído ou rescindido** (com motivo). Depois de vigente, valor e condições não
  mudam (só observações e arquivo); mudança de valor = aditivo no Financeiro ou novo contrato.

## Integração (sem contar duas vezes)
- Ao **ativar**, o contrato com valor vira compromisso "Contrato · Mão de obra" no Financeiro (CTR-0001 · objeto), com a
  fase (quando é uma só) → entra no **comprometido** dos custos.
- Parcelas lançadas e medições lançadas viram **despesas desse contrato** → somam no incorrido e **abatem** do comprometido.
  Medição aprovada e ainda não lançada de um contrato aparece em "a lançar", mas não soma de novo no comprometido.
- Contrato por medição cria o **vínculo de remuneração** (empreitada, atividades das fases do escopo) usado nos boletins.
- Encerrar: o compromisso passa a contar só o que já foi lançado; o vínculo de medição deixa de valer.
- **Quando contratar**: a lista mostra as fases do cronograma que começam nos próximos 60 dias (ou já começaram) e não
  estão em nenhum contrato em rascunho ou vigente, com o botão "Contratar" já marcando a fase.

## Permissões (banco, migração `0015_contratos_mao_obra`)
- Ver contratos e valores: administrador, engenheiro e financeiro (supervisor e cliente não).
- Criar/editar/ativar/encerrar: quem vê valores e tem a liberação de compras. Lançar parcela: quem grava o Financeiro.
- Testes: `tests/db.html` grupo 19 e `tests/index.html` grupo 24.

## Próximo passo
Modelos de contrato por profissional (os da empresa): preencher o contrato a partir do modelo com os dados do
cadastro (partes, objeto, valor, forma de pagamento, prazo) e gerar o PDF.
