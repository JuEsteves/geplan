// Administração › Configurações: reúne os ajustes que valem para todas as obras (já existentes no app).
import * as store from './store.js';
import { esc, I } from './ui.js';
import { isoBR, toDay, weekday } from './schedule.js';
import { pode } from './permissoes.js';
import { configurado as nuvemConfigurada } from './nuvem/supabase.js';
import { secaoCategorias } from './fornecedores.js';

export function viewConfiguracoes() {
  const lib = store.lib();
  const editar = pode('biblioteca');
  const modelos = lib.modelosEAP || [];
  const padrao = modelos.find((m) => m.id === lib.modeloPadraoId);
  const feriados = [...(lib.feriadosGlobais || [])].sort((a, b) => a.data.localeCompare(b.data));
  const nuvem = nuvemConfigurada();
  return `<div class="page-head"><div><h1>Configurações</h1><div class="muted">Ajustes que valem para todas as obras${nuvem ? ' da empresa' : ''}.</div></div></div>
  <div class="stack" style="max-width:860px">
    <div class="card card-pad stack">
      <h2>Feriados gerais</h2>
      <p class="muted small" style="margin:0">Valem para todas as obras com calendário em dias úteis. Feriados de uma obra só (municipais, por exemplo) ficam no Cadastro da obra.</p>
      ${editar ? `<div class="row"><input type="date" id="ferGData" style="width:auto"><input id="ferGDesc" placeholder="Descrição" style="flex:1;min-width:160px" data-enter="addFeriadoGeral"><button class="btn" data-act="addFeriadoGeral">${I.plus} Adicionar</button></div>` : ''}
      <div class="hol-list">${feriados.length ? feriados.map((f) => `<div class="list-item"><span style="flex:1"><b>${isoBR(f.data)}</b> <span class="muted">${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][weekday(toDay(f.data))]}</span> · ${esc(f.desc || '')}</span>${editar ? `<button class="icon-btn danger" data-act="delFeriadoGeral" data-d="${f.data}" title="Remover">${I.trash}</button>` : ''}</div>`).join('') : '<div class="muted small">Nenhum feriado geral cadastrado.</div>'}</div>
    </div>
    <div class="card card-pad stack">
      <h2>Modelo inicial de fases (EAP)</h2>
      <p style="margin:0">${padrao ? `Novas obras começam pelo modelo <b>${esc(padrao.nome)}</b>.` : modelos.length ? 'Nenhum modelo marcado como inicial.' : 'Nenhum modelo cadastrado ainda: importe a planilha modelo.'}</p>
      <div class="row"><a class="btn" href="#/fases">Abrir EAP e fases</a>${modelos.length ? '' : `<a class="btn" href="#/importar">${I.upload} Importar planilha</a>`}</div>
    </div>
    <div class="card card-pad stack">
      <h2>Composições e base SINAPI</h2>
      <p class="muted small" style="margin:0">${(lib.composicoes || []).length} composição(ões) na biblioteca. A base SINAPI é importada da planilha mensal da Caixa e fica neste aparelho.</p>
      <div class="row"><a class="btn" href="#/composicoes">Composições</a><a class="btn" href="#/sinapi">Base SINAPI</a></div>
    </div>
    ${secaoCategorias()}
    <div class="card card-pad stack">
      <h2>Exportar dados</h2>
      <p class="muted small" style="margin:0">Arquivo JSON com as obras que você vê e a biblioteca (composições, feriados e modelos de EAP). ${nuvem ? 'É uma cópia para conferência e portabilidade; o backup oficial é o do banco de dados.' : 'Use também para levar os dados a outro aparelho.'}</p>
      <div class="row"><button class="btn" data-act="backupExport">Baixar dados (.json)</button></div>
    </div>
  </div>`;
}
