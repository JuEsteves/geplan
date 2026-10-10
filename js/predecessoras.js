// Notação de predecessoras da planilha ↔ dependências {codigo, tipo: 'FS'|'SS', lag}.
//
//   "3.2"              → FS lag 0   (começa no dia útil seguinte ao fim da 3.2)
//   "3.2 TI-10"        → FS lag -10 (começa 10 dias úteis antes do fim da 3.2 — sobreposição)
//   "3.2+2"            → FS lag +2  (2 dias úteis de folga após o fim)
//   "3.1 II+5"         → SS lag +5  (começa 5 dias úteis após o início da 3.1)
//   "3.1 II"           → SS lag 0
//   "6.1/6.2/6.4 TI-5" → várias predecessoras com o mesmo tipo e lag (vale a data mais tardia)
//   "1.2; 3.1 II"      → grupos separados por ";"
//   "-", "—" ou vazio  → sem predecessora
//   texto ("Retomada") → sem dependência; vira observação e pede início fixado

const GRUPO = /^(\d+(?:\.\d+)*(?:\s*\/\s*\d+(?:\.\d+)*)*)\s*(?:(II|TI|SS|FS|TT|IT)\b)?\s*([+-]\s*\d+)?$/i;

export function parseNotacao(texto) {
  const t = String(texto ?? '').replace(/\(orig\.?\)/i, '').trim();
  if (!t || /^[-–—]+$/.test(t)) return { deps: [], obs: '', textoLivre: false };
  const deps = [];
  for (const parte of t.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = parte.replace(/\s+/g, ' ').match(GRUPO);
    if (!m) {
      if (!/\d/.test(parte)) return { deps: [], obs: `Predecessora original: "${t}"`, textoLivre: true };
      throw new Error(`"${parte}" não é uma predecessora válida. Use 3.2, 3.2 TI-10, 3.1 II+5 ou 6.1/6.2 TI-5.`);
    }
    const codigos = m[1].split('/').map((c) => c.trim());
    const tipoTxt = (m[2] || '').toUpperCase();
    const lag = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
    const tipo = tipoTxt === 'II' || tipoTxt === 'SS' ? 'SS' : 'FS';
    if (tipoTxt === 'TT' || tipoTxt === 'IT') throw new Error(`Tipo "${tipoTxt}" não é suportado (use término→início ou II).`);
    for (const codigo of codigos) deps.push({ codigo, tipo, lag });
  }
  return { deps, obs: '', textoLivre: false };
}

/** Dependências → texto na mesma notação (agrupa por tipo e lag). */
export function formatNotacao(deps, codigoDe) {
  const grupos = new Map();
  for (const d of deps) {
    const c = codigoDe(d.predecessoraId);
    if (!c) continue;
    const k = `${d.tipo}|${d.lag}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(c);
  }
  const partes = [];
  for (const [k, codigos] of grupos) {
    const [tipo, lagS] = k.split('|');
    const lag = Number(lagS);
    let suf = '';
    if (tipo === 'SS') suf = ' II' + (lag ? (lag > 0 ? `+${lag}` : `${lag}`) : '');
    else if (lag < 0) suf = ` TI${lag}`;
    else if (lag > 0) suf = `+${lag}`;
    partes.push(codigos.join('/') + suf);
  }
  return partes.join('; ');
}

/** Converte texto em dependências da atividade (resolve códigos → ids). Lança erro com mensagem amigável. */
export function resolverNotacao(texto, atividadeId, idPorCodigo) {
  const { deps, obs, textoLivre } = parseNotacao(texto);
  const out = [];
  for (const d of deps) {
    const id = idPorCodigo.get(d.codigo);
    if (!id) throw new Error(`A atividade ${d.codigo} não existe.`);
    if (id === atividadeId) throw new Error('Uma atividade não pode depender dela mesma.');
    out.push({ predecessoraId: id, tipo: d.tipo, lag: d.lag });
  }
  return { deps: out, obs, textoLivre };
}
