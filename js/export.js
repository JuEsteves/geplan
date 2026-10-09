// Exportação para Excel (SheetJS) e PDF (jsPDF). As bibliotecas são carregadas só quando usadas.
import { fmtBR, fmtNum, formatPreds, todayDay } from './schedule.js';

const LIBS = {
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
};

const loaded = {};
function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Não foi possível carregar a biblioteca de exportação (verifique a internet).')); };
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '-');

function cronogramaRows(sched) {
  const out = [];
  for (const et of sched.etapas) {
    out.push({ etapa: true, cells: [et.code, et.nome, '', '', '', '', et.horas || '', '', et.vazia ? '' : et.dur, et.vazia ? '' : fmtBR(et.inicio), et.vazia ? '' : fmtBR(et.termino), '', '', et.critico ? 'Sim' : '', et.vazia ? '' : Math.round(et.pct)] });
    for (const r of et.rows) {
      out.push({ etapa: false, critico: r.critico, cells: [
        r.code, r.nome, r.comp?.nome || '', r.unidade, r.qtd || '', r.coef || '', Math.round(r.horas * 100) / 100 || '', r.equipes,
        r.dur, fmtBR(r.inicio), fmtBR(r.termino), formatPreds(r.s.preds, sched.codes), r.folga, r.critico ? 'Sim' : '', Number(r.s.pct) || 0,
      ] });
    }
  }
  return out;
}

const HEAD = ['Código', 'Etapa / Serviço', 'Composição', 'Unid.', 'Quantidade', 'Coef. (h/un)', 'Horas', 'Equipes', 'Duração (dias úteis)', 'Início', 'Término', 'Predecessoras', 'Folga (dias)', 'Crítico', '% Executado'];

export async function exportExcel(obra, sched, lib) {
  await loadScript(LIBS.xlsx);
  const X = window.XLSX;
  const wb = X.utils.book_new();

  const info = [
    [`Cronograma — ${obra.nome}`],
    [`Início: ${fmtBR(sched.inicio)}   Término: ${fmtBR(sched.termino)}   Duração: ${sched.durTotal} dias úteis   Jornada: ${sched.jornada} h/dia`],
    [],
    HEAD,
    ...cronogramaRows(sched).map((r) => r.cells),
  ];
  const ws = X.utils.aoa_to_sheet(info);
  ws['!cols'] = [8, 40, 30, 7, 11, 11, 10, 8, 10, 12, 12, 16, 10, 8, 11].map((w) => ({ wch: w }));
  X.utils.book_append_sheet(wb, ws, 'Cronograma');

  const comps = [['Composição', 'Unidade', 'Coeficiente (h/un)', 'Produção por equipe (un/dia)', 'Observação'],
    ...lib.composicoes.map((c) => [c.nome, c.unidade, Number(c.coef) || 0, c.coef > 0 ? Math.round((sched.jornada / c.coef) * 100) / 100 : '', c.obs || ''])];
  const wc = X.utils.aoa_to_sheet(comps);
  wc['!cols'] = [{ wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 24 }, { wch: 40 }];
  X.utils.book_append_sheet(wb, wc, 'Composições');

  const dn = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const calRows = [['Jornada (h/dia)', sched.jornada], ['Dias úteis', (obra.calendario.dias || []).map((d) => dn[d]).join(', ')], [], ['Feriado', 'Descrição'],
    ...(obra.calendario.feriados || []).map((f) => [f.data.split('-').reverse().join('/'), f.desc || ''])];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(calRows), 'Calendário');

  if (obra.medicoes?.length) {
    const med = [['Data', '% Executado (real)', '% Planejado'], ...obra.medicoes.map((m) => [m.data.split('-').reverse().join('/'), Math.round(m.real * 10) / 10, Math.round(m.plan * 10) / 10])];
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(med), 'Medições');
  }

  X.writeFile(wb, `Cronograma - ${safeName(obra.nome)}.xlsx`);
}

export async function exportPDF(obra, sched) {
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
    doc.text(`${obra.nome}  •  Início ${fmtBR(sched.inicio)}  •  Término ${fmtBR(sched.termino)}  •  ${sched.durTotal} dias úteis  •  Emitido em ${fmtBR(todayDay())}`, M, M + 10);
  };

  // 1) Tabela
  header('Cronograma de execução');
  const rows = cronogramaRows(sched);
  doc.autoTable({
    startY: M + 14,
    head: [['Cód.', 'Etapa / Serviço', 'Unid.', 'Quant.', 'Horas', 'Equip.', 'Dur.', 'Início', 'Término', 'Pred.', 'Folga', '%']],
    body: rows.map((r) => [r.cells[0], r.cells[1], r.cells[3], r.cells[4] === '' ? '' : fmtNum(r.cells[4]), r.cells[6] === '' ? '' : fmtNum(r.cells[6], 1), r.etapa ? '' : r.cells[7], r.cells[8], r.cells[9], r.cells[10], r.cells[11], r.etapa ? '' : r.cells[12], r.cells[14] === '' ? '' : `${r.cells[14]}%`]),
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [20, 48, 90] },
    columnStyles: { 1: { cellWidth: 80 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 10: { halign: 'right' }, 11: { halign: 'right' } },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      const r = rows[d.row.index];
      if (r.etapa) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [236, 235, 230]; }
      else if (r.critico && d.column.index === 1) d.cell.styles.textColor = [208, 59, 59];
    },
    margin: { left: M, right: M },
  });

  // 2) Gantt
  if (!sched.rows.length) { doc.save(`Cronograma - ${safeName(obra.nome)}.pdf`); return; }
  const labelW = 70, chartX = M + labelW, chartW = W - M - chartX, rowH = 6, top = M + 26;
  const d0 = sched.inicio, d1 = sched.termino + 1;
  const span = Math.max(1, d1 - d0);
  const x = (d) => chartX + ((d - d0) / span) * chartW;
  const lines = [];
  for (const et of sched.etapas) { lines.push({ et }); et.rows.forEach((r) => lines.push({ r })); }
  const perPage = Math.floor((H - top - M - 6) / rowH);
  const months = [];
  { const dt = new Date(d0 * 86400000); dt.setUTCDate(1); while (dt.getTime() / 86400000 < d1) { months.push(Math.floor(dt.getTime() / 86400000)); dt.setUTCMonth(dt.getUTCMonth() + 1); } }
  const mn = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const today = todayDay();

  for (let p = 0; p < lines.length; p += perPage) {
    doc.addPage();
    header('Gráfico de Gantt');
    const pageLines = lines.slice(p, p + perPage);
    const bottom = top + pageLines.length * rowH;
    doc.setDrawColor(220); doc.setLineWidth(0.1);
    doc.setFontSize(7); doc.setTextColor(110);
    for (const m of months) {
      const mx = Math.max(chartX, x(m));
      doc.line(mx, top - 6, mx, bottom);
      const dt = new Date(Math.max(m, d0) * 86400000);
      if (x(Math.max(m, d0)) < W - M - 6) doc.text(`${mn[dt.getUTCMonth()]}/${String(dt.getUTCFullYear()).slice(2)}`, mx + 1, top - 2);
    }
    doc.line(chartX, top, W - M, top);
    pageLines.forEach((ln, i) => {
      const y = top + i * rowH;
      doc.setDrawColor(235); doc.line(M, y + rowH, W - M, y + rowH);
      if (ln.et) {
        doc.setFillColor(246, 238, 231); doc.rect(M, y, W - 2 * M, rowH, 'F');
        doc.setFont('helvetica', 'bold'); doc.setTextColor(20); doc.setFontSize(8);
        doc.text(doc.splitTextToSize(`${ln.et.code}  ${ln.et.nome}`, labelW - 2)[0], M + 1, y + 4);
        if (!ln.et.vazia) { doc.setFillColor(184, 145, 122); doc.rect(x(ln.et.inicio), y + 2, Math.max(0.6, x(ln.et.termino + 1) - x(ln.et.inicio)), 2, 'F'); }
      } else {
        const r = ln.r;
        doc.setFont('helvetica', 'normal'); doc.setTextColor(r.critico ? 180 : 40, r.critico ? 40 : 40, r.critico ? 40 : 40); doc.setFontSize(7.5);
        doc.text(doc.splitTextToSize(`${r.code}  ${r.nome}`, labelW - 2)[0], M + 3, y + 4);
        if (r.dur === 0) {
          const cx = x(r.inicio); doc.setFillColor(58, 57, 54);
          doc.triangle(cx, y + 1.2, cx + 1.8, y + 3, cx - 1.8, y + 3, 'F'); doc.triangle(cx, y + 4.8, cx + 1.8, y + 3, cx - 1.8, y + 3, 'F');
        } else {
          const bx = x(r.inicio), bw = Math.max(0.6, x(r.termino + 1) - bx);
          if (r.critico) doc.setFillColor(208, 59, 59); else doc.setFillColor(61, 90, 128);
          doc.roundedRect(bx, y + 1.3, bw, rowH - 2.6, 0.6, 0.6, 'F');
          const pct = Number(r.s.pct) || 0;
          if (pct > 0) { if (r.critico) doc.setFillColor(130, 30, 30); else doc.setFillColor(20, 48, 90); doc.rect(bx, y + 1.3, (bw * pct) / 100, rowH - 2.6, 'F'); }
        }
      }
    });
    if (today >= d0 && today <= d1) {
      doc.setDrawColor(208, 59, 59); doc.setLineWidth(0.4); doc.setLineDashPattern([1, 1], 0);
      doc.line(x(today), top - 6, x(today), bottom); doc.setLineDashPattern([], 0);
    }
    doc.setFontSize(7); doc.setTextColor(110); doc.setFont('helvetica', 'normal');
    doc.text('Azul: serviço  •  Vermelho: caminho crítico  •  Parte escura: % executado  •  Linha tracejada: hoje', M, H - M + 2);
  }
  doc.save(`Cronograma - ${safeName(obra.nome)}.pdf`);
}
