# Ambiente de testes do GEPLAN

Este ramo (`teste`) é publicado pela Vercel em <https://geplan-git-teste-geplan1.vercel.app/>.
Nesse endereço o app usa o projeto Supabase **GEPLAN-testes** (dados separados do sistema real) e mostra a faixa
"AMBIENTE DE TESTES". A escolha do banco é feita em `js/config.js` pelo endereço do site.

- Para atualizar o ambiente de testes com a versão nova, publique os mesmos arquivos neste ramo.
- Migrações novas: aplique primeiro no projeto GEPLAN-testes, confira, e só depois no projeto real.
- Dados deste ambiente são de teste: não use para a operação real das obras.
