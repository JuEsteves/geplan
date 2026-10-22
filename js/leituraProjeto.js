// Leitura de projeto com IA: a pessoa envia os PDFs do projeto, a IA (Edge Function "ler-projeto", com a chave só no
// servidor) sugere quais etapas e subetapas do modelo de etapas se aplicam e o que falta; a pessoa revisa e só então a
// EAP é montada na obra. Depois disso a EAP é editável como qualquer outra (incluir, excluir, mover, renomear).
//
// Regras (puras, testáveis): etapasParaIA, selecaoDaSugestao, aplicarSugestao.
import * as store from './store.js';
import { configurado as nuvemConfigurada, sb, erroBanco } from './nuvem/supabase.js';
import * as nuvem from './nuvem/nuvem.js';
import { enviarArquivo, tamanhoLegivel } from './nuvem/arquivos.js';
import { pode } from './permissoes.js';
import { etapasDoModelo, instanciarModelo, modeloInicial } from './importador.js';
import { novaAtividade, renumerar, registrar } from './model.js';
import { esc, I, toast, commit } from './ui.js';
import { isoBR } from './schedule.js';
import { usuario } from './gestao.js';

const TIPO_PDF = { 'application/pdf': 'PDF' };
const MAX_ARQUIVO = 24 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024;

/** A leitura com IA pode ser usada aqui? { ok, motivo } */
export function leituraDisponivel() {
  if (!nuvemConfigurada() || !nuvem.ativo()) return { ok: false, motivo: 'A leitura de projeto com IA funciona no modo nuvem (entre com a sua conta da empresa).' };
  if (!pode('planejamento')) return { ok: false, motivo: 'Seu perfil não monta a EAP das obras.' };
  return { ok: true, motivo: '' };
}

/* ---------- regras ---------- */

/** Lista enviada à IA: etapas e subetapas do modelo (código e nome). */
export function etapasParaIA(M) {
  return etapasDoModelo(M).filter((e) => !e.variante).map((e) => ({ codigo: e.codigo, nome: e.nome, subetapas: e.subetapas.map((s) => ({ codigo: s.codigo, nome: s.nome })) }));
}

/** Seleção inicial (o que a IA marcou para incluir), por id do modelo. Códigos desconhecidos são ignorados. */
export function selecaoDaSugestao(M, sug) {
  const porCodigo = new Map(M.eap.map((a) => [a.codigo, a]));
  const etapas = new Set(), subetapas = new Set();
  for (const e of sug?.etapas || []) {
    const ne = porCodigo.get(String(e.codigo));
    if (!ne || ne.parentId) continue;
    const subs = (e.subetapas || []).filter((s) => s.incluir).map((s) => porCodigo.get(String(s.codigo))).filter((n) => n && n.parentId === ne.id);
    if (e.incluir || subs.length) { etapas.add(ne.id); subs.forEach((n) => subetapas.add(n.id)); }
  }
  return { etapas, subetapas };
}

/**
 * Monta a EAP na obra com o que a pessoa confirmou: etapas/subetapas do modelo (com atividades e predecessoras) e as
 * subetapas novas sugeridas (como atividades dentro da etapa indicada ou de uma etapa nova). Devolve um resumo.
 */
export function aplicarSugestao(obra, M, sel, novas, lib) {
  const antes = obra.eap.length;
  if (sel.etapas.size) instanciarModelo(obra, M, sel, { orcamento: false }, lib);
  const porCodigoModelo = new Map(M.eap.map((a) => [a.codigo, a.id]));
  const naObra = (modeloAtivId) => obra.eap.find((a) => a.modeloId === M.id && a.modeloAtivId === modeloAtivId);
  let criadas = 0;
  for (const n of novas) {
    let etapa = n.etapa_codigo ? naObra(porCodigoModelo.get(String(n.etapa_codigo))) : null;
    if (!etapa) {
      const nome = (n.etapa_nova || '').trim() || 'Serviços complementares';
      etapa = obra.eap.find((a) => !a.parentId && a.descricao.trim().toLowerCase() === nome.toLowerCase());
      if (!etapa) { etapa = novaAtividade({ descricao: nome, etapa: nome }); obra.eap.push(etapa); }
    }
    obra.eap.push(novaAtividade({ parentId: etapa.id, descricao: String(n.nome).trim(), etapa: etapa.descricao, tipo: 'Execução',
      obs: `Sugerida pela leitura do projeto${n.motivo ? `: ${n.motivo}` : ''}${n.paginas ? ` (${n.paginas})` : ''}` }));
    criadas++;
  }
  renumerar(obra);
  return { adicionadas: obra.eap.length - antes, novas: criadas };
}

/* ---------- interface ---------- */
const dlg = () => document.getElementById('dlg');
function janela(html, montar) {
  const d = dlg();
  d.innerHTML = html;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); resolve(v); };
    const form = d.querySelector('form');
    form.onsubmit = (e) => { e.preventDefault(); finish(e.submitter?.value === 'ok' ? form : null); };
    d.querySelectorAll('[value="cancel"]').forEach((b) => { b.onclick = () => finish(null); });
    d.oncancel = () => finish(null); d.onclose = () => { if (!d.open) finish(null); };
    montar?.(form, finish);
    d.showModal();
  });
}

async function ultimaLeitura(obraId) {
  const c = await sb();
  const { data, error } = await c.from('project_ai_reads').select('*').eq('project_id', obraId).order('created_at', { ascending: false }).limit(1);
  if (error) throw erroBanco(error, 'leituras');
  return data?.[0] || null;
}

/** Fluxo completo: escolher PDFs → enviar → acompanhar a leitura → revisar → montar a EAP. */
export async function lerProjeto(o) {
  const disp = leituraDisponivel();
  if (!disp.ok) return toast(disp.motivo, 6000);
  const c = await sb();
  let anterior = null, uso = null;
  try {
    [anterior, uso] = await Promise.all([ultimaLeitura(o.id).catch(() => null), c.rpc('ia_uso_obra', { p_project: o.id }).then((r) => r.data).catch(() => null)]);
  } catch {}
  if (anterior?.status === 'concluida' || anterior?.status === 'processando') {
    const escolha = await janela(`<form method="dialog"><h2>Leitura de projeto</h2>
      <p style="margin-top:10px">Já existe uma leitura ${anterior.status === 'processando' ? '<b>em andamento</b>' : 'concluída e ainda não aplicada'} desta obra (${esc(isoBR(anterior.created_at.slice(0, 10)))}, ${esc((anterior.files || []).map((f) => f.name).join(', '))}).</p>
      <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn" value="ok" name="op" data-op="nova">Nova leitura</button><button class="btn primary" value="ok" data-op="usar">${anterior.status === 'processando' ? 'Acompanhar' : 'Revisar essa sugestão'}</button></div></form>`,
    (form, finish) => form.querySelectorAll('[data-op]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); finish(b.dataset.op); }; }));
    if (!escolha) return;
    if (escolha === 'usar') return acompanhar(o, anterior.id);
  }
  const form = await janela(`<form method="dialog"><h2>Ler o projeto com IA</h2>
    <div class="stack" style="margin-top:12px">
      <p style="margin:0">Envie os PDFs do projeto (arquitetura, estrutura, instalações, memorial descritivo). A IA sugere as <b>etapas e subetapas</b> da EAP a partir do modelo de etapas — você revisa antes de entrar na obra.</p>
      <label class="field">Arquivos PDF (até 10, somando até 24 MB)<input type="file" name="arquivos" accept="application/pdf,.pdf" multiple required></label>
      <div class="muted small">Projetos em DWG: exporte as pranchas para PDF no programa de desenho (Imprimir/Plotar › PDF). Os arquivos ficam guardados na pasta privada da obra e são enviados à IA da Anthropic só para esta leitura.${uso ? ` Leituras da empresa neste mês: <b>${uso.uso} de ${uso.limite}</b>.` : ''}</div>
    </div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${I.upload} Enviar e ler</button></div></form>`);
  if (!form) return;
  const files = [...form.arquivos.files];
  try {
    if (!files.length) throw new Error('Escolha pelo menos um PDF.');
    if (files.length > 10) throw new Error('No máximo 10 arquivos por leitura.');
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_TOTAL) throw new Error(`Os arquivos somam ${tamanhoLegivel(total)}; o limite por leitura é 24 MB. Envie as pranchas principais.`);
    for (const f of files) if (!/\.pdf$/i.test(f.name)) throw new Error(`${f.name}: envie apenas PDF.`);
  } catch (e) { return toast(e.message, 6000); }

  progresso('Preparando a obra na nuvem…');
  try {
    await nuvem.enviar();   // a obra precisa existir no banco para receber os arquivos
    const ctx = nuvem.contexto();
    const enviados = [];
    for (const [i, f] of files.entries()) {
      progresso(`Enviando ${i + 1} de ${files.length}: ${f.name}…`);
      const file = f.type ? f : new File([f], f.name, { type: 'application/pdf' });
      enviados.push({ path: await enviarArquivo(ctx.orgId, 'obras', o.id, file, MAX_ARQUIVO, TIPO_PDF), name: f.name, size: f.size });
    }
    progresso('Pedindo a leitura à IA…');
    const M = modeloInicial(store.lib());
    const { data, error } = await c.functions.invoke('ler-projeto', { body: { projectId: o.id, files: enviados, etapas: etapasParaIA(M), obra: { nome: o.nome } } });
    if (error) {
      let msg = error.message;
      try { const corpo = await error.context?.json?.(); if (corpo?.erro) msg = corpo.erro; } catch {}
      if (/not found|404|Failed to send/i.test(msg)) msg = 'A leitura com IA ainda não foi ativada no servidor (função "ler-projeto" no Supabase).';
      throw new Error(msg);
    }
    if (data?.erro) throw new Error(data.erro);
    await acompanhar(o, data.leituraId);
  } catch (e) {
    fecharProgresso();
    toast(e.message || String(e), 8000);
  }
}

function progresso(texto) {
  const d = dlg();
  if (!d.open || !d.querySelector('[data-progresso]')) {
    d.innerHTML = `<form method="dialog"><h2>Leitura de projeto</h2><p data-progresso style="margin:14px 0 4px"></p>
      <div class="progress"><div style="width:100%" class="indeterminado"></div></div>
      <p class="muted small">Pode levar alguns minutos em projetos grandes. Você pode fechar esta janela: a leitura continua e fica disponível em "Ler projeto".</p>
      <div class="actions"><button type="button" class="btn" value="cancel" data-fechar>Fechar</button></div></form>`;
    d.querySelector('[data-fechar]').onclick = () => d.close();
    if (!d.open) d.showModal();
  }
  d.querySelector('[data-progresso]').textContent = texto;
}
const fecharProgresso = () => { const d = dlg(); if (d.open && d.querySelector('[data-progresso]')) d.close(); };

async function acompanhar(o, leituraId) {
  const c = await sb();
  const inicio = Date.now();
  for (;;) {
    const { data, error } = await c.from('project_ai_reads').select('*').eq('id', leituraId).maybeSingle();
    if (error) { fecharProgresso(); return toast(erroBanco(error, 'leitura').message, 6000); }
    if (data?.status === 'concluida') { fecharProgresso(); return revisar(o, data); }
    if (data?.status === 'aplicada') { fecharProgresso(); return toast('Essa leitura já foi aplicada à EAP.'); }
    if (data?.status === 'erro') { fecharProgresso(); return toast(`A leitura não foi concluída: ${data.error || 'erro desconhecido'}`, 9000); }
    const d = dlg();
    if (!d.open && Date.now() - inicio > 3000) return toast('A leitura continua em segundo plano. Abra "Ler projeto" de novo para ver o resultado.', 6000);
    if (Date.now() - inicio > 8 * 60000) { fecharProgresso(); return toast('A leitura está demorando mais que o normal. Tente abrir de novo em alguns minutos.', 8000); }
    progresso(`Lendo o projeto… (${Math.round((Date.now() - inicio) / 1000)} s)`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/** Tela de revisão: etapas/subetapas do modelo marcadas conforme a IA, com motivo e páginas; novas sugestões. */
async function revisar(o, leitura) {
  const lib = store.lib();
  const M = modeloInicial(lib);
  const sug = leitura.result || {};
  const sel = selecaoDaSugestao(M, sug);
  const porCodigo = new Map((sug.etapas || []).flatMap((e) => [[String(e.codigo), e], ...(e.subetapas || []).map((s) => [String(s.codigo), s])]));
  const nota = (codigo) => { const x = porCodigo.get(String(codigo)); return x ? `<span class="muted small">${esc(x.motivo || '')}${x.paginas ? ` · ${esc(x.paginas)}` : ''}</span>` : '<span class="muted small">não avaliada</span>'; };
  const etapas = etapasDoModelo(M).filter((e) => !e.variante);
  const dados = sug.dados_obra || {};
  const lista = etapas.map((e) => `<div class="fase"><label class="check"><input type="checkbox" name="e" value="${esc(e.id)}" ${sel.etapas.has(e.id) ? 'checked' : ''}> <b>${esc(e.codigo)}</b> ${esc(e.nome)}</label> ${nota(e.codigo)}
    ${e.subetapas.length ? `<details class="fase-subs" ${sel.etapas.has(e.id) ? 'open' : ''}><summary>${e.subetapas.filter((s) => sel.subetapas.has(s.id)).length} de ${e.subetapas.length} subetapa(s)</summary>
      ${e.subetapas.map((s) => `<label class="check"><input type="checkbox" name="s" value="${esc(s.id)}" data-etapa="${esc(e.id)}" ${sel.subetapas.has(s.id) ? 'checked' : ''}> <span class="muted">${esc(s.codigo)}</span> ${esc(s.nome)}<br>${nota(s.codigo)}</label>`).join('')}</details>` : ''}</div>`).join('');
  const novas = (sug.novas || []).map((n, i) => `<label class="check"><input type="checkbox" name="n" value="${i}" checked> <b>${esc(n.nome)}</b> <span class="muted small">→ ${esc(n.etapa_codigo ? `etapa ${n.etapa_codigo}` : `nova etapa "${n.etapa_nova || 'Serviços complementares'}"`)} · ${esc(n.motivo || '')}${n.paginas ? ` · ${esc(n.paginas)}` : ''}</span></label>`).join('');
  const num = (v, u) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR')}${u}`);
  const form = await janela(`<form method="dialog" class="dlg-wide"><h2>Sugestão de EAP — revise antes de montar</h2>
    <div class="stack" style="margin-top:10px">
      <div class="alert info small">Sugestão gerada por IA a partir de ${esc((leitura.files || []).map((f) => f.name).join(', '))}. <b>Confira</b>: marque e desmarque à vontade. Depois de montada, a EAP pode ser editada livremente.</div>
      ${sug.resumo ? `<p style="margin:0">${esc(sug.resumo)}</p>` : ''}
      <div class="small muted">${[dados.tipo, `área construída ${num(dados.area_construida_m2, ' m²')}`, `terreno ${num(dados.area_terreno_m2, ' m²')}`, `pavimentos ${dados.pavimentos ?? '—'}`, dados.sistema_construtivo, dados.fundacao && `fundação: ${dados.fundacao}`, dados.cobertura && `cobertura: ${dados.cobertura}`].filter(Boolean).map(esc).join(' · ')}${(dados.itens_especiais || []).length ? `<br>Itens especiais: ${esc(dados.itens_especiais.join(', '))}` : ''}</div>
      ${(sug.alertas || []).length ? `<div class="alert warn small"><b>Para conferir:</b><ul style="margin:4px 0 0;padding-left:18px">${sug.alertas.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      <h3 style="margin:6px 0 0">Etapas do modelo "${esc(M.nome)}"</h3>
      <div class="fases" style="max-height:44vh;overflow:auto">${lista}</div>
      ${novas ? `<h3 style="margin:6px 0 0">Serviços do projeto que não estão no modelo</h3><div class="stack">${novas}</div>` : ''}
    </div>
    <div class="actions"><button type="button" class="btn" value="cancel">Agora não</button><button class="btn primary" value="ok">Montar a EAP</button></div></form>`,
  (f) => f.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'e') f.querySelectorAll(`input[name="s"][data-etapa="${CSS.escape(t.value)}"]`).forEach((s) => { s.checked = t.checked; });
    if (t.name === 's' && t.checked) { const e = f.querySelector(`input[name="e"][value="${CSS.escape(t.dataset.etapa)}"]`); if (e) e.checked = true; }
  }));
  if (!form) return;
  const escolha = { etapas: new Set(), subetapas: new Set() };
  form.querySelectorAll('input[name="e"]:checked').forEach((x) => escolha.etapas.add(x.value));
  form.querySelectorAll('input[name="s"]:checked').forEach((x) => { escolha.subetapas.add(x.value); escolha.etapas.add(x.dataset.etapa); });
  const novasEscolhidas = [...form.querySelectorAll('input[name="n"]:checked')].map((x) => sug.novas[Number(x.value)]);
  if (!escolha.etapas.size && !novasEscolhidas.length) return toast('Nada marcado: a EAP não foi alterada.');
  const r = aplicarSugestao(o, M, escolha, novasEscolhidas, lib);
  o.dadosProjeto = { ...dados, resumo: sug.resumo || '', lidoEm: leitura.created_at, arquivos: (leitura.files || []).map((f) => f.name) };
  registrar(o, 'EAP montada a partir da leitura do projeto', `${r.adicionadas} item(ns) na EAP (${r.novas} sugerido(s) fora do modelo)`, usuario());
  commit(o);
  (await sb()).rpc('ia_marcar_aplicada', { p_id: leitura.id }).then(() => {}, () => {});
  toast(`EAP montada: ${r.adicionadas} item(ns). Revise durações, predecessoras e responsáveis na aba Atividades.`, 7000);
}
