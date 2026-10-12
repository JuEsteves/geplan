// Telas de gestão da obra: Painel (dashboard), Medições, Diário de obra e Financeiro/Suprimentos.
// Todos os números vêm dos dados salvos da obra e das regras centralizadas (calculo, cpm, curvaS, financeiro, execucao).
import * as store from './store.js';
import { savedUser } from './drive.js';
import { uid, registrar, CATEGORIAS_CUSTO, TIPOS_OCORRENCIA } from './model.js';
import { avanco, fracPlanejada, pctRealAte, incorridoAte } from './curvaS.js';
import { resumoOrcamento, resumoCustos, custosPorFase, totalCompromisso, compromissoEfetivo, COMPROMISSO_ENCERRADO, pagoDespesa, despesaDuplicada, valorAgregado } from './financeiro.js';
import { medicoesALancar } from './nuvem/aLancar.js';
import { quantidadePlanejada, metodoMedicao, medicoesDe, registrarMedicao, removerMedicao, pendenciasAbertas, periodoRdo, badgeRdo } from './execucao.js';
import { toDay, toISO, fmtBR, isoBR, todayDay, todayISO, fmtNum, fmtBRL } from './schedule.js';
import { esc, I, ui, toast, ask, info, formDialog, commit, queueRender, parseNum, fmtIn } from './ui.js';
import { contexto } from './obra.js';
import { atividadesAtrasadas } from './indicadores.js';
import { datalistFornecedores, idDoFornecedorPorNome } from './fornecedores.js';
import { LIBS, loadScript } from './libs.js';

export const usuario = () => savedUser()?.emailAddress || '';
const obraAtual = () => store.obra(location.hash.split('/')[2]);
const folhas = (c) => [...c.cron.nos.values()].filter((n) => n.folha);
const vazioCard = (txt) => `<div class="card empty"><p>${txt}</p></div>`;

/** Janela com formulário livre. `montar(form)` liga comportamentos; resolve com o form (submit) ou null. */
function dialogo(titulo, corpo, { ok = 'Salvar', largo = false, montar } = {}) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="${largo ? 'dlg-wide' : ''}"><h2>${esc(titulo)}</h2><div class="stack" style="margin-top:14px">${corpo}</div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  const form = dlg.querySelector('form');
  montar?.(form);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    form.onsubmit = (e) => { e.preventDefault(); finish(form); };
    dlg.querySelector('button[value="cancel"]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null); dlg.onclose = () => { if (!dlg.open) finish(null); };
    dlg.showModal();
    form.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  });
}

/* =====================================================================
   PAINEL (dashboard)
   ===================================================================== */
export function tabPainel(c) {
  const { o, calc, cron } = c;
  const hoje = todayDay();
  const etapaF = ui.painelEtapa || '';
  if (!o.eap.length && !o.orcamento.length) {
    return `<div class="card empty"><p>O painel aparece quando a obra tiver dados.</p>
      <p class="small">Cadastre ou importe o <b>orçamento</b>, monte as <b>atividades</b> (aba Atividades › "+ Fases do modelo") e vincule os itens às atividades.</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="#/obra/${o.id}/atividades">Montar atividades</a><a class="btn" href="#/obra/${o.id}/orcamento">Orçamento</a></div></div>`;
  }
  const av = avanco(o, calc, cron, hoje);
  const orc = resumoOrcamento(o, calc);
  const custos = resumoCustos(o, { aLancar: medicoesALancar(o.id) });
  const va = valorAgregado({ bac: av.finTotal, pv: av.finPlan, ev: av.valorAgregado, ac: incorridoAte(o, hoje) });
  const fl = folhas(c);
  const naEtapa = (n) => !etapaF || raizId(c, n.a) === etapaF;
  const atrasadas = atividadesAtrasadas(c, hoje, naEtapa);   // mesma regra da Visão geral (js/indicadores.js)
  const criticas = fl.filter((n) => naEtapa(n) && n.critico && pctRealAte(o, n.a, hoje) < 100);
  const marcos = [...cron.nos.values()].filter((n) => naEtapa(n) && ((n.folha && n.dur === 0) || n.a.nivel === 1) && n.termino >= hoje).sort((a, b) => a.termino - b.termino).slice(0, 6);
  const pend = pendenciasAbertas(o);
  const compras = (o.compromissos || []).filter((k) => String(k.tipo || '').startsWith('Pedido') && !['Entregue', 'Encerrado', 'Cancelado'].includes(k.status));
  let desvioPrazo = null;
  if (o.linhaBase) {
    const bt = Math.max(...Object.values(o.linhaBase.itens).map((b) => b.termino));
    desvioPrazo = cron.cal.idxPrev(cron.termino) - cron.cal.idxPrev(bt);
  }
  const pctDe = (v, t) => (t ? (v / t) * 100 : 0);
  const card = (titulo, valor, sub = '', cor = '') => `<div class="card kpi"><div class="k-label">${titulo}</div><div class="k-value" style="${cor ? `color:${cor};` : ''}${String(valor).length > 10 ? 'font-size:18px' : ''}">${valor}</div>${sub ? `<div class="k-sub">${sub}</div>` : ''}</div>`;
  const etapas = c.filhos.get(null) || [];
  const linhaEtapa = etapas.map((e) => {
    const fs = fl.filter((n) => raizId(c, n.a) === e.id);
    const tot = fs.reduce((s, n) => s + (calc.ativ.get(n.id).hh || n.dur), 0);
    const plan = tot ? fs.reduce((s, n) => s + (calc.ativ.get(n.id).hh || n.dur) * fracPlanejada(n, cron.cal, hoje, o), 0) / tot * 100 : 0;
    const real = tot ? fs.reduce((s, n) => s + (calc.ativ.get(n.id).hh || n.dur) * pctRealAte(o, n.a, hoje) / 100, 0) / tot * 100 : 0;
    const no = cron.nos.get(e.id);
    return `<tr><td>${esc(e.codigo)} ${esc(e.descricao)}</td><td class="nowrap small">${fmtBR(no.inicio)} → ${fmtBR(no.termino)}</td><td class="num">${fmtNum(plan, 0)}%</td><td class="num">${fmtNum(real, 0)}%</td>
      <td style="min-width:120px"><div class="progress duo"><div style="width:${Math.min(100, plan)}%" class="p"></div><div style="width:${Math.min(100, real)}%" class="r"></div></div></td><td class="num nowrap">${fmtBRL(calc.ativ.get(e.id).custo)}</td></tr>`;
  }).join('');
  const lista = (itens, vazio) => itens.length ? `<ul class="lista">${itens.join('')}</ul>` : `<div class="muted small" style="padding:8px 0">${vazio}</div>`;
  return `<div class="stack">
    <div class="row">
      <span class="badge info">${esc(o.status || 'Planejamento')}</span>${o.codigo ? `<span class="badge">${esc(o.codigo)}</span>` : ''}${o.cliente?.nome ? `<span class="muted small">Cliente: ${esc(o.cliente.nome)}</span>` : ''}
      <span style="flex:1"></span>
      <label class="field" style="max-width:280px">Filtrar por etapa<select data-chg="painelEtapa"><option value="">Todas as etapas</option>${etapas.map((e) => `<option value="${e.id}" ${e.id === etapaF ? 'selected' : ''}>${esc(e.codigo)} ${esc(e.descricao)}</option>`).join('')}</select></label>
    </div>
    <div class="kpis">
      ${card('Custo orçado (direto)', fmtBRL(orc.custoDireto), isFinite(orc.bdi) && orc.bdi ? `preço de venda ${fmtBRL(orc.precoVenda)} (BDI ${fmtNum(orc.bdi * 100, 2)}%)` : 'BDI não configurado')}
      ${card('Valor contratado', o.valorContratado ? fmtBRL(o.valorContratado) : '—', o.valorContratado ? '' : 'informe na aba Cadastro')}
      ${card('Custo comprometido', fmtBRL(custos.comprometido), `${fmtNum(pctDe(custos.comprometido, orc.custoDireto), 1)}% do orçado`)}
      ${card('Custo realizado (incorrido)', fmtBRL(custos.incorrido), `pago ${fmtBRL(custos.pago)} · a pagar ${fmtBRL(custos.saldoAPagar)}`)}
      ${card('Físico planejado (hoje)', `${fmtNum(av.fisicoPlan, 1)}%`, av.semPeso ? 'sem peso físico definido' : `peso: ${{ hh: 'HH', custo: 'custo', duracao: 'duração', manual: 'manual' }[o.pesoFisico || 'hh']}`)}
      ${card('Físico realizado', `${fmtNum(av.fisicoReal, 1)}%`, `desvio ${av.fisicoReal - av.fisicoPlan >= 0 ? '+' : ''}${fmtNum(av.fisicoReal - av.fisicoPlan, 1)} pts`, av.fisicoReal + 0.5 < av.fisicoPlan ? 'var(--crit)' : '')}
      ${card('Financeiro realizado', `${fmtNum(av.financeiroPct, 1)}%`, 'incorrido ÷ custo planejado — não é avanço físico')}
      ${card('Desvio de prazo', desvioPrazo == null ? (va.spi == null ? '—' : `SPI ${fmtNum(va.spi, 2)}`) : `${desvioPrazo > 0 ? '+' : ''}${desvioPrazo} ${cron.unidDias}`, desvioPrazo == null ? 'salve uma linha de base para comparar' : `término previsto ${fmtBR(cron.termino)}${va.spi != null ? ` · SPI ${fmtNum(va.spi, 2)}` : ''}`, desvioPrazo > 0 ? 'var(--crit)' : '')}
      ${card('Desvio de custo', va.cpi == null ? '—' : `CPI ${fmtNum(va.cpi, 2)}`, va.cpi == null ? 'sem custo realizado ainda' : `VAC ${fmtBRL(va.vac)}`, va.cpi != null && va.cpi < 0.98 ? 'var(--crit)' : '')}
      ${card('Previsão de custo final', fmtBRL(va.eac), 'EAC = realizado + (orçado − valor agregado)')}
      ${card('Previsão de conclusão', o.eap.length ? fmtBR(cron.termino) : '—', `${cron.durTotal} ${cron.unidDias}${o.terminoPlanejado ? ` · planejado ${isoBR(o.terminoPlanejado)}` : ''}`)}
    </div>
    ${custos.alertas.length ? `<div class="alert err">${custos.alertas.map(esc).join('<br>')}</div>` : ''}
    <div class="grid-2">
      <div class="card card-pad"><h2>Atividades atrasadas (${atrasadas.length})</h2>${lista(atrasadas.slice(0, 8).map((n) => `<li><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)} <span class="badge crit">${fmtNum(pctRealAte(o, n.a, hoje), 0)}% de ${fmtNum(fracPlanejada(n, cron.cal, hoje, o) * 100, 0)}%</span></li>`), 'Nenhuma atividade atrasada pelas medições registradas.')}<a class="small" href="#/obra/${o.id}/medicoes">Registrar medições →</a></div>
      <div class="card card-pad"><h2>Caminho crítico em aberto (${criticas.length})</h2>${lista(criticas.slice(0, 8).map((n) => `<li><b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)} <span class="muted small">${fmtBR(n.inicio)} → ${fmtBR(n.termino)}</span></li>`), 'Sem atividades críticas em aberto.')}</div>
      <div class="card card-pad"><h2>Próximos marcos</h2>${lista(marcos.map((n) => `<li>${n.a.nivel === 1 ? 'Fim da etapa ' : ''}<b>${esc(n.a.codigo)}</b> ${esc(n.a.descricao)} <span class="muted small">${fmtBR(n.termino)}</span></li>`), 'Nenhum marco à frente.')}</div>
      <div class="card card-pad"><h2>Pendências de execução (${pend.length})</h2>${lista(pend.slice(0, 8).map((p) => `<li><span class="badge warn">${esc(p.tipo)}</span> ${esc(p.descricao)} <span class="muted small">${isoBR(p.data)}</span></li>`), 'Nenhum impedimento/interferência em aberto no diário.')}<a class="small" href="#/obra/${o.id}/diario">Diário de obra →</a></div>
      <div class="card card-pad"><h2>Compras pendentes (${compras.length})</h2>${lista(compras.slice(0, 8).map((k) => `<li><b>${esc(k.objeto || k.fornecedor)}</b> <span class="badge">${esc(k.status || '')}</span>${k.dataNecessaria ? ` <span class="muted small">necessário em ${isoBR(k.dataNecessaria)}</span>` : ''}</li>`), 'Nenhum pedido de compra em aberto.')}<a class="small" href="#/obra/${o.id}/financeiro">Suprimentos →</a></div>
    </div>
    ${etapas.length ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Etapa</th><th>Período</th><th class="num">Físico plan.</th><th class="num">Físico real</th><th></th><th class="num">Custo planejado</th></tr></thead><tbody>${linhaEtapa}</tbody></table></div>` : ''}
    <div class="muted small">Indicadores calculados hoje (${fmtBR(hoje)}) a partir dos dados salvos. Físico = média ponderada do % medido (peso configurável); financeiro = custo incorrido ÷ custo planejado; CPI/SPI = índices de valor agregado (1,00 = no orçado/no prazo).</div>
  </div>`;
}
function raizId(c, a) { let x = a; while (x.parentId) x = c.porId.get(x.parentId); return x.id; }

/* =====================================================================
   MEDIÇÕES
   ===================================================================== */
export function tabMedicoes(c) {
  const { o, calc, cron, filhos } = c;
  if (!o.eap.length) return vazioCard('Monte as atividades antes de medir a execução.');
  ui.statusDate ||= todayISO();
  const day = toDay(ui.statusDate) ?? todayDay();
  const av = avanco(o, calc, cron, day);
  const termo = (ui.ativFilter || '').trim().toLowerCase();
  const soPeriodo = ui.medSoPeriodo !== false;
  const lista = folhas(c).filter((n) => {
    if (termo && !`${n.a.codigo} ${n.a.descricao}`.toLowerCase().includes(termo)) return false;
    if (!soPeriodo) return true;
    const real = pctRealAte(o, n.a, day);
    return n.inicio <= day + 14 && real < 100; // em andamento ou começando nas próximas 2 semanas
  });
  const rows = lista.map((n) => {
    const a = n.a, plan = quantidadePlanejada(calc, a.id), metodo = metodoMedicao(a, plan);
    const ms = medicoesDe(o, a.id), ult = [...ms].reverse().find((m) => m.data <= ui.statusDate);
    const real = pctRealAte(o, a, day), p = fracPlanejada(n, cron.cal, day, o) * 100;
    const sit = real >= 100 ? ['Concluída', 'good'] : real + 0.5 < p ? ['Atrasada', 'crit'] : real === 0 && p === 0 ? ['Não iniciada', ''] : ['Em dia', 'info'];
    return `<tr>
      <td class="nowrap">${esc(a.codigo)}</td><td>${esc(a.descricao)}<div class="small muted">${fmtBR(n.inicio)} → ${fmtBR(n.termino)}</div></td>
      <td class="small">${metodo === 'quantidade' ? `${fmtNum(plan.qtd, 2)} ${esc(plan.unidade)}` : '% direto'}</td>
      <td class="num">${ult ? (ult.metodo === 'quantidade' ? `${fmtNum(ult.qtdAcum, 2)} ${esc(ult.unidade)}` : '—') : '—'}</td>
      <td class="num"><b>${fmtNum(real, 1)}%</b></td><td class="num">${fmtNum(p, 0)}%</td>
      <td><span class="badge ${sit[1]}">${sit[0]}</span></td>
      <td class="nowrap"><button class="btn sm primary" data-act="medir" data-id="${a.id}">Medir</button>${ms.length ? ` <button class="btn sm" data-act="medHist" data-id="${a.id}">${ms.length} lanç.</button>` : ''}</td>
    </tr>`;
  }).join('');
  const ultimas = [...(o.medicoesAtiv || [])].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)).slice(0, 8);
  return `<div class="stack">
    <div class="card card-pad row">
      <label class="field" style="max-width:200px">Data de referência<input type="date" data-chg="statusDate" value="${ui.statusDate}"></label>
      <input data-inp="ativFilter" data-key="medBusca" value="${esc(ui.ativFilter || '')}" placeholder="Buscar atividade…" style="flex:1;min-width:180px">
      <label class="check"><input type="checkbox" data-chg="medSoPeriodo" ${soPeriodo ? 'checked' : ''}> Só as do período (em andamento e próximas 2 semanas)</label>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Físico planejado na data</div><div class="k-value">${fmtNum(av.fisicoPlan, 1)}%</div></div>
      <div class="card kpi"><div class="k-label">Físico medido</div><div class="k-value">${fmtNum(av.fisicoReal, 1)}%</div><div class="k-sub">desvio ${fmtNum(av.fisicoReal - av.fisicoPlan, 1)} pts</div></div>
      <div class="card kpi"><div class="k-label">Lançamentos</div><div class="k-value">${(o.medicoesAtiv || []).length}</div><div class="k-sub">histórico preservado</div></div>
    </div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Cód.</th><th>Atividade</th><th>Planejado</th><th class="num">Acumulado</th><th class="num">Real</th><th class="num">Plan. na data</th><th>Situação</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">Nenhuma atividade com esse filtro.</td></tr>'}</tbody></table></div>
    ${ultimas.length ? `<div class="card card-pad"><h2>Últimos lançamentos</h2><ul class="lista">${ultimas.map((m) => { const a = c.porId.get(m.atividadeId); return `<li><b>${esc(a?.codigo || '?')}</b> ${esc(a?.descricao || '')} — ${fmtNum(m.pct, 1)}% em ${isoBR(m.data)}${m.metodo === 'quantidade' ? ` (${fmtNum(m.qtdAcum, 2)} ${esc(m.unidade)})` : ''} <span class="muted small">${esc(m.responsavel || '')}</span></li>`; }).join('')}</ul></div>` : ''}
    <div class="muted small"><b>Como medir:</b> informe o <b>acumulado</b> executado até a data (não só o do período). Um lançamento por atividade por data — lançar de novo na mesma data substitui. Atividades com quantidade (vinculadas ao orçamento) são medidas pela quantidade; as demais, em %.</div>
  </div>`;
}

async function dialogoMedir(o, c, a) {
  const plan = quantidadePlanejada(c.calc, a.id), metodo = metodoMedicao(a, plan);
  const ms = medicoesDe(o, a.id), ult = ms[ms.length - 1];
  const form = await dialogo(`Medir ${a.codigo} — ${a.descricao}`, `
    <div class="grid-form">
      <label class="field">Data<input type="date" name="data" required value="${ui.statusDate || todayISO()}"></label>
      ${metodo === 'quantidade'
        ? `<label class="field">Quantidade ACUMULADA executada (${esc(plan.unidade)})<input name="qtd" inputmode="decimal" required value="${ult?.qtdAcum != null ? fmtIn(ult.qtdAcum, 4) : ''}" placeholder="de ${fmtNum(plan.qtd, 2)}"><span class="muted small" style="font-weight:400">Planejado: ${fmtNum(plan.qtd, 2)} ${esc(plan.unidade)}</span></label>`
        : `<label class="field">% ACUMULADO executado<input name="pct" inputmode="decimal" required value="${ult ? fmtIn(ult.pct, 1) : ''}" placeholder="0 a 100"></label>`}
    </div>
    <label class="field">Observação<input name="obs" placeholder="ex.: falta acabamento no banheiro"></label>
    ${ult ? `<div class="muted small">Última medição: ${fmtNum(ult.pct, 1)}% em ${isoBR(ult.data)}.</div>` : ''}`, { ok: 'Registrar' });
  if (!form) return;
  const v = Object.fromEntries(new FormData(form));
  try {
    const r = registrarMedicao(o, c.calc, { atividadeId: a.id, data: v.data, qtdAcum: parseNum(v.qtd), pct: parseNum(v.pct), obs: v.obs, responsavel: usuario() });
    commit(o);
    toast(`${r.substituida ? 'Medição da data substituída' : 'Medição registrada'}: ${fmtNum(r.medicao.pct, 1)}%.${r.avisos.length ? ' ' + r.avisos.join(' ') : ''}`, r.avisos.length ? 7000 : 3500);
  } catch (e) { toast(e.message, 5000); }
}

/* =====================================================================
   DIÁRIO DE OBRA — tem página própria (js/diario.js); aqui só o resumo e os atalhos
   ===================================================================== */
export function tabDiario(c) {
  const { o } = c;
  const lista = [...(o.diario || [])].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 6);
  return `<div class="stack">
    <div class="card card-pad row between" style="flex-wrap:wrap;gap:10px"><div><h2 style="margin:0">Diário de obra (RDO)</h2>
      <div class="muted small">Relatórios por período, fotos e vídeos, aprovação com assinatura e PDF ficam no painel do diário da obra.</div></div>
      <div class="row"><a class="btn primary" href="#/diario/${o.id}/rdo/novo/editar">${I.plus} Novo relatório</a><a class="btn" href="#/diario/${o.id}">Abrir o diário da obra</a></div></div>
    ${lista.length ? `<div class="card table-wrap"><table class="data tabela-clicavel"><thead><tr><th>Período</th><th>Nº</th><th>Situação</th><th>Responsável</th></tr></thead><tbody>
      ${lista.map((d) => `<tr data-act="diarioAbrir" data-obra="${o.id}" data-id="${d.id}" tabindex="0"><td class="nowrap">${periodoRdo(d)}</td><td>${d.numero || '—'}</td><td>${badgeRdo(d.status)}</td><td class="small">${esc(d.responsavel || '')}</td></tr>`).join('')}
    </tbody></table></div>` : vazioCard('Nenhum relatório no diário ainda.')}
    <div class="muted small">O diário registra o dia a dia da obra. O avanço físico é lançado nas <a href="#/obra/${o.id}/medicoes">Medições</a> (registros relacionados, mas com finalidades distintas).</div>
  </div>`;
}

/* =====================================================================
   FINANCEIRO E SUPRIMENTOS
   ===================================================================== */
const STATUS_COMP = ['Em cotação', 'Aprovado', 'Entregue parcialmente', 'Entregue', 'Encerrado', 'Cancelado'];
/** Tabela de custos por fase (orçado × valor agregado × comprometido × incorrido × pago × a lançar). */
function tabelaCustosFase(c, pf, diaEv) {
  const { o, calc } = c;
  const evF = new Map(), alocF = new Map();
  for (const n of folhas(c)) {
    const rz = raizId(c, n.a), A = calc.ativ.get(n.id);
    alocF.set(rz, (alocF.get(rz) || 0) + A.custo);
    evF.set(rz, (evF.get(rz) || 0) + A.custo * pctRealAte(o, n.a, diaEv) / 100);
  }
  const pct = (v, t) => (t > 0 ? `${fmtNum(v / t * 100, 0)}%` : '—');
  const barra = (fis, fin) => `<div class="progress duo" title="Físico ${fis == null ? '—' : fmtNum(fis, 0) + '%'} · financeiro ${fin == null ? '—' : fmtNum(fin, 0) + '%'}"><div style="width:${Math.min(100, fin || 0)}%" class="p"></div><div style="width:${Math.min(100, fis || 0)}%" class="r"></div></div>`;
  let evTot = 0;
  const linhas = pf.fases.map((f) => {
    const ev = f.id ? evF.get(f.id) || 0 : null, aloc = f.id ? alocF.get(f.id) || 0 : 0;
    if (ev) evTot += ev;
    const fis = f.id && aloc > 0 ? ev / aloc * 100 : null, fin = f.orcado > 0 ? f.incorrido / f.orcado * 100 : null;
    return `<tr${f.id ? '' : ' class="sem-fase"'}><td>${f.id ? `${esc(f.codigo)} ${esc(f.descricao)}` : `<b>${esc(f.descricao)}</b>`}</td>
      <td class="num nowrap">${fmtBRL(f.orcado)}</td><td class="num nowrap">${ev == null ? '—' : fmtBRL(ev)}</td>
      <td class="num nowrap">${fmtBRL(f.comprometido)}</td><td class="num nowrap">${fmtBRL(f.incorrido)}<div class="small muted">${pct(f.incorrido, f.orcado)} do orçado</div></td>
      <td class="num nowrap">${fmtBRL(f.pago)}</td><td class="num nowrap">${fmtBRL(f.incorrido - f.pago)}</td><td class="num nowrap">${f.aLancar ? fmtBRL(f.aLancar) : '—'}</td>
      <td style="min-width:110px">${f.id ? barra(fis, fin) : ''}<div class="small muted">${fis == null ? '' : `físico ${fmtNum(fis, 0)}%`}${fis != null && fin != null ? ' · ' : ''}${fin == null ? '' : `financ. ${fmtNum(fin, 0)}%`}</div></td></tr>`;
  }).join('');
  const t = pf.totais;
  return `<div class="card table-wrap"><table class="data custos-fase"><thead><tr><th>Fase da EAP</th><th class="num">Orçado</th><th class="num">Valor agregado</th><th class="num">Comprometido</th><th class="num">Incorrido</th><th class="num">Pago</th><th class="num">A pagar</th><th class="num">A lançar</th><th>Físico × financeiro</th></tr></thead>
    <tbody>${linhas || '<tr><td colspan="9" class="muted">Monte as fases da EAP para ver os custos por fase.</td></tr>'}</tbody>
    <tfoot><tr><th>Total</th><th class="num nowrap">${fmtBRL(t.orcado)}</th><th class="num nowrap">${fmtBRL(evTot)}</th><th class="num nowrap">${fmtBRL(t.comprometido)}</th><th class="num nowrap">${fmtBRL(t.incorrido)}</th><th class="num nowrap">${fmtBRL(t.pago)}</th><th class="num nowrap">${fmtBRL(t.incorrido - t.pago)}</th><th class="num nowrap">${t.aLancar ? fmtBRL(t.aLancar) : '—'}</th><th></th></tr></tfoot></table></div>`;
}

// etapas raiz; um nó mais interno já gravado (ex.: vindo de Suprimentos) continua na lista para não se perder ao salvar
const opcoesFases = (o, sel) => `<option value="">— sem fase —</option>${o.eap.filter((a) => !a.parentId || a.id === sel).map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.codigo)} ${esc(a.descricao)}</option>`).join('')}`;
const nomeFase = (o, id) => { const a = id && o.eap.find((x) => x.id === id); return a ? `${a.codigo} ${a.descricao}` : ''; };

export function tabFinanceiro(c) {
  const { o, calc } = c;
  const orc = resumoOrcamento(o, calc);
  const aLancar = medicoesALancar(o.id);
  const r = resumoCustos(o, { aLancar });
  const hoje = todayDay();
  const av = avanco(o, calc, c.cron, hoje);
  const va = valorAgregado({ bac: av.finTotal, pv: av.finPlan, ev: av.valorAgregado, ac: incorridoAte(o, hoje) });
  const corte = ui.custosAte ? toDay(ui.custosAte) : null;
  const cat = ui.custosCat || '';
  const pf = custosPorFase(o, { totalItem: (id) => calc.itens.get(id)?.total || 0, ateDia: corte, aLancar, categoria: cat });
  const itemNome = (id) => { const it = o.orcamento.find((x) => x.id === id); return it ? `${it.codigo} ${calc.itens.get(it.id).comp?.descricao || it.descricao || ''}` : ''; };
  const comps = (o.compromissos || []).map((k) => {
    const usado = r.porComp.get(k.id) || 0, tot = totalCompromisso(k), efetivo = compromissoEfetivo(k, usado);
    const encerrado = COMPROMISSO_ENCERRADO.includes(k.status);
    return `<tr><td><span class="badge">${esc(k.tipo === 'Contrato' ? 'Contrato' : 'Pedido')}</span> ${esc(k.numero || '')}</td><td>${esc(k.fornecedor || '')}<div class="small muted">${esc(k.objeto || '')}</div></td>
      <td class="small">${esc(k.categoria || '')}${k.faseId ? `<div class="muted">Fase ${esc(nomeFase(o, k.faseId))}</div>` : ''}${k.itemId ? `<div class="muted">${esc(itemNome(k.itemId))}</div>` : ''}</td>
      <td class="num nowrap">${fmtBRL(tot)}${(k.aditivos || []).length ? `<div class="small muted">${k.aditivos.length} aditivo(s)</div>` : ''}${encerrado ? `<div class="small muted" title="${esc(k.status)}: conta no comprometido só o que já foi incorrido">conta ${fmtBRL(efetivo)}</div>` : ''}</td><td class="num nowrap">${fmtBRL(usado)}</td><td class="num nowrap">${fmtBRL(Math.max(0, efetivo - usado))}</td>
      <td>${k.tipo === 'Pedido de compra' ? `<span class="badge ${k.status === 'Entregue' ? 'good' : 'warn'}">${esc(k.status || '')}</span>${k.dataNecessaria ? `<div class="small muted">necessário ${isoBR(k.dataNecessaria)}</div>` : ''}${k.quantidade ? `<div class="small muted">receb. ${fmtNum(k.quantidadeRecebida || 0, 2)} de ${fmtNum(k.quantidade, 2)} ${esc(k.unidade || '')}</div>` : ''}` : `<span class="badge">${esc(k.status || '')}</span>`}</td>
      <td class="nowrap"><button class="icon-btn" data-act="compEditar" data-id="${k.id}" title="Editar">${I.more}</button></td></tr>`;
  }).join('');
  const desp = [...(o.despesas || [])].sort((a, b) => b.data.localeCompare(a.data)).map((d) => {
    const pago = pagoDespesa(d), k = (o.compromissos || []).find((x) => x.id === d.compromissoId);
    return `<tr><td class="nowrap">${isoBR(d.data)}</td><td>${esc(d.documento || '')}</td><td>${esc(d.fornecedor || '')}<div class="small muted">${esc(d.descricao || '')}</div></td>
      <td class="small">${esc(d.categoria || '')}${d.faseId ? `<div class="muted">Fase ${esc(nomeFase(o, d.faseId))}</div>` : ''}${k ? `<div class="muted">${esc(k.tipo)} ${esc(k.numero || k.fornecedor || '')}</div>` : ''}${d.itemId ? `<div class="muted">${esc(itemNome(d.itemId))}</div>` : ''}</td>
      <td class="num nowrap">${fmtBRL(d.valor)}</td><td class="num nowrap">${fmtBRL(pago)}</td><td>${pago >= (Number(d.valor) || 0) - 0.005 ? '<span class="badge good">Paga</span>' : `<span class="badge warn">A pagar</span>${d.vencimento ? `<div class="small muted">vence ${isoBR(d.vencimento)}</div>` : ''}`}</td>
      <td class="nowrap"><button class="icon-btn" data-act="despEditar" data-id="${d.id}" title="Editar / pagamentos">${I.more}</button></td></tr>`;
  }).join('');
  const kpi = (t, v, s = '') => `<div class="card kpi"><div class="k-label">${t}</div><div class="k-value" style="font-size:19px">${v}</div>${s ? `<div class="k-sub">${s}</div>` : ''}</div>`;
  return `<div class="stack">
    <div class="kpis">
      ${kpi('Custo orçado', fmtBRL(orc.custoDireto), isFinite(orc.bdi) && orc.bdi ? `venda ${fmtBRL(orc.precoVenda)}` : 'sem BDI')}
      ${kpi('Valor contratado (cliente)', o.valorContratado ? fmtBRL(o.valorContratado) : '—')}
      ${kpi('Comprometido', fmtBRL(r.comprometido), r.aLancar ? 'contratos + pedidos + despesas avulsas + medições a lançar' : 'contratos + pedidos + despesas avulsas')}
      ${kpi('Incorrido', fmtBRL(r.incorrido), 'despesas lançadas')}
      ${kpi('Pago', fmtBRL(r.pago), `a pagar ${fmtBRL(r.saldoAPagar)}`)}
      ${kpi('A incorrer', fmtBRL(r.aIncorrer), 'saldo de contratos e pedidos + medições a lançar')}
      ${r.aLancar ? kpi('Medições a lançar', fmtBRL(r.aLancar), 'aprovadas, ainda sem despesa no Financeiro') : ''}
      ${kpi('Previsão de custo final (EAC)', fmtBRL(va.eac), va.cpi != null ? `CPI ${fmtNum(va.cpi, 2)}` : '')}
    </div>
    ${r.alertas.length ? `<div class="alert err">${r.alertas.map(esc).join('<br>')}</div>` : ''}
    <div class="row" id="secao-fases" style="flex-wrap:wrap;gap:10px;align-items:flex-end"><h2 style="flex:1;min-width:200px;margin:0">Custos por fase</h2>
      <label class="field" style="max-width:170px">Data de corte<input type="date" data-chg="custosAte" value="${esc(ui.custosAte || '')}"></label>
      <label class="field" style="max-width:200px">Categoria<select data-chg="custosCat"><option value="">Todas</option>${CATEGORIAS_CUSTO.map((x) => `<option ${x === cat ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      ${corte != null || cat ? '<button class="btn sm" data-act="custosLimpar">Limpar filtros</button>' : ''}</div>
    ${pf.semFase ? `<div class="alert warn">${pf.semFase} lançamento(s) sem fase (contrato/despesa sem fase, sem item do orçamento ou com item sem vínculo de 100% com a EAP) — os valores aparecem na linha <b>Sem fase</b>. Informe a fase no contrato ou na despesa para distribuí-los.</div>` : ''}
    ${tabelaCustosFase(c, pf, corte ?? hoje)}
    <div class="muted small"><b>Orçado</b> = custo direto (sem BDI) repartido pelos vínculos com a EAP. <b>Valor agregado</b> = custo das atividades × % executado (avanço físico) — não se soma com o dinheiro. <b>A lançar</b> = medições aprovadas sem despesa (só para quem vê valores). Fase de cada valor: a informada → o item do orçamento → o contrato/pedido → "Sem fase". Barra: escura = físico, clara = financeiro (incorrido ÷ orçado).${cat ? ' Filtro de categoria não muda o orçado nem o valor agregado.' : ''}${corte != null ? ` Valores até ${isoBR(ui.custosAte)}.` : ''}</div>
    <div class="row" id="secao-compras"><h2 style="flex:1">Contratos e pedidos de compra</h2><button class="btn sm" data-act="compNovo" data-t="Contrato">${I.plus} Contrato</button><button class="btn sm primary" data-act="compNovo" data-t="Pedido de compra">${I.plus} Pedido de compra</button></div>
    ${comps ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Documento</th><th>Fornecedor / objeto</th><th>Categoria</th><th class="num">Valor + aditivos</th><th class="num">Incorrido</th><th class="num">Saldo</th><th>Status</th><th></th></tr></thead><tbody>${comps}</tbody></table></div>` : vazioCard('Nenhum contrato ou pedido. Registre aqui os compromissos assumidos com fornecedores e empreiteiros.')}
    <div class="row"><h2 style="flex:1">Despesas (notas, medições de terceiros, recibos)</h2><button class="btn sm primary" data-act="despNova">${I.plus} Despesa</button></div>
    ${desp ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Data</th><th>Documento</th><th>Fornecedor / descrição</th><th>Categoria / vínculo</th><th class="num">Valor</th><th class="num">Pago</th><th>Situação</th><th></th></tr></thead><tbody>${desp}</tbody></table></div>` : vazioCard('Nenhuma despesa lançada.')}
    <div class="grid-2">
      <div class="card table-wrap"><table class="data"><thead><tr><th>Categoria</th><th class="num">Incorrido</th></tr></thead><tbody>${r.porCategoria.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${fmtBRL(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Sem despesas.</td></tr>'}</tbody></table></div>
    </div>
    <div class="muted small"><b>Sem duplicidade:</b> a despesa vinculada a um contrato/pedido consome o saldo dele (não soma de novo no comprometido). Contrato/pedido cancelado ou encerrado conta só o que já foi incorrido. Medição aprovada entra como "a lançar" até virar despesa. Empreitada só entra quando medida. Material recebido sem nota não é custo (Suprimentos acompanha o pedido). EAC = realizado + (orçado − valor agregado).</div>
  </div>`;
}

function opcoesItens(o, calc, sel) {
  return `<option value="">— sem vínculo —</option>${o.orcamento.map((it) => `<option value="${it.id}" ${it.id === sel ? 'selected' : ''}>${esc(it.codigo)} ${esc(calc.itens.get(it.id).comp?.descricao || it.descricao || '')}</option>`).join('')}`;
}

async function dialogoCompromisso(o, c, k, novo) {
  const pedido = k.tipo === 'Pedido de compra';
  const form = await dialogo(`${novo ? 'Novo' : 'Editar'} ${k.tipo.toLowerCase()}`, `
    <div class="grid-form">
      <label class="field">Número<input name="numero" value="${esc(k.numero || '')}"></label>
      <label class="field">Fornecedor<input name="fornecedor" required list="lista-fornecedores" autocomplete="off" value="${esc(k.fornecedor || '')}">${datalistFornecedores()}</label>
      <label class="field">Categoria<select name="categoria">${CATEGORIAS_CUSTO.map((x) => `<option ${x === k.categoria ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field">Valor (R$)<input name="valor" inputmode="decimal" required value="${k.valor != null ? fmtIn(k.valor, 2) : ''}"></label>
      <label class="field">Status<select name="status">${STATUS_COMP.map((x) => `<option ${x === k.status ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field">Data<input type="date" name="data" value="${k.data || todayISO()}"></label>
      ${pedido ? `<label class="field">Necessário na obra em<input type="date" name="dataNecessaria" value="${k.dataNecessaria || ''}"></label>
      <label class="field">Quantidade<input name="quantidade" inputmode="decimal" value="${k.quantidade != null ? fmtIn(k.quantidade, 4) : ''}"></label>
      <label class="field">Unidade<input name="unidade" list="unidades" value="${esc(k.unidade || '')}"></label>
      <label class="field">Quantidade recebida<input name="quantidadeRecebida" inputmode="decimal" value="${k.quantidadeRecebida != null ? fmtIn(k.quantidadeRecebida, 4) : ''}"></label>` : ''}
    </div>
    <label class="field">Objeto / descrição<input name="objeto" value="${esc(k.objeto || '')}"></label>
    <div class="grid-form">
      <label class="field">Fase da EAP (opcional)<select name="faseId">${opcoesFases(o, k.faseId)}</select></label>
      <label class="field">Item do orçamento relacionado<select name="itemId">${opcoesItens(o, c.calc, k.itemId)}</select></label>
    </div>
    <div class="muted small">Custos por fase: vale a fase informada; sem fase, o item do orçamento (pelos vínculos com a EAP).</div>
    <fieldset><legend>Aditivos</legend><div data-lista="ad">${(k.aditivos || []).map((a) => `<div class="row lin"><input type="date" name="adData" value="${a.data || ''}" style="width:auto"><input name="adValor" inputmode="decimal" placeholder="Valor (+/−)" value="${fmtIn(a.valor, 2)}" style="width:130px"><input name="adDesc" placeholder="Descrição" value="${esc(a.descricao || '')}" style="flex:1"><button type="button" class="icon-btn danger rm">${I.trash}</button></div>`).join('')}</div><button type="button" class="btn sm" data-add="ad">${I.plus} Aditivo</button></fieldset>
    ${!novo ? `<label class="check"><input type="checkbox" name="excluir"> Excluir este registro</label>` : ''}`, {
    largo: true,
    montar: (form) => form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) form.querySelector('[data-lista="ad"]').insertAdjacentHTML('beforeend', `<div class="row lin"><input type="date" name="adData" value="${todayISO()}" style="width:auto"><input name="adValor" inputmode="decimal" placeholder="Valor (+/−)" style="width:130px"><input name="adDesc" placeholder="Descrição" style="flex:1"><button type="button" class="icon-btn danger rm">${I.trash}</button></div>`);
      const rm = e.target.closest('.rm'); if (rm) rm.closest('.lin').remove();
    }),
  });
  if (!form) return;
  const fd = new FormData(form);
  if (fd.has('excluir')) {
    if ((o.despesas || []).some((d) => d.compromissoId === k.id) && !(await ask('Há despesas vinculadas a este registro. Elas ficarão sem vínculo. Excluir mesmo assim?', 'Excluir'))) return;
    o.compromissos = o.compromissos.filter((x) => x.id !== k.id);
    o.despesas.forEach((d) => { if (d.compromissoId === k.id) d.compromissoId = null; });
    registrar(o, `${k.tipo} excluído`, `${k.numero || ''} ${k.fornecedor || ''}`, usuario());
    return commit(o);
  }
  Object.assign(k, {
    numero: fd.get('numero').trim(), fornecedor: fd.get('fornecedor').trim(), fornecedorId: idDoFornecedorPorNome(fd.get('fornecedor')), categoria: fd.get('categoria'), valor: parseNum(fd.get('valor')) || 0,
    status: fd.get('status'), data: fd.get('data'), objeto: fd.get('objeto').trim(), itemId: fd.get('itemId') || null, faseId: fd.get('faseId') || null,
    aditivos: [...form.querySelectorAll('[data-lista="ad"] .lin')].map((l) => ({ data: l.querySelector('[name=adData]').value, valor: parseNum(l.querySelector('[name=adValor]').value) || 0, descricao: l.querySelector('[name=adDesc]').value.trim() })).filter((a) => a.valor),
  });
  if (pedido) Object.assign(k, { dataNecessaria: fd.get('dataNecessaria'), quantidade: parseNum(fd.get('quantidade')), unidade: fd.get('unidade'), quantidadeRecebida: parseNum(fd.get('quantidadeRecebida')) });
  if (novo) o.compromissos.push(k);
  registrar(o, `${k.tipo} ${novo ? 'registrado' : 'alterado'}`, `${k.numero || ''} ${k.fornecedor} — ${fmtBRL(totalCompromisso(k))}`, usuario());
  commit(o);
}

async function dialogoDespesa(o, c, d, novo) {
  const form = await dialogo(`${novo ? 'Nova' : 'Editar'} despesa`, `
    <div class="grid-form">
      <label class="field">Data<input type="date" name="data" required value="${d.data || todayISO()}"></label>
      <label class="field">Documento (NF, recibo…)<input name="documento" value="${esc(d.documento || '')}"></label>
      <label class="field">Fornecedor<input name="fornecedor" required list="lista-fornecedores" autocomplete="off" value="${esc(d.fornecedor || '')}">${datalistFornecedores()}</label>
      <label class="field">Valor (R$)<input name="valor" inputmode="decimal" required value="${d.valor != null ? fmtIn(d.valor, 2) : ''}"></label>
      <label class="field">Categoria<select name="categoria">${CATEGORIAS_CUSTO.map((x) => `<option ${x === d.categoria ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field">Vencimento<input type="date" name="vencimento" value="${d.vencimento || ''}"></label>
    </div>
    <label class="field">Descrição<input name="descricao" value="${esc(d.descricao || '')}"></label>
    <label class="field">Contrato/pedido relacionado (evita contar duas vezes)<select name="compromissoId"><option value="">— sem contrato/pedido —</option>${(o.compromissos || []).map((k) => `<option value="${k.id}" ${k.id === d.compromissoId ? 'selected' : ''}>${esc(k.tipo)} ${esc(k.numero || '')} ${esc(k.fornecedor || '')}</option>`).join('')}</select></label>
    <div class="grid-form">
      <label class="field">Fase da EAP (opcional)<select name="faseId">${opcoesFases(o, d.faseId)}</select></label>
      <label class="field">Item do orçamento<select name="itemId">${opcoesItens(o, c.calc, d.itemId)}</select></label>
    </div>
    <div class="muted small">Custos por fase: vale a fase informada; sem fase, o item do orçamento, depois o contrato/pedido; sem nenhum, fica em "Sem fase".</div>
    <fieldset><legend>Pagamentos</legend><div data-lista="pg">${(d.pagamentos || []).map((p) => `<div class="row lin"><input type="date" name="pgData" value="${p.data || ''}" style="width:auto"><input name="pgValor" inputmode="decimal" value="${fmtIn(p.valor, 2)}" style="width:140px"><button type="button" class="icon-btn danger rm">${I.trash}</button></div>`).join('')}</div><button type="button" class="btn sm" data-add="pg">${I.plus} Pagamento</button></fieldset>
    ${!novo ? `<label class="check"><input type="checkbox" name="excluir"> Excluir esta despesa</label>` : ''}`, {
    largo: true,
    montar: (form) => {
      // ao escolher o contrato/pedido, sugere a categoria, o fornecedor e o item do orçamento dele
      form.compromissoId.addEventListener('change', () => {
        const k = (o.compromissos || []).find((x) => x.id === form.compromissoId.value);
        if (!k) return;
        if (k.categoria) form.categoria.value = k.categoria;
        if (k.fornecedor && !form.fornecedor.value.trim()) form.fornecedor.value = k.fornecedor;
        if (k.itemId && !form.itemId.value) form.itemId.value = k.itemId;
        if (k.faseId && !form.faseId.value) form.faseId.value = raizId(c, c.porId.get(k.faseId) || { id: k.faseId, parentId: null });
      });
      form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) {
        const falta = (parseNum(form.valor.value) || 0) - [...form.querySelectorAll('[name=pgValor]')].reduce((s, x) => s + (parseNum(x.value) || 0), 0);
        form.querySelector('[data-lista="pg"]').insertAdjacentHTML('beforeend', `<div class="row lin"><input type="date" name="pgData" value="${todayISO()}" style="width:auto"><input name="pgValor" inputmode="decimal" value="${falta > 0 ? fmtIn(falta, 2) : ''}" style="width:140px"><button type="button" class="icon-btn danger rm">${I.trash}</button></div>`);
      }
      const rm = e.target.closest('.rm'); if (rm) rm.closest('.lin').remove();
      });
    },
  });
  if (!form) return;
  const fd = new FormData(form);
  if (fd.has('excluir')) {
    o.despesas = o.despesas.filter((x) => x.id !== d.id);
    registrar(o, 'Despesa excluída', `${d.documento || ''} ${d.fornecedor || ''} — ${fmtBRL(d.valor)}`, usuario());
    return commit(o);
  }
  const nova = {
    ...d, data: fd.get('data'), documento: fd.get('documento').trim(), fornecedor: fd.get('fornecedor').trim(), fornecedorId: idDoFornecedorPorNome(fd.get('fornecedor')), valor: parseNum(fd.get('valor')) || 0,
    categoria: fd.get('categoria'), vencimento: fd.get('vencimento'), descricao: fd.get('descricao').trim(), compromissoId: fd.get('compromissoId') || null, itemId: fd.get('itemId') || null,
    faseId: fd.get('faseId') || null,
    pagamentos: [...form.querySelectorAll('[data-lista="pg"] .lin')].map((l) => ({ data: l.querySelector('[name=pgData]').value, valor: parseNum(l.querySelector('[name=pgValor]').value) || 0 })).filter((p) => p.valor),
  };
  if (pagoDespesa(nova) > nova.valor + 0.005) return toast('Os pagamentos passam do valor da despesa.', 5000);
  const dup = despesaDuplicada(o, nova);
  if (dup && !(await ask(`Parece duplicada: já existe ${dup.documento || 'uma despesa'} de ${dup.fornecedor} em ${isoBR(dup.data)} (${fmtBRL(dup.valor)}). Lançar mesmo assim?`, 'Lançar'))) return;
  if (novo) o.despesas.push(nova); else Object.assign(d, nova);
  registrar(o, `Despesa ${novo ? 'lançada' : 'alterada'}`, `${nova.documento || ''} ${nova.fornecedor} — ${fmtBRL(nova.valor)}`, usuario());
  commit(o);
}

/* ---------- ações ---------- */
export const acoesGestao = {
  medir(d) { const o = obraAtual(); const c = contexto(o); dialogoMedir(o, c, o.eap.find((a) => a.id === d.id)); },
  medHist(d) {
    const o = obraAtual(); const a = o.eap.find((x) => x.id === d.id);
    const ms = medicoesDe(o, a.id);
    info(`Medições — ${a.codigo} ${a.descricao}`, `<div class="table-wrap"><table class="data"><thead><tr><th>Data</th><th class="num">Acumulado</th><th class="num">%</th><th>Obs.</th><th>Responsável</th><th></th></tr></thead><tbody>
      ${ms.map((m) => `<tr><td>${isoBR(m.data)}</td><td class="num">${m.metodo === 'quantidade' ? `${fmtNum(m.qtdAcum, 2)} ${esc(m.unidade)}` : '—'}</td><td class="num">${fmtNum(m.pct, 1)}%</td><td class="small">${esc(m.obs || '')}</td><td class="small">${esc(m.responsavel || '')}</td>
        <td><button type="button" class="icon-btn danger" data-del-med="${m.id}" title="Excluir">${I.trash}</button></td></tr>`).join('')}</tbody></table></div>`);
    document.getElementById('dlg').querySelectorAll('[data-del-med]').forEach((b) => {
      b.onclick = async () => {
        document.getElementById('dlg').close();
        if (!(await ask('Excluir esta medição? O avanço passa a ser o da medição anterior.', 'Excluir'))) return;
        removerMedicao(o, b.dataset.delMed, usuario()); commit(o);
      };
    });
  },
  custosLimpar() { ui.custosAte = ''; ui.custosCat = ''; queueRender(); },
  diarioAbrir(d) { location.hash = `#/diario/${d.obra}/rdo/${d.id}`; },
  compNovo(d) { const o = obraAtual(); dialogoCompromisso(o, contexto(o), { id: uid(), tipo: d.t, status: d.t === 'Contrato' ? 'Aprovado' : 'Em cotação', categoria: d.t === 'Contrato' ? 'Serviço terceirizado' : 'Material', aditivos: [] }, true); },
  compEditar(d) { const o = obraAtual(); dialogoCompromisso(o, contexto(o), o.compromissos.find((x) => x.id === d.id), false); },
  despNova() { const o = obraAtual(); dialogoDespesa(o, contexto(o), { id: uid(), categoria: 'Material', pagamentos: [] }, true); },
  despEditar(d) { const o = obraAtual(); dialogoDespesa(o, contexto(o), o.despesas.find((x) => x.id === d.id), false); },
};

export const mudancasGestao = {
  painelEtapa(d, el) { ui.painelEtapa = el.value; queueRender(); },
  custosAte(d, el) { ui.custosAte = el.value; queueRender(); },
  custosCat(d, el) { ui.custosCat = el.value; queueRender(); },
  medSoPeriodo(d, el) { ui.medSoPeriodo = el.checked; queueRender(); },
};
