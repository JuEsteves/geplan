// Utilitários de data e formatação (pt-BR).
// Datas são tratadas como "número do dia" (dias desde 1970-01-01, UTC) para evitar problemas de fuso/horário de verão.

const MS_DAY = 86400000;
export const toDay = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
};
export const toISO = (day) => new Date(day * MS_DAY).toISOString().slice(0, 10);
export const fmtBR = (day) => {
  if (day == null || isNaN(day)) return '';
  const d = new Date(day * MS_DAY);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
export const isoBR = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
export const weekday = (day) => (((day + 4) % 7) + 7) % 7; // 0 = domingo
export const todayDay = () => {
  const n = new Date();
  return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / MS_DAY);
};
export const todayISO = () => toISO(todayDay());
export const dateParts = (day) => { const d = new Date(day * MS_DAY); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
export const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Número no formato brasileiro (1.234,56). */
export const fmtNum = (n, dec = 2) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: dec });
export const fmtNumFix = (n, dec = 2) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
/** Moeda (R$ 1.234,56). */
export const fmtBRL = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Feriados nacionais do Brasil (inclui Carnaval e Corpus Christi, que são ponto facultativo). */
export function feriadosNacionais(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  const pascoa = Math.floor(Date.UTC(ano, mes - 1, dia) / MS_DAY);
  const fixo = (mm, dd, desc) => ({ data: `${ano}-${mm}-${dd}`, desc });
  return [
    fixo('01', '01', 'Confraternização Universal'),
    { data: toISO(pascoa - 48), desc: 'Carnaval (segunda)' },
    { data: toISO(pascoa - 47), desc: 'Carnaval (terça)' },
    { data: toISO(pascoa - 2), desc: 'Sexta-feira Santa' },
    fixo('04', '21', 'Tiradentes'),
    fixo('05', '01', 'Dia do Trabalho'),
    { data: toISO(pascoa + 60), desc: 'Corpus Christi' },
    fixo('09', '07', 'Independência'),
    fixo('10', '12', 'Nossa Senhora Aparecida'),
    fixo('11', '02', 'Finados'),
    fixo('11', '15', 'Proclamação da República'),
    fixo('11', '20', 'Consciência Negra'),
    fixo('12', '25', 'Natal'),
  ];
}
