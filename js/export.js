// Exportação para Excel (SheetJS) e PDF (jsPDF). As bibliotecas são carregadas só quando usadas.
import { LIBS, loadScript } from './libs.js';
import { fmtBR, fmtNum, todayDay, dateParts, MESES } from './schedule.js';
import { curvaS } from './curvaS.js';
import { liderDe } from './calculo.js';

const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '-');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function linhasAtividades(c) {
  return c.o.eap.map((a) => {
    const A = c.calc.ativ.get(a.id), n = c.cron.nos.get(a.id);
    return {
      a, folha: A.folha, critico: n.critico,
      cells: [a.codigo, a.nivel, a.descricao, A.folha ? a.tipo : '', A.funcaoLider || '', r2(A.hh) || '', A.folha ? (a.equipe ?? '') : '',
        A.folha ? (A.durCalc ?? '') : '', A.folha ? (a.duracaoManual ?? '') : '', n.dur, A.provisoria ? 'provisória' : '',
        fmtBR(n.inicio), fmtBR(n.termino), A.folha ? c.predsTexto(a) : '', n.folga, n.critico && A.folha ? 'Sim' : '', r2(A.custo) || '', A.folha ? Number(a.pct) || 0 : '',
        A.alertas.join(' | ')],
    };
  });
}
const HEAD_ATIV = ['Código', 'Nível', 'Atividade', 'Tipo', 'Função líder', 'HH', 'Equipe', 'Duração calc.', 'Duração manual', 'Duração adotada', 'Obs. duração', 'Início', 'Término', 'Predecessoras', 'Folga', 'Crítica', 'Custo alocado (R$)', '% executado', 'Alertas'];

export async function exportExcel(o, c) {
  await loadScript(LIBS.xlsx);
  const X = window.XLSX;
  const wb = X.utils.book_new();
  const cab = [[`Cronograma — ${o.nome}`], [`Início ${fmtBR(c.cron.inicio)} · Término ${fmtBR(c.cron.termino)} · ${c.cron.durTotal} dias úteis · Jornada ${fmtNum(c.calc.jornada)} h · Eficiência ${fmtNum(c.calc.eficiencia)}`], []];

  const ws = X.utils.aoa_to_sheet([...cab, HEAD_ATIV, ...linhasAtividades(c).map((r) => r.cells)]);
  ws['!cols'] = [10, 6, 50, 18, 16, 9, 8, 10, 10, 10, 11, 11, 11, 18, 7, 7, 14, 10, 40].map((w) => ({ wch: w }));
  X.utils.book_append_sheet(wb, ws, 'Atividades');

  const orc = [['Item', 'Etapa', 'Subetapa', 'Cód. composição', 'Descrição', 'Unid.', 'Quantidade', 'Custo unit. (R$)', 'Total (R$)', '% vinculado', 'Verificação'],
    ...o.orcamento.map((it) => { const I = c.calc.itens.get(it.id); return [it.codigo, it.etapa, it.subetapa, I.comp?.codigo || '', I.comp?.descricao || '', I.comp?.unidade || '', it.quantidade, it.custoUnit, r2(I.total), r2(I.pctSoma * 100) / 100, I.status]; }),
    ['', '', '', '', '', '', '', 'Total', r2(c.calc.totalOrcamento)]];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(orc), 'Orcamento');

  const vin = [['Item Orç.', 'ID Atividade (EAP)', '% da quantidade', 'Qtd alocada', 'Unid.', 'Função líder', 'Coef. líder (h/unid)', 'HH', 'Custo alocado (R$)'],
    ...c.calc.vinculos.map((r) => [r.item.codigo, r.atividade.codigo, r.pct, r2(r.qtd), r.unidade, r.funcao, r.coef, r2(r.hh), r2(r.custo)])];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(vin), 'Vinculo_Orc_EAP');

  const usadas = new Set(o.orcamento.map((it) => it.composicaoId));
  const comp = [['Cód. Composição', 'Descrição', 'Unid.', 'Função', 'Coef. (h/unid)', 'Função líder? (S/N)', 'Fonte', 'Versão']];
  for (const cp of c.lib.composicoes.filter((x) => usadas.has(x.id))) for (const m of cp.maoObra) comp.push([cp.codigo, cp.descricao, cp.unidade, m.funcao, m.coef, m.lider ? 'S' : 'N', cp.fonte, cp.versao]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(comp), 'Composicoes');

  const cs = curvaS(c.calc, c.cron, 'mes');
  const curva = [['Mês', 'Físico no período (%)', 'Físico acumulado (%)', 'Financeiro no período (R$)', 'Financeiro acumulado (R$)'],
    ...cs.periodos.map((p) => [p.label, r2(p.fisPer), r2(p.fisAc), r2(p.finPer), r2(p.finAc)])];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(curva), 'Curva S');

  if (o.medicoes?.length) {
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Data', 'Físico plan. (%)', 'Físico real (%)', 'Financeiro plan. (R$)', 'Financeiro real (R$)'],
      ...o.medicoes.map((m) => [m.data.split('-').reverse().join('/'), r2(m.fisicoPlan), r2(m.fisico), m.financeiroPlan == null ? '' : r2(m.financeiroPlan), m.financeiro == null ? '' : r2(m.financeiro)])]), 'Medições');
  }
  X.writeFile(wb, `Cronograma - ${safeName(o.nome)}.xlsx`);
}

/** PDF: tabela de atividades + Gantt (linhas visíveis na tela). */
export async function exportPDF(o, c, linhas) {
  await loadScript(LIBS.jspdf);
  await loadScript(LIBS.autotable);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = 297, H = 210, M = 10;
  const header = (title) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(20, 48, 90);
    doc.text('GEPLAN', W - M, M + 4, { align: 'right' });
    doc.text(title, M, M + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    doc.text(`${o.nome}  •  Início ${fmtBR(c.cron.inicio)}  •  Término ${fmtBR(c.cron.termino)}  •  ${c.cron.durTotal} dias úteis  •  Emitido em ${fmtBR(todayDay())}`, M, M + 10);
  };
  const rows = linhas.length ? linhas : c.o.eap;

  header('Cronograma de execução');
  doc.autoTable({
    startY: M + 14,
    head: [['Cód.', 'Atividade', 'Tipo', 'HH', 'Equipe', 'Dur.', 'Início', 'Término', 'Predec.', 'Folga', 'Custo (R$)']],
    body: rows.map((a) => {
      const A = c.calc.ativ.get(a.id), n = c.cron.nos.get(a.id);
      return [a.codigo, `${'  '.repeat(a.nivel - 1)}${a.descricao}`, A.folha ? a.tipo : '', A.hh ? fmtNum(A.hh, 1) : '', A.folha ? (a.equipe ?? '') : '',
        `${n.dur}${A.provisoria ? '*' : ''}`, fmtBR(n.inicio), fmtBR(n.termino), A.folha ? c.predsTexto(a) : '', n.folga, A.custo ? fmtNum(A.custo, 2) : ''];
    }),
    styles: { fontSize: 7.5, cellPadding: 1.2 },
    headStyles: { fillColor: [20, 48, 90] },
    columnStyles: { 1: { cellWidth: 82 }, 3: { halign: 'right' }, 5: { halign: 'right' }, 9: { halign: 'right' }, 10: { halign: 'right' } },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      const a = rows[d.row.index];
      if (!c.calc.ativ.get(a.id).folha) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = a.nivel === 1 ? [236, 228, 220] : [246, 238, 231]; }
      else if (c.cron.nos.get(a.id).critico && d.column.index === 1) d.cell.styles.textColor = [208, 59, 59];
    },
    margin: { left: M, right: M },
  });
  doc.setFontSize(7); doc.setTextColor(110);
  doc.text('* duração provisória (padrão do tipo de atividade). Atividades em vermelho estão no caminho crítico.', M, H - 6);

  // Gantt
  const labelW = 72, chartX = M + labelW, chartW = W - M - chartX, rowH = 5.4, top = M + 26;
  const d0 = c.cron.inicio, d1 = c.cron.termino + 1, span = Math.max(1, d1 - d0);
  const x = (d) => chartX + ((d - d0) / span) * chartW;
  const perPage = Math.floor((H - top - M - 6) / rowH);
  const meses = [];
  { const dt = new Date(d0 * 86400000); dt.setUTCDate(1); while (dt.getTime() / 86400000 < d1) { meses.push(Math.floor(dt.getTime() / 86400000)); dt.setUTCMonth(dt.getUTCMonth() + 1); } }
  const today = todayDay();
  for (let p = 0; p < rows.length; p += perPage) {
    doc.addPage(); header('Gráfico de Gantt');
    const page = rows.slice(p, p + perPage), bottom = top + page.length * rowH;
    doc.setDrawColor(220); doc.setLineWidth(0.1); doc.setFontSize(7); doc.setTextColor(110);
    for (const m of meses) {
      const mx = Math.max(chartX, x(m)); doc.line(mx, top - 6, mx, bottom);
      const pr = dateParts(Math.max(m, d0));
      if (mx < W - M - 6) doc.text(`${MESES[pr.m]}/${String(pr.y).slice(2)}`, mx + 1, top - 2);
    }
    page.forEach((a, i) => {
      const y = top + i * rowH, A = c.calc.ativ.get(a.id), n = c.cron.nos.get(a.id);
      doc.setDrawColor(235); doc.line(M, y + rowH, W - M, y + rowH);
      if (!A.folha) {
        doc.setFillColor(...(a.nivel === 1 ? [236, 228, 220] : [246, 238, 231])); doc.rect(M, y, W - 2 * M, rowH, 'F');
        doc.setFont('helvetica', 'bold'); doc.setTextColor(20); doc.setFontSize(7);
        doc.text(doc.splitTextToSize(`${a.codigo}  ${a.descricao}`, labelW - 2)[0], M + 1 + (a.nivel - 1) * 2, y + 3.7);
        doc.setFillColor(184, 145, 122); doc.rect(x(n.inicio), y + 1.8, Math.max(0.6, x(n.termino + 1) - x(n.inicio)), 1.8, 'F');
        return;
      }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8);
      if (n.critico) doc.setTextColor(180, 40, 40); else doc.setTextColor(40);
      doc.text(doc.splitTextToSize(`${a.codigo}  ${a.descricao}`, labelW - 4)[0], M + 1 + (a.nivel - 1) * 2, y + 3.7);
      if (n.dur === 0) { const cx = x(n.inicio); doc.setFillColor(58, 57, 54); doc.triangle(cx, y + 0.9, cx + 1.6, y + 2.7, cx - 1.6, y + 2.7, 'F'); doc.triangle(cx, y + 4.5, cx + 1.6, y + 2.7, cx - 1.6, y + 2.7, 'F'); return; }
      const bx = x(n.inicio), bw = Math.max(0.6, x(n.termino + 1) - bx);
      if (n.critico) doc.setFillColor(208, 59, 59); else if (A.provisoria) doc.setFillColor(160, 178, 200); else doc.setFillColor(61, 90, 128);
      doc.roundedRect(bx, y + 1.1, bw, rowH - 2.2, 0.5, 0.5, 'F');
      const pct = Number(a.pct) || 0;
      if (pct > 0) { doc.setFillColor(...(n.critico ? [130, 30, 30] : [20, 48, 90])); doc.rect(bx, y + 1.1, (bw * Math.min(100, pct)) / 100, rowH - 2.2, 'F'); }
    });
    if (today >= d0 && today <= d1) { doc.setDrawColor(208, 59, 59); doc.setLineWidth(0.4); doc.setLineDashPattern([1, 1], 0); doc.line(x(today), top - 6, x(today), bottom); doc.setLineDashPattern([], 0); }
    doc.setFontSize(7); doc.setTextColor(110); doc.setFont('helvetica', 'normal');
    doc.text('Azul: atividade • Azul claro: duração provisória • Vermelho: caminho crítico • Parte escura: % executado • Bege: etapa • Tracejado: hoje', M, H - 6);
  }
  doc.save(`Cronograma - ${safeName(o.nome)}.pdf`);
}
