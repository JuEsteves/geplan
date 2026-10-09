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
