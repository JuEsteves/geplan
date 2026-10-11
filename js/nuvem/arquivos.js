// Arquivos no Supabase Storage (bucket PRIVADO "documentos"). Caminho: <empresa>/<área>/<registro>/<uuid>-<nome>.
// O banco guarda só os metadados; o acesso ao conteúdo é por URL assinada de curta duração, gerada para quem
// passa nas políticas de segurança do Storage (ver migração 0006).
import { sb, erroBanco } from './supabase.js';

export const BUCKET = 'documentos';
export const TAMANHO_MAX = 50 * 1024 * 1024;   // igual ao limite do bucket
export const TIPOS_ACEITOS = {
  'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX', 'application/vnd.ms-excel': 'XLS',
  'application/msword': 'DOC', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX', 'text/plain': 'TXT',
};
export const ACCEPT = Object.keys(TIPOS_ACEITOS).join(',');

/** Nome seguro para o caminho (sem acentos/espaços estranhos). */
const nomeSeguro = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').slice(-120);

export function validarArquivo(file) {
  if (!file) throw new Error('Escolha um arquivo.');
  if (!TIPOS_ACEITOS[file.type]) throw new Error(`Tipo de arquivo não aceito (${file.type || 'desconhecido'}). Aceitos: ${[...new Set(Object.values(TIPOS_ACEITOS))].join(', ')}.`);
  if (file.size > TAMANHO_MAX) throw new Error('Arquivo maior que 50 MB.');
  if (!file.size) throw new Error('Arquivo vazio.');
}

/** Envia o arquivo; retorna o caminho gravado. Não sobrescreve arquivos existentes. */
export async function enviarArquivo(orgId, area, registroId, file) {
  validarArquivo(file);
  const caminho = `${orgId}/${area}/${registroId}/${crypto.randomUUID()}-${nomeSeguro(file.name)}`;
  const c = await sb();
  const { error } = await c.storage.from(BUCKET).upload(caminho, file, { contentType: file.type, upsert: false });
  if (error) throw erroBanco(error, 'arquivo');
  return caminho;
}

/** URL temporária (padrão: 5 minutos) para abrir ou baixar o arquivo. */
export async function urlTemporaria(caminho, segundos = 300, nomeDownload = null) {
  const c = await sb();
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(caminho, segundos, nomeDownload ? { download: nomeDownload } : undefined);
  if (error) throw erroBanco(error, 'arquivo');
  return data.signedUrl;
}

export const tamanhoLegivel = (b) => (b >= 1048576 ? `${(b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
