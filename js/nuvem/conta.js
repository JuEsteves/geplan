// Conta do usuário no modo nuvem: login (e-mail/senha ou Google), cadastro, recuperação de senha, empresas,
// membros, convites e plano. Toda regra de acesso é verificada no banco (RLS e funções); aqui só a interface.
import { sb, erroBanco, bancoSupabase } from './supabase.js';

const base = () => location.origin + location.pathname;
const verifica = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };

/* ---------- sessão ---------- */
export async function sessao() {
  const c = await sb();
  const { data, error } = await c.auth.getSession();
  if (error) throw erroBanco(error);
  return data.session;
}
export async function aoMudarSessao(fn) {
  const c = await sb();
  c.auth.onAuthStateChange((evento, s) => fn(evento, s));
}
export async function entrar(email, senha) {
  const c = await sb();
  const { data, error } = await c.auth.signInWithPassword({ email: email.trim(), password: senha });
  if (error) throw new Error(/invalid login/i.test(error.message) ? 'E-mail ou senha incorretos.' : /not confirmed/i.test(error.message) ? 'Confirme seu e-mail pelo link enviado antes de entrar.' : error.message);
  return data.session;
}
export async function cadastrar(email, senha, nome) {
  if ((senha || '').length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  const c = await sb();
  const { data, error } = await c.auth.signUp({ email: email.trim(), password: senha, options: { data: { full_name: nome.trim() }, emailRedirectTo: base() } });
  if (error) throw new Error(/registered/i.test(error.message) ? 'Este e-mail já tem cadastro. Use "Entrar" ou "Esqueci a senha".' : error.message);
  return data;   // data.session é nulo quando o projeto exige confirmação de e-mail
}
export async function entrarComGoogle() {
  const c = await sb();
  const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: base() } });
  if (error) throw erroBanco(error);
}
export async function recuperarSenha(email) {
  const c = await sb();
  verifica(await c.auth.resetPasswordForEmail(email.trim(), { redirectTo: base() + '?recuperar=1' }), 'recuperação');
}
export async function novaSenha(senha) {
  if ((senha || '').length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  const c = await sb();
  verifica(await c.auth.updateUser({ password: senha }), 'senha');
}
export async function sair() {
  const c = await sb();
  await c.auth.signOut();
}

/* ---------- empresas ---------- */
export async function minhasEmpresas() {
  return verifica(await (await sb()).rpc('my_organizations'), 'empresas') || [];
}
export async function criarEmpresa(nome, plano = 'profissional') {
  return verifica(await (await sb()).rpc('create_organization', { p_name: nome.trim(), p_plan: plano }), 'criar empresa');
}
export async function aceitarConvite(token) {
  return verifica(await (await sb()).rpc('accept_invitation', { p_token: token.trim() }), 'convite');
}
/** Liberações efetivas do usuário logado nesta empresa (calculadas pelo banco). */
export async function minhasLiberacoes(orgId) {
  return verifica(await (await sb()).rpc('minhas_liberacoes', { p_org: orgId }), 'liberações') || [];
}
export async function perfil(userId) {
  const c = await sb();
  return verifica(await c.from('user_profiles').select('*').eq('id', userId).maybeSingle(), 'perfil');
}
export async function lembrarEmpresa(userId, orgId) {
  const c = await sb();
  await c.from('user_profiles').update({ last_org_id: orgId }).eq('id', userId);
}
export async function logoDaEmpresa(orgId) {
  const c = await sb();
  return verifica(await c.from('organizations').select('logo_path').eq('id', orgId).maybeSingle(), 'empresa')?.logo_path || '';
}
/** Só o administrador consegue (banco: política organizations_update e caminho dentro da pasta da empresa). */
export async function definirLogo(orgId, caminho) {
  const c = await sb();
  verifica(await c.from('organizations').update({ logo_path: caminho }).eq('id', orgId), 'logo');
}
export async function renomearEmpresa(orgId, nome) {
  const c = await sb();
  verifica(await c.from('organizations').update({ name: nome.trim() }).eq('id', orgId), 'empresa');
}

/* ---------- membros e convites (só o admin vê convites; o banco garante) ---------- */
export async function membros(orgId) {
  const c = await sb();
  const ms = verifica(await c.from('organization_members').select('user_id, role, permissions, created_at').eq('org_id', orgId), 'membros') || [];
  const ps = ms.length ? verifica(await c.from('user_profiles').select('id, email, full_name').in('id', ms.map((m) => m.user_id)), 'perfis') : [];
  const porId = new Map(ps.map((p) => [p.id, p]));
  return ms.map((m) => ({ ...m, email: porId.get(m.user_id)?.email || '', nome: porId.get(m.user_id)?.full_name || '' }));
}
export async function convites(orgId) {
  const c = await sb();
  return verifica(await c.from('invitations').select('id, email, role, token, created_at, expires_at, accepted_at, revoked_at')
    .eq('org_id', orgId).is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false }), 'convites') || [];
}
export async function convidar(orgId, userId, email, papel) {
  const c = await sb();
  const r = verifica(await c.from('invitations').insert({ org_id: orgId, email: email.trim().toLowerCase(), role: papel, invited_by: userId }).select('token').single(), 'convite');
  return linkConvite(r.token);
}
export const linkConvite = (token) => `${base()}#/convite/${token}`;
export async function revogarConvite(id) {
  const c = await sb();
  verifica(await c.from('invitations').update({ revoked_at: new Date().toISOString() }).eq('id', id), 'convite');
}
export async function mudarPapel(orgId, userId, papel) {
  const c = await sb();
  // trocar o perfil volta as liberações ao padrão do novo perfil
  verifica(await c.from('organization_members').update({ role: papel, permissions: null }).eq('org_id', orgId).eq('user_id', userId), 'papel');
}
/** Define as liberações de uma pessoa (null = padrão do perfil). Só o administrador consegue (banco). */
export async function definirLiberacoes(orgId, userId, permissoes) {
  const c = await sb();
  verifica(await c.from('organization_members').update({ permissions: permissoes }).eq('org_id', orgId).eq('user_id', userId), 'liberações');
}
export async function removerMembro(orgId, userId) {
  const c = await sb();
  verifica(await c.from('organization_members').delete().eq('org_id', orgId).eq('user_id', userId), 'membro');
}

/* ---------- equipe de cada obra ---------- */
export async function equipeDaObra(projectId) {
  return verifica(await (await sb()).from('project_members').select('user_id, role').eq('project_id', projectId), 'equipe') || [];
}
export async function incluirNaObra(projectId, userId) {
  verifica(await (await sb()).from('project_members').insert({ project_id: projectId, user_id: userId }), 'equipe');
}
export async function tirarDaObra(projectId, userId) {
  verifica(await (await sb()).from('project_members').delete().eq('project_id', projectId).eq('user_id', userId), 'equipe');
}

/* ---------- plano e uso ---------- */
export async function usoDoPlano(orgId) {
  const c = await sb();
  const [uso, planos] = await Promise.all([
    c.from('v_org_usage').select('*').eq('org_id', orgId).maybeSingle(),
    c.from('plans').select('*').eq('is_available', true).order('sort_order'),
  ]);
  return { uso: verifica(uso, 'uso'), planos: verifica(planos, 'planos') || [] };
}

export const banco = async () => bancoSupabase(await sb());
