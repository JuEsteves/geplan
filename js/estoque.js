// Estoque e sobras (modo nuvem): transferência de material entre obras e para/do estoque da empresa, com o custo junto
// (migração 0020). Obra de origem recebe crédito, obra de destino recebe o custo; no estoque o material é saldo com custo
// médio. Tudo gravado pelas funções do banco (registrar_transferencia / cancelar_transferencia), que conferem permissões.
import * as store from './store.js';
import { esc, I, ui, toast, formDialog, queueRender, parseNum, fmtIn } from './ui.js';
import { fmtBRL, isoBR, todayISO } from './schedule.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { liberado } from './permissoes.js';

const vazio = () => ({ carregado: false, carregando: false, erro: '', em: 0, itens: [], transf: [] });
const E = vazio();
const ctx = () => nuvem.contexto();
const ok = ({ data, error }, onde) => { if (error) throw erroBanco(error, onde); return data; };
const papel = () => ctx()?.papel;
const veEstoque = () => ['admin', 'engenheiro', 'supervisor', 'financeiro', 'compras', 'contador'].includes(papel());
const movimenta = () => !['cliente', 'contador'].includes(papel()) && liberado('comprar');
const disponivel = () => nuvemConfigurada() && nuvem.ativo() && veEstoque();
const nomeObra = (id) => store.obra(id)?.nome || 'obra';
const trf = (n) => `TRF-${String(n).padStart(4, '0')}`;
const qtd = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const fasesDaObra = (o) => (o?.eap || []).filter((a) => a.nivel <= 2 && (o.eap || []).some((x) => x.parentId === a.id));

export async function carregarEstoque(forcar = false) {
  if (!disponivel() || E.carregando || (E.carregado && !forcar)) return;
  E.carregando = true; E.erro = '';
  try {
    const c = await sb();
    const org = ctx().orgId;
    const [its, ts] = await Promise.all([
      c.from('stock_items').select('*').eq('org_id', org).order('description'),
      c.from('material_transfers').select('*').eq('org_id', org).order('number', { ascending: false }),
    ]);
    E.itens = ok(its, 'estoque') || []; E.transf = ok(ts, 'transferências') || [];
    E.carregado = true; E.em = Date.now();
  } catch (e) { E.erro = e.message; }
  E.carregando = false;
  queueRender();
}
export function limparEstoque() { Object.assign(E, vazio()); }

/* ---------- tela ---------- */
export function viewEstoque() {
  const cab = `<div class="page-head"><div><h1>Estoque e sobras</h1><div class="muted">Sobra de material que vai para outra obra ou para o estoque da empresa — o custo vai junto, pelo preço da compra.</div></div>
    ${disponivel() && movimenta() ? `<div class="row"><button class="btn primary" data-act="estTransferir">${I.plus} Transferir material</button></div>` : ''}</div>`;
  if (!nuvemConfigurada()) return `${cab}<div class="card empty"><p>O estoque funciona no modo nuvem (banco de dados da empresa).</p></div>`;
  if (!veEstoque()) return `${cab}<div class="card empty"><p>Seu perfil não acessa o estoque.</p></div>`;
  if (!E.carregando && (!E.carregado || Date.now() - E.em > 60000)) setTimeout(() => carregarEstoque(true));
  if (!E.carregado) return `${cab}<div class="card empty"><p>${E.erro ? esc(E.erro) : 'Carregando…'}</p></div>`;
  const comSaldo = E.itens.filter((i) => Number(i.quantity) > 0);
  const valor = comSaldo.reduce((s, i) => s + Number(i.quantity) * Number(i.avg_cost), 0);
  const mes = todayISO().slice(0, 7);
  const doMes = E.transf.filter((t) => !t.cancelled_at && t.transfer_date.slice(0, 7) === mes);
  const lado = (proj, estoque) => (proj ? esc(nomeObra(proj)) : estoque ? '<span class="badge">Estoque</span>' : '—');
  return `${cab}<div class="stack">
    ${E.erro ? `<div class="alert err">${esc(E.erro)}</div>` : ''}
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Valor em estoque</div><div class="k-value" style="font-size:19px">${fmtBRL(valor)}</div><div class="k-sub">${comSaldo.length} material(is) · pelo custo médio</div></div>
      <div class="card kpi"><div class="k-label">Transferências no mês</div><div class="k-value">${doMes.length}</div><div class="k-sub">${fmtBRL(doMes.reduce((s, t) => s + Number(t.total), 0))} movimentados</div></div>
    </div>
    <h2 style="margin:6px 0 0">Estoque da empresa</h2>
    ${comSaldo.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Material</th><th class="num">Quantidade</th><th class="num">Custo médio</th><th class="num">Valor</th><th>Local</th><th></th></tr></thead><tbody>
      ${comSaldo.map((i) => `<tr><td>${esc(i.description)}</td><td class="num nowrap">${qtd(i.quantity)} ${esc(i.unit)}</td><td class="num nowrap">${fmtBRL(i.avg_cost)}</td>
        <td class="num nowrap">${fmtBRL(Number(i.quantity) * Number(i.avg_cost))}</td><td class="small">${esc(i.location || '—')}</td>
        <td class="nowrap">${movimenta() ? `<button class="btn sm primary" data-act="estEnviar" data-id="${i.id}">Enviar para obra</button> <button class="btn sm" data-act="estLocal" data-id="${i.id}">Local</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty"><p>Estoque vazio.</p><p class="small muted">Material entra no estoque quando uma sobra de obra é transferida para a empresa.</p></div>'}
    <h2 style="margin:6px 0 0">Transferências</h2>
    ${E.transf.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Nº / data</th><th>Material</th><th>De → para</th><th class="num">Custo</th><th>Situação</th><th></th></tr></thead><tbody>
      ${E.transf.map((t) => `<tr${t.cancelled_at ? ' style="opacity:.6"' : ''}><td class="nowrap"><b>${trf(t.number)}</b><div class="muted small">${isoBR(t.transfer_date)}</div></td>
        <td>${qtd(t.quantity)} ${esc(t.unit)} ${esc(t.description)}<div class="muted small">por ${esc(t.created_label || '—')}${t.notes ? ` · ${esc(t.notes)}` : ''}</div></td>
        <td class="small">${lado(t.from_project_id, !t.from_project_id)} → ${lado(t.to_project_id, !t.to_project_id)}
          ${t.from_client_funds && !t.cancelled_at ? '<div><span class="badge warn" title="O material foi pago pelo cliente da obra de origem (obra por administração)">origem por administração: credite o cliente</span></div>' : ''}</td>
        <td class="num nowrap">${fmtBRL(t.total)}<div class="muted small">${fmtBRL(t.unit_cost)} / ${esc(t.unit || 'un')}</div></td>
        <td class="small">${t.cancelled_at ? `Cancelada<div class="muted">${esc(t.cancel_reason)}</div>` : '<span class="badge good">Feita</span>'}</td>
        <td>${!t.cancelled_at && movimenta() ? `<button class="btn sm danger" data-act="estCancelar" data-id="${t.id}">Cancelar</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty"><p>Nenhuma transferência ainda.</p></div>'}
    <div class="muted small">Na obra de origem a sobra entra como crédito ("Sobra enviada") e na de destino como custo ("Material recebido"), na aba Custos — nenhuma das duas é conta a pagar. Para a empresa nada muda: o dinheiro saiu uma vez, na compra. Sobra pequena (meio saco, alguns parafusos) não precisa ser lançada. Em obra por administração, o material da origem foi pago pelo cliente: credite-o na prestação de contas e cobre do cliente da obra que recebeu.</div>
  </div>`;
}

/* ---------- formulário ---------- */
const opcoesObras = (sel, exceto = '') => store.obras().filter((o) => o.id !== exceto).map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.nome)}</option>`).join('');
const opcoesFases = (o, sel) => `<option value="">— sem fase —</option>${fasesDaObra(o).map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}`;

/** Formulário de transferência. `ini` pré-preenche: { deObra, deFase, item, descricao, unidade, custo, max, estoqueId }. */
export async function formularioTransferencia(ini = {}) {
  if (!E.carregado) await carregarEstoque(true);
  const doEstoque = !!ini.estoqueId;
  const s = doEstoque ? E.itens.find((i) => i.id === ini.estoqueId) : null;
  const obras = store.obras();
  const deObra = ini.deObra || obras[0]?.id || '';
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-wide" novalidate><h2>${doEstoque ? `Enviar do estoque — ${esc(s.description)}` : 'Transferir sobra de material'}</h2><div class="stack" style="margin-top:12px">
    ${doEstoque ? `<p class="muted small" style="margin:0">Em estoque: <b>${qtd(s.quantity)} ${esc(s.unit)}</b> a ${fmtBRL(s.avg_cost)} (custo médio).</p>`
      : `<div class="grid-form">
        <label class="field">Sai da obra *<select name="de" ${ini.item ? 'disabled' : ''}>${opcoesObras(deObra)}</select></label>
        <label class="field">Fase de origem<select name="deFase">${opcoesFases(store.obra(deObra), ini.deFase)}</select></label>
        <label class="field">Material *<input name="descricao" maxlength="300" value="${esc(ini.descricao || '')}" ${ini.item ? 'readonly' : ''}></label>
        <label class="field">Unidade<input name="unidade" maxlength="20" value="${esc(ini.unidade || '')}" ${ini.item ? 'readonly' : ''} style="width:90px"></label>
        <label class="field">Custo unitário (R$) *<input name="custo" inputmode="decimal" value="${ini.custo != null ? fmtIn(ini.custo, 2) : ''}"></label>
      </div>`}
    <div class="grid-form">
      <label class="field">Quantidade *<input name="qtd" inputmode="decimal" placeholder="${ini.max != null ? `até ${qtd(ini.max)}` : ''}"></label>
      <label class="field">Vai para *<select name="para">${doEstoque ? '' : '<option value="estoque">Estoque da empresa</option>'}${opcoesObras('', doEstoque ? '' : deObra)}</select></label>
      <label class="field" data-para-fase>Fase de destino<select name="paraFase"><option value="">— sem fase —</option></select></label>
      <label class="field">Data *<input type="date" name="data" value="${todayISO()}" max="${todayISO()}"></label>
    </div>
    <label class="field">Observações<input name="obs" maxlength="500" placeholder="ex.: sobra do contrapiso"></label>
    <div class="muted small" data-total></div>
    ${ini.item ? '<div class="muted small">Do item do pedido: no máximo o que foi recebido menos o que já foi transferido (o banco confere). Custo = preço do item na compra; ajuste se precisar.</div>' : ''}
    </div><div class="form-erro alert err small" hidden></div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Transferir</button></div></form>`;
  const f = dlg.querySelector('form');
  const erro = (m) => { const e = f.querySelector('.form-erro'); e.textContent = m; e.hidden = !m; };
  const fasesPara = () => {
    const o = f.para.value === 'estoque' ? null : store.obra(f.para.value);
    f.querySelector('[data-para-fase]').hidden = !o;
    f.paraFase.innerHTML = o ? opcoesFases(o, '') : '';
  };
  const total = () => {
    const q = parseNum(f.qtd.value) || 0;
    const c = doEstoque ? Number(s.avg_cost) : parseNum(f.custo.value) || 0;
    f.querySelector('[data-total]').textContent = q && c ? `Custo transferido: ${fmtBRL(Math.round(q * c * 100) / 100)}` : '';
  };
  f.para.onchange = fasesPara; fasesPara();
  if (!doEstoque && !ini.item) f.de.onchange = () => { f.deFase.innerHTML = opcoesFases(store.obra(f.de.value), ''); f.para.innerHTML = `<option value="estoque">Estoque da empresa</option>${opcoesObras('', f.de.value)}`; fasesPara(); };
  f.addEventListener('input', total);
  return new Promise((resolve) => {
    let fim = false;
    const finish = (v) => { if (fim) return; fim = true; if (dlg.open) dlg.close(); resolve(v); };
    f.querySelector('[value=cancel]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('[value=ok]'); btn.disabled = true; erro('');
      try {
        const q = parseNum(f.qtd.value);
        if (!(q > 0)) throw new Error('Informe a quantidade.');
        if (!f.data.value || f.data.value > todayISO()) throw new Error('Informe a data (não pode ser futura).');
        const paraEstoque = f.para.value === 'estoque';
        const args = { p_org: ctx().orgId, p_date: f.data.value, p_quantity: q, p_to_project: paraEstoque ? null : f.para.value, p_to_phase: paraEstoque ? null : (f.paraFase.value || null),
          p_to_stock: paraEstoque, p_notes: f.obs.value.trim() };
        if (doEstoque) Object.assign(args, { p_stock_item: s.id, p_description: s.description, p_unit: s.unit });
        else {
          const custo = parseNum(f.custo.value);
          if (custo == null || !(custo >= 0)) throw new Error('Informe o custo unitário.');
          if (!f.descricao.value.trim()) throw new Error('Informe o material.');
          Object.assign(args, { p_from_project: ini.item ? ini.deObra : f.de.value, p_from_phase: f.deFase.value || null, p_description: f.descricao.value.trim(),
            p_unit: f.unidade.value.trim(), p_unit_cost: custo, p_purchase_item: ini.item || null });
        }
        ok(await (await sb()).rpc('registrar_transferencia', args), 'transferência');
        await Promise.all([carregarEstoque(true), nuvem.baixar().catch(() => {})]);
        toast('Transferência registrada — o custo foi junto.');
        finish(true);
      } catch (e) { btn.disabled = false; erro(e.message); }
    };
    dlg.showModal();
    f.qtd.focus();
  });
}

export const acoesEstoque = {
  async estTransferir() { await formularioTransferencia(); },
  async estEnviar(d) { await formularioTransferencia({ estoqueId: d.id }); },
  async estLocal(d) {
    const i = E.itens.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Local — ${i.description}`, ok: 'Salvar', fields: [{ name: 'local', label: 'Onde está guardado', value: i.location || '' }] });
    if (!v) return;
    ok(await (await sb()).from('stock_items').update({ location: v.local.trim() }).eq('id', i.id), 'local');
    await carregarEstoque(true);
  },
  async estCancelar(d) {
    const t = E.transf.find((x) => x.id === d.id);
    const v = await formDialog({ title: `Cancelar ${trf(t.number)}`, ok: 'Cancelar transferência', text: 'O custo volta para a obra de origem e o estoque é refeito. Fica no histórico como cancelada.',
      fields: [{ name: 'motivo', label: 'Motivo (obrigatório)', required: true }] });
    if (!v) return;
    ok(await (await sb()).rpc('cancelar_transferencia', { p_id: t.id, p_reason: v.motivo }), 'cancelar');
    await Promise.all([carregarEstoque(true), nuvem.baixar().catch(() => {})]);
    toast('Transferência cancelada.');
  },
};
void ui;
