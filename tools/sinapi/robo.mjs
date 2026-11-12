// Robô mensal do SINAPI (roda no GitHub Actions: .github/workflows/sinapi-mensal.yml).
// Confere no site da Caixa se saiu um mês novo (ou uma retificação), baixa o ZIP "formato-xlsx", lê a planilha de
// referência com o MESMO leitor do site (js/basesRefDados.js) e grava a versão no banco como base pública.
// Nada é apagado: cada mês/retificação vira uma versão nova. Se a Caixa mudar o formato, o robô para com erro (o
// GitHub avisa por e-mail) e a importação manual pela tela continua disponível.
//
// Variáveis (segredos do repositório, configurados pela dona da plataforma — nunca no código):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   → banco de destino (testes ou produção)
//   MES (opcional, "AAAA-MM")                 → importar um mês específico em vez do mais recente
import { createClient } from '@supabase/supabase-js';
import * as XLSXmod from 'xlsx';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpretarReferenciaSinapi, gravarBase, nomeVersao } from './basesRefDados.mjs';

const XLSX = XLSXmod.read ? XLSXmod : XLSXmod.default;   // SheetJS publica ESM e CommonJS
const BASE_URL ='https://www.caixa.gov.br/Downloads/sinapi-relatorios-mensais/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 GEPLAN-robo-sinapi';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MES } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.log('Segredos do banco não configurados para este ambiente: nada a fazer.'); process.exit(0); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const existe = async (url) => {
  for (let t = 1; t <= 3; t++) {
    try { const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA } }); return r.ok; } catch (e) { if (t === 3) throw e; await new Promise((r) => setTimeout(r, 3000 * t)); }
  }
  return false;
};

/** Meses a conferir: o pedido em MES, ou os 3 últimos (a Caixa publica o mês de referência por volta do dia 10 do mês seguinte). */
function meses() {
  if (MES) { if (!/^\d{4}-\d{2}$/.test(MES)) throw new Error(`MES inválido: ${MES} (use AAAA-MM)`); return [MES]; }
  const hoje = new Date();
  return [0, 1, 2].map((k) => { const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - k, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; });
}

/** Arquivo mais recente publicado para o mês: o original ou a última retificação. */
async function arquivoDoMes(mes) {
  const raiz = `SINAPI-${mes}-formato-xlsx`;
  if (!(await existe(`${BASE_URL}${raiz}.zip`)) && !(await existe(`${BASE_URL}${raiz}_Retificacao01.zip`))) return null;
  let nome = (await existe(`${BASE_URL}${raiz}.zip`)) ? `${raiz}.zip` : null;
  for (let n = 1; n <= 9; n++) {
    const r = `${raiz}_Retificacao${String(n).padStart(2, '0')}.zip`;
    if (await existe(`${BASE_URL}${r}`)) nome = r; else if (n > 1 || nome) break;
  }
  return nome;
}

async function baixarELer(arquivo) {
  const dir = mkdtempSync(join(tmpdir(), 'sinapi-'));
  log('baixando', arquivo);
  const r = await fetch(`${BASE_URL}${arquivo}`, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`download ${arquivo}: HTTP ${r.status}`);
  const zip = join(dir, 'sinapi.zip');
  writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', zip, '-d', join(dir, 'x')]);
  const xlsx = readdirSync(join(dir, 'x'), { recursive: true }).map(String).find((f) => /SINAPI_Refer.*\.xlsx$/i.test(f.normalize('NFC')));
  if (!xlsx) throw new Error(`não achei a planilha de referência (SINAPI_Referência_AAAA_MM.xlsx) dentro de ${arquivo}`);
  log('lendo', xlsx);
  const wb = XLSX.read(readFileSync(join(dir, 'x', xlsx)), { type: 'buffer', cellFormula: true });
  const dados = interpretarReferenciaSinapi(wb, XLSX);
  if (dados.avisos.length) throw new Error(`a planilha mudou de formato: ${dados.avisos.join(' ')}`);
  if (dados.composicoes.length < 5000 || dados.ufs.length < 27) throw new Error(`leitura incompleta: ${dados.composicoes.length} composições, ${dados.ufs.length} UF`);
  return dados;
}

const c = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: existentes, error } = await c.from('ref_bases').select('nome, status').is('org_id', null).eq('fonte', 'SINAPI');
if (error) throw new Error(`banco: ${error.message}`);
const publicadas = new Set(existentes.filter((b) => b.status === 'publicada').map((b) => b.nome));
// sobra de uma execução interrompida: a versão incompleta é descartada antes de importar de novo
for (const b of existentes.filter((x) => x.status === 'importando')) { log('descartando importação incompleta', b.nome); await c.from('ref_bases').delete().is('org_id', null).eq('nome', b.nome).eq('status', 'importando'); }

let novas = 0;
for (const mes of meses()) {
  const arquivo = await arquivoDoMes(mes);
  if (!arquivo) { log(mes, 'ainda não publicado pela Caixa'); continue; }
  const nome = nomeVersao('SINAPI', `${mes}-01`, arquivo);
  if (publicadas.has(nome)) { log(nome, 'já está no banco'); if (!MES) break; continue; }
  const dados = await baixarELer(arquivo);
  if (dados.mes !== `${mes}-01`) throw new Error(`o arquivo ${arquivo} diz ser de ${dados.mes}`);
  log(`${nome}: ${dados.composicoes.length} composições, ${dados.itens.length} itens, ${dados.insumos.length} insumos — gravando`);
  let ultimo = 0;
  const r = await gravarBase(c, dados, { fonte: 'SINAPI', nome, arquivo }, (feito, total) => {
    const p = Math.floor((feito / total) * 10); if (p > ultimo) { ultimo = p; log(`  ${p * 10}%`); }
  });
  log(`${nome} publicada`, JSON.stringify(r.totais));
  novas++;
  if (!MES) break;   // só o mês mais recente que faltar; meses antigos, pedir com MES=AAAA-MM
}
log(novas ? `${novas} versão(ões) nova(s).` : 'Nada novo.');
