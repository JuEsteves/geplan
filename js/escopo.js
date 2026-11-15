// Obra em foco: os módulos da empresa (compras, entregas, medições, diário) abertos dentro da página da obra.
// Os módulos continuam gerando os links "globais" (#/suprimentos…, #/medicoes…, #/diario…); dentro da obra, rota()
// converte para o caminho da própria obra (#/obra/<id>/compras…), e a tela não sai da obra.
import { MODULOS } from './navegacao.js';

/** Id da obra aberta na rota atual (ou ''). */
export function obraEmFoco() {
  const m = location.hash.match(/^#\/obra\/([^/]+)/);
  return m ? m[1] : '';
}

/** Id da obra da rota atual: página da obra (#/obra/<id>) ou módulo com obra escolhida (#/modulo/<m>/<id>). */
export function idObraDaRota() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'obra') return p[1] || '';
  if (p[0] === 'modulo') return p[2] || '';
  return '';
}

/** Na tela do módulo com a faixa de obras (#/modulo/<m>/<obra>), links da mesma aba da obra continuam no módulo. */
export function noModulo(h) {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] !== 'modulo' || !p[2] || !MODULOS[p[1]]) return h;
  const m = h.match(/^#\/obra\/([^/]+)\/([^/]+)(\/.*)?$/);
  return m && m[1] === p[2] && m[2] === MODULOS[p[1]].aba ? `#/modulo/${p[1]}/${p[2]}${m[3] || ''}` : h;
}
export const linksNoModulo = (html) => html.replace(/href="(#\/obra\/[^"]+)"/g, (_, h) => `href="${noModulo(h)}"`);

/** Converte um link global de módulo no link equivalente dentro da obra em foco. */
export function rota(h, obra = obraEmFoco()) {
  if (!obra) return h;
  let m;
  if ((m = h.match(/^#\/suprimentos\/entregas(\/.*)?$/))) return `#/obra/${obra}/entregas${m[1] || ''}`;
  if ((m = h.match(/^#\/suprimentos(\/.*)?$/))) return `#/obra/${obra}/compras${m[1] || ''}`;
  if ((m = h.match(/^#\/medicoes(\/.*)?$/))) return `#/obra/${obra}/medicoes${m[1] || ''}`;
  if ((m = h.match(/^#\/diario(?:\/([^/]+))?(\/.*)?$/)) && (!m[1] || m[1] === obra)) return `#/obra/${obra}/diario${m[2] || ''}`;
  return h;
}

/** Navega respeitando a obra em foco. */
export const ir = (h) => { location.hash = rota(h); };

/** Reescreve os links de módulo de um trecho de HTML para a obra em foco. */
export const comEscopo = (html, obra) => html.replace(/href="(#\/(?:suprimentos|medicoes|diario)[^"]*)"/g, (_, h) => `href="${rota(h, obra)}"`);
