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

// Limite menor para fotos e comprovantes de obra enquanto a empresa usa o plano gratuito do Supabase (1 GB no total).
export const TAMANHO_MAX_OBRA = 10 * 1024 * 1024;

export function validarArquivo(file, max = TAMANHO_MAX, tipos = TIPOS_ACEITOS) {
  if (!file) throw new Error('Escolha um arquivo.');
  if (!tipos[file.type]) throw new Error(`${file.name || 'Arquivo'}: tipo não aceito (${file.type || 'desconhecido'}). Aceitos: ${[...new Set(Object.values(tipos))].join(', ')}.`);
  if (file.size > max) throw new Error(`${file.name}: maior que ${Math.round(max / 1048576)} MB.`);
  if (!file.size) throw new Error('Arquivo vazio.');
}

/** Envia o arquivo; retorna o caminho gravado. Não sobrescreve arquivos existentes. */
export async function enviarArquivo(orgId, area, registroId, file, max = TAMANHO_MAX, tipos = TIPOS_ACEITOS) {
  validarArquivo(file, max, tipos);
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

/** Vários links temporários de uma vez (galerias). Guarda em memória até perto de expirar. */
const cacheUrls = new Map();   // caminho → { url, expira }
export async function urlsTemporarias(caminhos, segundos = 3600) {
  const agora = Date.now();
  const faltam = [...new Set(caminhos.filter(Boolean))].filter((p) => !(cacheUrls.get(p)?.expira > agora + 60000));
  if (faltam.length) {
    const c = await sb();
    const { data, error } = await c.storage.from(BUCKET).createSignedUrls(faltam, segundos);
    if (error) throw erroBanco(error, 'arquivos');
    for (const r of data || []) if (r.signedUrl && !r.error) cacheUrls.set(r.path, { url: r.signedUrl, expira: agora + segundos * 1000 });
  }
  return new Map(caminhos.filter((p) => cacheUrls.has(p)).map((p) => [p, cacheUrls.get(p).url]));
}
export const urlEmCache = (caminho) => cacheUrls.get(caminho)?.url || '';

/** Envia uma imagem gerada no aparelho (ex.: assinatura desenhada) como arquivo. */
export async function enviarBlob(orgId, area, registroId, blob, nome, max = TAMANHO_MAX) {
  return enviarArquivo(orgId, area, registroId, new File([blob], nome, { type: blob.type || 'image/png' }), max);
}

export const TIPOS_VIDEO = { 'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/webm': 'WEBM' };
export const TAMANHO_MAX_VIDEO = 50 * 1024 * 1024;
export const TIPOS_IMAGEM = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP' };

export const tamanhoLegivel = (b) => (b >= 1048576 ? `${(b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
