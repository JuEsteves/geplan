// Testes obrigatórios (valores da planilha modelo, jornada 8,8 h e eficiência 0,85).
import { calcular, duracaoCalculada, validarComposicao } from '../js/calculo.js';
import { cronograma, Calendario, criaCiclo } from '../js/cpm.js';
import { parseNotacao, formatNotacao, resolverNotacao } from '../js/predecessoras.js';
import { novaObra, novaAtividade, novoItem, emptyLib, migrateLib, migrateObra, renumerar, uid } from '../js/model.js';
import { curvaS, pesosPerfil, distribuicao, pctRealAte } from '../js/curvaS.js';
import { registrarMedicao } from '../js/execucao.js';
import { bdiTCU, resumoOrcamento, snapshotOrcamento, compararOrcamento, resumoCustos, custosPorFase, despesaDuplicada, valorAgregado } from '../js/financeiro.js';
import { toDay, fmtBR } from '../js/schedule.js';
import { interpretar, criarObraImportada, etapasDoModelo, selecaoPadrao, instanciarModelo, duplicarModelo, modeloBase, modelosDisponiveis, modeloInicial, MODELO_BASE_UUID } from '../js/importador.js';
import { moverNo, subarvore } from '../js/model.js';
import { etapasParaIA, selecaoDaSugestao, aplicarSugestao } from '../js/leituraProjeto.js';
import { criarObraExemplo } from '../js/obraExemplo.js';
import { interpretarReferenciaSinapi, custoEm, maoDeObraItens, nomeVersao, variacao } from '../js/basesRefDados.js';
import { interpretarSinapi, maoDeObra, adicionarDaSinapi } from '../js/sinapi.js';
import { LIBS, loadScript } from '../js/libs.js';
import { sugerirMapeamento, validarLinhas, aplicarImportacao } from '../js/orcImport.js';
import { pedidosDaObra, consolidado } from '../js/indicadores.js';
import { docValido, formatarDoc } from '../js/validacao.js';
import { filtrarFornecedores, historicoFornecedor } from '../js/fornecedores.js';
import { liberacoesDe, LIBERACOES_PADRAO } from '../js/liberacoes.js';
import { novoDiario, salvarDiario, periodoRdo, diasDaSemanaRdo, prazosObra, filtrarDiario } from '../js/execucao.js';
import { obraParaLinhas, linhasParaObra } from '../js/nuvem/mapa.js';
import { valorLinha, conferirProducao, vinculoVigente, previaAcumulado, situacaoPagamento, linhasResumo, somarPor } from '../js/medicoesRegras.js';
import { podeGravar, fotografar, diferencas } from '../js/nuvem/sincronizar.js';
import { comparativoCotacoes, indicadoresEntrega, validarItens, situacaoPedido, recebidoPorItem, itensComSaldo, pendenciasPedido,
  resumoPedido, filtrarPedidos, numeroPedido, etapaGrupo, painelPorObra } from '../js/suprimentosRegras.js';

const out = document.getElementById('out');
let ok = 0, fail = 0, skip = 0;
const grupo = (t) => out.insertAdjacentHTML('beforeend', `<h2>${t}</h2>`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function teste(nome, fn) {
  try {
    const r = fn();
    if (r === 'skip') { skip++; out.insertAdjacentHTML('beforeend', `<div class="t skip"><b>—</b>${esc(nome)}</div>`); return; }
    ok++; out.insertAdjacentHTML('beforeend', `<div class="t ok"><b>OK</b>${esc(nome)}</div>`);
  } catch (e) {
    fail++; out.insertAdjacentHTML('beforeend', `<div class="t err"><b>FALHA</b>${esc(nome)} — <span>${esc(e.message)}</span></div>`);
  }
}
const igual = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`); };
const perto = (a, b, tol = 1e-6, msg = '') => { if (Math.abs(a - b) > tol) throw new Error(`${msg} esperado ${b}, obtido ${a}`); };
const verdade = (c, msg) => { if (!c) throw new Error(msg); };

/* ---------- dados da planilha ---------- */
function libPlanilha() {
  const lib = emptyLib();
  const C = (codigo, unidade, lider, coefL, aux, coefA) => ({
    id: codigo, codigo, descricao: codigo, unidade, fonte: 'Obra própria', versao: 1, ativa: true,
    maoObra: [{ id: uid(), funcao: lider, coef: coefL, lider: true }, { id: uid(), funcao: aux, coef: coefA, lider: false }],
  });
  lib.composicoes = [
    C('C001', 'm²', 'Carpinteiro', 1.1, 'Ajudante de carpinteiro', 0.4),
    C('C002', 'kg', 'Armador', 0.1, 'Ajudante de armador', 0.06),
    C('C003', 'm³', 'Pedreiro', 1.2, 'Servente', 2.4),
    C('C004', 'm²', 'Pedreiro', 0.85, 'Servente', 0.45),
    C('C005', 'm²', 'Pedreiro', 0.1, 'Servente', 0.05),
    C('C006', 'm²', 'Pedreiro', 0.7, 'Servente', 0.55),
    C('C007', 'm²', 'Pedreiro', 0.35, 'Servente', 0.3),
    C('C008', 'm²', 'Azulejista', 0.55, 'Servente', 0.25),
    C('C009', 'm²', 'Pintor', 0.3, 'Ajudante de pintor', 0.08),
    C('C010', 'm²', 'Pintor', 0.25, 'Ajudante de pintor', 0.05),
  ];
  return lib;
}

const ORC = [
  ['O-2.01', 'C001', 203, 95], ['O-2.02', 'C002', 850, 14.5], ['O-2.03', 'C003', 10.3, 720], ['O-3.01', 'C004', 520, 78],
  ['O-7.01', 'C005', 1040, 8], ['O-7.02', 'C006', 1040, 42], ['O-8.01', 'C007', 240, 48], ['O-11.01', 'C008', 240, 165],
  ['O-13.01', 'C009', 1040, 22], ['O-13.02', 'C010', 1040, 18],
];
const VINC = [
  ['O-2.01', '2.4.4', 1], ['O-2.02', '2.4.3', 0.6], ['O-2.02', '2.4.5', 0.4], ['O-2.03', '2.4.8', 1], ['O-3.01', '3.2.2', 0.5],
  ['O-3.01', '3.2.4', 0.5], ['O-7.01', '7.1.2', 1], ['O-7.02', '7.2.2', 1], ['O-8.01', '8.1.4', 1], ['O-11.01', '11.1.3', 1],
  ['O-13.01', '13.1.3', 0.5], ['O-13.01', '13.1.4', 0.5], ['O-13.02', '13.1.6', 0.5], ['O-13.02', '13.1.7', 0.5],
];
// código, tipo, equipe, duração manual, duração adotada esperada (coluna J da planilha)
const ATIV = [
  ['2.4.3', 'Execução', 2, null, 4], ['2.4.4', 'Execução', 3, null, 10], ['2.4.5', 'Execução', 2, null, 3],
  ['2.4.8', 'Execução', 4, null, 1], ['2.4.9', 'Espera técnica', null, 3, 3], ['3.2.2', 'Execução', 3, null, 10],
  ['3.2.4', 'Execução', 3, null, 10], ['7.1.2', 'Execução', 3, null, 5], ['7.1.5', 'Espera técnica', null, 3, 3],
  ['7.2.2', 'Execução', 4, null, 25], ['7.2.5', 'Espera técnica', null, 7, 7], ['8.1.4', 'Execução', 2, null, 6],
  ['8.1.5', 'Espera técnica', null, 3, 3], ['11.1.3', 'Execução', 2, null, 9], ['11.1.4', 'Espera técnica', null, 2, 2],
  ['13.1.3', 'Execução', 2, null, 11], ['13.1.4', 'Execução', 2, null, 11], ['13.1.6', 'Execução', 2, null, 9], ['13.1.7', 'Execução', 2, null, 9],
];

function obraPlanilha() {
  const o = novaObra({ nome: 'Teste', inicio: '2026-10-05' });
  o.jornada = 8.8; o.eficiencia = 0.85;
  const ids = new Map();
  for (const [cod, tipo, equipe, manual] of ATIV) {
    const a = novaAtividade({ codigo: cod, nivel: 3, tipo, equipe, duracaoManual: manual, descricao: cod });
    o.eap.push(a); ids.set(cod, a.id);
  }
  const itens = new Map();
  for (const [cod, comp, qtd, cu] of ORC) { const it = novoItem({ codigo: cod, composicaoId: comp, quantidade: qtd, custoUnit: cu }); o.orcamento.push(it); itens.set(cod, it.id); }
  for (const [item, ativ, pct] of VINC) o.vinculos.push({ id: uid(), itemId: itens.get(item), atividadeId: ids.get(ativ), pct });
  return { o, ids, itens };
}

/* ---------- 1. Cálculo de HH, duração e custo ---------- */
grupo('1. Orçamento × EAP — HH, duração e custo (jornada 8,8 h, eficiência 0,85)');
const lib = libPlanilha();
const { o, ids, itens } = obraPlanilha();
const calc = calcular(o, lib);
const A = (cod) => calc.ativ.get(ids.get(cod));

teste('2.4.4 Montagem das formas: 203 m² × 1,10 h/m² = 223,3 HH; equipe 3 → 10 dias úteis', () => {
  perto(A('2.4.4').hh, 223.3, 1e-9, 'HH'); igual(A('2.4.4').durCalc, 10, 'duração calculada'); igual(A('2.4.4').dur, 10, 'duração adotada');
});
teste('7.2.2 Reboco: 1.040 m² × 0,70 = 728 HH; equipe 4 → 25 dias úteis', () => {
  perto(A('7.2.2').hh, 728, 1e-9, 'HH'); igual(A('7.2.2').dur, 25, 'duração');
});
teste('Aço O-2.02 (850 kg × 0,10 h/kg): 60% → 2.4.3 (51 HH, equipe 2 → 4 dias)', () => {
  perto(A('2.4.3').hh, 51, 1e-9, 'HH'); igual(A('2.4.3').dur, 4, 'duração');
});
teste('Aço O-2.02: 40% → 2.4.5 (34 HH, equipe 2 → 3 dias)', () => {
  perto(A('2.4.5').hh, 34, 1e-9, 'HH'); igual(A('2.4.5').dur, 3, 'duração');
});
teste('Soma do custo alocado nas atividades = total do orçamento = R$ 224.306,00', () => {
  perto(calc.totalOrcamento, 224306, 1e-6, 'total do orçamento'); perto(calc.totalAlocado, 224306, 1e-6, 'custo alocado');
  perto([...calc.ativ.values()].reduce((s, x) => s + x.custo, 0), 224306, 1e-6, 'Σ custo das atividades');
});
teste('Todas as durações adotadas iguais à coluna J da planilha (Σ = 141 dias)', () => {
  let soma = 0;
  for (const [cod, , , , esperado] of ATIV) { igual(A(cod).dur, esperado, `${cod}:`); soma += A(cod).dur; }
  igual(soma, 141, 'soma');
});
teste('Duração manual tem prioridade sobre a calculada', () => {
  const x = obraPlanilha(); x.o.eap.find((a) => a.codigo === '2.4.4').duracaoManual = 12;
  igual(calcular(x.o, lib).ativ.get(x.ids.get('2.4.4')).dur, 12);
});
teste('Sem equipe → duração calculada vazia e alerta', () => {
  const x = obraPlanilha(); x.o.eap.find((a) => a.codigo === '2.4.4').equipe = null;
  const r = calcular(x.o, lib).ativ.get(x.ids.get('2.4.4'));
  igual(r.durCalc, null); verdade(r.alertas.some((t) => t.includes('equipe')), 'deveria alertar a equipe');
});
teste('ARREDONDAR.PARA.CIMA não arredonda valores exatos (duracaoCalculada(29,92 HH, 4) = 1)', () => {
  igual(duracaoCalculada(29.92, 4, 8.8, 0.85), 1); igual(duracaoCalculada(29.93, 4, 8.8, 0.85), 2); igual(duracaoCalculada(0, 4, 8.8, 0.85), null);
});

/* ---------- 2. Validações ---------- */
grupo('2. Validações');
teste('Itens com vínculos somando 100% → "OK"', () => { for (const I of calc.itens.values()) igual(I.status, 'OK', I.item.codigo); });
teste('Vínculos somando 90% → "Verificar"', () => {
  const x = obraPlanilha(); x.o.vinculos.find((v) => v.pct === 0.4).pct = 0.3;
  igual(calcular(x.o, lib).itens.get(x.itens.get('O-2.02')).status, 'Verificar');
});
teste('Item sem nenhum vínculo → alerta', () => {
  const x = obraPlanilha(); x.o.orcamento.push(novoItem({ codigo: 'O-99', composicaoId: 'C001', quantidade: 1, custoUnit: 1 }));
  const I = [...calcular(x.o, lib).itens.values()].find((i) => i.item.codigo === 'O-99');
  igual(I.status, 'Sem vínculo'); verdade(I.alertas.length > 0, 'sem alerta');
});
teste('Espera técnica sem duração manual → duração padrão provisória com alerta', () => {
  const x = obraPlanilha(); x.o.eap.find((a) => a.codigo === '2.4.9').duracaoManual = null;
  const r = calcular(x.o, lib).ativ.get(x.ids.get('2.4.9'));
  verdade(r.provisoria, 'deveria ser provisória'); igual(r.dur, 3, 'padrão Espera técnica'); verdade(r.alertas.length > 0, 'sem alerta');
});
teste('Composição exige exatamente uma função líder', () => {
  igual(validarComposicao({ maoObra: [{ lider: true }, { lider: false }] }).length, 0);
  verdade(validarComposicao({ maoObra: [{ lider: false }] }).length > 0, 'sem líder deveria falhar');
  verdade(validarComposicao({ maoObra: [{ lider: true }, { lider: true }] }).length > 0, '2 líderes deveria falhar');
});

/* ---------- 3. Notação de predecessoras ---------- */
grupo('3. Predecessoras (notação da planilha)');
const dep = (t) => parseNotacao(t).deps.map((d) => `${d.codigo} ${d.tipo} ${d.lag}`).join(', ');
teste('"3.2" → FS lag 0', () => igual(dep('3.2'), '3.2 FS 0'));
teste('"3.2 TI-10" → FS lag −10', () => igual(dep('3.2 TI-10'), '3.2 FS -10'));
teste('"3.1 II+5" → SS lag +5', () => igual(dep('3.1 II+5'), '3.1 SS 5'));
teste('"3.1 II" → SS lag 0', () => igual(dep('3.1 II'), '3.1 SS 0'));
teste('"6.1/6.2/6.4 TI-5" → 3 predecessoras FS −5', () => igual(dep('6.1/6.2/6.4 TI-5'), '6.1 FS -5, 6.2 FS -5, 6.4 FS -5'));
teste('"-", "" e "1.1  (orig.)"', () => { igual(dep('-'), ''); igual(dep(''), ''); igual(dep('1.1  (orig.)'), '1.1 FS 0'); });
teste('"Retomada" → sem dependência, vira observação', () => { const p = parseNotacao('Retomada'); verdade(p.textoLivre, 'textoLivre'); igual(p.deps.length, 0); });
teste('Texto inválido com números gera erro', () => { let erro = false; try { parseNotacao('3.2 XX 4'); } catch { erro = true; } verdade(erro, 'deveria dar erro'); });
teste('Formatação ida e volta', () => {
  const m = new Map([['a', '3.2'], ['b', '3.1'], ['c', '6.1'], ['d', '6.2']]);
  const deps = [{ predecessoraId: 'a', tipo: 'FS', lag: -10 }, { predecessoraId: 'b', tipo: 'SS', lag: 5 }, { predecessoraId: 'c', tipo: 'FS', lag: 0 }, { predecessoraId: 'd', tipo: 'FS', lag: 0 }];
  igual(formatNotacao(deps, (id) => m.get(id)), '3.2 TI-10; 3.1 II+5; 6.1/6.2');
});
teste('Código inexistente e auto-referência são rejeitados', () => {
  const idPorCodigo = new Map([['1.1', 'x']]);
  let e1 = false, e2 = false;
  try { resolverNotacao('9.9', 'y', idPorCodigo); } catch { e1 = true; }
  try { resolverNotacao('1.1', 'x', idPorCodigo); } catch { e2 = true; }
  verdade(e1 && e2, 'deveria rejeitar');
});

/* ---------- 4. Datas (CPM) ---------- */
grupo('4. Cronograma (CPM) — início seg 05/10/2026, feriado seg 12/10/2026');
function obraDatas() {
  const ob = novaObra({ nome: 'Datas', inicio: '2026-10-05' });
  ob.calendario.feriados = [{ data: '2026-10-12', desc: 'N. Sra. Aparecida' }];
  const mk = (codigo, dur, parentId = null) => { const a = novaAtividade({ codigo, descricao: codigo, duracaoManual: dur, parentId }); ob.eap.push(a); return a; };
  const P = mk('1', null);
  const a = mk('1.1', 5, P.id), b = mk('1.2', 3, P.id), c = mk('1.3', 3, P.id), d = mk('1.4', 2, P.id), e = mk('1.5', 1, P.id);
  const L = (s, p, tipo = 'FS', lag = 0) => ob.dependencias.push({ id: uid(), atividadeId: s.id, predecessoraId: p.id, tipo, lag });
  L(b, a); L(c, a, 'FS', -2); L(d, a, 'SS', 2); L(e, b); L(e, c); L(e, d);
  return { ob, P, a, b, c, d, e, L };
}
const datas = (ob) => { const cc = calcular(ob, emptyLib()); return cronograma(ob, emptyLib(), cc); };
const D = (cr, x) => { const n = cr.nos.get(x.id); return `${fmtBR(n.inicio)}–${fmtBR(n.termino)}`; };
{
  const t = obraDatas(); const cr = datas(t.ob);
  teste('Sem predecessora começa na data de início: 1.1 (5 d) = 05/10–09/10', () => igual(D(cr, t.a), '05/10/2026–09/10/2026'));
  teste('FS com feriado: 1.2 começa no dia útil seguinte (12/10 é feriado) = 13/10–15/10', () => igual(D(cr, t.b), '13/10/2026–15/10/2026'));
  teste('FS com TI-2 (sobreposição) e feriado no meio do intervalo: 1.3 = 08/10–13/10', () => igual(D(cr, t.c), '08/10/2026–13/10/2026'));
  teste('SS com lag +2 (II+2): 1.4 = 07/10–08/10', () => igual(D(cr, t.d), '07/10/2026–08/10/2026'));
  teste('Múltiplas predecessoras — vale a mais tardia: 1.5 = 16/10', () => igual(D(cr, t.e), '16/10/2026–16/10/2026'));
  teste('Folga total e caminho crítico (1.1→1.2→1.5 críticas; 1.3 folga 2; 1.4 folga 4)', () => {
    const n = (x) => cr.nos.get(x.id);
    verdade(n(t.a).critico && n(t.b).critico && n(t.e).critico, 'críticas');
    igual(n(t.c).folga, 2, '1.3'); igual(n(t.d).folga, 4, '1.4'); verdade(!n(t.c).critico, '1.3 não crítica');
  });
  teste('Nível superior agrega as filhas: 1 = 05/10–16/10', () => igual(D(cr, t.P), '05/10/2026–16/10/2026'));
  teste('Prazo total = 9 dias úteis (05/10 a 16/10, sem o feriado)', () => igual(cr.durTotal, 9));
}
teste('Início fixado tem prioridade sobre as predecessoras', () => {
  const t = obraDatas(); t.b.inicioFixado = '2026-10-20'; igual(D(datas(t.ob), t.b), '20/10/2026–22/10/2026');
});
teste('Início real > início fixado', () => {
  const t = obraDatas(); t.b.inicioFixado = '2026-10-20'; t.b.inicioReal = '2026-10-14'; igual(D(datas(t.ob), t.b), '14/10/2026–16/10/2026');
});
teste('Fim real substitui o fim calculado e reprojeta as sucessoras', () => {
  const t = obraDatas(); t.a.fimReal = '2026-10-07'; const cr = datas(t.ob);
  igual(D(cr, t.a), '05/10/2026–07/10/2026'); igual(D(cr, t.b), '08/10/2026–13/10/2026');
});
teste('Dependência circular é detectada e bloqueada', () => {
  const t = obraDatas();
  verdade(criaCiclo(t.ob, t.a.id, [t.e.id]), 'criaCiclo deveria acusar');
  verdade(!criaCiclo(t.ob, t.e.id, [t.a.id]), 'ligação válida acusada como ciclo');
  t.L(t.a, t.e); const cr = datas(t.ob); verdade(cr.ciclo, 'cronograma deveria marcar ciclo');
});
teste('Atividade dependente do próprio grupo (pai) é ciclo', () => { const t = obraDatas(); verdade(criaCiclo(t.ob, t.a.id, [t.P.id]), 'deveria acusar'); });
teste('Calendário: índice e data com feriado', () => {
  const cal = new Calendario({ inicio: '2026-10-05', feriados: [{ data: '2026-10-12' }] });
  igual(fmtBR(cal.date(5)), '13/10/2026'); igual(cal.idxNext(toDay('2026-10-12')), 5); igual(cal.idxPrev(toDay('2026-10-12')), 4);
  igual(fmtBR(cal.date(-1)), '02/10/2026');
});

/* ---------- 5. Curva S ---------- */
grupo('5. Curva S');
teste('Curva financeira acumulada termina no total (R$ 224.306,00) e a física em 100%', () => {
  const cr = cronograma(o, lib, calc);
  for (const per of ['semana', 'mes']) {
    const cs = curvaS(calc, cr, per); const ult = cs.periodos[cs.periodos.length - 1];
    perto(ult.finAc, 224306, 1e-6, `${per}:`); perto(ult.fisAc, 100, 1e-9, `${per}:`);
  }
});

/* ---------- 6. Migração do formato antigo ---------- */
grupo('6. Migração das obras existentes (formato v1)');
teste('Obra v1 (alvenaria 135 m² × 0,8 h/m², 8 h/dia) continua com 14 dias úteis', () => {
  const lib1 = migrateLib({ id: 'biblioteca', kind: 'biblioteca', etapas: [{ id: 'e1', nome: 'Alvenaria' }], composicoes: [{ id: 'c4', nome: 'Alvenaria de vedação', unidade: 'm²', coef: 0.8 }], updatedAt: 1 });
  const o1 = migrateObra({ id: 'o1', kind: 'obra', nome: 'Antiga', inicio: '2026-10-05', calendario: { jornada: 8, dias: [1, 2, 3, 4, 5], feriados: [] },
    etapas: [{ id: 'oe1', etapaId: 'e1', servicos: [{ id: 's1', composicaoId: 'c4', quantidade: 135, equipes: 1, duracaoFixa: '', preds: [], pct: 0 }] }], medicoes: [] }, lib1);
  igual(o1.schemaVersion, 2); igual(o1.eap.length, 2); igual(o1.vinculos.length, 1);
  const cc = calcular(o1, lib1); igual(cc.ativ.get('s1').dur, 14); igual(o1.eap[1].codigo, '1.1');
});

/* ---------- 9. Cronograma: TT/IT e dias corridos ---------- */
grupo('9. Dependências término-término (TT) e início-término (IT); calendário em dias corridos');
teste('"3.2 TT+2" → FF lag 2 e "3.2 IT" → SF; formatação volta igual', () => {
  igual(dep('3.2 TT+2'), '3.2 FF 2'); igual(dep('3.2 IT'), '3.2 SF 0');
  const m = new Map([['a', '3.2']]);
  igual(formatNotacao([{ predecessoraId: 'a', tipo: 'FF', lag: 2 }], (id) => m.get(id)), '3.2 TT+2');
  igual(formatNotacao([{ predecessoraId: 'a', tipo: 'SF', lag: 0 }], (id) => m.get(id)), '3.2 IT');
});
teste('FF: atividade de 3 dias termina junto com a 1.1 (09/10) → 07/10–09/10', () => {
  const t = obraDatas(); const x = novaAtividade({ codigo: '1.6', descricao: 'x', duracaoManual: 3, parentId: t.P.id }); t.ob.eap.push(x); t.L(x, t.a, 'FF', 0);
  igual(D(datas(t.ob), x), '07/10/2026–09/10/2026');
});
teste('SF: atividade de 2 dias termina na véspera do início da 1.2 (13/10) → 08/10–09/10', () => {
  const t = obraDatas(); const x = novaAtividade({ codigo: '1.6', descricao: 'x', duracaoManual: 2, parentId: t.P.id }); t.ob.eap.push(x); t.L(x, t.b, 'SF', 0);
  igual(D(datas(t.ob), x), '08/10/2026–09/10/2026');
});
teste('Dias corridos: fim de semana e feriado contam (1.2 = 10/10–12/10)', () => {
  const t = obraDatas(); t.ob.calendario.tipo = 'corridos';
  igual(D(datas(t.ob), t.b), '10/10/2026–12/10/2026');
});

/* ---------- 10. Físico-financeiro ---------- */
grupo('10. Distribuição de custos, perfis e peso físico');
teste('Perfis de distribuição somam 100% (linear, início, fim, sino)', () => {
  for (const p of ['linear', 'inicio', 'fim', 'sino']) perto(pesosPerfil(7, p).reduce((a, b) => a + b, 0), 1, 1e-12, p);
  verdade(pesosPerfil(5, 'inicio')[0] > pesosPerfil(5, 'inicio')[4], 'início deveria pesar mais no começo');
});
teste('Distribuição financeira em centavos soma exatamente o custo alocado (R$ 224.306,00), em todos os perfis', () => {
  for (const p of ['linear', 'inicio', 'fim', 'sino']) {
    const x = obraPlanilha(); x.o.distribuicaoPadrao = p;
    const cc = calcular(x.o, lib); const cr = cronograma(x.o, lib, cc);
    const ds = distribuicao(x.o, cc, cr);
    igual([...ds.dia.values()].reduce((s, v) => s + v[1], 0), 22430600, p);
    const cs = curvaS(cc, cr, 'semana', x.o); perto(cs.periodos[cs.periodos.length - 1].finAc, 224306, 1e-9, p);
  }
});
teste('Peso físico configurável: por custo a curva física acompanha a financeira; por HH não', () => {
  const x = obraPlanilha(); x.o.pesoFisico = 'custo';
  const cc = calcular(x.o, lib); const cr = cronograma(x.o, lib, cc);
  const cs = curvaS(cc, cr, 'semana', x.o);
  for (const p of cs.periodos) perto(p.fisAc, (p.finAc / 224306) * 100, 1e-6, p.label);
  x.o.pesoFisico = 'hh'; const cs2 = curvaS(cc, cr, 'semana', x.o);
  verdade(cs2.periodos.some((p, i) => Math.abs(p.fisAc - cs.periodos[i].fisAc) > 0.01), 'HH deveria diferir');
});

/* ---------- 11. Medições ---------- */
grupo('11. Medições de avanço (acumuladas, sem duplicar)');
teste('Medição por quantidade: 101,5 de 203 m² = 50%; repetir na mesma data substitui (não soma)', () => {
  const x = obraPlanilha(); const cc = calcular(x.o, lib);
  const id = x.ids.get('2.4.4');
  const r1 = registrarMedicao(x.o, cc, { atividadeId: id, data: '2026-10-20', qtdAcum: 101.5 });
  perto(r1.medicao.pct, 50, 1e-9); igual(r1.medicao.metodo, 'quantidade');
  const r2 = registrarMedicao(x.o, cc, { atividadeId: id, data: '2026-10-20', qtdAcum: 101.5 });
  verdade(r2.substituida, 'deveria substituir'); igual(x.o.medicoesAtiv.length, 1);
  igual(x.o.eap.find((a) => a.id === id).pct, 50);
});
teste('Quantidade acima da planejada fica limitada a 100% com aviso; acumulado menor que o anterior gera aviso', () => {
  const x = obraPlanilha(); const cc = calcular(x.o, lib); const id = x.ids.get('2.4.4');
  const r = registrarMedicao(x.o, cc, { atividadeId: id, data: '2026-10-20', qtdAcum: 250 });
  igual(r.medicao.pct, 100); verdade(r.avisos.length > 0, 'sem aviso');
  const r2 = registrarMedicao(x.o, cc, { atividadeId: id, data: '2026-10-25', qtdAcum: 50 });
  verdade(r2.avisos.some((t) => t.includes('menor')), 'sem aviso de redução');
});
teste('Avanço numa data usa a última medição até ela (histórico preservado)', () => {
  const x = obraPlanilha(); const cc = calcular(x.o, lib); const id = x.ids.get('2.4.4');
  registrarMedicao(x.o, cc, { atividadeId: id, data: '2026-10-10', qtdAcum: 50.75 });
  registrarMedicao(x.o, cc, { atividadeId: id, data: '2026-10-20', qtdAcum: 203 });
  const a = x.o.eap.find((y) => y.id === id);
  perto(pctRealAte(x.o, a, toDay('2026-10-15')), 25, 1e-9); igual(pctRealAte(x.o, a, toDay('2026-10-21')), 100);
  igual(pctRealAte(x.o, a, toDay('2026-10-01')), 0);
  igual(a.inicioReal, '2026-10-10'); igual(a.fimReal, '2026-10-20');
});
teste('Espera técnica (sem quantidade) é medida em %', () => {
  const x = obraPlanilha(); const cc = calcular(x.o, lib);
  const r = registrarMedicao(x.o, cc, { atividadeId: x.ids.get('2.4.9'), data: '2026-10-20', pct: 40 });
  igual(r.medicao.metodo, 'percentual'); igual(r.medicao.pct, 40);
});

/* ---------- 12. Orçamento: BDI e revisões ---------- */
grupo('12. Orçamento: BDI (fórmula TCU), preço de venda e revisões');
teste('BDI TCU: AC 4%, S 0,8%, R 1,27%, G 0%, DF 1,23%, L 7,4%, I 8,65% ≈ 26,24%', () => {
  const b = bdiTCU({ ac: 4, s: 0.8, r: 1.27, g: 0, df: 1.23, l: 7.4, i: 8.65 });
  perto(b, ((1 + 0.04 + 0.008 + 0.0127) * 1.0123 * 1.074) / (1 - 0.0865) - 1, 1e-12); perto(b * 100, 26.24, 0.01);
});
teste('Preço de venda = custo direto × (1 + BDI), aplicado uma vez; BDI zero = custo', () => {
  const x = obraPlanilha(); const cc = calcular(x.o, lib);
  x.o.bdi = { ac: 4, s: 0.8, r: 1.27, g: 0, df: 1.23, l: 7.4, i: 8.65 };
  const r = resumoOrcamento(x.o, cc); perto(r.precoVenda, 224306 * (1 + r.bdi), 1e-6);
  perto(r.etapas.reduce((s, e) => s + e.custo, 0), 224306, 1e-6);
  x.o.bdi = {}; perto(resumoOrcamento(x.o, cc).precoVenda, 224306, 1e-9);
});
teste('Revisão do orçamento: compara itens alterados, incluídos e removidos e a diferença total', () => {
  const x = obraPlanilha();
  const rev = snapshotOrcamento(x.o, lib, 'R0');
  x.o.orcamento[0].quantidade = 213; // +10 m² × 95
  x.o.orcamento.pop();
  const atual = snapshotOrcamento(x.o, lib, 'atual');
  const d = compararOrcamento(rev, atual);
  igual(d.alterados.length, 1); igual(d.removidos.length, 1); igual(d.incluidos.length, 0);
  perto(d.delta, 950 - 18720, 1e-6);
});

/* ---------- 13. Custos ---------- */
grupo('13. Custos: comprometido × incorrido × pago, sem duplicidade');
teste('Despesa vinculada a contrato não soma de novo no comprometido; avulsa soma; pago e saldo', () => {
  const o2 = novaObra({ nome: 'C', inicio: '2026-10-05' });
  o2.compromissos = [{ id: 'k1', tipo: 'Contrato', fornecedor: 'Empreiteira', valor: 10000, aditivos: [{ valor: 2000 }] }];
  o2.despesas = [
    { id: 'd1', compromissoId: 'k1', data: '2026-10-10', valor: 4000, pagamentos: [{ data: '2026-10-15', valor: 4000 }] },
    { id: 'd2', compromissoId: null, data: '2026-10-12', valor: 500, pagamentos: [] },
  ];
  const r = resumoCustos(o2);
  igual(r.comprometido, 12500); igual(r.incorrido, 4500); igual(r.pago, 4000); igual(r.saldoAPagar, 500); igual(r.aIncorrer, 8000);
  igual(resumoCustos(o2, { ateDia: toDay('2026-10-11') }).incorrido, 4000);
});
teste('Alerta quando as despesas passam do contratado; detecção de nota duplicada', () => {
  const o2 = novaObra({ nome: 'C', inicio: '2026-10-05' });
  o2.compromissos = [{ id: 'k1', tipo: 'Pedido', valor: 1000, aditivos: [] }];
  o2.despesas = [{ id: 'd1', compromissoId: 'k1', data: '2026-10-10', valor: 1200, documento: 'NF 10', fornecedor: 'Loja', pagamentos: [] }];
  verdade(resumoCustos(o2).alertas.length === 1, 'sem alerta');
  verdade(!!despesaDuplicada(o2, { id: 'novo', documento: 'nf 10', fornecedor: 'loja', valor: 5 }), 'não detectou duplicada');
});
teste('Valor agregado: CPI, SPI e estimativa no término (EAC = AC + BAC − EV)', () => {
  const v = valorAgregado({ bac: 100000, pv: 40000, ev: 30000, ac: 36000 });
  perto(v.cpi, 30000 / 36000, 1e-12); perto(v.spi, 0.75, 1e-12); igual(v.eac, 106000); igual(v.vac, -6000);
});

grupo('14. Importação de orçamento por Excel (associação de colunas e validação)');
teste('Sugere colunas pelo cabeçalho; valida obrigatórios, números e códigos repetidos; atualiza pelo código', () => {
  const lib = libPlanilha();
  const o2 = novaObra({ nome: 'I', inicio: '2026-10-05' });
  o2.orcamento.push(novoItem({ codigo: '1.1', descricao: 'Antigo', quantidade: 1, custoUnit: 1 }));
  const cab = ['Item', 'Etapa', 'Descrição', 'Unid.', 'Quant.', 'Custo unitário', 'Composição'];
  const m = sugerirMapeamento(cab);
  igual(m.codigo, 0); igual(m.etapa, 1); igual(m.descricao, 2); igual(m.unidade, 3); igual(m.quantidade, 4); igual(m.custoUnit, 5); igual(m.comp, 6);
  const linhas = [
    ['1.1', 'Fundação', 'Forma', 'm²', '10,5', 100, 'C001'],
    ['1.2', 'Fundação', 'Concreto', 'm³', 2, '350,00', ''],
    ['1.2', 'Fundação', 'Repetido', 'm³', 1, 1, ''],
    ['', 'Fundação', 'Sem código', 'un', 1, 1, ''],
    ['1.3', 'Fundação', 'Qtd ruim', 'un', 'abc', 1, ''],
    ['', '', '', '', '', '', ''],
  ];
  const regs = validarLinhas(linhas, m, o2, lib);
  igual(regs.length, 5, 'linha vazia');
  perto(regs[0].quantidade, 10.5); igual(regs[0].comp?.codigo, 'C001'); verdade(!!regs[0].existente, 'existente');
  perto(regs[1].custoUnit, 350);
  verdade(regs[2].erros.some((e) => e.includes('repetido')), 'repetido');
  verdade(regs[3].erros.length && regs[4].erros.length, 'erros');
  const so = JSON.parse(JSON.stringify(o2));
  const r1 = aplicarImportacao(so, validarLinhas(linhas, m, so, lib), 'novos');
  igual(r1.incluidos, 1); igual(r1.atualizados, 0); igual(r1.ignorados.length, 4);
  igual(so.orcamento.find((i) => i.codigo === '1.1').descricao, 'Antigo');
  const r2 = aplicarImportacao(o2, regs, 'atualizar');
  igual(r2.incluidos, 1); igual(r2.atualizados, 1);
  const it = o2.orcamento.find((i) => i.codigo === '1.1');
  perto(it.quantidade, 10.5); igual(it.composicaoId, 'C001');
});

grupo('15. Visão geral: indicadores consolidados (critérios de js/indicadores.js)');
teste('Pedidos: cancelados e entregues fora do "em andamento"; entrega só conta como feita com status Entregue', () => {
  const o2 = novaObra({ nome: 'P', inicio: '2026-10-05' });
  const hoje = toDay('2026-10-11');
  const P = (status, dataNecessaria) => ({ id: uid(), tipo: 'Pedido de compra', status, dataNecessaria, valor: 1, aditivos: [] });
  o2.compromissos = [P('Em cotação', '2026-10-20'), P('Aprovado', '2026-10-05'), P('Aprovado', '2026-10-15'), P('Entregue parcialmente', ''),
    P('Entregue', '2026-10-01'), P('Cancelado', '2026-10-01'), { id: 'c', tipo: 'Contrato', status: 'Aprovado', valor: 9, aditivos: [] }];
  const p = pedidosDaObra(o2, hoje);
  igual(p.total, 6, 'contrato não é pedido:');
  igual(p.emAndamento.length, 4, 'em andamento:');
  igual(p.aguardandoCotacao.length, 1, 'em cotação:');
  igual(p.entregasPendentes.length, 3, 'entregas pendentes:');
  igual(p.entregasAtrasadas.length, 1, 'atrasadas:');
  igual(p.entregasProximas.length, 1, 'próximas (7 dias):');
});
teste('Consolidado: média simples só de obras ativas com avanço; custo só quando há despesas; inativas fora', () => {
  const r = (ativa, real, temAvanco, incorrido, temDespesas, atras = 0) => ({ ativa, temAvanco, av: { fisicoReal: real }, atrasadas: Array(atras).fill(0), pend: [],
    custos: { incorrido }, temDespesas, pedidos: { total: 0, emAndamento: [], entregasPendentes: [], entregasAtrasadas: [] } });
  const k = consolidado([r(true, 40, true, 1000, true, 2), r(true, 10, true, 0, false), r(true, 0, false, 0, false), r(false, 100, true, 500, true, 5)]);
  igual(k.total, 4); igual(k.ativas, 3);
  perto(k.avancoMedio, 25, 1e-9, 'média (40+10)/2:');
  igual(k.atrasadas, 2, 'concluída/cancelada não soma atraso:');
  igual(k.custoRealizado, 1500, 'custo de todas as obras com despesa:');
  igual(consolidado([r(true, 0, false, 0, false)]).avancoMedio, null, 'sem avanço calculável → nulo:');
  igual(consolidado([r(true, 0, false, 0, false)]).custoRealizado, null, 'sem despesas → nulo (não zero):');
});

grupo('16. Fornecedores: validação, busca e histórico comercial');
teste('CPF/CNPJ: dígitos verificadores (mesma regra do banco), formatação e vazio aceito', () => {
  verdade(docValido('11.222.333/0001-81') && docValido('529.982.247-25') && docValido(''), 'válidos recusados');
  verdade(!docValido('11222333000182') && !docValido('52998224726') && !docValido('11111111111') && !docValido('123'), 'inválidos aceitos');
  igual(formatarDoc('11222333000181'), '11.222.333/0001-81'); igual(formatarDoc('52998224725'), '529.982.247-25');
});
teste('Busca sem acento por nome, CNPJ (só dígitos), cidade, produto e categoria; filtros de status', () => {
  const lista = [
    { id: 'a', trade_name: 'Depósito São José', legal_name: '', doc_number: '11222333000181', city: 'Campinas', state: 'SP', products: 'cimento, areia', representative: 'João', email: '', phone: '(19) 3333-4444', whatsapp: '', main_category_id: 'c1', status: 'ativo' },
    { id: 'b', trade_name: 'Madeireira Norte', legal_name: 'Norte Ltda', doc_number: '', city: 'Sumaré', state: 'SP', products: 'tábuas', representative: '', email: '', phone: '', whatsapp: '', main_category_id: 'c2', status: 'inativo' },
  ];
  const aux = { secundarias: new Map([['b', ['c1']]]), nomeCategoria: (id) => ({ c1: 'Cimento e argamassa', c2: 'Madeira e formas' }[id]) };
  const ids = (f) => filtrarFornecedores(lista, f, aux).map((s) => s.id).join();
  igual(ids({ busca: 'sao jose', status: '' }), 'a', 'sem acento:');
  igual(ids({ busca: '11.222.333', status: '' }), 'a', 'CNPJ formatado:');
  igual(ids({ busca: 'tabuas', status: '' }), 'b', 'produto:');
  igual(ids({ busca: 'madeira', status: '' }), 'b', 'nome da categoria:');
  igual(ids({ status: 'ativo' }), 'a', 'só ativos:');
  igual(ids({ categoria: 'c1', status: '' }), 'a,b', 'categoria principal ou secundária:');
  igual(ids({ cidade: 'sumare', status: '' }), 'b', 'cidade:');
});
teste('Histórico: liga pelo cadastro ou, em registros antigos, pelo nome; soma contratos e despesas sem misturar', () => {
  const s = { id: 'f1', trade_name: 'Depósito São José', legal_name: 'SJ Materiais Ltda' };
  const o1 = { id: 'o1', nome: 'Obra 1', compromissos: [
    { id: 'k1', tipo: 'Pedido de compra', fornecedorId: 'f1', fornecedor: 'qualquer', objeto: 'Cimento', valor: 1000, aditivos: [{ valor: 100 }], data: '2026-09-01' },
    { id: 'k2', tipo: 'Contrato', fornecedorId: null, fornecedor: 'SJ MATERIAIS LTDA', valor: 500, aditivos: [], data: '2026-08-01' },
    { id: 'k3', tipo: 'Contrato', fornecedorId: 'outro', fornecedor: 'Depósito São José', valor: 999, aditivos: [] }],
    despesas: [{ id: 'd1', fornecedorId: null, fornecedor: 'deposito são josé', valor: 300, data: '2026-09-10' }] };
  const o2 = { id: 'o2', nome: 'Obra 2', compromissos: [], despesas: [{ id: 'd2', fornecedorId: 'f1', fornecedor: '', valor: 50, data: '2026-10-01' }] };
  const h = historicoFornecedor(s, [o1, o2]);
  igual(h.linhas.length, 4, 'k3 é de outro fornecedor cadastrado:');
  igual(h.obras, 2); igual(h.contratado, 1600, 'contratos+pedidos com aditivos:'); igual(h.despesas, 350);
  igual(h.materiais.join(), 'Cimento');
  igual(h.linhas.filter((l) => l.porNome).length, 2, 'registros ligados pelo nome:');
});

grupo('17. Suprimentos: liberações, pedido com grupos, situação consolidada, cotações e entregas');
teste('Liberações: padrão por perfil, personalizadas, admin sempre todas, cliente nenhuma', () => {
  igual(liberacoesDe('supervisor').join(), 'solicitar,receber');
  igual(liberacoesDe('financeiro').join(), 'solicitar,comprar,fornecedores');
  igual(liberacoesDe('supervisor', ['solicitar', 'comprar']).join(), 'solicitar,comprar', 'personalizada:');
  igual(liberacoesDe('admin', []).join(), 'solicitar,comprar,receber,fornecedores,aprovar_rdo,aprovar_medicao', 'admin:');
  igual(liberacoesDe('engenheiro').includes('aprovar_rdo'), true, 'engenheiro aprova RDO:');
  igual(liberacoesDe('supervisor').includes('aprovar_rdo'), false, 'supervisor não aprova RDO:');
  igual(liberacoesDe('cliente', ['comprar']).join(), '', 'cliente:');
});
teste('Sincronização: contratos/pedidos seguem a liberação "comprar"; demais tabelas seguem o perfil', () => {
  verdade(!podeGravar('supervisor', 'contracts'), 'supervisor sem liberação (padrão)');
  verdade(podeGravar('supervisor', 'contracts', ['solicitar', 'comprar']), 'supervisor com "comprar"');
  verdade(!podeGravar('compras', 'contracts', ['solicitar']), 'compras sem "comprar"');
  verdade(podeGravar('financeiro', 'contracts', LIBERACOES_PADRAO.financeiro), 'financeiro padrão');
  verdade(!podeGravar('cliente', 'contracts', ['comprar']), 'cliente nunca');
  verdade(podeGravar('supervisor', 'activity_measurements', []), 'medição segue o perfil');
  verdade(!podeGravar('supervisor', 'expenses', ['comprar']), 'despesa segue o perfil');
});
teste('Sincronização detecta alteração dentro de campos aninhados (jsonb: listas do RDO, extra da obra, modelos)', () => {
  const antes = { id: 'r', equipment_list: [{ nome: 'Betoneira', qtd: 1, horas: 6 }], extra: { numeroContrato: 'A' } };
  const snap = fotografar({ daily_reports: [antes] }, ['daily_reports']);
  const depois = { ...antes, equipment_list: [{ nome: 'Betoneira', qtd: 1, horas: 8 }] };
  igual(diferencas({ daily_reports: [depois] }, snap, ['daily_reports']).daily_reports?.alteradas.length, 1, 'horas alteradas:');
  igual(diferencas({ daily_reports: [{ ...antes, extra: { numeroContrato: 'B' } }] }, snap, ['daily_reports']).daily_reports?.alteradas.length, 1, 'extra alterado:');
  igual(diferencas({ daily_reports: [{ extra: { numeroContrato: 'A' }, equipment_list: [{ horas: 6, qtd: 1, nome: 'Betoneira' }], id: 'r' }] }, snap, ['daily_reports']).daily_reports, undefined, 'mesma linha em outra ordem:');
});
teste('Situação do pedido (mesma regra do banco): coluna do grupo menos adiantado; "Em andamento" quando misturado', () => {
  const s = (...st) => { const r = situacaoPedido(st.map((status) => ({ status }))); return `${r.status}/${r.etapa}`; };
  igual(s(), 'pedido/1', 'sem grupos:');
  igual(s('analise', 'analise'), 'pedido/1');
  igual(s('cotacao', 'aprovacao'), 'em_cotacao/2', 'todos em cotação:');
  igual(s('cotacao', 'aguardando_entrega', 'entregue', 'retirada'), 'em_andamento/2', 'exemplo do pedido (madeira em cotação…):');
  igual(s('comprado', 'retirada', 'entrega_parcial'), 'aguardando_entrega/3', 'todos comprados:');
  igual(s('entregue', 'entrega_parcial'), 'em_andamento/3', 'entrega parcial impede a conclusão:');
  igual(s('entregue', 'resolvido', 'cancelado'), 'concluido/4');
  igual(s('cancelado', 'cancelado'), 'cancelado/4');
  igual(situacaoPedido([{ status: 'cotacao' }, { status: 'analise', deleted_at: 'x' }]).status, 'em_cotacao', 'grupo excluído não conta:');
});
teste('Recebido por item e pendências: soma entregas válidas, nunca negativo, lista exatamente o que falta', () => {
  const entregas = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3', deleted_at: 'x' }];
  const ie = [{ delivery_id: 'e1', item_id: 'i1', quantity: 30 }, { delivery_id: 'e2', item_id: 'i1', quantity: 5 }, { delivery_id: 'e3', item_id: 'i1', quantity: 99 }, { delivery_id: 'e1', item_id: 'i2', quantity: 4 }];
  const rec = recebidoPorItem(entregas, ie);
  igual(rec.get('i1'), 35, 'entrega desfeita fora:');
  const its = itensComSaldo([{ id: 'i1', quantity: 40 }, { id: 'i2', quantity: 3.5 }], rec);
  igual(its[0].pendente, 5); igual(its[1].pendente, 0); igual(its[1].excedente, 0.5);
  const grupos = [{ id: 'g1', name: 'Madeira', status: 'entrega_parcial', position: 0 }, { id: 'g2', name: 'Cimento', status: 'comprado', position: 1 },
    { id: 'g3', name: 'Aço', status: 'cotacao', position: 2 }, { id: 'g4', name: 'Tijolos', status: 'entregue', position: 3 }];
  const itens = new Map([['g1', [{ id: 'i1', quantity: 40, unit: 'un', description: 'Tábua', position: 0 }, { id: 'i2', quantity: 3.5, unit: 'dz', description: 'Sarrafo', position: 1 }]]]);
  igual(pendenciasPedido(grupos, itens, rec).map((x) => `${x.grupo}: ${x.pendencia}`).join(' | '),
    'Madeira: entrega parcial — faltam: 5 un Tábua | Cimento: aguardando entrega | Aço: ainda não comprado (Em cotação)');
});
teste('Cartão: progresso dos grupos e atraso (data necessária ou previsão vencida), nada em pedido encerrado', () => {
  const g = [{ status: 'entregue' }, { status: 'aguardando_entrega', expected_date: '2026-10-09' }, { status: 'cotacao' }];
  const r = resumoPedido({ status: 'em_andamento', needed_date: '2026-10-30' }, g, '2026-10-11');
  igual(r.encerrados, 1); igual(r.pct, 33); verdade(r.atrasado, 'previsão vencida'); igual(r.proximaPrevisao, '2026-10-09');
  verdade(resumoPedido({ status: 'pedido', needed_date: '2026-10-01' }, [], '2026-10-11').atrasado, 'data necessária vencida');
  verdade(!resumoPedido({ status: 'concluido', needed_date: '2026-10-01' }, [], '2026-10-11').atrasado, 'concluído não atrasa');
});
teste('Filtros do quadro: número/nome sem acento, obra, fase, prioridade, solicitante, fornecedor, período, cancelados', () => {
  const peds = [
    { id: 'a', number: 1, title: 'Materiais para estrutura', project_id: 'o1', phase_id: 'f1', priority: 'urgente', requester_label: 'Carol', buyer_label: 'Erin', status: 'em_andamento', created_at: '2026-10-05T10:00:00Z' },
    { id: 'b', number: 12, title: 'Elétrica', project_id: 'o2', phase_id: 'f2', priority: 'normal', requester_label: 'Ana', buyer_label: '', status: 'cancelado', created_at: '2026-10-09T10:00:00Z' },
  ];
  const aux = { fornecedoresDoPedido: (p) => (p.id === 'a' ? ['Depósito São José'] : []) };
  const ids = (f) => filtrarPedidos(peds, f, aux).map((p) => p.id).join();
  igual(ids({}), 'a', 'cancelado escondido:'); igual(ids({ cancelados: true }), 'a,b');
  igual(ids({ busca: 'ped-0001', cancelados: true }), 'a', 'número:'); igual(ids({ busca: 'eletrica', cancelados: true }), 'b', 'sem acento:');
  igual(ids({ obra: 'o1', fase: 'f1' }), 'a'); igual(ids({ prioridade: 'normal', cancelados: true }), 'b');
  igual(ids({ fornecedor: 'deposito sao jose' }), 'a'); igual(ids({ solicitante: 'ana', cancelados: true }), 'b');
  igual(ids({ de: '2026-10-06', cancelados: true }), 'b', 'período:'); igual(ids({ comprador: 'Erin' }), 'a');
});
teste('Comparação de cotações: total com frete, menor valor e menor prazo, descartadas fora, diferença para o menor', () => {
  const c = comparativoCotacoes([
    { id: 'a', supplier_name: 'A', total_amount: 2100, freight_amount: 0, lead_days: 2, status: 'recebida' },
    { id: 'b', supplier_name: 'B', total_amount: 1890.5, freight_amount: 120, lead_days: 3, status: 'recebida' },
    { id: 'c', supplier_name: 'C', total_amount: 1000, freight_amount: null, lead_days: 1, status: 'descartada' },
    { id: 'd', supplier_name: 'D', total_amount: 1, deleted_at: '2026-10-10', status: 'recebida' },
  ]);
  igual(c.map((x) => x.id).join(), 'c,b,a', 'ordem por total (excluída fora):');
  const b = c.find((x) => x.id === 'b'), a = c.find((x) => x.id === 'a');
  igual(b.total, 2010.5); verdade(b.menorValor && !b.menorPrazo, 'B = menor valor');
  verdade(a.menorPrazo && !a.menorValor, 'A = menor prazo (descartada não conta)');
  igual(a.acimaDoMenor, 89.5); igual(a.acimaPct, 4.5);
});
teste('Indicadores de entrega do fornecedor: no prazo pelo limite do grupo, conformes, ocorrências; sem dados = sem número', () => {
  const limites = new Map([['g1', '2026-10-20'], ['g2', '']]);
  const i = indicadoresEntrega([
    { group_id: 'g1', delivery_date: '2026-10-19', quantity_ok: false, issue: 'falta' },
    { group_id: 'g1', delivery_date: '2026-10-22', quantity_ok: true, issue: 'nenhuma' },
    { group_id: 'g2', delivery_date: '2026-10-05', quantity_ok: true, issue: 'avaria' },
    { group_id: 'g1', delivery_date: '2026-10-10', quantity_ok: false, issue: 'falta', deleted_at: 'x' },
    { group_id: 'outro', delivery_date: '2026-10-10', quantity_ok: false, issue: 'falta' },
  ], limites);
  igual(i.entregas, 3); igual(i.comDataNecessaria, 2); igual(i.noPrazo, 1); igual(i.pctNoPrazo, 50);
  igual(i.conformes, 1, 'avaria não é conforme:'); igual(i.pctConformes, 33.3); igual(i.totalOcorrencias, 2);
  igual(indicadoresEntrega([], limites).pctNoPrazo, null);
});
teste('Itens: linhas vazias ignoradas; quantidade > 0; ao menos um item; número do pedido com 4 dígitos', () => {
  igual(validarItens([{ description: '', quantity: '' }]).erro, 'Inclua pelo menos um item.');
  verdade(/maior que zero/.test(validarItens([{ description: 'Areia', quantity: 0 }]).erro), 'zero aceito');
  const v = validarItens([{ description: ' Tábua ', quantity: 40, unit: 'un', spec: 'pinus 30 cm' }, { description: '', quantity: '' }]);
  igual(v.itens.length, 1); igual(v.itens[0].description, 'Tábua'); igual(v.itens[0].spec, 'pinus 30 cm');
  igual(numeroPedido(7), 'PED-0007'); igual(etapaGrupo('retirada'), 3); igual(etapaGrupo('resolvido'), 4);
});
teste('Painel por obra: em compra, aguardando, atrasados, parciais, próxima previsão e última entrega; cancelados fora', () => {
  const pedidos = [{ id: 'p1', project_id: 'o1', status: 'em_andamento' }, { id: 'p2', project_id: 'o1', status: 'concluido' },
    { id: 'p3', project_id: 'o2', status: 'cancelado' }, { id: 'p4', project_id: 'o2', status: 'aguardando_entrega' }];
  const grupos = [
    { order_id: 'p1', status: 'cotacao' }, { order_id: 'p1', status: 'aguardando_entrega', expected_date: '2026-10-20' },
    { order_id: 'p1', status: 'entrega_parcial', expected_date: '2026-10-28' }, { order_id: 'p1', status: 'retirada', deleted_at: 'x' },
    { order_id: 'p2', status: 'entregue' }, { order_id: 'p3', status: 'cancelado' }, { order_id: 'p4', status: 'retirada' },
  ];
  const entregas = [{ project_id: 'o1', delivery_date: '2026-10-21' }, { project_id: 'o1', delivery_date: '2026-10-25' },
    { project_id: 'o1', delivery_date: '2026-10-26', deleted_at: 'x' }];
  const m = painelPorObra({ pedidos, grupos, entregas, hoje: '2026-10-26' });
  const a = m.get('o1'), b = m.get('o2');
  igual(`${a.pedidosAbertos}/${a.concluidos}/${a.emCompra}/${a.aguardando}/${a.parciais}/${a.atrasados}`, '1/1/1/2/1/1', 'obra 1:');
  igual(a.proximaPrevisao, '2026-10-20'); igual(a.ultimaEntrega, '2026-10-25', 'desfeita não conta:'); igual(a.entregas, 2);
  igual(`${b.pedidosAbertos}/${b.aguardando}/${b.retirada}/${b.atrasados}`, '1/1/1/0', 'obra 2 (cancelado fora):');
});

grupo('18. Diário de obra (RDO): período, número, prazos, filtros por fase e sincronização dos campos novos');
teste('RDO por período: sobreposição recusada, um dia aceito, fim antes do início recusado, número sequencial', () => {
  const o = novaObra({ nome: 'D', inicio: '2026-10-01' });
  const a = salvarDiario(o, { ...novoDiario('2026-11-01', 'Ana', o), dataFim: '2026-11-03' });
  const b = salvarDiario(o, novoDiario('2026-11-04', 'Ana', o));
  igual(a.numero, 1); igual(b.numero, 2); igual(periodoRdo(a), '01/11/2026 até 03/11/2026'); igual(periodoRdo(b), '04/11/2026');
  let erro = '';
  try { salvarDiario(o, { ...novoDiario('2026-11-03', 'Ana', o), dataFim: '2026-11-05' }); } catch (e) { erro = e.message; }
  verdade(/já cobre parte/.test(erro), `sobreposição aceita (${erro})`);
  erro = ''; try { salvarDiario(o, { ...novoDiario('2026-11-10', 'Ana', o), dataFim: '2026-11-09' }); } catch (e) { erro = e.message; }
  verdade(/antes do início/.test(erro), 'fim antes do início aceito');
  igual(diasDaSemanaRdo(a), 'Domingo até Terça-feira');
});
teste('Relatório aprovado não é alterado no aparelho; diário antigo (um por dia) vira RDO numerado', () => {
  const o = novaObra({ nome: 'D', inicio: '2026-10-01' });
  const a = salvarDiario(o, novoDiario('2026-11-01', 'Ana', o)); a.status = 'aprovado';
  let erro = ''; try { salvarDiario(o, { ...a, observacoes: 'x' }); } catch (e) { erro = e.message; }
  verdade(/aprovado/.test(erro), 'aprovado alterado');
  const antiga = migrateObra({ ...novaObra({ nome: 'Velha', inicio: '2026-01-01' }), diario: [{ id: 'x2', data: '2026-02-03', equipe: [] }, { id: 'x1', data: '2026-02-01', equipe: [] }] });
  igual(antiga.diario.map((d) => `${d.data}:${d.numero}:${d.dataFim}:${d.status}`).sort().join(), '2026-02-01:1:2026-02-01:preenchendo,2026-02-03:2:2026-02-03:preenchendo');
});
teste('Prazos da obra (dias corridos) e filtro de relatórios por fase da EAP', () => {
  const p = prazosObra({ inicio: '2026-08-03', terminoPlanejado: '2028-01-03' }, '2026-10-12');
  igual(p.contratual, 518); igual(p.decorrido, 70); igual(p.aVencer, 448); igual(p.pct, 14);
  igual(prazosObra({ inicio: '2026-08-03' }, '2026-10-12'), null, 'sem término:');
  const o = novaObra({ nome: 'F', inicio: '2026-10-01' });
  o.eap = [{ id: 'f1', nivel: 1, parentId: null }, { id: 's1', nivel: 2, parentId: 'f1' }, { id: 'a1', nivel: 3, parentId: 's1' }, { id: 'f2', nivel: 1, parentId: null }, { id: 'a2', nivel: 2, parentId: 'f2' }];
  o.diario = [{ id: 'r1', data: '2026-11-01', servicos: [{ atividadeId: 'a1' }], ocorrencias: [] }, { id: 'r2', data: '2026-11-02', servicos: [{ atividadeId: 'a2' }], ocorrencias: [] }];
  igual(filtrarDiario(o, { faseId: 'f1' }).map((d) => d.id).join(), 'r1');
  igual(filtrarDiario(o, { de: '2026-11-02' }).map((d) => d.id).join(), 'r2');
});
teste('Sincronização do RDO: campos novos vão e voltam; número, situação e aprovação não são enviados pelo aparelho', () => {
  const o = novaObra({ nome: 'S', inicio: '2026-10-01' });
  o.eap = [{ ...novaAtividade({ id: crypto.randomUUID(), codigo: '1', nivel: 1, descricao: 'Fase' }) }];
  const d = { ...novoDiario('2026-11-01', 'Ana', o), dataFim: '2026-11-03', condicoes: 'Normal', status: 'aprovado', numero: 7, aprovadoPor: 'falso',
    equipe: [{ funcao: 'Pedreiro', qtd: 3, tipo: 'terceirizada', empresa: 'X' }], equipamentosLista: [{ nome: 'Betoneira', qtd: 1, horas: 6 }],
    servicos: [{ atividadeId: o.eap[0].id, descricao: 'Formas', qtd: 42.5, unidade: 'm²', situacao: 'em_andamento', obs: '' }],
    ocorrencias: [{ tipo: 'Impedimento', descricao: 'Chuva', hora: '14:30', providencias: 'Suspenso', responsavel: 'Ana', resolvida: false }],
    materiaisLista: [{ descricao: 'Cimento', qtd: 20, unidade: 'sc', fornecedor: 'Dep', divergencia: '' }] };
  o.diario = [d];
  const L = obraParaLinhas(o, crypto.randomUUID());
  const r = L.daily_reports[0];
  verdade(!('status' in r) && !('number' in r) && !('approved_label' in r), 'campos do banco enviados pelo aparelho');
  igual(r.period_end, '2026-11-03'); igual(L.daily_report_crew[0].kind, 'terceirizada'); igual(L.site_occurrences[0].occurred_at, '14:30');
  const volta = linhasParaObra({ ...L, daily_reports: [{ ...r, number: 7, status: 'preenchendo', updated_at: null }] }).diario[0];
  igual(volta.dataFim, '2026-11-03'); igual(volta.equipe[0].empresa, 'X'); igual(volta.servicos[0].qtd, 42.5); igual(volta.servicos[0].situacao, 'em_andamento');
  igual(volta.equipamentosLista[0].horas, 6); igual(volta.materiaisLista[0].fornecedor, 'Dep'); igual(volta.ocorrencias[0].providencias, 'Suspenso');
  igual(volta.status, 'preenchendo', 'situação vem do banco:'); igual(volta.aprovadoPor, '', 'aprovação vem do banco:');
});

grupo('19. Medições por profissional: valores, produção × executado, vínculo vigente, acumulado e pagamento');
teste('Valor por forma de remuneração (mesma regra do banco); medida incompatível é apontada', () => {
  igual(valorLinha({ pay_type: 'unidade', unit_price: 25 }, 'qtd', 30).valor, 750);
  igual(valorLinha({ pay_type: 'diaria', unit_price: 180.5 }, 'dias', 3).valor, 541.5);
  igual(valorLinha({ pay_type: 'hora', unit_price: 32.33 }, 'horas', 7.5).valor, 242.48);
  igual(valorLinha({ pay_type: 'empreitada', contract_amount: 10000 }, 'percentual', 60).valor, 6000);
  igual(valorLinha({ pay_type: 'outro' }, 'qtd', 5).valor, null);
  igual(valorLinha(null, 'qtd', 5).tipo, 'sem_vinculo');
  verdade(/produção está em "Dias"/.test(valorLinha({ pay_type: 'unidade', unit_price: 25 }, 'dias', 3).erro), 'incompatível aceito');
});
teste('Produção em quantidade não passa do executado (dias/horas/% fora da soma); aprovada substitui a produzida', () => {
  const it = { period_qty: 50 };
  verdade(conferirProducao(it, [{ measure: 'qtd', produced_qty: 30 }, { measure: 'qtd', produced_qty: 20 }, { measure: 'dias', produced_qty: 5 }]).ok, '50 de 50 recusado');
  const c = conferirProducao(it, [{ measure: 'qtd', produced_qty: 30 }, { measure: 'qtd', produced_qty: 25 }]);
  verdade(!c.ok && c.soma === 55, 'acima aceito');
  verdade(conferirProducao(it, [{ measure: 'qtd', produced_qty: 30, approved_qty: 30 }, { measure: 'qtd', produced_qty: 25, approved_qty: 18 }], { aprovada: true }).ok, 'aprovada ajustada');
  igual(conferirProducao(it, [{ measure: 'qtd', produced_qty: 30 }]).sobra, 20, 'sem produção individual:');
});
teste('Vínculo vigente: dentro da vigência, atividade abrangida, o específico vence o geral', () => {
  const v = [
    { id: 'geral', worker_id: 'w', project_id: 'p', activity_ids: [], valid_from: '2026-01-01', valid_to: null },
    { id: 'esp', worker_id: 'w', project_id: 'p', activity_ids: ['a1'], valid_from: '2026-10-01', valid_to: '2026-10-31' },
    { id: 'velho', worker_id: 'w', project_id: 'p', activity_ids: ['a2'], valid_from: '2026-01-01', valid_to: '2026-06-30' },
  ];
  igual(vinculoVigente(v, 'w', 'p', 'a1', '2026-10-13').id, 'esp');
  igual(vinculoVigente(v, 'w', 'p', 'a1', '2026-11-05').id, 'geral', 'vencido:');
  igual(vinculoVigente(v, 'w', 'p', 'a2', '2026-10-13').id, 'geral');
  igual(vinculoVigente(v, 'x', 'p', 'a1', '2026-10-13'), null);
});
teste('Acumulado (prévia): anterior da última medição antes do período + executado; sem quantidade prevista, em %', () => {
  const ms = [{ data: '2026-10-01', pct: 40, qtdAcum: null }, { data: '2026-10-06', pct: 60, qtdAcum: 121.8 }, { data: '2026-10-20', pct: 90, qtdAcum: 182.7 }];
  const p = previaAcumulado(ms, { planned_qty: 203, period_qty: 50 }, '2026-10-07');
  igual(p.anterior, 121.8); igual(p.acumulado, 171.8); igual(p.saldo, 31.2);
  const q = previaAcumulado(ms, { planned_qty: null, period_pct: 15 }, '2026-10-07');
  igual(q.anteriorPct, 60); igual(q.pct, 75);
  igual(previaAcumulado([], { planned_qty: 10, period_qty: 12 }, '2026-10-07').saldo, 0, 'saldo nunca negativo:');
});
teste('Pagamento: "Pago" só com pagamentos que cobrem a despesa; aprovação ≠ pagamento', () => {
  igual(situacaoPagamento(750, null).rotulo, 'A lançar no Financeiro');
  igual(situacaoPagamento(750, { valor: 750, pagamentos: [] }).rotulo, 'A pagar');
  igual(situacaoPagamento(750, { valor: 750, pagamentos: [{ valor: 300 }] }).rotulo, 'Pago em parte');
  igual(situacaoPagamento(750, { valor: 750, pagamentos: [{ valor: 300 }, { valor: 450 }] }).rotulo, 'Pago');
  igual(situacaoPagamento(null, null).rotulo, 'Sem valor automático');
});
teste('Resumo por profissional: filtros por obra, fase e período; aprovada só de boletins aprovados', () => {
  const boletins = [{ id: 'b1', project_id: 'p', status: 'aprovado', period_start: '2026-10-07', period_end: '2026-10-13' }, { id: 'b2', project_id: 'p', status: 'rascunho', period_start: '2026-10-14', period_end: '2026-10-20' }];
  const itens = [{ id: 'i1', sheet_id: 'b1', activity_id: 'a1' }, { id: 'i2', sheet_id: 'b2', activity_id: 'a2' }];
  const linhas = [{ id: 'l1', item_id: 'i1', sheet_id: 'b1', worker_id: 'w', produced_qty: 30, approved_qty: 28 }, { id: 'l2', item_id: 'i2', sheet_id: 'b2', worker_id: 'w', produced_qty: 10, approved_qty: null }];
  const lista = linhasResumo({ boletins, itens, linhas, pagamentos: [{ worker_line_id: 'l1', amount: 700 }] });
  const t = somarPor(lista, (x) => x.l.worker_id).get('w');
  igual(t.produzida, 40); igual(t.aprovada, 28); igual(t.valor, 700);
  igual(linhasResumo({ boletins, itens, linhas, filtros: { fases: new Set(['a2']) } }).length, 1, 'fase:');
  igual(linhasResumo({ boletins, itens, linhas, filtros: { ate: '2026-10-13' } }).length, 1, 'período:');
});

grupo('21. EAP primeiro: modelo base do GEPLAN, obra sem planilha, mover itens e sugestão da leitura de projeto');
teste('Modelo base embutido: 16 etapas, 87 subetapas, 453 atividades, predecessoras ligadas, ids fixos, sem quantidades da obra de origem', () => {
  const M = modeloBase();
  const et = etapasDoModelo(M);
  igual(et.length, 16); igual(et.reduce((s, e) => s + e.subetapas.length, 0), 87); igual(et.reduce((s, e) => s + e.nAtiv, 0), 453);
  igual(M.id, MODELO_BASE_UUID); verdade(M.eap.every((a) => a.id === `gb-${a.codigo}`), 'ids fixos'); igual(modeloBase(), M, 'mesma instância:');
  verdade(M.dependencias.length > 450 && M.dependencias.every((d) => d.atividadeId && d.predecessoraId), 'predecessoras');
  verdade(!M.eap.some((a) => /\d+ estacas|m³|~\d|Ø/.test(a.descricao)), 'quantidade da obra de origem no nome');
  verdade(M.dependencias.some((d) => d.atividadeId === 'gb-3.1.1' && d.predecessoraId === 'gb-2.6.5'), '3.1.1 depois da fundação');
});
teste('Empresa sem modelo próprio: o inicial é o do GEPLAN; com modelo próprio marcado, o próprio vem primeiro', () => {
  const lib = emptyLib();
  igual(modeloInicial(lib), modeloBase()); igual(modelosDisponiveis(lib).length, 1);
  const C = duplicarModelo(modeloBase(), 'Meu modelo'); lib.modelosEAP.push(C); lib.modeloPadraoId = C.id;
  igual(modeloInicial(lib), C); igual(modelosDisponiveis(lib).length, 2);
  verdade(C.id !== modeloBase().id && C.eap.length === modeloBase().eap.length, 'cópia editável independente');
});
teste('Obra nova a partir do modelo base, sem planilha: escolhe etapas; cronograma calcula; acrescentar fases depois reconhece o que já está', () => {
  const lib = emptyLib(); const M = modeloBase();
  const o = novaObra({ nome: 'Sem planilha', inicio: '2026-10-19' });
  const et = etapasDoModelo(M);
  const sel = { etapas: new Set([et[0].id, et[1].id]), subetapas: new Set([...et[0].subetapas, ...et[1].subetapas].map((s) => s.id)) };
  instanciarModelo(o, M, sel, { orcamento: false }, lib);
  igual(o.eap.filter((a) => !a.parentId).length, 2); igual(o.eap.length, 1 + 8 + 44 + 1 + 6 + 40);
  const cron = cronograma(o, lib, calcular(o, lib));
  verdade(!cron.ciclo && cron.durTotal > 0, 'cronograma');
  const n = o.eap.length;
  instanciarModelo(o, M, { etapas: new Set([et[0].id, et[2].id]), subetapas: new Set([...et[0].subetapas, ...et[2].subetapas].map((s) => s.id)) }, { orcamento: false }, lib);
  igual(o.eap.length, n + 1 + 7 + 36, 'só acrescenta a etapa 3:');
  verdade(o.dependencias.some((d) => o.eap.find((a) => a.id === d.atividadeId)?.codigo === '3.1.1'), '3.1.1 religada à fundação');
});
teste('Mover item para outra etapa: leva as subatividades, mantém vínculos e predecessoras, renumera e atualiza a etapa', () => {
  const o = novaObra({ nome: 'Mover', inicio: '2026-10-19' });
  const e1 = novaAtividade({ descricao: 'Etapa A' }), e2 = novaAtividade({ descricao: 'Etapa B' });
  o.eap.push(e1, e2);
  const s = novaAtividade({ parentId: e1.id, descricao: 'Sub' }); o.eap.push(s);
  const f1 = novaAtividade({ parentId: s.id, descricao: 'F1' }), f2 = novaAtividade({ parentId: e2.id, descricao: 'F2' }); o.eap.push(f1, f2);
  renumerar(o);
  o.dependencias.push({ id: uid(), atividadeId: f2.id, predecessoraId: f1.id, tipo: 'FS', lag: 0 });
  moverNo(o, s.id, e2.id);
  igual(s.parentId, e2.id); igual(s.codigo, '2.2'); igual(f1.codigo, '2.2.1'); igual(f1.etapa, 'Etapa B'); igual(f1.subetapa, 'Sub');
  igual(o.dependencias.length, 1, 'predecessora mantida:');
  let erro = ''; try { moverNo(o, e2.id, f1.id); } catch (e) { erro = e.message; }
  verdade(/dentro dele mesmo/.test(erro), 'mover para dentro de si');
  verdade(subarvore(o, e2.id).has(f1.id), 'subárvore');
});
teste('Leitura de projeto: lista enviada à IA, seleção pelo que a IA marcou (códigos inválidos ignorados) e aplicação com serviços fora do modelo', () => {
  const M = modeloBase(); const lib = emptyLib();
  const lista = etapasParaIA(M);
  igual(lista.length, 16); igual(lista[0].subetapas[0].codigo, '1.1');
  const sug = { etapas: [
    { codigo: '1', incluir: true, subetapas: [{ codigo: '1.1', incluir: true }, { codigo: '1.6', incluir: false }, { codigo: '9.9', incluir: true }] },
    { codigo: '10', incluir: false, subetapas: [{ codigo: '10.1', incluir: false }] },
    { codigo: '99', incluir: true, subetapas: [] },
  ], novas: [{ etapa_codigo: '1', etapa_nova: '', nome: 'Muro de arrimo', motivo: 'corte no terreno', paginas: 'p. 2' }, { etapa_codigo: '', etapa_nova: 'Elevador', nome: 'Instalação do elevador', motivo: '', paginas: '' }] };
  const sel = selecaoDaSugestao(M, sug);
  igual(sel.etapas.size, 1); igual([...sel.subetapas].join(), 'gb-1.1');
  const o = novaObra({ nome: 'IA', inicio: '2026-10-19' });
  const r = aplicarSugestao(o, M, sel, sug.novas, lib);
  igual(o.eap.filter((a) => !a.parentId).map((a) => a.descricao).join(' | '), 'Serviços Preliminares | Elevador');
  verdade(o.eap.some((a) => a.descricao === 'Muro de arrimo' && /corte no terreno \(p\. 2\)/.test(a.obs)), 'nova dentro da etapa 1');
  igual(r.novas, 2); igual(o.eap.find((a) => a.descricao === 'Instalação do elevador').codigo, '2.1');
});

teste('Obra de exemplo (demonstração): EAP completa, orçamento R$ 224.306,00 todo vinculado, cronograma calcula; não mexe nas composições da empresa', () => {
  const lib = emptyLib();
  lib.composicoes.push({ id: 'minha', codigo: 'C001', descricao: 'Minha composição', unidade: 'm²', ativa: true, versao: 1, maoObra: [{ id: 'm1', funcao: 'Pedreiro', coef: 2, lider: true }] });
  const { obra } = criarObraExemplo(lib, { nome: 'Exemplo (demonstração)', inicio: '2026-11-03' });
  const calc = calcular(obra, lib);
  igual(Math.round(calc.totalOrcamento * 100) / 100, 224306);
  verdade([...calc.itens.values()].every((x) => x.status === 'OK'), 'vínculos incompletos');
  igual(obra.eap.filter((a) => !a.parentId).length, 16);
  verdade(lib.composicoes.find((c) => c.id === 'minha').ativa, 'composição da empresa desativada');
  verdade(lib.composicoes.filter((c) => c.codigo.startsWith('EX-')).length === 10, 'composições EX-');
  const cron = cronograma(obra, lib, calc);
  verdade(!cron.ciclo && cron.durTotal > 0, 'cronograma');
  igual(obra.eap.find((a) => a.codigo === '2.4.4').equipe, 3);
  igual(calc.ativ.get(obra.eap.find((a) => a.codigo === '2.4.4').id).dur, 10, 'formas 203 m² × 1,1 h ÷ (3 × 8,8 × 0,85):');
});

grupo('20. Integração de custos: por fase, cancelados, medições a lançar, data de corte e categoria');
function obraIntegracao() {
  const o2 = novaObra({ nome: 'Int', inicio: '2026-10-05' });
  o2.eap = [{ id: 'F1', parentId: null, codigo: '1', descricao: 'Fundação' }, { id: 'a1', parentId: 'F1', codigo: '1.1', descricao: 'Formas' },
    { id: 'F2', parentId: null, codigo: '2', descricao: 'Estrutura' }, { id: 'a2', parentId: 'F2', codigo: '2.1', descricao: 'Pilares' }];
  o2.orcamento = [{ id: 'i1' }, { id: 'i2' }];
  o2.vinculos = [{ itemId: 'i1', atividadeId: 'a1', pct: 0.5 }, { itemId: 'i1', atividadeId: 'a2', pct: 0.3 }, { itemId: 'i2', atividadeId: 'a2', pct: 1 }];
  o2.compromissos = [
    { id: 'k1', tipo: 'Contrato', valor: 5000, status: 'Aprovado', faseId: 'a2', categoria: 'Serviço terceirizado', aditivos: [{ data: '2026-11-20', valor: 500 }] },
    { id: 'k2', tipo: 'Pedido de compra', valor: 2000, status: 'Cancelado', itemId: 'i1', categoria: 'Material', aditivos: [] },
  ];
  o2.despesas = [
    { id: 'd1', compromissoId: 'k1', data: '2026-10-20', valor: 1200, categoria: 'Serviço terceirizado', pagamentos: [{ data: '2026-10-25', valor: 1000 }] },
    { id: 'd2', compromissoId: 'k2', data: '2026-10-21', valor: 300, categoria: 'Material', pagamentos: [] },
    { id: 'd3', data: '2026-12-01', valor: 800, faseId: 'F1', categoria: 'Equipamento', pagamentos: [] },
    { id: 'd4', data: '2026-10-22', valor: 100, categoria: 'Indireto', pagamentos: [] },
  ];
  return o2;
}
const totais = { i1: 1000, i2: 400 };
const aLancar = [{ faseId: 'F1', data: '2026-10-13', valor: 280 }];
teste('Cancelado/encerrado conta só o incorrido; "a lançar" entra no comprometido e no a incorrer', () => {
  const r = resumoCustos(obraIntegracao(), { aLancar });
  igual(r.comprometido, 5500 + 300 + 800 + 100 + 280); igual(r.aLancar, 280);
  igual(r.aIncorrer, (5500 - 1200) + 0 + 280);
  const o2 = obraIntegracao(); o2.compromissos[1].status = 'Aprovado';
  igual(resumoCustos(o2).comprometido, 5500 + 2000 + 800 + 100, 'pedido ativo conta o valor inteiro:');
});
teste('Fase de cada valor: informada → item (pelos vínculos, resto em "Sem fase") → contrato → "Sem fase"', () => {
  const p = custosPorFase(obraIntegracao(), { totalItem: (id) => totais[id], aLancar });
  const f = (id) => p.fases.find((x) => x.id === id);
  perto(f('F1').orcado, 500); perto(f('F2').orcado, 300 + 400); perto(f(null).orcado, 200);
  perto(f('F2').comprometido, 5500 + 90, 1e-9, 'contrato pela fase (raiz) + 30% do cancelado:');
  perto(f('F2').incorrido, 1200 + 90); perto(f('F2').pago, 1000);
  perto(f('F1').comprometido, 150 + 800 + 280); perto(f('F1').aLancar, 280);
  perto(f(null).incorrido, 60 + 100); igual(p.semFase, 3, 'lançamentos sem fase (pedido cancelado e sua nota: 20% do item; recibo avulso):');
  const r = resumoCustos(obraIntegracao(), { aLancar });
  perto(p.totais.comprometido, r.comprometido, 1e-9); perto(p.totais.incorrido, r.incorrido, 1e-9); perto(p.totais.pago, r.pago, 1e-9);
  igual(p.fases.map((x) => x.id).join(), 'F1,F2,', 'ordem da EAP e "Sem fase" por último:');
});
teste('Data de corte (despesa, aditivo, pagamento) e filtro de categoria (orçado não muda)', () => {
  const p = custosPorFase(obraIntegracao(), { totalItem: (id) => totais[id], ateDia: toDay('2026-11-15'), aLancar });
  const f = (id) => p.fases.find((x) => x.id === id);
  perto(f('F1').incorrido, 150); perto(f('F2').comprometido, 5000 + 90, 1e-9, 'aditivo depois do corte:');
  const m = custosPorFase(obraIntegracao(), { totalItem: (id) => totais[id], aLancar, categoria: 'Material' });
  perto(m.totais.comprometido, 300); perto(m.totais.aLancar, 0); perto(m.totais.orcado, 1400);
});

/* ---------- 7. Importação da planilha ---------- */
grupo('7. Importador (lê docs/modelo_orcamento_cronograma.xlsx, se existir)');
async function testeImportacao() {
  let buf = null;
  for (const nome of ['../docs/modelo_orcamento_cronograma.xlsx', '../docs/modelo_orcamento_cronograma.xlsx.xlsx']) {
    try { const r = await fetch(nome); if (r.ok) { buf = await r.arrayBuffer(); break; } } catch {}
  }
  if (!buf) { teste('Planilha não encontrada em docs/ (teste pulado)', () => 'skip'); return; }
  await loadScript(LIBS.xlsx);
  const wb = window.XLSX.read(buf, { type: 'array' });
  const d = interpretar(wb);
  // valores esperados lidos da própria planilha (aba Duracao_Atividades: ID, duração adotada, custo alocado)
  const X = window.XLSX;
  const linhasDur = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames.find((n) => /dura/i.test(n))], { header: 1, raw: true });
  const iCab = linhasDur.findIndex((r) => String(r[0]).includes('ID Atividade'));
  const cab = linhasDur[iCab].map((x) => String(x || ''));
  const jAdot = cab.findIndex((x) => /adotada/i.test(x)), jCusto = cab.findIndex((x) => /custo/i.test(x));
  const esperado = linhasDur.slice(iCab + 1).filter((r) => /^\d/.test(String(r[0] || ''))).map((r) => ({ cod: String(r[0]), dur: r[jAdot], custo: r[jCusto] }));
  const linhasOrc = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames.find((n) => /^or/i.test(n))], { header: 1, raw: true });
  const totalPlanilha = linhasOrc.slice(1).filter((r) => r[0] && String(r[0]).startsWith('O-')).reduce((s, r) => s + (Number(r[8]) || 0), 0);

  teste(`Lê as abas: ${d.atividades.length} linhas de EAP, ${d.composicoes.length} composições, ${d.orcamento.length} itens, ${d.vinculos.length} vínculos, ${d.duracoes.size} durações`, () => {
    verdade(d.atividades.length > 100 && d.composicoes.length > 0 && d.orcamento.length > 0 && d.vinculos.length > 0 && d.duracoes.size > 0, 'aba vazia');
    verdade(d.premissas.jornada > 0 && d.premissas.eficiencia > 0, 'premissas');
    igual(d.avisos.length, 0, `avisos: ${d.avisos.join(' | ')}`);
  });

  const libI = emptyLib();
  const { obra: ob, modelo } = criarObraImportada(d, { nome: 'Importada', inicio: '2026-10-05' }, libI);
  const cc = calcular(ob, libI);
  const cr = cronograma(ob, libI, cc);
  const codOrig = new Map(modelo.eap.map((n) => [n.id, n.codigoOrig || n.codigo]));
  const orig = (a) => codOrig.get(a.modeloAtivId);
  const porMod = new Map(ob.eap.map((a) => [orig(a), a]));
  const etapaId = (cod) => modelo.eap.find((n) => !n.parentId && (n.codigoOrig || n.codigo) === cod)?.id;
  teste(`Durações adotadas iguais à planilha (${esperado.length} atividades da aba Duracao_Atividades, jornada ${d.premissas.jornada} h)`, () => {
    for (const e of esperado) {
      const a = porMod.get(e.cod);
      verdade(a, `${e.cod} não importada`);
      igual(cc.ativ.get(a.id).dur, Number(e.dur), `${e.cod}:`);
      perto(cc.ativ.get(a.id).custo, Number(e.custo) || 0, 1e-6, `${e.cod} custo:`);
    }
  });
  teste(`Custo alocado = total do orçamento da planilha (${totalPlanilha.toLocaleString('pt-BR')})`, () => { perto(cc.totalAlocado, totalPlanilha, 1e-6); perto(cc.totalOrcamento, totalPlanilha, 1e-6); });
  teste('Predecessoras convertidas e nenhum ciclo', () => {
    verdade(ob.dependencias.length > 300, `só ${ob.dependencias.length}`); verdade(!cr.ciclo, `ciclo em ${cr.cicloIds.length} atividades`);
  });
  const etapas = etapasDoModelo(modelo);
  const variantes = etapas.filter((e) => e.variante);
  teste(`Modelo: variantes ficam ao lado da etapa base com letra (${variantes.map((v) => v.codigo).join(', ') || 'nenhuma'}) e ficam fora da obra por padrão`, () => {
    for (const v of variantes) {
      verdade(/[A-Z]$/.test(v.codigo), `código ${v.codigo}`);
      const base = etapas.find((e) => e.id === v.base);
      igual(etapas.indexOf(v), etapas.indexOf(base) + 1, 'posição no modelo');
      verdade(!ob.eap.some((a) => orig(a)?.startsWith((modelo.eap.find((n) => n.id === v.id).codigoOrig) + '.')), `${v.codigo} entrou na obra`);
    }
  });

  teste('Escolher fases: obra só com etapas 1 e 3; a 1ª atividade da 3 herda as predecessoras das fases ausentes (não começa no dia 0)', () => {
    const lib2 = emptyLib(); const o2 = novaObra({ nome: 'Fases', inicio: '2026-10-05' });
    const sp = selecaoPadrao(modelo);
    instanciarModelo(o2, modelo, { etapas: new Set([etapaId('1'), etapaId('3')]), subetapas: sp.subetapas }, { orcamento: true, quantidades: true }, lib2);
    igual(o2.eap.filter((a) => a.nivel === 1).map((a) => a.codigo).join(','), '1,2', 'renumeradas');
    const r2 = cronograma(o2, lib2, calcular(o2, lib2));
    const primeira3 = o2.eap.find((a) => orig(a) === '3.1.1');
    verdade(r2.nos.get(primeira3.id).es > 0, '3.1.1 começa no dia 0 (perdeu as predecessoras)');
    const ant = o2.eap.length;
    instanciarModelo(o2, modelo, { etapas: new Set([etapaId('1'), etapaId('2'), etapaId('3')]), subetapas: sp.subetapas }, { orcamento: true }, lib2);
    verdade(o2.eap.length > ant, 'não acrescentou');
    igual(o2.eap.filter((a) => a.nivel === 1).map((a) => orig(a)).join(','), '1,2,3', 'ordem do modelo');
    const ant2 = o2.eap.length;
    instanciarModelo(o2, modelo, { etapas: new Set([etapaId('1'), etapaId('2'), etapaId('3')]), subetapas: sp.subetapas }, { orcamento: true }, lib2);
    igual(o2.eap.length, ant2, 'repetir não duplica');
  });
  if (variantes.length) {
    const v = variantes[0];
    teste(`Variante ${v.codigo}: entra no lugar da etapa base e as predecessoras externas são trocadas`, () => {
      const lib3 = emptyLib(); const o3 = novaObra({ nome: 'Var', inicio: '2026-10-05' });
      const sp = selecaoPadrao(modelo); sp.etapas.delete(v.base); sp.etapas.add(v.id);
      instanciarModelo(o3, modelo, sp, {}, lib3);
      const raizes = o3.eap.filter((a) => a.nivel === 1).map((a) => a.modeloAtivId);
      verdade(!raizes.includes(v.base), 'base entrou');
      igual(raizes.indexOf(v.id), etapas.filter((e) => !e.variante).findIndex((e) => e.id === v.base), 'posição');
      const idsVar = new Set(o3.eap.filter((a) => { let x = modelo.eap.find((n) => n.id === a.modeloAtivId); while (x?.parentId) x = modelo.eap.find((n) => n.id === x.parentId); return x?.id === v.id; }).map((a) => a.id));
      const externas = o3.dependencias.filter((x) => idsVar.has(x.predecessoraId) && !idsVar.has(x.atividadeId));
      verdade(externas.length > 0, 'nenhuma atividade de fora depende da variante');
      verdade(!cronograma(o3, lib3, calcular(o3, lib3)).ciclo, 'ciclo');
    });
  }
  teste('Aba Fases: renomear e reordenar fases no modelo não quebra a obra (sem duplicar ao adicionar mais fases)', () => {
    const M = duplicarModelo(modelo, 'Teste'); const lib4 = emptyLib(); const o4 = novaObra({ nome: 'X', inicio: '2026-10-05' });
    const e1 = M.eap.find((n) => !n.parentId && n.codigo === '1'), e3 = M.eap.find((n) => !n.parentId && n.codigo === '3');
    const sp = selecaoPadrao(M);
    instanciarModelo(o4, M, { etapas: new Set([e1.id]), subetapas: sp.subetapas }, {}, lib4);
    const n1 = o4.eap.length;
    // edita o modelo: renomeia a etapa 3 e move para o topo
    e3.descricao = 'Fundação (renomeada)';
    M.eap.splice(M.eap.indexOf(e3), 1); M.eap.unshift(e3); renumerar(M);
    instanciarModelo(o4, M, { etapas: new Set([e1.id, e3.id]), subetapas: sp.subetapas }, {}, lib4);
    verdade(o4.eap.some((a) => a.descricao === 'Fundação (renomeada)'), 'nome novo não veio');
    igual(o4.eap.filter((a) => a.modeloAtivId === e1.id).length, 1, 'etapa 1 duplicou');
    verdade(o4.eap.length > n1, 'não acrescentou');
  });
}

/* ---------- 8. Base SINAPI (planilhas sintéticas nos dois layouts) ---------- */
async function testeSinapi() {
  grupo('8. Base SINAPI — leitura da planilha da Caixa');
  await loadScript(LIBS.xlsx);
  const X = window.XLSX;
  const wbDe = (aoa) => { const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), 'Analitico'); return wb; };
  // layout clássico: dados da composição repetidos em cada linha de item
  const classico = wbDe([
    ['SINAPI - CUSTO DE REFERÊNCIA DE COMPOSIÇÕES ANALÍTICO'], ['Localidade: SP  Mês de coleta: 08/2026  Encargos: NÃO DESONERADO'], [],
    ['DESCRICAO DA CLASSE', 'CODIGO DA COMPOSICAO', 'DESCRICAO DA COMPOSICAO', 'UNIDADE', 'TIPO ITEM', 'CODIGO ITEM', 'DESCRIÇÃO ITEM', 'UNIDADE ITEM', 'COEFICIENTE'],
    ['ALVENARIA', '87503', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', 'COMPOSICAO', '88309', 'PEDREIRO COM ENCARGOS COMPLEMENTARES', 'H', 0.85],
    ['ALVENARIA', '87503', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', 'COMPOSICAO', '88316', 'SERVENTE COM ENCARGOS COMPLEMENTARES', 'H', 0.45],
    ['ALVENARIA', '87503', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', 'INSUMO', '7271', 'BLOCO CERAMICO 14X19X39', 'UN', 13.35],
  ]);
  // layout com linha própria para a composição (tipo vazio) e uma só coluna de descrição/unidade
  const novo = wbDe([
    ['Grupo', 'Código da Composição', 'Tipo Item', 'Código do Item', 'Descrição', 'Unidade', 'Coeficiente'],
    ['REVESTIMENTO', '87529', '', '', 'MASSA ÚNICA, PARA RECEBIMENTO DE PINTURA, ESPESSURA 20MM', 'M2', ''],
    ['REVESTIMENTO', '87529', 'COMPOSICAO', '88309', 'PEDREIRO COM ENCARGOS COMPLEMENTARES', 'H', 0.7],
    ['REVESTIMENTO', '87529', 'COMPOSICAO', '88316', 'SERVENTE COM ENCARGOS COMPLEMENTARES', 'H', 0.55],
    ['REVESTIMENTO', '87529', 'INSUMO', '370', 'AREIA MEDIA', 'M3', 0.024],
  ]);
  const a = interpretarSinapi(classico), b = interpretarSinapi(novo);
  teste('Layout clássico: composição, unidade, itens e referência (SP · 08/2026 · não desonerado)', () => {
    igual(a.composicoes.length, 1); const c = a.composicoes[0];
    igual(c.c, '87503'); igual(c.u, 'M2'); igual(c.it.length, 3); verdade(c.d.startsWith('ALVENARIA'), c.d);
    igual(a.ref, 'SP · 08/2026 · não desonerado');
  });
  teste('Layout com linha da composição: descrição/unidade da linha própria e itens abaixo', () => {
    igual(b.composicoes.length, 1); const c = b.composicoes[0];
    igual(c.c, '87529'); verdade(c.d.startsWith('MASSA ÚNICA'), c.d); igual(c.u, 'M2'); igual(c.it.length, 3);
  });
  teste('Mão de obra: itens em horas viram funções; líder sugerida = Pedreiro (não o servente)', () => {
    const mo = maoDeObra(a.composicoes[0]);
    igual(mo.map((f) => `${f.funcao}:${f.coef}${f.lider ? '*' : ''}`).join(' '), 'Pedreiro:0.85* Servente:0.45');
  });
  teste('Adicionar à biblioteca: composição SINAPI editável com fonte e referência', () => {
    const lib5 = emptyLib(); const c = adicionarDaSinapi(a.composicoes[0], lib5);
    igual(c.fonte, 'SINAPI'); igual(c.refSinapi, '87503'); igual(c.maoObra.filter((f) => f.lider).length, 1);
  });
}
/* ---------- 22. Bases de referência: planilha da Caixa a partir de 2025 (todas as UF numa pasta) ---------- */
async function testeBasesRef() {
  grupo('22. Bases de referência — SINAPI 2025+ (27 UF numa pasta: CSD/CCD, ISD/ICD, Analítico)');
  await loadScript(LIBS.xlsx);
  const X = window.XLSX;
  const wb = X.utils.book_new();
  const aba = (nome, aoa) => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), nome);
  const topo = (t) => [['SINAPI - Sistema Nacional de Pesquisa de Custos e Índices da Construção Civil'], [t], ['Mês de Referência:', '09/2026'], ['Data de emissão:', '09/10/2026']];
  aba('Menu', [['SINAPI'], ['Insumos Não Desonerado', 'Relatório de preços de insumos sem desoneração']]);
  aba('ISD', [...topo('RELATÓRIO DE PREÇOS DE INSUMOS - ENCARGOS SOCIAIS SEM DESONERAÇÃO'), [], [],
    ['Classificação', 'Código do\nInsumo', 'Descrição do Insumo', 'Unidade', 'Origem de\nPreço', 'MG', 'SP'],
    ['MATERIAL', 7271, 'BLOCO CERAMICO 14X19X39', 'UN', 'C', 1.1, '1,25']]);
  aba('CSD', [...topo('RELATÓRIO DE CUSTOS DE COMPOSIÇÕES - ENCARGOS SOCIAIS SEM DESONERAÇÃO'), [], [], [], ['', '', '', '', 'MG', '', 'SP', ''],
    ['Grupo', 'Código da\nComposição', 'Descrição', 'Unidade', 'Custo (R$)', '%AS', 'Custo (R$)', '%AS'],
    ['Alvenaria', '87503', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', 70.5, '-', '1.080,40', '-'],
    ['Alvenaria', '99999', 'COMPOSIÇÃO SEM CUSTO EM SP', 'M2', 10, '-', 0, '-']]);
  aba('CCD', [...topo('RELATÓRIO DE CUSTOS DE COMPOSIÇÕES - ENCARGOS SOCIAIS COM DESONERAÇÃO'), [], [], [], ['', '', '', '', 'MG', '', 'SP', ''],
    ['Grupo', 'Código da\nComposição', 'Descrição', 'Unidade', 'Custo (R$)', '%AS', 'Custo (R$)', '%AS'],
    ['Alvenaria', '87503', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', 68, '-', 1060, '-']]);
  aba('CSE', [...topo('RELATÓRIO DE CUSTOS DE COMPOSIÇÕES - SEM ENCARGOS SOCIAIS'), [], [], [], ['', '', '', '', 'MG', '', 'SP', ''],
    ['Grupo', 'Código da\nComposição', 'Descrição', 'Unidade', 'Custo (R$)', '%AS', 'Custo (R$)', '%AS'],
    ['Alvenaria', '87503', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', 1, '-', 1, '-']]);
  aba('Analítico', [['SINAPI'], ['RELATÓRIO ANALÍTICO DE COMPOSIÇÕES'], ['Mês de Referência:', '09/2026'], [],
    ['Grupo', 'Código da\nComposição', 'Tipo Item', 'Código do\nItem', 'Descrição', 'Unidade', 'Coeficiente', 'Situação'],
    ['Alvenaria', '87503', '', '', 'ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 14 CM', 'M2', '', 'COM CUSTO'],
    ['Alvenaria', '87503', 'COMPOSICAO', '88309', 'PEDREIRO COM ENCARGOS COMPLEMENTARES', 'H', 0.85, 'COM CUSTO'],
    ['Alvenaria', '87503', 'COMPOSICAO', '88316', 'SERVENTE COM ENCARGOS COMPLEMENTARES', 'H', '0,4500000', 'COM CUSTO'],
    ['Alvenaria', '87503', 'INSUMO', '7271', 'BLOCO CERAMICO 14X19X39', 'UN', 13.35, 'COM PREÇO']]);
  aba('Analítico com Custo', [['SINAPI'], ['ANALÍTICO DE COMPOSIÇÃO COM CUSTO'], ['Mês de Referência:', '09/2026'], [], ['Tipo Item', 'Código do Item', 'Coeficiente'], ['#NOME?', '', '']]);
  // como no arquivo da Caixa: código como hiperlink para o analítico, com valor guardado 0
  wb.Sheets.CSD.B10 = { t: 'n', v: 0, f: 'HYPERLINK("#"&CELL("address",OFFSET(Analítico!$B$1,MATCH(87503,Analítico!$B:$B,0)-1,3)),87503)' };
  const d = interpretarReferenciaSinapi(wb, X);
  const c = d.composicoes.find((x) => x.codigo === '87503');
  teste('Mês, regimes e UF lidos do arquivo; aba "sem encargos" e "analítico com custo" ignoradas; sem avisos', () => {
    igual(d.mes, '2026-09-01'); igual(d.regimes.sort().join(), 'desonerado,nao_desonerado'); igual(d.ufs.join(), 'MG,SP');
    igual(d.avisos.length, 0, d.avisos.join(' | ')); igual(d.itens.length, 3, 'itens do analítico:');
  });
  teste('Código lido do hiperlink (valor guardado 0); nenhuma composição com código 0', () => {
    verdade(!!c, '87503 não lida'); verdade(!d.composicoes.some((x) => x.codigo === '0'), 'código 0');
  });
  teste('Custo por regime e UF (número ou texto "1.080,40"); hífen ou zero = sem custo; insumo com preço por UF', () => {
    igual(custoEm(c, 'SP', 'nao_desonerado'), 1080.4); igual(custoEm(c, 'MG', 'desonerado'), 68); igual(custoEm(c, 'SP', 'desonerado'), 1060);
    igual(custoEm(d.composicoes.find((x) => x.codigo === '99999'), 'SP', 'nao_desonerado'), null, 'hífen:');
    igual(d.insumos[0].precos.nao_desonerado.SP, 1.25); igual(c.situacao, 'COM CUSTO'); verdade(c.busca.includes('vedacao de blocos ceramicos'), c.busca);
  });
  teste('Mão de obra do analítico (coeficiente em texto "0,4500000") e líder; nome da versão com retificação', () => {
    igual(maoDeObraItens(d.itens.filter((i) => i.composicao === '87503')).map((f) => `${f.funcao}:${f.coef}${f.lider ? '*' : ''}`).join(' '), 'Pedreiro:0.85* Servente:0.45');
    igual(nomeVersao('SINAPI', d.mes, 'SINAPI-2026-09-formato-xlsx.zip'), 'SINAPI 09/2026');
    igual(nomeVersao('SINAPI', '2026-02-01', 'SINAPI-2026-02-formato-xlsx_Retificacao01.zip'), 'SINAPI 02/2026 · retificação 01');
    igual(variacao(100, 112.5), 12.5); igual(variacao(null, 5), null);
  });
}

testeImportacao().then(testeSinapi).then(testeBasesRef).finally(() => {
  const r = document.getElementById('resumo');
  r.className = fail ? 'err' : 'ok';
  r.textContent = `${ok} passaram · ${fail} falharam${skip ? ` · ${skip} pulados` : ''}`;
  window.__resultado = { ok, fail, skip };
});
