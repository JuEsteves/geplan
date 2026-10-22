// Service worker: deixa o site abrir sem internet (os dados ficam no aparelho e sobem ao Drive depois).
const CACHE = 'geplan-v17';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/schedule.js', './js/drive.js', './js/export.js', './js/config.js',
  './js/model.js', './js/calculo.js', './js/predecessoras.js', './js/cpm.js', './js/curvaS.js', './js/importador.js', './js/libs.js', './js/ui.js', './js/obra.js', './js/biblioteca.js', './js/fases.js', './js/sinapi.js', './js/gestao.js', './js/financeiro.js', './js/execucao.js', './js/orcImport.js',
  './js/nuvem/supabase.js', './js/nuvem/conta.js', './js/nuvem/nuvem.js', './js/nuvem/mapa.js', './js/nuvem/sincronizar.js', './js/nuvem/telaEmpresa.js', './js/permissoes.js', './js/navegacao.js', './js/inicio.js', './js/indicadores.js', './js/configuracoes.js', './js/fornecedores.js', './js/validacao.js', './js/nuvem/arquivos.js',
  './js/liberacoes.js', './js/suprimentos.js', './js/suprimentosRegras.js', './js/diario.js', './js/medicoes.js', './js/medicoesRegras.js', './js/nuvem/aLancar.js', './js/modeloBase.js', './js/leituraProjeto.js',
  './icons/logo-full.png', './icons/logo-mark.png', './icons/favicon-64.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Fontes (Montserrat) e bibliotecas (CDN, versões fixas): cache após o primeiro uso. A API do Supabase não passa aqui.
  if (['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }

  // APIs do Google nunca passam pelo cache
  if (url.hostname.endsWith('googleapis.com') || url.hostname === 'accounts.google.com') return;

  // Arquivos do site: rede primeiro (para pegar atualizações), cache se estiver offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))));
  }
});
