// Estrutura geral do GEPLAN: login, rotas, Google Drive, backup e eventos das telas.
import * as store from './store.js';
import * as drive from './drive.js';
import { ALLOWED_EMAIL_HASHES } from './config.js';
import { todayISO } from './schedule.js';
import { esc, ui, toast, ask, setRenderer, queueRender } from './ui.js';
import { viewObra, acoesObra, mudancasObra, entradasObra, depoisObra } from './obra.js';
import { viewObras, viewComposicoes, viewImportar, acoesBiblioteca, mudancasBiblioteca, entradasBiblioteca } from './biblioteca.js';
import { viewFases, acoesFases, mudancasFases, entradasFases } from './fases.js';
import { acoesGestao, mudancasGestao } from './gestao.js';
import { viewSinapi, acoesSinapi, mudancasSinapi, entradasSinapi, depoisSinapi } from './sinapi.js';
import { configurado as nuvemConfigurada } from './nuvem/supabase.js';
import * as conta from './nuvem/conta.js';
import * as nuvem from './nuvem/nuvem.js';
import { viewEmpresa, acoesEmpresa, mudancasEmpresa, limparEmpresa } from './nuvem/telaEmpresa.js';
import { renderMenu, viewModulo, MODULOS, obraUnica, linkModulo } from './navegacao.js';
import { viewInicio, viewPendencias, resumoDe, entradasInicio, mudancasInicio } from './inicio.js';
import { viewConfiguracoes } from './configuracoes.js';
import { viewFornecedores, viewFornecedor, acoesFornecedores, entradasFornecedores, mudancasFornecedores, limparFornecedores } from './fornecedores.js';

// Modo nuvem (Supabase) quando js/config.js tiver URL e chave; senão, modo Google Drive (como antes).
const NUVEM = nuvemConfigurada();

/* ---------- acesso (login com Google + lista de contas autorizadas) ---------- */
let authorized = false;
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function isAllowed(email) {
  if (!email) return false;
  return ALLOWED_EMAIL_HASHES.includes(await sha256(email.trim().toLowerCase()));
}

const $view = document.getElementById('view');
const $sync = document.getElementById('sync');


function renderGate(error = '') {
  if (NUVEM) return renderGateNuvem(gateModo, error);
  document.body.classList.add('locked');
  document.getElementById('gate').innerHTML = `<div class="gate-card">
    <div class="gate-logo"><img src="icons/logo-full.png" alt="GEPLAN – Gestão e Planejamento de Obras"></div>
    <p class="gate-slogan">Da estratégia à execução</p>
    <button class="gate-btn" id="gateLogin" type="button">
      <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
      Entrar com Google
    </button>
    ${error ? `<div class="gate-error">${esc(error)}</div>` : ''}
    <p class="gate-note">Acesso restrito a usuários autorizados.</p>
  </div>`;
  document.getElementById('gateLogin').onclick = login;
}

async function login() {
  const btn = document.getElementById('gateLogin');
  btn.disabled = true; btn.lastChild.textContent = ' Entrando…';
  try {
    const user = await drive.signIn();
    if (!(await isAllowed(user.emailAddress))) {
      drive.disconnect();
      return renderGate(`A conta ${user.emailAddress} não tem acesso ao GEPLAN.`);
    }
    // Outra conta usou este aparelho antes: não misturar os dados
    if (store.meta.owner && store.meta.owner !== user.emailAddress.toLowerCase()) store.clearLocal();
    store.meta.owner = user.emailAddress.toLowerCase();
    store.saveMeta();
    authorized = true;
    document.body.classList.remove('locked');
    render();
    drive.init();
    await drive.activate(user);
  } catch (e) {
    renderGate(e.message || 'Não foi possível entrar.');
  }
}

/* ---------- acesso no modo nuvem (Supabase Auth: e-mail/senha ou Google; empresas e convites) ---------- */
let gateModo = 'entrar';
let sessaoAtual = null;
const LOGO = `<div class="gate-logo"><img src="icons/logo-full.png" alt="GEPLAN – Gestão e Planejamento de Obras"></div><p class="gate-slogan">Da estratégia à execução</p>`;
const GOOGLE_SVG = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

function renderGateNuvem(modo = 'entrar', msg = '', ok = '') {
  gateModo = modo;
  document.body.classList.add('locked');
  const convite = sessionStorage.getItem('geplan:convite');
  const aviso = `${msg ? `<div class="gate-error">${esc(msg)}</div>` : ''}${ok ? `<div class="gate-ok">${esc(ok)}</div>` : ''}`;
  let corpo;
  if (modo === 'carregando') corpo = `<p class="gate-note">${esc(msg || 'Carregando…')}</p>`;
  else if (modo === 'empresa') {
    corpo = `<p class="gate-note" style="margin-top:0">Olá${sessaoAtual?.user?.email ? `, ${esc(sessaoAtual.user.email)}` : ''}! Para começar, crie a sua empresa ou use o convite que recebeu.</p>
      <form class="gate-form" data-gate="criarEmpresa"><input name="nome" placeholder="Nome da empresa (ou o seu nome, se for autônomo)" required minlength="2">
        <button class="gate-btn primary" type="submit">Criar empresa</button></form>
      <form class="gate-form" data-gate="convite"><input name="link" placeholder="Cole aqui o link do convite" required>
        <button class="gate-btn" type="submit">Usar convite</button></form>
      ${aviso}<p class="gate-note"><a href="#" data-gate-modo="sair">Sair</a></p>`;
  } else if (modo === 'novaSenha') {
    corpo = `<form class="gate-form" data-gate="novaSenha"><input type="password" name="senha" placeholder="Nova senha (mínimo 8 caracteres)" required minlength="8" autocomplete="new-password">
      <button class="gate-btn primary" type="submit">Salvar nova senha</button></form>${aviso}`;
  } else if (modo === 'recuperar') {
    corpo = `<form class="gate-form" data-gate="recuperar"><input type="email" name="email" placeholder="E-mail da conta" required autocomplete="email">
      <button class="gate-btn primary" type="submit">Enviar link para criar nova senha</button></form>${aviso}
      <p class="gate-note"><a href="#" data-gate-modo="entrar">Voltar para entrar</a></p>`;
  } else {
    const cad = modo === 'cadastro';
    corpo = `${convite ? `<div class="gate-ok">Você recebeu um convite. ${cad ? 'Crie a conta' : 'Entre'} com o e-mail convidado para aceitá-lo.</div>` : ''}
      <form class="gate-form" data-gate="${cad ? 'cadastro' : 'entrar'}">
        ${cad ? '<input name="nome" placeholder="Seu nome" required autocomplete="name">' : ''}
        <input type="email" name="email" placeholder="E-mail" required autocomplete="email">
        <input type="password" name="senha" placeholder="${cad ? 'Crie uma senha (mínimo 8 caracteres)' : 'Senha'}" required ${cad ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}>
        <button class="gate-btn primary" type="submit">${cad ? 'Criar conta' : 'Entrar'}</button>
      </form>
      <button class="gate-btn" type="button" data-gate-google>${GOOGLE_SVG} ${cad ? 'Criar conta' : 'Entrar'} com Google</button>
      ${aviso}
      <p class="gate-note">${cad ? '<a href="#" data-gate-modo="entrar">Já tenho conta</a>' : '<a href="#" data-gate-modo="cadastro">Criar conta</a> · <a href="#" data-gate-modo="recuperar">Esqueci a senha</a>'}</p>`;
  }
  document.getElementById('gate').innerHTML = `<div class="gate-card">${LOGO}${corpo}</div>`;
}

document.getElementById('gate').addEventListener('click', async (e) => {
  if (!NUVEM) return;
  const m = e.target.closest('[data-gate-modo]');
  if (m) {
    e.preventDefault();
    if (m.dataset.gateModo === 'sair') { await conta.sair().catch(() => {}); sessaoAtual = null; return renderGateNuvem('entrar'); }
    return renderGateNuvem(m.dataset.gateModo);
  }
  if (e.target.closest('[data-gate-google]')) {
    try { await conta.entrarComGoogle(); } catch (err) { renderGateNuvem(gateModo, err.message); }
  }
});
document.getElementById('gate').addEventListener('submit', async (e) => {
  if (!NUVEM) return;
  e.preventDefault();
  const f = e.target, tipo = f.dataset.gate, v = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (tipo === 'entrar') { sessaoAtual = await conta.entrar(v.email, v.senha); await entrarNaEmpresa(); }
    else if (tipo === 'cadastro') {
      const r = await conta.cadastrar(v.email, v.senha, v.nome);
      if (r.session) { sessaoAtual = r.session; await entrarNaEmpresa(); }
      else renderGateNuvem('entrar', '', `Enviamos um link de confirmação para ${v.email}. Abra o link e depois entre aqui.`);
    } else if (tipo === 'recuperar') {
      await conta.recuperarSenha(v.email);
      renderGateNuvem('entrar', '', 'Se o e-mail tiver cadastro, você vai receber um link para criar uma nova senha.');
    } else if (tipo === 'novaSenha') {
      await conta.novaSenha(v.senha); toast('Senha alterada.');
      sessaoAtual = await conta.sessao(); await entrarNaEmpresa();
    } else if (tipo === 'criarEmpresa') {
      const id = await conta.criarEmpresa(v.nome); await entrarNaEmpresa(id);
    } else if (tipo === 'convite') {
      const token = String(v.link).trim().split('/').pop();
      const id = await conta.aceitarConvite(token); toast('Convite aceito.'); await entrarNaEmpresa(id);
    }
  } catch (err) {
    renderGateNuvem(gateModo, err.message);
  }
});

/** Depois do login: aceita convite pendente, escolhe a empresa e carrega os dados dela. */
async function entrarNaEmpresa(orgPreferida = null) {
  sessaoAtual ||= await conta.sessao();
  if (!sessaoAtual) return renderGateNuvem('entrar');
  const user = sessaoAtual.user;
  const email = (user.email || '').toLowerCase();
  let msg = '';
  const convite = sessionStorage.getItem('geplan:convite');
  if (convite) {
    sessionStorage.removeItem('geplan:convite');
    try { orgPreferida = await conta.aceitarConvite(convite); toast('Convite aceito.'); } catch (e) { msg = e.message; }
  }
  let empresas, ultima = null;
  try {
    empresas = await conta.minhasEmpresas();
    ultima = (await conta.perfil(user.id).catch(() => null))?.last_org_id;
  } catch (e) {
    // sem internet: continua com a última empresa usada neste aparelho
    const salvo = nuvem.contextoSalvo();
    if (salvo?.userId === user.id) empresas = [{ org_id: salvo.orgId, name: salvo.orgNome, role: salvo.papel }];
    else return renderGateNuvem('entrar', e.message);
  }
  if (!empresas.length) return renderGateNuvem('empresa', msg);
  const org = empresas.find((x) => x.org_id === orgPreferida) || empresas.find((x) => x.org_id === ultima) || empresas[0];
  // outra conta usou este aparelho antes: não misturar os dados
  if (store.meta.owner && store.meta.owner !== email) { nuvem.encerrar(); store.clearLocal(); }
  store.meta.owner = email; store.saveMeta();
  authorized = true;
  limparEmpresa();
  document.body.classList.remove('locked');
  render();
  try {
    await nuvem.iniciar({ userId: user.id, email, orgId: org.org_id, orgNome: org.name, papel: org.role });
    conta.lembrarEmpresa(user.id, org.org_id).catch(() => {});
  } catch (e) { toast(`Não foi possível carregar os dados da empresa: ${e.message}. Mostrando a cópia deste aparelho.`, 6000); }
  if (msg) toast(msg, 6000);
  render();
}

async function sairNuvem() {
  if (nuvem.pendente()) await nuvem.enviar().catch(() => {});
  if (nuvem.pendente() && !(await ask('Há alterações que ainda NÃO foram enviadas para a nuvem e serão perdidas. Sair mesmo assim?', 'Sair'))) return;
  await conta.sair().catch(() => {});
  nuvem.encerrar(); store.clearLocal(); limparEmpresa(); limparFornecedores();
  sessaoAtual = null; authorized = false;
  location.hash = '#/inicio';
  renderGateNuvem('entrar');
}
window.addEventListener('geplan:sair', () => sairNuvem().catch((e) => toast(e.message)));
window.addEventListener('geplan:aviso', (e) => toast(e.detail, 7000));
window.addEventListener('geplan:trocar-empresa', async (e) => {
  await nuvem.enviar().catch(() => {});
  if (nuvem.pendente() && !(await ask('Há alterações não enviadas nesta empresa. Trocar mesmo assim (elas serão perdidas)?', 'Trocar'))) return queueRender();
  nuvem.encerrar(); store.clearLocal(); limparFornecedores();
  location.hash = '#/inicio';
  await entrarNaEmpresa(e.detail);
});

/* ---------- rotas ---------- */
let ultimoHash = '';
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'convite' && parts[1]) return { name: 'convite', token: parts[1] };
  if (parts[0] === 'obra' && parts[1]) return { name: 'obra', id: parts[1], tab: parts[2] || 'painel', sub: parts[3] || '' };
  if (parts[0] === 'fases') return { name: 'fases', id: parts[1] };
  if (parts[0] === 'modulo' && parts[1]) return { name: 'modulo', modulo: parts[1] };
  if (parts[0] === 'fornecedores') return parts[1] ? { name: 'fornecedor', id: parts[1] } : { name: 'fornecedores' };
  if (['obras', 'composicoes', 'drive', 'importar', 'sinapi', 'pendencias', 'inicio', 'configuracoes'].includes(parts[0])) return { name: parts[0] };
  return { name: 'inicio' };   // página inicial: Visão geral
}

function render() {
  const route = parseRoute();
  if (route.name === 'convite') {
    if (!NUVEM) { location.hash = '#/inicio'; return; }
    sessionStorage.setItem('geplan:convite', route.token);
    history.replaceState(null, '', location.pathname + location.search + '#/inicio');
    if (authorized) { entrarNaEmpresa().catch((e) => toast(e.message)); return; }
    return renderGateNuvem(gateModo === 'carregando' ? 'carregando' : 'entrar');
  }
  if (!authorized) return renderGate();
  document.body.classList.remove('locked');
  const ae = document.activeElement;
  const focusKey = ui.pendingFocus || (ae && $view.contains(ae) ? ae.dataset.key : null);
  const sel = ae && ae.dataset?.key === focusKey && 'selectionStart' in ae ? (() => { try { return [ae.selectionStart, ae.selectionEnd]; } catch { return null; } })() : null;
  const scrollGantt = document.getElementById('gantt')?.scrollLeft;
  const scrollTree = document.querySelector('.tree-wrap')?.scrollLeft;

  // módulos por obra: com uma obra só, abre direto nela
  if (route.name === 'modulo' && MODULOS[route.modulo]) {
    const unica = obraUnica();
    if (unica) { history.replaceState(null, '', location.pathname + location.search + linkModulo(unica, MODULOS[route.modulo])); return render(); }
  }
  if (route.name === 'obra') { try { localStorage.setItem('planobras:ultimaObra', route.id); } catch {} }
  renderMenu(route);
  document.body.classList.remove('menu-aberto');

  let html;
  if (route.name === 'inicio') html = viewInicio();
  else if (route.name === 'pendencias') html = viewPendencias();
  else if (route.name === 'configuracoes') html = viewConfiguracoes();
  else if (route.name === 'fornecedores') html = viewFornecedores();
  else if (route.name === 'fornecedor') html = viewFornecedor(route);
  else if (route.name === 'modulo') html = viewModulo(route, resumoDe);
  else if (route.name === 'obra') html = viewObra(route);
  else if (route.name === 'composicoes') html = viewComposicoes();
  else if (route.name === 'sinapi') html = viewSinapi();
  else if (route.name === 'fases') html = viewFases(route);
  else if (route.name === 'importar') html = viewImportar();
  else if (route.name === 'drive') html = NUVEM ? viewEmpresa() : viewDrive();
  else html = viewObras();
  $view.innerHTML = html;

  // "Compras e materiais" abre o Financeiro da obra já na seção de pedidos (só ao chegar na rota)
  if (route.sub === 'compras' && ultimoHash !== location.hash) setTimeout(() => document.getElementById('secao-compras')?.scrollIntoView({ block: 'start' }));
  ultimoHash = location.hash;
  if (focusKey) {
    const el = $view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus({ preventScroll: !ui.pendingFocus });
      if (ui.pendingFocus && el.select) el.select();
      else if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
    }
    ui.pendingFocus = null;
  }
  const tw = document.querySelector('.tree-wrap');
  if (tw && scrollTree) tw.scrollLeft = scrollTree;
  if (route.name === 'obra') depoisObra(route, scrollGantt);
  if (route.name === 'sinapi') depoisSinapi();
}
setRenderer(render);

/* ---------- Google Drive ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

function viewDrive() {
  const connected = drive.isConnected();
  const st = drive.status;
  const user = st.user || drive.savedUser();
  const last = store.meta.lastSync ? new Date(store.meta.lastSync).toLocaleString('pt-BR') : 'nunca';
  const origin = location.origin;
  return `<div class="page-head"><div><h1>Google Drive</h1><div class="muted">Armazenamento principal das suas obras</div></div></div>
  <div class="stack" style="max-width:820px">
    <div class="card card-pad stack">
      <div class="row between"><h2>Conta e conexão</h2><span class="badge ${connected ? (st.state === 'ok' ? 'good' : st.state === 'error' || st.state === 'auth' ? 'crit' : 'warn') : ''}">${connected ? esc(st.message || 'Conectado') : 'Não conectado'}</span></div>
      <div>${user ? `Conta: <b>${esc(user.displayName || '')}</b> ${esc(user.emailAddress || '')}<br>` : ''}Pasta no Drive: <b>Meu Drive › GEPLAN - Planejamento de Obras</b><br><span class="muted small">Última sincronização: ${last}</span></div>
      <div class="row"><button class="btn primary" data-act="syncNow">Sincronizar agora</button><button class="btn danger" data-act="logout">Sair</button></div>
      <div class="muted small">Ao sair, os dados deste aparelho são apagados (eles continuam no seu Google Drive). Use "Sair" em computadores ou celulares de outras pessoas.</div>
    </div>
    <details class="card card-pad">
      <summary style="cursor:pointer;font-weight:600">Autorizar outra pessoa</summary>
      <div class="stack" style="margin-top:12px">
        <p class="muted small" style="margin:0">1) Digite o e-mail Google da pessoa e gere o código. 2) Mande o código para quem mantém o site, para incluir em <code class="k">js/config.js</code>. 3) Adicione o mesmo e-mail em Google Cloud › Google Auth Platform › Público-alvo › <b>Usuários de teste</b>.</p>
        <div class="row"><input id="accessEmail" type="email" placeholder="email@gmail.com" style="flex:1;min-width:200px" data-enter="genAccessCode"><button class="btn" data-act="genAccessCode">Gerar código de acesso</button></div>
        <div id="accessCode"></div>
        <p class="muted small" style="margin:0">Cada pessoa usa o próprio Google Drive: ela não vê as suas obras.</p>
      </div>
    </details>
    <details class="card card-pad" ${drive.clientId() ? '' : 'open'}>
      <summary style="cursor:pointer;font-weight:600">Configuração do Google (Client ID)</summary>
      <div class="stack" style="margin-top:12px">
        <label class="field">Client ID OAuth<input id="clientId" value="${esc(drive.clientId())}" placeholder="0000000000-xxxxxxxx.apps.googleusercontent.com"></label>
        <div><button class="btn" data-act="saveClientId">Salvar Client ID</button></div>
        <p class="small muted" style="margin:0">Origem deste endereço: <code class="k">${esc(origin)}</code> (precisa estar em "Origens JavaScript autorizadas" no Google Cloud).</p>
      </div>
    </details>
    <div class="card card-pad stack">
      <h2>Backup</h2>
      <p class="muted" style="margin:0">Cópia de segurança de todas as obras e da biblioteca (composições, feriados gerais e modelos de EAP) em um arquivo.</p>
      <div class="row"><button class="btn" data-act="backupExport">Baixar backup (.json)</button>
        <label class="btn">Restaurar backup<input type="file" accept="application/json,.json" data-chg="backupImport" hidden></label></div>
    </div>
    ${installPrompt ? `<div class="card card-pad row between"><div><h2>Instalar como aplicativo</h2><div class="muted small">Abre em tela cheia e funciona sem internet.</div></div><button class="btn primary" data-act="install">Instalar</button></div>` : ''}
  </div>`;
}

const acoesGerais = {
  async syncNow() { await drive.sync({ interactive: true }).catch((e) => toast(e.message)); render(); },
  async logout() {
    if (store.hasPending() && navigator.onLine) await drive.sync().catch(() => {});
    const msg = store.hasPending()
      ? 'Há alterações que ainda NÃO foram enviadas ao Google Drive e serão perdidas. Sair mesmo assim?'
      : 'Sair do GEPLAN neste aparelho? Seus dados continuam salvos no Google Drive.';
    if (!(await ask(msg, 'Sair'))) return;
    drive.disconnect();
    store.clearLocal();
    authorized = false;
    location.hash = '#/inicio';
    render();
  },
  async genAccessCode() {
    const email = document.getElementById('accessEmail').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Digite um e-mail válido.');
    const code = await sha256(email);
    document.getElementById('accessCode').innerHTML = `<div class="alert info small">Código de acesso de <b>${esc(email)}</b>:<br><code class="k" style="word-break:break-all;user-select:all">${code}</code></div>`;
  },
  saveClientId() { drive.setClientId(document.getElementById('clientId').value); toast('Client ID salvo.'); render(); },
  backupExport() {
    const blob = new Blob([store.exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-geplan-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  async install() { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); },
};
const mudancasGerais = {
  async backupImport(d, el) {
    const f = el.files[0];
    if (!f) return;
    if (!(await ask('Restaurar este backup? Os dados atuais neste aparelho serão substituídos.', 'Restaurar'))) { el.value = ''; return; }
    f.text().then((t) => { store.importAll(t); toast('Backup restaurado.'); render(); }).catch((e) => toast('Erro: ' + e.message));
  },
};

/* ---------- eventos ---------- */
const acoes = { ...acoesGerais, ...acoesBiblioteca, ...acoesObra, ...acoesFases, ...acoesSinapi, ...acoesGestao, ...acoesEmpresa, ...acoesFornecedores };
const mudancas = { ...mudancasGerais, ...mudancasBiblioteca, ...mudancasObra, ...mudancasFases, ...mudancasSinapi, ...mudancasGestao, ...mudancasEmpresa, ...mudancasInicio, ...mudancasFornecedores };
const entradas = { ...entradasBiblioteca, ...entradasObra, ...entradasFases, ...entradasSinapi, ...entradasInicio, ...entradasFornecedores };

$view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = acoes[el.dataset.act];
  if (!a) return;
  if (el.tagName !== 'A' || el.getAttribute('href') === '#') e.preventDefault();
  Promise.resolve(a(el.dataset, el, e)).catch((err) => toast(err.message || String(err), 5000));
});
$view.addEventListener('change', (e) => {
  const el = e.target.closest('[data-chg]');
  if (!el) return;
  Promise.resolve(mudancas[el.dataset.chg]?.(el.dataset, el)).catch((err) => toast(err.message || String(err), 5000));
});
let inputTimer = null;
$view.addEventListener('input', (e) => {
  const el = e.target.closest('[data-inp]');
  if (!el) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => entradas[el.dataset.inp]?.(el), 180);
});
$view.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter]');
  if (el) { e.preventDefault(); acoes[el.dataset.enter]?.(el.dataset, el); }
  else if (e.target.matches('input.cell[data-chg]')) e.target.blur();
});

/* ---------- indicador de sincronização ---------- */
function renderSync() {
  if (NUVEM) {
    const st = nuvem.status;
    const map = {
      local: ['', 'Não conectado'], busy: ['busy', 'Sincronizando…'], ok: ['ok', 'Salvo na nuvem'],
      pending: ['pending', 'Enviando…'], offline: ['pending', 'Offline'], error: ['err', 'Erro ao salvar'],
    };
    const [cls, label] = map[st.state] || map.local;
    $sync.className = `sync ${cls}`;
    // a hora só aparece depois que o banco confirmou a gravação (ou a leitura) — não é estimada
    const conf = nuvem.ultimaConfirmacao();
    $sync.title = [st.message, conf ? `Última confirmação do servidor: ${new Date(conf).toLocaleString('pt-BR')}` : 'Ainda sem confirmação do servidor nesta sessão'].filter(Boolean).join(' · ');
    $sync.innerHTML = `<span class="dot"></span>${label}`;
    return;
  }
  const st = drive.status;
  const map = {
    local: ['', 'Só neste aparelho'], busy: ['busy', 'Sincronizando…'], ok: ['ok', 'Salvo no Drive'],
    pending: ['pending', 'Enviando…'], offline: ['pending', 'Offline'], auth: ['err', 'Reconectar Drive'], error: ['err', 'Erro no Drive'],
  };
  const [cls, label] = map[st.state] || map.local;
  $sync.className = `sync ${cls}`;
  $sync.title = st.message || (st.state === 'local' ? 'Conecte o Google Drive para salvar na nuvem' : '');
  $sync.innerHTML = `<span class="dot"></span>${label}`;
}
$sync.addEventListener('click', async (e) => {
  if (NUVEM) return;
  if (drive.status.state === 'auth') {
    e.preventDefault();
    try { await drive.sync({ interactive: true }); } catch (err) { toast(err.message); }
  }
});

drive.onStatus(() => { renderSync(); if (parseRoute().name === 'drive') queueRender(); });
nuvem.onStatus(() => { renderSync(); if (parseRoute().name === 'drive') queueRender(); });
window.addEventListener('planobras:remote-change', () => { queueRender(); if (!NUVEM) toast('Dados atualizados a partir do Google Drive.'); });
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// Menu completo no celular: o botão "Menu" do rodapé abre o menu lateral por cima da tela.
document.getElementById('bottomnav').addEventListener('click', (e) => {
  if (!e.target.closest('[data-menu-celular]')) return;
  e.preventDefault();
  document.body.classList.toggle('menu-aberto');
});
document.getElementById('menuFundo').addEventListener('click', () => document.body.classList.remove('menu-aberto'));
document.getElementById('sidenav').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('menu-aberto'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('menu-aberto'); });

/** Início no modo nuvem: retoma a sessão salva (ou mostra o login). */
async function iniciarNuvem() {
  renderGateNuvem('carregando', 'Conectando…');
  renderSync();
  try {
    await conta.aoMudarSessao((evento) => { if (evento === 'PASSWORD_RECOVERY') { authorized = false; renderGateNuvem('novaSenha', '', 'Crie a nova senha.'); } });
    sessaoAtual = await conta.sessao();
  } catch (e) { sessaoAtual = null; renderGateNuvem('entrar', e.message); return; }
  // remove o código de login da barra de endereço (retorno do Google ou do e-mail)
  const recuperando = new URLSearchParams(location.search).has('recuperar');
  if (/[?&](code|error|recuperar)=?/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
  if (recuperando && sessaoAtual) return renderGateNuvem('novaSenha', '', 'Crie a nova senha.');
  if (gateModo === 'novaSenha') return;
  if (!sessaoAtual) return renderGateNuvem(parseRoute().name === 'convite' ? 'cadastro' : 'entrar');
  await entrarNaEmpresa();
}

// Início: entra direto se esta conta já fez login neste aparelho e está autorizada
(async () => {
  if (NUVEM) {
    if (parseRoute().name === 'convite') { sessionStorage.setItem('geplan:convite', parseRoute().token); history.replaceState(null, '', location.pathname + location.search + '#/inicio'); }
    return iniciarNuvem().catch((e) => renderGateNuvem('entrar', e.message));
  }
  const u = drive.savedUser();
  authorized = drive.isConnected() && (await isAllowed(u?.emailAddress));
  if (!authorized && drive.isConnected()) { drive.disconnect(); store.clearLocal(); }
  if (authorized && !store.meta.owner) { store.meta.owner = u.emailAddress.toLowerCase(); store.saveMeta(); }
  render();
  renderSync();
  if (authorized) drive.init();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
