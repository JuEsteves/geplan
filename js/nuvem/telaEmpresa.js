// Tela "Empresa" do modo nuvem: conta, empresa, sincronização, membros e convites, acesso às obras,
// plano e uso. Tudo que é gravado passa pelas regras do banco (RLS); a tela só reflete o que o banco permite.
import * as store from '../store.js';
import * as conta from './conta.js';
import * as nuvem from './nuvem.js';
import { esc, toast, ask, formDialog, info, queueRender } from '../ui.js';
import { LIBERACOES, LIBERACOES_PADRAO, liberacoesDe } from '../liberacoes.js';
import { enviarArquivo, urlTemporaria, validarArquivo, TIPOS_IMAGEM } from './arquivos.js';
import { carregarDiarioNuvem } from '../diario.js';

export const PAPEIS = {
  admin: 'Administrador da empresa', engenheiro: 'Engenheiro responsável', supervisor: 'Supervisor de obra',
  financeiro: 'Financeiro', compras: 'Compras', cliente: 'Cliente (só consulta)',
};
const RESTRITOS = ['supervisor', 'financeiro', 'compras', 'cliente'];   // veem só as obras em que foram incluídos
const STATUS_ASS = { trialing: 'Em avaliação', active: 'Ativa', past_due: 'Pagamento pendente', unpaid: 'Inadimplente', canceled: 'Cancelada', expired: 'Expirada' };
const fmtBRL = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const dados = { carregando: false, erro: '', membros: [], convites: [], uso: null, planos: [], equipes: {}, empresas: [], linkNovo: '' };

export async function carregarEmpresa() {
  const ctx = nuvem.contexto();
  if (!ctx || dados.carregando) return;
  dados.carregando = true; dados.erro = '';
  queueRender();
  try {
    const admin = ctx.papel === 'admin';
    const [membros, convites, plano, empresas] = await Promise.all([
      conta.membros(ctx.orgId), admin ? conta.convites(ctx.orgId) : [], conta.usoDoPlano(ctx.orgId), conta.minhasEmpresas(),
    ]);
    Object.assign(dados, { membros, convites, uso: plano.uso, planos: plano.planos, empresas });
    dados.logo = (await conta.logoDaEmpresa(ctx.orgId).catch(() => '')) || '';
    dados.logoUrl = dados.logo ? await urlTemporaria(dados.logo, 3600).catch(() => '') : '';
    if (['admin', 'engenheiro'].includes(ctx.papel)) {
      const eq = await Promise.all(store.obras().map(async (o) => [o.id, await conta.equipeDaObra(o.id)]));
      dados.equipes = Object.fromEntries(eq);
    }
  } catch (e) { dados.erro = e.message; }
  dados.carregando = false;
  dados.carregado = true;
  queueRender();
}

export function viewEmpresa() {
  const ctx = nuvem.contexto();
  if (!ctx) return '<div class="card empty"><p>Entre para ver a empresa.</p></div>';
  if (!dados.carregado && !dados.carregando) setTimeout(carregarEmpresa);
  const admin = ctx.papel === 'admin', gestor = ['admin', 'engenheiro'].includes(ctx.papel);
  const st = nuvem.status;
  const u = dados.uso;
  const lim = (usado, max) => `${usado ?? '—'}${max == null ? ' (sem limite)' : ` de ${max}`}`;
  const anteriores = nuvem.dadosAnteriores();
  const obras = store.obras();
  const restritos = dados.membros.filter((m) => RESTRITOS.includes(m.role));

  return `<div class="page-head"><div><h1>Empresa</h1><div class="muted">${esc(ctx.orgNome)} · ${esc(PAPEIS[ctx.papel] || ctx.papel)}</div></div></div>
  <div class="stack" style="max-width:900px">
    ${dados.erro ? `<div class="alert err">${esc(dados.erro)}</div>` : ''}
    <div class="card card-pad stack">
      <div class="row between"><h2>Conta e sincronização</h2><span class="badge ${st.state === 'ok' ? 'good' : st.state === 'error' ? 'crit' : 'warn'}">${esc(st.message || st.state)}</span></div>
      <div>Usuário: <b>${esc(ctx.email)}</b><br><span class="muted small">Os dados ficam no banco da empresa (Supabase) e uma cópia de trabalho neste aparelho, para funcionar sem internet.</span></div>
      <div class="row">
        <button class="btn primary" data-act="nuvemSincronizar">Sincronizar agora</button>
        <button class="btn" data-act="nuvemTrocarSenha">Trocar senha</button>
        ${dados.empresas.length > 1 ? `<select data-chg="nuvemTrocarEmpresa" style="width:auto">${dados.empresas.map((e) => `<option value="${e.org_id}" ${e.org_id === ctx.orgId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>` : ''}
        <button class="btn" data-act="nuvemNovaEmpresa">Criar outra empresa</button>
        <button class="btn danger" data-act="nuvemSair">Sair</button>
      </div>
    </div>

    ${anteriores && !nuvem.dadosAnterioresEnviados() && gestor ? `<div class="card card-pad stack">
      <h2>Dados que estavam neste aparelho</h2>
      <p class="muted" style="margin:0">Antes de entrar na nuvem, este aparelho tinha <b>${anteriores.obras.length}</b> obra(s) (modo Google Drive). Elas foram guardadas e <b>não</b> estão na empresa ainda.</p>
      <div class="row"><button class="btn primary" data-act="nuvemEnviarAnteriores">Enviar para a empresa</button></div>
    </div>` : ''}

    <div class="card card-pad stack">
      <div class="row between"><h2>Plano e uso</h2>${u?.status ? `<span class="badge ${u.status === 'active' || u.status === 'trialing' ? 'good' : 'crit'}">${esc(STATUS_ASS[u.status] || u.status)}</span>` : ''}</div>
      ${u ? `<div class="grid-2">
        <div>Plano: <b>${esc(dados.planos.find((p) => p.id === u.plan_id)?.name || u.plan_id || '—')}</b>${u.status === 'trialing' ? `<div class="muted small">${u.trial_ends_at ? `Avaliação até ${new Date(u.trial_ends_at).toLocaleDateString('pt-BR')}` : 'Avaliação (fase piloto, sem cobrança)'}</div>` : ''}</div>
        <div>Obras: <b>${lim(u.projects_used, u.max_projects)}</b><br>Usuários: <b>${lim(u.users_used, u.max_users)}</b></div>
      </div>` : `<div class="muted small">${dados.carregando ? 'Carregando…' : 'Somente o administrador vê os dados da assinatura.'}</div>`}
      ${dados.planos.length ? `<details><summary style="cursor:pointer">Planos disponíveis</summary><div class="table-wrap"><table class="data">
        <thead><tr><th>Plano</th><th class="num">Preço</th><th class="num">Obras</th><th class="num">Usuários</th><th class="num">Armazenamento</th></tr></thead>
        <tbody>${dados.planos.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtBRL(p.price)}/${p.billing_period === 'anual' ? 'ano' : 'mês'}</td><td class="num">${p.max_projects ?? 'sem limite'}</td><td class="num">${p.max_users ?? 'sem limite'}</td><td class="num">${p.max_storage_mb ? (p.max_storage_mb / 1024).toLocaleString('pt-BR') + ' GB' : '—'}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">Valores de referência. A contratação e o pagamento on-line ainda não estão disponíveis.</p></details>` : ''}
    </div>

    <div class="card card-pad stack">
      <div class="row between"><h2>Pessoas da empresa</h2>${admin ? '<button class="btn primary sm" data-act="nuvemConvidar">Convidar pessoa</button>' : ''}</div>
      ${dados.linkNovo ? `<div class="alert info small">Envie este link para a pessoa (vale 7 dias e só funciona com o e-mail convidado):<br><code class="k" style="word-break:break-all;user-select:all">${esc(dados.linkNovo)}</code></div>` : ''}
      <div class="table-wrap"><table class="data"><thead><tr><th>Pessoa</th><th>Perfil</th><th></th></tr></thead><tbody>
      ${dados.membros.map((m) => `<tr><td>${esc(m.nome || m.email)}<div class="muted small">${esc(m.email)}</div></td>
        <td>${admin && m.user_id !== ctx.userId ? `<select data-chg="nuvemPapel" data-id="${m.user_id}" style="width:auto">${Object.entries(PAPEIS).map(([k, v]) => `<option value="${k}" ${k === m.role ? 'selected' : ''}>${v}</option>`).join('')}</select>` : esc(PAPEIS[m.role] || m.role)}</td>
        <td>${admin && m.user_id !== ctx.userId ? `<button class="btn sm danger" data-act="nuvemRemoverMembro" data-id="${m.user_id}">Remover</button>` : m.user_id === ctx.userId ? '<span class="muted small">você</span>' : ''}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">${dados.carregando ? 'Carregando…' : 'Ninguém.'}</td></tr>`}
      </tbody></table></div>
      ${admin && dados.convites.length ? `<div><b class="small">Convites pendentes</b>${dados.convites.map((c) => `<div class="row small" style="margin-top:6px"><span style="flex:1">${esc(c.email)} · ${esc(PAPEIS[c.role] || c.role)} · até ${new Date(c.expires_at).toLocaleDateString('pt-BR')}</span>
        <button class="btn sm" data-act="nuvemCopiarConvite" data-token="${esc(c.token)}">Copiar link</button><button class="btn sm danger" data-act="nuvemRevogar" data-id="${c.id}">Cancelar</button></div>`).join('')}</div>` : ''}
      <p class="muted small" style="margin:0">Administrador e engenheiro veem todas as obras. Supervisor, financeiro, compras e cliente veem só as obras em que forem incluídos (abaixo). As permissões são conferidas pelo banco, não apenas pela tela.</p>
    </div>

    ${dados.membros.length ? `<div class="card card-pad stack">
      <h2>Liberações por pessoa</h2>
      <p class="muted small" style="margin:0">O que cada pessoa pode fazer em Suprimentos e no cadastro de fornecedores. Sem alteração, vale o padrão do perfil. O administrador tem todas; o cliente, nenhuma. Quem decide é o banco: a pessoa sem a liberação não consegue gravar, mesmo tentando por fora da tela.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Pessoa</th>${LIBERACOES.map((l) => `<th class="small" title="${esc(l.texto)}">${esc(l.rotulo)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${dados.membros.map((m) => {
        const efetivas = liberacoesDe(m.role, m.permissions);
        const fixo = !admin || ['admin', 'cliente'].includes(m.role);
        return `<tr><td>${esc(m.nome || m.email)}<div class="muted small">${esc(PAPEIS[m.role] || m.role)}</div></td>
          ${LIBERACOES.map((l) => `<td><input type="checkbox" aria-label="${esc(l.rotulo)} — ${esc(m.nome || m.email)}" data-chg="nuvemLiberacao" data-id="${m.user_id}" data-lib="${l.id}" ${efetivas.includes(l.id) ? 'checked' : ''} ${fixo ? 'disabled' : ''}></td>`).join('')}
          <td class="small">${m.permissions ? `<span class="badge info">personalizado</span>${admin ? ` <button class="btn sm" data-act="nuvemLiberacaoPadrao" data-id="${m.user_id}">Voltar ao padrão</button>` : ''}` : '<span class="muted">padrão do perfil</span>'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="muted small" style="margin:0">Trocar o perfil de uma pessoa volta as liberações dela ao padrão do novo perfil. A pessoa vê a mudança na próxima sincronização (até 2 minutos) ou ao recarregar.</p>
    </div>` : ''}

    <div class="card card-pad stack">
      <h2>Logo da empresa</h2>
      <p class="muted small" style="margin:0">Aparece no cabeçalho do RDO e no PDF. PNG, JPG ou WEBP até 2 MB.</p>
      ${dados.logoUrl ? `<img class="logo-previa" src="${esc(dados.logoUrl)}" alt="Logo da empresa">` : `<div class="muted small">${dados.logo ? 'Carregando…' : 'Nenhum logo enviado.'}</div>`}
      ${admin ? `<div class="row"><label class="btn">${dados.logo ? 'Trocar logo' : 'Enviar logo'}<input type="file" accept="image/png,image/jpeg,image/webp" data-chg="nuvemLogo" hidden></label>${dados.logo ? '<button class="btn" data-act="nuvemLogoRemover">Remover</button>' : ''}</div>` : '<div class="muted small">Só o administrador altera o logo.</div>'}
    </div>

    <div class="card card-pad stack">
      <h2>Exportar dados</h2>
      <p class="muted" style="margin:0">Cópia das obras que você pode ver e da biblioteca da empresa, em um arquivo JSON (portabilidade e backup pessoal). O backup oficial é o do banco (veja supabase/README.md).</p>
      <div class="row"><button class="btn" data-act="backupExport">Baixar dados (.json)</button></div>
    </div>

    ${gestor && restritos.length && obras.length ? `<div class="card card-pad stack">
      <h2>Acesso às obras</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>Pessoa</th>${obras.map((o) => `<th class="small">${esc(o.nome)}</th>`).join('')}</tr></thead><tbody>
      ${restritos.map((m) => `<tr><td>${esc(m.nome || m.email)}<div class="muted small">${esc(PAPEIS[m.role])}</div></td>${obras.map((o) => {
        const tem = (dados.equipes[o.id] || []).some((x) => x.user_id === m.user_id);
        return `<td><input type="checkbox" data-chg="nuvemAcessoObra" data-obra="${o.id}" data-id="${m.user_id}" ${tem ? 'checked' : ''}></td>`;
      }).join('')}</tr>`).join('')}
      </tbody></table></div>
    </div>` : ''}
  </div>`;
}

export const acoesEmpresa = {
  async nuvemSincronizar() { await nuvem.enviar(); await nuvem.baixar(); toast('Sincronizado.'); },
  async nuvemTrocarSenha() {
    const v = await formDialog({ title: 'Trocar senha', ok: 'Salvar', fields: [{ name: 's', label: 'Nova senha (mínimo 8 caracteres)', type: 'password', required: true }] });
    if (!v) return;
    await conta.novaSenha(v.s); toast('Senha alterada.');
  },
  async nuvemNovaEmpresa() {
    const v = await formDialog({ title: 'Criar outra empresa', ok: 'Criar', fields: [{ name: 'n', label: 'Nome da empresa', required: true }] });
    if (!v) return;
    const id = await conta.criarEmpresa(v.n);
    window.dispatchEvent(new CustomEvent('geplan:trocar-empresa', { detail: id }));
  },
  async nuvemSair() { window.dispatchEvent(new Event('geplan:sair')); },
  async nuvemEnviarAnteriores() {
    if (!(await ask('Enviar as obras que estavam neste aparelho para a empresa? Composições e modelos também entram na biblioteca da empresa (os que já existem não são alterados).', 'Enviar'))) return;
    const n = await nuvem.enviarDadosAnteriores();
    toast(`${n} obra(s) enviada(s).`); dados.carregado = false; queueRender();
  },
  async nuvemConvidar() {
    const ctx = nuvem.contexto();
    const v = await formDialog({ title: 'Convidar pessoa', ok: 'Gerar convite', text: 'A pessoa cria a conta (ou entra) com este e-mail e abre o link do convite.', fields: [
      { name: 'email', label: 'E-mail', type: 'email', required: true },
      { name: 'papel', label: 'Perfil', type: 'select', value: 'engenheiro', options: Object.entries(PAPEIS).map(([value, label]) => ({ value, label })) },
    ] });
    if (!v) return;
    dados.linkNovo = await conta.convidar(ctx.orgId, ctx.userId, v.email, v.papel);
    try { await navigator.clipboard.writeText(dados.linkNovo); toast('Link do convite copiado.'); } catch {}
    dados.carregado = false; queueRender();
  },
  async nuvemCopiarConvite(d) {
    const link = conta.linkConvite(d.token);
    try { await navigator.clipboard.writeText(link); toast('Link copiado.'); } catch { info('Link do convite', `<code class="k" style="word-break:break-all;user-select:all">${esc(link)}</code>`); }
  },
  async nuvemLogoRemover() {
    if (!(await ask('Remover o logo dos relatórios? (O arquivo continua guardado.)', 'Remover'))) return;
    await conta.definirLogo(nuvem.contexto().orgId, '');
    carregarDiarioNuvem(true).catch(() => {});
    toast('Logo removido.'); dados.carregado = false; queueRender();
  },
  async nuvemLiberacaoPadrao(d) {
    await conta.definirLiberacoes(nuvem.contexto().orgId, d.id, null);
    toast('Liberações de volta ao padrão do perfil.'); dados.carregado = false; queueRender();
  },
  async nuvemRevogar(d) { await conta.revogarConvite(d.id); dados.carregado = false; queueRender(); },
  async nuvemRemoverMembro(d) {
    const m = dados.membros.find((x) => x.user_id === d.id);
    if (!(await ask(`Remover ${m?.email || 'esta pessoa'} da empresa? Ela perde o acesso a todas as obras.`, 'Remover'))) return;
    await conta.removerMembro(nuvem.contexto().orgId, d.id); dados.carregado = false; queueRender();
  },
};

export const mudancasEmpresa = {
  async nuvemPapel(d, el) {
    await conta.mudarPapel(nuvem.contexto().orgId, d.id, el.value).catch((e) => { dados.carregado = false; queueRender(); throw e; });
    toast('Perfil alterado.'); dados.carregado = false; queueRender();
  },
  async nuvemLogo(d, el) {
    const f = el.files[0];
    if (!f) return;
    try {
      validarArquivo(f, 2 * 1024 * 1024, TIPOS_IMAGEM);
      const org = nuvem.contexto().orgId;
      const caminho = await enviarArquivo(org, 'empresa', 'logo', f, 2 * 1024 * 1024, TIPOS_IMAGEM);
      await conta.definirLogo(org, caminho);
      carregarDiarioNuvem(true).catch(() => {});   // o RDO passa a mostrar o logo novo
      toast('Logo atualizado.'); dados.carregado = false; queueRender();
    } catch (e) { el.value = ''; throw e; }
  },
  async nuvemLiberacao(d, el) {
    const m = dados.membros.find((x) => x.user_id === d.id);
    const atual = new Set(liberacoesDe(m.role, m.permissions));
    if (el.checked) atual.add(d.lib); else atual.delete(d.lib);
    const ids = LIBERACOES.map((l) => l.id).filter((k) => atual.has(k));
    const padrao = LIBERACOES.map((l) => l.id).filter((k) => (LIBERACOES_PADRAO[m.role] || []).includes(k));
    const nova = ids.join() === padrao.join() ? null : ids;   // igual ao padrão: volta a acompanhar o perfil
    try { await conta.definirLiberacoes(nuvem.contexto().orgId, d.id, nova); }
    catch (e) { el.checked = !el.checked; throw e; }
    m.permissions = nova;
    toast('Liberação alterada.'); queueRender();
  },
  async nuvemAcessoObra(d, el) {
    try {
      if (el.checked) await conta.incluirNaObra(d.obra, d.id); else await conta.tirarDaObra(d.obra, d.id);
      toast(el.checked ? 'Acesso liberado.' : 'Acesso retirado.');
    } catch (e) { el.checked = !el.checked; throw e; }
    dados.equipes[d.obra] = await conta.equipeDaObra(d.obra);
  },
  nuvemTrocarEmpresa(d, el) { window.dispatchEvent(new CustomEvent('geplan:trocar-empresa', { detail: el.value })); },
};

export function limparEmpresa() { Object.assign(dados, { carregado: false, membros: [], convites: [], uso: null, planos: [], equipes: {}, empresas: [], linkNovo: '', erro: '' }); }
