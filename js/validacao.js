// Validações de cadastro (as mesmas regras são conferidas no banco: public.doc_valido e checks das tabelas).
export const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/** CPF (11) ou CNPJ (14) com dígitos verificadores corretos. Vazio é aceito (documento opcional). */
export function docValido(s) {
  const d = soDigitos(s);
  if (!d) return true;
  const dig = (arr) => arr.map(Number);
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return false;
    const n = dig([...d]);
    let s1 = 0; for (let i = 0; i < 9; i++) s1 += n[i] * (10 - i);
    let r = (s1 * 10) % 11; if (r === 10) r = 0;
    if (r !== n[9]) return false;
    let s2 = 0; for (let i = 0; i < 10; i++) s2 += n[i] * (11 - i);
    r = (s2 * 10) % 11; if (r === 10) r = 0;
    return r === n[10];
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return false;
    const n = dig([...d]);
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], w2 = [6, ...w1];
    const dv = (w) => { const s = w.reduce((a, x, i) => a + x * n[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
    return dv(w1) === n[12] && dv(w2) === n[13];
  }
  return false;
}

export function formatarDoc(s) {
  const d = soDigitos(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}
export const tipoDoc = (s) => ({ 11: 'CPF', 14: 'CNPJ' }[soDigitos(s).length] || '');
export const emailValido = (s) => !s || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
/** Texto sem acentos e em minúsculas, para busca. */
export const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
