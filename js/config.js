// Cole aqui o "ID do cliente OAuth" criado no Google Cloud (veja o README).
// Exemplo: '1234567890-abcdefg.apps.googleusercontent.com'
// Também é possível informar o ID pela tela "Google Drive" do próprio site.
export const GOOGLE_CLIENT_ID = '591124863425-v1aauosv96fphp86531m8necih4qaf8i.apps.googleusercontent.com';

// Contas Google autorizadas a entrar no GEPLAN.
// Para não expor os e-mails no código público, guardamos o "hash" SHA-256 de cada e-mail (em minúsculas).
// Para autorizar outra pessoa: na tela "Google Drive" do GEPLAN use "Autorizar outra pessoa", cole o código aqui
// e adicione o e-mail dela também em Google Cloud › Google Auth Platform › Público-alvo › Usuários de teste.
export const ALLOWED_EMAIL_HASHES = [
  '179943bef1b704fff7a6ff06760f16baef40f7fc9feecdca3ce5ab3154a26e76', // dona do sistema
];

// ---------------------------------------------------------------------------------------------
// Banco de dados na nuvem (Supabase). Enquanto estes dois campos estiverem vazios, o GEPLAN funciona como
// antes (dados no aparelho + Google Drive). Preenchidos, passa a usar o banco: login por e-mail/Google,
// empresas, convites, permissões e dados de todas as obras no Supabase (veja supabase/README.md).
//
// A URL e a chave "anon" (publishable) SÃO PÚBLICAS por natureza: vão para o navegador de qualquer forma.
// A proteção dos dados vem das políticas RLS do banco. NUNCA coloque aqui a chave "service_role" (secreta).
//
// AMBIENTE DE TESTES: o endereço do ramo "teste" na Vercel (geplan-git-teste-….vercel.app) usa o projeto Supabase
// "GEPLAN-testes", com dados totalmente separados do sistema real, e mostra uma faixa "Ambiente de testes".
// Por ser outro endereço, a cópia local do navegador também fica separada da do sistema real.
const BANCOS = {
  producao: {
    url: 'https://mywimldrzhvwsffwivpw.supabase.co',
    anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15d2ltbGRyemh2d3NmZndpdnB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MTE5ODYsImV4cCI6MjEwNzI4Nzk4Nn0.yo08pdfE4lo0Z8frX5Hc8cOY8U3HZAp2Gks8dypekt8',
  },
  teste: {   // projeto Supabase "GEPLAN-testes" (mesmas migrações, dados separados)
    url: 'https://intpnyntneityqpzelxb.supabase.co',
    anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImludHBueW50bmVpdHlxcHplbHhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTg3NjcsImV4cCI6MjEwNzM3NDc2N30.4EQpJmx9aba4SNIErNIeKh8NtGOc50eI-_taHrUZK2o',
  },
};
export const AMBIENTE = /^geplan-git-teste-/.test(globalThis.location?.hostname || '') ? 'teste' : 'producao';
export const SUPABASE_URL = BANCOS[AMBIENTE].url;
export const SUPABASE_ANON_KEY = BANCOS[AMBIENTE].anon;

if (AMBIENTE === 'teste' && globalThis.document) {
  document.title = `[TESTES] ${document.title}`;
  const faixa = document.createElement('div');
  faixa.className = 'faixa-teste';
  faixa.textContent = 'AMBIENTE DE TESTES — dados separados do sistema real';
  document.body.prepend(faixa);
}
